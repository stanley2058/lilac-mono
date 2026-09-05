import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { acquireSessionIndexLock, type SessionIndexLockFailure } from "./session-index-lock.ts";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  captureAcpFailure,
  captureExternal,
  recordAcpCleanupFailure,
  signalAcpDefect,
  type CapturedAcpFailure,
} from "./external-adapters.ts";
import {
  ExternalOperationFailed,
  InvalidRunId,
  RunCancellationCorruptFields,
  RunCancellationMalformedSerialization,
  RunCancellationMarkerInvalidType,
  RunCancellationUnsupportedVersion,
  RunRecordCorruptFields,
  RunRecordMalformedSerialization,
  SessionIndexCorruptFields,
  SessionIndexLockTimedOut,
  SessionIndexMalformedSerialization,
  SessionIndexUnsupportedVersion,
  WorkAndCleanupFailed,
  type RunStoreError,
  type SessionIndexCodecError,
  type SessionStoreError,
} from "./failures.ts";
import {
  promptRunRecordSchema,
  sessionIndexEntrySchema,
  sessionIndexSchema,
  type PromptRunRecord,
  type SessionIndex,
  type SessionIndexEntry,
} from "./types.ts";

function settleAcpCapture<T>(
  captured: ResultType<T, ReturnType<typeof captureAcpFailure>>,
): ResultType<T, CapturedAcpFailure> {
  return captured.mapError(({ settle }) => settle());
}

async function settleAcpCapturePromise<T>(
  captured: Promise<ResultType<T, ReturnType<typeof captureAcpFailure>>>,
): Promise<ResultType<T, CapturedAcpFailure>> {
  return settleAcpCapture(await captured);
}

type PersistedRead<T> = {
  readonly provenance: "current" | "migrated" | "missing-defaulted";
  readonly value: T;
};

type PresentPersistedRead<T> = {
  readonly provenance: "current" | "migrated";
  readonly value: T;
};

export type SessionIndexRead = PersistedRead<SessionIndex>;

const persistedVersionSchema = z.object({ version: z.number() });
const runCancellationSchema = z.object({
  version: z.literal(1),
  runCreatedAt: z.number().int().nonnegative(),
  requestedAt: z.number().int().nonnegative(),
});
const legacyRunCancellationSchema = runCancellationSchema.extend({ version: z.literal(0) });
const legacyRunRecordSchema = promptRunRecordSchema
  .omit({ permissions: true })
  .extend({ permissions: z.never().optional() });
const legacySessionIndexSchema = z.object({
  version: z.literal(0),
  sessions: z.array(sessionIndexEntrySchema),
});

export type RunRecordCodecInput = {
  readonly runId: string;
  readonly content: string;
};

export type RunCancellation = z.output<typeof runCancellationSchema>;

export type RunCancellationCodecInput = {
  readonly runId: string;
  readonly content: string;
};

function stateBaseDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const base =
    xdgStateHome && xdgStateHome.trim().length > 0
      ? xdgStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "lilac-acp-controller");
}

function runsDir(): string {
  return path.join(stateBaseDir(), "runs");
}

function sessionsDir(): string {
  return path.join(stateBaseDir(), "sessions");
}

function sessionIndexPath(): string {
  return path.join(sessionsDir(), "index.json");
}

function runFilePath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function runCancellationPath(runId: string): string {
  return path.join(runsDir(), `${runId}.cancel.json`);
}

function validateRunId(runId: string): ResultType<string, InvalidRunId> {
  const trimmed = runId.trim();
  if (/^run_[a-f0-9-]+$/.test(trimmed)) return Result.ok(trimmed);
  return Result.err(new InvalidRunId({ runId, message: `Invalid run ID '${runId}'.` }));
}

function parseJson(content: string): ResultType<unknown, { readonly cause: Error }> {
  const parsed = settleAcpCapture(
    Result.try({
      try: () => JSON.parse(content),
      catch: captureAcpFailure,
    }),
  );
  const outcome = parsed.match<ResultType<unknown, { readonly cause: Error }> | Panic>({
    ok: (value) => Result.ok(value),
    err: (failure) =>
      failure.kind === "panic" ? failure.panic : Result.err({ cause: failure.cause }),
  });
  return Panic.is(outcome) ? signalAcpDefect(outcome) : outcome;
}

