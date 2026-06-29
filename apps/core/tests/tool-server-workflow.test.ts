import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../src/surface/adapter";
import { Workflow } from "../src/tool-server/tools/workflow";
import type { RequestContext } from "../src/tool-server/types";
import { SqliteWorkflowStore } from "../src/workflow/workflow-store";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../src/surface/types";

function testConfig(input: unknown): CoreConfig {
  const cfg = parseCoreConfigV1ToUniversal(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

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
      const id = `${Date.now()}-0`;
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

    fetch: async <TData>(topic: string, _opts: FetchOptions) => {
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

class FakeAdapter implements SurfaceAdapter {
  public sendCalls: Array<{
    sessionRef: SessionRef;
    content: ContentOpts;
    opts?: SendOpts;
  }> = [];

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }

  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "discord",
      send: true,
      edit: true,
      delete: true,
      reactions: true,
      readHistory: true,
      threads: true,
      markRead: true,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }

  async startOutput(): Promise<never> {
    throw new Error("not implemented");
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, opts?: SendOpts): Promise<MsgRef> {
    this.sendCalls.push({ sessionRef, content, opts });
    return { platform: "discord", channelId: sessionRef.channelId, messageId: "m1" };
  }

  async readMsg(): Promise<SurfaceMessage | null> {
    throw new Error("not implemented");
  }

  async listMsg(): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async editMsg(): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteMsg(): Promise<void> {
    throw new Error("not implemented");
  }

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async addReaction(): Promise<void> {
    throw new Error("not implemented");
  }

  async removeReaction(): Promise<void> {
    throw new Error("not implemented");
  }

  async listReactions(): Promise<string[]> {
    throw new Error("not implemented");
  }

  async subscribe(): Promise<never> {
    throw new Error("not implemented");
  }

  async getUnRead(): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async markRead(): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("tool-server workflow", () => {
  it("accepts scalar attachment fields for send_and_wait", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-workflow-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const cfg = testConfig({
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: ["c1"],
            allowedGuildIds: [],
            botName: "lilac",
          },
        },
        entity: {
          sessions: {
            discord: {
              ops: { discord: "c1", comment: "Deploy coordination" },
            },
          },
        },
      });

      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const adapter = new FakeAdapter();
      const tool = new Workflow({ bus, adapter, config: cfg });

      const ctx: RequestContext = {
        requestId: "discord:c1:m0",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await tool.call(
        "workflow.wait_for_reply.send_and_wait",
        {
          sessionId: "#ops",
          text: "hello",
          silent: true,
          paths: p,
          filenames: "renamed.txt",
          taskDescription: "wait for reply",
          summary: "summary",
        },
        { context: ctx },
      );

      expect(res).toMatchObject({ ok: true });
      expect(adapter.sendCalls.length).toBe(1);
      expect(adapter.sendCalls[0]?.content.attachments?.length).toBe(1);
      expect(adapter.sendCalls[0]?.content.attachments?.[0]?.filename).toBe("renamed.txt");
      expect(adapter.sendCalls[0]?.opts?.silent).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("lists workflows without failing on malformed scheduled task rows", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const store = new SqliteWorkflowStore(":memory:");
    const tool = new Workflow({ bus, workflowStore: store });

    store.upsertWorkflow({
      workflowId: "wf_scheduled",
      state: "blocked",
      createdAt: 1,
      updatedAt: 1,
      definition: {
        version: 3,
        kind: "scheduled",
        schedule: {
          mode: "wait_until",
          runAtMs: 123,
        },
        job: {
          summary: "scheduled job",
          userPrompt: "run it",
        },
      },
      resumeSeq: 0,
    });
    store.upsertTask({
      workflowId: "wf_scheduled",
      taskId: "bad",
      kind: "time.wait_until",
      description: "bad task",
      state: "blocked",
      input: {
        runAtMs: 123,
      },
      createdAt: 1,
      updatedAt: 1,
      timeoutAt: 123,
    });

    getUnsafeDb(store)
      .query("UPDATE workflow_tasks SET input_json = ? WHERE workflow_id = ? AND task_id = ?")
      .run("{", "wf_scheduled", "bad");

    const withoutTasks = (await tool.call("workflow.list", {})) as {
      ok: boolean;
      workflows: Array<{ workflowId: string; nextRunAt?: number; tasks?: unknown[] }>;
    };
    expect(withoutTasks.ok).toBe(true);
    expect(withoutTasks.workflows[0]?.workflowId).toBe("wf_scheduled");
    expect(withoutTasks.workflows[0]?.nextRunAt).toBeUndefined();
    expect(withoutTasks.workflows[0]?.tasks).toBeUndefined();

    const withTasks = (await tool.call("workflow.list", { includeTasks: true })) as {
      ok: boolean;
      workflows: Array<{ workflowId: string; tasks?: unknown[] }>;
    };
    expect(withTasks.ok).toBe(true);
    expect(withTasks.workflows[0]?.tasks).toEqual([]);
  });
});
