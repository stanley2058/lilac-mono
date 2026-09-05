import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  blobHandleV1Schema,
  blobRefV1Schema,
  type BlobCloseSummary,
  type BlobHandleV1,
  type BlobLifecycleLogContext,
  type BlobLifecycleLogger,
  type BlobMaintenanceSummary,
  type BlobRead,
  type BlobReadComplete,
  type BlobRefV1,
  type BlobRetention,
  type BlobSource,
  type BlobStore,
  type BlobUpload,
} from "./contracts";
import {
  classifyAdapterCause,
  classifyBlobDefect,
  contentKeyFor,
  expiryIndexKey,
  metadataKey,
  reservationDecisionKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
  signalRetainedBlobPanic,
  temporaryKey,
  type BlobBackend,
  type BlobSink,
  type ClassifiedAdapterCause,
} from "./backend";
import {
  BlobAdapterFailure,
  BlobCloseDeadlineExceeded,
  BlobCloseFailed,
  BlobDeleteFailed,
  BlobIntegrityFailure,
  BlobInvalidInput,
  BlobInvalidReference,
  BlobInvalidRetention,
  BlobMaintenanceFailed,
  BlobObjectAbsent,
  BlobObjectExpired,
  BlobOperationAndCleanupFailed,
  BlobReadCancelled,
  BlobReadSourceFailure,
  BlobResolveTimeout,
  BlobStoreClosed,
  BlobUploadFailed,
  BlobUploadInterrupted,
  BlobUploadReservationFailed,
  type BlobCloseError,
  type BlobDeleteError,
  type BlobMaintenanceError,
  type BlobReadError,
  type BlobReadTerminalError,
  type BlobResolveError,
  type BlobUploadStartError,
  type BlobWriteError,
} from "./errors";

const retentionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("durable") }),
  z.strictObject({
    kind: z.literal("expires"),
    expiresAt: z.number().int().nonnegative().safe().max(8_640_000_000_000_000),
  }),
]);

const stagingExpiresAtSchema = z.number().int().nonnegative().safe().max(8_640_000_000_000_000);

const pendingReservationSchema = z.strictObject({
  version: z.literal(1),
  objectId: z.string(),
  generation: z.string().uuid(),
  state: z.literal("pending"),
  retention: retentionSchema,
  createdAt: z.number().int().nonnegative().safe(),
  stagingExpiresAt: stagingExpiresAtSchema.optional(),
  pendingWrites: z.boolean().optional(),
});
const readyReservationSchema = z.strictObject({
  version: z.literal(1),
  objectId: z.string(),
  generation: z.string().uuid(),
  state: z.literal("ready"),
  retention: retentionSchema,
  createdAt: z.number().int().nonnegative().safe(),
  stagingExpiresAt: stagingExpiresAtSchema.optional(),
  pendingWrites: z.boolean().optional(),
  ref: blobRefV1Schema,
  contentKey: z.string(),
});
const stagedReservationSchema = readyReservationSchema.extend({
  state: z.literal("staged"),
  retention: z.strictObject({ kind: z.literal("durable") }),
  stagingExpiresAt: stagingExpiresAtSchema,
});
const failedReservationSchema = z.strictObject({
  version: z.literal(1),
  objectId: z.string(),
  generation: z.string().uuid(),
  state: z.literal("failed"),
  retention: retentionSchema,
  createdAt: z.number().int().nonnegative().safe(),
  stagingExpiresAt: stagingExpiresAtSchema.optional(),
  pendingWrites: z.boolean().optional(),
  reason: z.enum(["source", "write", "expected_sha256", "expected_byte_length", "fenced"]),
});
const interruptedReservationSchema = z.strictObject({
  version: z.literal(1),
  objectId: z.string(),
  generation: z.string().uuid(),
  state: z.literal("interrupted"),
  retention: retentionSchema,
  createdAt: z.number().int().nonnegative().safe(),
  stagingExpiresAt: stagingExpiresAtSchema.optional(),
  pendingWrites: z.boolean().optional(),
});
const deletedReservationSchema = z.strictObject({
  version: z.literal(1),
  objectId: z.string(),
  generation: z.string().uuid(),
  state: z.literal("deleted"),
  retention: retentionSchema,
  createdAt: z.number().int().nonnegative().safe(),
  stagingExpiresAt: stagingExpiresAtSchema.optional(),
  pendingWrites: z.boolean().optional(),
});
const reservationSchema = z.discriminatedUnion("state", [
  pendingReservationSchema,
  readyReservationSchema,
  stagedReservationSchema,
  failedReservationSchema,
  interruptedReservationSchema,
  deletedReservationSchema,
]);

type Reservation = z.infer<typeof reservationSchema>;
type PendingReservation = z.infer<typeof pendingReservationSchema>;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (panic: Panic) => void;
};

type ActiveUpload = {
  readonly reservation: PendingReservation;
  readonly source: BlobSource;
  readonly expectedSha256?: string;
  readonly expectedByteLength?: number;
  readonly abortController: AbortController;
  readonly completion: Deferred<ResultType<BlobRefV1, BlobWriteError>>;
  readonly reservationCreated: Promise<ResultType<void, BlobAdapterFailure>>;
  phase: "reserving" | "uploading" | "completed" | "interrupted" | "deleted";
  observedByteLength?: number;
  contentWritesSettled?: boolean;
  sink?: BlobSink;
  readyPublication?: Promise<ResultType<boolean, BlobAdapterFailure>>;
};

type ReadOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function deferred<T>(): Deferred<T> {
  const controls = Promise.withResolvers<T>();
  return {
    promise: controls.promise,
    resolve: controls.resolve,
    reject: controls.reject,
  };
}

