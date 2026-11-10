import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  decodeRemoteFsDaemonRequestJson,
  decodeRemoteFsRequestJson,
  decodeRemoteRunnerResponseJson,
  FileSystem,
  remoteEditResponseSchema,
  remoteFuzzySearchResponseSchema,
  remoteGlobResponseSchema,
  remoteGrepResponseSchema,
  remoteHealthResponseSchema,
  remoteReadBytesResponseSchema,
  remoteReadTextResponseSchema,
  type RemoteEditResponse,
  type RemoteFsDaemonRequest,
  type RemoteFuzzySearchResponse,
  type RemoteGlobResponse,
  type RemoteGrepResponse,
  type RemoteHealthResponse,
  type RemoteReadBytesResponse,
  type RemoteReadTextResponse,
  type RemoteRunnerRequestDecodeError,
  type RemoteRunnerResponseDecodeError,
} from "@stanley2058/lilac-fs";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

declare const PACKAGE_VERSION: string;

const RUNNER_PACKAGE_VERSION = typeof PACKAGE_VERSION === "string" ? PACKAGE_VERSION : "dev";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;
const SOCKET_RESPONSE_TIMEOUT_MS = 15_000;

type RemoteFsResponse =
  | RemoteReadTextResponse
  | RemoteReadBytesResponse
  | RemoteGlobResponse
  | RemoteGrepResponse
  | RemoteFuzzySearchResponse
  | RemoteEditResponse
  | RemoteHealthResponse;
type ResponseEnvelope = { ok: true; value: RemoteFsResponse } | { ok: false; error: string };
type ReadTextRequest = Extract<RemoteFsDaemonRequest, { op: "fs.read_text" }>;
type ReadBytesRequest = Extract<RemoteFsDaemonRequest, { op: "fs.read_bytes" }>;
type GlobRequest = Extract<RemoteFsDaemonRequest, { op: "fs.glob" }>;
type GrepRequest = Extract<RemoteFsDaemonRequest, { op: "fs.grep" }>;
type FuzzySearchRequest = Extract<RemoteFsDaemonRequest, { op: "fs.fuzzy_search" }>;
type EditRequest = Extract<RemoteFsDaemonRequest, { op: "fs.edit" }>;
type HealthRequest = Extract<RemoteFsDaemonRequest, { op: "health" }>;

