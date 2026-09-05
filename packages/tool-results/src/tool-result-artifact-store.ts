import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createLogger } from "@stanley2058/lilac-utils/logging";
import { errorCode } from "@stanley2058/lilac-utils/runtime-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createToolResultWindow,
  type ToolResultWindow,
  type ToolResultWindowOptions,
} from "./tool-result-window";

import {
  decodeToolResultArtifactMetadata,
  encodeToolResultArtifactMetadata,
  ToolResultArtifactMetadataUnsupportedVersion,
  type DecodedToolResultArtifactMetadata,
  type ToolResultArtifactMetadata,
  type ToolResultArtifactMetadataCodecError,
  type ToolResultArtifactMetadataIssueCode,
} from "./tool-result-artifact-metadata-codec";

export const TOOL_RESULT_URI_PREFIX = "tool-result://";
export const TOOL_RESULT_UNAVAILABLE_MESSAGE =
  "This transient tool result is no longer available because it expired or was evicted. Re-run the original tool call if the output is still needed.";
export { TOOL_RESULT_MAX_PAGE_CHARACTERS } from "./tool-result-window";

export type ToolResultArtifactStart =
  | { type: "offset"; offset: number }
  | { type: "line"; line: number; column?: number };

type ArtifactMetadata = ToolResultArtifactMetadata;

type ToolResultArtifactScope = { scopeId: string } | { sessionId: string };

type ToolResultArtifactScopeLimit = { maxBytesPerScope: number } | { maxBytesPerSession: number };

export type CreateToolResultArtifactBaseParams = ToolResultArtifactScope &
  ToolResultArtifactScopeLimit & {
    requestId: string;
    toolCallId: string;
    toolName: string;
    ttlMs: number;
    maxArtifactBytes?: number;
  };

export type CreateToolResultArtifactParams = CreateToolResultArtifactBaseParams & {
  content: string;
};

export type CreateToolResultArtifactFileParams = CreateToolResultArtifactBaseParams & {
  sourcePath: string;
};

export type CreateToolResultArtifactStreamParams = CreateToolResultArtifactBaseParams & {
  source: Readable;
};

export type CreatedToolResultArtifact = {
  id: string;
  uri: string;
  bytes: number;
  scopeBytes: number;
  /** @deprecated Use scopeBytes. */
  sessionBytes: number;
  evicted: number;
  oversized: boolean;
};

export class ToolResultArtifactTooLargeError extends TaggedError(
  "ToolResultArtifactTooLargeError",
)<{
  readonly maxArtifactBytes: number;
  readonly message: string;
}> {}

export class ToolResultArtifactStorageFailure extends TaggedError(
  "ToolResultArtifactStorageFailure",
)<{
  readonly operation: ToolResultArtifactStorageOperation;
  readonly code: string;
  readonly message: string;
}> {}

export class ToolResultArtifactInvalidInput extends TaggedError("ToolResultArtifactInvalidInput")<{
  readonly message: string;
}> {}

export class ToolResultArtifactDecryptAuthenticationFailed extends TaggedError(
  "ToolResultArtifactDecryptAuthenticationFailed",
)<{
  readonly target: "metadata" | "content";
  readonly issueCode: "decrypt-auth-failed";
  readonly message: string;
}> {}

export class ToolResultArtifactContentMismatch extends TaggedError(
  "ToolResultArtifactContentMismatch",
)<{
  readonly issueCode: "content-mismatch";
  readonly message: string;
}> {}

export class ToolResultArtifactUnavailable extends TaggedError("ToolResultArtifactUnavailable")<{
  readonly reason: "invalid-uri" | "absent" | "scope-mismatch" | "expired-or-evicted";
  readonly message: string;
}> {}

export class ToolResultArtifactReadTooLarge extends TaggedError("ToolResultArtifactReadTooLarge")<{
  readonly maxBytes: number;
  readonly actualBytes: number;
  readonly message: string;
}> {}

export class ToolResultArtifactReadCancelled extends TaggedError(
  "ToolResultArtifactReadCancelled",
)<{
  readonly message: string;
}> {}

export class ToolResultArtifactMaintenanceAndCleanupFailure extends TaggedError(
  "ToolResultArtifactMaintenanceAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactReadError;
  readonly cleanupError: ToolResultArtifactStorageFailure;
  readonly message: string;
}> {}

export class ToolResultArtifactReadAndCleanupFailure extends TaggedError(
  "ToolResultArtifactReadAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactReadOperationError;
  readonly cleanupError: ToolResultArtifactStorageFailure;
  readonly message: string;
}> {}

export class ToolResultArtifactWriteAndCleanupFailure extends TaggedError(
  "ToolResultArtifactWriteAndCleanupFailure",
)<{
  readonly primaryError: ToolResultArtifactWriteOperationError;
  readonly cleanupErrors: readonly ToolResultArtifactStorageFailure[];
  readonly message: string;
}> {}

type ToolResultArtifactStorageOperation =
  | "initialize"
  | "list-metadata"
  | "read-metadata"
  | "read-content"
  | "write-content"
  | "write-metadata"
  | "remove-artifact"
  | "maintenance";

export type ToolResultArtifactDiagnostic = {
  readonly operation: "read-metadata" | "read-content";
  readonly issueCode:
    | ToolResultArtifactMetadataIssueCode
    | "decrypt-auth-failed"
    | "content-mismatch";
  readonly version?: number;
};

