import type { EffectiveSearchBackend, FsBackend, FuzzySearchResult } from "@stanley2058/lilac-fs";
import { createRequire } from "node:module";

import { sshExecBash, sshExecScriptJson } from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText } from "../../ssh/remote-js";
import type { FileEdit, HashlineEdit, HashlineWarning } from "@stanley2058/lilac-fs";

const requirePackageJson = createRequire(import.meta.url);

export type RemoteReadTextInput = {
  path: string;
  startLine?: number;
  startColumn?: number;
  maxLines?: number;
  maxCharacters?: number;
  format?: "raw" | "numbered" | "hashline";
};

export type RemoteReadTextOutput =
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStartLine?: number;
      nextStartColumn?: number;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      format: "raw";
      content: string;
    }
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStartLine?: number;
      nextStartColumn?: number;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      format: "numbered";
      numberedContent: string;
    }
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStartLine?: number;
      nextStartColumn?: number;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      format: "hashline";
      hashlineContent: string;
    }
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: "NOT_FOUND" | "PERMISSION" | "UNKNOWN";
        message: string;
      };
    };

export type RemoteReadBytesResult =
  | {
      ok: true;
      resolvedPath: string;
      fileHash: string;
      bytesLength: number;
      base64: string;
    }
  | {
      ok: false;
      resolvedPath?: string;
      error: string;
    };

export type RemoteGlobEntry = {
  path: string;
  type:
    | "symlink"
    | "file"
    | "directory"
    | "socket"
    | "block_device"
    | "character_device"
    | "fifo"
    | "unknown";
  size: number;
};

export type RemoteGlobOutput =
  | {
      mode: "default";
      truncated: boolean;
      paths: string[];
      effectiveBackend?: EffectiveSearchBackend;
      error?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      entries: RemoteGlobEntry[];
      effectiveBackend?: EffectiveSearchBackend;
      error?: string;
    };

export type RemoteGrepMatch = {
  file: string;
  line: number;
  column: number;
  text: string;
  submatches?: { match: string; start: number; end: number }[];
};

export type RemoteGrepOutput =
  | {
      mode: "default";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: {
        file: string;
        line: number;
        text: string;
      }[];
      error?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: RemoteGrepMatch[];
      error?: string;
    }
  | {
      mode: "hashline";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: {
        file: string;
        resolvedPath: string;
        fileHash: string;
        line: number;
        text: string;
      }[];
      error?: string;
    };

export type RemoteFuzzySearchOutput = FuzzySearchResult;

export type RemoteEditInput =
  | {
      path: string;
      edits: FileEdit[];
      expectedHash?: string;
      mode?: "legacy";
    }
  | {
      path: string;
      edits: readonly HashlineEdit[];
      mode: "hashline";
      expectedHash?: string;
    };

export type RemoteEditOutput =
  | {
      success: true;
      resolvedPath: string;
      oldHash: string;
      newHash: string;
      changesMade: boolean;
      replacementsMade: number;
    }
  | {
      success: false;
      resolvedPath: string;
      currentHash?: string;
      error: {
        code:
          | "NOT_FOUND"
          | "PERMISSION"
          | "UNKNOWN"
          | "NOT_READ"
          | "HASH_MISMATCH"
          | "INVALID_RANGE"
          | "RANGE_MISMATCH"
          | "NO_MATCHES"
          | "TOO_MANY_MATCHES"
          | "NOT_ENOUGH_MATCHES"
          | "INVALID_REGEX"
          | "INVALID_EDIT"
          | "STALE_ANCHOR";
        message: string;
      };
    };

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 500_000;

function readRemoteFsRunnerPackageSpec(): string {
  const rawPackageJson = requirePackageJson(
    "@stanley2058/lilac-remote-fs-runner/package.json",
  ) as unknown;
  if (!rawPackageJson || typeof rawPackageJson !== "object" || Array.isArray(rawPackageJson)) {
    throw new Error("remote fs runner package.json must be an object");
  }

  const { name, version } = rawPackageJson as { name?: unknown; version?: unknown };
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("remote fs runner package.json name must be a non-empty string");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("remote fs runner package.json version must be a non-empty string");
  }

  return `${name}@${version}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseJsonEnvelope<T>(
  stdout: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const stdoutTrim = stdout.trim();
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
          : "remote fs runner error";
      return { ok: false, error: err };
    }
    return { ok: false, error: "remote fs runner returned unexpected JSON" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `failed to parse remote fs runner JSON: ${msg}` };
  }
}

function buildRemoteFsRunnerCommand(): string {
  const override = process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
  if (override && override.trim().length > 0) return override;

  const packageSpec = shellSingleQuote(
    process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE ?? readRemoteFsRunnerPackageSpec(),
  );
  return `if command -v bunx >/dev/null 2>&1; then
  bunx ${packageSpec} request
elif command -v npx >/dev/null 2>&1; then
  npx --no-workspaces -y ${packageSpec} request
else
  echo '{"ok":false,"error":"Remote host has neither npx nor bunx in PATH"}'