export class RemoteFsSocketTransportError extends TaggedError("RemoteFsSocketTransportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class RemoteFsStdinReadError extends TaggedError("RemoteFsStdinReadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteFsDaemonSpawnError extends TaggedError("RemoteFsDaemonSpawnError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class RemoteFsRuntimeSetupError extends TaggedError("RemoteFsRuntimeSetupError")<{
  readonly cause: unknown;
  readonly code?: string;
  readonly message: string;
}> {}

export class RemoteFsDaemonStartupError extends TaggedError("RemoteFsDaemonStartupError")<{
  readonly message: string;
}> {}

export class RemoteFsStartupLockCleanupError extends TaggedError(
  "RemoteFsStartupLockCleanupError",
)<{
  readonly lockPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

type RemoteFsRequestOperationError =
  | RemoteFsStdinReadError
  | RemoteRunnerRequestDecodeError
  | RemoteFsRuntimeSetupError
  | RemoteFsSocketTransportError
  | RemoteRunnerResponseDecodeError
  | RemoteFsDaemonSpawnError
  | RemoteFsDaemonStartupError;

export class RemoteFsRequestCleanupCombinedError extends TaggedError(
  "RemoteFsRequestCleanupCombinedError",
)<{
  readonly operationError: RemoteFsRequestOperationError;
  readonly cleanupError: RemoteFsStartupLockCleanupError;
  readonly message: string;
}> {}

type RemoteFsRunRequestError =
  | RemoteFsRequestOperationError
  | RemoteFsStartupLockCleanupError
  | RemoteFsRequestCleanupCombinedError;

function preservePanic(error: Panic): never {
  Panic.is(error);
  throw error;
}

function opaqueErrorMessage(error: Error): string {
  return Result.try({
    try: () => error.message,
    catch: () => "Opaque remote fs runner failure",
  }).match({ ok: (message) => message, err: () => "Opaque remote fs runner failure" });
}

type ExternalErrorProjection =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "error"; readonly error: Error; readonly code?: string };

type ExternalErrorSettlement = () => ExternalErrorProjection;

function opaqueErrorCause(error: unknown): ExternalErrorSettlement {
  return () => {
    const inspectedPanic = Result.try({
      try: (): Panic | undefined => (Panic.is(error) ? error : undefined),
      catch: () => undefined,
    });
    const panic = inspectedPanic.match({ ok: (value) => value, err: () => undefined });
    if (panic) return { kind: "panic", panic };
    return Result.try({
      try: (): ExternalErrorProjection => {
        if (!(error instanceof Error)) {
          return { kind: "error", error: new Error("Opaque remote fs runner failure") };
        }
        const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
        return { kind: "error", error, code };
      },
      catch: (inspectionCause): ExternalErrorSettlement => {
        return () => {
          const inspected = Result.try({
            try: (): Panic | undefined => (Panic.is(inspectionCause) ? inspectionCause : undefined),
            catch: () => undefined,
          });
          const inspectionPanic = inspected.match({
            ok: (value) => value,
            err: () => undefined,
          });
          return inspectionPanic
            ? { kind: "panic", panic: inspectionPanic }
            : { kind: "error", error: new Error("Opaque remote fs runner failure") };
        };
      },
    }).match({ ok: (projection) => projection, err: (settle) => settle() });
  };
}

function settleExternalCapture<T>(
  result: ResultType<T, ExternalErrorSettlement>,
): ResultType<T, ExternalErrorProjection> {
  return result.mapError((settle) => settle());
}

async function captureRuntimeOperation<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<ResultType<T, RemoteFsRuntimeSetupError>> {
  const captured = settleExternalCapture(
    await Result.tryPromise({ try: operation, catch: opaqueErrorCause }),
  );
  const outcome = resultOutcome(captured);
  if (outcome.ok) return Result.ok(outcome.value);
  if (outcome.error.kind === "panic") return preservePanic(outcome.error.panic);
  return Result.err(
    new RemoteFsRuntimeSetupError({
      cause: outcome.error.error,
      code: outcome.error.code,
      message,
    }),
  );
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function runtimeBaseDir(): string {
  const fromEnv = process.env.LILAC_REMOTE_FS_RUNNER_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);

  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "lilac", "remote-fs-runner", RUNNER_PACKAGE_VERSION);
}

