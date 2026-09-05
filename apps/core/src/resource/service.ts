import { randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { extname, join } from "node:path";

import {
  BlobIntegrityFailure,
  BlobObjectAbsent,
  BlobObjectExpired,
  BlobReadCancelled,
  BlobUploadFailed,
  type BlobRead,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  createResourceId,
  DEFAULT_RESOURCE_LIMITS,
  formatResourceUri,
  parseResourceUri,
  resourceDescriptorFromRecord,
  type MaterializedResource,
  type RegisterResourceInput,
  type ResourceDescriptor,
  type ResourceId,
  type ResourceLimits,
  type ResourceReadComplete,
  type ResourceCacheV1,
  type ResourceRecordV1,
  type ResourceUri,
} from "./contracts";
import {
  ResourceAlreadyExists,
  ResourceCacheUnavailable,
  ResourceCancelled,
  ResourceIdCollisionExhausted,
  ResourceIntegrityFailure,
  ResourceInvalidUri,
  ResourceNotFound,
  ResourceOriginUnavailable,
  ResourceStoreFailure,
  ResourceTooLarge,
  ResourceUnsupportedClassification,
  ResourceWriteFailed,
  type ResourceAccessError,
  type ResourceRegistrationError,
} from "./errors";
import {
  classifyResourcePrefix,
  createUtf8ResourceValidator,
  type ResourceClassification,
} from "./resource-mime";
import type { ResourceOriginAdapterRegistry } from "./origin";
import type { ResourceCacheAttachDecision, ResourceStore } from "./store";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import { captureError } from "../shared/error-capture";

export type VerifiedResourceRead = {
  readonly descriptor: ResourceDescriptor;
  readonly classification: ResourceClassification;
  readonly blob: BlobRefV1;
  readonly stream: ReadableStream<Uint8Array>;
  readonly completion: Promise<ResultType<ResourceReadComplete, ResourceAccessError>>;
};

export type ResourceOpenOptions = {
  readonly maxBytes: number;
  readonly expected?: "text" | "image" | "pdf" | "any";
  readonly signal?: AbortSignal;
};

export type ResourceMaterializeOptions = {
  readonly targetDirectory: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
};

export interface ResourceRegistry {
  register(
    input: RegisterResourceInput,
  ): Promise<ResultType<ResourceDescriptor, ResourceRegistrationError>>;
}

export interface ResourceAccess {
  describe(uri: string): ResultType<ResourceDescriptor, ResourceAccessError>;
  open(
    uri: string,
    options: ResourceOpenOptions,
  ): Promise<ResultType<VerifiedResourceRead, ResourceAccessError>>;
  materialize(
    uri: string,
    options: ResourceMaterializeOptions,
  ): Promise<ResultType<MaterializedResource, ResourceAccessError>>;
}

export type ResourceMaintenanceSummary = {
  readonly inspected: number;
  readonly deleted: number;
  readonly retained: number;
  readonly changed: number;
  readonly failed: number;
};

export type ResourceServiceLogger = {
  debug(message: string, context: Readonly<Record<string, unknown>>): void;
  error(message: string, context: Readonly<Record<string, unknown>>): void;
};

export type ResourceFetch = (url: URL, init: BunFetchRequestInit) => Promise<Response>;

export type ResourceServiceDependencies = {
  readonly store: ResourceStore;
  readonly blobStore: BlobStore;
  readonly originAdapters: ResourceOriginAdapterRegistry;
  readonly fetch?: ResourceFetch;
  readonly now?: () => number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly limits?: Partial<ResourceLimits>;
  readonly logger?: ResourceServiceLogger;
};

type OpenedRecord = {
  readonly record: ResourceRecordV1;
  readonly read: BlobRead;
  readonly cachedReference?: ResourceCacheV1;
};

type ResourceFillParticipant = {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly cancel?: () => void;
  readonly controls: {
    readonly promise: Promise<ResultType<ResourceCacheV1, ResourceAccessError>>;
    readonly resolve: (result: ResultType<ResourceCacheV1, ResourceAccessError>) => void;
    readonly reject: (cause: Error | Panic) => void;
  };
};

type ActiveResourceFill = {
  readonly record: ResourceRecordV1;
  readonly abortController: AbortController;
  readonly participants: Map<symbol, ResourceFillParticipant>;
  readonly task: Promise<ResultType<ResourceCacheV1, ResourceAccessError>>;
  observedBytes: number;
  responseByteLength?: number;
  accepting: boolean;
};

type PrefixRead = {
  readonly chunks: readonly Uint8Array[];
  readonly remainder?: Uint8Array;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
};

type ResourceCapturedFailure = {
  readonly cause: Error | Panic;
};

type ResourceFileOpenFailure = ResourceCapturedFailure & {
  readonly kind: "already_exists" | "io";
};

type ResourceOriginDownloadDecision =
  | { readonly kind: "blob"; readonly blob: BlobRefV1 }
  | { readonly kind: "error"; readonly error: ResourceAccessError }
  | { readonly kind: "panic"; readonly panic: Panic };

type ResourceOriginDownloadAttemptDecision =
  | ResourceOriginDownloadDecision
  | {
      readonly kind: "retry";
      readonly phase: "fetch" | "stream";
      readonly terminalError: ResourceAccessError;
    };

const RESOURCE_ID_COLLISION_ATTEMPTS = 8;
const RESOURCE_REGISTRATION_RESERVATION_MS = 60_000;
const RESOURCE_ORIGIN_DOWNLOAD_ATTEMPTS = 2;
const RESOURCE_ORIGIN_IDLE_TIMEOUT_MS = 15_000;
const RESOURCE_ORIGIN_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

function normalizeMediaType(value: string | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function resourceUri(record: ResourceRecordV1): ResourceUri {
  return formatResourceUri(record.resourceId);
}

function storeAccessFailure(uri: string, operation: string): ResourceCacheUnavailable {
  return new ResourceCacheUnavailable({
    uri,
    retryable: true,
    message: `Resource ${operation} is unavailable`,
  });
}

function validateMaxBytes(uri: string, maxBytes: number): ResultType<number, ResourceTooLarge> {
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0) return Result.ok(maxBytes);
  return Result.err(
    new ResourceTooLarge({
      uri,
      limit: 0,
      limitKind: "operation",
      message: "Resource operation byte limit must be a positive safe integer",
    }),
  );
}

function reportedSizeFailure(input: {
  readonly uri: string;
  readonly reportedBytes: number | undefined;
  readonly maxBytes: number;
  readonly resourceMaxBytes: number;
}): ResourceTooLarge | null {
  if (input.reportedBytes === undefined) return null;
  const limit = Math.min(input.maxBytes, input.resourceMaxBytes);
  if (input.reportedBytes <= limit) return null;
  return new ResourceTooLarge({
    uri: input.uri,
    limit,
    limitKind: input.maxBytes < input.resourceMaxBytes ? "operation" : "resource",
    reportedBytes: input.reportedBytes,
    message: `Resource exceeds the ${limit}-byte limit`,
  });
}

function classificationMediaType(classification: ResourceClassification): string | undefined {
  return classification.mediaType;
}

function classificationMatches(
  classification: ResourceClassification,
  expected: ResourceOpenOptions["expected"],
): boolean {
  return expected === undefined || expected === "any" || classification.kind === expected;
}

function captureResourceFailure(cause: unknown): ResourceCapturedFailure {
  if (Panic.is(cause)) return { cause };
  return {
    cause: captureError(cause, "Resource external operation failed").cause,
  };
}

function captureResourceFileOpenFailure(cause: unknown): ResourceFileOpenFailure {
  const kind =
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST"
      ? "already_exists"
      : "io";
  return { ...captureResourceFailure(cause), kind };
}

function mapBlobReadTerminalError(uri: string, error: BlobReadTerminalError): ResourceAccessError {
  if (error instanceof BlobReadCancelled) {
    return new ResourceCancelled({
      uri,
      message: "Resource read was cancelled",
    });
  }
  return new ResourceIntegrityFailure({
    uri,
    reason: "terminal_verification_failed",
    message: "Resource bytes failed terminal verification",
  });
}

function safeMaterializedFilename(record: ResourceRecordV1): string {
  const candidate = record.filename;
  if (candidate !== undefined) {
    const byteLength = Buffer.byteLength(candidate, "utf8");
    const invalid =
      candidate === "." ||
      candidate === ".." ||
      candidate.includes("/") ||
      candidate.includes("\\") ||
      /\p{Cc}/u.test(candidate) ||
      byteLength === 0 ||
      byteLength > 255;
    if (!invalid) return candidate;
  }
  const originalExtension = candidate ? extname(candidate).toLowerCase() : "";
  const extension = /^[.][a-z0-9]{1,12}$/u.test(originalExtension)
    ? originalExtension
    : extensionForMediaType(record.detectedMediaType ?? record.declaredMediaType);
  return `resource-${record.resourceId.slice(3, 11)}${extension}`;
}

function extensionForMediaType(mediaType: string | undefined): string {
  switch (mediaType) {
    case "application/pdf":
      return ".pdf";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

export class CoreResourceService implements ResourceRegistry, ResourceAccess {
  readonly #store: ResourceStore;
  readonly #blobStore: BlobStore;
  readonly #originAdapters: ResourceOriginAdapterRegistry;
  readonly #fetch: ResourceFetch;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #limits: ResourceLimits;
  readonly #logger?: ResourceServiceLogger;
  readonly #fills = new Map<ResourceId, ActiveResourceFill>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #registrationReservations = new Map<ResourceId, number>();
  #closed = false;

  constructor(dependencies: ResourceServiceDependencies) {
    this.#store = dependencies.store;
    this.#blobStore = dependencies.blobStore;
    this.#originAdapters = dependencies.originAdapters;
    this.#fetch = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#now = dependencies.now ?? Date.now;
    this.#randomBytes = dependencies.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.#limits = { ...DEFAULT_RESOURCE_LIMITS, ...dependencies.limits };
    this.#logger = dependencies.logger;
  }

  async register(
    input: RegisterResourceInput,
  ): Promise<ResultType<ResourceDescriptor, ResourceRegistrationError>> {
    const declaredMediaType = normalizeMediaType(input.declaredMediaType);
    const registeredAt = this.#now();
    for (let attempt = 0; attempt < RESOURCE_ID_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateResourceId = createResourceId(this.#randomBytes);
      const registered = this.#store.registerOrGet({
        candidateResourceId,
        origin: input.origin,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
        ...(input.reportedByteLength === undefined
          ? {}
          : { reportedByteLength: input.reportedByteLength }),
        createdAt: registeredAt,
      });
      const decision = registered.match<
        | {
            readonly kind: "value";
            readonly value: ReturnType<ResourceStore["registerOrGet"]> extends ResultType<
              infer T,
              unknown
            >
              ? T
              : never;
          }
        | { readonly kind: "error"; readonly error: ResourceStoreFailure }
      >({
        ok: (value) => ({ kind: "value", value }),
        err: (error) => ({ kind: "error", error }),
      });
      if (decision.kind === "error") return Result.err(decision.error);
      if (decision.value.kind === "collision") continue;
      this.#registrationReservations.set(decision.value.record.resourceId, registeredAt);
      this.#scheduleEagerFill(decision.value.record);
      return Result.ok(resourceDescriptorFromRecord(decision.value.record));
    }
    return Result.err(
      new ResourceIdCollisionExhausted({
        attempts: RESOURCE_ID_COLLISION_ATTEMPTS,
        message: "Could not allocate a unique resource identifier",
      }),
    );
  }

  describe(uri: string): ResultType<ResourceDescriptor, ResourceAccessError> {
    const parsed = parseResourceUri(uri);
    const parsedDecision = parsed.match<
      | { readonly kind: "id"; readonly id: ResourceId }
      | { readonly kind: "error"; readonly error: ResourceInvalidUri }
    >({
      ok: (id) => ({ kind: "id", id }),
      err: (error) => ({ kind: "error", error }),
    });
    if (parsedDecision.kind === "error") return Result.err(parsedDecision.error);
    const loaded = this.#store.getRetained(parsedDecision.id);
    return loaded.match<ResultType<ResourceDescriptor, ResourceAccessError>>({
      ok: (record) =>
        record === null
          ? Result.err(
              new ResourceNotFound({
                uri,
                message: "Resource is not retained",
              }),
            )
          : Result.ok(resourceDescriptorFromRecord(record)),
      err: () => Result.err(storeAccessFailure(uri, "lookup")),
    });
  }

  async open(
    uri: string,
    options: ResourceOpenOptions,
  ): Promise<ResultType<VerifiedResourceRead, ResourceAccessError>> {
    const parsed = parseResourceUri(uri);
    const parsedDecision = parsed.match<
      | { readonly kind: "id"; readonly id: ResourceId }
      | { readonly kind: "error"; readonly error: ResourceInvalidUri }
    >({
      ok: (id) => ({ kind: "id", id }),
      err: (error) => ({ kind: "error", error }),
    });
    if (parsedDecision.kind === "error") return Result.err(parsedDecision.error);
    const maxBytesResult = validateMaxBytes(uri, options.maxBytes);
    const maxBytesDecision = maxBytesResult.match<
      | { readonly kind: "value"; readonly value: number }
      | { readonly kind: "error"; readonly error: ResourceTooLarge }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (maxBytesDecision.kind === "error") return Result.err(maxBytesDecision.error);
    if (options.signal?.aborted)
      return Result.err(
        new ResourceCancelled({
          uri,
          message: "Resource operation was cancelled",
        }),
      );

    const loaded = this.#store.getRetained(parsedDecision.id);
    const recordDecision = loaded.match<
      | { readonly kind: "record"; readonly record: ResourceRecordV1 | null }
      | { readonly kind: "error" }
    >({
      ok: (record) => ({ kind: "record", record }),
      err: () => ({ kind: "error" }),
    });
    if (recordDecision.kind === "error") return Result.err(storeAccessFailure(uri, "lookup"));
    if (recordDecision.record === null)
      return Result.err(new ResourceNotFound({ uri, message: "Resource is not retained" }));
    const record = recordDecision.record;

    const opened = await this.#openRecord(record, maxBytesDecision.value, options.signal);
    const openedDecision = opened.match<
      | { readonly kind: "value"; readonly value: OpenedRecord }
      | { readonly kind: "error"; readonly error: ResourceAccessError }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (openedDecision.kind === "error") return Result.err(openedDecision.error);
    return this.#classifyOpened(openedDecision.value, options);
  }

  async materialize(
    uri: string,
    options: ResourceMaterializeOptions,
  ): Promise<ResultType<MaterializedResource, ResourceAccessError>> {
    const opened = await this.open(uri, {
      maxBytes: options.maxBytes,
      expected: "any",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const openedDecision = opened.match<
      | { readonly kind: "value"; readonly value: VerifiedResourceRead }
      | { readonly kind: "error"; readonly error: ResourceAccessError }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (openedDecision.kind === "error") return Result.err(openedDecision.error);
    const read = openedDecision.value;
    const parsed = parseResourceUri(uri);
    const id = parsed.match({ ok: (value) => value, err: () => null });
    if (id === null)
      return Result.err(new ResourceInvalidUri({ uri, message: "Resource URI is invalid" }));
    const retained = this.#store.getRetained(id);
    const record = retained.match({ ok: (value) => value, err: () => null });
    if (record === null) {
      await cancelVerifiedResourceRead(read);
      return Result.err(new ResourceNotFound({ uri, message: "Resource is not retained" }));
    }
    const filename = safeMaterializedFilename(record);
    const path = join(options.targetDirectory, filename);
    const openedFile = await Result.tryPromise({
      try: () => fs.open(path, "wx", 0o600),
      catch: captureResourceFileOpenFailure,
    });
    const fileDecision = openedFile.match<
      | {
          readonly kind: "file";
          readonly file: Awaited<ReturnType<typeof fs.open>>;
        }
      | { readonly kind: "error"; readonly failure: ResourceFileOpenFailure }
    >({
      ok: (file) => ({ kind: "file", file }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (fileDecision.kind === "error") {
      await cancelVerifiedResourceRead(read);
      if (Panic.is(fileDecision.failure.cause)) {
        return adaptToolResultToHost(Result.err(fileDecision.failure.cause));
      }
      return fileDecision.failure.kind === "already_exists"
        ? Result.err(
            new ResourceAlreadyExists({
              uri,
              path,
              message: "Materialization destination already exists",
            }),
          )
        : Result.err(
            new ResourceWriteFailed({
              uri,
              path,
              message: "Could not create materialization destination",
            }),
          );
    }

    const written = await this.#writeMaterializedFile({
      uri,
      path,
      read,
      file: fileDecision.file,
      signal: options.signal,
    });
    const writtenDecision = written.match<
      | { readonly kind: "value"; readonly value: ResourceReadComplete }
      | { readonly kind: "error"; readonly error: ResourceAccessError }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (writtenDecision.kind === "error") return Result.err(writtenDecision.error);
    return Result.ok({
      uri: read.descriptor.uri,
      path,
      filename,
      ...(classificationMediaType(read.classification) === undefined
        ? {}
        : { mimeType: classificationMediaType(read.classification) }),
      bytes: writtenDecision.value.byteLength,
      sha256: writtenDecision.value.sha256,
    });
  }

  async maintain(input: {
    readonly limit: number;
  }): Promise<ResultType<ResourceMaintenanceSummary, ResourceStoreFailure>> {
    const now = this.#now();
    const pruned = this.#pruneRegistrationReservations(now);
    const pruneError = pruned.match({ ok: () => null, err: (error) => error });
    if (pruneError !== null) return Result.err(pruneError);
    const listed = this.#store.listUnretained(input);
    const listDecision = listed.match<
      | { readonly kind: "value"; readonly value: readonly ResourceRecordV1[] }
      | { readonly kind: "error"; readonly error: ResourceStoreFailure }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (error) => ({ kind: "error", error }),
    });
    if (listDecision.kind === "error") return Result.err(listDecision.error);
    let deleted = 0;
    let retained = 0;
    let changed = 0;
    let failed = 0;
    for (const record of listDecision.value) {
      const reservedAt = this.#registrationReservations.get(record.resourceId);
      if (reservedAt !== undefined && now - reservedAt < RESOURCE_REGISTRATION_RESERVATION_MS) {
        continue;
      }
      this.#registrationReservations.delete(record.resourceId);
      if (record.cache !== undefined) {
        const removed = await this.#blobStore.delete(record.cache.blob);
        const removalFailed = removed.match({
          ok: () => false,
          err: () => true,
        });
        if (removalFailed) {
          failed += 1;
          continue;
        }
      }
      const finalized = this.#store.finalizeUnretained({
        resourceId: record.resourceId,
        ...(record.cache === undefined ? {} : { expectedCache: record.cache }),
      });
      const finalDecision = finalized.match<
        | {
            readonly kind: "value";
            readonly value: ReturnType<ResourceStore["finalizeUnretained"]> extends ResultType<
              infer T,
              unknown
            >
              ? T
              : never;
          }
        | { readonly kind: "error"; readonly error: ResourceStoreFailure }
      >({
        ok: (value) => ({ kind: "value", value }),
        err: (error) => ({ kind: "error", error }),
      });
      if (finalDecision.kind === "error") return Result.err(finalDecision.error);
      switch (finalDecision.value.kind) {
        case "deleted":
        case "absent":
          deleted += 1;
          break;
        case "retained":
          retained += 1;
          break;
        case "changed":
          changed += 1;
          break;
      }
    }
    return Result.ok({
      inspected: listDecision.value.length,
      deleted,
      retained,
      changed,
      failed,
    });
  }

  #pruneRegistrationReservations(now: number): ResultType<void, ResourceStoreFailure> {
    for (const [resourceId, reservedAt] of this.#registrationReservations) {
      if (now - reservedAt >= RESOURCE_REGISTRATION_RESERVATION_MS) {
        this.#registrationReservations.delete(resourceId);
        continue;
      }
      const retained = this.#store.getRetained(resourceId);
      const decision = retained.match<
        | { readonly kind: "record"; readonly record: ResourceRecordV1 | null }
        | { readonly kind: "error"; readonly error: ResourceStoreFailure }
      >({
        ok: (record) => ({ kind: "record", record }),
        err: (error) => ({ kind: "error", error }),
      });
      if (decision.kind === "error") return Result.err(decision.error);
      if (decision.record !== null) this.#registrationReservations.delete(resourceId);
    }
    return Result.ok(undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#registrationReservations.clear();
    await Promise.allSettled([
      ...this.#background,
      ...[...this.#fills.values()].map((fill) => fill.task),
    ]);
  }

  #scheduleEagerFill(record: ResourceRecordV1): void {
    if (
      this.#closed ||
      record.cache !== undefined ||
      record.reportedByteLength === undefined ||
      record.reportedByteLength > this.#limits.modelInlineMaxBytes
    )
      return;
    const task = this.#coalescedFill(record, this.#limits.modelInlineMaxBytes, undefined);
    this.#background.add(task);
    void this.#settleBackgroundFill(record, task);
  }

  async #settleBackgroundFill(record: ResourceRecordV1, task: Promise<unknown>): Promise<void> {
    const captured = await Result.tryPromise({
      try: () => task,
      catch: captureResourceFailure,
    });
    this.#background.delete(task);
    const failure = captured.match({ ok: () => null, err: (error) => error });
    if (failure === null) return;
    if (Panic.is(failure.cause)) return adaptToolResultToHost(Result.err(failure.cause));
    this.#logger?.error("resource eager cache fill crashed", {
      uri: resourceUri(record),
      errorClass: failure.cause.name,
    });
  }

  async #openRecord(
    record: ResourceRecordV1,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ResultType<OpenedRecord, ResourceAccessError>> {
    const uri = resourceUri(record);
    let recordForFill = record;
    if (record.cache !== undefined) {
      const cacheSizeFailure = reportedSizeFailure({
        uri,
        reportedBytes: record.cache.blob.byteLength,
        maxBytes,
        resourceMaxBytes: this.#limits.maxBytes,
      });
      if (cacheSizeFailure) return Result.err(cacheSizeFailure);
      const opened = await this.#blobStore.open(record.cache.blob);
      const decision = opened.match<
        | { readonly kind: "read"; readonly read: BlobRead }
        | { readonly kind: "error"; readonly error: BlobReadError }
      >({
        ok: (read) => ({ kind: "read", read }),
        err: (error) => ({ kind: "error", error }),
      });
      if (decision.kind === "read") {
        return Result.ok({
          record,
          read: decision.read,
          cachedReference: record.cache,
        });
      }
      const canRefill =
        decision.error instanceof BlobObjectAbsent ||
        decision.error instanceof BlobObjectExpired ||
        decision.error instanceof BlobIntegrityFailure;
      if (!canRefill) return Result.err(storeAccessFailure(uri, "cache"));
      if (!(decision.error instanceof BlobObjectAbsent)) {
        const removed = await this.#blobStore.delete(record.cache.blob);
        const removalFailed = removed.match({
          ok: () => false,
          err: () => true,
        });
        if (removalFailed) return Result.err(storeAccessFailure(uri, "stale cache cleanup"));
      }
      const cleared = this.#store.clearCache({
        resourceId: record.resourceId,
        expected: record.cache,
      });
      const clearFailed = cleared.match({ ok: () => false, err: () => true });
      if (clearFailed) return Result.err(storeAccessFailure(uri, "cache repair"));
      const { cache: _cache, ...uncachedRecord } = record;
      recordForFill = uncachedRecord;
    }
    const filled = await this.#coalescedFill(recordForFill, maxBytes, signal);
    const fillDecision = filled.match<
      | { readonly kind: "cache"; readonly cache: ResourceCacheV1 }
      | { readonly kind: "error"; readonly error: ResourceAccessError }
    >({
      ok: (cache) => ({ kind: "cache", cache }),
      err: (error) => ({ kind: "error", error }),
    });
    if (fillDecision.kind === "error") return Result.err(fillDecision.error);
    const opened = await this.#blobStore.open(fillDecision.cache.blob);
    return opened.match<ResultType<OpenedRecord, ResourceAccessError>>({
      ok: (read) =>
        Result.ok({
          record: {
            ...recordForFill,
            cache: fillDecision.cache,
          },
          read,
          cachedReference: fillDecision.cache,
        }),
      err: () => Result.err(storeAccessFailure(uri, "cache open")),
    });
  }

  async #coalescedFill(
    record: ResourceRecordV1,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ResultType<ResourceCacheV1, ResourceAccessError>> {
    while (true) {
      if (signal?.aborted) {
        return Result.err(
          new ResourceCancelled({
            uri: resourceUri(record),
            message: "Resource operation was cancelled",
          }),
        );
      }
      const existing = this.#fills.get(record.resourceId);
      if (existing !== undefined && !existing.accepting) {
        await this.#awaitSettledFill(existing, signal);
        continue;
      }
      const active = existing ?? this.#startCoalescedFill(record);
      return this.#joinResourceFill(active, maxBytes, signal);
    }
  }

  #startCoalescedFill(record: ResourceRecordV1): ActiveResourceFill {
    let active: ActiveResourceFill;
    const task = Promise.resolve()
      .then(() => this.#fillRecord(active))
      .finally(() => {
        active.accepting = false;
      });
    active = {
      record,
      abortController: new AbortController(),
      participants: new Map(),
      task,
      observedBytes: 0,
      accepting: true,
    };
    this.#fills.set(record.resourceId, active);
    void this.#settleCoalescedFill(record.resourceId, active);
    return active;
  }

  #joinResourceFill(
    active: ActiveResourceFill,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ResultType<ResourceCacheV1, ResourceAccessError>> {
    const uri = resourceUri(active.record);
    const observedSizeFailure = reportedSizeFailure({
      uri,
      reportedBytes: active.observedBytes,
      maxBytes,
      resourceMaxBytes: this.#limits.maxBytes,
    });
    if (observedSizeFailure !== null) {
      return Promise.resolve(
        Result.err(
          new ResourceTooLarge({
            uri: observedSizeFailure.uri,
            limit: observedSizeFailure.limit,
            limitKind: observedSizeFailure.limitKind,
            observedBytes: active.observedBytes,
            message: observedSizeFailure.message,
          }),
        ),
      );
    }
    const responseSizeFailure = reportedSizeFailure({
      uri,
      reportedBytes: active.responseByteLength,
      maxBytes,
      resourceMaxBytes: this.#limits.maxBytes,
    });
    if (responseSizeFailure !== null) return Promise.resolve(Result.err(responseSizeFailure));
    const key = Symbol(active.record.resourceId);
    const controls = Promise.withResolvers<ResultType<ResourceCacheV1, ResourceAccessError>>();
    const cancel =
      signal === undefined ? undefined : () => this.#cancelFillParticipant(active, key, uri);
    const participant: ResourceFillParticipant = {
      maxBytes,
      controls,
      ...(signal === undefined ? {} : { signal }),
      ...(cancel === undefined ? {} : { cancel }),
    };
    active.participants.set(key, participant);
    if (cancel !== undefined) signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) this.#cancelFillParticipant(active, key, uri);
    return controls.promise;
  }

  async #awaitSettledFill(
    active: ActiveResourceFill,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal === undefined) {
      await active.task;
      return;
    }
    const cancelled = Promise.withResolvers<void>();
    const cancel = () => cancelled.resolve();
    signal.addEventListener("abort", cancel, { once: true });
    await Promise.race([active.task.then(() => undefined), cancelled.promise]);
    signal.removeEventListener("abort", cancel);
  }

  #cancelFillParticipant(active: ActiveResourceFill, key: symbol, uri: ResourceUri): void {
    this.#settleFillParticipant(
      active,
      key,
      Result.err(
        new ResourceCancelled({
          uri,
          message: "Resource operation was cancelled",
        }),
      ),
    );
    this.#abortUnobservedFill(active);
  }

  #settleFillParticipant(
    active: ActiveResourceFill,
    key: symbol,
    result: ResultType<ResourceCacheV1, ResourceAccessError>,
  ): void {
    const participant = active.participants.get(key);
    if (participant === undefined) return;
    active.participants.delete(key);
    if (participant.signal !== undefined && participant.cancel !== undefined) {
      participant.signal.removeEventListener("abort", participant.cancel);
    }
    participant.controls.resolve(result);
  }

  #abortUnobservedFill(active: ActiveResourceFill): void {
    if (active.participants.size > 0 || !active.accepting) return;
    active.accepting = false;
    active.abortController.abort();
  }

  #rejectOversizedParticipants(
    active: ActiveResourceFill,
    bytes: number,
    kind: "response" | "observed",
  ): ResourceTooLarge | null {
    let lastFailure: ResourceTooLarge | null = null;
    for (const [key, participant] of active.participants) {
      const failure = reportedSizeFailure({
        uri: resourceUri(active.record),
        reportedBytes: bytes,
        maxBytes: participant.maxBytes,
        resourceMaxBytes: this.#limits.maxBytes,
      });
      if (failure === null) continue;
      lastFailure =
        kind === "response"
          ? failure
          : new ResourceTooLarge({
              uri: failure.uri,
              limit: failure.limit,
              limitKind: failure.limitKind,
              observedBytes: bytes,
              message: failure.message,
            });
      this.#settleFillParticipant(active, key, Result.err(lastFailure));
    }
    this.#abortUnobservedFill(active);
    return lastFailure;
  }

  async #settleCoalescedFill(resourceId: ResourceId, active: ActiveResourceFill): Promise<void> {
    const captured = await Result.tryPromise({
      try: () => active.task,
      catch: captureResourceFailure,
    });
    if (this.#fills.get(resourceId) === active) this.#fills.delete(resourceId);
    const decision = captured.match<
      | {
          readonly kind: "result";
          readonly result: ResultType<ResourceCacheV1, ResourceAccessError>;
        }
      | { readonly kind: "failure"; readonly failure: ResourceCapturedFailure }
    >({
      ok: (result) => ({ kind: "result", result }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (decision.kind === "result") {
      for (const key of active.participants.keys()) {
        this.#settleFillParticipant(active, key, decision.result);
      }
      return;
    }
    for (const participant of active.participants.values()) {
      if (participant.signal !== undefined && participant.cancel !== undefined) {
        participant.signal.removeEventListener("abort", participant.cancel);
      }
      participant.controls.reject(decision.failure.cause);
    }
    active.participants.clear();
    if (Panic.is(decision.failure.cause)) {
      return adaptToolResultToHost(Result.err(decision.failure.cause));
    }
    return adaptToolResultToHost(
      Result.err(
        new Panic({
          message: "Resource cache fill rejected",
          cause: decision.failure.cause,
        }),
      ),
    );
  }

  async #fillRecord(
    active: ActiveResourceFill,
  ): Promise<ResultType<ResourceCacheV1, ResourceAccessError>> {
    const record = active.record;
    const uri = resourceUri(record);
    if (this.#closed)
      return Result.err(
        new ResourceCacheUnavailable({
          uri,
          retryable: true,
          message: "Resource service is closed",
        }),
      );
    const resolved = await this.#originAdapters.resolve({
      record,
      signal: active.abortController.signal,
    });
    const originDecision = resolved.match<
      | {
          readonly kind: "origin";
          readonly origin: Awaited<
            ReturnType<ResourceOriginAdapterRegistry["resolve"]>
          > extends ResultType<infer T, unknown>
            ? T
            : never;
        }
      | { readonly kind: "error"; readonly error: ResourceOriginUnavailable }
    >({
      ok: (origin) => ({ kind: "origin", origin }),
      err: (error) => ({ kind: "error", error }),
    });
    if (originDecision.kind === "error") return Result.err(originDecision.error);
    const downloaded = await this.#downloadOrigin(active, originDecision.origin.url, uri);
    if (downloaded.kind === "error") return Result.err(downloaded.error);
    if (downloaded.kind === "panic") {
      return adaptToolResultToHost(Result.err(downloaded.panic));
    }
    const blob = downloaded.blob;
    const next = { blob, cachedAt: this.#now() };
    if (active.participants.size === 0) {
      const removed = await this.#blobStore.delete(blob);
      const removalFailed = removed.match({ ok: () => false, err: () => true });
      if (removalFailed) return Result.err(storeAccessFailure(uri, "abandoned cache cleanup"));
      return Result.err(
        new ResourceCancelled({
          uri,
          message: "Resource cache fill has no active callers",
        }),
      );
    }
    const attached = this.#store.compareAndSwapCache({
      resourceId: record.resourceId,
      ...(record.cache === undefined ? {} : { expected: record.cache }),
      next,
    });
    const attachDecision = attached.match<
      | { readonly kind: "value"; readonly value: ResourceCacheAttachDecision }
      | { readonly kind: "error" }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: () => ({ kind: "error" }),
    });
    if (attachDecision.kind === "error") {
      const removed = await this.#blobStore.delete(blob);
      const removalFailed = removed.match({ ok: () => false, err: () => true });
      if (removalFailed) {
        return Result.err(storeAccessFailure(uri, "duplicate cache cleanup"));
      }
      return Result.err(storeAccessFailure(uri, "cache publication"));
    }
    if (attachDecision.value.kind === "attached") return Result.ok(next);
    const removed = await this.#blobStore.delete(blob);
    const removalFailed = removed.match({ ok: () => false, err: () => true });
    if (removalFailed) {
      return Result.err(storeAccessFailure(uri, "duplicate cache cleanup"));
    }
    const winning = attachDecision.value.record?.cache;
    return winning === undefined
      ? Result.err(
          new ResourceNotFound({
            uri,
            message: "Resource is no longer retained",
          }),
        )
      : Result.ok(winning);
  }

  async #downloadOrigin(
    active: ActiveResourceFill,
    url: URL,
    uri: ResourceUri,
  ): Promise<ResourceOriginDownloadDecision> {
    for (let attempt = 0; attempt < RESOURCE_ORIGIN_DOWNLOAD_ATTEMPTS; attempt += 1) {
      active.observedBytes = 0;
      delete active.responseByteLength;
      const decision = await this.#downloadOriginAttempt(active, url, uri, attempt > 0);
      if (decision.kind !== "retry") return decision;
      if (this.#shouldRetryOriginDownload(active, attempt, uri, decision.phase)) continue;
      return { kind: "error", error: decision.terminalError };
    }
    return {
      kind: "error",
      error: new ResourceOriginUnavailable({
        uri,
        retryable: true,
        message: "Resource origin download failed",
      }),
    };
  }

  #shouldRetryOriginDownload(
    active: ActiveResourceFill,
    attempt: number,
    uri: ResourceUri,
    phase: "fetch" | "stream",
  ): boolean {
    if (attempt + 1 >= RESOURCE_ORIGIN_DOWNLOAD_ATTEMPTS) return false;
    if (active.participants.size === 0 || active.abortController.signal.aborted) return false;
    this.#logger?.debug("resource origin download retrying", { uri, phase });
    return true;
  }

  async #downloadOriginAttempt(
    active: ActiveResourceFill,
    url: URL,
    uri: ResourceUri,
    freshConnection: boolean,
  ): Promise<ResourceOriginDownloadAttemptDecision> {
    const signal = AbortSignal.any([
      active.abortController.signal,
      AbortSignal.timeout(RESOURCE_ORIGIN_ATTEMPT_TIMEOUT_MS),
    ]);
    const fetched = await Result.tryPromise({
      try: () =>
        this.#fetch(url, {
          redirect: "follow",
          signal,
          timeout: RESOURCE_ORIGIN_IDLE_TIMEOUT_MS,
          ...(freshConnection ? { keepalive: false } : {}),
        }),
      catch: captureResourceFailure,
    });
    const responseDecision = fetched.match<
      | { readonly kind: "response"; readonly response: Response }
      | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
    >({
      ok: (response) => ({ kind: "response", response }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (responseDecision.kind === "error") {
      return this.#originFetchFailureDecision(responseDecision.failure, uri);
    }
    const response = responseDecision.response;
    if (!response.ok || response.body === null) {
      return this.#rejectUnreadableOriginResponse(response, uri);
    }
    const responseSizeFailure = await this.#applyOriginResponseSize(active, response);
    if (responseSizeFailure !== null) return { kind: "error", error: responseSizeFailure };

    let streamFailure: ResourceTooLarge | null = null;
    const sourceReader = response.body.getReader();
    const limitedSource = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await sourceReader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        active.observedBytes += chunk.value.byteLength;
        streamFailure = this.#rejectOversizedParticipants(active, active.observedBytes, "observed");
        if (active.participants.size === 0) {
          controller.error(streamFailure);
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel: async (reason) => sourceReader.cancel(reason),
    });
    const started = await this.#blobStore.startUpload({
      source: limitedSource,
      retention: { kind: "durable" },
    });
    const uploadDecision = started.match<
      | {
          readonly kind: "upload";
          readonly upload: Awaited<ReturnType<BlobStore["startUpload"]>> extends ResultType<
            infer T,
            unknown
          >
            ? T
            : never;
        }
      | { readonly kind: "error" }
    >({
      ok: (upload) => ({ kind: "upload", upload }),
      err: () => ({ kind: "error" }),
    });
    if (uploadDecision.kind === "error") {
      return this.#rejectOriginUploadStart(limitedSource, uri);
    }
    const completed = await uploadDecision.upload.completion;
    const completionDecision = completed.match<
      | { readonly kind: "blob"; readonly blob: BlobRefV1 }
      | { readonly kind: "error"; readonly sourceFailure: boolean }
    >({
      ok: (blob) => ({ kind: "blob", blob }),
      err: (error) => ({
        kind: "error",
        sourceFailure: error instanceof BlobUploadFailed && error.reason === "source",
      }),
    });
    if (completionDecision.kind === "error" && streamFailure !== null) {
      return { kind: "error", error: streamFailure };
    }
    if (completionDecision.kind === "error" && completionDecision.sourceFailure) {
      return {
        kind: "retry",
        phase: "stream",
        terminalError: storeAccessFailure(uri, "cache upload"),
      };
    }
    if (completionDecision.kind === "error") {
      return { kind: "error", error: storeAccessFailure(uri, "cache upload") };
    }
    const blob = completionDecision.blob;
    if (blob.byteLength === active.observedBytes) return { kind: "blob", blob };
    return this.#rejectMismatchedOriginBlob(blob, uri);
  }

  #originFetchFailureDecision(
    failure: ResourceCapturedFailure,
    uri: ResourceUri,
  ): ResourceOriginDownloadAttemptDecision {
    if (Panic.is(failure.cause)) return { kind: "panic", panic: failure.cause };
    return {
      kind: "retry",
      phase: "fetch",
      terminalError: new ResourceOriginUnavailable({
        uri,
        retryable: true,
        message: "Resource origin download failed",
      }),
    };
  }

  async #rejectUnreadableOriginResponse(
    response: Response,
    uri: ResourceUri,
  ): Promise<ResourceOriginDownloadDecision> {
    await response.body?.cancel();
    return {
      kind: "error",
      error: new ResourceOriginUnavailable({
        uri,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        message: "Resource origin did not return readable bytes",
      }),
    };
  }

  async #applyOriginResponseSize(
    active: ActiveResourceFill,
    response: Response,
  ): Promise<ResourceTooLarge | null> {
    const contentLengthValue = response.headers.get("content-length");
    const contentLength =
      contentLengthValue !== null && /^\d+$/u.test(contentLengthValue)
        ? Number(contentLengthValue)
        : undefined;
    if (contentLength === undefined) return null;
    active.responseByteLength = contentLength;
    const failure = this.#rejectOversizedParticipants(active, contentLength, "response");
    if (active.participants.size > 0 || failure === null) return null;
    await response.body?.cancel();
    return failure;
  }

  async #rejectOriginUploadStart(
    source: ReadableStream<Uint8Array>,
    uri: ResourceUri,
  ): Promise<ResourceOriginDownloadDecision> {
    await source.cancel();
    return { kind: "error", error: storeAccessFailure(uri, "cache upload") };
  }

  async #rejectMismatchedOriginBlob(
    blob: BlobRefV1,
    uri: ResourceUri,
  ): Promise<ResourceOriginDownloadDecision> {
    const removed = await this.#blobStore.delete(blob);
    const removalFailed = removed.match({ ok: () => false, err: () => true });
    if (removalFailed) {
      return { kind: "error", error: storeAccessFailure(uri, "invalid cache cleanup") };
    }
    return {
      kind: "error",
      error: new ResourceIntegrityFailure({
        uri,
        reason: "Uploaded byte length does not match streamed bytes",
        message: "Resource cache verification failed",
      }),
    };
  }

  async #classifyOpened(
    opened: OpenedRecord,
    options: ResourceOpenOptions,
  ): Promise<ResultType<VerifiedResourceRead, ResourceAccessError>> {
    const uri = resourceUri(opened.record);
    const prefixResult = await readPrefix(opened.read.stream, this.#limits.sniffBytes);
    const prefixDecision = prefixResult.match<
      | { readonly kind: "value"; readonly value: PrefixRead }
      | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (prefixDecision.kind === "error") {
      if (Panic.is(prefixDecision.failure.cause)) {
        await Result.tryPromise({
          try: () => opened.read.completion,
          catch: captureResourceFailure,
        });
        return adaptToolResultToHost(Result.err(prefixDecision.failure.cause));
      }
      const completion = await opened.read.completion;
      return completion.match<ResultType<VerifiedResourceRead, ResourceAccessError>>({
        ok: () =>
          Result.err(
            new ResourceIntegrityFailure({
              uri,
              reason: "stream_failed",
              message: "Resource stream failed during classification",
            }),
          ),
        err: (error) => Result.err(mapBlobReadTerminalError(uri, error)),
      });
    }
    const prefix = concatenateChunks(prefixDecision.value.chunks);
    const classification = await classifyResourcePrefix({
      prefix,
      ...(opened.record.filename === undefined ? {} : { filename: opened.record.filename }),
    });
    if (!classificationMatches(classification, options.expected)) {
      await prefixDecision.value.reader.cancel();
      await opened.read.completion;
      return Result.err(
        new ResourceUnsupportedClassification({
          uri,
          expected: options.expected ?? "any",
          ...(classification.mediaType === undefined
            ? {}
            : { detectedMediaType: classification.mediaType }),
          message: `Resource is ${classification.kind}, not ${options.expected ?? "the expected type"}`,
        }),
      );
    }
    const detectedMediaType = classificationMediaType(classification);
    if (
      opened.record.detectedMediaType !== undefined &&
      detectedMediaType !== opened.record.detectedMediaType
    ) {
      await prefixDecision.value.reader.cancel();
      await opened.read.completion;
      if (opened.record.cache !== undefined) {
        const removed = await this.#blobStore.delete(opened.record.cache.blob);
        const removalFailed = removed.match({
          ok: () => false,
          err: () => true,
        });
        if (removalFailed) {
          return Result.err(storeAccessFailure(uri, "stale cache cleanup"));
        }
        const cleared = this.#store.clearCache({
          resourceId: opened.record.resourceId,
          expected: opened.record.cache,
        });
        const clearFailed = cleared.match({ ok: () => false, err: () => true });
        if (clearFailed) return Result.err(storeAccessFailure(uri, "stale cache repair"));
      }
      return Result.err(
        new ResourceIntegrityFailure({
          uri,
          reason: "Detected media type changed",
          message: "Resource classification no longer matches its retained record",
        }),
      );
    }
    return Result.ok(
      this.#replayVerifiedRead(
        opened,
        prefixDecision.value,
        classification,
        options.expected === "text",
        options.signal,
      ),
    );
  }

  #replayVerifiedRead(
    opened: OpenedRecord,
    prefix: PrefixRead,
    classification: ResourceClassification,
    validateUtf8: boolean,
    signal: AbortSignal | undefined,
  ): VerifiedResourceRead {
    const uri = resourceUri(opened.record);
    const validationControls = Promise.withResolvers<ResultType<void, ResourceAccessError>>();
    const validator =
      validateUtf8 && classification.kind === "text" ? createUtf8ResourceValidator() : undefined;
    const replay = [
      ...prefix.chunks,
      ...(prefix.remainder === undefined ? [] : [prefix.remainder]),
    ];
    let index = 0;
    let settled = false;
    const settle = (result: ResultType<void, ResourceAccessError>): void => {
      if (settled) return;
      settled = true;
      validationControls.resolve(result);
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (signal?.aborted) {
          const error = new ResourceCancelled({
            uri,
            message: "Resource operation was cancelled",
          });
          settle(Result.err(error));
          await prefix.reader.cancel();
          controller.error(error);
          return;
        }
        const next =
          index < replay.length
            ? { done: false as const, value: replay[index++]! }
            : await prefix.reader.read();
        if (next.done) {
          const validation = validator?.finish() ?? Result.ok(undefined);
          const validationDecision = validation.match<
            { readonly kind: "ok" } | { readonly kind: "error" }
          >({ ok: () => ({ kind: "ok" }), err: () => ({ kind: "error" }) });
          if (validationDecision.kind === "error") {
            const error = new ResourceUnsupportedClassification({
              uri,
              expected: "text",
              detectedMediaType: classification.mediaType,
              message: "Resource text is not valid UTF-8",
            });
            settle(Result.err(error));
            controller.error(error);
            return;
          }
          settle(Result.ok(undefined));
          controller.close();
          return;
        }
        const observed = validator?.observe(next.value) ?? Result.ok(undefined);
        const invalid = observed.match({ ok: () => false, err: () => true });
        if (invalid) {
          const error = new ResourceUnsupportedClassification({
            uri,
            expected: "text",
            detectedMediaType: classification.mediaType,
            message: "Resource text is not valid UTF-8",
          });
          settle(Result.err(error));
          await prefix.reader.cancel();
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      },
      cancel: async () => {
        settle(
          Result.err(
            new ResourceCancelled({
              uri,
              message: "Resource read was cancelled",
            }),
          ),
        );
        await prefix.reader.cancel();
      },
    });
    const completion = this.#completeVerifiedRead(
      opened,
      classification,
      validator !== undefined,
      validationControls.promise,
    );
    return {
      descriptor: resourceDescriptorFromRecord(opened.record),
      classification,
      blob: opened.read.ref,
      stream,
      completion,
    };
  }

  async #completeVerifiedRead(
    opened: OpenedRecord,
    classification: ResourceClassification,
    validatedText: boolean,
    validation: Promise<ResultType<void, ResourceAccessError>>,
  ): Promise<ResultType<ResourceReadComplete, ResourceAccessError>> {
    const uri = resourceUri(opened.record);
    const [blobCompletion, validationResult] = await Promise.all([
      opened.read.completion,
      validation,
    ]);
    const validationError = validationResult.match({
      ok: () => null,
      err: (error) => error,
    });
    if (validationError) return Result.err(validationError);
    const terminal = blobCompletion.match<
      | { readonly kind: "complete"; readonly complete: ResourceReadComplete }
      | { readonly kind: "error"; readonly error: BlobReadTerminalError }
    >({
      ok: (complete) => ({ kind: "complete", complete }),
      err: (error) => ({ kind: "error", error }),
    });
    if (terminal.kind === "error") {
      if (terminal.error instanceof BlobIntegrityFailure && opened.cachedReference !== undefined) {
        const repaired = await this.#repairTerminalCache(opened.record, opened.cachedReference);
        const repairError = repaired.match({
          ok: () => null,
          err: (error) => error,
        });
        if (repairError !== null) {
          this.#logger?.debug("resource terminal cache repair failed", {
            uri,
            errorTag: repairError._tag,
          });
        }
      }
      return Result.err(mapBlobReadTerminalError(uri, terminal.error));
    }
    const detectedMediaType = classificationMediaType(classification);
    if (
      detectedMediaType !== undefined &&
      opened.record.detectedMediaType === undefined &&
      (classification.kind !== "text" || validatedText)
    ) {
      const recorded = this.#store.recordDetectedMediaType({
        resourceId: opened.record.resourceId,
        next: detectedMediaType,
      });
      const failed = recorded.match({ ok: () => false, err: () => true });
      if (failed) return Result.err(storeAccessFailure(uri, "classification persistence"));
    }
    return Result.ok(terminal.complete);
  }

  async #repairTerminalCache(
    record: ResourceRecordV1,
    expected: ResourceCacheV1,
  ): Promise<ResultType<void, ResourceAccessError>> {
    const uri = resourceUri(record);
    const removed = await this.#blobStore.delete(expected.blob);
    const removalFailed = removed.match({ ok: () => false, err: () => true });
    if (removalFailed) return Result.err(storeAccessFailure(uri, "stale cache cleanup"));
    const cleared = this.#store.clearCache({
      resourceId: record.resourceId,
      expected,
    });
    const clearDecision = cleared.match<
      { readonly kind: "cleared"; readonly cleared: boolean } | { readonly kind: "error" }
    >({
      ok: (value) => ({ kind: "cleared", cleared: value }),
      err: () => ({ kind: "error" }),
    });
    if (clearDecision.kind === "error") {
      return Result.err(storeAccessFailure(uri, "stale cache repair"));
    }
    if (!clearDecision.cleared) return Result.ok(undefined);
    const { cache: _cache, ...uncachedRecord } = record;
    return (await this.#coalescedFill(uncachedRecord, this.#limits.maxBytes, undefined)).map(
      () => undefined,
    );
  }

  async #writeMaterializedFile(input: {
    readonly uri: string;
    readonly path: string;
    readonly read: VerifiedResourceRead;
    readonly file: Awaited<ReturnType<typeof fs.open>>;
    readonly signal?: AbortSignal;
  }): Promise<ResultType<ResourceReadComplete, ResourceAccessError>> {
    const reader = input.read.stream.getReader();
    let writeFailure: ResourceAccessError | null = null;
    let done = false;
    while (!done && writeFailure === null) {
      if (input.signal?.aborted) {
        writeFailure = new ResourceCancelled({
          uri: input.uri,
          message: "Resource materialization was cancelled",
        });
        await reader.cancel();
        break;
      }
      const readChunk = await Result.tryPromise({
        try: () => reader.read(),
        catch: captureResourceFailure,
      });
      const chunkDecision = readChunk.match<
        | {
            readonly kind: "chunk";
            readonly chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
          }
        | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
      >({
        ok: (chunk) => ({ kind: "chunk", chunk }),
        err: (failure) => ({ kind: "error", failure }),
      });
      if (chunkDecision.kind === "error") {
        if (Panic.is(chunkDecision.failure.cause)) {
          return adaptToolResultToHost(Result.err(chunkDecision.failure.cause));
        }
        writeFailure = new ResourceWriteFailed({
          uri: input.uri,
          path: input.path,
          message: "Resource stream failed during materialization",
        });
        break;
      }
      if (chunkDecision.chunk.done) {
        done = true;
        break;
      }
      const value = chunkDecision.chunk.value;
      let offset = 0;
      while (offset < value.byteLength && writeFailure === null) {
        const wrote = await Result.tryPromise({
          try: () => input.file.write(value, offset),
          catch: captureResourceFailure,
        });
        const writeDecision = wrote.match<
          | { readonly kind: "written"; readonly bytesWritten: number }
          | {
              readonly kind: "error";
              readonly failure: ResourceCapturedFailure;
            }
        >({
          ok: (value) => ({
            kind: "written",
            bytesWritten: value.bytesWritten,
          }),
          err: (failure) => ({ kind: "error", failure }),
        });
        if (writeDecision.kind === "error") {
          if (Panic.is(writeDecision.failure.cause)) {
            return adaptToolResultToHost(Result.err(writeDecision.failure.cause));
          }
          writeFailure = new ResourceWriteFailed({
            uri: input.uri,
            path: input.path,
            message: "Could not write materialized resource",
          });
          break;
        }
        offset += writeDecision.bytesWritten;
      }
    }
    const closed = await Result.tryPromise({
      try: () => input.file.close(),
      catch: captureResourceFailure,
    });
    const closeDecision = closed.match<
      | { readonly kind: "closed" }
      | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
    >({
      ok: () => ({ kind: "closed" }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (closeDecision.kind === "error" && Panic.is(closeDecision.failure.cause)) {
      return adaptToolResultToHost(Result.err(closeDecision.failure.cause));
    }
    const closeFailed = closeDecision.kind === "error";
    const completion = await input.read.completion;
    const completionError = completion.match({
      ok: () => null,
      err: (error) => error,
    });
    const finalError =
      writeFailure ??
      completionError ??
      (closeFailed
        ? new ResourceWriteFailed({
            uri: input.uri,
            path: input.path,
            message: "Could not close materialized resource",
          })
        : null);
    if (finalError !== null) {
      await Result.tryPromise({
        try: () => fs.unlink(input.path),
        catch: () => undefined,
      });
      return Result.err(finalError);
    }
    return completion;
  }
}

async function readPrefix(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<ResultType<PrefixRead, ResourceCapturedFailure>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (byteLength < maxBytes) {
    const captured = await Result.tryPromise({
      try: () => reader.read(),
      catch: captureResourceFailure,
    });
    const decision = captured.match<
      | {
          readonly kind: "chunk";
          readonly chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        }
      | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
    >({
      ok: (chunk) => ({ kind: "chunk", chunk }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (decision.kind === "error") return Result.err(decision.failure);
    if (decision.chunk.done) break;
    const remaining = maxBytes - byteLength;
    if (decision.chunk.value.byteLength <= remaining) {
      chunks.push(decision.chunk.value);
      byteLength += decision.chunk.value.byteLength;
      continue;
    }
    chunks.push(decision.chunk.value.subarray(0, remaining));
    return Result.ok({
      chunks,
      remainder: decision.chunk.value.subarray(remaining),
      reader,
    });
  }
  return Result.ok({ chunks, reader });
}

function concatenateChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function cancelVerifiedResourceRead(read: VerifiedResourceRead): Promise<void> {
  const cancelled = await Result.tryPromise({
    try: () => read.stream.cancel(),
    catch: captureResourceFailure,
  });
  const panic = cancelled.match({
    ok: () => null,
    err: (failure) => (Panic.is(failure.cause) ? failure.cause : null),
  });
  await read.completion;
  if (panic !== null) return adaptToolResultToHost(Result.err(panic));
}

export async function consumeVerifiedResourceRead(
  read: VerifiedResourceRead,
): Promise<ResultType<Uint8Array, ResourceAccessError>> {
  const reader = read.stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let streamFailed = false;
  let done = false;
  while (!done && !streamFailed) {
    const captured = await Result.tryPromise({
      try: () => reader.read(),
      catch: captureResourceFailure,
    });
    const decision = captured.match<
      | {
          readonly kind: "chunk";
          readonly chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        }
      | { readonly kind: "error"; readonly failure: ResourceCapturedFailure }
    >({
      ok: (chunk) => ({ kind: "chunk", chunk }),
      err: (failure) => ({ kind: "error", failure }),
    });
    if (decision.kind === "error") {
      if (Panic.is(decision.failure.cause)) {
        return adaptToolResultToHost(Result.err(decision.failure.cause));
      }
      streamFailed = true;
      break;
    }
    if (decision.chunk.done) {
      done = true;
      break;
    }
    chunks.push(decision.chunk.value);
    byteLength += decision.chunk.value.byteLength;
  }
  const completed = await read.completion;
  const completionError = completed.match({
    ok: () => null,
    err: (error) => error,
  });
  if (completionError !== null) return Result.err(completionError);
  if (streamFailed) {
    return Result.err(
      new ResourceIntegrityFailure({
        uri: read.descriptor.uri,
        reason: "stream_failed",
        message: "Resource stream failed",
      }),
    );
  }
  return Result.ok(concatenateChunks(chunks));
}
