import {
  createLogger,
  env,
  errorCode,
  formatTaggedErrorForLog,
  isPanic,
  resolveVcsEnv,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { analyzeBashCommand, type BashSafetyCode } from "@stanley2058/lilac-bash-safety";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { formatBlockedMessage, redactSecrets } from "./bash-safety/format";
import { expandTilde } from "@stanley2058/lilac-fs";

import { getGithubEnvForBash } from "../github/github-auth";

import {
  formatRemoteDisplayPath,
  parseSshCwdTarget,
  toBashSafetyCwdForRemote,
} from "../ssh/ssh-cwd";
import { sshExecBash } from "../ssh/ssh-exec";
import {
  BashOutputCleanupError,
  BashOutputStreamAndCleanupError,
  BashOutputStreamError,
  createBashOutputSanitizerTransform,
  readSanitizedStreamTextCapped,
} from "./bash-output-sanitizer";
import { loadToolEnv } from "./tool-env";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

export const BASH_NO_OUTPUT_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_KILL_SIGNAL = "SIGTERM";
const DEFAULT_BASH_STDIN_MODE: BashStdinMode = "error";
const BASH_TRUNCATED_OUTPUT_DIR = "/tmp";

const DEFAULT_MAX_BASH_OUTPUT_BYTES = 40 * 1024;

const logger = createLogger({
  module: "tool:bash",
});

type BashLogValue = string | number | boolean | null | undefined;
type BashLogFields = Readonly<Record<string, BashLogValue>>;

function logBashInfo(message: string, fields: BashLogFields): void {
  logger.info(message, fields);
}

function logBashWarn(message: string, fields: BashLogFields): void {
  logger.warn(message, fields);
}

function logBashError(message: string, fields: BashLogFields): void {
  logger.error(message, fields);
}

export type BashToolInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * stdin behavior for child commands.
   * - "error" (default): stdin reads fail immediately (EBADF).
   * - "eof": stdin is /dev/null (reads return EOF).
   */
  stdinMode?: BashStdinMode;
  /** Bypass bash safety guardrails for this call. */
  dangerouslyAllow?: boolean;
};

export type BashStdinMode = "error" | "eof";

export type BashSpawnErrno = "EACCES" | "ENOENT" | "ENOTDIR" | "EPERM";

export type BashExceptionCode =
  | "cleanup_failed"
  | "execution_failed"
  | "exit_status_read_failed"
  | "spawn_cwd_missing"
  | "spawn_failed"
  | "stderr_read_failed"
  | "stdout_read_failed";

export type BashExecutionError =
  | {
      type: "blocked";
      code: BashSafetyCode | "restricted_cwd";
      reason: string;
      hint?: string;
      segment?: string;
    }
  | {
      type: "aborted";
      code: "execution_cancelled";
      signal?: string;
    }
  | {
      type: "timeout";
      code: "no_output_timeout" | "wall_clock_timeout";
      timeoutMs: number;
      timeoutKind: "no_output" | "wall_clock";
      signal: string;
    }
  | {
      type: "exception";
      code: BashExceptionCode;
      phase: "spawn" | "stdout" | "stderr" | "unknown";
      message: string;
      errno?: BashSpawnErrno;
      cwd?: string;
    };

type BashTermination =
  | { type: "aborted" }
  | { type: "timeout"; timeoutKind: "no_output" | "wall_clock"; timeoutMs: number };

export type BashToolOutput = {
  stdout: string;
  stderr: string;
  /**
   * Exit code of the command.
   *
   * Notes:
   * - Non-zero exit codes mean the command failed.
   * - A value of -1 means the tool failed to execute the command (see executionError).
   */
  exitCode: number;
  /**
   * Tool-level error (timeout, spawn failure, or stream read failure).
   *
   * This is distinct from a command failure, which is represented by a non-zero exitCode.
   */
  executionError?: BashExecutionError;
  truncation?: {
    artifactUri?: string;
    message: string;
    originalStdoutBytes: number;
    originalStderrBytes: number;
    previewBytes: number;
    completeOutputRetained: boolean;
  };
};

class BashAdapterError extends TaggedError("BashAdapterError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly errno?: BashSpawnErrno;
  readonly message: string;
}> {}

export class BashSpillCleanupError extends TaggedError("BashSpillCleanupError")<{
  readonly failures: readonly BashAdapterError[];
  readonly message: string;
}> {}

export class BashOperationAndCleanupError extends TaggedError("BashOperationAndCleanupError")<{
  readonly primary: BashAdapterError;
  readonly cleanup: BashSpillCleanupError;
  readonly message: string;
}> {}

export class BashReportedExecutionAndCleanupError extends TaggedError(
  "BashReportedExecutionAndCleanupError",
)<{
  readonly primary: BashExecutionError;
  readonly cleanup: BashSpillCleanupError;
  readonly message: string;
}> {}

export interface BashSpillFileOperations {
  remove(target: string): Promise<void>;
}

const DEFAULT_SPILL_FILE_OPERATIONS: BashSpillFileOperations = {
  remove: (target) => fs.rm(target, { force: true }),
};

function mapCapturedBashExecutionFailure(
  capture: ReturnType<typeof captureRuntimeError>,
): BashAdapterError | Panic {
  if (capture.kind === "panic") return capture.panic;
  const caught = projectCapturedRuntimeError(capture, "Opaque Bash execution failure");
  const code = errorCode(caught);
  let errno: BashSpawnErrno | undefined;
  switch (code) {
    case "EACCES":
    case "ENOENT":
    case "ENOTDIR":
    case "EPERM":
      errno = code;
      break;
  }
  return new BashAdapterError({
    operation: "execute",
    cause: caught,
    errno,
    message: "Bash execution failed",
  });
}

async function settleBashExecution(
  run: () => Promise<BashToolOutput>,
): Promise<ResultType<BashToolOutput, BashAdapterError | Panic>> {
  const captured = await Result.tryPromise({
    try: run,
    catch: captureRuntimeError,
  });
  return captured.mapError(mapCapturedBashExecutionFailure);
}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

