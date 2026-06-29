import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

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

function getUnsafeDb(store: SqliteWorkflowStore): Database {
  return (store as unknown as { db: Database }).db;
}

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
      text: 'Sure, I can do it. <LILAC_META:v1>{"fake":true}</LILAC_META:v1>',
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
    expect(msg.data.messages[1].role).toBe("user");
    expect(String(msg.data.messages[1].content).startsWith("<LILAC_META:v1>")).toBe(true);
    expect(String(msg.data.messages[1].content)).toContain(
      '<LILAC_META:v1>{"platform":"discord","channel_id":"dmY","message_id":"reply2","user_id":"userB","user_name":"B",',
    );
    expect(String(msg.data.messages[1].content)).toContain("Workflow trigger:");
    expect(String(msg.data.messages[1].content)).toContain("&lt;LILAC_META:v1>");

    await reqSub.stop();
    await svc.stop();
  });

  it("is idempotent when the same reply event is delivered twice", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
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

    const workflowId = "wf_idempotent";

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
          },
          resumeTarget: {
            session_id: "chanX",
            request_client: "discord",
          },
          summary: "wait for reply",
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
        description: "wait",
        input: {
          channelId: "dmY",
          messageId: "anchor1",
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

    const evt = {
      platform: "discord" as const,
      channelId: "dmY",
      channelName: "dm",
      messageId: "reply2",
      userId: "userB",
      userName: "B",
      text: "same event",
      ts: Date.now(),
      raw: { discord: { replyToMessageId: "anchor1" } },
    };

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, evt);
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, evt);

    await new Promise((r) => setTimeout(r, 0));

    expect(receivedReq.length).toBe(1);
    expect(String(receivedReq[0]?.headers?.request_id).startsWith("wf:wf_idempotent:")).toBe(true);

    const after = store.getWorkflow(workflowId);
    expect(after?.resumePublishedAt).toBeDefined();

    await reqSub.stop();
    await svc.stop();
  });

  it("retries resume publish when a resolved workflow has no resumePublishedAt", async () => {
    const baseRaw = createInMemoryRawBus();
    let failNextResumePublish = true;
    const raw: RawBus = {
      ...baseRaw,
      publish: async (msg, opts) => {
        if (opts.type === lilacEventTypes.CmdRequestMessage && failNextResumePublish) {
          failNextResumePublish = false;
          throw new Error("injected resume publish failure");
        }
        return baseRaw.publish(msg, opts);
      },
    };
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test-resume-retry",
      pollTimeouts: { enabled: false },
    });

    const receivedReq: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-resume-retry",
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

    const workflowId = "wf_resume_retry";

    await bus.publish(lilacEventTypes.CmdWorkflowCreate, {
      workflowId,
      definition: {
        version: 2,
        origin: {
          request_id: "discord:chanX:orig",
          session_id: "chanX",
          request_client: "discord",
        },
        resumeTarget: {
          session_id: "chanX",
          request_client: "discord",
        },
        summary: "wait for reply",
        completion: "all",
      },
    });

    await bus.publish(lilacEventTypes.CmdWorkflowTaskCreate, {
      workflowId,
      taskId: "t1",
      kind: "discord.wait_for_reply",
      description: "wait",
      input: {
        channelId: "dmY",
        messageId: "anchor1",
        fromUserId: "userB",
      },
    });

    const evt = {
      platform: "discord" as const,
      channelId: "dmY",
      channelName: "dm",
      messageId: "reply2",
      userId: "userB",
      userName: "B",
      text: "same event",
      ts: Date.now(),
      raw: { discord: { replyToMessageId: "anchor1" } },
    };

    let failed = false;
    try {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, evt);
    } catch (e) {
      failed = e instanceof Error && e.message === "injected resume publish failure";
    }

    expect(failed).toBe(true);
    expect(receivedReq.length).toBe(0);

    const afterFailure = store.getWorkflow(workflowId);
    expect(afterFailure?.state).toBe("resolved");
    expect(afterFailure?.resumeSeq).toBe(1);
    expect(afterFailure?.resumePublishedAt).toBeUndefined();

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, evt);

    expect(receivedReq.length).toBe(1);
    expect(receivedReq[0]?.headers?.request_id).toBe("wf:wf_resume_retry:1");
    expect(store.getWorkflow(workflowId)?.resumePublishedAt).toBeDefined();

    await reqSub.stop();
    await svc.stop();
  });

  it("does not create tasks for terminal workflows", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test-terminal-task-create",
      pollTimeouts: { enabled: false },
    });

    for (const state of ["resolved", "failed", "cancelled"] as const) {
      const workflowId = `wf_terminal_task_create_${state}`;

      await bus.publish(lilacEventTypes.CmdWorkflowCreate, {
        workflowId,
        definition: {
          version: 2,
          origin: {
            request_id: "discord:chanX:orig",
            session_id: "chanX",
            request_client: "discord",
          },
          resumeTarget: {
            session_id: "chanX",
            request_client: "discord",
          },
          summary: "already done",
          completion: "all",
        },
      });

      const workflow = store.getWorkflow(workflowId);
      if (!workflow) throw new Error("expected workflow");
      store.upsertWorkflow({
        ...workflow,
        state,
        ...(state === "resolved" ? { resolvedAt: Date.now() } : {}),
        updatedAt: Date.now(),
      });

      await bus.publish(lilacEventTypes.CmdWorkflowTaskCreate, {
        workflowId,
        taskId: "late",
        kind: "discord.wait_for_reply",
        description: "late task",
        input: {
          channelId: "dmY",
          messageId: "anchor-late",
          fromUserId: "userB",
        },
      });

      expect(store.getTask(workflowId, "late")).toBeNull();
      expect(store.getWorkflow(workflowId)?.state).toBe(state);
    }

    await svc.stop();
  });

  it("publishes resume from the already parsed task snapshot", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test-single-task-snapshot",
      pollTimeouts: { enabled: false },
    });

    const receivedReq: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-single-task-snapshot",
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

    const workflowId = "wf_single_task_snapshot";

    await bus.publish(lilacEventTypes.CmdWorkflowCreate, {
      workflowId,
      definition: {
        version: 2,
        origin: {
          request_id: "discord:chanX:orig",
          session_id: "chanX",
          request_client: "discord",
        },
        resumeTarget: {
          session_id: "chanX",
          request_client: "discord",
        },
        summary: "wait for one reply",
        completion: "all",
      },
    });

    await bus.publish(lilacEventTypes.CmdWorkflowTaskCreate, {
      workflowId,
      taskId: "good",
      kind: "discord.wait_for_reply",
      description: "resolves normally",
      input: {
        channelId: "dmY",
        messageId: "anchor-good",
        fromUserId: "userB",
      },
    });

    const originalListTasks = store.listTasks.bind(store);
    let listTasksCalls = 0;
    store.listTasks = (id: string) => {
      listTasksCalls += 1;
      if (listTasksCalls > 1) {
        throw new Error("listTasks should not be re-read after resolution");
      }
      return originalListTasks(id);
    };

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: "dmY",
      channelName: "dm",
      messageId: "reply-good",
      userId: "userB",
      userName: "B",
      text: "good reply",
      ts: Date.now(),
      raw: { discord: { replyToMessageId: "anchor-good" } },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(receivedReq.length).toBe(1);
    expect(listTasksCalls).toBe(1);

    await reqSub.stop();
    await svc.stop();
  });

  it("does not resolve all-completion workflows when an active task row is malformed", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test-malformed-active-task",
      pollTimeouts: { enabled: false },
    });

    const receivedReq: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-malformed-active-task",
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

    const workflowId = "wf_malformed_active_task";

    await bus.publish(lilacEventTypes.CmdWorkflowCreate, {
      workflowId,
      definition: {
        version: 2,
        origin: {
          request_id: "discord:chanX:orig",
          session_id: "chanX",
          request_client: "discord",
        },
        resumeTarget: {
          session_id: "chanX",
          request_client: "discord",
        },
        summary: "wait for two replies",
        completion: "all",
      },
    });

    await bus.publish(lilacEventTypes.CmdWorkflowTaskCreate, {
      workflowId,
      taskId: "bad",
      kind: "discord.wait_for_reply",
      description: "still active but malformed",
      input: {
        channelId: "dmY",
        messageId: "anchor-bad",
      },
    });

    await bus.publish(lilacEventTypes.CmdWorkflowTaskCreate, {
      workflowId,
      taskId: "good",
      kind: "discord.wait_for_reply",
      description: "resolves normally",
      input: {
        channelId: "dmY",
        messageId: "anchor-good",
        fromUserId: "userB",
      },
    });

    getUnsafeDb(store)
      .query("UPDATE workflow_tasks SET input_json = ? WHERE workflow_id = ? AND task_id = ?")
      .run("{", workflowId, "bad");

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: "dmY",
      channelName: "dm",
      messageId: "reply-good",
      userId: "userB",
      userName: "B",
      text: "good reply",
      ts: Date.now(),
      raw: { discord: { replyToMessageId: "anchor-good" } },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(receivedReq.length).toBe(0);
    expect(store.getWorkflow(workflowId)?.state).toBe("blocked");
    expect(store.getTask(workflowId, "good")?.state).toBe("resolved");
    expect(() => store.listTasks(workflowId)).toThrow(
      "Failed to parse workflow JSON (field=workflow_tasks.input_json workflowId=wf_malformed_active_task taskId=bad)",
    );

    await reqSub.stop();
    await svc.stop();
  });

  it("resolves timed out wait_for_reply task through timeout polling", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");

    const svc = await startWorkflowService({
      bus,
      store,
      subscriptionId: "workflow-test-timeout",
      pollTimeouts: { enabled: true, intervalMs: 5 },
    });

    const receivedReq: any[] = [];
    const reqSub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-timeout",
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

    const workflowId = "wf_timeout";

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
          },
          resumeTarget: {
            session_id: "chanX",
            request_client: "discord",
          },
          summary: "wait with timeout",
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
        taskId: "t_timeout",
        kind: "discord.wait_for_reply",
        description: "wait with timeout",
        input: {
          channelId: "dmY",
          messageId: "anchor_timeout",
          timeoutMs: 1,
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

    await new Promise((r) => setTimeout(r, 40));

    expect(receivedReq.length).toBe(1);
    const msg = receivedReq[0]!;
    expect(msg.headers?.session_id).toBe("chanX");
    expect(msg.data.queue).toBe("prompt");

    const task = store.getTask(workflowId, "t_timeout");
    expect(task?.state).toBe("resolved");
    expect(task?.resolvedBy?.startsWith("timeout:")).toBe(true);

    await reqSub.stop();
    await svc.stop();
  });
});
