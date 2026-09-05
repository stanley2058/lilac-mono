import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  type BlobRead,
  type BlobRefV1,
  type BlobSource,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { createLogger } from "@stanley2058/lilac-utils/logging";
import { errorCode } from "@stanley2058/lilac-utils/runtime-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  decodeBlobToolResultArtifactMetadata,
  encodeBlobToolResultArtifactMetadata,
  type BlobToolResultArtifactMetadata,
  type DecodedBlobToolResultArtifactMetadata,
} from "./blob-tool-result-artifact-metadata-codec";
import {
  TOOL_RESULT_MAX_PAGE_CHARACTERS,
  TOOL_RESULT_URI_PREFIX,
  ToolResultArtifactContentMismatch,
  ToolResultArtifactDecryptAuthenticationFailed,
  ToolResultArtifactInvalidInput,
  ToolResultArtifactMaintenanceAndCleanupFailure,
  ToolResultArtifactReadCancelled,
  ToolResultArtifactReadTooLarge,
  ToolResultArtifactStorageFailure,
  ToolResultArtifactTooLargeError,
  ToolResultArtifactUnavailable,
  ToolResultArtifactWriteAndCleanupFailure,
  type CreateToolResultArtifactBaseParams,
  type CreatedToolResultArtifact,
  type ToolResultArtifactDiagnostic,
  type ToolResultArtifactError,
  type ToolResultArtifactMaintenanceError,
  type ToolResultArtifactMaintenanceResult,
  type ToolResultArtifactMetadataReadError,
  type ToolResultArtifactReadOperationError,
  type ToolResultArtifactReadOptions,
  type ToolResultArtifactStart,
  type ToolResultArtifactStore,
  type ToolResultArtifactStoreOptions,
  type ToolResultArtifactWriteError,
  type ToolResultArtifactWriteOperationError,
} from "./tool-result-artifact-store";
import {
  ToolResultArtifactMetadataUnsupportedVersion,
  type ToolResultArtifactMetadataCodecError,
} from "./tool-result-artifact-metadata-codec";

type StorageOperation =
  | "initialize"
  | "list-metadata"
  | "read-metadata"
  | "read-content"
  | "write-content"
  | "write-metadata"
  | "remove-artifact"
  | "maintenance";

type Metadata = BlobToolResultArtifactMetadata;
type Scope = { scopeId: string } | { sessionId: string };
type ScopeLimit = { maxBytesPerScope: number } | { maxBytesPerSession: number };

type Effect<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "defect"; readonly error?: Error };

function captureCause(restore: () => unknown): Exclude<Effect<never>, { kind: "completed" }> {
  const cause = restore();
  return Result.try({
    try: () => {
      if (Panic.is(cause)) return { kind: "panic", panic: cause } as const;
      return { kind: "defect", ...(cause instanceof Error ? { error: cause } : {}) } as const;
    },
    catch: () => undefined,
  }).match<Exclude<Effect<never>, { kind: "completed" }>>({
    ok: (value) => value,
    err: () => ({ kind: "defect" as const }),
  });
}

async function captureEffect<T>(effect: Promise<T>): Promise<Effect<T>> {
  return (
    await Result.tryPromise({
      try: () => effect,
      catch: (cause) => ({ restore: () => cause }),
    })
  ).match<Effect<T>>({
    ok: (value) => ({ kind: "completed", value }),
    err: ({ restore }) => captureCause(restore),
  });
}

function captureSyncEffect<T>(effect: () => T): Effect<T> {
  return Result.try({
    try: () => ({ value: effect() }),
    catch: (cause) => ({ restore: () => cause }),
  }).match<Effect<T>>({
    ok: ({ value }) => ({ kind: "completed", value }),
    err: ({ restore }) => captureCause(restore),
  });
}

function rethrowBlobToolResultPanic(panic: Panic): never {
  throw panic;
}

function cancelledRead(): ToolResultArtifactReadCancelled {
  return new ToolResultArtifactReadCancelled({
    message: "Tool result artifact read was cancelled",
  });
}

function contentMismatch(): ToolResultArtifactContentMismatch {
  return new ToolResultArtifactContentMismatch({
    issueCode: "content-mismatch",
    message: "Tool result artifact content does not match its metadata",
  });
}

