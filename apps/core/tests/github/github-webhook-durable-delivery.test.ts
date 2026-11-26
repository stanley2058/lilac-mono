import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  EventPublishContractInvalid,
  lilacEventTypes,
  type RawBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import type { Result } from "better-result";

import { createGithubWebhookApp } from "../../src/github/webhook/github-webhook-server";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  type CorePreparedRequestEnvelope,
} from "../../src/surface/bridge/request-delivery";
import { corePreparedRequestEnvelopeSchema } from "../../src/surface/bridge/request-delivery/core-integration";

function value<T, E extends Error>(result: Result<T, E>): T {
  return result.match({
    ok: (resultValue) => resultValue,
    err: (error) => {
      throw error;
    },
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const store = new SqliteRequestDeliveryStore({
    dbPath: ":memory:",
    codecs: coreRequestDeliveryCodecs,
  });
  const blobs = value(await createMemoryBlobStore());
  const coordinator = new RequestDeliveryCoordinator({
    store,
    blobStore: blobs,
    admission: createCoreRequestDeliveryAdmission(blobs),
  });
  const publications: CorePreparedRequestEnvelope[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected external operation");
  };
  const raw: RawBus = {
    publish: unexpected,
    async acquireRequestPublicationClaim(requestDeliveryId) {
      return { status: "acquired", claim: { requestDeliveryId, token: crypto.randomUUID() } };
    },
    async publishClaimedRequest(message, options) {
      publications.push(
        corePreparedRequestEnvelopeSchema.parse({ headers: options.headers, data: message.data }),
      );
      const id = `${publications.length}-0`;
      return { status: "published", receipt: { id, cursor: id } };
    },
    async confirmRequestPublication() {
      return "confirmed";
    },
    async abandonRequestPublicationClaim() {
      return "abandoned";
    },
    subscribe: unexpected,
    fetch: unexpected,
    close: async () => {},
  };
  const transportBus = createLilacBus(raw);
  const bus = createDurableCoreRequestBus({
    transportBus,
    coordinator,
    publisher: createLilacBusRequestDeliveryPublisher(transportBus),
  });
  cleanups.push(async () => {
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });
  return {
    bus,
    coordinator,
    publications,
    session: `synthetic/${crypto.randomUUID()}#1`,
  };
}

describe("GitHub webhook durable delivery", () => {
  it("keeps invalid delivery identities rejected before durable preparation", async () => {
    const f = await fixture();
    const prepare = spyOn(f.coordinator, "prepareAndPublish");
    const result = await f.bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: "github-delivery:invalid:prompt",
        queue: "prompt",
        messages: [{ role: "user", content: "synthetic" }],
      },
      { headers: { request_id: "synthetic", session_id: f.session, request_client: "github" } },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("EventPublishContractInvalid");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.publications).toHaveLength(0);
    prepare.mockRestore();
  });

  it("logs a redacted nested contract error while retaining the handler error", async () => {
    const logger = createLogger({ module: "github-contract-log-test" });
    const logged = Promise.withResolvers<unknown>();
    const log = spyOn(logger, "error").mockImplementation((_message, fields) =>
      logged.resolve(fields),
    );
    const error = new EventPublishContractInvalid({
      eventType: lilacEventTypes.CmdRequestMessage,
      message: "Invalid UUID at data.requestDeliveryId; token=synthetic-private-value",
    });
    const body = "{}";
    const app = createGithubWebhookApp({
      secret: "test-secret",
      path: "/webhook",
      logger,
      handle: async () => {
        throw error;
      },
      reportFatalError: (cause) => {
        throw cause;
      },
    }).compile();
    try {
      const response = await app.handle(
        new Request("http://localhost/webhook", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(200);
      const fields = await logged.promise;
      expect(fields).toMatchObject({
        errorTag: "GithubWebhookOperationError",
        errorMessage: expect.stringContaining(
          "EventPublishContractInvalid: Invalid UUID at data.requestDeliveryId; token=<redacted>",
        ),
      });
      expect(JSON.stringify(fields)).not.toContain("synthetic-private-value");
    } finally {
      log.mockRestore();
    }
  });
});