async function cleanupBashSpills(
  paths: readonly string[],
  operations: BashSpillFileOperations,
): Promise<ResultType<void, BashSpillCleanupError | Panic>> {
  const failures: BashAdapterError[] = [];
  let deferredPanic: Panic | undefined;
  for (const target of new Set(paths)) {
    const [attempt] = await Promise.allSettled([
      Promise.resolve().then(() => operations.remove(target)),
    ]);
    if (attempt?.status === "rejected") {
      if (isPanic(attempt.reason)) {
        deferredPanic ??= attempt.reason;
        continue;
      }
      failures.push(
        new BashAdapterError({
          operation: "remove_temporary_spill",
          cause: attempt.reason,
          message: "Failed to remove temporary Bash output spill",
        }),
      );
    }
  }

  if (deferredPanic) return Result.err(deferredPanic);
  return failures.length === 0
    ? Result.ok()
    : Result.err(
        new BashSpillCleanupError({
          failures,
          message: "Bash temporary output cleanup failed",
        }),
      );
}

function appendCleanupNotice(stderr: string): string {
  const notice = "Bash temporary output cleanup failed.";
  return stderr.length > 0 ? `${stderr}\n${notice}` : notice;
}

function formatBashStreamFailureForLog(reason: unknown): BashLogFields {
  if (
    BashOutputStreamError.is(reason) ||
    BashOutputCleanupError.is(reason) ||
    BashOutputStreamAndCleanupError.is(reason)
  ) {
    return { failureTag: reason._tag, failureMessage: reason.message };
  }
  return { failureMessage: "Bash stream operation failed" };
}

function surfaceBashCleanupFailure(
  output: BashToolOutput,
  cleanup: BashSpillCleanupError,
): BashToolOutput {
  if (output.executionError) {
    const combined = new BashReportedExecutionAndCleanupError({
      primary: output.executionError,
      cleanup,
      message: "Bash execution failed and temporary output cleanup also failed",
    });
    logger.error("bash execution and cleanup failed", formatTaggedErrorForLog(combined));
    return { ...output, stderr: appendCleanupNotice(output.stderr) };
  }

  logger.error("bash cleanup failed", formatTaggedErrorForLog(cleanup));
  return {
    ...output,
    stderr: appendCleanupNotice(output.stderr),
    exitCode: -1,
    executionError: {
      type: "exception",
      code: "cleanup_failed",
      phase: "unknown",
      message: cleanup.message,
    },
  };
}

async function failedSpawnCwdIsMissing(resolvedCwd: string): Promise<boolean> {
  const inspected = await Result.tryPromise({
    try: () => fs.stat(resolvedCwd),
    catch: captureRuntimeError,
  });
  const outcome = inspected.match<
    | { readonly kind: "stat"; readonly isDirectory: boolean }
    | { readonly kind: "error"; readonly captured: ReturnType<typeof captureRuntimeError> }
  >({
    ok: (stat) => ({ kind: "stat", isDirectory: stat.isDirectory() }),
    err: (captured) => ({ kind: "error", captured }),
  });
  if (outcome.kind === "stat") return !outcome.isDirectory;

  const cause = projectCapturedRuntimeError(outcome.captured, "Opaque Bash cwd inspection failure");
  preserveToolPanic(cause);
  const code = errorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function toFailedExecutionError(
  termination: BashTermination | undefined,
  errno: BashSpawnErrno | undefined,
  resolvedCwd: string,
  local: boolean,
): Promise<BashExecutionError> {
  if (!termination) {
    const cwdMissing =
      local &&
      (errno === "ENOENT" || errno === "ENOTDIR") &&
      (await failedSpawnCwdIsMissing(resolvedCwd));
    if (cwdMissing) {
      return {
        type: "exception",
        code: "spawn_cwd_missing",
        phase: "spawn",
        message: `Bash cwd does not exist or is not a directory: ${resolvedCwd}`,
        errno,
        cwd: resolvedCwd,
      };
    }
    return {
      type: "exception",
      code: "spawn_failed",
      phase: "spawn",
      message: "Bash process could not be started",
      ...(errno ? { errno } : {}),
      cwd: resolvedCwd,
    };
  }
  switch (termination.type) {
    case "timeout":
      return {
        ...termination,
        code: termination.timeoutKind === "no_output" ? "no_output_timeout" : "wall_clock_timeout",
        signal: DEFAULT_KILL_SIGNAL,
      };
    case "aborted":
      return { type: "aborted", code: "execution_cancelled", signal: DEFAULT_KILL_SIGNAL };
  }
}

function stripAnsiEscapeSequences(input: string): string {
  let output = "";
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) output += input.slice(plainStart, end);
  };

  const skipCsi = (start: number): number => {
    let i = start;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      i += 1;
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return i;
  };

  const skipOsc = (start: number): number => {
    let i = start;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code === 0x07) return i + 1;
      if (code === 0x9c) return i + 1;
      if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
      i += 1;
    }
    return i;
  };

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      flushPlain(i);
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = skipCsi(i + 2) - 1;
      } else if (next === 0x5d) {
        i = skipOsc(i + 2) - 1;
      } else {
        i = Math.min(i + 1, input.length - 1);
      }
      plainStart = i + 1;
      continue;
    }

    if (code === 0x9b) {
      flushPlain(i);
      i = skipCsi(i + 1) - 1;
      plainStart = i + 1;
      continue;
    }

    if (code === 0x9d) {
      flushPlain(i);
      i = skipOsc(i + 1) - 1;
      plainStart = i + 1;
    }
  }

  flushPlain(input.length);
  return [...output]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f;
    })
    .join("");
}

function sanitizeTempFileToken(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;

  const safe = trimmed
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return safe.length > 0 ? safe : fallback;
}

function buildTruncatedOutputPaths(params: { requestId?: string; toolCallId?: string }): {
  outputPath: string;
  stdoutOverflowPath: string;
  stderrOverflowPath: string;
} {
  const requestToken = sanitizeTempFileToken(params.requestId, "unknown-request");
  const toolToken = sanitizeTempFileToken(params.toolCallId, "unknown-tool");
  const fileName = `${requestToken}-${toolToken}-${randomUUID()}.log`;
  const outputPath = path.join(BASH_TRUNCATED_OUTPUT_DIR, fileName);
  return {
    outputPath,
    stdoutOverflowPath: `${outputPath}.stdout.part`,
    stderrOverflowPath: `${outputPath}.stderr.part`,
  };
}