async function settleReaderCancellation(cancellation?: Promise<void>): Promise<boolean> {
  if (!cancellation) return false;
  const captured = await captureEffect(cancellation);
  if (captured.kind === "panic") return rethrowBlobToolResultPanic(captured.panic);
  return captured.kind === "defect";
}

async function materializeBlobReadWithSignal(
  read: BlobRead,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<
  ResultType<Uint8Array, ToolResultArtifactReadCancelled | ToolResultArtifactContentMismatch>
> {
  const reader = read.stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let sourceFailed = false;
  let overflowed = false;
  let done = false;
  const aborted = Promise.withResolvers<void>();
  let signalCancellation: Promise<void> | undefined;
  const cancelForSignal = () => {
    signalCancellation ??= reader.cancel("Tool result artifact read was cancelled");
    aborted.resolve();
  };
  signal?.addEventListener("abort", cancelForSignal, { once: true });
  if (signal?.aborted) cancelForSignal();
  while (!done && !sourceFailed && !overflowed && !signal?.aborted) {
    const readStep = reader.read().then((result) => ({ kind: "read" as const, result }));
    const raced = signal
      ? Promise.race([readStep, aborted.promise.then(() => ({ kind: "cancelled" as const }))])
      : readStep;
    const captured = await captureEffect(raced);
    if (captured.kind === "panic") return rethrowBlobToolResultPanic(captured.panic);
    if (captured.kind === "defect") {
      sourceFailed = true;
      continue;
    }
    if (captured.value.kind === "cancelled") continue;
    if (captured.value.result.done) {
      done = true;
      continue;
    }
    const chunk = captured.value.result.value;
    if (byteLength + chunk.byteLength > maxBytes) {
      overflowed = true;
      continue;
    }
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  signal?.removeEventListener("abort", cancelForSignal);
  const overflowCancellation = overflowed
    ? reader.cancel("Tool result artifact exceeded its limit")
    : undefined;
  const overflowCancellationFailed = await settleReaderCancellation(overflowCancellation);
  const signalCancellationFailed = await settleReaderCancellation(signalCancellation);
  sourceFailed = sourceFailed || overflowCancellationFailed || signalCancellationFailed;
  reader.releaseLock();
  const completed = await captureEffect(read.completion);
  if (completed.kind === "panic") return rethrowBlobToolResultPanic(completed.panic);
  if (signal?.aborted) return Result.err(cancelledRead());
  if (overflowed || sourceFailed || completed.kind === "defect") {
    return Result.err(contentMismatch());
  }
  const verified = outcome(completed.value);
  if (!verified.ok || verified.value.byteLength !== byteLength) {
    return Result.err(contentMismatch());
  }
  const joined = captureSyncEffect(() => {
    const content = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return content;
  });
  if (joined.kind === "panic") return rethrowBlobToolResultPanic(joined.panic);
  return joined.kind === "completed" ? Result.ok(joined.value) : Result.err(contentMismatch());
}

function outcome<T, E>(result: ResultType<T, E>): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true as const, value }),
    err: (error) => ({ ok: false as const, error }),
  });
}

function scopeId(value: Scope): string {
  return "scopeId" in value ? value.scopeId : value.sessionId;
}

function scopeLimit(value: ScopeLimit): number {
  return "maxBytesPerScope" in value ? value.maxBytesPerScope : value.maxBytesPerSession;
}

function artifactIdFromUri(uri: string): string | null {
  if (!uri.startsWith(TOOL_RESULT_URI_PREFIX)) return null;
  const id = uri.slice(TOOL_RESULT_URI_PREFIX.length);
  return /^[0-9a-f-]{36}$/u.test(id) ? id : null;
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
  return maxArtifactBytes !== undefined && bytes > maxArtifactBytes
    ? Result.err(
        new ToolResultArtifactTooLargeError({
          maxArtifactBytes,
          message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
        }),
      )
    : Result.ok(undefined);
}

function validateReadOptions(
  options: ToolResultArtifactReadOptions,
): ResultType<void, ToolResultArtifactInvalidInput> {
  if (
    options.maxBytes === undefined ||
    (Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0)
  ) {
    return Result.ok(undefined);
  }
  return Result.err(
    new ToolResultArtifactInvalidInput({
      message: "Tool result artifact read maxBytes must be a positive safe integer",
    }),
  );
}

type WindowSelection = {
  readonly content: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly totalCharacters: number;
  readonly hasMore: boolean;
  readonly nextStart?: ToolResultArtifactStart;
};