export type ToolResultArtifactStoreOptions = {
  readonly onDiagnostic?: (diagnostic: ToolResultArtifactDiagnostic) => void;
};

export type ToolResultArtifactMetadataReadError =
  | ToolResultArtifactMetadataCodecError
  | ToolResultArtifactDecryptAuthenticationFailed
  | ToolResultArtifactStorageFailure;

export type ToolResultArtifactWriteOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactInvalidInput
  | ToolResultArtifactTooLargeError;

export type ToolResultArtifactWriteError =
  | ToolResultArtifactWriteOperationError
  | ToolResultArtifactWriteAndCleanupFailure;

export type ToolResultArtifactReadOperationError =
  | ToolResultArtifactMetadataReadError
  | ToolResultArtifactContentMismatch
  | ToolResultArtifactReadTooLarge
  | ToolResultArtifactReadCancelled
  | ToolResultArtifactUnavailable;

export type ToolResultArtifactReadError =
  | ToolResultArtifactReadOperationError
  | ToolResultArtifactReadAndCleanupFailure;

export type ToolResultArtifactError = ToolResultArtifactWriteError | ToolResultArtifactReadError;

export type ToolResultArtifactMaintenanceError =
  | ToolResultArtifactReadError
  | ToolResultArtifactStorageFailure
  | ToolResultArtifactMaintenanceAndCleanupFailure;

export type ToolResultArtifactMaintenanceResult = {
  readonly removedInvalid: number;
  readonly removedExpired: number;
};

export type ToolResultArtifactRead = {
  readonly content: string;
  readonly id: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type ToolResultArtifactReadWindow = ToolResultArtifactRead & {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly totalCharacters: number;
  readonly hasMore: boolean;
  readonly nextStart?: ToolResultArtifactStart;
};

export type ToolResultArtifactReadOptions = {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
};

export type ToolResultArtifactAvailability<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false };

export type ToolResultArtifactReadMaintenancePolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "maintain-after-unavailable";
      readonly onMaintenanceError: "reject" | "unavailable";
    };

