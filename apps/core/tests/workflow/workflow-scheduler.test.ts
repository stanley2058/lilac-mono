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
import { startWorkflowScheduler } from "../../src/workflow/workflow-scheduler";
import { SqliteWorkflowStore } from "../../src/workflow/workflow-store";
import { createWorkflowStoreQueries } from "../../src/workflow/workflow-store-queries";

import { Workflow as WorkflowTool } from "../../src/tool-server/tools/workflow";

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
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

describe("workflow scheduler", () => {
  it("fires wait_until scheduled workflow once", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test",
      pollTimeouts: { enabled: false },
    });

    const scheduler = await startWorkflowScheduler({
      bus,
      store,
      queries,
      subscriptionId: "workflow-scheduler-test",
      intervalMs: 0,
    });

    const requestMsgs: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) requestMsgs.push(m);
        await ctx.commit();
      },
    );

    const tool = new WorkflowTool({ bus, workflowStore: store });

    const runAtMs = Date.now() - 5;
    const created = await tool.call("workflow.schedule", {
      mode: "wait_until",
      summary: "job",
      userPrompt: "do thing",
      runAtMs,
    });
    expect((created as any).ok).toBe(true);
    const workflowId = (created as any).workflowId as string;

    await scheduler.tick(Date.now());

    expect(requestMsgs.length).toBe(1);
    expect(requestMsgs[0].headers?.request_client).toBe("unknown");
    expect(requestMsgs[0].headers?.session_id).toBe(`job:${workflowId}`);
    expect(String(requestMsgs[0].headers?.request_id)).toBe(`wf:${workflowId}:1`);

    const w = store.getWorkflow(workflowId);
    expect(w?.state).toBe("resolved");

    const tasks = store.listTasks(workflowId);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.kind).toBe("time.wait_until");
    expect(tasks[0]!.state).toBe("resolved");

    await reqSub.stop();
    await scheduler.stop();
    await svc.stop();
  });

  it("fires cron scheduled workflow and reschedules", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test",
      pollTimeouts: { enabled: false },
    });

    const scheduler = await startWorkflowScheduler({
      bus,
      store,
      queries,
      subscriptionId: "workflow-scheduler-test",
      intervalMs: 0,
    });

    const requestMsgs: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) requestMsgs.push(m);
        await ctx.commit();
      },
    );

    const tool = new WorkflowTool({ bus, workflowStore: store });

    const created = await tool.call("workflow.schedule", {
      mode: "cron",
      summary: "cron job",
      userPrompt: "do thing",
      expr: "*/5 * * * *",
      tz: "UTC",
      skipMissed: true,
    });
    expect((created as any).ok).toBe(true);
    const workflowId = (created as any).workflowId as string;
    const taskId = (created as any).taskId as string;

    const initialTask = store.getTask(workflowId, taskId);
    expect(initialTask?.kind).toBe("time.cron");
    expect(typeof initialTask?.timeoutAt).toBe("number");

    const fireAt = (initialTask!.timeoutAt as number) + 1;
    await scheduler.tick(fireAt);

    expect(requestMsgs.length).toBe(1);
    expect(String(requestMsgs[0].headers?.request_id)).toBe(`wf:${workflowId}:1`);

    const updated = store.getTask(workflowId, taskId)!;
    expect(updated.state).toBe("blocked");
    expect(typeof updated.timeoutAt).toBe("number");
    expect((updated.timeoutAt as number) > fireAt).toBe(true);

    const w = store.getWorkflow(workflowId);
    expect(w?.state).toBe("blocked");

    await reqSub.stop();
    await scheduler.stop();
    await svc.stop();
  });

  it("cancel prevents cron firing", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const store = new SqliteWorkflowStore(":memory:");
    const queries = createWorkflowStoreQueries(store);

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test",
      pollTimeouts: { enabled: false },
    });

    const scheduler = await startWorkflowScheduler({
      bus,
      store,
      queries,
      subscriptionId: "workflow-scheduler-test",
      intervalMs: 0,
    });

    const requestMsgs: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) requestMsgs.push(m);
        await ctx.commit();
      },
    );

    const tool = new WorkflowTool({ bus, workflowStore: store });

    const created = await tool.call("workflow.schedule", {
      mode: "cron",
      summary: "cron job",
      userPrompt: "do thing",
      expr: "*/5 * * * *",
      tz: "UTC",
      skipMissed: true,
    });
    const workflowId = (created as any).workflowId as string;
    const taskId = (created as any).taskId as string;

    const initialTask = store.getTask(workflowId, taskId)!;
    const fireAt = (initialTask.timeoutAt as number) + 1;

    await tool.call("workflow.cancel", { workflowId, reason: "stop" });

    await scheduler.tick(fireAt);
    expect(requestMsgs.length).toBe(0);

    const w = store.getWorkflow(workflowId);
    expect(w?.state).toBe("cancelled");

    const list = (await tool.call("workflow.list", {
      includeTasks: true,
    })) as any;
    expect(list.ok).toBe(true);
    expect(list.workflows.some((x: any) => x.workflowId === workflowId)).toBe(true);

    await reqSub.stop();
    await scheduler.stop();
    await svc.stop();
  });
});
