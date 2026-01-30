import { z } from "zod";
import { homedir } from "node:os";
import path from "node:path";

import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";

const DEFAULT_SSH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const MAX_OUTPUT_CHARS = 200_000;

const emptyInputSchema = z.object({});

const runInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe(
      "SSH host alias from ~/.ssh/config (or a valid ssh destination like user@host).",
    ),
  cmd: z.string().min(1).describe("Command to execute on the remote host."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory on the remote host. If provided, the command runs after `cd`.",
    ),
  timeoutMs: z
    .coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type RunInput = z.infer<typeof runInputSchema>;

const probeInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe(
      "SSH host alias from ~/.ssh/config. Use ssh.hosts to list configured aliases.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to probe (used for git context). Defaults to the remote default directory.",
    ),
  timeoutMs: z
    .coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type ProbeInput = z.infer<typeof probeInputSchema>;

let cachedProbeScript: string | null = null;
async function loadProbeScript(): Promise<string> {
  if (cachedProbeScript) return cachedProbeScript;
  const p = path.join(import.meta.dir, "ssh-probe.sh");
  cachedProbeScript = await Bun.file(p).text();
  return cachedProbeScript;
}

function resolveSshConfigPath(): string {
  const fromEnv = process.env.LILAC_SSH_CONFIG_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(homedir(), ".ssh", "config");
}

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

export function parseSshHostsFromConfigText(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/g);
  for (const raw of lines) {
    const noComment = stripComment(raw).trim();
    if (!noComment) continue;

    const match = /^Host\s+(.+)$/i.exec(noComment);
    if (!match) continue;

    const rest = match[1] ?? "";
    const tokens = rest.split(/\s+/g).filter(Boolean);
    for (const t of tokens) {
      if (t.startsWith("!")) continue;
      if (t.includes("*") || t.includes("?")) continue;
      // Avoid advertising the global wildcard entry.
      if (t === "*") continue;
      if (!seen.has(t)) {
        seen.add(t);
        hosts.push(t);
      }
    }
  }

  return hosts;
}

async function readConfiguredHosts(): Promise<{
  configPath: string;
  hosts: string[];
  exists: boolean;
  readError?: string;
}> {
  const configPath = resolveSshConfigPath();
  const file = Bun.file(configPath);
  const exists = await file.exists();
  if (!exists) return { configPath, hosts: [], exists: false };

  try {
    const text = await file.text();
    const hosts = parseSshHostsFromConfigText(text);
    return { configPath, hosts, exists: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { configPath, hosts: [], exists: true, readError: msg };
  }
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false as const };
  return { text: text.slice(0, maxChars), truncated: true as const };
}

async function readStreamText(stream: unknown): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream as any).text();
}

async function writeToStdin(stdin: unknown, text: string) {
  if (!stdin || typeof stdin === "number") return;
  const ws = stdin as WritableStream<Uint8Array>;
  const writer = ws.getWriter();
  try {
    const bytes = new TextEncoder().encode(text);
    await writer.write(bytes);
  } finally {
    await writer.close();
  }
}

function inferTransportError(stderr: string):
  | { type: "hostkey" | "auth" | "connect" | "unknown"; message: string }
  | undefined {
  const s = stderr.toLowerCase();
  if (s.includes("host key verification failed")) {
    return { type: "hostkey", message: "Host key verification failed" };
  }
  if (s.includes("permission denied")) {
    return { type: "auth", message: "Permission denied" };
  }
  if (s.includes("connection refused") || s.includes("timed out") || s.includes("could not resolve hostname")) {
    return { type: "connect", message: "Failed to connect" };
  }
  return undefined;
}

function buildRemoteScript(input: RunInput) {
  const cwd = input.cwd ?? "";
  // Use heredocs to avoid quoting issues.
  return `#!/usr/bin/env bash\nset -euo pipefail\n\nCWD=$(cat <<'__LILAC_CWD__'\n${cwd}\n__LILAC_CWD__\n)\n\nCMD=$(cat <<'__LILAC_CMD__'\n${input.cmd}\n__LILAC_CMD__\n)\n\nif [ -n "$CWD" ]; then\n  cd "$CWD"\nfi\n\n# Run under bash -lc for a predictable shell environment.\nbash -lc "$CMD"\n`;
}

async function buildProbeScript(input: ProbeInput): Promise<string> {
  const base = await loadProbeScript();
  const cwd = input.cwd ?? "";
  return base.replace("__LILAC_CWD_VALUE__", cwd);
}

function requireConfiguredHost(
  configured: { configPath: string; hosts: string[]; readError?: string },
  host: string,
) {
  if (configured.readError) {
    throw new Error(
      `Failed to read SSH config at ${configured.configPath}: ${configured.readError}`,
    );
  }

  if (configured.hosts.length === 0) {
    throw new Error(
      `No SSH hosts are configured. Add host aliases to ${configured.configPath} (and ensure known_hosts + keys are configured), then retry.`,
    );
  }

  if (!configured.hosts.includes(host)) {
    throw new Error(
      `Unknown SSH host alias '${host}'. Use ssh.hosts to see configured aliases from ${configured.configPath}, or add an explicit Host entry.`,
    );
  }
}

export class SSH implements ServerTool {
  id = "ssh";

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    const { hosts, readError } = await readConfiguredHosts();
    const hidden = hosts.length === 0 && readError === undefined;

