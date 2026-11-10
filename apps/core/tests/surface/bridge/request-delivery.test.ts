import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BlobIntegrityFailure,
  BlobResolveTimeout,
  BlobUploadFailed,
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobHandleV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type RawMessageDecodeOutcome,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import {
  REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS,
  RequestDeliveryCoordinator,
  RequestDeliveryAdmissionRejected,
  RequestDeliverySqliteFailure,
  SqliteRequestDeliveryStore,
  collectCoreRequestInputHandles,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  createRequestDeliveryPostCommitObserver,
  type CorePreparedRequestEnvelope,
  type CoreRequestOutputMetadata,
  type CoreAcceptedRequestWork,
  type RequestDeliveryPublisher,
} from "../../../src/surface/bridge/request-delivery";

import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";

function value<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match({
    ok: (resultValue) => resultValue,
    err: (error) => {
      throw error;
    },
  });
}

async function resultValue<T, E extends Error>(result: Promise<ResultType<T, E>>): Promise<T> {
  return value(await result);
}

async function memoryBlobStore(): Promise<BlobStore> {
  return resultValue(createMemoryBlobStore());
}

function createStore() {
  return new SqliteRequestDeliveryStore<
    CorePreparedRequestEnvelope,
    CoreAcceptedRequestWork,
    CoreRequestOutputMetadata
  >({
    dbPath: ":memory:",
    codecs: coreRequestDeliveryCodecs,
  });
}

function envelope(input: {
  requestDeliveryId: string;
  requestId: string;
  handle?: BlobHandleV1;
}): CorePreparedRequestEnvelope {
  return {
    headers: {
      request_id: input.requestId,
      session_id: "session-1",
      request_client: "discord",
    },
    data: {
      requestDeliveryId: input.requestDeliveryId,
      queue: "prompt",
      messages: [
        {
          role: "user",
          content: input.handle
            ? [
                { type: "text", text: "inspect" },
                {
                  type: "blob",
                  blob: input.handle,
                  mediaType: "text/plain",
                  filename: "input.txt",
                },
              ]
            : "hello",
        },
      ],
    },
  };
}