function selectWindow(
  content: string,
  requestedStart: ToolResultArtifactStart,
  requestedCharacters: number,
  requestedLines: number,
  requestedOutputBytes: number | undefined,
): WindowSelection {
  const start: ToolResultArtifactStart =
    requestedStart.type === "offset"
      ? {
          type: "offset",
          offset: Number.isFinite(requestedStart.offset)
            ? Math.max(0, Math.floor(requestedStart.offset))
            : 0,
        }
      : {
          type: "line",
          line: Number.isFinite(requestedStart.line)
            ? Math.max(1, Math.floor(requestedStart.line))
            : 1,
          column:
            requestedStart.column !== undefined && Number.isFinite(requestedStart.column)
              ? Math.max(0, Math.floor(requestedStart.column))
              : 0,
        };
  const maxCharacters = Math.min(
    TOOL_RESULT_MAX_PAGE_CHARACTERS,
    Math.max(
      1,
      Number.isFinite(requestedCharacters)
        ? Math.floor(requestedCharacters)
        : TOOL_RESULT_MAX_PAGE_CHARACTERS,
    ),
  );
  const maxLines = Number.isFinite(requestedLines) ? Math.max(1, Math.floor(requestedLines)) : 1;
  const maxOutputBytes =
    requestedOutputBytes !== undefined && Number.isFinite(requestedOutputBytes)
      ? Math.max(1, Math.floor(requestedOutputBytes))
      : Number.POSITIVE_INFINITY;
  let offset = 0;
  let line = 1;
  let column = 0;
  let startOffset: number | undefined;
  let endOffset: number | undefined;
  let endLine: number | undefined;
  let endColumn: number | undefined;
  let selectedLines = 1;
  let selectedBytes = 0;
  const selected: string[] = [];
  for (const character of content) {
    if (startOffset === undefined) {
      const reached =
        start.type === "offset"
          ? offset >= start.offset
          : line === start.line && (column >= (start.column ?? 0) || character === "\n");
      if (reached) startOffset = offset;
    }
    let selectionEnds = false;
    if (startOffset !== undefined && endOffset === undefined) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (selectedBytes + characterBytes > maxOutputBytes) {
        endOffset = offset;
        endLine = line;
        endColumn = column;
      } else if (character === "\n" && selectedLines >= maxLines) {
        if (start.type === "offset") {
          selected.push(character);
          selectedBytes += characterBytes;
        }
        selectionEnds = true;
      } else {
        selected.push(character);
        selectedBytes += characterBytes;
        if (selected.length >= maxCharacters) selectionEnds = true;
        else if (character === "\n") selectedLines += 1;
      }
    }
    offset += 1;
    if (character === "\n") {
      line += 1;
      column = 0;
    } else column += 1;
    if (selectionEnds) {
      endOffset = offset;
      endLine = line;
      endColumn = column;
    }
  }
  const resolvedStartOffset = startOffset ?? offset;
  const resolvedEndOffset = endOffset ?? offset;
  const hasMore = resolvedEndOffset < offset;
  let nextStart: ToolResultArtifactStart | undefined;
  if (hasMore && start.type === "offset") {
    nextStart = { type: "offset", offset: resolvedEndOffset };
  } else if (hasMore) {
    nextStart = { type: "line", line: endLine ?? line, column: endColumn ?? column };
  }
  return {
    content: selected.join(""),
    startOffset: resolvedStartOffset,
    endOffset: resolvedEndOffset,
    totalCharacters: offset,
    hasMore,
    ...(nextStart === undefined ? {} : { nextStart }),
  };
}

function encryptedStream(
  source: Readable,
  maxArtifactBytes: number | undefined,
  state: { bytes: number; tooLarge?: ToolResultArtifactTooLargeError },
  encryptionKey: Buffer,
): BlobSource {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  async function* encryptChunks() {
    yield nonce;
    for await (const chunk of source) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.bytes += value.byteLength;
      if (maxArtifactBytes !== undefined && state.bytes > maxArtifactBytes) {
        state.tooLarge = new ToolResultArtifactTooLargeError({
          maxArtifactBytes,
          message: `Tool result artifact exceeds the hard limit of ${maxArtifactBytes} bytes`,
        });
        return;
      }
      const encrypted = cipher.update(value);
      if (encrypted.byteLength > 0) yield encrypted;
    }
    const final = cipher.final();
    if (final.byteLength > 0) yield final;
    yield cipher.getAuthTag();
  }
  const iterator = encryptChunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