export function decodeRunRecord(
  input: RunRecordCodecInput,
): ResultType<
  PresentPersistedRead<PromptRunRecord>,
  RunRecordMalformedSerialization | RunRecordCorruptFields
> {
  const decoded = parseJson(input.content);
  return decoded.match<
    ResultType<
      PresentPersistedRead<PromptRunRecord>,
      RunRecordMalformedSerialization | RunRecordCorruptFields
    >
  >({
    err: (error) =>
      Result.err(
        new RunRecordMalformedSerialization({
          runId: input.runId,
          message:
            error.cause instanceof Error
              ? error.cause.message
              : `Run record '${input.runId}' contains malformed JSON.`,
        }),
      ),
    ok: (value) => {
      const parsed = promptRunRecordSchema.safeParse(value);
      if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
      const legacy = legacyRunRecordSchema.safeParse(value);
      if (legacy.success) {
        return Result.ok({
          provenance: "migrated",
          value: {
            ...legacy.data,
            permissions: {
              permissionsApproved: 0,
              permissionsRejected: 0,
              permissionsCancelled: 0,
            },
          },
        });
      }
      return Result.err(
        new RunRecordCorruptFields({
          runId: input.runId,
          message: `Run record '${input.runId}' is malformed.`,
        }),
      );
    },
  });
}

export function decodeRunCancellation(
  input: RunCancellationCodecInput,
): ResultType<
  PresentPersistedRead<RunCancellation>,
  | RunCancellationMalformedSerialization
  | RunCancellationUnsupportedVersion
  | RunCancellationCorruptFields
> {
  const decoded = parseJson(input.content);
  return decoded.match<
    ResultType<
      PresentPersistedRead<RunCancellation>,
      | RunCancellationMalformedSerialization
      | RunCancellationUnsupportedVersion
      | RunCancellationCorruptFields
    >
  >({
    err: () =>
      Result.err(
        new RunCancellationMalformedSerialization({
          runId: input.runId,
          message: `Run cancellation marker '${input.runId}' contains malformed JSON.`,
        }),
      ),
    ok: (value) => {
      const parsed = runCancellationSchema.safeParse(value);
      if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
      const legacy = legacyRunCancellationSchema.safeParse(value);
      if (legacy.success) {
        return Result.ok({
          provenance: "migrated",
          value: { ...legacy.data, version: 1 },
        });
      }
      const version = persistedVersionSchema.safeParse(value);
      if (version.success && version.data.version !== 1) {
        return Result.err(
          new RunCancellationUnsupportedVersion({
            runId: input.runId,
            version: version.data.version,
            message: `Run cancellation marker '${input.runId}' has unsupported version ${version.data.version}.`,
          }),
        );
      }
      return Result.err(
        new RunCancellationCorruptFields({
          runId: input.runId,
          message: `Run cancellation marker '${input.runId}' contains corrupt fields.`,
        }),
      );
    },
  });
}

export function decodeSessionIndex(
  content: string | undefined,
): ResultType<SessionIndexRead, SessionIndexCodecError> {
  if (content === undefined) {
    return Result.ok({
      provenance: "missing-defaulted",
      value: { version: 1, sessions: [] },
    });
  }
  const decoded = parseJson(content);
  return decoded.match<ResultType<SessionIndexRead, SessionIndexCodecError>>({
    err: (error) =>
      Result.err(
        new SessionIndexMalformedSerialization({
          message:
            error.cause instanceof Error
              ? error.cause.message
              : "Session index contains malformed JSON.",
        }),
      ),
    ok: (value) => {
      const parsed = sessionIndexSchema.safeParse(value);
      if (parsed.success) return Result.ok({ provenance: "current", value: parsed.data });
      const legacy = legacySessionIndexSchema.safeParse(value);
      if (legacy.success) {
        return Result.ok({
          provenance: "migrated",
          value: { version: 1, sessions: legacy.data.sessions },
        });
      }
      const version = persistedVersionSchema.safeParse(value);
      if (version.success && version.data.version !== 1) {
        return Result.err(
          new SessionIndexUnsupportedVersion({
            version: version.data.version,
            message: `Session index version ${version.data.version} is unsupported.`,
          }),
        );
      }
      return Result.err(
        new SessionIndexCorruptFields({ message: "Session index contains corrupt fields." }),
      );
    },
  });
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  operation: "write-run" | "write-session-index",
): Promise<ResultType<void, ExternalOperationFailed>> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const written = await captureExternal(operation, () => fs.writeFile(tempPath, content, "utf8"));
  const writeError = written.match({ ok: () => undefined, err: (error) => error });
  if (writeError !== undefined) return Result.err(writeError);
  return captureExternal(operation, () => fs.rename(tempPath, filePath));
}

