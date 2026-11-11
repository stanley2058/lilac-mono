import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Result } from "better-result";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  type CorePreparedRequestEnvelope,
  type RequestDeliveryPublisher,
} from "../../../src/surface/bridge/request-delivery";
import {
  createRealCoreBusFixture,
  requireBusOk,
  withBusDeadline,
} from "../../helpers/real-core-bus";

type Fixture = Awaited<ReturnType<typeof createRealCoreBusFixture>>;

function preparedRequest() {
  const requestDeliveryId = crypto.randomUUID();
  const requestId = `durable-${crypto.randomUUID()}`;
  const envelope: CorePreparedRequestEnvelope = {
    headers: { request_id: requestId, session_id: requestId, request_client: "discord" },
    data: {
      requestDeliveryId,
      queue: "prompt",
      messages: [{ role: "user", content: "Preserve this request through recovery" }],
    },
  };
  return { requestDeliveryId, requestId, envelope, inputHandles: [] };
}

function reopen(fixture: Fixture) {
  const store = new SqliteRequestDeliveryStore({
    dbPath: join(fixture.directory, "request-delivery.sqlite"),
    codecs: coreRequestDeliveryCodecs,
  });
  const coordinator = new RequestDeliveryCoordinator({
    store,
    blobStore: fixture.blobs,
    admission: createCoreRequestDeliveryAdmission(fixture.blobs),
  });
  return { store, coordinator };
}

async function expireProducerClaim(fixture: Fixture, requestDeliveryId: string) {
  const key = `${fixture.keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`;
  expect(await fixture.redis.exists(key)).toBe(1);
  // Expire the crashed producer's lease without waiting for its production TTL.
  expect(await fixture.redis.pexpire(key, 0)).toBe(1);
  expect(await fixture.redis.exists(key)).toBe(0);
}

