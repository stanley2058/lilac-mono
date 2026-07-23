import { homedir } from "node:os";
import path from "node:path";

import { expandTilde } from "@stanley2058/lilac-fs";
import { tool, type ToolSet } from "ai";

import {
  assertCanonicalPathAllowed,
  assertGuardrailBypassAllowed,
  assertLocalCwd,
} from "./guardrails";
import { bashInputSchema, type BashInput } from "./schemas";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OUTPUT_CAP_BYTES = 40 * 1024;
const HARD_KILL_DELAY_MS = 500;

export type BashExecutionError =
  | { type: "blocked"; reason: string }
  | { type: "aborted"; signal: "SIGTERM" }
  | { type: "timeout"; timeoutMs: number; signal: "SIGTERM" }
  | { type: "exception"; message: string };

export type BashOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  executionError?: BashExecutionError;
};

export type BashOutputDelta = {
  type: "output-delta";
  delta: string;
};

const STREAM_FLUSH_INTERVAL_MS = 40;
const STREAM_FLUSH_BYTES = 4 * 1024;

type CappedStream = { bytes: Uint8Array; totalBytes: number };

async function readCappedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onDelta?: (delta: string) => void,
): Promise<CappedStream> {
  const reader = stream.getReader();
  const decoder = onDelta ? new TextDecoder() : undefined;
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const delta = decoder?.decode(next.value, { stream: true });
    if (delta) onDelta?.(delta);
    totalBytes += next.value.byteLength;
    if (retainedBytes >= maxBytes) continue;
    const remaining = maxBytes - retainedBytes;
    const kept = next.value.subarray(0, remaining);
    chunks.push(kept);
    retainedBytes += kept.byteLength;
  }
  const finalDelta = decoder?.decode();
  if (finalDelta) onDelta?.(finalDelta);

  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    totalBytes,
  };
}

function allocateOutputBudgets(params: {
  stdoutBytes: number;
  stderrBytes: number;
  maxBytes: number;
}): { stdout: number; stderr: number } {
  const both = params.stdoutBytes > 0 && params.stderrBytes > 0;
  let stdout = both
    ? Math.min(params.stdoutBytes, Math.ceil(params.maxBytes / 2))
    : Math.min(params.stdoutBytes, params.maxBytes);
  let stderr = both
    ? Math.min(params.stderrBytes, Math.floor(params.maxBytes / 2))
    : Math.min(params.stderrBytes, params.maxBytes);
  let remaining = Math.max(0, params.maxBytes - stdout - stderr);
  const stdoutExtra = Math.min(Math.max(0, params.stdoutBytes - stdout), remaining);
  stdout += stdoutExtra;
  remaining -= stdoutExtra;
  stderr += Math.min(Math.max(0, params.stderrBytes - stderr), remaining);
  return { stdout, stderr };
}

function decodeUtf8WithinBudget(bytes: Uint8Array, budget: number): string {
  let end = Math.min(bytes.byteLength, budget);
  while (end > 0) {
    const text = Buffer.from(bytes.subarray(0, end)).toString("utf8");
    if (Buffer.byteLength(text, "utf8") <= budget) return text;
    end--;
  }
  return "";
}

function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function protectedPathInCommand(command: string, denyPaths: readonly string[]): string | undefined {
  const home = homedir();
  for (const denied of denyPaths) {
    const expanded = path.resolve(expandTilde(denied));
    const relativeToHome = path.relative(home, expanded).split(path.sep).join("/");
    const spellings = [expanded];
    if (!relativeToHome.startsWith("..") && relativeToHome !== "") {
      spellings.push(
        `~/${relativeToHome}`,
        `$HOME/${relativeToHome}`,
        `\${HOME}/${relativeToHome}`,
      );
    }
    if (spellings.some((spelling) => command.includes(spelling))) return expanded;
  }
  return undefined;
}

