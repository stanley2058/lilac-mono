import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { expandTilde } from "@stanley2058/lilac-fs";
import { tool, type ToolSet } from "ai";

import {
  DEFAULT_ARTIFACT_MAX_BYTES_PER_SCOPE,
  DEFAULT_ARTIFACT_TTL_MS,
  DEFAULT_BASH_SPOOL_MAX_BYTES,
  type CodingToolArtifactIntegration,
} from "./artifact-integration";
import { createBashOutputSanitizer, sanitizeBashOutputText } from "./bash-output-sanitizer";
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
  truncation?: BashTruncation;
};

export type BashTruncationRetentionStatus =
  | "retained"
  | "spool-limit-exceeded"
  | "spool-unavailable"
  | "artifact-write-failed"
  | "identity-unavailable";

export type BashTruncation = {
  artifactUri?: string;
  artifactBytes?: number;
  message: string;
  originalStdoutBytes: number;
  originalStderrBytes: number;
  previewBytes: number;
  completeOutputRetained: boolean;
  retentionStatus: BashTruncationRetentionStatus;
};

export type BashOutputDelta = {
  type: "output-delta";
  delta: string;
};

const STREAM_FLUSH_INTERVAL_MS = 40;
const STREAM_FLUSH_BYTES = 4 * 1024;

type BoundedStreamCapture = { head: Buffer; tail: Buffer; totalBytes: number };

type BashSpool = {
  stdoutPath: string;
  stderrPath: string;
  complete: boolean;
  limitExceeded: boolean;
  write(kind: "stdout" | "stderr", chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  cleanup(): Promise<void>;
};

const BASH_SPOOL_DIRECTORY_PREFIX = "lilac-coding-bash-";
const MIDDLE_OMISSION_MARKER = "\n...[middle output omitted]...\n";
const SENSITIVE_ENV_NAME_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS)/iu;

function normalizedNonnegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.floor(resolved);
}

