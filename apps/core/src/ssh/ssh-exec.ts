import { requireConfiguredSshHost } from "./ssh-config";

const DEFAULT_CONNECT_TIMEOUT_SECS = 10;

export type SshExecOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Maximum stdout/stderr characters to capture per stream.
   * If output exceeds this cap, it is truncated and `capped=true`.
   */
  maxOutputChars: number;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  capped: { stdout: boolean; stderr: boolean };
};

type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
};

async function readStreamTextCapped(stream: unknown, maxChars: number): Promise<StreamTextResult> {
  if (!stream || typeof stream === "number") {
    return { text: "", totalChars: 0, capped: false };
  }

  const maybeReadable = stream as { getReader?: unknown };
  if (typeof maybeReadable.getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    let text = "";
    let totalChars = 0;
    let capped = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const chunkText = decoder.decode(value, { stream: true });
        totalChars += chunkText.length;

        if (text.length < maxChars) {
          const remaining = maxChars - text.length;
          if (chunkText.length <= remaining) {
            text += chunkText;
          } else {
            text += chunkText.slice(0, remaining);
            capped = true;
          }
        } else {
          capped = true;
        }
      }

      const tail = decoder.decode();
      if (tail.length > 0) {
        totalChars += tail.length;
        if (text.length < maxChars) {
          const remaining = maxChars - text.length;
          text += tail.length <= remaining ? tail : tail.slice(0, remaining);
          if (tail.length > remaining) capped = true;
        } else {
          capped = true;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text, totalChars, capped };
  }

  const full = await new Response(stream as any).text();
  return {
    text: full.length > maxChars ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    capped: full.length > maxChars,
  };
}

function inferTransportError(
  stderr: string,
): { type: "hostkey" | "auth" | "connect" | "unknown"; message: string } | undefined {
  const s = stderr.toLowerCase();
  if (s.includes("host key verification failed")) {
    return { type: "hostkey", message: "Host key verification failed" };
  }
  if (s.includes("permission denied")) {
    return { type: "auth", message: "Permission denied" };
  }
  if (
    s.includes("connection refused") ||
    s.includes("timed out") ||
    s.includes("could not resolve hostname")
  ) {
    return { type: "connect", message: "Failed to connect" };
  }
  return undefined;
}

function buildRemoteScript(params: { cmd: string; cwd?: string }) {
  const cwd = params.cwd ?? "";
  return `#!/usr/bin/env bash
set -euo pipefail

CWD=$(cat <<'__LILAC_CWD__'
${cwd}
__LILAC_CWD__
)

CMD=$(cat <<'__LILAC_CMD__'
${params.cmd}
__LILAC_CMD__
)

if [ -n "$CWD" ]; then
  if [ "$CWD" = "~" ]; then
    CWD="$HOME"
  elif [[ "$CWD" == "~/"* ]]; then
    CWD="$HOME/\${CWD:2}"
  fi
  cd "$CWD"
fi

# Run under a clean bash to avoid remote environment surprises (rc/profile).
bash --noprofile --norc -c "$CMD"

exit 0
`;
}

function buildSshChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

export async function sshExecBash(params: {
  host: string;
  cmd: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
}): Promise<
  SshExecResult & {
    transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
  }