async function withSessionIndexLock<T>(
  work: () => Promise<
    ResultType<T, ExternalOperationFailed | SessionIndexCodecError | SessionIndexLockTimedOut>
  >,
): Promise<ResultType<T, SessionStoreError>> {
  const directory = await captureExternal("acquire-session-lock", () =>
    fs.mkdir(sessionsDir(), { recursive: true }),
  );
  const directoryError = directory.match({ ok: () => undefined, err: (error) => error });
  if (directoryError !== undefined) return Result.err(directoryError);
  const acquired = await acquireSessionIndexLock(sessionsDir());
  const lock = acquired.match<
    | { readonly kind: "acquired"; readonly file: FileHandle }
    | { readonly kind: "failed"; readonly error: SessionIndexLockFailure }
  >({
    ok: (file) => ({ kind: "acquired" as const, file }),
    err: (error) => ({ kind: "failed" as const, error }),
  });
  if (lock.kind === "failed") return Result.err(lock.error);

  const attempted = await settleAcpCapturePromise(
    Result.tryPromise({
      try: work,
      catch: captureAcpFailure,
    }),
  );
  const cleanupAttempted = await settleAcpCapturePromise(
    Result.tryPromise({
      try: () => captureExternal("remove-session-lock", () => lock.file.close()),
      catch: captureAcpFailure,
    }),
  );

  function ordinaryCaptureToExternal(
    operation: "remove-session-lock" | "session-index-work",
    captured: Extract<CapturedAcpFailure, { readonly kind: "ordinary" }>,
  ): ExternalOperationFailed {
    return new ExternalOperationFailed({
      operation,
      cause: captured.cause,
      ...(captured.projection.code ? { code: captured.projection.code } : {}),
      message: captured.projection.message,
    });
  }

  const workCaptureFailure = attempted.match({ ok: () => undefined, err: (failure) => failure });
  const cleanupCaptureFailure = cleanupAttempted.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  if (workCaptureFailure?.kind === "panic") {
    if (cleanupCaptureFailure === undefined) {
      const cleanupResult = cleanupAttempted.match({ ok: (value) => value, err: () => undefined });
      const cleanupError = cleanupResult?.match({ ok: () => undefined, err: (error) => error });
      if (cleanupError !== undefined)
        recordAcpCleanupFailure(workCaptureFailure.panic, cleanupError);
    } else {
      const cleanupFailure =
        cleanupCaptureFailure.kind === "panic"
          ? cleanupCaptureFailure.panic
          : ordinaryCaptureToExternal("remove-session-lock", cleanupCaptureFailure);
      recordAcpCleanupFailure(workCaptureFailure.panic, cleanupFailure);
    }
    return signalAcpDefect(workCaptureFailure.panic);
  }

  const resultOrPanic = attempted.match<
    | ResultType<T, ExternalOperationFailed | SessionIndexCodecError | SessionIndexLockTimedOut>
    | Panic
  >({
    ok: (value) => value,
    err: (failure) =>
      failure.kind === "panic"
        ? failure.panic
        : Result.err(ordinaryCaptureToExternal("session-index-work", failure)),
  });
  if (Panic.is(resultOrPanic)) return signalAcpDefect(resultOrPanic);
  const result = resultOrPanic;

  const cleanupOrPanic = cleanupAttempted.match<ResultType<void, ExternalOperationFailed> | Panic>({
    ok: (value) => value,
    err: (failure) =>
      failure.kind === "panic"
        ? failure.panic
        : Result.err(ordinaryCaptureToExternal("remove-session-lock", failure)),
  });
  if (Panic.is(cleanupOrPanic)) return signalAcpDefect(cleanupOrPanic);
  const cleanup = cleanupOrPanic;
  const cleanupError = cleanup.match({ ok: () => undefined, err: (error) => error });
  if (cleanupError === undefined) return result;
  const resultError = result.match({ ok: () => undefined, err: (error) => error });
  if (resultError === undefined) return Result.err(cleanupError);
  return Result.err(
    new WorkAndCleanupFailed({
      primary: resultError,
      cleanup: cleanupError,
      message: `${resultError.message} Session index lock cleanup also failed.`,
    }),
  );
}

