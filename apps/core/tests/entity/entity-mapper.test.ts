import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "@stanley2058/lilac-utils";

import { createDiscordEntityMapper } from "../../src/entity/entity-mapper";
import { DiscordSurfaceStore } from "../../src/surface/store/discord-surface-store";

describe("entity-mapper (discord)", () => {
  it("rewrites @username via config (punctuation safe)", async () => {
    const dbPath = path.join(os.tmpdir(), `lilac-entity-mapper-${crypto.randomUUID()}.db`);
    const store = new DiscordSurfaceStore(dbPath);

    try {
      const cfg = coreConfigSchema.parse({
        entity: {
          users: { Stanley: { discord: "123" } },
          sessions: { discord: { dev_channel: "456" } },
        },
      });

      const mapper = createDiscordEntityMapper({ cfg, store });
      expect(mapper.rewriteOutgoingText("hi @Stanley, welcome")).toBe(
        "hi <@123>, welcome",
      );
    } finally {
      store.close();
      try {
        await Bun.file(dbPath).delete();
      } catch {
        // ignore
      }
    }
  });

  it("rewrites @username via DB reverse lookup", async () => {
    const dbPath = path.join(os.tmpdir(), `lilac-entity-mapper-${crypto.randomUUID()}.db`);
    const store = new DiscordSurfaceStore(dbPath);

    try {
      const cfg = coreConfigSchema.parse({});
      store.upsertUserName({
        userId: "999",
        username: "someone",
        updatedTs: Date.now(),
      });

      const mapper = createDiscordEntityMapper({ cfg, store });
      expect(mapper.rewriteOutgoingText("ping @someone")).toBe("ping <@999>");
    } finally {
      store.close();
      try {
        await Bun.file(dbPath).delete();
      } catch {
        // ignore
      }
    }
  });

  it("does not rewrite inside inline code or fenced code", async () => {
    const dbPath = path.join(os.tmpdir(), `lilac-entity-mapper-${crypto.randomUUID()}.db`);
    const store = new DiscordSurfaceStore(dbPath);

    try {
      const cfg = coreConfigSchema.parse({
        entity: {
          users: { Stanley: { discord: "123" } },
          sessions: { discord: { dev_channel: "456" } },
        },
      });
      const mapper = createDiscordEntityMapper({ cfg, store });

      expect(mapper.rewriteOutgoingText("use `@Stanley` here")).toBe(
        "use `@Stanley` here",
      );

      expect(mapper.rewriteOutgoingText("```\n@Stanley\n```"))
        .toBe("```\n@Stanley\n```");

      expect(mapper.rewriteOutgoingText("outside @Stanley, inside `@Stanley`"))
        .toBe("outside <@123>, inside `@Stanley`");

      expect(mapper.rewriteOutgoingText("channel is #dev_channel"))
        .toBe("channel is <#456>");
    } finally {
      store.close();
      try {
        await Bun.file(dbPath).delete();
      } catch {
        // ignore
      }
    }
  });

  it("normalizes inbound mentions to canonical tokens (config casing preferred)", async () => {
    const dbPath = path.join(os.tmpdir(), `lilac-entity-mapper-${crypto.randomUUID()}.db`);
    const store = new DiscordSurfaceStore(dbPath);

    try {
      const cfg = coreConfigSchema.parse({
        entity: {
          users: { Stanley: { discord: "123" } },
          sessions: { discord: { dev_channel: "456" } },
        },
      });
      const mapper = createDiscordEntityMapper({ cfg, store });

      expect(mapper.normalizeIncomingText("hello <@123>"))
        .toBe("hello @Stanley");

      expect(mapper.normalizeIncomingText("go to <#456>"))
        .toBe("go to #dev_channel");

      expect(mapper.normalizeIncomingText("unknown <@999>"))
        .toBe("unknown @user_999");
    } finally {
      store.close();
      try {
        await Bun.file(dbPath).delete();
      } catch {
        // ignore
      }
    }
  });
});