function createBashArtifactSource(params: {
  requestId?: string;
  toolCallId?: string;
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Readable {
  async function* content() {
    yield (
      "<bash_tool_full_output>\n" +
        `requestId: ${params.requestId ?? "unknown"}\n` +
        `toolCallId: ${params.toolCallId ?? "unknown"}\n\n`
    );
    yield "--- stdout ---\n";
    if (params.stdoutOverflowPath) yield* createReadStream(params.stdoutOverflowPath);
    else yield params.stdout;
    yield "\n\n--- stderr ---\n";
    if (params.stderrOverflowPath) yield* createReadStream(params.stderrOverflowPath);
    else yield params.stderr;
    yield "\n</bash_tool_full_output>\n";
  }

  return Readable.from(content());
}

function takeUtf8Edge(value: string, maxBytes: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  let bytes = 0;
  let output = "";
  const start = fromEnd ? characters.length - 1 : 0;
  const stop = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== stop; index += step) {
    const character = characters[index]!;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output = fromEnd ? character + output : output + character;
    bytes += characterBytes;
  }
  return output;
}

function previewStream(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const totalCharacters = Array.from(value).length;
  const marker = `\n...[${totalCharacters} characters omitted]...\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return takeUtf8Edge(value, maxBytes, false);
  const contentBudget = maxBytes - markerBytes;
  const head = takeUtf8Edge(value, Math.ceil(contentBudget / 2), false);
  const tail = takeUtf8Edge(value, Math.floor(contentBudget / 2), true);
  const omitted = Math.max(0, totalCharacters - Array.from(head).length - Array.from(tail).length);
  return `${head}\n...[${omitted} characters omitted]...\n${tail}`;
}

async function overflowStreamBytes(captured: string, overflowPath?: string): Promise<number> {
  if (!overflowPath) return Buffer.byteLength(captured, "utf8");
  const inspected = (
    await Result.tryPromise({ try: () => fs.stat(overflowPath), catch: captureRuntimeError })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque Bash overflow stat failure"),
  );
  const inspectError = inspected.match({ ok: () => null, err: (error) => error });
  if (inspectError) {
    preserveToolPanic(inspectError);
    return Buffer.byteLength(captured, "utf8");
  }
  return inspected.match({ ok: (value) => value.size, err: () => 0 });
}

async function readOverflowTail(
  overflowPath: string,
  contentBudget: number,
): Promise<ResultType<Buffer, BashAdapterError | BashOperationAndCleanupError>> {
  const opened = (
    await Result.tryPromise({
      try: () => fs.open(overflowPath, "r"),
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque Bash overflow open failure"),
  );
  const openError = opened.match({ ok: () => null, err: (error) => error });
  if (openError) {
    return Result.err(
      new BashAdapterError({
        operation: "open_overflow",
        cause: preserveToolPanic(openError),
        message: "Failed to open Bash overflow output",
      }),
    );
  }

  const handle = selectResultValue(opened);
  const readTail = async () => {
    const stat = await handle.stat();
    const readBytes = Math.min(stat.size, Math.max(4096, contentBudget * 4));
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    return buffer;
  };
  const read = (await Result.tryPromise({ try: readTail, catch: captureRuntimeError })).mapError(
    (captured) => projectCapturedRuntimeError(captured, "Opaque Bash overflow read failure"),
  );
  const closed = (
    await Result.tryPromise({ try: () => handle.close(), catch: captureRuntimeError })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque Bash overflow close failure"),
  );
  const readCause = read.match({ ok: () => null, err: (error) => error });
  const closeCause = closed.match({ ok: () => null, err: (error) => error });
  if (readCause && isPanic(readCause)) preserveToolPanic(readCause);
  if (closeCause && isPanic(closeCause)) preserveToolPanic(closeCause);

  if (readCause) {
    const readError = new BashAdapterError({
      operation: "read_overflow",
      cause: readCause,
      message: "Failed to read Bash overflow output",
    });
    if (!closeCause) return Result.err(readError);
    const closeError = new BashAdapterError({
      operation: "close_overflow",
      cause: closeCause,
      message: "Failed to close Bash overflow output",
    });
    return Result.err(
      new BashOperationAndCleanupError({
        primary: readError,
        cleanup: new BashSpillCleanupError({
          failures: [closeError],
          message: "Failed to close Bash overflow output after its read failed",
        }),
        message: "Failed to read and close Bash overflow output",
      }),
    );
  }
  if (closeCause) {
    return Result.err(
      new BashAdapterError({
        operation: "close_overflow",
        cause: closeCause,
        message: "Failed to close Bash overflow output",
      }),
    );
  }
  return Result.ok(read.match({ ok: (value) => value, err: () => Buffer.alloc(0) }));
}

async function buildOverflowStreamPreview(params: {
  captured: string;
  overflowPath?: string;
  maxBytes: number;
  literalSecrets: readonly string[];
}): Promise<string> {
  if (!params.overflowPath) return previewStream(params.captured, params.maxBytes);
  const marker = "\n...[output omitted]...\n";
  const contentBudget = Math.max(0, params.maxBytes - Buffer.byteLength(marker, "utf8"));
  const head = takeUtf8Edge(params.captured, Math.ceil(contentBudget / 2), false);
  const read = await readOverflowTail(params.overflowPath, contentBudget);
  const readValue = read.match({ ok: (value) => value, err: () => null });
  if (!readValue) return previewStream(params.captured, params.maxBytes);
  const sanitized = redactSecrets(
    stripAnsiEscapeSequences(readValue.toString("utf8")),
    params.literalSecrets,
  );
  const tail = takeUtf8Edge(sanitized, Math.floor(contentBudget / 2), true);
  return `${head}${marker}${tail}`;
}

function allocateStreamPreviewBytes(params: {
  stdoutBytes: number;
  stderrBytes: number;
  maxBytes: number;
}): { stdout: number; stderr: number } {
  const both = params.stdoutBytes > 0 && params.stderrBytes > 0;
  let stdout = 0;
  let stderr = 0;
  if (both) {
    stdout = Math.min(params.stdoutBytes, Math.ceil(params.maxBytes / 2));
    stderr = Math.min(params.stderrBytes, Math.floor(params.maxBytes / 2));
  } else if (params.stdoutBytes > 0) {
    stdout = params.maxBytes;
  } else if (params.stderrBytes > 0) {
    stderr = params.maxBytes;
  }
  let remaining = Math.max(0, params.maxBytes - stdout - stderr);
  const stdoutExtra = Math.min(Math.max(0, params.stdoutBytes - stdout), remaining);
  stdout += stdoutExtra;
  remaining -= stdoutExtra;
  stderr += Math.min(Math.max(0, params.stderrBytes - stderr), remaining);
  return { stdout, stderr };
}

function limitBashOutput(
  input: { stdout: string; stderr: string },
  maxOutputBytes: number,
  options?: { truncated?: boolean },
): {
  stdout: string;
  stderr: string;
  truncated: boolean;
} {
  const stdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(input.stderr, "utf8");
  const totalBytes = stdoutBytes + stderrBytes;
  const truncated = Boolean(options?.truncated) || totalBytes > maxOutputBytes;
  if (!truncated) {
    return { ...input, truncated: false };
  }

  if (totalBytes <= maxOutputBytes) {
    return {
      stdout: input.stdout,
      stderr: input.stderr,
      truncated: true,
    };
  }

  const available = Math.max(0, maxOutputBytes);
  const bothStreams = input.stdout.length > 0 && input.stderr.length > 0;
  let stdoutBudget = 0;
  let stderrBudget = 0;
  if (bothStreams) {
    stdoutBudget = Math.min(stdoutBytes, Math.ceil(available / 2));
    stderrBudget = Math.min(stderrBytes, Math.floor(available / 2));
  } else if (input.stdout.length > 0) {
    stdoutBudget = available;
  } else if (input.stderr.length > 0) {
    stderrBudget = available;
  }
  let remaining = Math.max(0, available - stdoutBudget - stderrBudget);
  const stdoutNeed = Math.max(0, stdoutBytes - stdoutBudget);
  const stdoutExtra = Math.min(stdoutNeed, remaining);
  stdoutBudget += stdoutExtra;
  remaining -= stdoutExtra;
  stderrBudget += Math.min(Math.max(0, stderrBytes - stderrBudget), remaining);
  let stdoutPart = previewStream(input.stdout, stdoutBudget);
  let stderrPart = previewStream(input.stderr, stderrBudget);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const usedBytes = Buffer.byteLength(stdoutPart, "utf8") + Buffer.byteLength(stderrPart, "utf8");
    if (usedBytes <= available) break;
    const excess = usedBytes - available;
    if (stdoutBudget > 0 && stderrBudget > 0) {
      stdoutBudget = Math.max(0, stdoutBudget - Math.ceil(excess / 2));
      stderrBudget = Math.max(0, stderrBudget - Math.floor(excess / 2));
    } else if (stdoutBudget > 0) {
      stdoutBudget = Math.max(0, stdoutBudget - excess);
    } else {
      stderrBudget = Math.max(0, stderrBudget - excess);
    }
    stdoutPart = previewStream(input.stdout, stdoutBudget);
    stderrPart = previewStream(input.stderr, stderrBudget);
  }

  return {
    stdout: stdoutPart,
    stderr: stderrPart,
    truncated: true,
  };
}

export function withLimitedBashOutput(
  output: BashToolOutput,
  options: {
    maxOutputBytes: number;
    truncated?: boolean;
    artifactUri?: string;
    originalStdoutBytes?: number;
    originalStderrBytes?: number;
  },
): BashToolOutput {
  const limited = limitBashOutput(
    { stdout: output.stdout, stderr: output.stderr },
    options.maxOutputBytes,
    { truncated: options.truncated },
  );
  if (!limited.truncated) return output;

  const originalStdoutBytes =
    options.originalStdoutBytes ?? Buffer.byteLength(output.stdout, "utf8");
  const originalStderrBytes =
    options.originalStderrBytes ?? Buffer.byteLength(output.stderr, "utf8");
  const message = options.artifactUri
    ? `Bash output was truncated. Complete output: ${options.artifactUri}. Use read with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.`
    : "Bash output was truncated and the complete output could not be retained. Re-run the command with narrower output if needed.";

  logger.info("tool.result.truncated", {
    toolName: "bash",
    outputKind: "stdout-stderr",
    originalBytes: originalStdoutBytes + originalStderrBytes,
    previewBytes:
      Buffer.byteLength(limited.stdout, "utf8") + Buffer.byteLength(limited.stderr, "utf8"),
    artifactStored: options.artifactUri !== undefined,
  });

  return {
    ...output,
    stdout: limited.stdout,
    stderr: limited.stderr,
    truncation: {
      ...(options.artifactUri ? { artifactUri: options.artifactUri } : {}),
      message,
      originalStdoutBytes,
      originalStderrBytes,
      previewBytes:
        Buffer.byteLength(limited.stdout, "utf8") + Buffer.byteLength(limited.stderr, "utf8"),
      completeOutputRetained: options.artifactUri !== undefined,
    },
  };
}

async function persistTruncatedOutput(params: {
  artifacts?: ToolResultArtifactStore;
  outputConfig: CoreConfig["tools"]["output"];
  context?: { requestId: string; sessionId: string; requestClient: string };
  toolCallId?: string;
  literalSecrets: readonly string[];
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Promise<{ uri?: string }> {
  if (!params.artifacts || !params.context || !params.toolCallId) return {};
  const artifacts = params.artifacts;
  const context = params.context;
  const toolCallId = params.toolCallId;
  const source = createBashArtifactSource({
    requestId: context.requestId,
    toolCallId,
    stdout: params.stdout,
    stderr: params.stderr,
    stdoutOverflowPath: params.stdoutOverflowPath,
    stderrOverflowPath: params.stderrOverflowPath,
  }).pipe(createBashOutputSanitizerTransform(params.literalSecrets));
  const created = (
    await Result.tryPromise({
      try: () =>
        artifacts.createFromStream({
          sessionId: context.sessionId,
          requestId: context.requestId,
          toolCallId,
          toolName: "bash",
          source,
          ttlMs: params.outputConfig.artifactTtlMs,
          maxBytesPerSession: params.outputConfig.artifactMaxBytesPerSession,
        }),
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque Bash artifact persistence failure"),
  );
  let result: { uri?: string } = {};
  const createError = created.match({ ok: () => null, err: (error) => error });
  if (createError) {
    const cause = preserveToolPanic(createError);
    logger.warn("tool.artifact.write_failed", {
      toolName: "bash",
      ...formatTaggedErrorForLog(
        new BashAdapterError({
          operation: "persist_artifact",
          cause,
          message: "Failed to persist Bash output artifact",
        }),
      ),
    });
  } else {
    const artifact = selectResultValue(created);
    const artifactError = artifact.match({ ok: () => null, err: (error) => error });
    if (artifactError) {
      logger.warn("tool.artifact.write_failed", {
        toolName: "bash",
        ...formatTaggedErrorForLog(artifactError),
      });
    } else {
      result = artifact.match({ ok: (value) => ({ uri: value.uri }), err: () => ({}) });
    }
  }
  return result;
}

function buildBashChildEnv(params: {
  toolEnv: Record<string, string>;
  githubEnv: Record<string, string>;
  vcsEnv: Record<string, string>;
  context?: {
    requestId: string;
    requestDeliveryId?: string;
    sessionId: string;
    requestClient: string;
    currentTurnUserId?: string;
  };
  resolvedCwd: string;
  toolCallId?: string;
  controlCapability?: string;
  subagentProfile?: string;
}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.toolEnv,
    ...params.githubEnv,
    ...params.vcsEnv,
    LILAC_REQUEST_ID: params.context?.requestId,
    LILAC_REQUEST_DELIVERY_ID: params.context?.requestDeliveryId,
    LILAC_SESSION_ID: params.context?.sessionId,
    LILAC_REQUEST_CLIENT: params.context?.requestClient,
    LILAC_CURRENT_TURN_USER_ID: params.context?.currentTurnUserId,
    LILAC_CWD: params.resolvedCwd,
    LILAC_TOOL_CALL_ID: params.toolCallId,
    LILAC_CONTROL_CAPABILITY: params.controlCapability,
    LILAC_SUBAGENT_PROFILE: params.subagentProfile,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

function buildLocalSpawnArgs(command: string, stdinMode: BashStdinMode): string[] {
  if (stdinMode === "eof") {
    return ["bash", "-c", command];
  }

  return ["bash", "-c", `exec 0>/dev/null; ${command}`];
}

export async function executeBash(
  { command, cwd, timeoutMs, stdinMode, dangerouslyAllow }: BashToolInput,
  {
    context,
    abortSignal,
    toolCallId,
    artifacts,
    outputConfig = {
      maxPreviewBytes: DEFAULT_MAX_BASH_OUTPUT_BYTES,
      artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    },
    onActivity,
    controlCapability,
    subagentProfile,
    spillFileOperations = DEFAULT_SPILL_FILE_OPERATIONS,
  }: {
    context?: {
      requestId: string;
      requestDeliveryId?: string;
      sessionId: string;
      requestClient: string;
      currentTurnUserId?: string;
    };
    abortSignal?: AbortSignal;
    toolCallId?: string;
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
    onActivity?: () => void;
    controlCapability?: string;
    subagentProfile?: string;
    spillFileOperations?: BashSpillFileOperations;
  } = {},
): Promise<BashToolOutput> {
  const cwdTarget = parseSshCwdTarget(cwd);
  let resolvedCwd: string;
  if (cwdTarget.kind === "local") {
    resolvedCwd = cwdTarget.cwd ? expandTilde(cwdTarget.cwd) : process.cwd();
  } else {
    resolvedCwd = cwdTarget.cwd;
  }
  const displayCwd =
    cwdTarget.kind === "ssh" ? formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd) : resolvedCwd;
  const remoteLogMeta =
    cwdTarget.kind === "ssh" ? { sshHost: cwdTarget.host, remoteCwd: cwdTarget.cwd } : {};

  const redactedCommand = redactSecrets(command);
  const effectiveStdinMode = stdinMode ?? DEFAULT_BASH_STDIN_MODE;
  const startedAt = Date.now();
  const truncatedOutputPaths = buildTruncatedOutputPaths({
    requestId: context?.requestId,
    toolCallId,
  });

  logger.info("bash exec", {
    command: redactedCommand,
    cwd: displayCwd,
    target: cwdTarget.kind,
    ...remoteLogMeta,
    timeoutMs,
    noOutputTimeoutMs: BASH_NO_OUTPUT_TIMEOUT_MS,
    stdinMode: effectiveStdinMode,
    dangerouslyAllow: dangerouslyAllow === true,
    requestId: context?.requestId,
    sessionId: context?.sessionId,
    requestClient: context?.requestClient,
    toolCallId,
  });

  if (!dangerouslyAllow) {
    const safetyCwd =
      cwdTarget.kind === "ssh" ? toBashSafetyCwdForRemote(cwdTarget.cwd) : resolvedCwd;
    const blocked = analyzeBashCommand(command, {
      cwd: safetyCwd,
      protectedPaths:
        cwdTarget.kind === "local" ? [path.resolve(env.dataDir, "secret")] : undefined,
    });
    if (blocked) {
      logger.warn("bash blocked", {
        reason: blocked.reason,
        segment: blocked.segment,
        requestId: context?.requestId,
        toolCallId,
      });

      return {
        stdout: "",
        stderr: formatBlockedMessage({
          reason: blocked.reason,
          hint: blocked.hint,
          command,
          segment: blocked.segment,
          redact: redactSecrets,
        }),
        exitCode: -1,
        executionError: {
          type: "blocked",
          code: blocked.code,
          reason: blocked.reason,
          hint: blocked.hint,
          segment: blocked.segment,
        },
      };
    }
  }

  const githubEnv = await getGithubEnvForBash({ dataDir: env.dataDir });
  const vcsEnv = resolveVcsEnv({ dataDir: env.dataDir });

  const controller = new AbortController();
  let termination: BashTermination | undefined;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const killProcessGroupBestEffort = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    // Best-effort: kill the whole subprocess group (tools cli, ssh, etc.).
    // Requires the child to be spawned as a new process group leader.
    // Negative pid means "process group" on POSIX.
    const groupKill = Result.try({
      try: () => process.kill(-pid, signal),
      catch: captureRuntimeError,
    }).mapError((captured) =>
      projectCapturedRuntimeError(captured, "Opaque Bash process-group termination failure"),
    );
    const processKill = Result.try({
      try: () => process.kill(pid, signal),
      catch: captureRuntimeError,
    }).mapError((captured) =>
      projectCapturedRuntimeError(captured, "Opaque Bash process termination failure"),
    );
    groupKill.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => preserveToolPanic(error),
    })();
    processKill.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => preserveToolPanic(error),
    })();
  };

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = child?.pid;
      if (typeof pid === "number" && pid > 0) {
        killProcessGroupBestEffort(pid, "SIGKILL");
      }
    }, HARD_KILL_DELAY_MS);
    hardKillTimer.unref?.();
  };

  const terminate = (
    reason:
      | { type: "aborted" }
      | { type: "timeout"; timeoutKind: "no_output" | "wall_clock"; timeoutMs: number },
  ) => {
    if (termination) return;
    termination = reason;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      killProcessGroupBestEffort(pid, "SIGTERM");
      scheduleHardKill();
    }
  };

  let abortListener: (() => void) | null = null;
  if (abortSignal) {
    const onAbort = () => terminate({ type: "aborted" });
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => abortSignal.removeEventListener("abort", onAbort);
    }
  }

  let noOutputTimer: ReturnType<typeof setTimeout> | null = null;
  let wallClockTimer: ReturnType<typeof setTimeout> | null = null;
  const resetNoOutputTimer = () => {
    if (termination) return;
    if (noOutputTimer) clearTimeout(noOutputTimer);
    noOutputTimer = setTimeout(
      () =>
        terminate({
          type: "timeout",
          timeoutKind: "no_output",
          timeoutMs: BASH_NO_OUTPUT_TIMEOUT_MS,
        }),
      BASH_NO_OUTPUT_TIMEOUT_MS,
    );
  };
  if (timeoutMs !== undefined) {
    wallClockTimer = setTimeout(
      () => terminate({ type: "timeout", timeoutKind: "wall_clock", timeoutMs }),
      timeoutMs,
    );
  }
  const onRawOutput = () => {
    resetNoOutputTimer();
    onActivity?.();
  };
  const stopWatchingExecution = () => {
    if (noOutputTimer) {
      clearTimeout(noOutputTimer);
      noOutputTimer = null;
    }
    if (wallClockTimer) {
      clearTimeout(wallClockTimer);
      wallClockTimer = null;
    }
    if (hardKillTimer && !termination) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
    abortListener?.();
    abortListener = null;
  };

  const runExecution = async (): Promise<BashToolOutput> => {
    resetNoOutputTimer();
    const execResult =
      cwdTarget.kind === "ssh"
        ? await sshExecBash({
            host: cwdTarget.host,
            cmd: command,
            cwd: cwdTarget.cwd,
            stdinMode: effectiveStdinMode,
            signal: controller.signal,
            maxOutputChars: outputConfig.maxPreviewBytes,
            overflowOutputPath: truncatedOutputPaths.outputPath,
            onActivity: onRawOutput,
          })
        : null;

    if (cwdTarget.kind === "ssh" && execResult) {
      stopWatchingExecution();
      const stdout = execResult.stdout;
      const stderr = execResult.stderr;
      const exitCode = execResult.exitCode;

      let safeStdout = redactSecrets(stripAnsiEscapeSequences(stdout));
      let safeStderr = redactSecrets(stripAnsiEscapeSequences(stderr));

      const streamCapped = execResult.capped.stdout || execResult.capped.stderr;
      const outputTruncated =
        streamCapped ||
        Buffer.byteLength(safeStdout, "utf8") + Buffer.byteLength(safeStderr, "utf8") >
          outputConfig.maxPreviewBytes;
      const spillIncomplete =
        (execResult.capped.stdout && !execResult.overflowPaths.stdout) ||
        (execResult.capped.stderr && !execResult.overflowPaths.stderr);
      let originalStdoutBytes = Buffer.byteLength(safeStdout, "utf8");
      let originalStderrBytes = Buffer.byteLength(safeStderr, "utf8");
      if (outputTruncated) {
        [originalStdoutBytes, originalStderrBytes] = await Promise.all([
          overflowStreamBytes(safeStdout, execResult.overflowPaths.stdout),
          overflowStreamBytes(safeStderr, execResult.overflowPaths.stderr),
        ]);
        const budgets = allocateStreamPreviewBytes({
          stdoutBytes: originalStdoutBytes,
          stderrBytes: originalStderrBytes,
          maxBytes: outputConfig.maxPreviewBytes,
        });
        [safeStdout, safeStderr] = await Promise.all([
          buildOverflowStreamPreview({
            captured: safeStdout,
            overflowPath: execResult.overflowPaths.stdout,
            maxBytes: budgets.stdout,
            literalSecrets: [],
          }),
          buildOverflowStreamPreview({
            captured: safeStderr,
            overflowPath: execResult.overflowPaths.stderr,
            maxBytes: budgets.stderr,
            literalSecrets: [],
          }),
        ]);
      }
      const persistedOutput =
        outputTruncated && !spillIncomplete
          ? await persistTruncatedOutput({
              artifacts,
              outputConfig,
              context,
              toolCallId,
              literalSecrets: [],
              stdout,
              stderr,
              stdoutOverflowPath: execResult.overflowPaths.stdout,
              stderrOverflowPath: execResult.overflowPaths.stderr,
            })
          : {};
      const artifactUri = persistedOutput.uri;
      const bashLimitOptions = {
        truncated: outputTruncated,
        artifactUri,
        maxOutputBytes: outputConfig.maxPreviewBytes,
        originalStdoutBytes,
        originalStderrBytes,
      };

      const durationMs = execResult.durationMs;

      if (termination?.type === "timeout") {
        logBashWarn("bash timeout", {
          timeoutMs: termination.timeoutMs,
          timeoutKind: termination.timeoutKind,
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          toolCallId,
        });

        return withLimitedBashOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "timeout",
              code:
                termination.timeoutKind === "no_output"
                  ? "no_output_timeout"
                  : "wall_clock_timeout",
              timeoutMs: termination.timeoutMs,
              timeoutKind: termination.timeoutKind,
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          bashLimitOptions,
        );
      }

      if (termination?.type === "aborted" || execResult.aborted) {
        logBashWarn("bash aborted", {
          timeoutMs,
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          toolCallId,
        });

        return withLimitedBashOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "aborted",
              code: "execution_cancelled",
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          bashLimitOptions,
        );
      }

      if (execResult.timedOut) {
        logBashWarn("bash timeout", {
          timeoutMs,
          timeoutKind: "wall_clock",
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          toolCallId,
        });

        return withLimitedBashOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "timeout",
              code: "wall_clock_timeout",
              timeoutMs: timeoutMs ?? execResult.durationMs,
              timeoutKind: "wall_clock",
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          bashLimitOptions,
        );
      }

      if (outputTruncated) {
        logBashWarn("bash output truncated", {
          exitCode,
          durationMs,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stdoutTotalChars: stdout.length,
          stderrTotalChars: stderr.length,
          stdoutCapped: execResult.capped.stdout,
          stderrCapped: execResult.capped.stderr,
          artifactUri,
          requestId: context?.requestId,
          toolCallId,
        });
      }

      const ok = exitCode === 0;
      if (ok) {
        logBashInfo("bash done", {
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          toolCallId,
        });
      } else {
        logBashWarn("bash done (non-zero exit)", {
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          toolCallId,
        });
      }

      return withLimitedBashOutput(
        { stdout: safeStdout, stderr: safeStderr, exitCode },
        bashLimitOptions,
      );
    }

    // Local execution path.
    // Intentionally avoid a login shell here.
    // Login shells source /etc/profile (and friends) which can clobber PATH
    // and diverge from the process environment we want the tool to inherit.
    const toolEnv = await loadToolEnv(env.dataDir);
    const outputSecrets = [
      ...Object.values(toolEnv),
      ...Object.entries(githubEnv)
        .filter(([name]) => name.includes("TOKEN"))
        .map(([, value]) => value),
    ].map(stripAnsiEscapeSequences);
    child = Bun.spawn(buildLocalSpawnArgs(command, effectiveStdinMode), {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      killSignal: DEFAULT_KILL_SIGNAL,
      detached: true,
      env: buildBashChildEnv({
        toolEnv,
        githubEnv,
        vcsEnv,
        context,
        resolvedCwd,
        toolCallId,
        controlCapability,
        subagentProfile,
      }),
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readSanitizedStreamTextCapped(child.stdout, outputConfig.maxPreviewBytes, {
        overflowFilePath: truncatedOutputPaths.stdoutOverflowPath,
        literalSecrets: outputSecrets,
        onActivity: onRawOutput,
      }),
      readSanitizedStreamTextCapped(child.stderr, outputConfig.maxPreviewBytes, {
        overflowFilePath: truncatedOutputPaths.stderrOverflowPath,
        literalSecrets: outputSecrets,
        onActivity: onRawOutput,
      }),
      child.exited,
    ]);
    stopWatchingExecution();
    if (stdoutResult.status === "rejected" && isPanic(stdoutResult.reason)) {
      preserveToolPanic(stdoutResult.reason);
    }
    if (stderrResult.status === "rejected" && isPanic(stderrResult.reason)) {
      preserveToolPanic(stderrResult.reason);
    }
    if (exitResult.status === "rejected" && isPanic(exitResult.reason)) {
      preserveToolPanic(exitResult.reason);
    }

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    let safeStdout = redactSecrets(stdout);
    let safeStderr = redactSecrets(stderr);

    const durationMs = Date.now() - startedAt;

    const streamCapped =
      (stdoutResult.status === "fulfilled" && stdoutResult.value.capped) ||
      (stderrResult.status === "fulfilled" && stderrResult.value.capped);
    const outputTruncated =
      streamCapped ||
      Buffer.byteLength(safeStdout, "utf8") + Buffer.byteLength(safeStderr, "utf8") >
        outputConfig.maxPreviewBytes;
    const spillIncomplete =
      (stdoutResult.status === "fulfilled" &&
        stdoutResult.value.capped &&
        !stdoutResult.value.overflowFilePath) ||
      (stderrResult.status === "fulfilled" &&
        stderrResult.value.capped &&
        !stderrResult.value.overflowFilePath);
    const artifactStdout = safeStdout;
    const artifactStderr = safeStderr;
    const stdoutOverflowPath =
      stdoutResult.status === "fulfilled" ? stdoutResult.value.overflowFilePath : undefined;
    const stderrOverflowPath =
      stderrResult.status === "fulfilled" ? stderrResult.value.overflowFilePath : undefined;
    let originalStdoutBytes = Buffer.byteLength(safeStdout, "utf8");
    let originalStderrBytes = Buffer.byteLength(safeStderr, "utf8");
    if (outputTruncated) {
      originalStdoutBytes =
        stdoutResult.status === "fulfilled"
          ? stdoutResult.value.totalBytes
          : Buffer.byteLength(safeStdout, "utf8");
      originalStderrBytes =
        stderrResult.status === "fulfilled"
          ? stderrResult.value.totalBytes
          : Buffer.byteLength(safeStderr, "utf8");
      const budgets = allocateStreamPreviewBytes({
        stdoutBytes: originalStdoutBytes,
        stderrBytes: originalStderrBytes,
        maxBytes: outputConfig.maxPreviewBytes,
      });
      [safeStdout, safeStderr] = await Promise.all([
        buildOverflowStreamPreview({
          captured: safeStdout,
          overflowPath: stdoutOverflowPath,
          maxBytes: budgets.stdout,
          literalSecrets: outputSecrets,
        }),
        buildOverflowStreamPreview({
          captured: safeStderr,
          overflowPath: stderrOverflowPath,
          maxBytes: budgets.stderr,
          literalSecrets: outputSecrets,
        }),
      ]);
    }
    const persistedOutput =
      outputTruncated && !spillIncomplete
        ? await persistTruncatedOutput({
            artifacts,
            outputConfig,
            context,
            toolCallId,
            literalSecrets: outputSecrets,
            stdout: artifactStdout,
            stderr: artifactStderr,
            stdoutOverflowPath,
            stderrOverflowPath,
          })
        : {};
    const artifactUri = persistedOutput.uri;
    const bashLimitOptions = {
      truncated: outputTruncated,
      artifactUri,
      maxOutputBytes: outputConfig.maxPreviewBytes,
      originalStdoutBytes,
      originalStderrBytes,
    };

    if (termination?.type === "aborted") {
      logBashWarn("bash aborted", {
        timeoutMs,
        signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        toolCallId,
      });

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode,
          executionError: {
            type: "aborted",
            code: "execution_cancelled",
            signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
          },
        },
        bashLimitOptions,
      );
    }

    if (termination?.type === "timeout") {
      logBashWarn("bash timeout", {
        timeoutMs: termination.timeoutMs,
        timeoutKind: termination.timeoutKind,
        signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        toolCallId,
      });

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode,
          executionError: {
            type: "timeout",
            code:
              termination.timeoutKind === "no_output" ? "no_output_timeout" : "wall_clock_timeout",
            timeoutMs: termination.timeoutMs,
            timeoutKind: termination.timeoutKind,
            signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
          },
        },
        bashLimitOptions,
      );
    }

    if (stdoutResult.status === "rejected") {
      logBashError("bash stdout read failed", {
        durationMs,
        requestId: context?.requestId,
        toolCallId,
        ...formatBashStreamFailureForLog(stdoutResult.reason),
      });

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode: -1,
          executionError: {
            type: "exception",
            code: "stdout_read_failed",
            phase: "stdout",
            message: "Bash stdout read failed",
          },
        },
        bashLimitOptions,
      );
    }

    if (stderrResult.status === "rejected") {
      logBashError("bash stderr read failed", {
        durationMs,
        requestId: context?.requestId,
        toolCallId,
        ...formatBashStreamFailureForLog(stderrResult.reason),
      });

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode: -1,
          executionError: {
            type: "exception",
            code: "stderr_read_failed",
            phase: "stderr",
            message: "Bash stderr read failed",
          },
        },
        bashLimitOptions,
      );
    }

    if (exitResult.status === "rejected") {
      logBashError("bash exit status read failed", {
        durationMs,
        requestId: context?.requestId,
        toolCallId,
        failureMessage: "Bash exit status operation failed",
      });

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode: -1,
          executionError: {
            type: "exception",
            code: "exit_status_read_failed",
            phase: "unknown",
            message: "Bash exit status read failed",
          },
        },
        bashLimitOptions,
      );
    }

    if (outputTruncated) {
      logBashWarn("bash output truncated", {
        exitCode,
        durationMs,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        stdoutTotalChars: stdoutResult.status === "fulfilled" ? stdoutResult.value.totalChars : 0,
        stderrTotalChars: stderrResult.status === "fulfilled" ? stderrResult.value.totalChars : 0,
        stdoutCapped: stdoutResult.status === "fulfilled" ? stdoutResult.value.capped : false,
        stderrCapped: stderrResult.status === "fulfilled" ? stderrResult.value.capped : false,
        artifactUri,
        requestId: context?.requestId,
        toolCallId,
      });
    }

    // Always log the outcome (exitCode can be non-zero without executionError).
    const ok = exitCode === 0;
    if (ok) {
      logBashInfo("bash done", {
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        toolCallId,
      });
    } else {
      logBashWarn("bash done (non-zero exit)", {
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        toolCallId,
      });
    }

    return withLimitedBashOutput(
      { stdout: safeStdout, stderr: safeStderr, exitCode },
      bashLimitOptions,
    );
  };
  const executed = await settleBashExecution(runExecution);
  const cleanup = await cleanupBashSpills(
    [truncatedOutputPaths.stdoutOverflowPath, truncatedOutputPaths.stderrOverflowPath],
    spillFileOperations,
  );
  stopWatchingExecution();

  const executionFailure = executed.match({ ok: () => null, err: (error) => error });
  const cleanupFailure = cleanup.match({ ok: () => null, err: (error) => error });
  if (executionFailure && isPanic(executionFailure)) preserveToolPanic(executionFailure);
  if (cleanupFailure && isPanic(cleanupFailure)) preserveToolPanic(cleanupFailure);

  if (executionFailure) {
    const durationMs = Date.now() - startedAt;
    const executionError = await toFailedExecutionError(
      termination,
      executionFailure.errno,
      resolvedCwd,
      cwdTarget.kind === "local",
    );
    if (cleanupFailure) {
      const executionMessage =
        executionError.type === "exception" ? executionError.message : "Bash execution failed";
      const combined = new BashOperationAndCleanupError({
        primary: executionFailure,
        cleanup: cleanupFailure,
        message: "Bash execution failed and temporary output cleanup also failed",
      });
      logger.error("bash spawn and cleanup failed", {
        durationMs,
        requestId: context?.requestId,
        toolCallId,
        ...formatTaggedErrorForLog(combined),
      });
      return {
        stdout: "",
        stderr: `${executionMessage}. Bash temporary output cleanup failed.`,
        exitCode: -1,
        executionError,
      };
    }

    logger.error("bash spawn failed", {
      durationMs,
      requestId: context?.requestId,
      toolCallId,
      ...formatTaggedErrorForLog(executionFailure),
    });

    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError,
    };
  }
  const output = selectResultValue(executed);
  if (cleanupFailure) {
    return surfaceBashCleanupFailure(output, cleanupFailure);
  }
  return output;
}