export async function saveRunRecord(
  run: PromptRunRecord,
): Promise<ResultType<void, ExternalOperationFailed>> {
  const directory = await captureExternal("write-run", () =>
    fs.mkdir(runsDir(), { recursive: true }),
  );
  const directoryError = directory.match({ ok: () => undefined, err: (error) => error });
  if (directoryError !== undefined) return Result.err(directoryError);
  return atomicWriteFile(runFilePath(run.id), `${JSON.stringify(run)}\n`, "write-run");
}

export async function loadRunCancellation(
  run: Pick<PromptRunRecord, "id" | "createdAt">,
): Promise<ResultType<number | undefined, RunStoreError>> {
  const markerPath = runCancellationPath(run.id);
  const marker = await captureExternal("read-run", () => fs.lstat(markerPath));
  const markerError = marker.match({ ok: () => undefined, err: (error) => error });
  if (markerError !== undefined) {
    return markerError.code === "ENOENT" ? Result.ok(undefined) : Result.err(markerError);
  }
  const markerStat = marker.match({ ok: (value) => value, err: () => undefined });
  if (markerStat === undefined) return Result.ok(undefined);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    return Result.err(
      new RunCancellationMarkerInvalidType({
        runId: run.id,
        message: `Run cancellation marker '${run.id}' must be a regular file.`,
      }),
    );
  }
  const content = await captureExternal("read-run", () => fs.readFile(markerPath, "utf8"));
  const contentError = content.match({ ok: () => undefined, err: (error) => error });
  if (contentError !== undefined) return Result.err(contentError);
  const text = content.match({ ok: (value) => value, err: () => undefined });
  if (text === undefined) return Result.ok(undefined);
  const decoded = decodeRunCancellation({ runId: run.id, content: text });
  const decodeError = decoded.match({ ok: () => undefined, err: (error) => error });
  if (decodeError !== undefined) return Result.err(decodeError);
  const cancellation = decoded.match({ ok: (value) => value.value, err: () => undefined });
  if (cancellation === undefined) return Result.ok(undefined);
  if (cancellation.runCreatedAt !== run.createdAt || cancellation.requestedAt < run.createdAt) {
    return Result.ok(undefined);
  }
  return Result.ok(cancellation.requestedAt);
}

function applyRunCancellation(
  run: PromptRunRecord,
  requestedAt: number | undefined,
): PromptRunRecord {
  if (requestedAt === undefined) return run;
  const cancelRequestedAt = Math.min(run.cancelRequestedAt ?? requestedAt, requestedAt);
  if (isTerminalRunStatus(run.status) && run.updatedAt <= cancelRequestedAt) {
    return { ...run, cancelRequestedAt };
  }
  if (!isTerminalRunStatus(run.status)) return { ...run, cancelRequestedAt };
  if (run.status === "cancelled") return { ...run, cancelRequestedAt };
  return {
    ...run,
    status: "cancelled",
    cancelRequestedAt,
    error: run.error ?? "Prompt cancelled.",
  };
}