export async function executeLocalBash(
  input: BashInput,
  options: {
    cwd: string;
    denyPaths: readonly string[];
    defaultTimeoutMs?: number;
    maxOutputBytes?: number;
    env?: Readonly<Record<string, string | undefined>>;
    abortSignal?: AbortSignal;
    allowGuardrailBypass?: boolean;
    onOutput?: (update: BashOutputDelta) => void;
    mergeOutput?: boolean;
  },
): Promise<BashOutput> {
  assertGuardrailBypassAllowed(input.dangerouslyAllow, options.allowGuardrailBypass ?? false);
  if (input.cwd) assertLocalCwd(input.cwd);
  const cwd = path.resolve(expandTilde(input.cwd ?? options.cwd));
  const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = Math.max(
    1,
    Math.floor(options.maxOutputBytes ?? DEFAULT_OUTPUT_CAP_BYTES),
  );
  const blockedPath = input.dangerouslyAllow
    ? undefined
    : protectedPathInCommand(input.command, options.denyPaths);
  let cwdBlockReason: string | undefined;
  if (!input.dangerouslyAllow) {
    try {
      await assertCanonicalPathAllowed(cwd, options.denyPaths, "bash cwd");
    } catch (error: unknown) {
      cwdBlockReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (blockedPath || cwdBlockReason) {
    const reason = cwdBlockReason ?? `Access denied: '${blockedPath}' is protected`;
    return {
      stdout: "",
      stderr: reason,
      exitCode: -1,
      stdoutTruncated: false,
      stderrTruncated: false,
      executionError: { type: "blocked", reason },
    };
  }

  if (options.abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      stdoutTruncated: false,
      stderrTruncated: false,
      executionError: { type: "aborted", signal: "SIGTERM" },
    };
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    const stdinCommand = input.stdinMode === "eof" ? input.command : `exec 0>&-; ${input.command}`;
    const command = options.mergeOutput ? `exec 2>&1; ${stdinCommand}` : stdinCommand;
    child = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: { ...(options.env ?? process.env), NO_COLOR: "1", FORCE_COLOR: undefined },
    });
  } catch (error: unknown) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      stdoutTruncated: false,
      stderrTruncated: false,
      executionError: {
        type: "exception",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  let termination: "aborted" | "timeout" | undefined;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "aborted" | "timeout") => {
    if (termination) return;
    termination = reason;
    killProcessGroup(child.pid, "SIGTERM");
    hardKillTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), HARD_KILL_DELAY_MS);
  };
  const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
  const onAbort = () => terminate("aborted");
  if (options.abortSignal?.aborted) onAbort();
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (
      !stdoutStream ||
      typeof stdoutStream === "number" ||
      !stderrStream ||
      typeof stderrStream === "number"
    ) {
      throw new Error("Bun.spawn did not provide piped output streams");
    }
    let streamedOutputBytes = 0;
    const publishOutput = (delta: string) => {
      const remaining = Math.max(0, maxOutputBytes - streamedOutputBytes);
      if (remaining === 0) return;
      const bounded = decodeUtf8WithinBudget(Buffer.from(delta), remaining);
      if (!bounded) return;
      streamedOutputBytes += Buffer.byteLength(bounded);
      options.onOutput?.({ type: "output-delta", delta: bounded });
    };
    const [stdoutStreamResult, stderrStreamResult, exitCode] = await Promise.all([
      readCappedStream(stdoutStream, maxOutputBytes, publishOutput),
      readCappedStream(stderrStream, maxOutputBytes, publishOutput),
      child.exited,
    ]);
    const budgets = options.mergeOutput
      ? { stdout: maxOutputBytes, stderr: 0 }
      : allocateOutputBudgets({
          stdoutBytes: stdoutStreamResult.totalBytes,
          stderrBytes: stderrStreamResult.totalBytes,
          maxBytes: maxOutputBytes,
        });
    const stdout = options.mergeOutput
      ? decodeUtf8WithinBudget(
          Buffer.concat([stdoutStreamResult.bytes, stderrStreamResult.bytes]),
          budgets.stdout,
        )
      : decodeUtf8WithinBudget(stdoutStreamResult.bytes, budgets.stdout);
    const stderr = options.mergeOutput
      ? ""
      : decodeUtf8WithinBudget(stderrStreamResult.bytes, budgets.stderr);
    const executionError: BashExecutionError | undefined =
      termination === "timeout"
        ? { type: "timeout", timeoutMs, signal: "SIGTERM" }
        : termination === "aborted"
          ? { type: "aborted", signal: "SIGTERM" }
          : undefined;
    return {
      stdout,
      stderr,
      exitCode,
      stdoutTruncated: options.mergeOutput
        ? stdoutStreamResult.totalBytes + stderrStreamResult.totalBytes > budgets.stdout
        : stdoutStreamResult.totalBytes > budgets.stdout,
      stderrTruncated: options.mergeOutput ? false : stderrStreamResult.totalBytes > budgets.stderr,
      ...(executionError ? { executionError } : {}),
    };
  } catch (error: unknown) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      stdoutTruncated: false,
      stderrTruncated: false,
      executionError: {
        type: "exception",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function* streamLocalBash(
  input: BashInput,
  options: Parameters<typeof executeLocalBash>[1],
): AsyncGenerator<BashOutputDelta | BashOutput, BashOutput> {
  let bufferedOutput = "";
  let bufferedBytes = 0;
  let outputReady = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let completed: { ok: true; output: BashOutput } | { ok: false; error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const markOutputReady = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    outputReady = bufferedOutput.length > 0;
    notify();
  };
  void executeLocalBash(input, {
    ...options,
    onOutput: (update) => {
      bufferedOutput += update.delta;
      bufferedBytes += Buffer.byteLength(update.delta);
      if (bufferedBytes >= STREAM_FLUSH_BYTES) {
        markOutputReady();
      } else if (flushTimer === undefined) {
        flushTimer = setTimeout(markOutputReady, STREAM_FLUSH_INTERVAL_MS);
      }
    },
  }).then(
    (output) => {
      completed = { ok: true, output };
      markOutputReady();
    },
    (error: unknown) => {
      completed = { ok: false, error };
      markOutputReady();
    },
  );

  while (completed === undefined || outputReady || bufferedOutput.length > 0) {
    if (outputReady || (completed !== undefined && bufferedOutput.length > 0)) {
      const delta = bufferedOutput;
      bufferedOutput = "";
      bufferedBytes = 0;
      outputReady = false;
      yield { type: "output-delta", delta };
      continue;
    }
    if (completed !== undefined) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (outputReady || completed !== undefined) notify();
    });
  }
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  if (completed === undefined) throw new Error("Bash output stream ended without a result");
  if (!completed.ok) throw completed.error;
  return completed.output;
}

export function createBashTool(params: {
  cwd: string;
  denyPaths: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string | undefined>>;
  allowGuardrailBypass?: boolean;
  streamOutput?: boolean;
  mergeOutput?: boolean;
}): ToolSet {
  return {
    bash: tool({
      description:
        "Execute a command in local bash from the caller-supplied cwd. Output is capped and interactive stdin is disabled. Path guardrails are best-effort and do not sandbox command contents.",
      inputSchema: bashInputSchema,
      execute: (input, { abortSignal }) => {
        const options = {
          cwd: params.cwd,
          denyPaths: params.denyPaths,
          defaultTimeoutMs: params.timeoutMs,
          maxOutputBytes: params.maxOutputBytes,
          env: params.env,
          abortSignal,
          allowGuardrailBypass: params.allowGuardrailBypass,
          mergeOutput: params.mergeOutput,
        };
        return params.streamOutput
          ? streamLocalBash(input, options)
          : executeLocalBash(input, options);
      },
    }),
  };
}
