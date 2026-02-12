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
import type { RequestContext } from "../src/tool-server/types";
import { Attachment } from "../src/tool-server/tools/attachment";

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

function isAddFilesResult(
  value: unknown,
): value is { ok: true; attachments: Array<{ filename: string }> } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && Array.isArray(record.attachments);
}

describe("tool-server attachment", () => {
  it("accepts scalar paths and filenames", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "lilac-att-tool-server-"));
    const p = join(tmp, "hello.txt");
    await fs.writeFile(p, "hello", "utf8");

    try {
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const tool = new Attachment({ bus });

      const ctx: RequestContext = {
        requestId: "discord:c1:m1",
        sessionId: "c1",
        requestClient: "discord",
        cwd: tmp,
      };

      const res = await tool.call(
        "attachment.add_files",
        {
          paths: p,
          filenames: "renamed.txt",
        },
        { context: ctx },
      );

      expect(isAddFilesResult(res)).toBe(true);
      if (!isAddFilesResult(res)) return;
      expect(res.attachments.length).toBe(1);
      expect(res.attachments[0]?.filename).toBe("renamed.txt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