function socketPath(baseDir = runtimeBaseDir()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lilac-remote-fs-${RUNNER_PACKAGE_VERSION.replace(/[^a-zA-Z0-9]/g, "-")}`;
  }
  return path.join(baseDir, "daemon.sock");
}

function lockPath(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "startup.lock");
}

function fffCacheDir(baseDir = runtimeBaseDir()): string {
  return path.join(baseDir, "fff-cache");
}

export async function ensureRuntimeDir(
  baseDir = runtimeBaseDir(),
): Promise<ResultType<void, RemoteFsRuntimeSetupError>> {
  return captureRuntimeOperation(
    `failed to prepare remote fs runtime directory: ${baseDir}`,
    async () => {
      await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await fs.chmod(baseDir, 0o700);
    },
  );
}

async function readStdinText(): Promise<ResultType<string, RemoteFsStdinReadError>> {
  const readStdin = async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const captured = settleExternalCapture(
    await Result.tryPromise({ try: readStdin, catch: opaqueErrorCause }),
  );
  const outcome = resultOutcome(captured);
  if (outcome.ok) return Result.ok(outcome.value);
  if (outcome.error.kind === "panic") return preservePanic(outcome.error.panic);
  return Result.err(
    new RemoteFsStdinReadError({
      cause: outcome.error.error,
      message: "failed to read remote fs CLI stdin",
    }),
  );
}

function writeJson(value: ResponseEnvelope): void {
  process.stdout.write(JSON.stringify(value));
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function responseError(error: { readonly message: string }): ResponseEnvelope {
  return { ok: false, error: error.message };
}

function responseSuccess(value: RemoteFsResponse): ResponseEnvelope {
  return { ok: true, value };
}

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

type EditResult =
  | Awaited<ReturnType<FileSystem["editFile"]>>
  | Awaited<ReturnType<FileSystem["hashlineEditFile"]>>;

function normalizeEditOutput(result: EditResult): RemoteEditResponse {
  if (result.success) {
    return {
      success: true,
      resolvedPath: result.resolvedPath,
      oldHash: result.oldHash,
      newHash: result.newHash,
      changesMade: result.changesMade,
      replacementsMade: result.replacementsMade,
    };
  }

  return {
    success: false,
    resolvedPath: result.resolvedPath,
    currentHash: result.currentHash,
    error: result.error,
  };
}

export function handleRequest(envelope: ReadTextRequest): Promise<RemoteReadTextResponse>;
export function handleRequest(envelope: ReadBytesRequest): Promise<RemoteReadBytesResponse>;
export function handleRequest(envelope: GlobRequest): Promise<RemoteGlobResponse>;
export function handleRequest(envelope: GrepRequest): Promise<RemoteGrepResponse>;
export function handleRequest(envelope: FuzzySearchRequest): Promise<RemoteFuzzySearchResponse>;
export function handleRequest(envelope: EditRequest): Promise<RemoteEditResponse>;
export function handleRequest(envelope: HealthRequest): Promise<RemoteHealthResponse>;
export function handleRequest(envelope: RemoteFsDaemonRequest): Promise<RemoteFsResponse>;
export async function handleRequest(envelope: RemoteFsDaemonRequest): Promise<RemoteFsResponse> {
  const fsTool = new FileSystem(envelope.cwd, {
    denyPaths: envelope.denyPaths,
    fsBackend: "fff",
    fffCacheDir: fffCacheDir(),
    fuzzySearchFallback: "fzf",
  });

  switch (envelope.op) {
    case "fs.read_text":
      return await fsTool.readFile({
        path: envelope.input.path,
        start: envelope.input.start,
        maxLines: envelope.input.maxLines,
        maxCharacters: envelope.input.maxCharacters,
        maxBytes: envelope.input.maxBytes,
        format: envelope.input.format ?? "raw",
      });
    case "fs.read_bytes": {
      const result = await fsTool.readFileBytes({
        path: envelope.input.path,
        maxBytes: envelope.input.maxBytes,
        prefixBytes: envelope.input.prefixBytes,
      });
      if (!result.success) {
        return {
          ok: false,
          resolvedPath: result.resolvedPath,
          error: result.error.message,
          errorCode: result.error.code,
        };
      }
      return {
        ok: true,
        resolvedPath: result.resolvedPath,
        fileHash: result.fileHash,
        bytesLength: result.bytesLength,
        ...(result.totalBytes === undefined ? {} : { totalBytes: result.totalBytes }),
        base64: Buffer.from(result.bytes).toString("base64"),
      };
    }
    case "fs.glob":
      return await fsTool.glob({
        patterns: envelope.input.patterns,
        maxEntries: envelope.input.maxEntries,
        mode: envelope.input.mode ?? "default",
      });
    case "fs.grep":
      return await fsTool.grep({
        pattern: envelope.input.pattern,
        baseDir: envelope.input.baseDir,
        reportedFilePath: envelope.input.reportedFilePath,
        regex: envelope.input.regex,
        maxResults: envelope.input.maxResults,
        fileExtensions: envelope.input.fileExtensions?.map((ext) => ext.replace(/^\./, "")),
        includeContextLines: envelope.input.includeContextLines,
        mode: envelope.input.mode ?? "default",
      });
    case "fs.fuzzy_search":
      return await fsTool.fuzzySearchFiles({
        query: envelope.input.query,
        maxResults: envelope.input.maxResults,
      });
    case "fs.edit": {
      const expectedHash =
        envelope.input.expectedHash && envelope.input.expectedHash.length > 0
          ? envelope.input.expectedHash
          : undefined;
      if (envelope.input.mode === "hashline") {
        return normalizeEditOutput(
          await fsTool.hashlineEditFile({
            path: envelope.input.path,
            edits: envelope.input.edits,
            expectedHash,
          }),
        );
      }
      return normalizeEditOutput(
        await fsTool.editFile({
          path: envelope.input.path,
          edits: envelope.input.edits,
          expectedHash,
        }),
      );
    }
    case "health":
      return { pid: process.pid };
  }
}

function readSocketResponse(
  payload: RemoteFsDaemonRequest,
  timeoutMs: number,
): Promise<ResultType<string, RemoteFsSocketTransportError>> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath());
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settleError(new Error(`remote fs daemon socket response timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    const settle = (result: ResultType<string, RemoteFsSocketTransportError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const settleError = (cause: Error) => {
      if (settled) return;
      client.destroy();
      settle(
        Result.err(
          new RemoteFsSocketTransportError({
            cause,
            message: "remote fs daemon socket transport failed",
          }),
        ),
      );
    };

    client.setEncoding("utf8");
    client.on("connect", () => {
      client.end(JSON.stringify(payload));
    });
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.on("error", settleError);
    client.on("end", () => {
      if (settled) return;
      settle(Result.ok(response));
    });
  });
}

