import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { normalizeRemoteCwd } from "./ssh-cwd";
import fs from "node:fs/promises";

import { BufferedFileSink } from "@stanley2058/lilac-coding-tools/buffered-file-sink";
import type { BundledRemoteRunnerRequest, RemoteFsRequest } from "@stanley2058/lilac-fs";
import { createLogger, formatTaggedErrorForLog, isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  captureRuntimeError,
  projectCapturedRuntimeError,
  projectRuntimeError,
} from "../runtime/error-format";
import { requireConfiguredSshHost } from "./ssh-config";
import { preserveToolPanic } from "../tools/tool-result-adapters";

const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const DEFAULT_SSH_STDIN_MODE: SshBashStdinMode = "error";
let sshControlDirectory: Promise<string> | undefined;
const deployedRunners = new Set<string>();
const runnerDeploymentGates = new Map<string, Promise<void>>();
const logger = createLogger({ module: "ssh-exec" });

export type SshBashStdinMode = "error" | "eof";

export type SshExecOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Maximum stdout/stderr characters to capture per stream.
   * If output exceeds this cap, it is truncated and `capped=true`.
   */
  maxOutputChars: number;
  overflowOutputPath?: string;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  capped: { stdout: boolean; stderr: boolean };
  overflowPaths: { stdout?: string; stderr?: string };
  errors?: { stdoutRead?: string; stderrRead?: string; exitRead?: string };
};

export class SshExecutionCancelledError extends TaggedError("SshExecutionCancelledError")<{
  readonly message: string;
}> {}

export class SshExecutionTimedOutError extends TaggedError("SshExecutionTimedOutError")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class SshExecutionOutputCappedError extends TaggedError("SshExecutionOutputCappedError")<{
  readonly message: string;
}> {}

export class SshExecutionTransportError extends TaggedError("SshExecutionTransportError")<{
  readonly transportType: "hostkey" | "auth" | "connect" | "unknown";
  readonly message: string;
}> {}

export class SshSubprocessExitError extends TaggedError("SshSubprocessExitError")<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly message: string;
}> {}

export class SshExecutionAdapterError extends TaggedError("SshExecutionAdapterError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshRequestSerializationError extends TaggedError("SshRequestSerializationError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamReadError extends TaggedError("SshStreamReadError")<{
  readonly detail?: string;
  readonly operation: "acquire_reader" | "read_chunk" | "read_body" | "report_activity";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamCleanupError extends TaggedError("SshStreamCleanupError")<{
  readonly operation: "release_reader";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshStreamReadAndCleanupError extends TaggedError("SshStreamReadAndCleanupError")<{
  readonly primary: SshStreamReadError;
  readonly cleanup: SshStreamCleanupError;
  readonly message: string;
}> {}

class SshOverflowOperationError extends TaggedError("SshOverflowOperationError")<{
  readonly operation: "open" | "write" | "close" | "abort" | "remove";
  readonly cause: unknown;
  readonly message: string;
}> {}

class SshOverflowCleanupError extends TaggedError("SshOverflowCleanupError")<{
  readonly failures: readonly SshOverflowOperationError[];
  readonly message: string;
}> {}

class SshProcessSignalError extends TaggedError("SshProcessSignalError")<{
  readonly target: "group" | "process";
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly cause: unknown;
  readonly message: string;
}> {}

class SshProcessCleanupError extends TaggedError("SshProcessCleanupError")<{
  readonly failures: readonly SshProcessSignalError[];
  readonly message: string;
}> {}

class SshExitWaitError extends TaggedError("SshExitWaitError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type SshJsonExecutionError =
  | SshExecutionCancelledError
  | SshExecutionTimedOutError
  | SshExecutionOutputCappedError
  | SshExecutionTransportError
  | SshSubprocessExitError
  | SshExecutionAdapterError
  | SshRequestSerializationError;

export type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
  overflowFilePath?: string;
};

export type SshStreamTextError =
  | SshStreamReadError
  | SshStreamCleanupError
  | SshStreamReadAndCleanupError;

export type SshStreamTextSource =
  | ReadableStream<Uint8Array>
  | XMLHttpRequestBodyInit
  | number
  | null
  | undefined;

type OverflowCapture = {
  readonly target: string;
  readonly bufferedRawChunks: Buffer[];
  sink?: BufferedFileSink;
  fileCreated: boolean;
  disabled: boolean;
};

type SshStreamReadChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

type SshOverflowCleanupOutcome = {
  readonly result: ResultType<void, SshOverflowCleanupError>;
  readonly panic?: Panic;
};

function rethrowSshPanic(cause: Error | Panic): Error {
  return preserveToolPanic(cause);
}

function captureSshOperation<T, E extends Error>(params: {
  readonly run: () => Awaited<T>;
  readonly fallback: string;
  readonly mapError: (cause: Error) => E;
}): ResultType<T, E> {
  const captured = Result.try({
    try: params.run,
    catch: (cause) => new Error(params.fallback, { cause }),
  }).mapError((captured) => projectRuntimeError(captured.cause, params.fallback));
  return captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => Result.err(params.mapError(rethrowSshPanic(error))),
  })();
}

async function captureSshPromise<T, E extends Error>(params: {
  readonly run: () => Promise<T>;
  readonly fallback: string;
  readonly mapError: (cause: Error) => E;
}): Promise<ResultType<T, E>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) => projectCapturedRuntimeError(error, params.fallback));
  return captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => Result.err(params.mapError(rethrowSshPanic(error))),
  })();
}

