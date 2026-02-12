import { describe, expect, it } from "bun:test";
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
import { coreConfigSchema, type CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../src/surface/adapter";
import { Workflow } from "../src/tool-server/tools/workflow";
import type { RequestContext } from "../src/tool-server/types";
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
  const cfg = coreConfigSchema.parse(input);
  return { ...cfg, agent: { ...cfg.agent, systemPrompt: "(test)" } };
}

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

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<MsgRef> {
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

  async getReplyContext(
    _msgRef: MsgRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
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
        entity: { sessions: { discord: { ops: "c1" } } },
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
      expect(adapter.sendCalls[0]?.content.attachments?.[0]?.filename).toBe(
        "renamed.txt",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