async function createBashSpool(maxBytes: number): Promise<BashSpool> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), BASH_SPOOL_DIRECTORY_PREFIX));
  const stdoutPath = path.join(directory, `${randomUUID()}.stdout.raw`);
  const stderrPath = path.join(directory, `${randomUUID()}.stderr.raw`);
  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;
  try {
    await fs.chmod(directory, 0o700);
    stdoutHandle = await fs.open(stdoutPath, "wx", 0o600);
    stderrHandle = await fs.open(stderrPath, "wx", 0o600);
  } catch (error) {
    await Promise.all([
      stdoutHandle?.close().catch(() => undefined),
      stderrHandle?.close().catch(() => undefined),
    ]);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const handles = { stdout: stdoutHandle, stderr: stderrHandle };
  let retainedBytes = 0;
  let closed = false;
  const spool: BashSpool = {
    stdoutPath,
    stderrPath,
    complete: true,
    limitExceeded: false,
    async write(kind, chunk) {
      if (!spool.complete || chunk.byteLength === 0) return;
      const remaining = Math.max(0, maxBytes - retainedBytes);
      const retained = chunk.subarray(0, remaining);
      retainedBytes += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) {
        spool.complete = false;
        spool.limitExceeded = true;
      }
      if (retained.byteLength === 0) return;
      try {
        await handles[kind].write(retained);
      } catch {
        spool.complete = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([
        handles.stdout.close().catch(() => undefined),
        handles.stderr.close().catch(() => undefined),
      ]);
    },
    async cleanup() {
      await spool.close();
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
  return spool;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onDelta?: (delta: string) => void,
  onChunk?: (chunk: Uint8Array) => Promise<void>,
): Promise<BoundedStreamCapture> {
  const reader = stream.getReader();
  const decoder = onDelta ? new TextDecoder() : undefined;
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let totalBytes = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const delta = decoder?.decode(next.value, { stream: true });
      if (delta) onDelta?.(delta);
      totalBytes += next.value.byteLength;
      if (headBytes < maxBytes) {
        const kept = Buffer.from(next.value.subarray(0, maxBytes - headBytes));
        headChunks.push(kept);
        headBytes += kept.byteLength;
      }
      if (maxBytes > 0) {
        tail = Buffer.concat([tail, Buffer.from(next.value)]);
        if (tail.byteLength > maxBytes)
          tail = Buffer.from(tail.subarray(tail.byteLength - maxBytes));
      }
      await onChunk?.(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const finalDelta = decoder?.decode();
  if (finalDelta) onDelta?.(finalDelta);

  return {
    head: Buffer.concat(headChunks),
    tail,
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

function takeUtf8Edge(value: string, maxBytes: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  let bytes = 0;
  let output = "";
  const start = fromEnd ? characters.length - 1 : 0;
  const stop = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== stop; index += step) {
    const character = characters[index];
    if (character === undefined) continue;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output = fromEnd ? character + output : output + character;
    bytes += characterBytes;
  }
  return output;
}

function previewText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const markerBytes = Buffer.byteLength(MIDDLE_OMISSION_MARKER, "utf8");
  if (markerBytes >= maxBytes) return takeUtf8Edge(value, maxBytes, false);
  const contentBytes = maxBytes - markerBytes;
  return `${takeUtf8Edge(value, Math.ceil(contentBytes / 2), false)}${MIDDLE_OMISSION_MARKER}${takeUtf8Edge(value, Math.floor(contentBytes / 2), true)}`;
}

function previewCapture(capture: BoundedStreamCapture, maxBytes: number): string {
  if (capture.totalBytes <= maxBytes) {
    return takeUtf8Edge(capture.head.toString("utf8"), maxBytes, false);
  }
  if (maxBytes <= Buffer.byteLength(MIDDLE_OMISSION_MARKER, "utf8")) {
    return takeUtf8Edge(capture.head.toString("utf8"), maxBytes, false);
  }
  const contentBytes = maxBytes - Buffer.byteLength(MIDDLE_OMISSION_MARKER, "utf8");
  const head = takeUtf8Edge(capture.head.toString("utf8"), Math.ceil(contentBytes / 2), false);
  const tail = takeUtf8Edge(capture.tail.toString("utf8"), Math.floor(contentBytes / 2), true);
  return `${head}${MIDDLE_OMISSION_MARKER}${tail}`;
}

function sensitiveEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_ENV_NAME_PATTERN.test(name) && (value?.length ?? 0) >= 8)
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
}

function createBashArtifactSource(spool: BashSpool, literalSecrets: readonly string[]): Readable {
  async function* rawContent() {
    yield "<bash_tool_full_output>\n--- stdout ---\n";
    yield* createReadStream(spool.stdoutPath);
    yield "\n\n--- stderr ---\n";
    yield* createReadStream(spool.stderrPath);
    yield "\n</bash_tool_full_output>\n";
  }
  async function* sanitizedContent() {
    const sanitizer = createBashOutputSanitizer(literalSecrets);
    for await (const chunk of rawContent()) {
      const sanitized = sanitizer.write(Buffer.from(chunk));
      if (sanitized) yield sanitized;
    }
    const tail = sanitizer.end();
    if (tail) yield tail;
  }
  return Readable.from(sanitizedContent());
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

async function persistBashArtifact(params: {
  integration: CodingToolArtifactIntegration;
  toolCallId: string;
  spool: BashSpool;
  literalSecrets: readonly string[];
}): Promise<{ uri: string; bytes: number }> {
  const artifact = await params.integration.artifacts.createFromStream({
    scopeId: params.integration.scopeId,
    requestId: params.integration.requestId,
    toolCallId: params.toolCallId,
    toolName: "bash",
    source: createBashArtifactSource(params.spool, params.literalSecrets),
    ttlMs: normalizedNonnegativeInteger(
      params.integration.ttlMs,
      DEFAULT_ARTIFACT_TTL_MS,
      "artifactIntegration.ttlMs",
    ),
    maxBytesPerScope: normalizedNonnegativeInteger(
      params.integration.maxBytesPerScope,
      DEFAULT_ARTIFACT_MAX_BYTES_PER_SCOPE,
      "artifactIntegration.maxBytesPerScope",
    ),
    ...(params.integration.maxArtifactBytes === undefined
      ? {}
      : {
          maxArtifactBytes: normalizedNonnegativeInteger(
            params.integration.maxArtifactBytes,
            0,
            "artifactIntegration.maxArtifactBytes",
          ),
        }),
  });
  return { uri: artifact.uri, bytes: artifact.bytes };
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
    artifactIntegration?: CodingToolArtifactIntegration;
    toolCallId?: string;
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

  const environment = options.env ?? process.env;
  const literalSecrets = sensitiveEnvironmentValues(environment);
  let spool: BashSpool | undefined;
  let spoolUnavailable = false;
  if (options.artifactIntegration) {
    try {
      spool = await createBashSpool(
        normalizedNonnegativeInteger(
          options.artifactIntegration.maxSpoolBytes,
          DEFAULT_BASH_SPOOL_MAX_BYTES,
          "artifactIntegration.maxSpoolBytes",
        ),
      );
    } catch {
      spoolUnavailable = true;
    }
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
      env: { ...environment, NO_COLOR: "1", FORCE_COLOR: undefined },
    });
  } catch (error: unknown) {
    await spool?.cleanup();
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
      const bounded = takeUtf8Edge(delta, remaining, false);
      if (!bounded) return;
      streamedOutputBytes += Buffer.byteLength(bounded);
      options.onOutput?.({ type: "output-delta", delta: bounded });
    };
    const [stdoutSettled, stderrSettled, exitSettled] = await Promise.allSettled([
      readBoundedStream(
        stdoutStream,
        maxOutputBytes,
        publishOutput,
        (chunk) => spool?.write("stdout", chunk) ?? Promise.resolve(),
      ),
      readBoundedStream(
        stderrStream,
        maxOutputBytes,
        publishOutput,
        (chunk) => spool?.write("stderr", chunk) ?? Promise.resolve(),
      ),
      child.exited,
    ]);
    if (stdoutSettled.status === "rejected") throw stdoutSettled.reason;
    if (stderrSettled.status === "rejected") throw stderrSettled.reason;
    if (exitSettled.status === "rejected") throw exitSettled.reason;
    const stdoutStreamResult = stdoutSettled.value;
    const stderrStreamResult = stderrSettled.value;
    const exitCode = exitSettled.value;
    await spool?.close();
    const budgets = options.mergeOutput
      ? { stdout: maxOutputBytes, stderr: 0 }
      : allocateOutputBudgets({
          stdoutBytes: stdoutStreamResult.totalBytes,
          stderrBytes: stderrStreamResult.totalBytes,
          maxBytes: maxOutputBytes,
        });
    let stdout = previewCapture(stdoutStreamResult, budgets.stdout);
    let stderr = options.mergeOutput ? "" : previewCapture(stderrStreamResult, budgets.stderr);
    if (options.artifactIntegration) {
      stdout = previewText(sanitizeBashOutputText(stdout, literalSecrets), budgets.stdout);
      stderr = previewText(sanitizeBashOutputText(stderr, literalSecrets), budgets.stderr);
    }
    const stdoutTruncated = options.mergeOutput
      ? stdoutStreamResult.totalBytes + stderrStreamResult.totalBytes > budgets.stdout
      : stdoutStreamResult.totalBytes > budgets.stdout;
    const stderrTruncated = options.mergeOutput
      ? false
      : stderrStreamResult.totalBytes > budgets.stderr;
    const executionError: BashExecutionError | undefined =
      termination === "timeout"
        ? { type: "timeout", timeoutMs, signal: "SIGTERM" }
        : termination === "aborted"
          ? { type: "aborted", signal: "SIGTERM" }
          : undefined;
    let truncation: BashTruncation | undefined;
    if (options.artifactIntegration && (stdoutTruncated || stderrTruncated)) {
      let retentionStatus: BashTruncationRetentionStatus;
      let artifactUri: string | undefined;
      let artifactBytes: number | undefined;
      if (!spool || spoolUnavailable) {
        retentionStatus = "spool-unavailable";
      } else if (!spool.complete) {
        retentionStatus = spool.limitExceeded ? "spool-limit-exceeded" : "spool-unavailable";
      } else if (!options.toolCallId) {
        retentionStatus = "identity-unavailable";
      } else {
        try {
          const artifact = await persistBashArtifact({
            integration: options.artifactIntegration,
            toolCallId: options.toolCallId,
            spool,
            literalSecrets,
          });
          artifactUri = artifact.uri;
          artifactBytes = artifact.bytes;
          retentionStatus = "retained";
        } catch {
          retentionStatus = "artifact-write-failed";
        }
      }
      const previewBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
      truncation = {
        ...(artifactUri ? { artifactUri } : {}),
        ...(artifactBytes === undefined ? {} : { artifactBytes }),
        message: artifactUri
          ? `Bash output was truncated. Complete output: ${artifactUri}. Use read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse nextStart unchanged while hasMore is true.`
          : "Bash output was truncated and the complete output could not be retained. Re-run the command with narrower output if needed.",
        originalStdoutBytes: stdoutStreamResult.totalBytes,
        originalStderrBytes: stderrStreamResult.totalBytes,
        previewBytes,
        completeOutputRetained: artifactUri !== undefined,
        retentionStatus,
      };
    }
    return {
      stdout,
      stderr,
      exitCode,
      stdoutTruncated,
      stderrTruncated,
      ...(executionError ? { executionError } : {}),
      ...(truncation ? { truncation } : {}),
    };
  } catch (error: unknown) {
    killProcessGroup(child.pid, "SIGTERM");
    const forceKill = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), HARD_KILL_DELAY_MS);
    await child.exited.catch(() => undefined);
    clearTimeout(forceKill);
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
    await spool?.cleanup();
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
  artifactIntegration?: CodingToolArtifactIntegration;
}): ToolSet {
  return {
    bash: tool({
      description:
        "Execute a command in local bash from the caller-supplied cwd. Output is capped with a head/tail preview and interactive stdin is disabled. When complete truncated output is retained, truncation.artifactUri can be paged with read_file using the returned nextStart. Path guardrails are best-effort and do not sandbox command contents.",
      inputSchema: bashInputSchema,
      execute: (input, { abortSignal, toolCallId }) => {
        const options = {
          cwd: params.cwd,
          denyPaths: params.denyPaths,
          defaultTimeoutMs: params.timeoutMs,
          maxOutputBytes: params.maxOutputBytes,
          env: params.env,
          abortSignal,
          allowGuardrailBypass: params.allowGuardrailBypass,
          mergeOutput: params.mergeOutput,
          artifactIntegration: params.artifactIntegration,
          toolCallId,
        };
        return params.streamOutput
          ? streamLocalBash(input, options)
          : executeLocalBash(input, options);
      },
    }),
  };
}