export function serializeRemoteRunnerRequestJson(
  request: BundledRemoteRunnerRequest | RemoteFsRequest,
): ResultType<string, SshRequestSerializationError> {
  return captureSshOperation({
    run: () => JSON.stringify(request),
    fallback: "Opaque SSH adapter failure",
    mapError: (cause) =>
      new SshRequestSerializationError({
        cause,
        message: "Remote runner request could not be serialized as JSON",
      }),
  }).andThen((serialized) =>
    serialized !== undefined
      ? Result.ok(serialized)
      : Result.err(
          new SshRequestSerializationError({
            cause: new TypeError("JSON.stringify returned undefined for a remote runner request"),
            message: "Remote runner request could not be serialized as JSON",
          }),
        ),
  );
}

function acquireStreamReader(
  stream: ReadableStream<Uint8Array>,
): ResultType<ReadableStreamDefaultReader<Uint8Array>, SshStreamReadError> {
  return captureSshOperation({
    run: () => stream.getReader(),
    fallback: "Opaque SSH stream reader acquisition failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "acquire_reader",
        cause,
        message: "Failed to acquire the SSH output stream reader",
      }),
  });
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ResultType<SshStreamReadChunk, SshStreamReadError>> {
  return captureSshPromise({
    run: () => reader.read(),
    fallback: "Opaque SSH stream read failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "read_chunk",
        cause,
        message: "Failed to read SSH output",
      }),
  });
}

function releaseStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ResultType<void, SshStreamCleanupError> {
  return captureSshOperation({
    run: () => reader.releaseLock(),
    fallback: "Opaque SSH stream reader release failure",
    mapError: (cause) =>
      new SshStreamCleanupError({
        operation: "release_reader",
        cause,
        message: "Failed to release the SSH output stream reader",
      }),
  });
}

function reportStreamActivity(onActivity: () => void): ResultType<void, SshStreamReadError> {
  return captureSshOperation({
    run: onActivity,
    fallback: "Opaque SSH output activity callback failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "report_activity",
        cause,
        message: "SSH output activity callback failed",
      }),
  });
}

function readResponseBody(
  body: XMLHttpRequestBodyInit,
): Promise<ResultType<Buffer, SshStreamReadError>> {
  return captureSshPromise({
    run: async () => Buffer.from(await new Response(body).arrayBuffer()),
    fallback: "Opaque SSH output body read failure",
    mapError: (cause) =>
      new SshStreamReadError({
        detail: `${cause.name}: ${cause.message}`,
        operation: "read_body",
        cause,
        message: "Failed to read the SSH output body",
      }),
  });
}

function openOverflowSink(
  target: string,
): Promise<ResultType<BufferedFileSink, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => BufferedFileSink.open(target, { flags: "wx", mode: 0o600 }),
    fallback: "Opaque SSH overflow output open failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "open",
        cause,
        message: "Failed to open SSH overflow output",
      }),
  });
}

function writeOverflowSink(
  sink: BufferedFileSink,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.write(chunk),
    fallback: "Opaque SSH overflow output write failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "write",
        cause,
        message: "Failed to write SSH overflow output",
      }),
  });
}

function closeOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.close(),
    fallback: "Opaque SSH overflow output close failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "close",
        cause,
        message: "Failed to close SSH overflow output",
      }),
  });
}

function abortOverflowSink(
  sink: BufferedFileSink,
): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => sink.abort(),
    fallback: "Opaque SSH overflow output abort failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "abort",
        cause,
        message: "Failed to abort SSH overflow output",
      }),
  });
}