function coordinator(input: {
  store: ReturnType<typeof createStore>;
  blobStore: Pick<BlobStore, "resolve" | "open" | "delete">;
  now?: () => number;
  inputBlobRetained?: (objectId: string) => ResultType<boolean, Error>;
  activity?: { requestStarted(id: string): void; requestSettled(id: string): void };
  logger?: {
    debug(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
    error(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
  };
}) {
  return new RequestDeliveryCoordinator({
    store: input.store,
    blobStore: input.blobStore,
    admission: createCoreRequestDeliveryAdmission(input.blobStore),
    activity: input.activity,
    inputBlobRetained: input.inputBlobRetained,
    ...(input.now ? { now: input.now } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

function publicationClaimMethods() {
  return {
    async acquire(input: { readonly requestDeliveryId: string }) {
      return Result.ok({
        status: "acquired" as const,
        claim: {
          requestDeliveryId: input.requestDeliveryId,
          token: crypto.randomUUID(),
        },
      });
    },
    async confirm() {
      return Result.ok("confirmed" as const);
    },
    async abandon() {
      return Result.ok("abandoned" as const);
    },
  };
}

describe("durable request delivery", () => {
  test("hands retained input blobs to transcript ownership when the request ends", async () => {
    const store = createStore();
    const transcripts = new SqliteTranscriptStore(":memory:");
    const blobs = await memoryBlobStore();
    try {
      const upload = value(
        await blobs.startUpload({
          source: new TextEncoder().encode("retained image"),
          retention: { kind: "durable" },
        }),
      );
      const ref = value(await blobs.resolve(upload.handle, { timeoutMs: 1_000 }));
      const id = crypto.randomUUID();
      value(
        store.prepare({
          requestDeliveryId: id,
          requestId: "retained",
          envelope: envelope({
            requestDeliveryId: id,
            requestId: "retained",
            handle: upload.handle,
          }),
          inputHandles: [upload.handle],
          createdAt: 1,
        }),
      );
      let ownershipAvailable = false;
      const delivery = coordinator({
        store,
        blobStore: blobs,
        inputBlobRetained: (id) =>
          ownershipAvailable
            ? transcripts.readCoreOwnedBlob(id).map((blob) => blob !== null)
            : Result.err(new Error("Ownership lookup unavailable")),
      });
      const accepted = value(await delivery.handleDelivery(id));
      if (accepted.disposition !== "accepted") throw new Error("Expected admission");
      value(
        transcripts.saveRequestTranscript({
          requestId: "retained",
          sessionId: "session-1",
          requestClient: "discord",
          messages: accepted.record.work.data.messages,
        }),
      );
      value(await delivery.terminalize({ requestDeliveryId: id, outcome: { kind: "completed" } }));
      expect(value(store.load(id)).state).toBe("terminal");
      expect(value(await blobs.resolve(upload.handle, { timeoutMs: 1_000 }))).toEqual(ref);
      expect(value(await delivery.maintain()).failures).toHaveLength(1);
      ownershipAvailable = true;
      expect(value(await delivery.maintain()).failures).toEqual([]);
      expect(
        value(
          await transcripts.maintainCoreOwnedBlobs({
            blobStore: blobs,
            limit: 10,
            now: Date.now() + 600_000,
          }),
        ).deleted,
      ).toBe(0);
      const read = value(await blobs.open(ref));
      expect(new TextDecoder().decode(value(await materializeBlobRead(read)))).toBe(
        "retained image",
      );
    } finally {
      transcripts.close();
      store.close();
      await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
    }
  });

  test("tracks delivery activity before admission, across recovery, and through terminal outcomes", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const events: string[] = [];
    const activity = {
      requestStarted: (id: string) => {
        events.push(`start:${id}`);
      },
      requestSettled: (id: string) => {
        events.push(`settle:${id}`);
      },
    };
    const ids = new Map<string, string>();
    const delivery = coordinator({ store, blobStore: blobs, activity });
    for (const kind of ["completed", "cancelled", "abandoned"] as const) {
      const id = crypto.randomUUID();
      ids.set(kind, id);
      value(
        store.prepare({
          requestDeliveryId: id,
          requestId: kind,
          envelope: envelope({ requestDeliveryId: id, requestId: kind }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
      const pending = delivery.handleDelivery(id);
      expect(events.at(-1)).toBe(`start:${id}`);
      expect(value(await pending).disposition).toBe("accepted");
      value(await delivery.handleDelivery(id));
    }
    events.length = 0;
    const recovered = coordinator({ store, blobStore: blobs, activity });
    value(
      await recovered.recoverAccepted(async (record) => {
        expect(events.at(-1)).toBe(`start:${record.requestDeliveryId}`);
        return Result.ok(undefined);
      }),
    );
    expect(events).toHaveLength(3);
    for (const kind of ["completed", "cancelled", "abandoned"] as const) {
      const id = ids.get(kind)!;
      value(await recovered.terminalize({ requestDeliveryId: id, outcome: { kind } }));
      expect(events.at(-1)).toBe(`settle:${id}`);
      const count = events.length;
      value(await recovered.handleDelivery(id));
      expect(events).toHaveLength(count);
    }
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("releases presence inhibition when admission parks or recovery fails", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const id = crypto.randomUUID();
    const active = new Set<string>();
    const activity = {
      requestStarted: (id: string) => {
        active.add(id);
      },
      requestSettled: (id: string) => {
        active.delete(id);
      },
    };
    value(
      store.prepare({
        requestDeliveryId: id,
        requestId: "parked",
        envelope: envelope({ requestDeliveryId: id, requestId: "parked" }),
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const parked = new RequestDeliveryCoordinator({
      store,
      blobStore: blobs,
      activity,
      admission: {
        async validateAndBuildWork() {
          expect(active.has(id)).toBe(true);
          return Result.err(
            new RequestDeliveryAdmissionRejected({
              requestDeliveryId: id,
              disposition: "park",
              code: "test-park",
              message: "Admission unavailable",
            }),
          );
        },
      },
    });
    expect(value(await parked.handleDelivery(id)).disposition).toBe("park");
    expect(active.size).toBe(0);
    const delivery = coordinator({ store, blobStore: blobs, activity });
    expect(value(await delivery.handleDelivery(id)).disposition).toBe("accepted");
    expect(active.has(id)).toBe(true);
    active.clear();
    value(await delivery.handleDelivery(id));
    expect(active.size).toBe(0);
    const recoveryError = new Error("Recovery unavailable");
    const summary = value(
      await delivery.recoverAccepted(async () => {
        expect(active.has(id)).toBe(true);
        return Result.err(recoveryError);
      }),
    );
    expect(summary.failures).toEqual([{ requestDeliveryId: id, error: recoveryError }]);
    expect(active.size).toBe(0);
    value(await delivery.recoverAccepted(async () => Result.ok(undefined)));
    expect(active.has(id)).toBe(true);
    value(await delivery.terminalize({ requestDeliveryId: id, outcome: { kind: "completed" } }));
    expect(active.size).toBe(0);
    active.add(id);
    const load = spyOn(store, "load").mockReturnValue(
      Result.err(
        new RequestDeliverySqliteFailure({
          operation: "load",
          code: "SQLITE_BUSY",
          message: "Database busy",
        }),
      ),
    );
    expect(value(await delivery.handleDelivery(id)).disposition).toBe("park");
    expect(active.has(id)).toBe(true);
    load.mockRestore();
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("routes every cmd.request on the Core bus through a prepared record", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    const requestDeliveryId = crypto.randomUUID();
    let observedPrepared = false;
    let publishedCount = 0;
    const raw: RawBus = {
      async publish<TData>(_message: PublishMessage<TData>, _options: PublishOptions) {
        return { id: "ordinary-1", cursor: "ordinary-1" };
      },
      async acquireRequestPublicationClaim(requestDeliveryId) {
        return {
          status: "acquired",
          claim: { requestDeliveryId, token: crypto.randomUUID() },
        };
      },
      async publishClaimedRequest() {
        publishedCount += 1;
        observedPrepared = value(store.load(requestDeliveryId)).state === "prepared";
        return {
          status: "published",
          receipt: { id: "100-0", cursor: "100-0" },
        };
      },
      async confirmRequestPublication() {
        return "confirmed";
      },
      async abandonRequestPublicationClaim() {
        return "abandoned";
      },
      async subscribe(_topic: string, _options: SubscriptionOptions, _handler: RawDeliveryHandler) {
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
      async fetch(
        _topic: string,
        _options: FetchOptions,
      ): Promise<{
        messages: Array<{ msg: RawMessageDecodeOutcome; cursor: string }>;
        next?: string;
      }> {
        return { messages: [] };
      },
      async close() {},
    };
    const transportBus = createLilacBus(raw);
    const durableBus = createDurableCoreRequestBus({
      transportBus,
      coordinator: delivery,
      publisher: createLilacBusRequestDeliveryPublisher(transportBus),
    });

    const published = value(
      await durableBus.publish(
        lilacEventTypes.CmdRequestMessage,
        envelope({ requestDeliveryId, requestId: "request-proxy" }).data,
        {
          headers: {
            request_id: "request-proxy",
            session_id: "session-1",
            request_client: "discord",
          },
        },
      ),
    );

    expect(observedPrepared).toBe(true);
    expect(published).toMatchObject({ id: "100-0", topic: "cmd.request" });
    expect(value(store.load(requestDeliveryId)).publication?.streamId).toBe("100-0");
    await durableBus.publish(
      lilacEventTypes.CmdRequestMessage,
      envelope({ requestDeliveryId, requestId: "request-proxy" }).data,
      {
        headers: {
          request_id: "request-proxy",
          session_id: "session-1",
          request_client: "discord",
        },
      },
    );
    expect(publishedCount).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("publishes active cancel, steer, interrupt, and workflow controls with one request ID", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    let publishedCount = 0;
    const raw: RawBus = {
      async publish() {
        return { id: "ordinary-1", cursor: "ordinary-1" };
      },
      async acquireRequestPublicationClaim(requestDeliveryId) {
        return {
          status: "acquired",
          claim: { requestDeliveryId, token: crypto.randomUUID() },
        };
      },
      async publishClaimedRequest() {
        publishedCount += 1;
        const id = `${publishedCount}-0`;
        return { status: "published", receipt: { id, cursor: id } };
      },
      async confirmRequestPublication() {
        return "confirmed";
      },
      async abandonRequestPublicationClaim() {
        return "abandoned";
      },
      async subscribe() {
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
      async fetch() {
        return { messages: [] };
      },
      async close() {},
    };
    const transportBus = createLilacBus(raw);
    const durableBus = createDurableCoreRequestBus({
      transportBus,
      coordinator: delivery,
      publisher: createLilacBusRequestDeliveryPublisher(transportBus),
    });
    const requestId = "discord:active-control-session:request";
    const deliveries = [
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt" as const,
        messages: [{ role: "user" as const, content: "start" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [],
        raw: { cancel: true, requiresActive: true },
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "steer" as const,
        messages: [{ role: "user" as const, content: "change direction" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [{ role: "user" as const, content: "replace active work" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [],
        raw: { cancel: true, cancelQueued: true, requiresActive: false },
        requestClient: "unknown" as const,
      },
    ];

    for (const command of deliveries) {
      const published = await durableBus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: command.requestDeliveryId,
          queue: command.queue,
          messages: command.messages,
          ...("raw" in command ? { raw: command.raw } : {}),
        },
        {
          headers: {
            request_id: requestId,
            session_id: "active-control-session",
            request_client: command.requestClient,
          },
        },
      );
      expect(published.status).toBe("ok");
    }

    expect(publishedCount).toBe(deliveries.length);
    for (const command of deliveries) {
      expect(value(store.load(command.requestDeliveryId))).toMatchObject({
        state: "prepared",
        requestDeliveryId: command.requestDeliveryId,
        requestId,
      });
    }
    for (const command of deliveries) {
      expect(value(await delivery.handleDelivery(command.requestDeliveryId)).disposition).toBe(
        "accepted",
      );
    }
    const output = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("active request output"),
        retention: { kind: "durable" },
      }),
    );
    expect(
      value(
        delivery.registerOutputHandle({
          requestDeliveryId: deliveries[0]!.requestDeliveryId,
          handle: output.handle,
          metadata: { mimeType: "text/plain" },
        }),
      ).requestDeliveryId,
    ).toBe(deliveries[0]!.requestDeliveryId);
    await resultValue(output.completion);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("prepares before publication and recovers an ambiguous publication idempotently", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-1",
    });
    let attempts = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      async publish() {
        attempts += 1;
        return attempts === 1
          ? Result.err(new Error("connection outcome unknown"))
          : Result.ok({ streamId: "100-0" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "transport" }),
    };

    const first = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId: "request-1",
          envelope: preparedEnvelope,
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(first.status).toBe("ambiguous");
    expect(value(store.load(requestDeliveryId)).state).toBe("prepared");

    const recovered = value(await delivery.recoverPreparedPublications(publisher));
    expect(recovered.published).toBe(1);
    const durable = value(store.load(requestDeliveryId));
    expect(durable.state).toBe("prepared");
    expect(durable.publication?.streamId).toBe("100-0");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("reconciles a publication receipt after delivery wins the accept or terminal race", async () => {
    for (const terminalBeforeReceipt of [false, true]) {
      const store = createStore();
      const blobs = await memoryBlobStore();
      const requestDeliveryId = crypto.randomUUID();
      const requestId = `request-publication-race-${terminalBeforeReceipt}`;
      const preparedEnvelope = envelope({ requestDeliveryId, requestId });
      const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
      let publications = 0;
      const confirmations: Array<{
        requestDeliveryId: string;
        streamId: string;
      }> = [];
      const streamId = `race:${terminalBeforeReceipt}`;
      const outcome = value(
        await delivery.prepareAndPublish(
          {
            requestDeliveryId,
            requestId,
            envelope: preparedEnvelope,
            inputHandles: [],
          },
          {
            ...publicationClaimMethods(),
            publish: async () => {
              publications += 1;
              expect(value(await delivery.handleDelivery(requestDeliveryId)).disposition).toBe(
                "accepted",
              );
              value(delivery.observeTransportCommit(requestDeliveryId, streamId));
              if (terminalBeforeReceipt) {
                value(
                  await delivery.terminalize({
                    requestDeliveryId,
                    outcome: {
                      kind: "completed",
                      code: "finished-before-publish-receipt",
                    },
                  }),
                );
              }
              return Result.ok({ streamId });
            },
            classifyFailure: () => ({
              certainty: "ambiguous",
              code: "unexpected",
            }),
            confirm: async ({ claim, streamId }) => {
              confirmations.push({
                requestDeliveryId: claim.requestDeliveryId,
                streamId,
              });
              return Result.ok("confirmed");
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "published",
        record: {
          state: terminalBeforeReceipt ? "terminal" : "accepted",
          requestDeliveryId,
          publication: { streamId },
        },
      });
      expect(publications).toBe(1);
      expect(confirmations).toEqual([{ requestDeliveryId, streamId }]);
      expect(value(await delivery.handleDelivery(requestDeliveryId))).toMatchObject({
        disposition: "commit",
        reason: terminalBeforeReceipt ? "already-terminal" : "already-accepted",
      });
      expect(
        store.recordPublication({
          requestDeliveryId,
          streamId: "different-stream",
          recordedAt: 3,
        }).status,
      ).toBe("error");
      store.close();
      await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
    }
  });

  test("fails closed on confirmation mismatch and reconciles an absent marker under a fresh claim", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-confirmation-mismatch";
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const confirmations = ["mismatch", "absent"] as const;
    let confirmationIndex = 0;
    let publications = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      publish: async () => {
        publications += 1;
        return Result.ok({ streamId: "confirmation:1" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "unexpected" }),
      confirm: async () => Result.ok(confirmations[confirmationIndex++] ?? "fenced"),
    };

    const first = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId,
          envelope: envelope({ requestDeliveryId, requestId }),
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(first).toMatchObject({
      status: "ambiguous",
      publicationError: { name: "RequestDeliveryPublicationFenceRejected" },
    });
    expect(publications).toBe(1);
    expect(value(store.load(requestDeliveryId)).publication?.streamId).toBe("confirmation:1");

    const reconciled = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId,
          envelope: envelope({ requestDeliveryId, requestId }),
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(reconciled.status).toBe("already-published");
    expect(publications).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("retains live input ownership when the same delivery retries after acceptance", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("accepted retry input"),
        retention: { kind: "durable" },
      }),
    );
    const reference = await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-accepted-producer-retry";
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId,
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: preparedEnvelope,
        inputHandles: [upload.handle],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    expect(value(await delivery.handleDelivery(requestDeliveryId)).disposition).toBe("accepted");
    let publications = 0;
    const retried = await delivery.prepareAndPublish(
      {
        requestDeliveryId,
        requestId,
        envelope: preparedEnvelope,
        inputHandles: [upload.handle],
      },
      {
        ...publicationClaimMethods(),
        publish: async () => {
          publications += 1;
          return Result.ok({ streamId: "must-not-publish" });
        },
        classifyFailure: () => ({ certainty: "ambiguous", code: "unexpected" }),
      },
    );
    expect(retried.status).toBe("error");
    expect(publications).toBe(0);
    const read = value(await blobs.open(reference));
    expect(new TextDecoder().decode(value(await materializeBlobRead(read)))).toBe(
      "accepted retry input",
    );
    expect(value(store.load(requestDeliveryId))).toMatchObject({
      state: "accepted",
      inputReferences: [reference],
    });
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("deletes durable input handles when the prepared-record write fails", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("unowned after prepare failure"),
        retention: { kind: "durable" },
      }),
    );
    await resultValue(upload.completion);
    const delivery = coordinator({ store, blobStore: blobs, now: () => -1 });
    const requestDeliveryId = crypto.randomUUID();
    let publishCalls = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      async publish() {
        publishCalls += 1;
        return Result.ok({ streamId: "unexpected" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "unused" }),
    };

    const prepared = await delivery.prepareAndPublish(
      {
        requestDeliveryId,
        requestId: "request-prepare-write-failure",
        envelope: envelope({
          requestDeliveryId,
          requestId: "request-prepare-write-failure",
          handle: upload.handle,
        }),
        inputHandles: [upload.handle],
      },
      publisher,
    );

    expect(prepared.status).toBe("error");
    expect(publishCalls).toBe(0);
    expect((await blobs.resolve(upload.handle, { timeoutMs: 1_000 })).status).toBe("error");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("resolves handles before validation and commits accepted redelivery before blob access", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("durable input"),
        retention: { kind: "durable" },
      }),
    );
    const reference = await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-2",
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-2",
        envelope: preparedEnvelope,
        inputHandles: collectCoreRequestInputHandles(preparedEnvelope),
        createdAt: 1,
      }),
    );

    let resolveCalls = 0;
    let openCalls = 0;
    const countingBlobs: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      resolve: async (handle, options) => {
        resolveCalls += 1;
        expect(options.timeoutMs).toBe(REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS);
        return blobs.resolve(handle, options);
      },
      open: async (blob) => {
        openCalls += 1;
        return blobs.open(blob);
      },
      delete: (target) => blobs.delete(target),
    };
    const delivery = coordinator({
      store,
      blobStore: countingBlobs,
      now: () => 2,
    });
    const accepted = value(await delivery.handleDelivery(requestDeliveryId));
    expect(accepted.disposition).toBe("accepted");
    if (accepted.disposition === "accepted") {
      expect(accepted.record.inputReferences).toEqual([reference]);
      const file = accepted.record.work.data.messages[0]?.content;
      expect(file).toEqual([
        { type: "text", text: "inspect" },
        {
          type: "blob",
          blob: reference,
          mediaType: "text/plain",
          filename: "input.txt",
        },
      ]);
    }

    const redelivery = value(await delivery.handleDelivery(requestDeliveryId));
    expect(redelivery).toMatchObject({
      disposition: "commit",
      reason: "already-accepted",
    });
    expect(resolveCalls).toBe(1);
    expect(openCalls).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("preserves resource parts through prepared and accepted request delivery", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const resource = {
      type: "resource" as const,
      uri: `resource://r1_${"ab".repeat(16)}`,
      filename: "diagram.png",
      mediaType: "image/png",
      size: 321,
    };
    const preparedEnvelope: CorePreparedRequestEnvelope = {
      headers: {
        request_id: "request-resource",
        session_id: "session-1",
        request_client: "discord",
      },
      data: {
        requestDeliveryId,
        queue: "prompt",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "inspect" }, resource],
          },
        ],
      },
    };

    expect(collectCoreRequestInputHandles(preparedEnvelope)).toEqual([]);
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-resource",
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );

    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const accepted = value(await delivery.handleDelivery(requestDeliveryId));
    expect(accepted.disposition).toBe("accepted");
    if (accepted.disposition === "accepted") {
      expect(accepted.record.inputReferences).toEqual([]);
      const acceptedMessage = accepted.record.work.data.messages[0];
      expect(acceptedMessage?.role).toBe("user");
      if (acceptedMessage?.role === "user" && Array.isArray(acceptedMessage.content)) {
        expect(acceptedMessage.content).toEqual([{ type: "text", text: "inspect" }, resource]);
      }
    }

    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("terminalizes instead of accepting when a resolved blob fails its verified read", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("corrupt input"),
        retention: { kind: "durable" },
      }),
    );
    await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-corrupt-input",
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-corrupt-input",
        envelope: preparedEnvelope,
        inputHandles: collectCoreRequestInputHandles(preparedEnvelope),
        createdAt: 1,
      }),
    );

    let openCalls = 0;
    const corruptBlobs: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      resolve: (handle, options) => blobs.resolve(handle, options),
      async open(reference) {
        openCalls += 1;
        return Result.ok({
          ref: reference,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("tampered input"));
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: reference.objectId,
                reason: "sha256-mismatch",
                message: "Controlled corrupt request blob",
              }),
            ),
          ),
        });
      },
      delete: (target) => blobs.delete(target),
    };
    const delivery = coordinator({
      store,
      blobStore: corruptBlobs,
      now: () => 2,
    });

    expect(value(await delivery.handleDelivery(requestDeliveryId))).toEqual({
      disposition: "commit",
      reason: "terminalized",
    });
    expect(openCalls).toBe(1);
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal.state).toBe("terminal");
    if (terminal.state === "terminal") {
      expect(terminal.outcome).toEqual({
        kind: "failed",
        code: "resolved-reference-unreadable",
      });
    }

    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("uses one 60 second resolve budget and terminalizes a timed-out delivery", async () => {
    const store = createStore();
    const requestDeliveryId = crypto.randomUUID();
    const handle = {
      version: 1,
      objectId: "b1_11111111111111111111111111111111",
    } as const;
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-3",
      handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-3",
        envelope: preparedEnvelope,
        inputHandles: [handle],
        createdAt: 1,
      }),
    );
    let observedTimeout = 0;
    const blobPort: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      async resolve(target, options) {
        observedTimeout = options.timeoutMs;
        return Result.err(
          new BlobResolveTimeout({
            objectId: target.objectId,
            timeoutMs: options.timeoutMs,
            message: "controlled timeout",
          }),
        );
      },
      async delete() {
        return Result.ok("deleted");
      },
      open: (reference) => {
        throw new Error(`Unexpected open for ${reference.objectId}`);
      },
    };
    const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
    const delivery = coordinator({
      store,
      blobStore: blobPort,
      now: () => 2,
      logger: {
        debug: () => undefined,
        error: (message, context) => errors.push({ message, context }),
      },
    });
    const outcome = value(await delivery.handleDelivery(requestDeliveryId));
    expect(outcome).toEqual({ disposition: "commit", reason: "terminalized" });
    expect(observedTimeout).toBe(60_000);
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal.state).toBe("terminal");
    if (terminal.state === "terminal") {
      expect(terminal.outcome.kind).toBe("upload-timeout");
      expect(terminal.inputCleanupPending).toEqual([]);
    }
    expect(errors).toEqual([
      {
        message: "request canceled after input blob upload failed",
        context: {
          requestDeliveryId,
          requestId: "request-3",
          objectId: handle.objectId,
          outcome: "upload-timeout",
          errorClass: "BlobResolveTimeout",
          errorMessage: "controlled timeout",
        },
      },
    ]);
    store.close();
  });

  test("logs an error when upload failure cancels a request", async () => {
    const store = createStore();
    const requestDeliveryId = crypto.randomUUID();
    const handle = {
      version: 1,
      objectId: "b1_22222222222222222222222222222222",
    } as const;
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-upload-failed",
      handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-upload-failed",
        envelope: preparedEnvelope,
        inputHandles: [handle],
        createdAt: 1,
      }),
    );
    const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
    const delivery = coordinator({
      store,
      blobStore: {
        resolve: async () =>
          Result.err(
            new BlobUploadFailed({
              objectId: handle.objectId,
              reason: "expected_byte_length",
              message: "controlled upload failure",
            }),
          ),
        delete: async () => Result.ok("deleted"),
        open: (reference) => {
          throw new Error(`Unexpected open for ${reference.objectId}`);
        },
      },
      now: () => 2,
      logger: {
        debug: () => undefined,
        error: (message, context) => errors.push({ message, context }),
      },
    });

    expect(value(await delivery.handleDelivery(requestDeliveryId))).toEqual({
      disposition: "commit",
      reason: "terminalized",
    });
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal).toMatchObject({
      state: "terminal",
      outcome: { kind: "upload-failed", code: "BlobUploadFailed" },
    });
    expect(errors).toEqual([
      {
        message: "request canceled after input blob upload failed",
        context: {
          requestDeliveryId,
          requestId: "request-upload-failed",
          objectId: handle.objectId,
          outcome: "upload-failed",
          errorClass: "BlobUploadFailed",
          errorMessage: "controlled upload failure",
        },
      },
    ]);
    store.close();
  });

  test("keeps terminal tombstones until transport commit is observed", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-4",
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-4",
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));
    value(
      await delivery.terminalize({
        requestDeliveryId,
        outcome: { kind: "completed" },
        transportCommitRequired: true,
      }),
    );

    const beforeCommit = value(await delivery.maintain({ now: 10 }));
    expect(beforeCommit.tombstonesDeleted).toBe(0);
    expect(value(store.load(requestDeliveryId)).state).toBe("terminal");

    value(delivery.observeTransportCommit(requestDeliveryId, "transport:request-4"));
    const afterCommit = value(await delivery.maintain({ now: 10 }));
    expect(afterCommit.tombstonesDeleted).toBe(1);
    expect(store.load(requestDeliveryId).match({ ok: () => false, err: () => true })).toBe(true);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("accepts a lagging fanout commit after terminal tombstone cleanup", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-lagging-fanout";
    const streamId = "100-0";
    const preparedEnvelope = envelope({ requestDeliveryId, requestId });
    value(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));
    value(
      await delivery.terminalize({
        requestDeliveryId,
        outcome: { kind: "cancelled" },
        transportCommitRequired: true,
      }),
    );
    value(delivery.observeTransportCommit(requestDeliveryId, streamId));
    expect(value(await delivery.maintain({ now: 10 })).tombstonesDeleted).toBe(1);

    const observer = createRequestDeliveryPostCommitObserver({
      observeTransportCommit: (deliveryId, observedStreamId) =>
        delivery.observeTransportCommit(deliveryId, observedStreamId),
    });
    const observed = await observer.observe(
      {
        topic: "cmd.request",
        id: streamId,
        type: lilacEventTypes.CmdRequestMessage,
        ts: 10,
        key: requestId,
        headers: preparedEnvelope.headers,
        data: preparedEnvelope.data,
      },
      {
        cursor: streamId,
        mode: "fanout",
        evidence: {
          source: {
            transport: "redis-streams",
            streamKey: "cmd.request",
            topic: "cmd.request",
            messageId: streamId,
          },
          wire: { kind: "bounded-complete", fields: [] },
        },
        deliveryId: "0".repeat(64),
        attempt: 1,
        leaseDeadline: 1_000,
        signal: new AbortController().signal,
      },
    );

    expect(value(observed)).toBeUndefined();
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("exhausts recovery pages without a published prefix starving later work", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const preparedIds = Array.from({ length: 105 }, () => crypto.randomUUID()).toSorted();
    for (const [index, requestDeliveryId] of preparedIds.entries()) {
      value(
        store.prepare({
          requestDeliveryId,
          requestId: `prepared-${index}`,
          envelope: envelope({
            requestDeliveryId,
            requestId: `prepared-${index}`,
          }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
    }
    for (const requestDeliveryId of preparedIds.slice(0, 12)) {
      value(
        store.recordPublication({
          requestDeliveryId,
          streamId: `published:${requestDeliveryId}`,
          recordedAt: 1,
        }),
      );
    }
    const published: string[] = [];
    const preparedSummary = value(
      await delivery.recoverPreparedPublications(
        {
          ...publicationClaimMethods(),
          publish: async ({ requestDeliveryId }) => {
            published.push(requestDeliveryId);
            return Result.ok({ streamId: `recovered:${requestDeliveryId}` });
          },
          classifyFailure: () => ({
            certainty: "ambiguous",
            code: "unexpected",
          }),
        },
        { limit: 10 },
      ),
    );
    expect(preparedSummary).toMatchObject({
      published: 93,
      alreadyPublished: 12,
    });
    expect(published).toHaveLength(93);

    const acceptedIds = Array.from({ length: 105 }, () => crypto.randomUUID()).toSorted();
    for (const [index, requestDeliveryId] of acceptedIds.entries()) {
      value(
        store.prepare({
          requestDeliveryId,
          requestId: `accepted-${index}`,
          envelope: envelope({
            requestDeliveryId,
            requestId: `accepted-${index}`,
          }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
      value(await delivery.handleDelivery(requestDeliveryId));
    }
    const resumed: string[] = [];
    const acceptedSummary = value(
      await delivery.recoverAccepted(
        async (record) => {
          resumed.push(record.requestDeliveryId);
          return Result.ok(undefined);
        },
        { limit: 10 },
      ),
    );
    expect(acceptedSummary.resumed).toBe(105);
    expect(resumed.toSorted()).toEqual(acceptedIds);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("reports an undecodable accepted record and still recovers the rest", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "request-delivery-bad-record-"));
    const dbPath = path.join(directory, "deliveries.db");
    const store = new SqliteRequestDeliveryStore<
      CorePreparedRequestEnvelope,
      CoreAcceptedRequestWork,
      CoreRequestOutputMetadata
    >({ dbPath, codecs: coreRequestDeliveryCodecs });
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID()).toSorted();
    for (const [index, requestDeliveryId] of ids.entries()) {
      value(
        store.prepare({
          requestDeliveryId,
          requestId: `accepted-${index}`,
          envelope: envelope({ requestDeliveryId, requestId: `accepted-${index}` }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
      value(await delivery.handleDelivery(requestDeliveryId));
    }
    const corrupt = new Database(dbPath);
    corrupt.run(
      "UPDATE request_delivery_records SET accepted_work_json = '{' WHERE request_delivery_id = ?",
      [ids[1]!],
    );
    corrupt.close();
    const resumed: string[] = [];
    try {
      const summary = value(
        await delivery.recoverAccepted(
          async (record) => {
            resumed.push(record.requestDeliveryId);
            return Result.ok(undefined);
          },
          { limit: 2 },
        ),
      );
      expect(summary.resumed).toBe(4);
      expect(summary.failures.map(({ requestDeliveryId }) => requestDeliveryId)).toEqual([ids[1]!]);
      expect(resumed).toEqual(ids.filter((id) => id !== ids[1]));
      const inspect = new Database(dbPath, { readonly: true });
      const row = inspect
        .query<{ state: string }, [string]>(
          "SELECT state FROM request_delivery_records WHERE request_delivery_id = ?",
        )
        .get(ids[1]!);
      inspect.close();
      expect(row?.state).toBe("accepted");
    } finally {
      store.close();
      await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically replaces an accepted alias identity for work, outputs, and recovery", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const originalRequestId = "request-model-control";
    const aliasRequestId = "request-model-control:projected-run";
    value(
      store.prepare({
        requestDeliveryId,
        requestId: originalRequestId,
        envelope: envelope({ requestDeliveryId, requestId: originalRequestId }),
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const accepted = value(await delivery.handleDelivery(requestDeliveryId));
    if (accepted.disposition !== "accepted") throw new Error("expected accepted work");
    const outputUpload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("alias output"),
        retention: { kind: "durable" },
      }),
    );
    value(
      delivery.registerOutputHandle({
        requestDeliveryId,
        handle: outputUpload.handle,
        metadata: { mimeType: "text/plain" },
      }),
    );

    const replacedWork: CoreAcceptedRequestWork = {
      ...accepted.record.work,
      requestId: aliasRequestId,
      headers: {
        ...accepted.record.work.headers,
        request_id: aliasRequestId,
      },
      data: { ...accepted.record.work.data, queue: "prompt" },
    };
    const replaced = value(
      delivery.replaceAcceptedWork({
        requestDeliveryId,
        requestId: aliasRequestId,
        work: replacedWork,
      }),
    );
    expect(replaced).toMatchObject({
      requestId: aliasRequestId,
      work: replacedWork,
    });
    expect(
      value(
        delivery.registerOutputHandle({
          requestDeliveryId,
          handle: outputUpload.handle,
          metadata: { mimeType: "text/plain" },
        }),
      ).requestId,
    ).toBe(aliasRequestId);
    expect(value(store.listOutputsForRequest(originalRequestId))).toEqual([]);
    expect(value(store.listOutputsForRequest(aliasRequestId))).toMatchObject([
      {
        requestId: aliasRequestId,
        target: { kind: "handle", blob: outputUpload.handle },
        metadata: { mimeType: "text/plain" },
      },
    ]);
    const resumed: string[] = [];
    value(
      await delivery.recoverAccepted(async (record) => {
        expect(record.work.requestId).toBe(record.requestId);
        resumed.push(record.requestId);
        return Result.ok(undefined);
      }),
    );
    expect(resumed).toEqual([aliasRequestId]);
    await resultValue(outputUpload.completion);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("keeps output durable through the final Redis replay deadline", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-5",
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-5",
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));

    const outputUpload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("generated output"),
        retention: { kind: "durable" },
      }),
    );
    value(
      delivery.registerOutputHandle({
        requestDeliveryId,
        handle: outputUpload.handle,
        metadata: { mimeType: "text/plain", filename: "output.txt" },
      }),
    );
    const outputReference = await resultValue(outputUpload.completion);
    value(
      delivery.recordOutputReference({
        requestDeliveryId,
        reference: outputReference,
      }),
    );
    value(delivery.observeTransportCommit(requestDeliveryId, "transport:request-5"));
    value(
      await delivery.terminalize({
        requestDeliveryId,
        outcome: { kind: "completed" },
        finalReplayDeadline: 1_000,
      }),
    );

    const early = value(await delivery.maintain({ now: 999 }));
    expect(early.outputObjectsDeleted).toBe(0);
    const earlyRead = value(await blobs.open(outputReference));
    expect(new TextDecoder().decode(value(await materializeBlobRead(earlyRead)))).toBe(
      "generated output",
    );

    const due = value(await delivery.maintain({ now: 1_000 }));
    expect(due.outputObjectsDeleted).toBe(1);
    expect(due.tombstonesDeleted).toBe(1);
    expect(
      (await blobs.open(outputReference)).match({
        ok: () => false,
        err: () => true,
      }),
    ).toBe(true);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("uses a terminal journal head as execution authority without resuming the agent", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-terminal-journal-recovery";
    value(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: envelope({ requestDeliveryId, requestId }),
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));
    let resumes = 0;

    const recovered = value(
      await delivery.recoverAccepted(
        async () => {
          resumes += 1;
          return Result.ok(undefined);
        },
        {
          terminalRecovery: (record) =>
            record.requestDeliveryId === requestDeliveryId
              ? {
                  outcome: { kind: "completed", code: "journal-terminal" },
                  finalReplayDeadline: 5_000,
                }
              : undefined,
        },
      ),
    );

    expect(recovered).toMatchObject({
      resumed: 0,
      terminalized: 1,
      failures: [],
    });
    expect(resumes).toBe(0);
    expect(value(store.load(requestDeliveryId))).toMatchObject({
      state: "terminal",
      outcome: { kind: "completed", code: "journal-terminal" },
      finalReplayDeadline: 5_000,
    });
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });
});
