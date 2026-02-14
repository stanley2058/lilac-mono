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

import { workflowTool } from "../../src/tools/workflow/workflow";

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
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
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
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
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

describe("workflow tool", () => {
  it("publishes cmd.workflow.create and cmd.workflow.task.create for each task", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const t = workflowTool({ bus }).workflow;

    const workflowCreates: any[] = [];
    const taskCreates: any[] = [];

    const sub = await bus.subscribeTopic(
      "cmd.workflow",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdWorkflowCreate) workflowCreates.push(m);
        if (m.type === lilacEventTypes.CmdWorkflowTaskCreate) taskCreates.push(m);
        await ctx.commit();
      },
    );

    const res = await (t as any).execute(
      {
        summary: "Waiting for replies",
        tasks: [
          { description: "Wait for DM reply", sessionId: "dm1", messageId: "m1" },
          { description: "Wait for second", sessionId: "dm2", messageId: "m2" },
        ],
      },
      {
        experimental_context: {
          requestId: "discord:chanX:orig",
          sessionId: "chanX",
          requestClient: "discord",
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(workflowCreates.length).toBe(1);
    expect(taskCreates.length).toBe(2);

    expect(taskCreates[0].data.kind).toBe("discord.wait_for_reply");
    expect(taskCreates[0].data.description).toBe("Wait for DM reply");
    expect(taskCreates[0].data.input).toEqual({ channelId: "dm1", messageId: "m1" });

    await sub.stop();
  });
});