export type ToolResultArtifactStore = {
  readonly rootDir: string;
  init(): Promise<ResultType<void, ToolResultArtifactError>>;
  create(
    params: CreateToolResultArtifactParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromFile(
    params: CreateToolResultArtifactFileParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  createFromStream(
    params: CreateToolResultArtifactStreamParams,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>>;
  read(
    uri: string,
    scopeId: string,
    options?: ToolResultArtifactReadOptions,
  ): Promise<ResultType<ToolResultArtifactRead, ToolResultArtifactError>>;
  readWindow(
    uri: string,
    scopeId: string,
    options: {
      start: ToolResultArtifactStart;
      maxCharacters: number;
      maxLines: number;
      /** Maximum payload bytes. Must be at least 4 when set. */
      maxOutputBytes?: number;
    },
  ): Promise<ResultType<ToolResultArtifactReadWindow, ToolResultArtifactError>>;
  maintain(
    now?: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>>;
};

export function adaptToolResultArtifactReadToAvailability<T extends object>(
  result: ResultType<T, ToolResultArtifactError>,
): ToolResultArtifactAvailability<T> {
  const outcome = result.match<
    | { type: "available"; value: T }
    | { type: "unavailable" }
    | { type: "invalid"; error: ToolResultArtifactInvalidInput }
  >({
    ok: (value) => ({ type: "available", value }),
    err: (error) =>
      error instanceof ToolResultArtifactInvalidInput
        ? { type: "invalid", error }
        : { type: "unavailable" },
  });
  if (outcome.type === "invalid") {
    throw new RangeError(outcome.error.message);
  }
  return outcome.type === "available" ? { ok: true, ...outcome.value } : { ok: false };
}

export async function adaptToolResultArtifactReadToUnavailablePolicy<T extends object>(
  store: ToolResultArtifactStore,
  result: ResultType<T, ToolResultArtifactError>,
  policy: ToolResultArtifactReadMaintenancePolicy = {
    kind: "maintain-after-unavailable",
    onMaintenanceError: "unavailable",
  },
): Promise<ToolResultArtifactAvailability<T>> {
  const unavailable = result.match({
    ok: () => false,
    err: (error) =>
      !(
        error instanceof ToolResultArtifactInvalidInput ||
        error instanceof ToolResultArtifactReadTooLarge ||
        error instanceof ToolResultArtifactReadCancelled
      ),
  });
  if (unavailable && policy.kind === "maintain-after-unavailable") {
    const maintained = await store.maintain();
    const maintenanceError = maintained.match({ ok: () => null, err: (error) => error });
    if (maintenanceError && policy.onMaintenanceError === "reject") {
      throw maintenanceError;
    }
  }
  return adaptToolResultArtifactReadToAvailability(result);
}

export function adaptToolResultArtifactStoreInitToHost(
  result: ResultType<void, ToolResultArtifactError>,
): void {
  const error = result.match({ ok: () => null, err: (failure) => failure });
  if (error) throw new Error(error.message);
}

function resultOutcome<T, E>(
  result: ResultType<T, E> | { ok: true; value: T } | { ok: false; error: E },
): { ok: true; value: T } | { ok: false; error: E } {
  if ("ok" in result) return result;
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function metadataScopeId(metadata: ArtifactMetadata): string {
  return metadata.scopeId;
}

function artifactScopeId(params: ToolResultArtifactScope): string {
  return "scopeId" in params ? params.scopeId : params.sessionId;
}

function maxBytesPerScope(params: ToolResultArtifactScopeLimit): number {
  return "maxBytesPerScope" in params ? params.maxBytesPerScope : params.maxBytesPerSession;
}

type CapturedToolResultEffect<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "defect"; readonly error: Error };

type CapturedToolResultFailure = Exclude<
  CapturedToolResultEffect<never>,
  { readonly kind: "completed" }
>;

function captureToolResultFailure(restoreCause: () => unknown): CapturedToolResultFailure {
  const cause = restoreCause();
  return Result.try({
    try: (): CapturedToolResultFailure => {
      if (Panic.is(cause)) return { kind: "panic", panic: cause };
      if (cause instanceof Error) return { kind: "defect", error: cause };
      return { kind: "defect", error: new Error("Opaque tool-result operation defect") };
    },
    catch: () => undefined,
  }).match({
    ok: (value) => value,
    err: () => ({ kind: "defect", error: new Error("Opaque tool-result operation defect") }),
  });
}

async function captureToolResultEffect<T>(
  effect: Promise<T>,
): Promise<CapturedToolResultEffect<T>> {
  const captured = await Result.tryPromise({
    try: () => effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedToolResultEffect<T>>({
    ok: (value) => ({ kind: "completed", value }),
    err: ({ restoreCause }) => captureToolResultFailure(restoreCause),
  });
}

function captureToolResultSyncEffect<T>(effect: () => T): CapturedToolResultEffect<T> {
  const captured = Result.try({
    try: () => ({ value: effect() }),
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  return captured.match<CapturedToolResultEffect<T>>({
    ok: ({ value }) => ({ kind: "completed", value }),
    err: ({ restoreCause }) => captureToolResultFailure(restoreCause),
  });
}

function validateHardLimit(
  bytes: number,
  maxArtifactBytes: number | undefined,
): ResultType<void, ToolResultArtifactInvalidInput | ToolResultArtifactTooLargeError> {
  if (
    maxArtifactBytes !== undefined &&
    (!Number.isFinite(maxArtifactBytes) || maxArtifactBytes < 0)
  ) {
    return Result.err(
      new ToolResultArtifactInvalidInput({
        message: "Tool result artifact maxArtifactBytes must be a non-negative finite number",
      }),
    );
  }
  if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
    return Result.err(
      new ToolResultArtifactTooLargeError({
        maxArtifactBytes,
        message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
      }),
    );
  }
  return Result.ok(undefined);
}

function validateReadMaxBytes(
  maxBytes: number | undefined,
): ResultType<void, ToolResultArtifactInvalidInput> {
  if (maxBytes === undefined || (Number.isSafeInteger(maxBytes) && maxBytes > 0)) {
    return Result.ok(undefined);
  }
  return Result.err(
    new ToolResultArtifactInvalidInput({
      message: "Tool result artifact read maxBytes must be a positive safe integer",
    }),
  );
}

function cancelledRead(): ToolResultArtifactReadCancelled {
  return new ToolResultArtifactReadCancelled({
    message: "Tool result artifact read was cancelled",
  });
}

function artifactIdFromUri(uri: string): string | null {
  if (!uri.startsWith(TOOL_RESULT_URI_PREFIX)) return null;
  const id = uri.slice(TOOL_RESULT_URI_PREFIX.length);
  return /^[0-9a-f-]{36}$/u.test(id) ? id : null;
}

export function createToolResultArtifactStore(
  rootDir: string,
  options: ToolResultArtifactStoreOptions = {},
): ToolResultArtifactStore {
  const resolvedRoot = path.resolve(rootDir);
  const logger = createLogger({ module: "tool-result-artifacts" });
  const encryptionKey = randomBytes(32);
  let operationQueue = Promise.resolve();

  function reportDiagnostic(
    error:
      | ToolResultArtifactMetadataCodecError
      | ToolResultArtifactDecryptAuthenticationFailed
      | ToolResultArtifactContentMismatch,
  ): void {
    let diagnostic: ToolResultArtifactDiagnostic;
    if (error instanceof ToolResultArtifactMetadataUnsupportedVersion) {
      diagnostic = {
        operation: "read-metadata",
        issueCode: error.issueCode,
        version: error.version,
      };
    } else if (error instanceof ToolResultArtifactDecryptAuthenticationFailed) {
      diagnostic = {
        operation: error.target === "metadata" ? "read-metadata" : "read-content",
        issueCode: error.issueCode,
      };
    } else if (error instanceof ToolResultArtifactContentMismatch) {
      diagnostic = { operation: "read-content", issueCode: error.issueCode };
    } else {
      diagnostic = { operation: "read-metadata", issueCode: error.issueCode };
    }
    if (options.onDiagnostic) options.onDiagnostic(diagnostic);
    else logger.warn("tool.artifact.persistence_invalid", diagnostic);
  }

  function storageFailure(
    operation: ToolResultArtifactStorageOperation,
    cause: Error | undefined,
  ): ToolResultArtifactStorageFailure {
    return new ToolResultArtifactStorageFailure({
      operation,
      code: cause === undefined ? "UNKNOWN" : (errorCode(cause) ?? "UNKNOWN"),
      message: `Tool result artifact ${operation} failed`,
    });
  }

  function combineWriteAndCleanupFailure(
    primary: ToolResultArtifactWriteError,
    cleanupError: ToolResultArtifactStorageFailure,
  ): ToolResultArtifactWriteAndCleanupFailure {
    if (primary instanceof ToolResultArtifactWriteAndCleanupFailure) {
      return new ToolResultArtifactWriteAndCleanupFailure({
        primaryError: primary.primaryError,
        cleanupErrors: [...primary.cleanupErrors, cleanupError],
        message: "Tool result artifact write and cleanup failed",
      });
    }
    return new ToolResultArtifactWriteAndCleanupFailure({
      primaryError: primary,
      cleanupErrors: [cleanupError],
      message: "Tool result artifact write and cleanup failed",
    });
  }

  async function captureOperation<T>(
    operation: ToolResultArtifactStorageOperation,
    effect: () => Promise<T>,
  ): Promise<ResultType<T, ToolResultArtifactStorageFailure>> {
    const outcome = await captureToolResultEffect(effect());
    if (outcome.kind === "completed") return Result.ok(outcome.value);
    if (outcome.kind === "panic") throw outcome.panic;
    return Result.err(storageFailure(operation, outcome.error));
  }

  function applyWriteCleanup(
    primary: ToolResultArtifactWriteError,
    cleanup: ResultType<void, ToolResultArtifactStorageFailure>,
  ): ResultType<never, ToolResultArtifactWriteError> {
    const outcome = resultOutcome(cleanup);
    return Result.err(outcome.ok ? primary : combineWriteAndCleanupFailure(primary, outcome.error));
  }

  function applyReadCleanup<T>(
    primary: ResultType<T, ToolResultArtifactReadOperationError>,
    cleanup: ResultType<void, ToolResultArtifactStorageFailure>,
  ): ResultType<T, ToolResultArtifactReadError> {
    const primaryOutcome = resultOutcome(primary);
    const cleanupOutcome = resultOutcome(cleanup);
    if (primaryOutcome.ok) {
      return cleanupOutcome.ok ? Result.ok(primaryOutcome.value) : Result.err(cleanupOutcome.error);
    }
    return cleanupOutcome.ok
      ? Result.err(primaryOutcome.error)
      : Result.err(
          new ToolResultArtifactReadAndCleanupFailure({
            primaryError: primaryOutcome.error,
            cleanupError: cleanupOutcome.error,
            message: "Tool result artifact read and cleanup failed",
          }),
        );
  }

  function contentPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.bin`);
  }

  function metadataPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.meta`);
  }

  function encrypt(
    value: string,
    operation: ToolResultArtifactStorageOperation,
  ): ResultType<Buffer, ToolResultArtifactStorageFailure> {
    const outcome = captureToolResultSyncEffect(() => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    });
    if (outcome.kind === "completed") return Result.ok(outcome.value);
    if (outcome.kind === "panic") throw outcome.panic;
    return Result.err(storageFailure(operation, outcome.error));
  }

  function decrypt(
    value: Buffer,
    target: "metadata" | "content",
  ): ResultType<string, ToolResultArtifactDecryptAuthenticationFailed> {
    if (value.length < 28) {
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target,
          issueCode: "decrypt-auth-failed",
          message: `Tool result artifact ${target} authentication failed`,
        }),
      );
    }
    const outcome = captureToolResultSyncEffect(() => {
      const nonce = value.subarray(0, 12);
      const authTag = value.subarray(value.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
        "utf8",
      );
    });
    if (outcome.kind === "completed") return Result.ok(outcome.value);
    if (outcome.kind === "panic") throw outcome.panic;
    return Result.err(
      new ToolResultArtifactDecryptAuthenticationFailed({
        target,
        issueCode: "decrypt-auth-failed",
        message: `Tool result artifact ${target} authentication failed`,
      }),
    );
  }

  async function readMetadata(
    storageKey: string,
  ): Promise<ResultType<DecodedToolResultArtifactMetadata, ToolResultArtifactMetadataReadError>> {
    const readOutcome = await captureToolResultEffect(fs.readFile(metadataPath(storageKey)));
    if (readOutcome.kind === "panic") throw readOutcome.panic;
    if (readOutcome.kind === "defect" && errorCode(readOutcome.error) === "ENOENT") {
      const absent = decodeToolResultArtifactMetadata({
        serialized: null,
        expectedStorageKey: storageKey,
      });
      const absentOutcome = resultOutcome(absent);
      if (!absentOutcome.ok) reportDiagnostic(absentOutcome.error);
      return absent;
    }
    if (readOutcome.kind === "defect") {
      return Result.err(storageFailure("read-metadata", readOutcome.error));
    }
    const encrypted = readOutcome.value;

    const decrypted = resultOutcome(decrypt(encrypted, "metadata"));
    if (!decrypted.ok) {
      reportDiagnostic(decrypted.error);
      return Result.err(decrypted.error);
    }
    const decoded = decodeToolResultArtifactMetadata({
      serialized: decrypted.value,
      expectedStorageKey: storageKey,
    });
    const decodedOutcome = resultOutcome(decoded);
    if (!decodedOutcome.ok) reportDiagnostic(decodedOutcome.error);
    return decoded;
  }

  async function listMetadata(
    ignoredStorageKey?: string,
  ): Promise<ResultType<ArtifactMetadata[], ToolResultArtifactMetadataReadError>> {
    const entries = resultOutcome(
      await captureOperation("list-metadata", () => fs.readdir(resolvedRoot)),
    );
    if (!entries.ok) return Result.err(entries.error);
    const storageKeys = [
      ...new Set(
        entries.value.flatMap((entry) => {
          if (entry.endsWith(".meta")) return [entry.slice(0, -".meta".length)];
          if (entry.endsWith(".bin")) return [entry.slice(0, -".bin".length)];
          return [];
        }),
      ),
    ].filter((storageKey) => storageKey !== ignoredStorageKey);
    const metadata: ArtifactMetadata[] = [];
    for (const storageKey of storageKeys) {
      const item = resultOutcome(await readMetadata(storageKey));
      if (!item.ok) return Result.err(item.error);
      metadata.push(item.value.value);
    }
    return Result.ok(metadata);
  }

  function removeArtifact(
    storageKey: string,
  ): Promise<ResultType<void, ToolResultArtifactStorageFailure>> {
    return captureOperation("remove-artifact", async () => {
      await Promise.all([
        fs.rm(contentPath(storageKey), { force: true }),
        fs.rm(metadataPath(storageKey), { force: true }),
      ]);
    });
  }

  async function cleanupWriteFailure<T>(
    storageKey: string,
    error: ToolResultArtifactWriteError,
  ): Promise<ResultType<T, ToolResultArtifactWriteError>> {
    return applyWriteCleanup(error, await removeArtifact(storageKey));
  }

  async function removeInvalidArtifact(
    storageKey: string,
    primaryError: ToolResultArtifactReadError,
  ): Promise<ResultType<void, ToolResultArtifactMaintenanceAndCleanupFailure>> {
    const removed = await removeArtifact(storageKey);
    const outcome = resultOutcome(removed);
    return outcome.ok
      ? Result.ok(outcome.value)
      : Result.err(
          new ToolResultArtifactMaintenanceAndCleanupFailure({
            primaryError,
            cleanupError: outcome.error,
            message: "Tool result artifact invalidation cleanup failed",
          }),
        );
  }

  async function maintainArtifacts(
    now: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>> {
    const entries = resultOutcome(
      await captureOperation("maintenance", () => fs.readdir(resolvedRoot)),
    );
    if (!entries.ok) return Result.err(entries.error);
    const storageKeys = [
      ...new Set(
        entries.value.flatMap((entry) => {
          if (entry.endsWith(".meta")) return [entry.slice(0, -".meta".length)];
          if (entry.endsWith(".bin")) return [entry.slice(0, -".bin".length)];
          return [];
        }),
      ),
    ];
    let removedInvalid = 0;
    let removedExpired = 0;
    for (const storageKey of storageKeys) {
      const decoded = resultOutcome(await readMetadata(storageKey));
      if (!decoded.ok) {
        const removed = resultOutcome(await removeInvalidArtifact(storageKey, decoded.error));
        if (!removed.ok) return Result.err(removed.error);
        removedInvalid += 1;
        continue;
      }
      const metadata = decoded.value.value;
      if (metadata.expiresAt <= now) {
        const removed = resultOutcome(await removeArtifact(storageKey));
        if (!removed.ok) return Result.err(removed.error);
        removedExpired += 1;
        continue;
      }
      const content = resultOutcome(await readEncryptedContent(storageKey, metadata.bytes));
      if (!content.ok) {
        const removed = resultOutcome(await removeInvalidArtifact(storageKey, content.error));
        if (!removed.ok) return Result.err(removed.error);
        removedInvalid += 1;
      }
    }
    if (removedExpired > 0) logger.info("tool.artifact.expired", { count: removedExpired });
    if (removedInvalid > 0) logger.info("tool.artifact.invalid_removed", { count: removedInvalid });
    return Result.ok({ removedInvalid, removedExpired });
  }

  function exclusive<T, E>(operation: () => Promise<ResultType<T, E>>): Promise<ResultType<T, E>> {
    const previous = operationQueue;
    let release = () => {};
    operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await previous;
      const operated = operation();
      await Promise.allSettled([operated]);
      release();
      return operated;
    })();
  }

  async function writeAtomic(
    operation: "write-content" | "write-metadata",
    filePath: string,
    content: Uint8Array,
  ): Promise<ResultType<void, ToolResultArtifactWriteError>> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const written = await captureOperation(operation, async () => {
      await fs.writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
    });
    const writtenOutcome = resultOutcome(written);
    if (writtenOutcome.ok) return Result.ok(undefined);
    const cleanup = await captureOperation("remove-artifact", () =>
      fs.rm(temporaryPath, { force: true }),
    );
    return applyWriteCleanup(writtenOutcome.error, cleanup);
  }

  async function writeEncryptedStreamAtomic(
    filePath: string,
    source: Readable,
    maxArtifactBytes?: number,
  ): Promise<ResultType<number, ToolResultArtifactWriteError>> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    let bytes = 0;
    const countBytes = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (maxArtifactBytes !== undefined && bytes > maxArtifactBytes) {
          callback(
            new ToolResultArtifactTooLargeError({
              maxArtifactBytes,
              message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
            }),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    const writeOutcome = await captureToolResultEffect(
      (async () => {
        await fs.writeFile(temporaryPath, nonce, { mode: 0o600, flag: "wx" });
        await pipeline(
          source,
          countBytes,
          cipher,
          createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }),
        );
        await fs.appendFile(temporaryPath, cipher.getAuthTag());
        await fs.rename(temporaryPath, filePath);
        await fs.chmod(filePath, 0o600);
        return bytes;
      })(),
    );
    if (writeOutcome.kind === "panic") {
      await captureToolResultEffect(fs.rm(temporaryPath, { force: true }));
      throw writeOutcome.panic;
    }
    const written: ResultType<number, ToolResultArtifactWriteOperationError> =
      writeOutcome.kind === "completed"
        ? Result.ok(writeOutcome.value)
        : Result.err(
            writeOutcome.error instanceof ToolResultArtifactTooLargeError
              ? writeOutcome.error
              : storageFailure("write-content", writeOutcome.error),
          );
    const writtenOutcome = resultOutcome(written);
    if (writtenOutcome.ok) return Result.ok(writtenOutcome.value);
    const cleanup = await captureOperation("remove-artifact", () =>
      fs.rm(temporaryPath, { force: true }),
    );
    return applyWriteCleanup(writtenOutcome.error, cleanup);
  }

  async function createArtifact(
    params: CreateToolResultArtifactBaseParams,
    writeContent: (filePath: string) => Promise<ResultType<number, ToolResultArtifactWriteError>>,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactWriteError>> {
    return exclusive(async () => {
      const now = Date.now();
      const scopeId = artifactScopeId(params);
      const scopeLimit = maxBytesPerScope(params);

      const id = randomUUID();
      const storageKey = randomUUID();
      const writtenContent = resultOutcome(await writeContent(contentPath(storageKey)));
      if (!writtenContent.ok) return cleanupWriteFailure(storageKey, writtenContent.error);
      const bytes = writtenContent.value;

      const listed = resultOutcome(await listMetadata(storageKey));
      if (!listed.ok) return cleanupWriteFailure(storageKey, listed.error);
      const metadataItems = listed.value;
      const scopeArtifacts = metadataItems
        .filter((item) => item.expiresAt > now && metadataScopeId(item) === scopeId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      let scopeBytes = scopeArtifacts.reduce((sum, item) => sum + item.bytes, 0);
      let evicted = 0;

      if (bytes > scopeLimit) {
        for (const item of scopeArtifacts) {
          const removed = resultOutcome(await removeArtifact(item.storageKey));
          if (!removed.ok) return Result.err(removed.error);
          scopeBytes -= item.bytes;
          evicted += 1;
        }
      } else {
        while (scopeArtifacts.length > 0 && scopeBytes + bytes > scopeLimit) {
          const item = scopeArtifacts.shift();
          if (!item) break;
          const removed = resultOutcome(await removeArtifact(item.storageKey));
          if (!removed.ok) return Result.err(removed.error);
          scopeBytes -= item.bytes;
          evicted += 1;
        }
      }

      const metadata: ArtifactMetadata = {
        id,
        storageKey,
        scopeId,
        requestId: params.requestId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        createdAt: now,
        expiresAt: now + params.ttlMs,
        bytes,
      };

      const encryptedMetadata = resultOutcome(
        encrypt(encodeToolResultArtifactMetadata(metadata), "write-metadata"),
      );
      if (!encryptedMetadata.ok) {
        return cleanupWriteFailure(storageKey, encryptedMetadata.error);
      }
      const writtenMetadata = resultOutcome(
        await writeAtomic("write-metadata", metadataPath(storageKey), encryptedMetadata.value),
      );
      if (!writtenMetadata.ok) return cleanupWriteFailure(storageKey, writtenMetadata.error);

      logger.info("tool.artifact.created", {
        toolName: params.toolName,
        bytes,
        scopeBytes: scopeBytes + bytes,
        evicted,
        oversized: bytes > scopeLimit,
      });
      if (evicted > 0) logger.info("tool.artifact.evicted", { count: evicted });
      if (bytes > scopeLimit) {
        logger.info("tool.artifact.oversized_single", { bytes });
      }

      return Result.ok({
        id,
        uri: `${TOOL_RESULT_URI_PREFIX}${id}`,
        bytes,
        scopeBytes: scopeBytes + bytes,
        sessionBytes: scopeBytes + bytes,
        evicted,
        oversized: bytes > scopeLimit,
      });
    });
  }

  async function readEncryptedWindow(
    storageKey: string,
    expectedBytes: number,
    options: ToolResultWindowOptions,
  ): Promise<ResultType<ToolResultWindow, ToolResultArtifactReadError>> {
    const filePath = contentPath(storageKey);
    const opened = await captureOperation("read-content", () => fs.open(filePath, "r"));
    const openedOutcome = opened.match<
      | { type: "ok"; value: Awaited<ReturnType<typeof fs.open>> }
      | { type: "error"; error: ToolResultArtifactStorageFailure }
    >({
      ok: (value) => ({ type: "ok" as const, value }),
      err: (error) => ({ type: "error" as const, error }),
    });
    if (openedOutcome.type === "error") return Result.err(openedOutcome.error);
    const handle = openedOutcome.value;
    const headerOutcome = await captureToolResultEffect(
      captureOperation("read-content", async () => {
        const size = (await handle.stat()).size;
        const nonce = Buffer.alloc(12);
        const authTag = Buffer.alloc(16);
        if (size < 28) return { size, nonce, authTag };
        await handle.read(nonce, 0, nonce.length, 0);
        await handle.read(authTag, 0, authTag.length, size - authTag.length);
        return { size, nonce, authTag };
      }),
    );
    const closeOutcome = await captureToolResultEffect(
      captureOperation("read-content", () => handle.close()),
    );
    if (headerOutcome.kind === "panic") throw headerOutcome.panic;
    if (headerOutcome.kind === "defect") throw headerOutcome.error;
    if (closeOutcome.kind === "panic") throw closeOutcome.panic;
    if (closeOutcome.kind === "defect") throw closeOutcome.error;
    const header = applyReadCleanup(headerOutcome.value, closeOutcome.value);
    const headerOutcomeValue = header.match<
      | { type: "ok"; value: { size: number; nonce: Buffer; authTag: Buffer } }
      | { type: "error"; error: ToolResultArtifactReadError }
    >({
      ok: (value) => ({ type: "ok" as const, value }),
      err: (error) => ({ type: "error" as const, error }),
    });
    if (headerOutcomeValue.type === "error") return Result.err(headerOutcomeValue.error);
    const { size, nonce, authTag } = headerOutcomeValue.value;
    if (size < 28) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }

    const decipherOutcome = captureToolResultSyncEffect(() => {
      const value = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
      value.setAuthTag(authTag);
      return value;
    });
    if (decipherOutcome.kind === "panic") throw decipherOutcome.panic;
    const decipher = decipherOutcome.kind === "completed" ? decipherOutcome.value : null;
    if (decipher === null) {
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target: "content",
          issueCode: "decrypt-auth-failed",
          message: "Tool result artifact content authentication failed",
        }),
      );
    }
    const decoder = new StringDecoder("utf8");
    const window = createToolResultWindow(options);

    const ciphertextBytes = size - 28;
    if (ciphertextBytes !== expectedBytes) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }
    const openedCiphertext = await captureOperation("read-content", () => fs.open(filePath, "r"));
    const openedCiphertextOutcome = openedCiphertext.match<
      | { type: "ok"; value: Awaited<ReturnType<typeof fs.open>> }
      | { type: "error"; error: ToolResultArtifactStorageFailure }
    >({
      ok: (value) => ({ type: "ok" as const, value }),
      err: (error) => ({ type: "error" as const, error }),
    });
    if (openedCiphertextOutcome.type === "error") {
      return Result.err(openedCiphertextOutcome.error);
    }
    const ciphertextHandle = openedCiphertextOutcome.value;
    const decryptionOutcome = await captureToolResultEffect(
      (async (): Promise<ResultType<void, ToolResultArtifactReadOperationError>> => {
        let decryptionError:
          | ToolResultArtifactStorageFailure
          | ToolResultArtifactDecryptAuthenticationFailed
          | undefined;
        const decryptedOutcome = await captureToolResultEffect(
          (async () => {
            if (ciphertextBytes > 0) {
              const decrypted = createReadStream(filePath, {
                fd: ciphertextHandle.fd,
                autoClose: false,
                start: 12,
                end: size - 17,
              }).pipe(decipher);
              for await (const chunk of decrypted) {
                window.consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
              }
            } else {
              decipher.final();
            }
          })(),
        );
        if (decryptedOutcome.kind === "panic") {
          throw decryptedOutcome.panic;
        }
        if (decryptedOutcome.kind === "defect") {
          if (decryptedOutcome.error instanceof Error) {
            const code = errorCode(decryptedOutcome.error);
            if (code !== undefined && !code.startsWith("ERR_CRYPTO")) {
              decryptionError = storageFailure("read-content", decryptedOutcome.error);
            }
          }
          decryptionError ??= new ToolResultArtifactDecryptAuthenticationFailed({
            target: "content",
            issueCode: "decrypt-auth-failed",
            message: "Tool result artifact content authentication failed",
          });
        }
        if (decryptionError !== undefined) {
          if (decryptionError instanceof ToolResultArtifactDecryptAuthenticationFailed) {
            reportDiagnostic(decryptionError);
          }
          return Result.err(decryptionError);
        }
        return Result.ok(undefined);
      })(),
    );
    const ciphertextCloseOutcome = await captureToolResultEffect(
      captureOperation("read-content", () => ciphertextHandle.close()),
    );
    if (decryptionOutcome.kind === "panic") throw decryptionOutcome.panic;
    if (decryptionOutcome.kind === "defect") throw decryptionOutcome.error;
    if (ciphertextCloseOutcome.kind === "panic") throw ciphertextCloseOutcome.panic;
    if (ciphertextCloseOutcome.kind === "defect") throw ciphertextCloseOutcome.error;
    const decryption = applyReadCleanup(decryptionOutcome.value, ciphertextCloseOutcome.value);
    const decryptionError = decryption.match({ ok: () => null, err: (error) => error });
    if (decryptionError) return Result.err(decryptionError);
    window.consume(decoder.end());
    return Result.ok(window.finish());
  }

  async function readEncryptedContent(
    storageKey: string,
    expectedBytes: number,
  ): Promise<ResultType<string, ToolResultArtifactReadError>> {
    const encrypted = resultOutcome(
      await captureOperation("read-content", () => fs.readFile(contentPath(storageKey))),
    );
    if (!encrypted.ok) return Result.err(encrypted.error);
    if (encrypted.value.byteLength - 28 !== expectedBytes) {
      const error = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      reportDiagnostic(error);
      return Result.err(error);
    }
    const decrypted = decrypt(encrypted.value, "content");
    const decryptedOutcome = resultOutcome(decrypted);
    if (!decryptedOutcome.ok) reportDiagnostic(decryptedOutcome.error);
    return decrypted;
  }

  return {
    rootDir: resolvedRoot,
    async init() {
      return captureOperation("initialize", async () => {
        await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
        const entries = await fs.readdir(resolvedRoot);
        await Promise.all(
          entries
            .filter(
              (entry) =>
                entry.endsWith(".bin") ||
                entry.endsWith(".meta") ||
                entry.endsWith(".tmp") ||
                entry.endsWith(".txt") ||
                entry.endsWith(".json"),
            )
            .map(async (entry) => {
              const entryPath = path.join(resolvedRoot, entry);
              const entryStat = await fs.lstat(entryPath);
              if (entryStat.isFile() || entryStat.isSymbolicLink()) {
                await fs.rm(entryPath, { force: true });
              }
            }),
        );
      });
    },
    async create(params) {
      const bytes = Buffer.byteLength(params.content, "utf8");
      const hardLimit = resultOutcome(validateHardLimit(bytes, params.maxArtifactBytes));
      if (!hardLimit.ok) return Result.err(hardLimit.error);
      const encrypted = resultOutcome(encrypt(params.content, "write-content"));
      if (!encrypted.ok) return Result.err(encrypted.error);
      const { content: _content, ...metadata } = params;
      return await createArtifact(metadata, async (filePath) =>
        (await writeAtomic("write-content", filePath, encrypted.value)).map(() => bytes),
      );
    },
    async createFromFile(params) {
      const configuredLimit = resultOutcome(validateHardLimit(0, params.maxArtifactBytes));
      if (!configuredLimit.ok) return Result.err(configuredLimit.error);
      const sourceStat = resultOutcome(
        await captureOperation("write-content", () => fs.stat(params.sourcePath)),
      );
      if (!sourceStat.ok) return Result.err(sourceStat.error);
      const hardLimit = resultOutcome(
        validateHardLimit(sourceStat.value.size, params.maxArtifactBytes),
      );
      if (!hardLimit.ok) return Result.err(hardLimit.error);
      const { sourcePath, ...metadata } = params;
      return await createArtifact(metadata, async (filePath) =>
        writeEncryptedStreamAtomic(filePath, createReadStream(sourcePath), params.maxArtifactBytes),
      );
    },
    async createFromStream(params) {
      const hardLimit = resultOutcome(validateHardLimit(0, params.maxArtifactBytes));
      if (!hardLimit.ok) return Result.err(hardLimit.error);
      const { source, ...metadata } = params;
      return await createArtifact(metadata, (filePath) =>
        writeEncryptedStreamAtomic(filePath, source, params.maxArtifactBytes),
      );
    },
    async read(uri, scopeId, options = {}) {
      const configuredLimit = resultOutcome(validateReadMaxBytes(options.maxBytes));
      if (!configuredLimit.ok) return Result.err(configuredLimit.error);
      if (options.signal?.aborted) return Result.err(cancelledRead());
      return exclusive(async () => {
        const now = Date.now();
        const id = artifactIdFromUri(uri);
        if (!id) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            }),
          );
        }
        const listed = resultOutcome(await listMetadata());
        if (!listed.ok) return Result.err(listed.error);
        const metadata = listed.value.find((item) => item.id === id);
        if (!metadata) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadata.expiresAt <= now) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadataScopeId(metadata) !== scopeId) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            }),
          );
        }

        if (options.maxBytes !== undefined && metadata.bytes > options.maxBytes) {
          return Result.err(
            new ToolResultArtifactReadTooLarge({
              maxBytes: options.maxBytes,
              actualBytes: metadata.bytes,
              message: `Tool result artifact exceeds the ${options.maxBytes}-byte read limit`,
            }),
          );
        }
        if (options.signal?.aborted) return Result.err(cancelledRead());

        const content = resultOutcome(
          await readEncryptedContent(metadata.storageKey, metadata.bytes),
        );
        if (!content.ok) return Result.err(content.error);
        if (options.signal?.aborted) return Result.err(cancelledRead());
        logger.info("tool.artifact.read", { bytes: metadata.bytes });
        return Result.ok({
          content: content.value,
          id,
          bytes: metadata.bytes,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
        });
      });
    },
    async readWindow(uri, scopeId, options) {
      if (
        options.maxOutputBytes !== undefined &&
        Number.isFinite(options.maxOutputBytes) &&
        Math.floor(options.maxOutputBytes) < 4
      ) {
        return Result.err(
          new ToolResultArtifactInvalidInput({
            message:
              "Tool result artifact maxOutputBytes must be at least 4 to fit one Unicode character",
          }),
        );
      }
      return exclusive(async () => {
        const now = Date.now();
        const id = artifactIdFromUri(uri);
        if (!id) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "invalid-uri",
              message: "Tool result artifact URI is invalid",
            }),
          );
        }
        const listed = resultOutcome(await listMetadata());
        if (!listed.ok) return Result.err(listed.error);
        const metadata = listed.value.find((item) => item.id === id);
        if (!metadata) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadata.expiresAt <= now) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "expired-or-evicted",
              message: "Tool result artifact is unavailable",
            }),
          );
        }
        if (metadataScopeId(metadata) !== scopeId) {
          return Result.err(
            new ToolResultArtifactUnavailable({
              reason: "scope-mismatch",
              message: "Tool result artifact is unavailable to this scope",
            }),
          );
        }

        const window = resultOutcome(
          await readEncryptedWindow(metadata.storageKey, metadata.bytes, options),
        );
        if (!window.ok) return Result.err(window.error);
        logger.info("tool.artifact.read", { bytes: metadata.bytes });
        return Result.ok({
          ...window.value,
          id,
          bytes: metadata.bytes,
          createdAt: metadata.createdAt,
          expiresAt: metadata.expiresAt,
        });
      });
    },
    async maintain(now = Date.now()) {
      return exclusive(() => maintainArtifacts(now));
    },
  };
}