function decodeSocketResponse(
  request: RemoteFsDaemonRequest,
  text: string,
): ResultType<RemoteFsResponse, RemoteRunnerResponseDecodeError> {
  switch (request.op) {
    case "fs.read_text":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteReadTextResponseSchema);
    case "fs.read_bytes":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteReadBytesResponseSchema);
    case "fs.glob":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteGlobResponseSchema);
    case "fs.grep":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteGrepResponseSchema);
    case "fs.fuzzy_search":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteFuzzySearchResponseSchema);
    case "fs.edit":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteEditResponseSchema);
    case "health":
      return decodeRemoteRunnerResponseJson(request.op, text, remoteHealthResponseSchema);
  }
}

export async function connectOnce(
  payload: RemoteFsDaemonRequest,
  timeoutMs = SOCKET_RESPONSE_TIMEOUT_MS,
): Promise<
  ResultType<RemoteFsResponse, RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError>
> {
  const response = await readSocketResponse(payload, timeoutMs);
  const outcome = resultOutcome(response);
  return outcome.ok ? decodeSocketResponse(payload, outcome.value) : Result.err(outcome.error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnDaemon(
  executable = process.execPath,
  launchDaemon: () => ReturnType<typeof spawn> = () =>
    spawn(executable, [process.argv[1] ?? "", "daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }),
): Promise<ResultType<void, RemoteFsDaemonSpawnError>> {
  const launched = settleExternalCapture(
    Result.try({ try: launchDaemon, catch: opaqueErrorCause }),
  );
  const launchOutcome = resultOutcome(launched);
  if (!launchOutcome.ok) {
    if (launchOutcome.error.kind === "panic") preservePanic(launchOutcome.error.panic);
    return Result.err(
      new RemoteFsDaemonSpawnError({
        cause: launchOutcome.error.error,
        message: "failed to spawn remote fs daemon",
      }),
    );
  }
  const child = launchOutcome.value;

  return await new Promise((resolve) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(Result.ok(undefined));
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      resolve(
        Result.err(
          new RemoteFsDaemonSpawnError({
            cause,
            message: "failed to spawn remote fs daemon",
          }),
        ),
      );
    });
  });
}

async function tryConnectUntil(
  deadline: number,
  payload: RemoteFsDaemonRequest,
): Promise<
  ResultType<RemoteFsResponse, RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError>
> {
  let latestError: RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError =
    new RemoteFsSocketTransportError({
      cause: undefined,
      message: "remote fs daemon socket was unavailable",
    });
  while (Date.now() < deadline) {
    const response = await connectOnce(payload, Math.max(1, deadline - Date.now()));
    const completed = response.match<
      ResultType<RemoteFsResponse, RemoteRunnerResponseDecodeError> | undefined
    >({
      ok: (value) => Result.ok(value),
      err: (error) => {
        if (!RemoteFsSocketTransportError.is(error)) return Result.err(error);
        latestError = error;
        return undefined;
      },
    });
    if (completed) return completed;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await sleep(Math.min(CONNECT_RETRY_MS, remainingMs));
  }
  return Result.err(latestError);
}

export async function tryAcquireStartupLock(
  createLock: (target: string) => Promise<void> = async (target) => {
    await fs.mkdir(target);
  },
): Promise<ResultType<boolean, RemoteFsRuntimeSetupError>> {
  const target = lockPath();
  const created = resultOutcome(
    await captureRuntimeOperation(`failed to create remote fs startup lock: ${target}`, () =>
      createLock(target),
    ),
  );
  if (created.ok) return Result.ok(true);
  if (created.error.code !== "EEXIST") return Result.err(created.error);

  const statResult = resultOutcome(
    await captureRuntimeOperation(`failed to inspect remote fs startup lock: ${target}`, () =>
      fs.stat(target),
    ),
  );
  if (!statResult.ok) {
    return statResult.error.code === "ENOENT" ? Result.ok(false) : Result.err(statResult.error);
  }

  const lockAgeMs = Date.now() - statResult.value.mtimeMs;
  if (lockAgeMs <= STARTUP_TIMEOUT_MS) return Result.ok(false);

  const removed = resultOutcome(
    await captureRuntimeOperation(`failed to remove stale remote fs startup lock: ${target}`, () =>
      fs.rm(target, { recursive: true, force: true }),
    ),
  );
  if (!removed.ok) return Result.err(removed.error);

  const recreated = resultOutcome(
    await captureRuntimeOperation(`failed to recreate remote fs startup lock: ${target}`, () =>
      createLock(target),
    ),
  );
  if (recreated.ok) return Result.ok(true);
  return recreated.error.code === "EEXIST" ? Result.ok(false) : Result.err(recreated.error);
}

export async function releaseStartupLock(
  removeLock: (target: string) => Promise<void> = async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  },
): Promise<ResultType<void, RemoteFsStartupLockCleanupError>> {
  const target = lockPath();
  const removed = settleExternalCapture(
    await Result.tryPromise({
      try: () => removeLock(target),
      catch: opaqueErrorCause,
    }),
  );
  const outcome = resultOutcome(removed);
  if (outcome.ok) return Result.ok(undefined);
  if (outcome.error.kind === "panic") return preservePanic(outcome.error.panic);
  return Result.err(
    new RemoteFsStartupLockCleanupError({
      lockPath: target,
      cause: outcome.error.error,
      message: `failed to release remote fs startup lock: ${target}`,
    }),
  );
}

