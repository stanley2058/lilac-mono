import type {
  BlobHandleV1,
  BlobRefV1,
  BlobResolveError,
  BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";

import { SqliteRequestDeliveryStore, type AcceptedRecoveryRow } from "./sqlite-store";
import {
  REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS,
  RequestDeliveryAdmissionRejected,
  RequestDeliveryDeleteFailed,
  RequestDeliveryPublicationFenceRejected,
  RequestDeliveryResolutionFailed,
  RequestDeliveryPreparationCleanupFailed,
  type AcceptedRequestDelivery,
  type PreparedRequestDelivery,
  type PrepareAndPublishOutcome,
  type RequestDeliveryAdmission,
  type RequestDeliveryHandleOutcome,
  type RequestDeliveryMaintenanceSummary,
  type RequestDeliveryPublisher,
  type RequestPublicationClaim,
  type RequestDeliveryRecord,
  type RequestDeliveryStoreError,
  type RequestDeliveryTerminalOutcome,
  type RequestDeliveryTerminalizeResult,
  type RequestOutputLifecycle,
  type RequestOutputLifecycleRegistrar,
} from "./types";

export type PreparedPublicationRecoverySummary = {
  readonly published: number;
  readonly alreadyPublished: number;
  readonly ambiguous: number;
  readonly terminalized: number;
  readonly failures: readonly Error[];
};

export type AcceptedRequestRecoveryFailure = {
  readonly requestDeliveryId: string;
  readonly error: Error;
};

/** Failed records stay accepted, so the next recovery pass retries them. */
export type AcceptedRequestRecoverySummary = {
  readonly resumed: number;
  readonly terminalized: number;
  readonly failures: readonly AcceptedRequestRecoveryFailure[];
};

export type RequestDeliveryActivity = {
  requestStarted(requestDeliveryId: string): void;
  requestSettled(requestDeliveryId: string): void;
};

export type RequestDeliveryCoordinatorOptions<TEnvelope, TWork, TOutputMetadata> = {
  readonly store: SqliteRequestDeliveryStore<TEnvelope, TWork, TOutputMetadata>;
  readonly blobStore: Pick<BlobStore, "resolve" | "delete">;
  readonly admission: RequestDeliveryAdmission<TEnvelope, TWork>;
  readonly now?: () => number;
  readonly isResolveTimeout?: (error: BlobResolveError) => boolean;
  readonly logger?: RequestDeliveryLogger;
  readonly activity?: RequestDeliveryActivity;
  readonly inputBlobRetained?: (objectId: string) => ResultType<boolean, Error>;
};

export type RequestDeliveryLogger = {
  debug(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
  error(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
};

function taggedErrorName(error: Error): string {
  return error.name;
}

function defaultIsResolveTimeout(error: BlobResolveError): boolean {
  return taggedErrorName(error).toLowerCase().includes("timeout");
}

export class RequestDeliveryCoordinator<
  TEnvelope,
  TWork,
  TOutputMetadata,
> implements RequestOutputLifecycleRegistrar<TOutputMetadata> {
  readonly #store: SqliteRequestDeliveryStore<TEnvelope, TWork, TOutputMetadata>;
  readonly #blobStore: Pick<BlobStore, "resolve" | "delete">;
  readonly #admission: RequestDeliveryAdmission<TEnvelope, TWork>;
  readonly #now: () => number;
  readonly #isResolveTimeout: (error: BlobResolveError) => boolean;
  readonly #logger?: RequestDeliveryLogger;
  readonly #activity?: RequestDeliveryActivity;
  readonly #inputBlobRetained?: (objectId: string) => ResultType<boolean, Error>;

  constructor(options: RequestDeliveryCoordinatorOptions<TEnvelope, TWork, TOutputMetadata>) {
    this.#store = options.store;
    this.#blobStore = options.blobStore;
    this.#admission = options.admission;
    this.#now = options.now ?? Date.now;
    this.#isResolveTimeout = options.isResolveTimeout ?? defaultIsResolveTimeout;
    this.#logger = options.logger;
    this.#activity = options.activity;
    this.#inputBlobRetained = options.inputBlobRetained;
  }

  async prepareAndPublish(
    input: {
      readonly requestDeliveryId: string;
      readonly requestId: string;
      readonly envelope: TEnvelope;
      readonly inputHandles: readonly BlobHandleV1[];
    },
    publisher: RequestDeliveryPublisher<TEnvelope>,
  ): Promise<ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>> {
    const prepared = this.#store.prepare({ ...input, createdAt: this.#now() });
    return prepared.match<
      () => Promise<
        ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>
      >
    >({
      err: (error) => async () => {
        const ownership = this.#store.load(input.requestDeliveryId).match<
          | {
              readonly kind: "owned";
              readonly record: RequestDeliveryRecord<TEnvelope, TWork>;
            }
          | { readonly kind: "missing" }
          | { readonly kind: "uncertain" }
        >({
          ok: (record) => ({ kind: "owned", record }),
          err: (loadError) =>
            loadError.name === "RequestDeliveryNotFound"
              ? { kind: "missing" }
              : { kind: "uncertain" },
        });
        if (ownership.kind === "owned") {
          if (!ownership.record.publication) return Result.err(error);
          return this.#publishPrepared(ownership.record, publisher);
        }
        if (ownership.kind === "uncertain") return Result.err(error);
        const cleanupFailures = await this.#deleteUnownedHandles({
          requestDeliveryId: input.requestDeliveryId,
          handles: input.inputHandles,
        });
        return cleanupFailures.length === 0
          ? Result.err(error)
          : Result.err(
              new RequestDeliveryPreparationCleanupFailed({
                requestDeliveryId: input.requestDeliveryId,
                prepareError: error,
                cleanupFailures,
                message:
                  "Request preparation failed and one or more input handles could not be deleted",
              }),
            );
      },
      ok:
        ({ record }) =>
        async () =>
          this.#publishPrepared(record, publisher),
    })();
  }

  async #publishPrepared(
    sourceRecord: RequestDeliveryRecord<TEnvelope, TWork>,
    publisher: RequestDeliveryPublisher<TEnvelope>,
  ): Promise<ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>> {
    const acquired = await publisher.acquire({
      requestDeliveryId: sourceRecord.requestDeliveryId,
    });
    const acquisition = acquired.match<
      | { readonly kind: "acquired"; readonly claim: RequestPublicationClaim }
      | { readonly kind: "contended" }
      | { readonly kind: "error"; readonly error: Error }
    >({
      err: (error) => ({ kind: "error", error }),
      ok: (outcome) =>
        outcome.status === "acquired"
          ? { kind: "acquired", claim: outcome.claim }
          : { kind: "contended" },
    });
    if (acquisition.kind === "error") {
      return Result.ok({
        status: "ambiguous",
        record: sourceRecord,
        publicationError: acquisition.error,
      });
    }
    if (acquisition.kind === "contended") {
      return Result.ok({
        status: "ambiguous",
        record: sourceRecord,
        publicationError: new RequestDeliveryPublicationFenceRejected({
          requestDeliveryId: sourceRecord.requestDeliveryId,
          stage: "claim",
          outcome: "contended",
          message: "Another producer owns the live request publication claim",
        }),
      });
    }

    const refreshed = this.#store.load(sourceRecord.requestDeliveryId);
    const current = refreshed.match<
      | { readonly kind: "record"; readonly record: RequestDeliveryRecord<TEnvelope, TWork> }
      | { readonly kind: "error"; readonly error: RequestDeliveryStoreError }
    >({
      err: (error) => ({ kind: "error", error }),
      ok: (record) => ({ kind: "record", record }),
    });
    if (current.kind === "error") {
      await publisher.abandon({ claim: acquisition.claim });
      return Result.err(current.error);
    }
    if (current.record.publication) {
      return this.#confirmRecordedPublication({
        claim: acquisition.claim,
        publisher,
        record: current.record,
        status: "already-published",
        streamId: current.record.publication.streamId,
      });
    }
    if (current.record.state !== "prepared") {
      await publisher.abandon({ claim: acquisition.claim });
      return Result.ok({
        status: "ambiguous",
        record: current.record,
        publicationError: new RequestDeliveryPublicationFenceRejected({
          requestDeliveryId: current.record.requestDeliveryId,
          stage: "claim",
          outcome: `record-${current.record.state}-without-publication`,
          message: "Request publication claim observed a non-prepared record without a receipt",
        }),
      });
    }

    const published = await publisher.publish({
      requestDeliveryId: current.record.requestDeliveryId,
      envelope: current.record.envelope,
      claim: acquisition.claim,
    });
    return published.match<
      () => Promise<
        ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>
      >
    >({
      err: (publicationError) => async () => {
        const reconciled = this.#store
          .load(current.record.requestDeliveryId)
          .match<
            | { readonly kind: "record"; readonly record: RequestDeliveryRecord<TEnvelope, TWork> }
            | { readonly kind: "missing" }
          >({
            err: () => ({ kind: "missing" }),
            ok: (record) => ({ kind: "record", record }),
          });
        if (reconciled.kind === "record" && reconciled.record.publication) {
          return this.#confirmRecordedPublication({
            claim: acquisition.claim,
            publisher,
            record: reconciled.record,
            status: "already-published",
            streamId: reconciled.record.publication.streamId,
          });
        }
        const abandoned = await publisher.abandon({ claim: acquisition.claim });
        const abandonOutcome = abandoned.match<
          | { readonly kind: "outcome"; readonly outcome: string }
          | { readonly kind: "error"; readonly error: Error }
        >({
          err: (error) => ({ kind: "error", error }),
          ok: (outcome) => ({ kind: "outcome", outcome }),
        });
        if (abandonOutcome.kind === "error" || abandonOutcome.outcome !== "abandoned") {
          return Result.ok({
            status: "ambiguous",
            record: current.record,
            publicationError:
              abandonOutcome.kind === "error" ? abandonOutcome.error : publicationError,
          });
        }
        const failure = publisher.classifyFailure(publicationError);
        if (failure.certainty === "ambiguous") {
          return Result.ok({
            status: "ambiguous",
            record: current.record,
            publicationError,
          });
        }
        const terminalized = await this.terminalize({
          requestDeliveryId: current.record.requestDeliveryId,
          outcome: { kind: "publication-failed", code: failure.code },
          transportCommitRequired: false,
        });
        return terminalized.map(({ record }) => ({
          status: "terminalized" as const,
          record,
          publicationError,
        }));
      },
      ok: (receipt) => async () => {
        const recorded = this.#store.recordPublication({
          requestDeliveryId: current.record.requestDeliveryId,
          streamId: receipt.streamId,
          recordedAt: this.#now(),
        });
        return recorded.match<
          () => Promise<
            ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>
          >
        >({
          err: (error) => async () => Result.err(error),
          ok: (record) => async () =>
            this.#confirmRecordedPublication({
              claim: acquisition.claim,
              publisher,
              record,
              status: "published",
              streamId: receipt.streamId,
            }),
        })();
      },
    })();
  }

  async #confirmRecordedPublication(input: {
    readonly claim: RequestPublicationClaim;
    readonly publisher: RequestDeliveryPublisher<TEnvelope>;
    readonly record: RequestDeliveryRecord<TEnvelope, TWork>;
    readonly status: "already-published" | "published";
    readonly streamId: string;
  }): Promise<ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>> {
    const confirmed = await input.publisher.confirm({
      claim: input.claim,
      streamId: input.streamId,
    });
    return confirmed.match<
      ResultType<PrepareAndPublishOutcome<TEnvelope, TWork>, RequestDeliveryStoreError>
    >({
      err: (publicationError) =>
        Result.ok({
          status: "ambiguous" as const,
          record: input.record,
          publicationError,
        }),
      ok: (outcome) =>
        outcome === "confirmed" || outcome === "absent"
          ? Result.ok({ status: input.status, record: input.record })
          : Result.ok({
              status: "ambiguous" as const,
              record: input.record,
              publicationError: new RequestDeliveryPublicationFenceRejected({
                requestDeliveryId: input.record.requestDeliveryId,
                stage: "confirmation",
                outcome,
                message: "Request publication confirmation did not match the live fenced claim",
              }),
            }),
    });
  }

  /**
   * Durable delivery boundary. Accepted and terminal records return before any
   * blob operation, so Redis redelivery cannot hydrate or apply work twice.
   */
  async handleDelivery(
    requestDeliveryId: string,
  ): Promise<ResultType<RequestDeliveryHandleOutcome<TWork>, never>> {
    return this.#store
      .load(requestDeliveryId)
      .match<() => Promise<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>>({
        err: (error) => async () => Result.ok({ disposition: "park", error }),
        ok: (record) => async () => {
          if (record.state === "terminal") {
            return Result.ok({
              disposition: "commit",
              reason: "already-terminal",
            });
          }
          if (record.state === "accepted") {
            return Result.ok({
              disposition: "commit",
              reason: "already-accepted",
            });
          }
          this.#activity?.requestStarted(requestDeliveryId);
          const handled = await this.#handlePrepared(record);
          const parked = handled.match({
            ok: (outcome) => outcome.disposition === "park",
            err: () => false,
          });
          if (parked) this.#activity?.requestSettled(requestDeliveryId);
          return handled;
        },
      })();
  }

  registerOutputHandle(input: {
    readonly requestDeliveryId: string;
    readonly handle: BlobHandleV1;
    readonly metadata: TOutputMetadata;
  }): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> {
    return this.#store.registerOutputHandle({
      ...input,
      createdAt: this.#now(),
    });
  }

  recordOutputReference(input: {
    readonly requestDeliveryId: string;
    readonly reference: BlobRefV1;
  }): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> {
    return this.#store.recordOutputReference(input);
  }

  replaceAcceptedWork(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly work: TWork;
  }): ResultType<AcceptedRequestDelivery<TWork>, RequestDeliveryStoreError> {
    return this.#store.replaceAcceptedWork(input);
  }

  observeTransportCommit(
    requestDeliveryId: string,
    streamId?: string,
  ): ResultType<void, RequestDeliveryStoreError> {
    return this.#store.observeTransportCommit({
      requestDeliveryId,
      ...(streamId === undefined ? {} : { streamId }),
      committedAt: this.#now(),
    });
  }

  async terminalize(input: {
    readonly requestDeliveryId: string;
    readonly outcome: RequestDeliveryTerminalOutcome;
    readonly finalReplayDeadline?: number;
    readonly transportCommitRequired?: boolean;
  }): Promise<ResultType<RequestDeliveryTerminalizeResult, RequestDeliveryStoreError>> {
    const terminalized = this.#store.terminalize({
      requestDeliveryId: input.requestDeliveryId,
      outcome: input.outcome,
      terminalAt: this.#now(),
      transportCommitRequired: input.transportCommitRequired ?? true,
      ...(input.finalReplayDeadline === undefined
        ? {}
        : { finalReplayDeadline: input.finalReplayDeadline }),
    });
    return terminalized.match<
      () => Promise<ResultType<RequestDeliveryTerminalizeResult, RequestDeliveryStoreError>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (value) => async () => {
        this.#activity?.requestSettled(input.requestDeliveryId);
        await this.#deleteInputTargets(value.record);
        return Result.ok(value);
      },
    })();
  }

  async recoverPreparedPublications(
    publisher: RequestDeliveryPublisher<TEnvelope>,
    input?: { readonly limit?: number },
  ): Promise<ResultType<PreparedPublicationRecoverySummary, RequestDeliveryStoreError>> {
    let published = 0;
    let alreadyPublished = 0;
    let ambiguous = 0;
    let terminalized = 0;
    const failures: Error[] = [];
    const limit = Math.max(1, Math.min(1_000, input?.limit ?? 100));
    let after: { readonly createdAt: number; readonly requestDeliveryId: string } | undefined;
    for (;;) {
      const selected = this.#store.listPreparedForPublication({
        limit,
        ...(after ? { after } : {}),
      });
      const page = selected.match<
        | {
            readonly kind: "records";
            readonly records: readonly PreparedRequestDelivery<TEnvelope>[];
          }
        | { readonly kind: "error"; readonly error: RequestDeliveryStoreError }
      >({
        ok: (records) => ({ kind: "records", records }),
        err: (error) => ({ kind: "error", error }),
      });
      if (page.kind === "error") return Result.err(page.error);
      for (const record of page.records) {
        const recovery = await this.#publishPrepared(record, publisher);
        recovery.match({
          err: (error) => failures.push(error),
          ok: (outcome) => {
            if (outcome.status === "published") published += 1;
            if (outcome.status === "already-published") alreadyPublished += 1;
            if (outcome.status === "terminalized") terminalized += 1;
            if (outcome.status === "ambiguous") ambiguous += 1;
            if (outcome.publicationError) failures.push(outcome.publicationError);
          },
        });
      }
      const last = page.records.at(-1);
      if (!last || page.records.length < limit) break;
      after = {
        createdAt: last.createdAt,
        requestDeliveryId: last.requestDeliveryId,
      };
    }
    return Result.ok({
      published,
      alreadyPublished,
      ambiguous,
      terminalized,
      failures,
    });
  }

  async recoverAccepted(
    resume: (record: AcceptedRequestDelivery<TWork>) => Promise<ResultType<void, Error>>,
    input?: {
      readonly limit?: number;
      readonly prepareTerminalRecovery?: (
        record: AcceptedRequestDelivery<TWork>,
      ) => Promise<ResultType<void, Error>>;
      readonly terminalRecovery?: (record: AcceptedRequestDelivery<TWork>) =>
        | {
            readonly outcome: RequestDeliveryTerminalOutcome;
            readonly finalReplayDeadline?: number;
          }
        | undefined;
    },
  ): Promise<ResultType<AcceptedRequestRecoverySummary, RequestDeliveryStoreError>> {
    let resumed = 0;
    let terminalized = 0;
    const failures: AcceptedRequestRecoveryFailure[] = [];
    const limit = Math.max(1, Math.min(1_000, input?.limit ?? 100));
    let after: { readonly acceptedAt: number; readonly requestDeliveryId: string } | undefined;
    for (;;) {
      const selected = this.#store.listAcceptedForRecovery({
        limit,
        ...(after ? { after } : {}),
      });
      const page = selected.match<
        | {
            readonly kind: "rows";
            readonly rows: readonly AcceptedRecoveryRow<TWork>[];
          }
        | { readonly kind: "error"; readonly error: RequestDeliveryStoreError }
      >({
        ok: (rows) => ({ kind: "rows", rows }),
        err: (error) => ({ kind: "error", error }),
      });
      if (page.kind === "error") return Result.err(page.error);
      for (const row of page.rows) {
        const decoded = row.record.match<
          | { readonly kind: "record"; readonly record: AcceptedRequestDelivery<TWork> }
          | { readonly kind: "error"; readonly error: Error }
        >({
          ok: (record) => ({ kind: "record", record }),
          err: (error) => ({ kind: "error", error }),
        });
        if (decoded.kind === "error") {
          failures.push({ requestDeliveryId: row.requestDeliveryId, error: decoded.error });
          continue;
        }
        const { record } = decoded;
        const terminalRecovery = input?.terminalRecovery?.(record);
        if (terminalRecovery) {
          if (input?.prepareTerminalRecovery) {
            const prepared = await input.prepareTerminalRecovery(record);
            const prepareError = prepared.match({
              ok: () => null,
              err: (error) => error,
            });
            if (prepareError) {
              failures.push({ requestDeliveryId: record.requestDeliveryId, error: prepareError });
              continue;
            }
          }
          const recoveredTerminal = await this.terminalize({
            requestDeliveryId: record.requestDeliveryId,
            outcome: terminalRecovery.outcome,
            ...(terminalRecovery.finalReplayDeadline === undefined
              ? {}
              : { finalReplayDeadline: terminalRecovery.finalReplayDeadline }),
            transportCommitRequired: true,
          });
          const terminalError = recoveredTerminal.match({
            ok: () => null,
            err: (error) => error,
          });
          if (terminalError) {
            failures.push({ requestDeliveryId: record.requestDeliveryId, error: terminalError });
          } else {
            terminalized += 1;
          }
          continue;
        }
        this.#activity?.requestStarted(record.requestDeliveryId);
        const result = await resume(record);
        const resumeError = result.match({
          err: (error) => error,
          ok: () => null,
        });
        if (resumeError) {
          this.#activity?.requestSettled(record.requestDeliveryId);
          failures.push({ requestDeliveryId: record.requestDeliveryId, error: resumeError });
          continue;
        }
        resumed += 1;
      }
      const last = page.rows.at(-1);
      if (!last || page.rows.length < limit) break;
      after = {
        acceptedAt: last.acceptedAt,
        requestDeliveryId: last.requestDeliveryId,
      };
    }
    return Result.ok({ resumed, terminalized, failures });
  }

  async maintain(input?: {
    readonly now?: number;
    readonly limit?: number;
  }): Promise<ResultType<RequestDeliveryMaintenanceSummary, RequestDeliveryStoreError>> {
    const now = input?.now ?? this.#now();
    const limit = input?.limit;
    const inputRecords = this.#store.listPendingInputCleanup({ limit });
    return inputRecords.match<
      () => Promise<ResultType<RequestDeliveryMaintenanceSummary, RequestDeliveryStoreError>>
    >({
      err: (error) => async () => Result.err(error),
      ok: (records) => async () => {
        let inputObjectsDeleted = 0;
        let outputObjectsDeleted = 0;
        const failures: RequestDeliveryDeleteFailed[] = [];
        for (const record of records) {
          const summary = await this.#deleteInputTargets(record);
          inputObjectsDeleted += summary.deleted;
          failures.push(...summary.failures);
        }

        const due = this.#store.listDueOutputs({ now, limit });
        const continueDue = due.match<() => Promise<ResultType<void, RequestDeliveryStoreError>>>({
          err: (error) => async () => Result.err(error),
          ok: (outputs) => async () => {
            for (const output of outputs) {
              const deleted = await this.#blobStore.delete(output.target.blob);
              const continueDeleted = deleted.match<
                () => ResultType<void, RequestDeliveryStoreError>
              >({
                err: (error) => () => {
                  failures.push(
                    new RequestDeliveryDeleteFailed({
                      requestDeliveryId: output.requestDeliveryId,
                      objectId: output.target.blob.objectId,
                      message: `Output blob deletion failed: ${taggedErrorName(error)}`,
                    }),
                  );
                  return Result.ok(undefined);
                },
                ok: () => () =>
                  this.#store
                    .markOutputDeleted({
                      requestDeliveryId: output.requestDeliveryId,
                      objectId: output.target.blob.objectId,
                    })
                    .map(() => {
                      outputObjectsDeleted += 1;
                    }),
              });
              const marked = continueDeleted();
              const storeError = marked.match({
                err: (error) => error,
                ok: () => undefined,
              });
              if (storeError) return Result.err(storeError);
            }
            return Result.ok(undefined);
          },
        });
        const dueResult = await continueDue();
        const dueError = dueResult.match({
          err: (error) => error,
          ok: () => undefined,
        });
        if (dueError) return Result.err(dueError);

        return this.#store.deleteEligibleTombstones({ limit }).map((tombstonesDeleted) => ({
          inputObjectsDeleted,
          outputObjectsDeleted,
          tombstonesDeleted,
          failures,
        }));
      },
    })();
  }

  async #handlePrepared(
    record: PreparedRequestDelivery<TEnvelope>,
  ): Promise<ResultType<RequestDeliveryHandleOutcome<TWork>, never>> {
    const resolutions = await Promise.all(
      record.inputHandles.map(async (handle) => {
        const result = await this.#blobStore.resolve(handle, {
          timeoutMs: REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS,
        });
        return result.mapError(
          (resolutionError) =>
            new RequestDeliveryResolutionFailed({
              requestDeliveryId: record.requestDeliveryId,
              objectId: handle.objectId,
              resolutionError,
              message: "Request input blob did not resolve before durable admission",
            }),
        );
      }),
    );
    const resolved = Result.all(resolutions);
    return resolved.match<() => Promise<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>>({
      err: (error) => async () => {
        const kind = this.#isResolveTimeout(error.resolutionError)
          ? "upload-timeout"
          : "upload-failed";
        this.#logger?.error("request canceled after input blob upload failed", {
          requestDeliveryId: record.requestDeliveryId,
          requestId: record.requestId,
          objectId: error.objectId,
          outcome: kind,
          errorClass: taggedErrorName(error.resolutionError),
          errorMessage: error.resolutionError.message,
        });
        const terminalized = await this.terminalize({
          requestDeliveryId: record.requestDeliveryId,
          outcome: { kind, code: taggedErrorName(error.resolutionError) },
          transportCommitRequired: true,
        });
        return terminalized.match<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>({
          err: (terminalError) => Result.ok({ disposition: "park", error: terminalError } as const),
          ok: () =>
            Result.ok({
              disposition: "commit",
              reason: "terminalized",
            } as const),
        });
      },
      ok: (inputReferences) => async () => {
        this.#logger?.debug("request input blobs resolved", {
          requestDeliveryId: record.requestDeliveryId,
          requestId: record.requestId,
          inputBlobCount: inputReferences.length,
        });
        const admitted = await this.#admission.validateAndBuildWork({
          requestDeliveryId: record.requestDeliveryId,
          requestId: record.requestId,
          envelope: record.envelope,
          inputReferences,
        });
        return admitted.match<
          () => Promise<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>
        >({
          err: (rejection) => async () => {
            if (rejection.disposition === "park") {
              return Result.ok({ disposition: "park", error: rejection });
            }
            const terminalized = await this.terminalize({
              requestDeliveryId: record.requestDeliveryId,
              outcome: { kind: "failed", code: rejection.code },
              transportCommitRequired: true,
            });
            return terminalized.match<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>({
              err: (terminalError) =>
                Result.ok({
                  disposition: "park",
                  error: terminalError,
                } as const),
              ok: () =>
                Result.ok({
                  disposition: "commit",
                  reason: "terminalized",
                } as const),
            });
          },
          ok: (work) => async () =>
            this.#store
              .accept({
                requestDeliveryId: record.requestDeliveryId,
                work,
                inputReferences,
                acceptedAt: this.#now(),
              })
              .match<ResultType<RequestDeliveryHandleOutcome<TWork>, never>>({
                err: (error) => Result.ok({ disposition: "park", error } as const),
                ok: ({ record: accepted }) =>
                  Result.ok({
                    disposition: "accepted",
                    record: accepted,
                    source: "new",
                  } as const),
              }),
        })();
      },
    })();
  }

  async #deleteInputBlob(
    blob: BlobHandleV1 | BlobRefV1,
  ): Promise<ResultType<"deleted" | "absent" | "retained", Error>> {
    return Result.gen(async function* (
      this: RequestDeliveryCoordinator<TEnvelope, TWork, TOutputMetadata>,
    ) {
      const retained = yield* this.#inputBlobRetained?.(blob.objectId) ?? Result.ok(false);
      if (retained) return Result.ok("retained" as const);
      return await this.#blobStore.delete(blob);
    }, this);
  }

  async #deleteInputTargets(record: {
    readonly requestDeliveryId: string;
    readonly inputCleanupPending: readonly {
      readonly blob: BlobHandleV1 | BlobRefV1;
    }[];
  }): Promise<{
    readonly deleted: number;
    readonly failures: RequestDeliveryDeleteFailed[];
  }> {
    let deleted = 0;
    const failures: RequestDeliveryDeleteFailed[] = [];
    for (const target of record.inputCleanupPending) {
      const result = await this.#deleteInputBlob(target.blob);
      const continueResult = result.match<() => void>({
        err: (error) => () => {
          failures.push(
            new RequestDeliveryDeleteFailed({
              requestDeliveryId: record.requestDeliveryId,
              objectId: target.blob.objectId,
              message: `Request input blob deletion failed: ${taggedErrorName(error)}`,
            }),
          );
        },
        ok: (outcome) => () => {
          const marked = this.#store.markInputObjectDeleted({
            requestDeliveryId: record.requestDeliveryId,
            objectId: target.blob.objectId,
          });
          marked.match({
            err: (error) =>
              failures.push(
                new RequestDeliveryDeleteFailed({
                  requestDeliveryId: record.requestDeliveryId,
                  objectId: target.blob.objectId,
                  message: `Request input cleanup acknowledgement failed: ${taggedErrorName(error)}`,
                }),
              ),
            ok: () => {
              if (outcome !== "retained") deleted += 1;
            },
          });
        },
      });
      continueResult();
    }
    return { deleted, failures };
  }

  async #deleteUnownedHandles(input: {
    readonly requestDeliveryId: string;
    readonly handles: readonly BlobHandleV1[];
  }): Promise<readonly RequestDeliveryDeleteFailed[]> {
    const failures: RequestDeliveryDeleteFailed[] = [];
    const objectIds = new Set<string>();
    for (const handle of input.handles) {
      if (objectIds.has(handle.objectId)) continue;
      objectIds.add(handle.objectId);
      const deleted = await this.#blobStore.delete(handle);
      deleted.match({
        ok: () => undefined,
        err: (error) =>
          failures.push(
            new RequestDeliveryDeleteFailed({
              requestDeliveryId: input.requestDeliveryId,
              objectId: handle.objectId,
              message: `Unowned request input deletion failed: ${taggedErrorName(error)}`,
            }),
          ),
      });
    }
    return failures;
  }
}

export function terminalAdmissionRejection(input: {
  readonly requestDeliveryId: string;
  readonly code: string;
  readonly message: string;
}): RequestDeliveryAdmissionRejected {
  return new RequestDeliveryAdmissionRejected({
    ...input,
    disposition: "terminal",
  });
}

export function parkedAdmissionRejection(input: {
  readonly requestDeliveryId: string;
  readonly code: string;
  readonly message: string;
}): RequestDeliveryAdmissionRejected {
  return new RequestDeliveryAdmissionRejected({
    ...input,
    disposition: "park",
  });
}