function removeOverflowFile(target: string): Promise<ResultType<void, SshOverflowOperationError>> {
  return captureSshPromise({
    run: () => fs.rm(target, { force: true }),
    fallback: "Opaque SSH overflow output removal failure",
    mapError: (cause) =>
      new SshOverflowOperationError({
        operation: "remove",
        cause,
        message: "Failed to remove incomplete SSH overflow output",
      }),
  });
}

async function settleOverflowOperation<T>(
  run: () => Promise<ResultType<T, SshOverflowOperationError>>,
): Promise<ResultType<ResultType<T, SshOverflowOperationError>, Panic>> {
  const settled = (await Result.tryPromise({ try: run, catch: captureRuntimeError })).mapError(
    (captured) => projectCapturedRuntimeError(captured, "Opaque SSH overflow Result rejection"),
  );
  return settled.mapError((error) =>
    isPanic(error)
      ? error
      : new Panic({ message: "SSH overflow Result API rejected with an ordinary error" }),
  );
}

async function cleanupOverflowCaptureOutcome(
  capture: OverflowCapture,
): Promise<SshOverflowCleanupOutcome> {
  const failures: SshOverflowOperationError[] = [];
  let deferredPanic: Panic | undefined;
  const sink = capture.sink;
  capture.sink = undefined;
  if (sink) {
    const aborted = await settleOverflowOperation(() => abortOverflowSink(sink));
    aborted.match({
      err: (panic) => {
        deferredPanic = panic;
      },
      ok: (result) =>
        result.match({
          ok: () => undefined,
          err: (error) => {
            failures.push(error);
          },
        }),
    });
  }
  if (capture.fileCreated) {
    const removed = await settleOverflowOperation(() => removeOverflowFile(capture.target));
    removed.match({
      err: (panic) => {
        deferredPanic ??= panic;
      },
      ok: (result) =>
        result.match({
          ok: () => undefined,
          err: (error) => {
            failures.push(error);
          },
        }),
    });
  }
  capture.fileCreated = false;
  capture.bufferedRawChunks.length = 0;
  return {
    result:
      failures.length === 0
        ? Result.ok()
        : Result.err(
            new SshOverflowCleanupError({
              failures,
              message: "Failed to clean up incomplete SSH overflow output",
            }),
          ),
    ...(deferredPanic ? { panic: deferredPanic } : {}),
  };
}

async function cleanupOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowCleanupError>> {
  const outcome = await cleanupOverflowCaptureOutcome(capture);
  if (outcome.panic) preserveToolPanic(outcome.panic);
  return outcome.result;
}

async function propagateOverflowPanic(capture: OverflowCapture, panic: Panic): Promise<never> {
  await cleanupOverflowCaptureOutcome(capture);
  return preserveToolPanic(panic);
}

async function disableOverflowCapture(
  capture: OverflowCapture,
  failure: SshOverflowOperationError,
): Promise<void> {
  capture.disabled = true;
  logger.debug("SSH overflow retention unavailable", formatTaggedErrorForLog(failure));
  const cleanup = await cleanupOverflowCapture(capture);
  cleanup.match({
    ok: () => undefined,
    err: (error) => logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
  });
}

async function writeOverflowChunk(
  capture: OverflowCapture,
  chunk: Uint8Array,
): Promise<ResultType<void, SshOverflowOperationError>> {
  if (chunk.byteLength === 0 || capture.disabled) return Result.ok();
  let sink = capture.sink;
  if (!sink) {
    const opened = await settleOverflowOperation(() => openOverflowSink(capture.target));
    return opened.match({
      err: (panic) => async () => propagateOverflowPanic(capture, panic),
      ok: (result) => async () =>
        result.match({
          err: (error) => async () => Result.err(error),
          ok: (openedSink) => async () => {
            capture.sink = openedSink;
            capture.fileCreated = true;
            const written = await settleOverflowOperation(() =>
              writeOverflowSink(openedSink, chunk),
            );
            return written.match({
              err: (panic) => async () => propagateOverflowPanic(capture, panic),
              ok: (value) => async () => value,
            })();
          },
        })(),
    })();
  }
  const written = await settleOverflowOperation(() => writeOverflowSink(sink, chunk));
  return written.match({
    err: (panic) => async () => propagateOverflowPanic(capture, panic),
    ok: (result) => async () => result,
  })();
}

