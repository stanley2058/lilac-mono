import { describe, expect, it } from "bun:test";

import { coreConfigSchema, type CoreConfig } from "@stanley2058/lilac-utils";

import { createDiscordEntityMapper } from "../../src/entity/entity-mapper";
import { DiscordSurfaceStore } from "../../src/surface/store/discord-surface-store";

function buildCfg(): CoreConfig {
  const base = coreConfigSchema.parse({});

  return {
    ...base,
    agent: { ...base.agent, systemPrompt: "" },
    entity: {
      users: {
        Stanley: { discord: "123" },
        Alice: { discord: "456" },
      },
      sessions: { discord: {} },
    },
  };
}

describe("createDiscordEntityMapper.rewriteOutgoingText", () => {
  it("rewrites config-backed @Name to explicit discord mention", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.rewriteOutgoingText("hi @Stanley")).toBe("hi <@123>");
  });

  it("keeps unknown @Name tokens unchanged", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.rewriteOutgoingText("hi @NotAUser")).toBe("hi @NotAUser");
  });

  it("does not rewrite mentions inside inline and fenced code", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.rewriteOutgoingText("`@Stanley`")).toBe("`@Stanley`");
    expect(mapper.rewriteOutgoingText("```\n@Stanley\n```")).toBe("```\n@Stanley\n```");
  });
});

describe("createDiscordEntityMapper.normalizeIncomingText", () => {
  it("maps bot mention ids to a friendly configured bot name from store", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    store.upsertUserName({
      userId: "999",
      username: "lilac",
      globalName: "lilac",
      displayName: "lilac",
      updatedTs: Date.now(),
    });

    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.normalizeIncomingText("hi <@999>")).toBe("hi @lilac");
  });

  it("prefers configured aliases over store display names", () => {
    const base = buildCfg();
    const existingUsers = base.entity?.users ?? {};
    const cfg: CoreConfig = {
      ...base,
      entity: {
        users: {
          ...existingUsers,
          BotAlias: { discord: "999" },
        },
        sessions: { discord: {} },
      },
    };
    const store = new DiscordSurfaceStore(":memory:");
    store.upsertUserName({
      userId: "999",
      username: "some_other_name",
      globalName: "some_other_name",
      displayName: "some_other_name",
      updatedTs: Date.now(),
    });

    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.normalizeIncomingText("hi <@999>")).toBe("hi @BotAlias");
  });
});