function decodeReservation(
  serialized: string,
  objectId: string,
): ResultType<Reservation, BlobIntegrityFailure> {
  const parsedJson = Result.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: classifyAdapterCause,
  });
  const decoded = parsedJson.match<
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "failure"; readonly failure: ClassifiedAdapterCause }
  >({
    ok: (value) => ({ kind: "value", value }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (decoded.kind === "failure") {
    if (decoded.failure.kind === "panic") {
      signalRetainedBlobPanic(decoded.failure.panic);
    }
    return Result.err(
      new BlobIntegrityFailure({
        objectId,
        reason: "Reservation metadata is not valid JSON",
        message: `Blob reservation ${objectId} is corrupt`,
      }),
    );
  }
  const reservation = reservationSchema.safeParse(decoded.value);
  if (!reservation.success || reservation.data.objectId !== objectId) {
    return Result.err(
      new BlobIntegrityFailure({
        objectId,
        reason: "Reservation metadata does not match its object identity",
        message: `Blob reservation ${objectId} is corrupt`,
      }),
    );
  }
  return Result.ok(reservation.data);
}

function serializeReservation(reservation: Reservation): string {
  return `${JSON.stringify(reservation)}\n`;
}

function terminalReservation(
  reservation: Reservation,
  state: "interrupted" | "deleted",
): Reservation {
  return {
    version: 1,
    objectId: reservation.objectId,
    generation: reservation.generation,
    state,
    retention: reservation.retention,
    createdAt: reservation.createdAt,
    ...(reservation.stagingExpiresAt === undefined
      ? {}
      : { stagingExpiresAt: reservation.stagingExpiresAt }),
    ...(reservation.pendingWrites === true ||
    (reservation.state === "pending" && reservation.stagingExpiresAt !== undefined)
      ? { pendingWrites: true }
      : {}),
  };
}

function referenceIssues(value: BlobRefV1 | BlobHandleV1): readonly string[] {
  const decoded = blobRefV1Schema.safeParse(value);
  return decoded.success ? [] : decoded.error.issues.map((issue) => issue.message);
}

function handleIssues(value: BlobRefV1 | BlobHandleV1): readonly string[] {
  const decoded = blobHandleV1Schema.safeParse(value);
  return decoded.success ? [] : decoded.error.issues.map((issue) => issue.message);
}

function uploadFailureReason(error: BlobWriteError): BlobUploadFailed["reason"] | undefined {
  if (error instanceof BlobUploadFailed) return error.reason;
  if (error instanceof BlobOperationAndCleanupFailed && error.primary instanceof BlobUploadFailed) {
    return error.primary.reason;
  }
  return undefined;
}

export class SupervisedBlobStore implements BlobStore {
  readonly #backend: BlobBackend;
  readonly #logger?: BlobLifecycleLogger;
  readonly #active = new Map<string, ActiveUpload>();
  readonly #objectLocks = new Map<string, Promise<void>>();
  #closed = false;
  #closeResult?: Promise<ResultType<BlobCloseSummary, BlobCloseError>>;
  #completedUploads = 0;

  constructor(backend: BlobBackend, logger?: BlobLifecycleLogger) {
    this.#backend = backend;
    this.#logger = logger;
  }

  #debug(message: string, context: BlobLifecycleLogContext): void {
    this.#logger?.debug(message, { adapter: this.#backend.kind, ...context });
  }

  #error(message: string, context: BlobLifecycleLogContext): void {
    this.#logger?.error(message, { adapter: this.#backend.kind, ...context });
  }

  startStagedUpload(input: {
    readonly source: BlobSource;
    readonly stagingExpiresAt: number;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<ResultType<BlobUpload, BlobUploadStartError>> {
    const deadline = stagingExpiresAtSchema.safeParse(input.stagingExpiresAt);
    if (!deadline.success || deadline.data <= Date.now()) {
      return Promise.resolve(
        Result.err(
          new BlobInvalidInput({
            field: "stagingExpiresAt",
            message: "Staging deadline must be a safe integer in the future",
          }),
        ),
      );
    }
    return this.#startUpload({ ...input, retention: { kind: "durable" } });
  }

  startUpload(input: {
    readonly source: BlobSource;
    readonly retention: BlobRetention;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<ResultType<BlobUpload, BlobUploadStartError>> {
    return this.#startUpload(input);
  }

  async #startUpload(input: {
    readonly stagingExpiresAt?: number;
    readonly source: BlobSource;
    readonly retention: BlobRetention;
    readonly expectedSha256?: string;
    readonly expectedByteLength?: number;
  }): Promise<ResultType<BlobUpload, BlobUploadStartError>> {
    if (this.#closed) {
      return Result.err(new BlobStoreClosed({ message: "Blob store is closed" }));
    }
    const retention = retentionSchema.safeParse(input.retention);
    if (
      !retention.success ||
      (retention.data.kind === "expires" && retention.data.expiresAt <= Date.now())
    ) {
      return Result.err(
        new BlobInvalidRetention({
          message: "Blob retention must be durable or expire in the future",
        }),
      );
    }
    if (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(input.expectedSha256)) {
      return Result.err(
        new BlobInvalidInput({
          field: "expectedSha256",
          message: "Expected SHA-256 must be lowercase hexadecimal",
        }),
      );
    }
    if (
      input.expectedByteLength !== undefined &&
      (!Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength < 0)
    ) {
      return Result.err(
        new BlobInvalidInput({
          field: "expectedByteLength",
          message: "Expected byte length must be a non-negative safe integer",
        }),
      );
    }
    if (!(input.source instanceof Uint8Array) && !(input.source instanceof ReadableStream)) {
      return Result.err(
        new BlobInvalidInput({
          field: "source",
          message: "Blob source must be bytes or a readable byte stream",
        }),
      );
    }

    const objectId = `b1_${randomBytes(16).toString("hex")}`;
    const reservation: PendingReservation = {
      version: 1,
      objectId,
      generation: randomUUID(),
      state: "pending",
      retention: retention.data,
      createdAt: Date.now(),
      ...(input.stagingExpiresAt === undefined ? {} : { stagingExpiresAt: input.stagingExpiresAt }),
    };
    const completion = deferred<ResultType<BlobRefV1, BlobWriteError>>();
    const reservationCreated = this.#backend.createReservation(
      objectId,
      serializeReservation(reservation),
      reservation.stagingExpiresAt ??
        (reservation.retention.kind === "expires" ? reservation.retention.expiresAt : undefined),
    );
    const active: ActiveUpload = {
      reservation,
      source: input.source,
      expectedSha256: input.expectedSha256,
      expectedByteLength: input.expectedByteLength,
      abortController: new AbortController(),
      completion,
      reservationCreated,
      phase: "reserving",
    };
    this.#active.set(objectId, active);
    this.#debug("blob upload reservation started", {
      objectId,
      retention: reservation.retention.kind,
      ...(input.expectedByteLength === undefined
        ? {}
        : { expectedByteLength: input.expectedByteLength }),
      expectedSha256: input.expectedSha256 !== undefined,
    });

    const created = await reservationCreated;
    const outcome = created.match<ReadOutcome<void>>({
      ok: (value) => ({ ok: true, value }),
      err: () => ({ ok: false }),
    });
    if (!outcome.ok) {
      this.#active.delete(objectId);
      this.#error("blob upload reservation failed", {
        objectId,
        durationMs: Date.now() - reservation.createdAt,
      });
      return created.match<ResultType<BlobUpload, BlobUploadStartError>>({
        ok: () =>
          Result.err(
            new BlobStoreClosed({
              message: "Blob upload reservation was lost",
            }),
          ),
        err: (failure) =>
          Result.err(
            new BlobUploadReservationFailed({
              objectId,
              failure,
              message: `Could not reserve blob upload ${objectId}`,
            }),
          ),
      });
    }

    if (active.phase === "reserving") {
      active.phase = "uploading";
      this.#debug("blob upload started", {
        objectId,
        durationMs: Date.now() - reservation.createdAt,
      });
      void this.#superviseUpload(active);
    }

    return Result.ok({
      handle: { version: 1, objectId },
      completion: completion.promise,
    });
  }

  adopt(handle: BlobHandleV1): Promise<ResultType<BlobRefV1, BlobResolveError>> {
    const issues = handleIssues(handle);
    if (issues.length > 0) {
      return Promise.resolve(
        Result.err(new BlobInvalidReference({ issues, message: "Blob handle is invalid" })),
      );
    }
    return Result.gen(async function* (this: SupervisedBlobStore) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reservation = yield* Result.await(this.#readReservation(handle.objectId));
        if (reservation?.state === "ready") return Result.ok(reservation.ref);
        if (reservation === null || reservation.state === "deleted") {
          return Result.err(
            new BlobObjectAbsent({
              objectId: handle.objectId,
              message: `Blob ${handle.objectId} is absent or its staging deadline passed`,
            }),
          );
        }
        if (reservation.state === "failed") {
          return Result.err(
            new BlobUploadFailed({
              objectId: handle.objectId,
              reason: reservation.reason,
              message: `Blob upload ${handle.objectId} failed`,
            }),
          );
        }
        if (reservation.state === "interrupted") {
          return Result.err(
            new BlobUploadInterrupted({
              objectId: handle.objectId,
              message: `Blob upload ${handle.objectId} was interrupted`,
            }),
          );
        }
        if (
          reservation.stagingExpiresAt !== undefined &&
          reservation.stagingExpiresAt <= Date.now()
        ) {
          const expired = terminalReservation(reservation, "deleted");
          const applied = yield* Result.await(
            this.#backend.compareAndSwapReservation(
              handle.objectId,
              serializeReservation(reservation),
              serializeReservation(expired),
            ),
          );
          if (!applied) continue;
          return Result.err(
            new BlobObjectAbsent({
              objectId: handle.objectId,
              message: `Blob ${handle.objectId} expired before adoption`,
            }),
          );
        }
        if (reservation.state === "pending") break;
        const adopted: Reservation = { ...reservation, state: "ready" };
        const applied = yield* Result.await(
          this.#backend.compareAndSwapReservation(
            handle.objectId,
            serializeReservation(reservation),
            serializeReservation(adopted),
          ),
        );
        if (applied) return Result.ok(reservation.ref);
      }
      return Result.err(
        new BlobResolveTimeout({
          objectId: handle.objectId,
          timeoutMs: 0,
          message: `Blob upload ${handle.objectId} is not ready for adoption`,
        }),
      );
    }, this);
  }

  async resolve(
    handle: BlobHandleV1,
    options: { readonly timeoutMs: number },
  ): Promise<ResultType<BlobRefV1, BlobResolveError>> {
    const issues = handleIssues(handle);
    if (issues.length > 0) {
      return Result.err(new BlobInvalidReference({ issues, message: "Blob handle is invalid" }));
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
      return Result.err(
        new BlobInvalidInput({
          field: "timeoutMs",
          message: "Resolve timeout must be a non-negative safe integer",
        }),
      );
    }
    const deadline = Date.now() + options.timeoutMs;
    const localUpload = this.#active.get(handle.objectId);
    if (localUpload !== undefined && localUpload.reservation.stagingExpiresAt === undefined) {
      const remaining = Math.max(0, deadline - Date.now());
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const localDeadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
        deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), remaining);
        deadlineTimer.unref?.();
      });
      const localSettlement = await Promise.race([
        localUpload.completion.promise.then((result) => ({ kind: "settled" as const, result })),
        localDeadline,
      ]).finally(() => clearTimeout(deadlineTimer));
      if (localSettlement.kind === "deadline") {
        return Result.err(
          new BlobResolveTimeout({
            objectId: handle.objectId,
            timeoutMs: options.timeoutMs,
            message: `Timed out resolving blob upload ${handle.objectId}`,
          }),
        );
      }
      return localSettlement.result.match<ResultType<BlobRefV1, BlobResolveError>>({
        ok: (ref) => Result.ok(ref),
        err: (error) => {
          if (localUpload.phase === "deleted") {
            return Result.err(
              new BlobObjectAbsent({
                objectId: handle.objectId,
                message: `Blob ${handle.objectId} is absent`,
              }),
            );
          }
          return Result.err(
            error instanceof BlobUploadFailed || error instanceof BlobUploadInterrupted
              ? error
              : new BlobUploadFailed({
                  objectId: handle.objectId,
                  reason: "write",
                  message: `Blob upload ${handle.objectId} failed`,
                }),
          );
        },
      });
    }
    let delayMs = 5;
    while (true) {
      const observed = await this.#readReservation(handle.objectId);
      const decision = observed.match<
        | { readonly kind: "ready"; readonly ref: BlobRefV1 }
        | { readonly kind: "wait" }
        | { readonly kind: "error"; readonly error: BlobResolveError }
      >({
        ok: (reservation) => {
          if (reservation === null || reservation.state === "deleted") {
            return {
              kind: "error",
              error: new BlobObjectAbsent({
                objectId: handle.objectId,
                message: `Blob ${handle.objectId} is absent`,
              }),
            };
          }
          if (reservation.state === "ready") return { kind: "ready", ref: reservation.ref };
          if (reservation.state === "pending" || reservation.state === "staged")
            return { kind: "wait" };
          if (reservation.state === "interrupted") {
            return {
              kind: "error",
              error: new BlobUploadInterrupted({
                objectId: handle.objectId,
                message: `Blob upload ${handle.objectId} was interrupted during shutdown`,
              }),
            };
          }
          return {
            kind: "error",
            error: new BlobUploadFailed({
              objectId: handle.objectId,
              reason: reservation.reason,
              message: `Blob upload ${handle.objectId} failed`,
            }),
          };
        },
        err: (error) => ({ kind: "error", error }),
      });
      if (decision.kind === "ready") return Result.ok(decision.ref);
      if (decision.kind === "error") return Result.err(decision.error);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return Result.err(
          new BlobResolveTimeout({
            objectId: handle.objectId,
            timeoutMs: options.timeoutMs,
            message: `Timed out resolving blob upload ${handle.objectId}`,
          }),
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }

  async open(ref: BlobRefV1): Promise<ResultType<BlobRead, BlobReadError>> {
    const decoded = blobRefV1Schema.safeParse(ref);
    if (!decoded.success) {
      return Result.err(
        new BlobInvalidReference({
          issues: referenceIssues(ref),
          message: "Blob reference is invalid",
        }),
      );
    }
    if (decoded.data.expiresAt !== undefined && decoded.data.expiresAt <= Date.now()) {
      return Result.err(
        new BlobObjectExpired({
          objectId: decoded.data.objectId,
          expiresAt: decoded.data.expiresAt,
          message: `Blob ${decoded.data.objectId} has expired`,
        }),
      );
    }

    const observed = await this.#readReservation(decoded.data.objectId);
    const established = await observed.match<
      Promise<ResultType<ReadableStream<Uint8Array>, BlobReadError>>
    >({
      ok: async (reservation) => {
        if (reservation === null || reservation.state !== "ready") {
          return Result.err(
            new BlobObjectAbsent({
              objectId: decoded.data.objectId,
              message: `Blob ${decoded.data.objectId} is absent`,
            }),
          );
        }
        if (JSON.stringify(reservation.ref) !== JSON.stringify(decoded.data)) {
          return Result.err(
            new BlobIntegrityFailure({
              objectId: decoded.data.objectId,
              reason: "Reference does not match committed metadata",
              message: `Blob ${decoded.data.objectId} metadata is corrupt`,
            }),
          );
        }
        const technicalMetadata = await this.#backend.readMetadata(reservation.contentKey);
        const verifiedMetadata = technicalMetadata.andThen((serialized) =>
          serialized === `${JSON.stringify(decoded.data)}\n`
            ? Result.ok(undefined)
            : Result.err(
                new BlobIntegrityFailure({
                  objectId: decoded.data.objectId,
                  reason: "Committed technical metadata is missing or inconsistent",
                  message: `Blob ${decoded.data.objectId} metadata is corrupt`,
                }),
              ),
        );
        return Result.gen(async function* (this: SupervisedBlobStore) {
          yield* verifiedMetadata;
          const stream = yield* Result.await(this.#backend.openContent(reservation.contentKey));
          if (stream === null) {
            return Result.err(
              new BlobIntegrityFailure({
                objectId: decoded.data.objectId,
                reason: "Committed content is missing",
                message: `Blob ${decoded.data.objectId} content is corrupt`,
              }),
            );
          }
          return Result.ok(stream);
        }, this);
      },
      err: async (error) => Result.err(error),
    });
    return established.map((stream) => createVerifiedRead(decoded.data, stream));
  }

  async delete(
    target: BlobHandleV1 | BlobRefV1,
  ): Promise<ResultType<"deleted" | "absent", BlobDeleteError>> {
    const decodedRef = blobRefV1Schema.safeParse(target);
    const decodedHandle = blobHandleV1Schema.safeParse(target);
    if (!decodedRef.success && !decodedHandle.success) {
      return Result.err(
        new BlobInvalidReference({
          issues: [...referenceIssues(target), ...handleIssues(target)],
          message: "Blob delete target is invalid",
        }),
      );
    }
    const objectId = decodedRef.success ? decodedRef.data.objectId : decodedHandle.data?.objectId;
    if (objectId === undefined) {
      return Result.err(
        new BlobInvalidReference({
          issues: [],
          message: "Blob delete target is invalid",
        }),
      );
    }
    const pendingLocalUpload = this.#active.get(objectId);
    if (pendingLocalUpload !== undefined && pendingLocalUpload.phase !== "completed") {
      pendingLocalUpload.phase = "deleted";
      pendingLocalUpload.abortController.abort();
    }
    return this.#withObjectLock(objectId, async () => {
      const observed = await this.#readReservation(objectId);
      return observed.match<Promise<ResultType<"deleted" | "absent", BlobDeleteError>>>({
        ok: async (reservation) => {
          if (reservation === null) return Result.ok("absent");
          if (reservation.state === "deleted") return this.#cleanupDeletedReservation(reservation);
          if (
            decodedRef.success &&
            (reservation.state === "ready" || reservation.state === "staged") &&
            JSON.stringify(reservation.ref) !== JSON.stringify(decodedRef.data)
          ) {
            return Result.err(
              new BlobIntegrityFailure({
                objectId,
                reason: "Delete reference does not match committed metadata",
                message: `Blob ${objectId} metadata is corrupt`,
              }),
            );
          }
          const active = this.#active.get(reservation.objectId);
          const fence = await this.#persistDeletedFence(reservation);
          return fence.match<Promise<ResultType<"deleted", BlobDeleteError>>>({
            ok: async (fenced) => {
              if (active !== undefined && active.phase !== "completed") {
                active.completion.resolve(
                  Result.err(
                    new BlobUploadFailed({
                      objectId: reservation.objectId,
                      reason: "fenced",
                      message: `Blob upload ${reservation.objectId} was deleted`,
                    }),
                  ),
                );
              }
              return this.#cleanupDeletedReservation(fenced);
            },
            err: async (failure) => {
              if (active !== undefined && active.phase !== "completed") {
                active.completion.resolve(
                  Result.err(
                    new BlobUploadFailed({
                      objectId: reservation.objectId,
                      reason: "write",
                      message: `Blob upload ${reservation.objectId} deletion fence failed`,
                    }),
                  ),
                );
              }
              return failure instanceof BlobIntegrityFailure
                ? Result.err(failure)
                : Result.err(
                    new BlobDeleteFailed({
                      objectId: reservation.objectId,
                      failure,
                      message: `Could not fence blob ${reservation.objectId} for deletion`,
                    }),
                  );
            },
          });
        },
        err: async (error) => Result.err(error),
      });
    });
  }

  async #persistDeletedFence(
    initial: Reservation,
  ): Promise<ResultType<Reservation, BlobAdapterFailure | BlobIntegrityFailure>> {
    let reservation = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (
        reservation.state === "deleted" ||
        reservation.state === "failed" ||
        reservation.state === "interrupted"
      ) {
        return Result.ok(terminalReservation(reservation, "deleted"));
      }
      const fenced = terminalReservation(reservation, "deleted");
      const persisted = await this.#backend.compareAndSwapReservation(
        reservation.objectId,
        serializeReservation(reservation),
        serializeReservation(fenced),
      );
      const outcome = persisted.match<
        | { readonly kind: "applied"; readonly applied: boolean }
        | { readonly kind: "failure"; readonly failure: BlobAdapterFailure }
      >({
        ok: (applied) => ({ kind: "applied", applied }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (outcome.kind === "failure") return Result.err(outcome.failure);
      if (outcome.applied) return Result.ok(fenced);
      const observed = await this.#readReservation(reservation.objectId);
      const current = observed.match<
        | { readonly kind: "reservation"; readonly reservation: Reservation | null }
        | {
            readonly kind: "failure";
            readonly failure: BlobAdapterFailure | BlobIntegrityFailure;
          }
      >({
        ok: (value) => ({ kind: "reservation", reservation: value }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (current.kind === "failure") return Result.err(current.failure);
      if (current.reservation === null) return Result.ok(fenced);
      reservation = current.reservation;
    }
    return Result.err(
      new BlobIntegrityFailure({
        objectId: initial.objectId,
        reason: "Reservation kept changing while writing deletion fence",
        message: `Blob reservation ${initial.objectId} changed during deletion`,
      }),
    );
  }

  async #cleanupDeletedReservation(
    reservation: Reservation,
  ): Promise<ResultType<"deleted", BlobDeleteError>> {
    const contentKey = contentKeyFor({
      objectId: reservation.objectId,
      expiresAt:
        reservation.retention.kind === "expires" ? reservation.retention.expiresAt : undefined,
    });
    const removed = await this.#backend.deleteKeys([
      contentKey,
      metadataKey(contentKey),
      temporaryKey(reservation.objectId, reservation.generation),
      ...(reservation.pendingWrites === true
        ? []
        : [
            ...(reservation.retention.kind === "expires"
              ? [expiryIndexKey(reservation.retention.expiresAt, reservation.objectId)]
              : []),
            ...(reservation.stagingExpiresAt === undefined
              ? []
              : [expiryIndexKey(reservation.stagingExpiresAt, reservation.objectId)]),
            reservationKey(reservation.objectId),
            reservationFenceKey(reservation.objectId),
            reservationDecisionKey(reservation.objectId),
            reservationTransitionKey(reservation.objectId),
          ]),
    ]);
    return removed.match<ResultType<"deleted", BlobDeleteError>>({
      ok: () => Result.ok("deleted"),
      err: (failure) =>
        Result.err(
          new BlobDeleteFailed({
            objectId: reservation.objectId,
            failure,
            message: `Blob ${reservation.objectId} was fenced but physical deletion failed`,
          }),
        ),
    });
  }

  async maintain(
    input: {
      readonly now?: number;
      readonly limit?: number;
    } = {},
  ): Promise<ResultType<BlobMaintenanceSummary, BlobMaintenanceError>> {
    const now = input.now ?? Date.now();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(now) || now < 0) {
      return Result.err(
        new BlobInvalidInput({
          field: "now",
          message: "Maintenance time must be a non-negative safe integer",
        }),
      );
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      return Result.err(
        new BlobInvalidInput({
          field: "limit",
          message: "Maintenance limit must be between 1 and 10000",
        }),
      );
    }
    return Result.gen(async function* (this: SupervisedBlobStore) {
      const listed = yield* Result.await(
        this.#backend.listExpiredReservationIds(now, limit).then((result) =>
          result.mapError(
            (failure) =>
              new BlobMaintenanceFailed({
                failure,
                message: "Blob maintenance could not list reservations",
              }),
          ),
        ),
      );
      let deleted = 0;
      let firstFailure: BlobAdapterFailure | BlobIntegrityFailure | null = null;
      for (const objectId of listed.ids) {
        const maintained = await this.#withObjectLock(objectId, () =>
          this.#maintainReservation(objectId, now),
        );
        const outcome = maintained.match<
          | { readonly kind: "ok"; readonly deleted: boolean }
          | { readonly kind: "error"; readonly error: BlobAdapterFailure | BlobIntegrityFailure }
        >({
          ok: (value) => ({ kind: "ok", deleted: value }),
          err: (error) => ({ kind: "error", error }),
        });
        if (outcome.kind === "error") {
          firstFailure ??= outcome.error;
          continue;
        }
        if (outcome.deleted) deleted += 1;
      }
      if (firstFailure !== null)
        return Result.err(
          new BlobMaintenanceFailed({
            failure: firstFailure,
            message: "Blob maintenance could not clean up an expired reservation",
          }),
        );
      return Result.ok({ inspected: listed.ids.length, deleted, remaining: listed.remaining });
    }, this);
  }

  #maintainReservation(
    objectId: string,
    now: number,
  ): Promise<ResultType<boolean, BlobAdapterFailure | BlobIntegrityFailure>> {
    return Result.gen(async function* (this: SupervisedBlobStore) {
      const reservation = yield* Result.await(this.#readReservation(objectId));
      if (reservation === null) return Result.ok(false);
      if (reservation.state === "ready" && reservation.stagingExpiresAt !== undefined) {
        yield* Result.await(
          this.#backend.deleteKeys([expiryIndexKey(reservation.stagingExpiresAt, objectId)]),
        );
        return Result.ok(false);
      }
      const expiresAt =
        reservation.stagingExpiresAt ??
        (reservation.retention.kind === "expires" ? reservation.retention.expiresAt : undefined);
      if (expiresAt === undefined || expiresAt > now) return Result.ok(false);
      const deleted = terminalReservation(reservation, "deleted");
      if (
        reservation.state !== "deleted" &&
        reservation.state !== "failed" &&
        reservation.state !== "interrupted"
      ) {
        const applied = yield* Result.await(
          this.#backend.compareAndSwapReservation(
            objectId,
            serializeReservation(reservation),
            serializeReservation(deleted),
          ),
        );
        if (!applied) return Result.ok(false);
      }
      const active = this.#active.get(objectId);
      if (active !== undefined && active.phase !== "completed") {
        active.phase = "deleted";
        active.abortController.abort();
        active.completion.resolve(
          Result.err(
            new BlobUploadFailed({
              objectId,
              reason: "fenced",
              message: `Blob upload ${objectId} expired before publication`,
            }),
          ),
        );
      }
      yield* Result.await(
        this.#cleanupDeletedReservation(deleted).then((result) =>
          result.mapError((error) => {
            if (error instanceof BlobDeleteFailed) return error.failure;
            if (error instanceof BlobIntegrityFailure) return error;
            return new BlobIntegrityFailure({
              objectId,
              reason: error.message,
              message: `Blob maintenance could not delete ${objectId}`,
            });
          }),
        ),
      );
      return Result.ok(true);
    }, this);
  }

  close(input: {
    readonly deadlineAtMs: number;
  }): Promise<ResultType<BlobCloseSummary, BlobCloseError>> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    if (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs < 0) {
      return Promise.resolve(
        Result.err(
          new BlobInvalidInput({
            field: "deadlineAtMs",
            message: "Close deadline must be a non-negative safe integer",
          }),
        ),
      );
    }
    this.#closed = true;
    const active = [...this.#active.values()].filter((upload) => upload.phase !== "completed");
    for (const upload of active) {
      upload.phase = "interrupted";
      upload.abortController.abort();
      void upload.sink?.abort();
    }
    const fences = active.map((upload) => this.#fenceInterrupted(upload));
    this.#closeResult = this.#settleClose(fences, input.deadlineAtMs);
    return this.#closeResult;
  }

  async #runUpload(active: ActiveUpload): Promise<void> {
    const upload = await this.#transfer(active);
    if (active.reservation.stagingExpiresAt !== undefined && active.contentWritesSettled === true) {
      await this.#retireSettledCleanup(active.reservation.objectId);
    }
    const settled = upload.match<
      | { readonly ok: true; readonly value: BlobRefV1 }
      | { readonly ok: false; readonly error: BlobWriteError }
    >({
      ok: (value) => ({ ok: true, value }),
      err: (error) => ({ ok: false, error }),
    });
    if (
      active.phase === "interrupted" ||
      active.phase === "deleted" ||
      active.phase === "completed"
    ) {
      this.#debug("blob upload settlement ignored", {
        objectId: active.reservation.objectId,
        phase: active.phase,
        durationMs: Date.now() - active.reservation.createdAt,
      });
      return;
    }
    if (settled.ok) {
      this.#debug("blob upload completed", {
        objectId: active.reservation.objectId,
        byteLength: settled.value.byteLength,
        retention: active.reservation.retention.kind,
        durationMs: Date.now() - active.reservation.createdAt,
      });
    } else {
      const failureReason = uploadFailureReason(settled.error);
      this.#error("blob upload failed", {
        objectId: active.reservation.objectId,
        errorClass: settled.error.name,
        errorMessage: settled.error.message,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(active.expectedByteLength === undefined
          ? {}
          : { expectedByteLength: active.expectedByteLength }),
        ...(active.observedByteLength === undefined
          ? {}
          : { observedByteLength: active.observedByteLength }),
        durationMs: Date.now() - active.reservation.createdAt,
      });
    }
    active.phase = settled.ok ? "completed" : active.phase;
    active.completion.resolve(settled.ok ? Result.ok(settled.value) : Result.err(settled.error));
    if (settled.ok) this.#completedUploads += 1;
    this.#active.delete(active.reservation.objectId);
  }

  async #retireSettledCleanup(objectId: string): Promise<void> {
    const retired = await Result.gen(async function* (this: SupervisedBlobStore) {
      const reservation = yield* Result.await(this.#readReservation(objectId));
      if (reservation === null || reservation.pendingWrites !== true) return Result.ok(undefined);
      if (
        reservation.state !== "deleted" &&
        reservation.state !== "failed" &&
        reservation.state !== "interrupted"
      ) {
        return Result.ok(undefined);
      }
      const settled: Reservation = { ...reservation, pendingWrites: false };
      const applied = yield* Result.await(
        this.#backend.compareAndSwapReservation(
          objectId,
          serializeReservation(reservation),
          serializeReservation(settled),
        ),
      );
      if (!applied) return Result.ok(undefined);
      yield* Result.await(this.#cleanupDeletedReservation(settled));
      return Result.ok(undefined);
    }, this);
    retired.match({
      ok: () => undefined,
      err: (error) =>
        this.#error("blob settled cleanup will retry during maintenance", {
          objectId,
          errorClass: error.name,
          errorMessage: error.message,
        }),
    });
  }

  async #superviseUpload(active: ActiveUpload): Promise<void> {
    const captured = await Result.tryPromise({
      try: async () => this.#runUpload(active),
      catch: classifyBlobDefect,
    });
    const outcome = captured.match<
      { readonly kind: "complete" } | { readonly kind: "panic"; readonly panic: Panic }
    >({
      ok: () => ({ kind: "complete" }),
      err: (panic) => ({ kind: "panic", panic }),
    });
    if (outcome.kind === "complete") return;
    this.#error("blob upload crashed", {
      objectId: active.reservation.objectId,
      errorClass: outcome.panic.name,
      errorMessage: outcome.panic.message,
      durationMs: Date.now() - active.reservation.createdAt,
    });
    active.phase = "interrupted";
    active.abortController.abort();
    const fenced = await this.#persistDefectFence(active);
    if (fenced) this.#active.delete(active.reservation.objectId);
    active.completion.reject(outcome.panic);
  }

  async #persistDefectFence(active: ActiveUpload): Promise<boolean> {
    return this.#withObjectLock(active.reservation.objectId, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await this.#readReservation(active.reservation.objectId);
        const state = observed.match<
          | { readonly kind: "reservation"; readonly reservation: Reservation | null }
          | { readonly kind: "failure" }
        >({
          ok: (reservation) => ({ kind: "reservation", reservation }),
          err: () => ({ kind: "failure" }),
        });
        if (state.kind === "failure" || state.reservation === null) return Result.ok(false);
        if (
          state.reservation.generation !== active.reservation.generation ||
          state.reservation.state === "deleted" ||
          state.reservation.state === "failed" ||
          state.reservation.state === "interrupted"
        ) {
          return Result.ok(state.reservation.generation === active.reservation.generation);
        }
        const interrupted = terminalReservation(state.reservation, "interrupted");
        const persisted = await this.#backend.compareAndSwapReservation(
          state.reservation.objectId,
          serializeReservation(state.reservation),
          serializeReservation(interrupted),
        );
        const applied = persisted.match<boolean>({
          ok: (value) => value,
          err: () => false,
        });
        if (applied) return Result.ok(true);
      }
      return Result.ok(false);
    }).then((result) => result.match({ ok: (value) => value, err: () => false }));
  }

  async #transfer(active: ActiveUpload): Promise<ResultType<BlobRefV1, BlobWriteError>> {
    const sinkResult = await this.#backend.openSink(
      active.reservation.objectId,
      active.reservation.generation,
    );
    const sinkOutcome = sinkResult.match<
      { readonly sink: BlobSink } | { readonly failure: BlobAdapterFailure }
    >({
      ok: (sink) => ({ sink }),
      err: (failure) => ({ failure }),
    });
    if ("failure" in sinkOutcome) {
      this.#error("blob upload sink open failed", {
        objectId: active.reservation.objectId,
        operation: sinkOutcome.failure.operation,
        failureKind: sinkOutcome.failure.kind,
        errorMessage: sinkOutcome.failure.message,
      });
      return this.#recordUploadFailure(active, "write", sinkOutcome.failure);
    }
    active.sink = sinkOutcome.sink;
    this.#debug("blob upload sink opened", {
      objectId: active.reservation.objectId,
      durationMs: Date.now() - active.reservation.createdAt,
    });
    const hash = createHash("sha256");
    let byteLength = 0;
    const writeChunk = async (chunk: Uint8Array): Promise<ResultType<void, BlobWriteError>> => {
      if (active.abortController.signal.aborted) {
        return Result.err(
          new BlobUploadInterrupted({
            objectId: active.reservation.objectId,
            message: `Blob upload ${active.reservation.objectId} was interrupted`,
          }),
        );
      }
      hash.update(chunk);
      byteLength += chunk.byteLength;
      return (await sinkOutcome.sink.write(chunk)).mapError(
        () =>
          new BlobUploadFailed({
            objectId: active.reservation.objectId,
            reason: "write",
            message: `Blob upload ${active.reservation.objectId} failed while writing content`,
          }),
      );
    };

    const consumed =
      active.source instanceof Uint8Array
        ? await writeChunk(active.source)
        : await consumeUploadStream(active, active.source, writeChunk);
    const consumeOutcome = consumed.match<
      { readonly ok: true } | { readonly ok: false; readonly error: BlobWriteError }
    >({
      ok: () => ({ ok: true }),
      err: (error) => ({ ok: false, error }),
    });
    if (!consumeOutcome.ok) {
      const aborted = await sinkOutcome.sink.abort();
      const cleanupFailure = aborted.match<BlobAdapterFailure | null>({
        ok: () => null,
        err: (failure) => failure,
      });
      if (consumeOutcome.error instanceof BlobUploadInterrupted)
        return cleanupFailure === null
          ? Result.err(consumeOutcome.error)
          : Result.err(
              new BlobOperationAndCleanupFailed({
                operation: "consume upload source",
                primary: consumeOutcome.error,
                cleanup: cleanupFailure,
                message: `Blob upload ${active.reservation.objectId} was interrupted and its temporary content could not be cleaned up`,
              }),
            );
      if (!(consumeOutcome.error instanceof BlobUploadFailed))
        return Result.err(consumeOutcome.error);
      const recorded = await this.#recordUploadFailure(
        active,
        consumeOutcome.error.reason === "write" ? "write" : "source",
      );
      return cleanupFailure === null
        ? recorded
        : Result.err(
            new BlobOperationAndCleanupFailed({
              operation: "consume upload source",
              primary: consumeOutcome.error,
              cleanup: cleanupFailure,
              message: `Blob upload ${active.reservation.objectId} failed and its temporary content could not be cleaned up`,
            }),
          );
    }
    const finished = await sinkOutcome.sink.finish();
    const finishOutcome = finished.match<
      { readonly ok: true } | { readonly ok: false; readonly failure: BlobAdapterFailure }
    >({
      ok: () => ({ ok: true }),
      err: (failure) => ({ ok: false, failure }),
    });
    if (!finishOutcome.ok) {
      this.#error("blob upload sink finish failed", {
        objectId: active.reservation.objectId,
        operation: finishOutcome.failure.operation,
        failureKind: finishOutcome.failure.kind,
        errorMessage: finishOutcome.failure.message,
      });
      const aborted = await sinkOutcome.sink.abort();
      const cleanupFailure = aborted.match<BlobAdapterFailure | null>({
        ok: () => null,
        err: (failure) => failure,
      });
      const recorded = await this.#recordUploadFailure(active, "write");
      return cleanupFailure === null
        ? recorded
        : Result.err(
            new BlobOperationAndCleanupFailed({
              operation: "finish upload content",
              primary: finishOutcome.failure,
              cleanup: cleanupFailure,
              message: `Blob upload ${active.reservation.objectId} failed to finish and clean up temporary content`,
            }),
          );
    }

    active.contentWritesSettled = true;
    const sha256 = hash.digest("hex");
    active.observedByteLength = byteLength;
    this.#debug("blob upload source consumed", {
      objectId: active.reservation.objectId,
      byteLength,
      durationMs: Date.now() - active.reservation.createdAt,
    });
    if (active.expectedSha256 !== undefined && active.expectedSha256 !== sha256) {
      this.#error("blob upload digest verification failed", {
        objectId: active.reservation.objectId,
        failureReason: "expected_sha256",
        byteLength,
      });
      await this.#backend.deleteKeys([
        temporaryKey(active.reservation.objectId, active.reservation.generation),
      ]);
      return this.#recordUploadFailure(active, "expected_sha256");
    }
    if (active.expectedByteLength !== undefined && active.expectedByteLength !== byteLength) {
      this.#error("blob upload length verification failed", {
        objectId: active.reservation.objectId,
        failureReason: "expected_byte_length",
        expectedByteLength: active.expectedByteLength,
        observedByteLength: byteLength,
      });
      await this.#backend.deleteKeys([
        temporaryKey(active.reservation.objectId, active.reservation.generation),
      ]);
      return this.#recordUploadFailure(active, "expected_byte_length");
    }

    return this.#withObjectLock(active.reservation.objectId, async () => {
      if (active.phase === "interrupted" || active.phase === "deleted") {
        await this.#backend.deleteKeys([
          temporaryKey(active.reservation.objectId, active.reservation.generation),
        ]);
        return Result.err(
          active.phase === "interrupted"
            ? new BlobUploadInterrupted({
                objectId: active.reservation.objectId,
                message: `Blob upload ${active.reservation.objectId} was interrupted`,
              })
            : new BlobUploadFailed({
                objectId: active.reservation.objectId,
                reason: "fenced",
                message: `Blob upload ${active.reservation.objectId} lost its reservation fence`,
              }),
        );
      }
      const ref: BlobRefV1 = {
        version: 1,
        objectId: active.reservation.objectId,
        sha256,
        byteLength,
        ...(active.reservation.retention.kind === "expires"
          ? { expiresAt: active.reservation.retention.expiresAt }
          : {}),
      };
      const contentKey = contentKeyFor(ref);
      active.contentWritesSettled = false;
      const committed = await this.#backend.commitTemp(
        active.reservation.objectId,
        active.reservation.generation,
        contentKey,
        `${JSON.stringify(ref)}\n`,
        { sha256, byteLength },
      );
      const commitOutcome = committed.match<
        { readonly ok: true } | { readonly ok: false; readonly failure: BlobAdapterFailure }
      >({
        ok: () => ({ ok: true }),
        err: (failure) => ({ ok: false, failure }),
      });
      if (!commitOutcome.ok) {
        this.#error("blob upload content commit failed", {
          objectId: active.reservation.objectId,
          operation: commitOutcome.failure.operation,
          failureKind: commitOutcome.failure.kind,
          errorMessage: commitOutcome.failure.message,
        });
        const cleaned = await this.#backend.deleteKeys([
          contentKey,
          metadataKey(contentKey),
          temporaryKey(active.reservation.objectId, active.reservation.generation),
        ]);
        const cleanupFailure = cleaned.match<BlobAdapterFailure | null>({
          ok: () => null,
          err: (failure) => failure,
        });
        const recorded = await this.#recordUploadFailureUnlocked(active, "write");
        return cleanupFailure === null
          ? recorded
          : Result.err(
              new BlobOperationAndCleanupFailed({
                operation: "commit upload content",
                primary: commitOutcome.failure,
                cleanup: cleanupFailure,
                message: `Blob upload ${active.reservation.objectId} failed to commit and clean up content`,
              }),
            );
      }
      active.contentWritesSettled = true;
      this.#debug("blob upload content committed", {
        objectId: active.reservation.objectId,
        byteLength,
        durationMs: Date.now() - active.reservation.createdAt,
      });
      const afterCommitPhase = this.#uploadPhase(active);
      if (afterCommitPhase === "interrupted" || afterCommitPhase === "deleted") {
        await this.#backend.deleteKeys([contentKey, metadataKey(contentKey)]);
        return Result.err(
          afterCommitPhase === "interrupted"
            ? new BlobUploadInterrupted({
                objectId: active.reservation.objectId,
                message: `Blob upload ${active.reservation.objectId} was interrupted`,
              })
            : new BlobUploadFailed({
                objectId: active.reservation.objectId,
                reason: "fenced",
                message: `Blob upload ${active.reservation.objectId} lost its reservation fence`,
              }),
        );
      }
      const ready: Reservation =
        active.reservation.stagingExpiresAt === undefined
          ? { ...active.reservation, state: "ready", ref, contentKey }
          : {
              ...active.reservation,
              state: "staged",
              retention: { kind: "durable" },
              stagingExpiresAt: active.reservation.stagingExpiresAt,
              ref,
              contentKey,
            };
      const publication = this.#backend.compareAndSwapReservation(
        active.reservation.objectId,
        serializeReservation(active.reservation),
        serializeReservation(ready),
      );
      active.readyPublication = publication;
      const published = await publication;
      const publishState = published.match<
        | { readonly ok: true; readonly applied: boolean }
        | { readonly ok: false; readonly failure: BlobAdapterFailure }
      >({
        ok: (applied) => ({ ok: true, applied }),
        err: (failure) => ({ ok: false, failure }),
      });
      if (publishState.ok && publishState.applied) {
        this.#debug("blob upload reference published", {
          objectId: active.reservation.objectId,
          durationMs: Date.now() - active.reservation.createdAt,
        });
        return Result.ok(ref);
      }
      if (!publishState.ok) {
        this.#error("blob upload reference publication failed", {
          objectId: active.reservation.objectId,
          operation: publishState.failure.operation,
          failureKind: publishState.failure.kind,
          errorMessage: publishState.failure.message,
        });
      }
      const cleaned = await this.#backend.deleteKeys([contentKey, metadataKey(contentKey)]);
      const cleanupFailure = cleaned.match<BlobAdapterFailure | null>({
        ok: () => null,
        err: (failure) => failure,
      });
      const recorded = publishState.ok
        ? Result.err(
            new BlobUploadFailed({
              objectId: active.reservation.objectId,
              reason: "fenced",
              message: `Blob upload ${active.reservation.objectId} lost its reservation fence`,
            }),
          )
        : await this.#recordUploadFailureUnlocked(active, "write");
      return cleanupFailure === null
        ? recorded
        : Result.err(
            new BlobOperationAndCleanupFailed({
              operation: "publish upload reference",
              primary: publishState.ok
                ? new BlobUploadFailed({
                    objectId: active.reservation.objectId,
                    reason: "fenced",
                    message: `Blob upload ${active.reservation.objectId} lost its reservation fence`,
                  })
                : publishState.failure,
              cleanup: cleanupFailure,
              message: `Blob upload ${active.reservation.objectId} failed to publish and clean up content`,
            }),
          );
    });
  }

  async #recordUploadFailure(
    active: ActiveUpload,
    reason: "source" | "write" | "expected_sha256" | "expected_byte_length",
    _failure?: BlobAdapterFailure,
  ): Promise<ResultType<BlobRefV1, BlobWriteError>> {
    return this.#withObjectLock(active.reservation.objectId, async () =>
      this.#recordUploadFailureUnlocked(active, reason),
    );
  }

  async #recordUploadFailureUnlocked(
    active: ActiveUpload,
    reason: "source" | "write" | "expected_sha256" | "expected_byte_length",
  ): Promise<ResultType<BlobRefV1, BlobWriteError>> {
    if (active.phase === "interrupted") {
      return Result.err(
        new BlobUploadInterrupted({
          objectId: active.reservation.objectId,
          message: `Blob upload ${active.reservation.objectId} was interrupted`,
        }),
      );
    }
    if (active.phase === "deleted") {
      return Result.err(
        new BlobUploadFailed({
          objectId: active.reservation.objectId,
          reason: "fenced",
          message: `Blob upload ${active.reservation.objectId} was deleted`,
        }),
      );
    }
    const observed = await this.#readReservation(active.reservation.objectId);
    const state = observed.match<
      | {
          readonly kind: "reservation";
          readonly reservation: Reservation | null;
        }
      | { readonly kind: "failure" }
    >({
      ok: (reservation) => ({ kind: "reservation", reservation }),
      err: () => ({ kind: "failure" }),
    });
    if (state.kind === "failure") {
      return Result.err(
        new BlobUploadFailed({
          objectId: active.reservation.objectId,
          reason: "write",
          message: `Blob upload ${active.reservation.objectId} failed and its terminal state could not be inspected`,
        }),
      );
    }
    const reservation = state.reservation;
    if (
      reservation === null ||
      reservation.state !== "pending" ||
      reservation.generation !== active.reservation.generation
    ) {
      return Result.err(
        new BlobUploadFailed({
          objectId: active.reservation.objectId,
          reason: "fenced",
          message: `Blob upload ${active.reservation.objectId} lost its reservation fence`,
        }),
      );
    }
    const failed: Reservation = {
      ...active.reservation,
      state: "failed",
      reason,
      ...(active.reservation.stagingExpiresAt !== undefined && active.contentWritesSettled !== true
        ? { pendingWrites: true }
        : {}),
    };
    const persisted = await this.#backend.compareAndSwapReservation(
      active.reservation.objectId,
      serializeReservation(reservation),
      serializeReservation(failed),
    );
    const persistenceFailed = persisted.match({
      ok: (applied) => !applied,
      err: () => true,
    });
    return Result.err(
      new BlobUploadFailed({
        objectId: active.reservation.objectId,
        reason: persistenceFailed ? "write" : reason,
        message: persistenceFailed
          ? `Blob upload ${active.reservation.objectId} failed and its terminal state could not be persisted`
          : `Blob upload ${active.reservation.objectId} failed`,
      }),
    );
  }

  async #fenceInterrupted(active: ActiveUpload): Promise<ResultType<void, BlobCloseError>> {
    await active.reservationCreated;
    const immediate = await this.#writeInterruptedFence(active);
    const readyPublication = active.readyPublication;
    if (readyPublication === undefined) return immediate;
    await readyPublication;
    return this.#withObjectLock(active.reservation.objectId, async () =>
      this.#writeInterruptedFence(active),
    );
  }

  async #writeInterruptedFence(active: ActiveUpload): Promise<ResultType<void, BlobCloseError>> {
    const observed = await this.#readReservation(active.reservation.objectId);
    const state = observed.match<
      | {
          readonly kind: "reservation";
          readonly reservation: Reservation | null;
        }
      | {
          readonly kind: "failure";
          readonly failure: BlobAdapterFailure | BlobIntegrityFailure;
        }
    >({
      ok: (reservation) => ({ kind: "reservation", reservation }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (state.kind === "failure") {
      active.completion.resolve(
        Result.err(
          new BlobUploadInterrupted({
            objectId: active.reservation.objectId,
            message: `Blob upload ${active.reservation.objectId} was interrupted during shutdown`,
          }),
        ),
      );
      return Result.err(
        new BlobCloseFailed({
          failure: state.failure,
          message: `Could not inspect blob upload ${active.reservation.objectId} during shutdown`,
        }),
      );
    }
    const reservation = state.reservation;
    if (reservation === null) {
      active.completion.resolve(
        Result.err(
          new BlobUploadInterrupted({
            objectId: active.reservation.objectId,
            message: `Blob upload ${active.reservation.objectId} was interrupted during shutdown`,
          }),
        ),
      );
      return Result.ok(undefined);
    }
    if (reservation.generation !== active.reservation.generation) {
      return Result.err(
        new BlobCloseFailed({
          failure: new BlobIntegrityFailure({
            objectId: active.reservation.objectId,
            reason: "Reservation generation changed during shutdown",
            message: `Blob reservation ${active.reservation.objectId} is corrupt`,
          }),
          message: `Could not safely fence blob upload ${active.reservation.objectId} during shutdown`,
        }),
      );
    }
    if (reservation.state === "failed") {
      active.completion.resolve(
        Result.err(
          new BlobUploadFailed({
            objectId: reservation.objectId,
            reason: reservation.reason,
            message: `Blob upload ${reservation.objectId} failed`,
          }),
        ),
      );
      return Result.ok(undefined);
    }
    if (reservation.state === "interrupted" || reservation.state === "deleted") {
      active.completion.resolve(
        Result.err(
          reservation.state === "interrupted"
            ? new BlobUploadInterrupted({
                objectId: reservation.objectId,
                message: `Blob upload ${reservation.objectId} was interrupted during shutdown`,
              })
            : new BlobUploadFailed({
                objectId: reservation.objectId,
                reason: "fenced",
                message: `Blob upload ${reservation.objectId} was deleted`,
              }),
        ),
      );
      return Result.ok(undefined);
    }
    const interrupted = terminalReservation(reservation, "interrupted");
    const fenced = await this.#backend.compareAndSwapReservation(
      reservation.objectId,
      serializeReservation(reservation),
      serializeReservation(interrupted),
    );
    const fenceApplied = fenced.match<boolean | null>({
      ok: (applied) => applied,
      err: () => null,
    });
    if (fenceApplied === false) return this.#writeInterruptedFence(active);
    return fenced.match<ResultType<void, BlobCloseError>>({
      ok: () => {
        active.completion.resolve(
          Result.err(
            new BlobUploadInterrupted({
              objectId: reservation.objectId,
              message: `Blob upload ${reservation.objectId} was interrupted during shutdown`,
            }),
          ),
        );
        if (reservation.state === "ready" || reservation.state === "staged") {
          void this.#backend.deleteKeys([
            reservation.contentKey,
            metadataKey(reservation.contentKey),
          ]);
        }
        return Result.ok(undefined);
      },
      err: (failure) => {
        active.completion.resolve(
          Result.err(
            new BlobUploadInterrupted({
              objectId: reservation.objectId,
              message: `Blob upload ${reservation.objectId} was interrupted during shutdown`,
            }),
          ),
        );
        return Result.err(
          new BlobCloseFailed({
            failure,
            message: `Could not fence blob upload ${reservation.objectId} during shutdown`,
          }),
        );
      },
    });
  }

  async #settleClose(
    fences: readonly Promise<ResultType<void, BlobCloseError>>[],
    deadlineAtMs: number,
  ): Promise<ResultType<BlobCloseSummary, BlobCloseError>> {
    if (fences.length === 0) {
      return Result.ok({
        completedUploads: this.#completedUploads,
        interruptedUploads: 0,
      });
    }
    const allFences = Promise.all(fences);
    const remaining = Math.max(0, deadlineAtMs - Date.now());
    const deadline = new Promise<"deadline">((resolve) => {
      const timer = setTimeout(() => resolve("deadline"), remaining);
      timer.unref?.();
    });
    const raced = await Promise.race([
      allFences.then((results) => ({ kind: "fences" as const, results })),
      deadline.then(() => ({ kind: "deadline" as const })),
    ]);
    if (raced.kind === "deadline") {
      return Result.err(
        new BlobCloseDeadlineExceeded({
          deadlineAtMs,
          pendingFences: fences.length,
          message: "Blob store could not durably fence every upload before its close deadline",
        }),
      );
    }
    for (const result of raced.results) {
      const failure = result.match<BlobCloseError | null>({
        ok: () => null,
        err: (error) => error,
      });
      if (failure !== null) return Result.err(failure);
    }
    return Result.ok({
      completedUploads: this.#completedUploads,
      interruptedUploads: fences.length,
    });
  }

  async #readReservation(
    objectId: string,
  ): Promise<ResultType<Reservation | null, BlobAdapterFailure | BlobIntegrityFailure>> {
    const read = await this.#backend.readReservation(objectId);
    return read.andThen((serialized) =>
      serialized === null ? Result.ok(null) : decodeReservation(serialized, objectId),
    );
  }

  #withObjectLock<T, E>(
    objectId: string,
    operation: () => Promise<ResultType<T, E>>,
  ): Promise<ResultType<T, E>> {
    const predecessor = this.#objectLocks.get(objectId) ?? Promise.resolve();
    const released = deferred<void>();
    const tail = predecessor.then(() => released.promise);
    this.#objectLocks.set(objectId, tail);
    const captured = Result.tryPromise({
      try: async () => {
        await predecessor;
        return operation();
      },
      catch: classifyBlobDefect,
    });
    return captured.then((settled) => {
      released.resolve(undefined);
      if (this.#objectLocks.get(objectId) === tail) this.#objectLocks.delete(objectId);
      return settled.match<ResultType<T, E>>({
        ok: (value) => value,
        err: (panic) => signalRetainedBlobPanic(panic),
      });
    });
  }

  #uploadPhase(active: ActiveUpload): ActiveUpload["phase"] {
    return active.phase;
  }
}

