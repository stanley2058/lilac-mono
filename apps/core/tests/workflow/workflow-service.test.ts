import { describe, expect, it } from "bun:test";

import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { startWorkflowService } from "../../src/workflow/workflow-service";
import { SqliteWorkflowStore } from "../../src/workflow/workflow-store";

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(
      msg: Omit<Message<TData>, "id" | "ts">,
      opts: PublishOptions,
    ) => {
      const id = String(Date.now()) + "-0";
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        handler: handler as unknown as (
          msg: Message<unknown>,
          ctx: HandleContext,
        ) => Promise<void>,
      };
      subs.add(entry);

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
        const existing = topics.get(topic) ?? [];
        for (const m of existing) {
          await handler(m as unknown as Message<TData>, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string, _opts: any) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next:
          existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

describe("workflow-service (v2)", () => {
  it("resolves discord.wait_for_reply on strict reply and publishes a wf: resume request", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    // In-memory sqlite db
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test",
      pollTimeouts: { enabled: false },
    });

    const receivedReq: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          receivedReq.push(m);
        }
        await ctx.commit();
      },
    );

    const workflowId = "wf_1";

    await bus.publish(
      lilacEventTypes.CmdWorkflowCreate,
      {
        workflowId,
        definition: {
          version: 2,
          origin: {
            request_id: "discord:chanX:orig",
            session_id: "chanX",
            request_client: "discord",
            user_id: "userA",
          },
          resumeTarget: {
            session_id: "chanX",
            request_client: "discord",
            mention_user_id: "userA",
          },
          summary: "We DM'd B and are waiting for reply.",
          completion: "all",
        },
      },
      {
        headers: {
          request_id: "discord:chanX:orig",
          session_id: "chanX",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdWorkflowTaskCreate,
      {
        workflowId,
        taskId: "t1",
        kind: "discord.wait_for_reply",
        description: "Wait for B to reply to the DM",
        input: {
          channelId: "dmY",
          messageId: "dmMsg1",
          fromUserId: "userB",
        },
      },
      {
        headers: {
          request_id: "discord:chanX:orig",
          session_id: "chanX",
          request_client: "discord",
        },
      },
    );

    // This adapter event is a strict reply to dmMsg1 in dmY.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: "dmY",
      channelName: "dm",
      messageId: "reply2",
      userId: "userB",
      userName: "B",
      text: "Sure, I can do it.",
      ts: Date.now(),
      raw: { discord: { replyToMessageId: "dmMsg1" } },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(receivedReq.length).toBe(1);

    const msg = receivedReq[0];
    expect(msg.headers?.session_id).toBe("chanX");
    expect(msg.headers?.request_client).toBe("discord");
    expect(String(msg.headers?.request_id).startsWith("wf:wf_1:")).toBe(true);
    expect(String(msg.headers?.request_id).startsWith("discord:")).toBe(false);

    expect(msg.data.queue).toBe("prompt");
    expect(Array.isArray(msg.data.messages)).toBe(true);
    expect(msg.data.messages[0].role).toBe("system");
    expect(String(msg.data.messages[0].content)).toContain("We DM'd B");
    expect(String(msg.data.messages[0].content)).toContain("Wait for B to reply");

    await reqSub.stop();
    await svc.stop();
  });
});