> {
  await requireConfiguredSshHost(params.host);

  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const killProcessGroupBestEffort = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-pid, signal);
    } catch {
      // ignore
    }
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  };

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = (child as { pid?: unknown } | null)?.pid;
      if (typeof pid === "number" && pid > 0) {
        killProcessGroupBestEffort(pid, "SIGKILL");
      }
    }, HARD_KILL_DELAY_MS);
  };

  let abortListener: (() => void) | null = null;
  if (params.signal) {
    const onAbort = () => {
      aborted = true;
      controller.abort();
      const pid = child?.pid;
      if (pid) {
        killProcessGroupBestEffort(pid, "SIGTERM");
        scheduleHardKill();
      }
    };
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      killProcessGroupBestEffort(pid, "SIGTERM");
      scheduleHardKill();
    }
  }, params.timeoutMs);

  const startedAt = Date.now();
  try {
    const sshArgs = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`,
      "-o",
      "LogLevel=ERROR",
      params.host,
      "bash",
      "--noprofile",
      "--norc",
      "-s",
    ];

    const script = buildRemoteScript({ cmd: params.cmd, cwd: params.cwd });

    child = Bun.spawn(["ssh", ...sshArgs], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([script]),
      signal: controller.signal,
      killSignal: "SIGTERM",
      detached: true,
      env: buildSshChildEnv(),
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamTextCapped(child.stdout, params.maxOutputChars),
      readStreamTextCapped(child.stderr, params.maxOutputChars),
      child.exited,
    ]);

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;

    return {
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut,
      aborted,
      capped: {
        stdout: stdoutResult.status === "fulfilled" ? stdoutResult.value.capped : false,
        stderr: stderrResult.status === "fulfilled" ? stderrResult.value.capped : false,
      },
      transportError,
    };
  } finally {
    clearTimeout(timeout);
    abortListener?.();
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
  }
}

export async function sshExecScriptJson<T>(params: {
  host: string;
  cwd: string;
  js: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const inputJson = JSON.stringify(params.input);

  const script = `#!/usr/bin/env bash
set -euo pipefail

REMOTE_CWD=$(cat <<'__LILAC_REMOTE_CWD__'
${params.cwd}
__LILAC_REMOTE_CWD__
)

if [ -n "$REMOTE_CWD" ]; then
  if [ "$REMOTE_CWD" = "~" ]; then
    REMOTE_CWD="$HOME"
  elif [[ "$REMOTE_CWD" == "~/"* ]]; then
    REMOTE_CWD="$HOME/\${REMOTE_CWD:2}"
  fi

  if [ ! -d "$REMOTE_CWD" ]; then
    echo '{"ok":false,"error":"Remote cwd does not exist or is not a directory"}'
    exit 0
  fi

  if ! cd "$REMOTE_CWD"; then
    echo '{"ok":false,"error":"Remote cwd is not accessible"}'
    exit 0
  fi
fi

TMP_JS=""
cleanup() {
  if [ -n "$TMP_JS" ]; then
    rm -f "$TMP_JS" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if command -v mktemp >/dev/null 2>&1; then
  TMP_JS=$(mktemp -t lilac-remote-tool.XXXXXX)
else
  TMP_JS="/tmp/lilac-remote-tool.$$"
fi

cat >"$TMP_JS" <<'__LILAC_JS__'
${params.js}
__LILAC_JS__

if command -v bun >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | bun "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | node "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

echo '{"ok":false,"error":"Remote host has neither bun nor node in PATH"}'
exit 0
`;

  const res = await sshExecBash({
    host: params.host,
    cmd: script,
    cwd: undefined,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    maxOutputChars: params.maxOutputChars,
  });

  if (res.aborted) return { ok: false, error: "aborted" };
  if (res.timedOut) return { ok: false, error: `timeout:${params.timeoutMs}` };
  if (res.capped.stdout || res.capped.stderr) {
    return { ok: false, error: "remote output capped (response too large)" };
  }

  const stdoutTrim = res.stdout.trim();
  try {
    const parsed = JSON.parse(stdoutTrim) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "ok" in parsed &&
      (parsed as { ok?: unknown }).ok === true &&
      "value" in parsed
    ) {
      return { ok: true, value: (parsed as { value: T }).value };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "ok" in parsed &&
      (parsed as { ok?: unknown }).ok === false
    ) {
      const err =
        (parsed as { error?: unknown }).error !== undefined
          ? String((parsed as { error?: unknown }).error)
          : "remote script error";
      return { ok: false, error: err };
    }
    return { ok: false, error: "remote returned unexpected JSON" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail = res.stderr.trim().length > 0 ? `\n${res.stderr.trim()}` : "";
    return { ok: false, error: `failed to parse remote JSON: ${msg}${detail}` };
  }
}