function isTerminalRunStatus(status: PromptRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function saveWorkerRunRecord(
  run: PromptRunRecord,
): Promise<ResultType<PromptRunRecord, RunStoreError>> {
  const cancellationBefore = await loadRunCancellation(run);
  const cancellationBeforeError = cancellationBefore.match({
    ok: () => undefined,
    err: (error) => error,
  });
  if (cancellationBeforeError !== undefined) return Result.err(cancellationBeforeError);
  const before = cancellationBefore.match({ ok: (value) => value, err: () => undefined });
  let next = applyRunCancellation(run, before);
  const saved = await saveRunRecord(next);
  const saveError = saved.match({ ok: () => undefined, err: (error) => error });
  if (saveError !== undefined) return Result.err(saveError);

  const cancellationAfter = await loadRunCancellation(run);
  const cancellationAfterError = cancellationAfter.match({
    ok: () => undefined,
    err: (error) => error,
  });
  if (cancellationAfterError !== undefined) return Result.err(cancellationAfterError);
  const after = cancellationAfter.match({ ok: (value) => value, err: () => undefined });
  const merged = applyRunCancellation(next, after);
  if (merged !== next) {
    const cancellationSaved = await saveRunRecord(merged);
    const cancellationSaveError = cancellationSaved.match({
      ok: () => undefined,
      err: (error) => error,
    });
    if (cancellationSaveError !== undefined) return Result.err(cancellationSaveError);
    next = merged;
  }
  return Result.ok(next);
}

export type RunCancellationRequestOutcome =
  | { readonly kind: "requested"; readonly run: PromptRunRecord }
  | { readonly kind: "already-terminal"; readonly run: PromptRunRecord };

export async function commitRunCancellationRequest(
  run: PromptRunRecord,
): Promise<
  ResultType<Extract<RunCancellationRequestOutcome, { readonly kind: "requested" }>, RunStoreError>
> {
  const directory = await captureExternal("write-run", () =>
    fs.mkdir(runsDir(), { recursive: true }),
  );
  const directoryError = directory.match({ ok: () => undefined, err: (error) => error });
  if (directoryError !== undefined) return Result.err(directoryError);
  const requestedAt = run.cancelRequestedAt ?? Math.max(Date.now(), run.createdAt);
  const marked = await atomicWriteFile(
    runCancellationPath(run.id),
    `${JSON.stringify({
      version: 1,
      runCreatedAt: run.createdAt,
      requestedAt,
    } satisfies RunCancellation)}\n`,
    "write-run",
  );
  const markError = marked.match({ ok: () => undefined, err: (error) => error });
  if (markError !== undefined) return Result.err(markError);
  const current = await loadRunRecord(run.id);
  return current.map((value) => ({ kind: "requested" as const, run: value }));
}

export async function requestRunCancellation(
  runId: string,
): Promise<ResultType<RunCancellationRequestOutcome, RunStoreError>> {
  const safeRunId = validateRunId(runId);
  const id = safeRunId.match<string | InvalidRunId>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (InvalidRunId.is(id)) return Result.err(id);
  const loaded = await loadRunRecord(id);
  const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
  if (loadError !== undefined) return Result.err(loadError);
  const current = loaded.match({ ok: (value) => value, err: () => undefined });
  if (current === undefined) {
    return loaded.map((value) => ({ kind: "already-terminal" as const, run: value }));
  }
  if (isTerminalRunStatus(current.status)) {
    return Result.ok({ kind: "already-terminal", run: current });
  }
  return commitRunCancellationRequest(current);
}

export type RunCancellationObservation = {
  readonly result: Promise<ResultType<"requested" | "stopped", RunStoreError>>;
  readonly close: () => Promise<ResultType<void, ExternalOperationFailed>>;
};

export async function observeRunCancellation(
  run: Pick<PromptRunRecord, "id" | "createdAt">,
  inspect: (
    candidate: Pick<PromptRunRecord, "id" | "createdAt">,
  ) => Promise<ResultType<number | undefined, RunStoreError>> = loadRunCancellation,
): Promise<ResultType<RunCancellationObservation, ExternalOperationFailed>> {
  const watched = await captureExternal("watch-run-cancellation", async () => watch(runsDir()));
  const watcher = watched.match<ReturnType<typeof watch> | ExternalOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ExternalOperationFailed.is(watcher)) return Result.err(watcher);
  let accepting = true;
  let settled = false;
  let resolveResult: (result: ResultType<"requested" | "stopped", RunStoreError>) => void = () =>
    undefined;
  let rejectResult: (cause: Panic) => void = () => undefined;
  const result = new Promise<ResultType<"requested" | "stopped", RunStoreError>>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  let stopFallbackCheck: () => void = () => undefined;
  const settle = (resolution: ResultType<"requested" | "stopped", RunStoreError>) => {
    if (settled) return;
    settled = true;
    stopFallbackCheck();
    resolveResult(resolution);
  };
  const settlePanic = (panic: Extract<CapturedAcpFailure, { readonly kind: "panic" }>) => {
    if (settled) return;
    settled = true;
    stopFallbackCheck();
    rejectResult(panic.panic);
  };
  let pendingCheck = Promise.resolve();
  const scheduleCheck = () => {
    if (!accepting || settled) return;
    pendingCheck = pendingCheck.then(async () => {
      if (settled) return;
      const inspected = await settleAcpCapturePromise(
        Result.tryPromise({
          try: () => inspect(run),
          catch: captureAcpFailure,
        }),
      );
      const inspectionFailure = inspected.match({ ok: () => undefined, err: (failure) => failure });
      if (inspectionFailure !== undefined) {
        switch (inspectionFailure.kind) {
          case "panic":
            settlePanic(inspectionFailure);
            return;
          case "ordinary":
            settle(
              Result.err(
                new ExternalOperationFailed({
                  operation: "watch-run-cancellation",
                  cause: inspectionFailure.cause,
                  ...(inspectionFailure.projection.code
                    ? { code: inspectionFailure.projection.code }
                    : {}),
                  message: inspectionFailure.projection.message,
                }),
              ),
            );
            return;
        }
      }
      const inspection = inspected.match({ ok: (value) => value, err: () => undefined });
      inspection?.match({
        err: (error) => settle(Result.err(error)),
        ok: (value) => {
          if (value !== undefined) settle(Result.ok("requested"));
        },
      });
    });
  };
  watcher.on("change", scheduleCheck);
  watcher.on("error", (cause: Error) => {
    settle(
      Result.err(
        new ExternalOperationFailed({
          operation: "watch-run-cancellation",
          cause,
          message: cause.message,
        }),
      ),
    );
  });
  scheduleCheck();
  const fallbackCheck = setInterval(scheduleCheck, 100);
  fallbackCheck.unref();
  stopFallbackCheck = () => clearInterval(fallbackCheck);
  if (settled) stopFallbackCheck();

  let closeResult: Promise<ResultType<void, ExternalOperationFailed>> | undefined;
  const close = () => {
    if (closeResult) return closeResult;
    closeResult = (async () => {
      accepting = false;
      stopFallbackCheck();
      const closed = await captureExternal("close-run-cancellation-watch", async () =>
        watcher.close(),
      );
      await pendingCheck;
      if (!settled) settle(Result.ok("stopped"));
      return closed.map(() => undefined);
    })();
    return closeResult;
  };

  return Result.ok({
    result,
    close,
  });
}