export function applyStartupLockCleanup(
  operation: ResultType<ResponseEnvelope, RemoteFsRequestOperationError>,
  cleanup: ResultType<void, RemoteFsStartupLockCleanupError>,
): ResultType<ResponseEnvelope, RemoteFsRunRequestError> {
  return cleanup.match<ResultType<ResponseEnvelope, RemoteFsRunRequestError>>({
    ok: () => operation,
    err: (cleanupError) =>
      operation.match<ResultType<ResponseEnvelope, RemoteFsRunRequestError>>({
        ok: () => Result.err(cleanupError),
        err: (operationError) =>
          Result.err(
            new RemoteFsRequestCleanupCombinedError({
              operationError,
              cleanupError,
              message: `${operationError.message}; additionally, ${cleanupError.message}`,
            }),
          ),
      }),
  });
}

type StartupLockOperationOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<ResponseEnvelope, RemoteFsRequestOperationError>;
    }
  | { readonly kind: "rejection"; readonly cause: Error };

async function captureStartupLockOperation(
  operation: () => Promise<ResultType<ResponseEnvelope, RemoteFsRequestOperationError>>,
): Promise<StartupLockOperationOutcome> {
  const captured = settleExternalCapture(
    await Result.tryPromise({ try: operation, catch: opaqueErrorCause }),
  );
  return captured.match({
    ok: (result): StartupLockOperationOutcome => ({ kind: "result", result }),
    err: (projected): StartupLockOperationOutcome => ({
      kind: "rejection",
      cause: projected.kind === "panic" ? projected.panic : projected.error,
    }),
  });
}

type CleanupFailureReporter = (failure: { readonly message: string }) => void;

function reportCleanupFailureWithoutMaskingOperation(
  report: CleanupFailureReporter,
  failure: { readonly message: string },
): void {
  Result.try({ try: () => report(failure), catch: () => undefined });
}

function reportStartupLockCleanupAfterOperationDefect(failure: { readonly message: string }): void {
  process.stderr.write(
    `remote fs startup-lock cleanup after operation defect: ${failure.message}\n`,
  );
}

async function superviseStartupLockCleanupAfterOperationDefect(
  cleanup: () => Promise<ResultType<void, RemoteFsStartupLockCleanupError>>,
  report: CleanupFailureReporter,
): Promise<void> {
  const cleaned = settleExternalCapture(
    await Result.tryPromise({ try: cleanup, catch: opaqueErrorCause }),
  );
  cleaned.match({
    ok: (cleanupResult) =>
      cleanupResult.match({
        ok: () => undefined,
        err: (error) => reportCleanupFailureWithoutMaskingOperation(report, error),
      }),
    err: (cause) =>
      reportCleanupFailureWithoutMaskingOperation(
        report,
        cause.kind === "panic" ? cause.panic : cause.error,
      ),
  });
}