describe("durable request delivery through Redis and SQLite", () => {
  test("recovers a lost publication reply after reopening SQLite without adding another stream entry", async () => {
    const fixture = await createRealCoreBusFixture();
    try {
      const request = preparedRequest();
      let streamId = "";
      const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
        ...fixture.publisher,
        async publish(input) {
          const receipt = requireBusOk(await fixture.publisher.publish(input));
          streamId = receipt.streamId;
          return Result.err(new Error("Lost reply after Redis committed XADD"));
        },
      };
      const first = requireBusOk(await fixture.coordinator.prepareAndPublish(request, publisher));
      expect(first.status).toBe("ambiguous");
      expect(
        requireBusOk(fixture.store.load(request.requestDeliveryId)).publication,
      ).toBeUndefined();
      const stream = `${fixture.keyPrefix}:v2:cmd.request`;
      expect(await fixture.redis.xlen(stream)).toBe(1);
      const restarted = reopen(fixture);
      try {
        const contended = requireBusOk(
          await restarted.coordinator.recoverPreparedPublications(fixture.publisher),
        );
        expect(contended.ambiguous).toBe(1);
        await expireProducerClaim(fixture, request.requestDeliveryId);
        const recovered = requireBusOk(
          await restarted.coordinator.recoverPreparedPublications(fixture.publisher),
        );
        expect(recovered).toMatchObject({ published: 1, ambiguous: 0, failures: [] });
        expect(
          requireBusOk(restarted.store.load(request.requestDeliveryId)).publication?.streamId,
        ).toBe(streamId);
        expect(await fixture.redis.xlen(stream)).toBe(1);
        const replay = requireBusOk(
          await restarted.coordinator.prepareAndPublish(request, fixture.publisher),
        );
        expect(replay.status).toBe("already-published");
        expect(await fixture.redis.xlen(stream)).toBe(1);
      } finally {
        restarted.store.close();
      }
    } finally {
      await fixture.close();
    }
  });

  for (const replyLostAfterConfirmation of [false, true]) {
    test(`recovers confirmation failure ${replyLostAfterConfirmation ? "after" : "before"} Redis confirmation`, async () => {
      const fixture = await createRealCoreBusFixture();
      try {
        const request = preparedRequest();
        const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
          ...fixture.publisher,
          async confirm(input) {
            if (replyLostAfterConfirmation) requireBusOk(await fixture.publisher.confirm(input));
            return Result.err(new Error("Connection lost during publication confirmation"));
          },
        };
        const first = requireBusOk(await fixture.coordinator.prepareAndPublish(request, publisher));
        expect(first.status).toBe("ambiguous");
        const receipt = requireBusOk(fixture.store.load(request.requestDeliveryId)).publication;
        expect(receipt?.streamId).toBeDefined();
        if (!replyLostAfterConfirmation)
          await expireProducerClaim(fixture, request.requestDeliveryId);
        const restarted = reopen(fixture);
        try {
          const recovered = requireBusOk(
            await restarted.coordinator.recoverPreparedPublications(fixture.publisher),
          );
          expect(recovered).toMatchObject({ alreadyPublished: 1, ambiguous: 0, failures: [] });
          expect(requireBusOk(restarted.store.load(request.requestDeliveryId)).publication).toEqual(
            receipt,
          );
          expect(await fixture.redis.xlen(`${fixture.keyPrefix}:v2:cmd.request`)).toBe(1);
          expect(
            await fixture.redis.exists(
              `${fixture.keyPrefix}:v2:request-publication:${request.requestDeliveryId}`,
            ),
          ).toBe(0);
        } finally {
          restarted.store.close();
        }
      } finally {
        await fixture.close();
      }
    });
  }

  test("retains a terminal tombstone until the real consumer commits before the producer receives its reply", async () => {
    const fixture = await createRealCoreBusFixture();
    try {
      const request = preparedRequest();
      const handled = Promise.withResolvers<void>();
      const subscription = requireBusOk(
        await fixture.bus.subscribeTopic(
          "cmd.request",
          { mode: "work", subscriptionId: "terminal-before-receipt", startFrom: "beginning" },
          async (message) => {
            expect(message.type).toBe(lilacEventTypes.CmdRequestMessage);
            expect(message.data.requestDeliveryId).toBe(request.requestDeliveryId);
            const accepted = requireBusOk(
              await fixture.coordinator.handleDelivery(request.requestDeliveryId),
            );
            expect(accepted.disposition).toBe("accepted");
            requireBusOk(
              await fixture.coordinator.terminalize({
                requestDeliveryId: request.requestDeliveryId,
                outcome: { kind: "completed" },
                transportCommitRequired: true,
              }),
            );
            expect(
              requireBusOk(await fixture.coordinator.maintain({ now: Date.now() + 1_000 }))
                .tombstonesDeleted,
            ).toBe(0);
            handled.resolve();
            return Result.ok(undefined);
          },
          () => "dead-letter",
        ),
      );
      try {
        const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
          ...fixture.publisher,
          async publish(input) {
            const receipt = requireBusOk(await fixture.publisher.publish(input));
            await withBusDeadline(handled.promise, "terminal consumer");
            await fixture.waitForCommit(receipt.streamId);
            return Result.ok(receipt);
          },
        };
        const published = requireBusOk(
          await fixture.coordinator.prepareAndPublish(request, publisher),
        );
        expect(published).toMatchObject({ status: "published", record: { state: "terminal" } });
        expect(published.record.transportCommittedAt).toBeDefined();
        expect(published.record.publication?.streamId).toBeDefined();
        expect(
          requireBusOk(await fixture.coordinator.maintain({ now: Date.now() + 1_000 }))
            .tombstonesDeleted,
        ).toBe(1);
        expect(fixture.store.load(request.requestDeliveryId).isErr()).toBe(true);
      } finally {
        requireBusOk(await subscription.stop());
      }
    } finally {
      await fixture.close();
    }
  });

  test("recovers accepted work from reopened SQLite after Redis acknowledgement", async () => {
    const fixture = await createRealCoreBusFixture();
    try {
      const request = preparedRequest();
      const subscription = requireBusOk(
        await fixture.bus.subscribeTopic(
          "cmd.request",
          { mode: "work", subscriptionId: "accepted-recovery", startFrom: "beginning" },
          async (message) => {
            const accepted = requireBusOk(
              await fixture.coordinator.handleDelivery(message.data.requestDeliveryId),
            );
            expect(accepted.disposition).toBe("accepted");
            return Result.ok(undefined);
          },
          () => "dead-letter",
        ),
      );
      const publication = requireBusOk(
        await fixture.coordinator.prepareAndPublish(request, fixture.publisher),
      );
      const streamId = publication.record.publication?.streamId;
      if (!streamId) throw new Error("Publication receipt missing");
      await fixture.waitForCommit(streamId);
      requireBusOk(await subscription.stop());
      const restarted = reopen(fixture);
      try {
        const resumed: string[] = [];
        const recovery = requireBusOk(
          await restarted.coordinator.recoverAccepted(async (record) => {
            expect(record.work.data.messages).toEqual([
              { role: "user", content: "Preserve this request through recovery" },
            ]);
            expect(record.transportCommittedAt).toBeDefined();
            resumed.push(record.requestDeliveryId);
            return Result.ok(undefined);
          }),
        );
        expect(recovery).toMatchObject({ resumed: 1, failures: [] });
        expect(resumed).toEqual([request.requestDeliveryId]);
        expect(
          requireBusOk(await restarted.coordinator.handleDelivery(request.requestDeliveryId)),
        ).toEqual({
          disposition: "commit",
          reason: "already-accepted",
        });
        expect(await fixture.redis.xlen(`${fixture.keyPrefix}:v2:cmd.request`)).toBe(1);
      } finally {
        restarted.store.close();
      }
    } finally {
      await fixture.close();
    }
  });
});