async function consumeUploadStream(
  active: ActiveUpload,
  stream: ReadableStream<Uint8Array>,
  writeChunk: (chunk: Uint8Array) => Promise<ResultType<void, BlobWriteError>>,
): Promise<ResultType<void, BlobWriteError>> {
  const reader = stream.getReader();
  const cancel = () => {
    void Result.tryPromise({
      try: async () => reader.cancel("Blob upload interrupted"),
      catch: classifyAdapterCause,
    });
  };
  active.abortController.signal.addEventListener("abort", cancel, {
    once: true,
  });
  let failure: BlobWriteError | undefined;
  let done = false;
  while (!done && failure === undefined) {
    if (active.abortController.signal.aborted) {
      failure = new BlobUploadInterrupted({
        objectId: active.reservation.objectId,
        message: `Blob upload ${active.reservation.objectId} was interrupted`,
      });
      break;
    }
    const captured = await Result.tryPromise({
      try: async () => reader.read(),
      catch: classifyAdapterCause,
    });
    const outcome = captured.match<
      | {
          readonly kind: "read";
          readonly result: Awaited<ReturnType<typeof reader.read>>;
        }
      | {
          readonly kind: "failure";
          readonly failure: ClassifiedAdapterCause;
        }
    >({
      ok: (result) => ({ kind: "read", result }),
      err: (failure) => ({ kind: "failure", failure }),
    });
    if (outcome.kind === "failure") {
      if (outcome.failure.kind === "panic") signalRetainedBlobPanic(outcome.failure.panic);
      failure = new BlobUploadFailed({
        objectId: active.reservation.objectId,
        reason: "source",
        message: `Blob upload ${active.reservation.objectId} source failed`,
      });
    } else if (outcome.result.done) {
      done = true;
    } else {
      const written = await writeChunk(outcome.result.value);
      failure = written.match<BlobWriteError | undefined>({
        ok: () => undefined,
        err: (error) => error,
      });
    }
  }
  active.abortController.signal.removeEventListener("abort", cancel);
  return failure === undefined ? Result.ok(undefined) : Result.err(failure);
}