    return [
      {
        callableId: "ssh.hosts",
        name: "SSH Hosts",
        description: "List SSH host aliases discovered from ~/.ssh/config on this server.",
        shortInput: zodObjectToCliLines(emptyInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(emptyInputSchema),
        hidden,
      },
      {
        callableId: "ssh.run",
        name: "SSH Run",
        description:
          "Run a command on a remote host over SSH (StrictHostKeyChecking=yes, BatchMode=yes).",
        shortInput: zodObjectToCliLines(runInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runInputSchema),
        hidden,
      },
      {
        callableId: "ssh.probe",
        name: "SSH Probe",
        description:
          "Probe remote host capabilities (expected tools + basic system and git context).",
        shortInput: zodObjectToCliLines(probeInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(probeInputSchema),
        hidden,
      },
    ];
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (callableId === "ssh.hosts") {
      const { configPath, hosts, exists, readError } = await readConfiguredHosts();
      return {
        configPath,
        exists,
        hosts,
        readError,
      };
    }

    if (callableId === "ssh.run") {
      const input = runInputSchema.parse(rawInput);

      const configured = await readConfiguredHosts();
      requireConfiguredHost(configured, input.host);

      const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
      const controller = new AbortController();
      let timedOut = false;

      const onAbort = () => controller.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, effectiveTimeoutMs);

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
          input.host,
          "bash",
          "-s",
        ];

        const child = Bun.spawn(["ssh", ...sshArgs], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          signal: controller.signal,
          killSignal: "SIGTERM",
          env: {
            ...process.env,
            // Ensure we don't implicitly change caller state.
            // Users should configure their SSH environment explicitly.
          },
        });

        const script = buildRemoteScript(input);
        // Fire-and-forget write; if ssh exits early, this will throw and be caught.
        const writePromise = writeToStdin(child.stdin, script);

        const [stdoutResult, stderrResult, exitResult, writeResult] =
          await Promise.allSettled([
            readStreamText(child.stdout),
            readStreamText(child.stderr),
            child.exited,
            writePromise,
          ]);

        const stdout =
          stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
        const stderr =
          stderrResult.status === "fulfilled" ? stderrResult.value : "";
        const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

        const durationMs = Date.now() - startedAt;

        const outTrunc = truncateText(stdout, MAX_OUTPUT_CHARS);
        const errTrunc = truncateText(stderr, MAX_OUTPUT_CHARS);

        const transportError =
          exitCode === 255 ? inferTransportError(stderr) : undefined;

        return {
          ok: exitCode === 0 && !timedOut,
          exitCode,
          durationMs,
          timedOut,
          target: {
            host: input.host,
            cwd: input.cwd,
            strictHostKeyChecking: true,
            batchMode: true,
          },
          stdout: outTrunc.text,
          stderr: errTrunc.text,
          truncated: {
            stdout: outTrunc.truncated,
            stderr: errTrunc.truncated,
          },
          transportError,
          errors: {
            stdoutRead:
              stdoutResult.status === "rejected"
                ? String(stdoutResult.reason)
                : undefined,
            stderrRead:
              stderrResult.status === "rejected"
                ? String(stderrResult.reason)
                : undefined,
            exitRead:
              exitResult.status === "rejected" ? String(exitResult.reason) : undefined,
            stdinWrite:
              writeResult.status === "rejected" ? String(writeResult.reason) : undefined,
          },
        };
      } finally {
        clearTimeout(timeout);
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
      }
    }

    if (callableId === "ssh.probe") {
      const input = probeInputSchema.parse(rawInput);

      const configured = await readConfiguredHosts();
      requireConfiguredHost(configured, input.host);

      const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
      const controller = new AbortController();
      let timedOut = false;

      const onAbort = () => controller.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, effectiveTimeoutMs);

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
          input.host,
          "bash",
          "-s",
        ];

        const child = Bun.spawn(["ssh", ...sshArgs], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          signal: controller.signal,
          killSignal: "SIGTERM",
          env: {
            ...process.env,
          },
        });

        const script = await buildProbeScript(input);
        const writePromise = writeToStdin(child.stdin, script);

        const [stdoutResult, stderrResult, exitResult, writeResult] =
          await Promise.allSettled([
            readStreamText(child.stdout),
            readStreamText(child.stderr),
            child.exited,
            writePromise,
          ]);

        const stdout =
          stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
        const stderr =
          stderrResult.status === "fulfilled" ? stderrResult.value : "";
        const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

        const durationMs = Date.now() - startedAt;

        const outTrunc = truncateText(stdout, MAX_OUTPUT_CHARS);
        const errTrunc = truncateText(stderr, MAX_OUTPUT_CHARS);

        const transportError =
          exitCode === 255 ? inferTransportError(stderr) : undefined;

        let probe: unknown | undefined;
        let parseError: string | undefined;

        if (exitCode === 0 && !timedOut) {
          try {
            probe = JSON.parse(stdout.trim()) as unknown;
          } catch (e) {
            parseError = e instanceof Error ? e.message : String(e);
          }
        }

        return {
          ok: exitCode === 0 && !timedOut,
          exitCode,
          durationMs,
          timedOut,
          target: {
            host: input.host,
            cwd: input.cwd,
            strictHostKeyChecking: true,
            batchMode: true,
          },
          probe,
          parseError,
          stdout: probe ? undefined : outTrunc.text,
          stderr: errTrunc.text,
          truncated: {
            stdout: outTrunc.truncated,
            stderr: errTrunc.truncated,
          },
          transportError,
          errors: {
            stdoutRead:
              stdoutResult.status === "rejected"
                ? String(stdoutResult.reason)
                : undefined,
            stderrRead:
              stderrResult.status === "rejected"
                ? String(stderrResult.reason)
                : undefined,
            exitRead:
              exitResult.status === "rejected" ? String(exitResult.reason) : undefined,
            stdinWrite:
              writeResult.status === "rejected" ? String(writeResult.reason) : undefined,
          },
        };
      } finally {
        clearTimeout(timeout);
        if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
      }
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
