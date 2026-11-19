import { describe, expect, it } from "bun:test";
import { parseCoreConfigResult } from "../core-config";
import { defaultNativeSurfaceConfig } from "../core-config/types";
import { resolveModelSlot } from "../model-slot";

function parseCoreConfig(raw: unknown) {
  return parseCoreConfigResult(raw).unwrap();
}

const retiredInputs = [
  { tools: { inspect: { model: "google/gemini-3.5-flash" } } },
  { tools: { web: { search: { provider: "exa" } } } },
  { tools: { web: { extract: { provider: "exa" } } } },
  { conversation: { thread: { jevAutoInject: { limit: 2 } } } },
  { conversation: { thread: { autoInjectMode: "jev" } } },
  ...[
    "recallMinProbability",
    "durableSubjectMinProbability",
    "casualMaxProbability",
    "relevanceMinProbability",
  ].map((key) => ({
    conversation: { thread: { decisionAutoInject: { [key]: 0.5 } } },
  })),
  ...Object.entries({
    titleModel: "main",
    outputStreaming: "complete",
    oldMessageSelectionMaxAgeMs: "1h",
    storageRetentionMaxAgeMs: "30d",
    crossThreadSend: { triggerRun: false },
  }).map(([key, value]) => ({ surface: { native: { [key]: value } } })),
];

describe("v3 retired configuration", () => {
  it("accepts and ignores codex_instructions in v1 and v2", () => {
    for (const configVersion of [1, 2]) {
      const cfg = parseCoreConfig({
        configVersion,
        models: {
          main: {
            model: "codex/gpt-6.1-sol",
            options: { codex_instructions: "Retired prompt", parallelToolCalls: false },
          },
        },
      });
      expect(resolveModelSlot(cfg, "main").providerOptions).toEqual({
        openai: { parallelToolCalls: false, store: false, systemMessageMode: "developer" },
      });
    }
  });

  it("rejects codex_instructions in every v3 model options location", () => {
    const options = { codex_instructions: "Retired prompt" };
    const model = "codex/gpt-6.2-sol";
    for (const models of [
      { main: { model, options } },
      { fast: { model, options } },
      { def: { codex: { model, options } } },
      { rules: [{ match: "codex/*", options }] },
      { main: { model, fallback: [{ model, options }] } },
      { fast: { model, fallback: [{ model, options }] } },
      { def: { codex: { model, fallback: [{ model, options }] } } },
    ]) {
      const result = parseCoreConfigResult({ configVersion: 3, models });
      if (!result.isErr()) throw new Error("Expected v3 to reject codex_instructions");
      expect(result.error._tag).toBe("CoreConfigV3Invalid");
      if (result.error._tag !== "CoreConfigV3Invalid") throw result.error;
      expect(JSON.stringify(result.error.cause.issues)).toContain(
        "codex_instructions was removed in configVersion 3",
      );
    }
  });

  for (const input of retiredInputs) {
    it(`rejects ${JSON.stringify(input)} with migration guidance while v2 accepts it`, () => {
      expect(() => parseCoreConfig({ configVersion: 3, ...input })).toThrow("configVersion 3");
      expect(() => parseCoreConfig({ configVersion: 2, ...input })).not.toThrow();
    });
  }

  it("rejects legacy keys even when their replacements are also supplied", () => {
    expect(() =>
      parseCoreConfig({
        configVersion: 3,
        tools: {
          web: {
            search: { provider: "exa" },
            extract: { providers: ["tavily"] },
          },
        },
      }),
    ).toThrow("tools.web.search");
    expect(() =>
      parseCoreConfig({
        configVersion: 3,
        tools: {
          web: {
            extract: { provider: "exa", providers: ["tavily"] },
          },
        },
      }),
    ).toThrow("tools.web.extract.provider");
    expect(() =>
      parseCoreConfig({
        configVersion: 3,
        conversation: {
          thread: {
            jevAutoInject: {},
            decisionAutoInject: {},
          },
        },
      }),
    ).toThrow("jevAutoInject");
  });

  it("preserves canonical web and recall settings", () => {
    const cfg = parseCoreConfig({
      configVersion: 3,
      tools: {
        web: { extract: { providers: ["exa", "tavily", "exa"] }, firecrawl: { queueTtl: "2s" } },
      },
      conversation: {
        thread: {
          autoInjectMode: "decision",
          decisionAutoInject: {
            model: ["typesafe/jev-1.13.0"],
            jev: { recallMinProbability: 0.7 },
            luna: { recallMinProbability: 0.8 },
          },
        },
      },
    });
    expect(cfg.tools.web.extract.providers).toEqual(["exa", "tavily"]);
    expect(cfg.tools.web.firecrawl?.queueTtlMs).toBe(2000);
    expect(cfg.conversation.thread.decisionAutoInject.jev.recallMinProbability).toBe(0.7);
    expect(cfg.conversation.thread.decisionAutoInject.luna.recallMinProbability).toBe(0.8);
    expect(cfg.conversation.thread.autoInject.gate?.model).toEqual(["typesafe/jev-1.13.0"]);
  });

  it("keeps legacy normalization in older versions", () => {
    for (const configVersion of [1, 2]) {
      const cfg = parseCoreConfig({
        configVersion,
        tools: { web: { search: { provider: "exa" } } },
      });
      expect(cfg.tools.web.extract.providers).toEqual(["exa"]);
      expect(cfg.tools).not.toHaveProperty("inspect");
    }
    const cfg = parseCoreConfig({
      configVersion: 2,
      conversation: {
        thread: {
          autoInjectMode: "jev",
          jevAutoInject: { recallMinProbability: 0.7 },
        },
      },
    });
    expect(cfg.conversation.thread.autoInjectMode).toBe("decision");
    expect(cfg.conversation.thread.decisionAutoInject.jev.recallMinProbability).toBe(0.7);
    expect(cfg.conversation.thread.decisionAutoInject.luna.recallMinProbability).toBe(0.7);
  });

  it("uses existing native defaults and retains native admission validation", () => {
    expect(parseCoreConfig({ configVersion: 3 }).surface.native).toEqual(
      defaultNativeSurfaceConfig(),
    );
    expect(() =>
      parseCoreConfig({ configVersion: 3, surface: { native: { enabled: true } } }),
    ).toThrow("Required when the native surface is enabled");
    expect(() =>
      parseCoreConfig({
        configVersion: 3,
        surface: {
          native: {
            enabled: true,
            installationId: "test",
            auth: { provider: "clerk" },
          },
        },
      }),
    ).toThrow("Required when Clerk authentication is enabled");
  });
});