export function createVerifiedRead(ref: BlobRefV1, source: ReadableStream<Uint8Array>): BlobRead {
  const completion = deferred<ResultType<BlobReadComplete, BlobReadTerminalError>>();
  const reader = source.getReader();
  const hash = createHash("sha256");
  let byteLength = 0;
  let settled = false;

  const settle = (result: ResultType<BlobReadComplete, BlobReadTerminalError>): void => {
    if (settled) return;
    settled = true;
    completion.resolve(result);
  };

  const reject = (panic: Panic): boolean => {
    if (settled) return false;
    settled = true;
    completion.reject(panic);
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const captured = await Result.tryPromise({
        try: async () => reader.read(),
        catch: classifyAdapterCause,
      });
      const outcome = captured.match<
        | {
            readonly kind: "read";
            readonly result: Awaited<ReturnType<typeof reader.read>>;
          }
        | {
            readonly kind: "failure";
            readonly failure: ClassifiedAdapterCause;
          }
      >({
        ok: (result) => ({ kind: "read", result }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (outcome.kind === "failure") {
        if (outcome.failure.kind === "panic") {
          if (reject(outcome.failure.panic)) {
            controller.error(outcome.failure.panic);
          }
          return;
        }
        const failure = new BlobReadSourceFailure({
          objectId: ref.objectId,
          message: `Blob ${ref.objectId} source failed during reading`,
        });
        settle(Result.err(failure));
        controller.error(new Error(failure.message));
        return;
      }
      if (outcome.result.done) {
        const sha256 = hash.digest("hex");
        if (byteLength !== ref.byteLength || sha256 !== ref.sha256) {
          settle(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason:
                  byteLength !== ref.byteLength
                    ? `Expected ${ref.byteLength} bytes but read ${byteLength}`
                    : `Expected SHA-256 ${ref.sha256} but read ${sha256}`,
                message: `Blob ${ref.objectId} failed terminal integrity verification`,
              }),
            ),
          );
        } else {
          settle(Result.ok({ sha256, byteLength }));
        }
        controller.close();
        return;
      }
      const value: unknown = outcome.result.value;
      if (!(value instanceof Uint8Array)) {
        const panic = new Panic({
          message: `Blob ${ref.objectId} source produced a non-byte chunk`,
          cause: value,
        });
        if (reject(panic)) controller.error(panic);
        return;
      }
      const processed = Result.try({
        try: () => {
          hash.update(value);
          byteLength += value.byteLength;
          controller.enqueue(value);
        },
        catch: classifyBlobDefect,
      });
      const processingPanic = processed.match<Panic | null>({
        ok: () => null,
        err: (panic) => panic,
      });
      if (processingPanic !== null && reject(processingPanic)) {
        controller.error(processingPanic);
      }
    },
    async cancel() {
      const failure = new BlobReadCancelled({
        objectId: ref.objectId,
        message: `Blob ${ref.objectId} read was cancelled before verification`,
      });
      settle(Result.err(failure));
      const cancelled = await Result.tryPromise({
        try: async () => reader.cancel(failure.message),
        catch: classifyAdapterCause,
      });
      const cancelPanic = cancelled.match<Panic | null>({
        ok: () => null,
        err: (cancelFailure) => (cancelFailure.kind === "panic" ? cancelFailure.panic : null),
      });
      if (cancelPanic !== null) signalRetainedBlobPanic(cancelPanic);
    },
  });

  return { ref, stream, completion: completion.promise };
}

export async function materializeBlobRead(
  read: BlobRead,
): Promise<ResultType<Uint8Array, BlobReadTerminalError>> {
  const reader = read.stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let terminalReadFailure = false;
  let done = false;
  while (!done && !terminalReadFailure) {
    const captured = await Result.tryPromise({
      try: async () => reader.read(),
      catch: classifyAdapterCause,
    });
    const outcome = captured.match<
      | {
          readonly kind: "read";
          readonly result: Awaited<ReturnType<typeof reader.read>>;
        }
      | { readonly kind: "failure" }
    >({
      ok: (result) => ({ kind: "read", result }),
      err: () => ({ kind: "failure" }),
    });
    if (outcome.kind === "failure") {
      terminalReadFailure = true;
    } else if (outcome.result.done) {
      done = true;
    } else {
      chunks.push(outcome.result.value);
      byteLength += outcome.result.value.byteLength;
    }
  }
  reader.releaseLock();
  const verified = await read.completion;
  return verified.map(() => {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });
}