export function createBlobBackedToolResultArtifactStore(
  rootDir: string,
  blobStore: BlobStore,
  options: ToolResultArtifactStoreOptions = {},
): ToolResultArtifactStore {
  const resolvedRoot = path.resolve(rootDir);
  const encryptionKey = randomBytes(32);
  const logger = createLogger({ module: "tool-result-artifacts" });
  let queue = Promise.resolve();

  function failure(operation: StorageOperation, cause?: Error): ToolResultArtifactStorageFailure {
    return new ToolResultArtifactStorageFailure({
      operation,
      code: cause === undefined ? "BLOB_STORE" : (errorCode(cause) ?? "UNKNOWN"),
      message: `Tool result artifact ${operation} failed`,
    });
  }

  async function captureFs<T>(
    operation: StorageOperation,
    effect: () => Promise<T>,
  ): Promise<ResultType<T, ToolResultArtifactStorageFailure>> {
    const captured = await captureEffect(effect());
    if (captured.kind === "panic") return rethrowBlobToolResultPanic(captured.panic);
    return captured.kind === "completed"
      ? Result.ok(captured.value)
      : Result.err(failure(operation, captured.error));
  }

  function report(
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
    } else diagnostic = { operation: "read-metadata", issueCode: error.issueCode };
    if (options.onDiagnostic) options.onDiagnostic(diagnostic);
    else logger.warn("tool.artifact.persistence_invalid", diagnostic);
  }

  function exclusive<T, E>(operation: () => Promise<ResultType<T, E>>): Promise<ResultType<T, E>> {
    const previous = queue;
    let release = () => {};
    queue = new Promise<void>((resolve) => {
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

  function metadataPath(storageKey: string): string {
    return path.join(resolvedRoot, `${storageKey}.meta`);
  }

  function encrypt(
    value: string,
    operation: StorageOperation,
  ): ResultType<Buffer, ToolResultArtifactStorageFailure> {
    const encrypted = captureSyncEffect(() => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      return Buffer.concat([
        nonce,
        cipher.update(value, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    });
    if (encrypted.kind === "panic") return rethrowBlobToolResultPanic(encrypted.panic);
    return encrypted.kind === "completed"
      ? Result.ok(encrypted.value)
      : Result.err(failure(operation, encrypted.error));
  }

  function decrypt(
    value: Uint8Array,
    target: "metadata" | "content",
  ): ResultType<string, ToolResultArtifactDecryptAuthenticationFailed> {
    if (value.byteLength < 28) {
      return Result.err(
        new ToolResultArtifactDecryptAuthenticationFailed({
          target,
          issueCode: "decrypt-auth-failed",
          message: `Tool result artifact ${target} authentication failed`,
        }),
      );
    }
    const decrypted = captureSyncEffect(() => {
      const bytes = Buffer.from(value);
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
        "utf8",
      );
    });
    if (decrypted.kind === "panic") return rethrowBlobToolResultPanic(decrypted.panic);
    return decrypted.kind === "completed"
      ? Result.ok(decrypted.value)
      : Result.err(
          new ToolResultArtifactDecryptAuthenticationFailed({
            target,
            issueCode: "decrypt-auth-failed",
            message: `Tool result artifact ${target} authentication failed`,
          }),
        );
  }

  async function writeMetadata(
    metadata: Metadata,
  ): Promise<ResultType<void, ToolResultArtifactWriteOperationError>> {
    const encrypted = outcome(
      encrypt(encodeBlobToolResultArtifactMetadata(metadata), "write-metadata"),
    );
    if (!encrypted.ok) return Result.err(encrypted.error);
    const destination = metadataPath(metadata.storageKey);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const written = outcome(
      await captureFs("write-metadata", async () => {
        await fs.writeFile(temporary, encrypted.value, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, destination);
        await fs.chmod(destination, 0o600);
      }),
    );
    if (written.ok) return Result.ok(undefined);
    await captureFs("remove-artifact", () => fs.rm(temporary, { force: true }));
    return Result.err(written.error);
  }

  async function readMetadata(
    storageKey: string,
  ): Promise<
    ResultType<DecodedBlobToolResultArtifactMetadata, ToolResultArtifactMetadataReadError>
  > {
    const read = await captureEffect(fs.readFile(metadataPath(storageKey)));
    if (read.kind === "panic") return rethrowBlobToolResultPanic(read.panic);
    if (read.kind === "defect" && read.error !== undefined && errorCode(read.error) === "ENOENT") {
      const absent = decodeBlobToolResultArtifactMetadata({
        serialized: null,
        expectedStorageKey: storageKey,
      });
      const decoded = outcome(absent);
      if (!decoded.ok) report(decoded.error);
      return absent;
    }
    if (read.kind === "defect") return Result.err(failure("read-metadata", read.error));
    const decrypted = outcome(decrypt(read.value, "metadata"));
    if (!decrypted.ok) {
      report(decrypted.error);
      return Result.err(decrypted.error);
    }
    const decoded = decodeBlobToolResultArtifactMetadata({
      serialized: decrypted.value,
      expectedStorageKey: storageKey,
    });
    const decodedOutcome = outcome(decoded);
    if (!decodedOutcome.ok) report(decodedOutcome.error);
    return decoded;
  }

  async function listMetadata(
    ignored?: string,
  ): Promise<ResultType<Metadata[], ToolResultArtifactMetadataReadError>> {
    const listed = outcome(await captureFs("list-metadata", () => fs.readdir(resolvedRoot)));
    if (!listed.ok) return Result.err(listed.error);
    const metadata: Metadata[] = [];
    for (const entry of listed.value.filter((value) => value.endsWith(".meta"))) {
      const storageKey = entry.slice(0, -5);
      if (storageKey === ignored) continue;
      const read = outcome(await readMetadata(storageKey));
      if (!read.ok) return Result.err(read.error);
      metadata.push(read.value.value);
    }
    return Result.ok(metadata);
  }

  async function deleteBlob(
    ref: BlobRefV1,
  ): Promise<ResultType<void, ToolResultArtifactStorageFailure>> {
    return (await blobStore.delete(ref))
      .map(() => undefined)
      .mapError(() => failure("remove-artifact"));
  }

  async function removeArtifact(
    metadata: Metadata,
  ): Promise<ResultType<void, ToolResultArtifactStorageFailure>> {
    const unlinked = outcome(
      await captureFs("remove-artifact", () =>
        fs.rm(metadataPath(metadata.storageKey), { force: true }),
      ),
    );
    if (!unlinked.ok) return Result.err(unlinked.error);
    return deleteBlob(metadata.blob);
  }

  async function readContent(
    metadata: Metadata,
    signal?: AbortSignal,
  ): Promise<ResultType<string, ToolResultArtifactReadOperationError>> {
    if (signal?.aborted) return Result.err(cancelledRead());
    const opened = outcome(await blobStore.open(metadata.blob));
    if (!opened.ok) {
      const mismatch = contentMismatch();
      report(mismatch);
      return Result.err(mismatch);
    }
    const materialized = outcome(
      await materializeBlobReadWithSignal(opened.value, metadata.bytes + 28, signal),
    );
    if (!materialized.ok && materialized.error instanceof ToolResultArtifactReadCancelled) {
      return Result.err(materialized.error);
    }
    if (!materialized.ok || materialized.value.byteLength !== metadata.bytes + 28) {
      const mismatch = contentMismatch();
      report(mismatch);
      return Result.err(mismatch);
    }
    const decrypted = outcome(decrypt(materialized.value, "content"));
    if (!decrypted.ok) {
      report(decrypted.error);
      return Result.err(decrypted.error);
    }
    if (Buffer.byteLength(decrypted.value, "utf8") !== metadata.bytes) {
      const mismatch = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      report(mismatch);
      return Result.err(mismatch);
    }
    return Result.ok(decrypted.value);
  }

  async function upload(
    source: BlobSource,
    expiresAt: number,
    bytes: () => number,
    tooLarge: () => ToolResultArtifactTooLargeError | undefined,
  ): Promise<
    ResultType<{ ref: BlobRefV1; bytes: number; expiresAt: number }, ToolResultArtifactWriteError>
  > {
    const started = outcome(
      await blobStore.startUpload({ source, retention: { kind: "expires", expiresAt } }),
    );
    if (!started.ok) {
      if (!(source instanceof Uint8Array)) await captureEffect(source.cancel());
      return Result.err(failure("write-content"));
    }
    const completed = outcome(await started.value.completion);
    if (!completed.ok) {
      const overflow = tooLarge();
      const deleted = outcome(await blobStore.delete(started.value.handle));
      const primary = overflow ?? failure("write-content");
      return deleted.ok
        ? Result.err(primary)
        : Result.err(
            new ToolResultArtifactWriteAndCleanupFailure({
              primaryError: primary,
              cleanupErrors: [failure("remove-artifact")],
              message: "Tool result artifact write and cleanup failed",
            }),
          );
    }
    const overflow = tooLarge();
    if (overflow !== undefined) {
      const deleted = outcome(await blobStore.delete(completed.value));
      return deleted.ok
        ? Result.err(overflow)
        : Result.err(
            new ToolResultArtifactWriteAndCleanupFailure({
              primaryError: overflow,
              cleanupErrors: [failure("remove-artifact")],
              message: "Tool result artifact write and cleanup failed",
            }),
          );
    }
    const rawBytes = bytes();
    if (completed.value.expiresAt !== expiresAt || completed.value.byteLength !== rawBytes + 28) {
      const primary = new ToolResultArtifactContentMismatch({
        issueCode: "content-mismatch",
        message: "Tool result artifact content does not match its metadata",
      });
      const deleted = outcome(await blobStore.delete(completed.value));
      return deleted.ok
        ? Result.err(primary)
        : Result.err(
            new ToolResultArtifactWriteAndCleanupFailure({
              primaryError: primary,
              cleanupErrors: [failure("remove-artifact")],
              message: "Tool result artifact write and cleanup failed",
            }),
          );
    }
    return Result.ok({ ref: completed.value, bytes: rawBytes, expiresAt });
  }

  async function createArtifact(
    params: CreateToolResultArtifactBaseParams,
    createdAt: number,
    uploaded: Promise<
      ResultType<{ ref: BlobRefV1; bytes: number; expiresAt: number }, ToolResultArtifactWriteError>
    >,
  ): Promise<ResultType<CreatedToolResultArtifact, ToolResultArtifactError>> {
    return exclusive(async () => {
      const uploadedOutcome = outcome(await uploaded);
      if (!uploadedOutcome.ok) return Result.err(uploadedOutcome.error);
      const id = randomUUID();
      const storageKey = randomUUID();
      const listed = outcome(await listMetadata());
      if (!listed.ok) {
        const deleted = outcome(await deleteBlob(uploadedOutcome.value.ref));
        return deleted.ok
          ? Result.err(listed.error)
          : Result.err(
              new ToolResultArtifactWriteAndCleanupFailure({
                primaryError: listed.error,
                cleanupErrors: [deleted.error],
                message: "Tool result artifact write and cleanup failed",
              }),
            );
      }
      const owner = scopeId(params);
      const limit = scopeLimit(params);
      const artifacts = listed.value
        .filter((item) => item.expiresAt > createdAt && item.scopeId === owner)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      let scopeBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
      let evicted = 0;
      const victims = uploadedOutcome.value.bytes > limit ? artifacts : artifacts.slice();
      while (
        victims.length > 0 &&
        (uploadedOutcome.value.bytes > limit || scopeBytes + uploadedOutcome.value.bytes > limit)
      ) {
        const victim = victims.shift();
        if (!victim) break;
        const removed = outcome(await removeArtifact(victim));
        if (!removed.ok) {
          const cleanedUpload = outcome(await deleteBlob(uploadedOutcome.value.ref));
          return cleanedUpload.ok
            ? Result.err(removed.error)
            : Result.err(
                new ToolResultArtifactWriteAndCleanupFailure({
                  primaryError: removed.error,
                  cleanupErrors: [cleanedUpload.error],
                  message: "Tool result artifact write and cleanup failed",
                }),
              );
        }
        scopeBytes -= victim.bytes;
        evicted += 1;
      }
      const metadata: Metadata = {
        id,
        storageKey,
        scopeId: owner,
        requestId: params.requestId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        createdAt,
        expiresAt: uploadedOutcome.value.expiresAt,
        bytes: uploadedOutcome.value.bytes,
        blob: uploadedOutcome.value.ref,
      };
      const written = outcome(await writeMetadata(metadata));
      if (!written.ok) {
        const deleted = outcome(await deleteBlob(metadata.blob));
        if (!deleted.ok) {
          return Result.err(
            new ToolResultArtifactWriteAndCleanupFailure({
              primaryError: written.error,
              cleanupErrors: [deleted.error],
              message: "Tool result artifact write and cleanup failed",
            }),
          );
        }
        return Result.err(written.error);
      }
      const total = scopeBytes + metadata.bytes;
      logger.info("tool.artifact.created", {
        toolName: params.toolName,
        bytes: metadata.bytes,
        scopeBytes: total,
        evicted,
        oversized: metadata.bytes > limit,
      });
      return Result.ok({
        id,
        uri: `${TOOL_RESULT_URI_PREFIX}${id}`,
        bytes: metadata.bytes,
        scopeBytes: total,
        sessionBytes: total,
        evicted,
        oversized: metadata.bytes > limit,
      });
    });
  }

  async function find(
    uri: string,
    owner: string,
  ): Promise<ResultType<Metadata, ToolResultArtifactError>> {
    const id = artifactIdFromUri(uri);
    if (!id)
      return Result.err(
        new ToolResultArtifactUnavailable({
          reason: "invalid-uri",
          message: "Tool result artifact URI is invalid",
        }),
      );
    const listed = outcome(await listMetadata());
    if (!listed.ok) return Result.err(listed.error);
    const metadata = listed.value.find((item) => item.id === id);
    if (!metadata || metadata.expiresAt <= Date.now()) {
      return Result.err(
        new ToolResultArtifactUnavailable({
          reason: "expired-or-evicted",
          message: "Tool result artifact is unavailable",
        }),
      );
    }
    return metadata.scopeId === owner
      ? Result.ok(metadata)
      : Result.err(
          new ToolResultArtifactUnavailable({
            reason: "scope-mismatch",
            message: "Tool result artifact is unavailable to this scope",
          }),
        );
  }

  async function maintainUnlocked(
    now: number,
  ): Promise<ResultType<ToolResultArtifactMaintenanceResult, ToolResultArtifactMaintenanceError>> {
    const listed = outcome(await captureFs("maintenance", () => fs.readdir(resolvedRoot)));
    if (!listed.ok) return Result.err(listed.error);
    let removedInvalid = 0;
    let removedExpired = 0;
    for (const entry of listed.value.filter((value) => value.endsWith(".meta"))) {
      const storageKey = entry.slice(0, -5);
      const decoded = outcome(await readMetadata(storageKey));
      if (!decoded.ok) {
        const removed = outcome(
          await captureFs("remove-artifact", () =>
            fs.rm(metadataPath(storageKey), { force: true }),
          ),
        );
        if (!removed.ok)
          return Result.err(
            new ToolResultArtifactMaintenanceAndCleanupFailure({
              primaryError: decoded.error,
              cleanupError: removed.error,
              message: "Tool result artifact invalidation cleanup failed",
            }),
          );
        removedInvalid += 1;
        continue;
      }
      const metadata = decoded.value.value;
      if (metadata.expiresAt <= now) {
        const removed = outcome(await removeArtifact(metadata));
        if (!removed.ok) return Result.err(removed.error);
        removedExpired += 1;
        continue;
      }
      const content = outcome(await readContent(metadata));
      if (!content.ok) {
        const removed = outcome(await removeArtifact(metadata));
        if (!removed.ok)
          return Result.err(
            new ToolResultArtifactMaintenanceAndCleanupFailure({
              primaryError: content.error,
              cleanupError: removed.error,
              message: "Tool result artifact invalidation cleanup failed",
            }),
          );
        removedInvalid += 1;
      }
    }
    return Result.ok({ removedInvalid, removedExpired });
  }

  return {
    rootDir: resolvedRoot,
    init: () =>
      captureFs("initialize", async () => {
        await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
        const entries = await fs.readdir(resolvedRoot);
        await Promise.all(
          entries
            .filter((entry) => /\.(?:bin|meta|tmp|txt|json)$/u.test(entry))
            .map((entry) => fs.rm(path.join(resolvedRoot, entry), { force: true })),
        );
      }),
    async create(params) {
      const bytes = Buffer.byteLength(params.content, "utf8");
      const valid = outcome(validateHardLimit(bytes, params.maxArtifactBytes));
      if (!valid.ok) return Result.err(valid.error);
      const encrypted = outcome(encrypt(params.content, "write-content"));
      if (!encrypted.ok) return Result.err(encrypted.error);
      const createdAt = Date.now();
      const expiresAt = Math.trunc(createdAt + params.ttlMs);
      return createArtifact(
        params,
        createdAt,
        upload(
          encrypted.value,
          expiresAt,
          () => bytes,
          () => undefined,
        ),
      );
    },
    async createFromFile(params) {
      const configured = outcome(validateHardLimit(0, params.maxArtifactBytes));
      if (!configured.ok) return Result.err(configured.error);
      const stated = outcome(await captureFs("write-content", () => fs.stat(params.sourcePath)));
      if (!stated.ok) return Result.err(stated.error);
      const valid = outcome(validateHardLimit(stated.value.size, params.maxArtifactBytes));
      if (!valid.ok) return Result.err(valid.error);
      const state: { bytes: number; tooLarge?: ToolResultArtifactTooLargeError } = { bytes: 0 };
      const source = encryptedStream(
        createReadStream(params.sourcePath),
        params.maxArtifactBytes,
        state,
        encryptionKey,
      );
      const createdAt = Date.now();
      const expiresAt = Math.trunc(createdAt + params.ttlMs);
      return createArtifact(
        params,
        createdAt,
        upload(
          source,
          expiresAt,
          () => state.bytes,
          () => state.tooLarge,
        ),
      );
    },
    async createFromStream(params) {
      const valid = outcome(validateHardLimit(0, params.maxArtifactBytes));
      if (!valid.ok) return Result.err(valid.error);
      const state: { bytes: number; tooLarge?: ToolResultArtifactTooLargeError } = { bytes: 0 };
      const source = encryptedStream(params.source, params.maxArtifactBytes, state, encryptionKey);
      const createdAt = Date.now();
      const expiresAt = Math.trunc(createdAt + params.ttlMs);
      return createArtifact(
        params,
        createdAt,
        upload(
          source,
          expiresAt,
          () => state.bytes,
          () => state.tooLarge,
        ),
      );
    },
    read(uri, owner, options = {}) {
      const validOptions = outcome(validateReadOptions(options));
      if (!validOptions.ok) return Promise.resolve(Result.err(validOptions.error));
      if (options.signal?.aborted) return Promise.resolve(Result.err(cancelledRead()));
      return exclusive(async () => {
        const metadata = outcome(await find(uri, owner));
        if (!metadata.ok) return Result.err(metadata.error);
        if (options.maxBytes !== undefined && metadata.value.bytes > options.maxBytes) {
          return Result.err(
            new ToolResultArtifactReadTooLarge({
              maxBytes: options.maxBytes,
              actualBytes: metadata.value.bytes,
              message: `Tool result artifact exceeds the ${options.maxBytes}-byte read limit`,
            }),
          );
        }
        const content = outcome(await readContent(metadata.value, options.signal));
        if (!content.ok) return Result.err(content.error);
        return Result.ok({
          content: content.value,
          id: metadata.value.id,
          bytes: metadata.value.bytes,
          createdAt: metadata.value.createdAt,
          expiresAt: metadata.value.expiresAt,
        });
      });
    },
    readWindow(uri, owner, options) {
      if (
        options.maxOutputBytes !== undefined &&
        Number.isFinite(options.maxOutputBytes) &&
        Math.floor(options.maxOutputBytes) < 4
      ) {
        return Promise.resolve(
          Result.err(
            new ToolResultArtifactInvalidInput({
              message:
                "Tool result artifact maxOutputBytes must be at least 4 to fit one Unicode character",
            }),
          ),
        );
      }
      return exclusive(async () => {
        const metadata = outcome(await find(uri, owner));
        if (!metadata.ok) return Result.err(metadata.error);
        const content = outcome(await readContent(metadata.value));
        if (!content.ok) return Result.err(content.error);
        return Result.ok({
          ...selectWindow(
            content.value,
            options.start,
            options.maxCharacters,
            options.maxLines,
            options.maxOutputBytes,
          ),
          id: metadata.value.id,
          bytes: metadata.value.bytes,
          createdAt: metadata.value.createdAt,
          expiresAt: metadata.value.expiresAt,
        });
      });
    },
    maintain: (now = Date.now()) => exclusive(() => maintainUnlocked(now)),
  };
}