export async function loadRunRecord(
  runId: string,
): Promise<ResultType<PromptRunRecord, RunStoreError>> {
  const safeRunId = validateRunId(runId);
  const id = safeRunId.match<string | InvalidRunId>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (InvalidRunId.is(id)) return Result.err(id);
  const content = await captureExternal("read-run", () => fs.readFile(runFilePath(id), "utf8"));
  const contentError = content.match({ ok: () => undefined, err: (error) => error });
  if (contentError !== undefined) return Result.err(contentError);
  const text = content.match({ ok: (value) => value, err: () => "" });
  const decoded = decodeRunRecord({ runId: id, content: text });
  const decodeError = decoded.match({ ok: () => undefined, err: (error) => error });
  if (decodeError !== undefined) return Result.err(decodeError);
  const record = decoded.match({ ok: (value) => value.value, err: () => undefined });
  if (record === undefined) return decoded.map((value) => value.value);
  const cancellation = await loadRunCancellation(record);
  return cancellation.map((requestedAt) => applyRunCancellation(record, requestedAt));
}

async function saveSessionIndex(
  entries: readonly SessionIndexEntry[],
): Promise<ResultType<void, ExternalOperationFailed>> {
  const directory = await captureExternal("write-session-index", () =>
    fs.mkdir(sessionsDir(), { recursive: true }),
  );
  const directoryError = directory.match({ ok: () => undefined, err: (error) => error });
  if (directoryError !== undefined) return Result.err(directoryError);
  const payload: SessionIndex = { version: 1, sessions: [...entries] };
  return atomicWriteFile(sessionIndexPath(), `${JSON.stringify(payload)}\n`, "write-session-index");
}

export async function loadSessionIndex(): Promise<
  ResultType<SessionIndexRead, ExternalOperationFailed | SessionIndexCodecError>