export async function runWithStartupLockCleanup(
  operation: () => Promise<ResultType<ResponseEnvelope, RemoteFsRequestOperationError>>,
  cleanup: () => Promise<ResultType<void, RemoteFsStartupLockCleanupError>> = releaseStartupLock,
  report: CleanupFailureReporter = reportStartupLockCleanupAfterOperationDefect,
): Promise<ResultType<ResponseEnvelope, RemoteFsRunRequestError>> {
  const outcome = await captureStartupLockOperation(operation);
  if (outcome.kind === "rejection") {
    await superviseStartupLockCleanupAfterOperationDefect(cleanup, report);
    throw outcome.cause;
  }
  const cleanupResult = await cleanup();
  return applyStartupLockCleanup(outcome.result, cleanupResult);
}

async function waitForDaemon(
  payload: RemoteFsDaemonRequest,
): Promise<
  ResultType<
    ResponseEnvelope,
    RemoteFsSocketTransportError | RemoteRunnerResponseDecodeError | RemoteFsDaemonStartupError
  >
> {
  const response = await tryConnectUntil(Date.now() + STARTUP_TIMEOUT_MS, payload);
  return response
    .map(responseSuccess)
    .mapError((error) =>
      RemoteFsSocketTransportError.is(error)
        ? new RemoteFsDaemonStartupError({ message: "remote fs daemon did not start" })
        : error,
    );
}

export async function runRequest(): Promise<ResultType<ResponseEnvelope, RemoteFsRunRequestError>> {
  const stdin = resultOutcome(await readStdinText());
  if (!stdin.ok) return Result.err(stdin.error);
  const request = resultOutcome(decodeRemoteFsRequestJson(stdin.value));
  if (!request.ok) return Result.err(request.error);
  const payload: RemoteFsDaemonRequest = { ...request.value, cwd: process.cwd() };
  const runtimeDir = resultOutcome(await ensureRuntimeDir());
  if (!runtimeDir.ok) return Result.err(runtimeDir.error);

  const direct = resultOutcome(await tryConnectUntil(Date.now() + CONNECT_RETRY_MS, payload));
  if (direct.ok) return Result.ok(responseSuccess(direct.value));
  if (!RemoteFsSocketTransportError.is(direct.error)) return Result.err(direct.error);

  const lock = resultOutcome(await tryAcquireStartupLock());
  if (!lock.ok) return Result.err(lock.error);
  const acquiredLock = lock.value;

  const operation = async (): Promise<
    ResultType<ResponseEnvelope, RemoteFsRequestOperationError>
  > => {
    if (!acquiredLock) return await waitForDaemon(payload);
    const spawned = resultOutcome(await spawnDaemon());
    if (!spawned.ok) return Result.err(spawned.error);
    return await waitForDaemon(payload);
  };

  if (!acquiredLock) return await operation();
  return await runWithStartupLockCleanup(operation);
}

export async function executeDaemonRequest(
  request: RemoteFsDaemonRequest,
  execute: (request: RemoteFsDaemonRequest) => Promise<RemoteFsResponse> = handleRequest,
): Promise<ResultType<RemoteFsResponse, RemoteFsSocketTransportError>> {
  const executed = settleExternalCapture(
    await Result.tryPromise({
      try: () => execute(request),
      catch: opaqueErrorCause,
    }),
  );
  const outcome = resultOutcome(executed);
  if (outcome.ok) return Result.ok(outcome.value);
  if (outcome.error.kind === "panic") return preservePanic(outcome.error.panic);
  return Result.err(
    new RemoteFsSocketTransportError({
      cause: outcome.error.error,
      message: `remote fs daemon failed to execute ${request.op}`,
    }),
  );
}