async function activateOverflowCapture(
  capture: OverflowCapture,
): Promise<ResultType<void, SshOverflowOperationError>> {
  for (const chunk of capture.bufferedRawChunks) {
    const written = await writeOverflowChunk(capture, chunk);
    const failure = written.match({ ok: () => null, err: (error) => Result.err(error) });
    if (failure) return failure;
  }
  capture.bufferedRawChunks.length = 0;
  return Result.ok();
}

function combineStreamReadAndCleanup(
  primary: ResultType<StreamTextResult, SshStreamReadError>,
  cleanup: ResultType<void, SshStreamCleanupError>,
): ResultType<StreamTextResult, SshStreamTextError> {
  return primary.match<ResultType<StreamTextResult, SshStreamTextError>>({
    ok: (value) => cleanup.map(() => value),
    err: (primaryError) =>
      cleanup.match<ResultType<StreamTextResult, SshStreamTextError>>({
        ok: () => Result.err(primaryError),
        err: (cleanupError) =>
          Result.err(
            new SshStreamReadAndCleanupError({
              primary: primaryError,
              cleanup: cleanupError,
              message: `${primaryError.message}; cleanup also failed: ${cleanupError.message}`,
            }),
          ),
      }),
  });
}

async function readReadableStreamTextCapped(
  stream: ReadableStream<Uint8Array>,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void },
): Promise<ResultType<StreamTextResult, SshStreamTextError>> {
  const acquired = acquireStreamReader(stream);
  return acquired.match({
    err: (error) => async () => Result.err(error),
    ok: (reader) => async () => {
      let releaseAttempted = false;

      const outcome = await (async () => {
        const decoder = new TextDecoder();
        let text = "";
        let totalChars = 0;
        let capped = false;
        let overflowFilePath: string | undefined;
        const overflowCapture: OverflowCapture | undefined = options?.overflowFilePath
          ? {
              target: options.overflowFilePath,
              bufferedRawChunks: [],
              fileCreated: false,
              disabled: false,
            }
          : undefined;

        const consumeChunkText = async (
          chunkText: string,
        ): Promise<ResultType<void, SshOverflowOperationError>> => {
          if (chunkText.length === 0) return Result.ok();
          totalChars += chunkText.length;
          if (capped) return Result.ok();

          const previousText = text;
          const nextLen = previousText.length + chunkText.length;
          if (nextLen <= maxChars) {
            text = previousText + chunkText;
            return Result.ok();
          }

          capped = true;
          const remaining = Math.max(0, maxChars - previousText.length);
          text = previousText + chunkText.slice(0, remaining);
          if (!overflowCapture) return Result.ok();
          return activateOverflowCapture(overflowCapture);
        };

        let primary: ResultType<StreamTextResult, SshStreamReadError>;
        while (true) {
          const read = await readStreamChunk(reader);
          const readFailure = read.match({ ok: () => null, err: (error) => error });
          if (readFailure) {
            if (overflowCapture) {
              const cleanup = await cleanupOverflowCapture(overflowCapture);
              cleanup.match({
                ok: () => undefined,
                err: (error) =>
                  logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
              });
            }
            primary = Result.err(readFailure);
            break;
          }
          const chunk = read.match<SshStreamReadChunk>({
            ok: (value) => value,
            err: () => ({ done: true }),
          });
          const { done, value } = chunk;
          if (done) {
            const tail = decoder.decode();
            if (tail.length > 0) {
              const consumed = await consumeChunkText(tail);
              const failure = consumed.match({ ok: () => null, err: (error) => error });
              if (failure && overflowCapture)
                await disableOverflowCapture(overflowCapture, failure);
            }
            if (overflowCapture?.sink) {
              const overflowSink = overflowCapture.sink;
              const closed = await settleOverflowOperation(() => closeOverflowSink(overflowSink));
              await closed.match({
                err: (panic) => async () => propagateOverflowPanic(overflowCapture, panic),
                ok: (result) => async () =>
                  result.match({
                    err: (error) => async () => disableOverflowCapture(overflowCapture, error),
                    ok: () => async () => {
                      overflowCapture.sink = undefined;
                      overflowFilePath = overflowCapture.target;
                    },
                  })(),
              })();
            }
            primary = Result.ok({ text, totalChars, capped, overflowFilePath });
            break;
          }
          if (!value || value.byteLength === 0) continue;

          if (options?.onActivity) {
            const activity = reportStreamActivity(options.onActivity);
            const activityFailure = activity.match({ ok: () => null, err: (error) => error });
            if (activityFailure) {
              if (overflowCapture) {
                const cleanup = await cleanupOverflowCapture(overflowCapture);
                cleanup.match({
                  ok: () => undefined,
                  err: (error) =>
                    logger.debug("SSH overflow cleanup incomplete", formatTaggedErrorForLog(error)),
                });
              }
              primary = Result.err(activityFailure);
              break;
            }
          }
          if (capped && overflowCapture) {
            const written = await writeOverflowChunk(overflowCapture, value);
            const failure = written.match({ ok: () => null, err: (error) => error });
            if (failure) await disableOverflowCapture(overflowCapture, failure);
          } else if (overflowCapture) {
            overflowCapture.bufferedRawChunks.push(Buffer.from(value));
          }
          const consumed = await consumeChunkText(decoder.decode(value, { stream: true }));
          const failure = consumed.match({ ok: () => null, err: (error) => error });
          if (failure && overflowCapture) await disableOverflowCapture(overflowCapture, failure);
        }

        releaseAttempted = true;
        return {
          status: "return",
          value: combineStreamReadAndCleanup(primary, releaseStreamReader(reader)),
        } as const;
      })().finally(() => {
        if (!releaseAttempted) {
          const released = releaseStreamReader(reader);
          released.match({
            ok: () => undefined,
            err: (error) =>
              logger.debug("SSH stream reader cleanup failed", formatTaggedErrorForLog(error)),
          });
        }
      });
      return outcome.value;
    },
  })();
}

