import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type LilacBus,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type SubscriptionOptions,
} from "../index";

type PublicResultHandler = Parameters<LilacBus["subscribeTopic"]>[2];
type PublicResultHandlerContext = Parameters<PublicResultHandler>[1];
type PublicResultHandlerHasNoAck = "commit" extends keyof PublicResultHandlerContext ? false : true;

const PUBLIC_RESULT_HANDLER_HAS_NO_ACK: PublicResultHandlerHasNoAck = true;

function rawBusWithFetch(
  fetch: RawBus["fetch"],
  subscribe: RawBus["subscribe"] = async () =>
    Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    }),
): RawBus {
  return {
    publish: async <TData>(_message: PublishMessage<TData>, _options: PublishOptions) => ({
      id: "1-0",
      cursor: "1-0",
    }),
    subscribe,
    fetch,
    close: async () => {},
  };
}

describe("LilacBus Result APIs", () => {
  it("forwards the durable initial frontier without changing event codecs", async () => {
    let received: SubscriptionOptions | undefined;
    const raw = rawBusWithFetch(
      async () => ({ messages: [] }),
      async (_topic, options) => {
        received = options;
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
    );
    const bus = createLilacBus(raw);
    const options = {
      mode: "fanout" as const,
      subscriptionId: "native-projector",
      startFrom: "beginning" as const,
    };
    const subscription = await bus.subscribeTopic(
      "evt.request",
      options,
      async () => Result.ok(undefined),
      () => "retry",
    );
    expect(subscription.isOk()).toBe(true);
    expect(received).toEqual(options);
  });

  it("returns publish contract and transport failures as owned Results", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    const bus = createLilacBus(raw);
    const missingRequestId = await bus.publish(lilacEventTypes.CmdRequestMessage, {
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(missingRequestId.status).toBe("error");
    if (missingRequestId.status === "error") {
      expect(missingRequestId.error._tag).toBe("EventPublishContractInvalid");
    }

    raw.publish = async () => {
      throw new Error("redis unavailable");
    };
    const failed = await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: "run-1",
      revisionId: "revision-1",
      state: "running",
      previousState: "queued",
      ts: 1,
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") expect(failed.error._tag).toBe("EventPublishTransportFailed");
  });

  it("reports present, absent, uncertain, and unavailable output stream expiry outcomes", async () => {
    const raw = rawBusWithFetch(async () => ({ messages: [] }));
    const bus = createLilacBus(raw);

    const unsupported = await bus.getOutputStreamExpiry("request-unsupported");
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("EventOutputStreamExpiryUnavailable");
      expect(unsupported.error.reason).toBe("unsupported");
    }

    raw.readOutputStreamExpiry = async (topic) => ({
      kind: "present",
      expiresAt: topic === "out.req.request-present" ? 123_456 : 654_321,
    });
    expect(await bus.getOutputStreamExpiry("request-present")).toEqual(
      Result.ok({ kind: "present", expiresAt: 123_456 }),
    );

    raw.readOutputStreamExpiry = async () => ({ kind: "absent" });
    expect(await bus.getOutputStreamExpiry("request-absent")).toEqual(
      Result.ok({ kind: "absent" }),
    );

    raw.readOutputStreamExpiry = async () => ({
      kind: "uncertain",
      reason: "stream-has-no-expiry",
    });
    const uncertain = await bus.getOutputStreamExpiry("request-uncertain");
    expect(uncertain.status).toBe("error");
    if (uncertain.status === "error") expect(uncertain.error.reason).toBe("expiry-uncertain");

    raw.readOutputStreamExpiry = async () => {
      throw new Error("redis unavailable");
    };
    const unavailable = await bus.getOutputStreamExpiry("request-unavailable");
    expect(unavailable.status).toBe("error");
    if (unavailable.status === "error") {
      expect(unavailable.error.reason).toBe("transport-unavailable");
    }
  });

  it("keeps acknowledgement out of the public Result handler API", async () => {
    let rawHandler: RawDeliveryHandler | undefined;
    const raw = rawBusWithFetch(
      async () => ({ messages: [] }),
      async (_topic, _options, handler) => {
        rawHandler = handler;
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
    );
    let handlerContextHasAck = true;
    const started = await createLilacBus(raw).subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "begin" } },
      async (_message, context) => {
        handlerContextHasAck = "commit" in context;
        return Result.ok(undefined);
      },
      () => "commit",
    );
    expect(started.status).toBe("ok");
    expect(PUBLIC_RESULT_HANDLER_HAS_NO_ACK).toBe(true);
    if (!rawHandler) throw new Error("Raw delivery handler was not captured");

    const action = await rawHandler(
      {
        topic: "cmd.request",
        id: "1-0",
        type: "cmd.request.message",
        ts: 1,
        key: "request-1",
        headers: { request_id: "request-1" },
        data: {
          requestDeliveryId: crypto.randomUUID(),
          queue: "prompt",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      {
        cursor: "1-0",
        mode: "tail",
        evidence: {
          source: {
            transport: "redis-streams",
            streamKey: "test:cmd.request",
            topic: "cmd.request",
            messageId: "1-0",
          },
          wire: { kind: "bounded-complete", fields: [] },
        },
      },
    );
    expect(handlerContextHasAck).toBe(false);
    expect(action).toEqual({ disposition: "commit" });
  });

  it("returns invalid contracts as typed errors and redacts diagnostic payloads", async () => {
    const secret = "secret-payload-sentinel";
    const diagnostics: unknown[] = [];
    const raw = rawBusWithFetch(async (_topic: string, _options: FetchOptions) => ({
      messages: [
        {
          cursor: "1-0",
          msg: {
            topic: "cmd.request",
            id: "1-0",
            type: "secret-type-sentinel",
            ts: 1,
            data: { secret },
          },
        },
      ],
      next: "1-0",
    }));
    const bus = createLilacBus(raw, {
      logger: {
        warn: (event, context) => diagnostics.push({ event, context }),
        error: () => {},
      },
    });

    const fetched = await bus.fetchTopic("cmd.request", {
      offset: { type: "begin" },
    });
    expect(fetched.status).toBe("error");
    if (fetched.status === "error") expect(fetched.error._tag).toBe("EventFetchContractInvalid");
    expect(diagnostics).toEqual([
      {
        event: "event_bus.contract_invalid",
        context: {
          topic: "cmd.request",
          cursor: "1-0",
          source: "contract",
          stage: "event_type",
          eventType: "<unknown>",
        },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-type-sentinel");
  });
});