function createServer(idleMs: number): net.Server {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;

  const scheduleIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (inFlight > 0) return;
    idleTimer = setTimeout(() => process.exit(0), idleMs);
  };

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    inFlight += 1;
    if (idleTimer) clearTimeout(idleTimer);

    let requestText = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      requestText += chunk;
    });
    socket.on("error", () => {
      // The client may give up during daemon startup races. The next request will retry.
    });
    socket.on("end", () => {
      void (async () => {
        const request = decodeRemoteFsDaemonRequestJson(requestText);
        await request.match({
          err: async (error) => {
            socket.end(JSON.stringify(responseError(error)));
          },
          ok: async (value) => {
            const handled = await executeDaemonRequest(value);
            handled.match({
              ok: (response) => socket.end(JSON.stringify(responseSuccess(response))),
              err: (error) => socket.end(JSON.stringify(responseError(error))),
            });
          },
        });
        inFlight -= 1;
        scheduleIdleExit();
      })();
    });
  });

  server.on("close", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  scheduleIdleExit();
  return server;
}

async function runDaemon(): Promise<ResultType<void, RemoteFsRuntimeSetupError>> {
  const runtimeDir = await ensureRuntimeDir();
  return runtimeDir.match({
    err: async (error) => Result.err(error),
    ok: async () => {
      const sock = socketPath();
      if (process.platform !== "win32" && fsSync.existsSync(sock)) {
        const unlinked = await captureRuntimeOperation(
          `failed to remove stale remote fs socket: ${sock}`,
          () => fs.unlink(sock),
        );
        const unlinkError = unlinked.match({ ok: () => null, err: (error) => error });
        if (unlinkError) return Result.err(unlinkError);
      }

      const idleMs = numberOrUndefined(process.env.LILAC_REMOTE_FS_IDLE_MS) ?? DEFAULT_IDLE_MS;
      const server = createServer(idleMs);

      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);

      return await new Promise((resolve) => {
        let settled = false;
        server.once("error", (cause) => {
          if (settled) return;
          settled = true;
          resolve(
            Result.err(
              new RemoteFsRuntimeSetupError({
                cause,
                message: `failed to listen on remote fs socket: ${sock}`,
              }),
            ),
          );
        });
        server.listen(sock, () => {
          void (async () => {
            if (settled) return;
            if (process.platform !== "win32") {
              const secured = await captureRuntimeOperation(
                `failed to secure remote fs socket: ${sock}`,
                () => fs.chmod(sock, 0o600),
              );
              secured.match({
                err: (error) => {
                  settled = true;
                  server.close();
                  resolve(Result.err(error));
                },
                ok: () => {
                  settled = true;
                  resolve(Result.ok(undefined));
                },
              });
              return;
            }
            settled = true;
            resolve(Result.ok(undefined));
          })();
        });
      });
    },
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "request";
  if (command === "--version" || command === "-v" || command === "version") {
    writeLine(RUNNER_PACKAGE_VERSION);
    return;
  }
  if (command === "daemon") {
    const daemon = await runDaemon();
    daemon.match({
      ok: () => undefined,
      err: (error) => {
        writeJson(responseError(error));
        process.exitCode = 1;
      },
    });
    return;
  }
  if (command === "request") {
    const request = await runRequest();
    writeJson(request.match({ ok: (value) => value, err: responseError }));
    return;
  }
  if (command === "health") {
    const runtimeDir = await ensureRuntimeDir();
    await runtimeDir.match({
      err: async (error) => writeJson(responseError(error)),
      ok: async () => {
        const response = await connectOnce({
          op: "health",
          input: {},
          denyPaths: [],
          cwd: process.cwd(),
        });
        writeJson(
          response.match({
            ok: (value) => ({ ok: true, value }) satisfies ResponseEnvelope,
            err: responseError,
          }),
        );
      },
    });
    return;
  }

  writeJson({ ok: false, error: `Unknown command: ${command}` } satisfies ResponseEnvelope);
}

export function reportMainFailure(error: Error): void {
  const projected = opaqueErrorCause(error)();
  if (projected.kind === "panic") preservePanic(projected.panic);
  writeJson({ ok: false, error: opaqueErrorMessage(projected.error) } satisfies ResponseEnvelope);
  process.exitCode = 1;
}

async function startMain(): Promise<void> {
  const captured = settleExternalCapture(
    await Result.tryPromise({ try: main, catch: opaqueErrorCause }),
  );
  const failure = captured.match<ExternalErrorProjection | undefined>({
    ok: () => undefined,
    err: (error) => error,
  });
  if (!failure) return;
  reportMainFailure(failure.kind === "panic" ? failure.panic : failure.error);
}

if (import.meta.main) await startMain();