async function readBodyTextCapped(
  body: XMLHttpRequestBodyInit,
  maxChars: number,
  overflowFilePath?: string,
): Promise<ResultType<StreamTextResult, SshStreamReadError>> {
  const read = await readResponseBody(body);
  return read.match<() => Promise<ResultType<StreamTextResult, SshStreamReadError>>>({
    err: (error) => async () => Result.err(error),
    ok: (fullBytes) => async () => {
      const full = new TextDecoder().decode(fullBytes);
      const capped = full.length > maxChars;
      let retainedOverflowPath: string | undefined;
      if (capped && overflowFilePath) {
        const capture: OverflowCapture = {
          target: overflowFilePath,
          bufferedRawChunks: [],
          fileCreated: false,
          disabled: false,
        };
        const written = await writeOverflowChunk(capture, fullBytes);
        const writeFailure = written.match({ ok: () => null, err: (error) => error });
        if (writeFailure) {
          await disableOverflowCapture(capture, writeFailure);
        } else if (capture.sink) {
          const overflowSink = capture.sink;
          const closed = await settleOverflowOperation(() => closeOverflowSink(overflowSink));
          await closed.match({
            err: (panic) => async () => propagateOverflowPanic(capture, panic),
            ok: (result) => async () =>
              result.match({
                err: (error) => async () => disableOverflowCapture(capture, error),
                ok: () => async () => {
                  capture.sink = undefined;
                  retainedOverflowPath = overflowFilePath;
                },
              })(),
          })();
        }
      }

      return Result.ok({
        text: full.length > maxChars ? full.slice(0, maxChars) : full,
        totalChars: full.length,
        capped,
        overflowFilePath: retainedOverflowPath,
      });
    },
  })();
}

export async function readStreamTextCapped(
  stream: SshStreamTextSource,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void },
): Promise<ResultType<StreamTextResult, SshStreamTextError>> {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return Result.ok({ text: "", totalChars: 0, capped: false });
  }
  if (stream instanceof ReadableStream) {
    return readReadableStreamTextCapped(stream, maxChars, options);
  }
  return readBodyTextCapped(stream, maxChars, options?.overflowFilePath);
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