> {
  const content = await captureExternal("read-session-index", () =>
    fs.readFile(sessionIndexPath(), "utf8"),
  );
  const contentError = content.match({ ok: () => undefined, err: (error) => error });
  if (contentError !== undefined) {
    if (contentError.code === "ENOENT") {
      return Result.ok({
        provenance: "missing-defaulted",
        value: { version: 1, sessions: [] },
      });
    }
    return Result.err(contentError);
  }
  const text = content.match({ ok: (value) => value, err: () => "" });
  return decodeSessionIndex(text);
}

const fixtureRunId = "run_11111111-1111-4111-8111-111111111111";
const fixtureRunRecord: PromptRunRecord = {
  id: fixtureRunId,
  status: "submitted",
  createdAt: 1,
  updatedAt: 1,
  directory: "/repo",
  harnessId: "opencode",
  targetKind: "new",
  promptText: "fixture",
  textPreview: "fixture",
  permissions: {
    permissionsApproved: 0,
    permissionsRejected: 0,
    permissionsCancelled: 0,
  },
};

export const runRecordCodecCases = {
  current: {
    input: { runId: fixtureRunId, content: JSON.stringify(fixtureRunRecord) },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ ...fixtureRunRecord, permissions: undefined }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { runId: fixtureRunId, content: "" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { runId: fixtureRunId, content: '{"version":2}' },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { runId: fixtureRunId, content: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ ...fixtureRunRecord, permissions: {} }),
    },
    outcome: "error",
  },
} as const;

export const runCancellationCodecCases = {
  current: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ version: 1, runCreatedAt: 1, requestedAt: 2 }),
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      runId: fixtureRunId,
      content: JSON.stringify({ version: 0, runCreatedAt: 1, requestedAt: 2 }),
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { runId: fixtureRunId, content: "" },
    outcome: "error",
  },
  "unsupported-version": {
    input: { runId: fixtureRunId, content: '{"version":2}' },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { runId: fixtureRunId, content: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { runId: fixtureRunId, content: '{"version":1,"runCreatedAt":"bad"}' },
    outcome: "error",
  },
} as const;

export const sessionIndexCodecCases = {
  current: {
    input: '{"version":1,"sessions":[]}',
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: '{"version":0,"sessions":[]}',
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: undefined,
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: '{"version":2,"sessions":[]}',
    outcome: "error",
  },
  "malformed-serialization": {
    input: "{",
    outcome: "error",
  },
  "corrupt-fields": {
    input: '{"version":1,"sessions":"invalid"}',
    outcome: "error",
  },
} as const;

export async function upsertSessionIndexEntries(
  entries: readonly SessionIndexEntry[],
): Promise<ResultType<SessionIndex, SessionStoreError>> {
  return withSessionIndexLock(async () => {
    const loaded = await loadSessionIndex();
    const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
    if (loadError !== undefined) return Result.err(loadError);
    const index = loaded.match({ ok: (value) => value.value, err: () => undefined });
    if (index === undefined) return loaded.map((value) => value.value);
    const merged = new Map(index.sessions.map((entry) => [entry.sessionRef, entry]));
    for (const entry of entries) {
      const previous = merged.get(entry.sessionRef);
      merged.set(entry.sessionRef, {
        ...previous,
        ...entry,
        localTitle: entry.localTitle ?? previous?.localTitle,
      });
    }
    const next: SessionIndex = { version: 1, sessions: [...merged.values()] };
    const saved = await saveSessionIndex(next.sessions);
    return saved.map(() => next);
  });
}

export async function setLocalSessionTitle(
  sessionRef: string,
  localTitle: string,
): Promise<ResultType<SessionIndex, SessionStoreError>> {
  return withSessionIndexLock(async () => {
    const loaded = await loadSessionIndex();
    const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
    if (loadError !== undefined) return Result.err(loadError);
    const index = loaded.match({ ok: (value) => value.value, err: () => undefined });
    if (index === undefined) return loaded.map((value) => value.value);
    const nextSessions = index.sessions.map((entry) =>
      entry.sessionRef === sessionRef ? { ...entry, localTitle, title: localTitle } : entry,
    );
    const next: SessionIndex = { version: 1, sessions: nextSessions };
    const saved = await saveSessionIndex(next.sessions);
    return saved.map(() => next);
  });
}