fi`;
}

async function sshExecRemoteFsRunnerJson<T>(params: {
  host: string;
  cwd: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  maxOutputChars: number;
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const inputJson = JSON.stringify(params.input);
  const runnerCommand = buildRemoteFsRunnerCommand();

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

run_remote_fs_runner() {
${runnerCommand}
}

run_remote_fs_runner <<'__LILAC_INPUT__'
${inputJson}
__LILAC_INPUT__
`;

  const res = await sshExecBash({
    host: params.host,
    cmd: script,
    timeoutMs: params.timeoutMs,
    maxOutputChars: params.maxOutputChars,
  });

  if (res.aborted) return { ok: false, error: "aborted" };
  if (res.timedOut) return { ok: false, error: `timeout:${params.timeoutMs}` };
  if (res.capped.stdout || res.capped.stderr) {
    return { ok: false, error: "remote fs runner output capped (response too large)" };
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim().length > 0 ? `: ${res.stderr.trim()}` : "";
    return { ok: false, error: `remote fs runner exited with code ${res.exitCode}${detail}` };
  }

  const parsed = parseJsonEnvelope<T>(res.stdout);
  if (!parsed.ok && res.stderr.trim().length > 0) {
    return { ok: false, error: `${parsed.error}\n${res.stderr.trim()}` };
  }
  return parsed;
}

export async function remoteReadTextFile(params: {
  host: string;
  cwd: string;
  input: RemoteReadTextInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteReadTextOutput> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteReadTextOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.read_text",
      denyPaths: params.denyPaths,
      input: params.input,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    return {
      success: false,
      resolvedPath: params.input.path,
      error: { code: "UNKNOWN", message: res.error },
    };
  }

  return res.value;
}

export async function remoteReadFileBytes(params: {
  host: string;
  cwd: string;
  filePath: string;
  denyPaths: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
}): Promise<RemoteReadBytesResult> {
  // Base64 output can be large (1.33x bytes). Keep a generous cap.
  const maxOutputChars = Math.max(500_000, Math.ceil(params.maxBytes * 1.5) + 10_000);

  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteReadBytesResult>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.read_bytes",
      denyPaths: params.denyPaths,
      input: { path: params.filePath, maxBytes: params.maxBytes },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars,
  });

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  return res.value;
}

export async function remoteGlob(params: {
  host: string;
  cwd: string;
  patterns: readonly string[];
  maxEntries?: number;
  mode?: "default" | "detailed";
  denyPaths: readonly string[];
  fsBackend?: FsBackend;
  timeoutMs?: number;
}): Promise<RemoteGlobOutput> {
  const mode = params.mode ?? "default";
  const input = {
    op: "fs.glob",
    denyPaths: params.denyPaths,
    input: {
      patterns: params.patterns,
      maxEntries: params.maxEntries,
      mode,
    },
  };

  if (params.fsBackend === "fff") {
    const runnerRes = await sshExecRemoteFsRunnerJson<RemoteGlobOutput>({
      host: params.host,
      cwd: params.cwd,
      input,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    });
    if (runnerRes.ok) return runnerRes.value;
  }

  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteGlobOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    if (mode === "default") {
      return { mode, truncated: false, paths: [], error: res.error };
    }
    return { mode, truncated: false, entries: [], error: res.error };
  }

  return res.value;
}

export async function remoteGrep(params: {
  host: string;
  cwd: string;
  input: {
    pattern: string;
    regex?: boolean;
    maxResults?: number;
    fileExtensions?: readonly string[];
    includeContextLines?: number;
    mode?: "default" | "detailed" | "hashline";
  };
  denyPaths: readonly string[];
  fsBackend?: FsBackend;
  timeoutMs?: number;
}): Promise<RemoteGrepOutput> {
  const mode = params.input.mode ?? "default";
  const input = {
    op: "fs.grep",
    denyPaths: params.denyPaths,
    input: {
      pattern: params.input.pattern,
      regex: params.input.regex,
      maxResults: params.input.maxResults,
      fileExtensions: params.input.fileExtensions,
      includeContextLines: params.input.includeContextLines,
      mode,
    },
  };

  if (params.fsBackend === "fff") {
    const runnerRes = await sshExecRemoteFsRunnerJson<RemoteGrepOutput>({
      host: params.host,
      cwd: params.cwd,
      input,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    });
    if (runnerRes.ok) return runnerRes.value;
  }

  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteGrepOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    if (mode === "default") {
      return { mode, truncated: false, results: [], error: res.error };
    }
    if (mode === "hashline") {
      return { mode, truncated: false, results: [], error: res.error };
    }
    return { mode, truncated: false, results: [], error: res.error };
  }

  return res.value;
}

export async function remoteFuzzySearch(params: {
  host: string;
  cwd: string;
  input: {
    query: string;
    maxResults?: number;
  };
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteFuzzySearchOutput> {
  const input = {
    op: "fs.fuzzy_search",
    denyPaths: params.denyPaths,
    input: {
      query: params.input.query,
      maxResults: params.input.maxResults,
    },
  };

  const runnerRes = await sshExecRemoteFsRunnerJson<RemoteFuzzySearchOutput>({
    host: params.host,
    cwd: params.cwd,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });
  if (runnerRes.ok) return runnerRes.value;

  return {
    results: [],
    totalMatched: 0,
    totalFiles: 0,
    truncated: false,
    error: `remote fff fuzzy_search unavailable: ${runnerRes.error}`,
  };
}

export async function remoteEditFile(params: {
  host: string;
  cwd: string;
  input: RemoteEditInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
}): Promise<RemoteEditOutput> {
  const js = await getRemoteRunnerJsText();
  const res = await sshExecScriptJson<RemoteEditOutput>({
    host: params.host,
    cwd: params.cwd,
    js,
    input: {
      op: "fs.edit",
      denyPaths: params.denyPaths,
      input: params.input,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  });

  if (!res.ok) {
    return {
      success: false,
      resolvedPath: params.input.path,
      error: { code: "UNKNOWN", message: res.error },
    };
  }

  return res.value;
}

// For unit tests and future callsites.
export function toRemoteDebugPath(host: string, resolvedPath: string): string {
  const p = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;
  return `ssh://${host}${p}`;
}