export function buildRemoteScript(params: {
  cmd: string;
  cwd?: string;
  stdinMode?: SshBashStdinMode;
}) {
  const fields = [params.cwd ?? "", params.cmd, params.stdinMode ?? DEFAULT_SSH_STDIN_MODE];
  const payload = Buffer.from(
    JSON.stringify(fields.map((field) => Buffer.from(field).toString("base64"))),
  ).toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
IFS='"' read -r _ CWD64 _ CMD64 _ MODE64 _ <<< "$(printf '%s' '${payload}' | base64 -d)"
CWD=$(printf '%s' "$CWD64" | base64 -d)
MODE=$(printf '%s' "$MODE64" | base64 -d)
TMP_CMD=$(mktemp)
trap 'rm -f "$TMP_CMD"' EXIT
printf '%s' "$CMD64" | base64 -d >"$TMP_CMD"
if [ "$CWD" = "~" ]; then
  CWD="$HOME"
elif [[ "$CWD" == "~/"* ]]; then
  CWD="$HOME/\${CWD:2}"
fi
if [ -n "$CWD" ]; then cd -- "$CWD"; fi
if [ "$MODE" = "error" ]; then
  bash --noprofile --norc "$TMP_CMD" </dev/null
else
  bash --noprofile --norc "$TMP_CMD"
fi
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

function signalSshProcess(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  target: "group" | "process",
): ResultType<void, SshProcessSignalError> {
  const signalPid = target === "group" ? -pid : pid;
  return captureSshOperation({
    run: () => {
      process.kill(signalPid, signal);
    },
    fallback: `Opaque SSH ${target} signal failure`,
    mapError: (cause) =>
      new SshProcessSignalError({
        target,
        pid,
        signal,
        cause,
        message: `Failed to signal SSH ${target}`,
      }),
  });
}

function killProcessGroupBestEffort(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): ResultType<void, SshProcessCleanupError> {
  const failures: SshProcessSignalError[] = [];
  const group = signalSshProcess(pid, signal, "group");
  group.match({ ok: () => undefined, err: (error) => failures.push(error) });
  const processResult = signalSshProcess(pid, signal, "process");
  processResult.match({ ok: () => undefined, err: (error) => failures.push(error) });
  if (failures.length === 0) return Result.ok();
  return Result.err(
    new SshProcessCleanupError({
      failures,
      message: `Failed to fully signal SSH process group with ${signal}`,
    }),
  );
}

function observeBestEffortProcessCleanup(cleanup: ResultType<void, SshProcessCleanupError>): void {
  cleanup.match({
    ok: () => undefined,
    err: (error) =>
      logger.debug("SSH process-group cleanup incomplete", formatTaggedErrorForLog(error)),
  });
}

function waitForSshExit(exit: Promise<number>): Promise<ResultType<number, SshExitWaitError>> {
  return captureSshPromise({
    run: () => exit,
    fallback: "Opaque SSH subprocess exit wait failure",
    mapError: (cause) =>
      new SshExitWaitError({
        cause,
        message: "Failed while waiting for the SSH subprocess to exit",
      }),
  });
}

function projectStreamCapture(
  streamName: "stdout" | "stderr",
  captured: ResultType<StreamTextResult, SshStreamTextError>,
): StreamTextResult {
  return captured.match({
    ok: (value) => value,
    err: (error) => {
      logger.debug(`SSH ${streamName} capture failed`, formatTaggedErrorForLog(error));
      return { text: "", totalChars: 0, capped: false };
    },
  });
}

export async function sshExecBash(params: {
  host: string;
  cmd: string;
  cwd?: string;
  stdinMode?: SshBashStdinMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  overflowOutputPath?: string;
  onActivity?: () => void;
}): Promise<
  SshExecResult & {
    transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
  }
> {
  if (params.cwd !== undefined) normalizeRemoteCwd(params.cwd);
  await requireConfiguredSshHost(params.host);

  if (params.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      aborted: true,
      capped: { stdout: false, stderr: false },
      overflowPaths: {},
    };
  }

  const controller = new AbortController();
  let termination: "timeout" | "aborted" | undefined;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = child?.pid;
      if (typeof pid === "number" && pid > 0) {
        observeBestEffortProcessCleanup(killProcessGroupBestEffort(pid, "SIGKILL"));
      }
    }, HARD_KILL_DELAY_MS);
    hardKillTimer.unref?.();
  };

  const terminate = (reason: "timeout" | "aborted") => {
    if (termination) return;
    termination = reason;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      observeBestEffortProcessCleanup(killProcessGroupBestEffort(pid, "SIGTERM"));
      scheduleHardKill();
    }
  };

  let abortListener: (() => void) | null = null;
  if (params.signal) {
    const onAbort = () => terminate("aborted");
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }
  }

  const timeout =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(() => terminate("timeout"), params.timeoutMs);
  const stopWatchingExecution = () => {
    if (timeout) clearTimeout(timeout);
    abortListener?.();
    abortListener = null;
    if (hardKillTimer && !termination) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
  };

  const startedAt = Date.now();
  const outcome = await (async () => {
    sshControlDirectory ??= fs.mkdtemp(path.join(os.tmpdir(), "lilac-ssh-"));
    const controlDirectory = await sshControlDirectory;
    const sshArgs = [
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPersist=60",
      "-o",
      `ControlPath=${controlDirectory}/%C`,
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

    const script = buildRemoteScript({
      cmd: params.cmd,
      cwd: params.cwd,
      stdinMode: params.stdinMode,
    });

    child = Bun.spawn(["ssh", ...sshArgs], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([script]),
      signal: controller.signal,
      killSignal: "SIGTERM",
      detached: true,
      env: buildSshChildEnv(),
    });

    const [stdoutCapture, stderrCapture, exitResult] = await Promise.all([
      readStreamTextCapped(child.stdout, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stdout.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      readStreamTextCapped(child.stderr, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stderr.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      waitForSshExit(child.exited),
    ]);
    stopWatchingExecution();

    const stdoutResult = projectStreamCapture("stdout", stdoutCapture);
    const stderrResult = projectStreamCapture("stderr", stderrCapture);
    exitResult.match({
      ok: () => undefined,
      err: (error) =>
        logger.debug("SSH subprocess exit wait failed", formatTaggedErrorForLog(error)),
    });
    const stdout = stdoutResult.text;
    const stderr = stderrResult.text;
    const exitCode = exitResult.match({ ok: (value) => value, err: () => -1 });

    const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;

    return {
      status: "return",
      value: {
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut: termination === "timeout",
        aborted: termination === "aborted",
        capped: {
          stdout: stdoutResult.capped,
          stderr: stderrResult.capped,
        },
        overflowPaths: {
          stdout: stdoutResult.overflowFilePath,
          stderr: stderrResult.overflowFilePath,
        },
        transportError,
        errors: {
          stdoutRead: stdoutCapture.match({
            ok: () => undefined,
            err: (error) =>
              error._tag === "SshStreamReadError" ? (error.detail ?? error.message) : error.message,
          }),
          stderrRead: stderrCapture.match({
            ok: () => undefined,
            err: (error) =>
              error._tag === "SshStreamReadError" ? (error.detail ?? error.message) : error.message,
          }),
          exitRead: exitResult.match({ ok: () => undefined, err: () => "exit status read failed" }),
        },
      },
    } as const;
  })().finally(stopWatchingExecution);
  return outcome.value;
}

function sshJsonExecutionFailure(
  res: SshExecResult & {
    transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
  },
  timeoutMs: number,
): SshJsonExecutionError | undefined {
  if (res.aborted) {
    return new SshExecutionCancelledError({ message: "aborted" });
  }
  if (res.timedOut) {
    return new SshExecutionTimedOutError({
      timeoutMs: timeoutMs,
      message: `timeout:${timeoutMs}`,
    });
  }
  if (res.capped.stdout || res.capped.stderr) {
    return new SshExecutionOutputCappedError({
      message: "remote output capped (response too large)",
    });
  }
  if (res.transportError) {
    return new SshExecutionTransportError({
      transportType: res.transportError.type,
      message: res.transportError.message,
    });
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim().length > 0 ? `: ${res.stderr.trim()}` : "";
    return new SshSubprocessExitError({
      exitCode: res.exitCode,
      stderr: res.stderr,
      message: `remote script exited with code ${res.exitCode}${detail}`,
    });
  }

  return undefined;
}

async function waitForRunnerDeployment(
  pending: Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<"ready" | "aborted" | "timeout"> {
  if (signal?.aborted) return "aborted";
  if (timeoutMs <= 0) return "timeout";
  const settled = Promise.withResolvers<"ready" | "aborted" | "timeout">();
  const onAbort = () => settled.resolve("aborted");
  const timeout = setTimeout(() => settled.resolve("timeout"), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  void pending.then(() => settled.resolve("ready"));
  return await settled.promise.finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  });
}

export async function sshExecScriptJson<T, TDecodeError>(params: {
  host: string;
  cwd: string;
  js: string;
  input: BundledRemoteRunnerRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  onActivity?: () => void;
  decodeResponse: (text: string) => ResultType<T, TDecodeError>;
}): Promise<ResultType<T, SshJsonExecutionError | TDecodeError>> {
  if (params.signal?.aborted) {
    return Result.err(new SshExecutionCancelledError({ message: "aborted" }));
  }
  const serializedInput = serializeRemoteRunnerRequestJson(params.input);
  const serializationFailure = serializedInput.match({
    ok: () => null,
    err: (error) => Result.err(error),
  });
  if (serializationFailure) return serializationFailure;
  const inputJson = serializedInput.match({ ok: (value) => value, err: () => "" });

  const deadline = Date.now() + params.timeoutMs;
  const runnerHash = crypto.createHash("sha256").update(params.js).digest("hex");
  const runnerKey = `${params.host}:${runnerHash}`;
  while (!deployedRunners.has(runnerKey)) {
    const pending = runnerDeploymentGates.get(runnerKey);
    if (!pending) break;
    const waited = await waitForRunnerDeployment(pending, params.signal, deadline - Date.now());
    if (waited === "aborted")
      return Result.err(new SshExecutionCancelledError({ message: "aborted" }));
    if (waited === "timeout")
      return Result.err(
        new SshExecutionTimedOutError({
          timeoutMs: params.timeoutMs,
          message: `timeout:${params.timeoutMs}`,
        }),
      );
  }
  const deployment = deployedRunners.has(runnerKey) ? undefined : Promise.withResolvers<void>();
  if (deployment) runnerDeploymentGates.set(runnerKey, deployment.promise);
  return await (async () => {
    if (!deployedRunners.has(runnerKey)) {
      const probe = await captureSshPromise({
        run: () =>
          sshExecBash({
            host: params.host,
            cmd: `test -f "\${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runners/${runnerHash}.js"`,
            timeoutMs: Math.max(1, deadline - Date.now()),
            signal: params.signal,
            maxOutputChars: 1000,
            onActivity: params.onActivity,
          }),
        fallback: "SSH runner cache probe failed",
        mapError: (cause) =>
          new SshExecutionAdapterError({ cause, message: "SSH runner cache probe failed" }),
      });
      const probeOutcome = probe.match<
        { value: Awaited<ReturnType<typeof sshExecBash>> } | { error: SshExecutionAdapterError }
      >({ ok: (value) => ({ value }), err: (error) => ({ error }) });
      if ("error" in probeOutcome) return Result.err(probeOutcome.error);
      const failure = sshJsonExecutionFailure(probeOutcome.value, params.timeoutMs);
      if (failure && !(failure._tag === "SshSubprocessExitError" && failure.exitCode === 1))
        return Result.err(failure);
      if (!failure) deployedRunners.add(runnerKey);
    }
    const source = Buffer.from(params.js).toString("base64");
    const install = deployedRunners.has(runnerKey)
      ? ""
      : `
mkdir -p "$RUNNER_DIR"
if [ ! -f "$TMP_JS" ]; then
  UPLOAD=$(mktemp "$RUNNER_DIR/upload.XXXXXX")
  trap 'rm -f "$UPLOAD"' EXIT
  printf '%s' '${source}' | base64 -d >"$UPLOAD"
  mv -f "$UPLOAD" "$TMP_JS"
fi
`;
    if (Date.now() >= deadline)
      return Result.err(
        new SshExecutionTimedOutError({
          timeoutMs: params.timeoutMs,
          message: `timeout:${params.timeoutMs}`,
        }),
      );
    const encodedInput = Buffer.from(inputJson).toString("base64");
    const script = `set -euo pipefail
umask 077
RUNNER_DIR="\${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runners"
TMP_JS="$RUNNER_DIR/${runnerHash}.js"
${install}
if command -v bun >/dev/null 2>&1; then
  printf '%s' '${encodedInput}' | base64 -d | bun "$TMP_JS"
elif command -v node >/dev/null 2>&1; then
  printf '%s' '${encodedInput}' | base64 -d | node "$TMP_JS"
else
  echo '{"ok":false,"error":"Remote host has neither bun nor node in PATH"}'
fi
`;

    const executed = await captureSshPromise({
      run: () =>
        sshExecBash({
          host: params.host,
          cmd: script,
          cwd: params.cwd,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal: params.signal,
          maxOutputChars: params.maxOutputChars,
          onActivity: params.onActivity,
        }),
      fallback: "Opaque SSH execution adapter failure",
      mapError: (cause) =>
        new SshExecutionAdapterError({ cause, message: "SSH execution adapter failed" }),
    });
    const executionOutcome = executed.match<
      { value: Awaited<ReturnType<typeof sshExecBash>> } | { error: SshExecutionAdapterError }
    >({ ok: (value) => ({ value }), err: (error) => ({ error }) });
    if ("error" in executionOutcome) return Result.err(executionOutcome.error);
    const res = executionOutcome.value;

    const failure = sshJsonExecutionFailure(res, params.timeoutMs);
    if (failure) return Result.err(failure);

    deployedRunners.add(runnerKey);
    return params.decodeResponse(res.stdout.trim());
  })().finally(() => {
    if (!deployment) return;
    if (runnerDeploymentGates.get(runnerKey) === deployment.promise)
      runnerDeploymentGates.delete(runnerKey);
    deployment.resolve();
  });
}
