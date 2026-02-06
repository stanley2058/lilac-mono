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

describe("createDiscordEntityMapper.extractOutgoingMentionUserIds", () => {
  it("extracts config-backed @Name", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.extractOutgoingMentionUserIds("hi @Stanley")).toEqual(["123"]);
  });

  it("extracts explicit <@id> and <@!id>", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.extractOutgoingMentionUserIds("ping <@456>"))
      .toEqual(["456"]);
    expect(mapper.extractOutgoingMentionUserIds("ping <@!456>"))
      .toEqual(["456"]);
  });

  it("ignores unknown @Name", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.extractOutgoingMentionUserIds("hi @NotAUser")).toEqual([]);
  });

  it("ignores mentions inside inline and fenced code", () => {
    const cfg = buildCfg();
    const store = new DiscordSurfaceStore(":memory:");
    const mapper = createDiscordEntityMapper({ cfg, store });

    expect(mapper.extractOutgoingMentionUserIds("`@Stanley`"))
      .toEqual([]);
    expect(mapper.extractOutgoingMentionUserIds("```\n@Stanley\n```"))
      .toEqual([]);
    expect(mapper.extractOutgoingMentionUserIds("```\n<@456>\n```"))
      .toEqual([]);
  });
});
