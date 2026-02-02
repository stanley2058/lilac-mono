import { describe, expect, it } from "bun:test";

import {
  coreConfigSchema,
  resolveModelSlot,
  type CoreConfig,
} from "../index";

function baseConfig(): CoreConfig {
  const parsed = coreConfigSchema.parse({});
  return {
    ...parsed,
    agent: { systemPrompt: "test" },
  };
}

describe("resolveModelSlot", () => {
  it("resolves models.def alias with deep-merged providerOptions", () => {
    const cfg = baseConfig();

    cfg.models.def = {
      sonnet: {
        model: "openrouter/anthropic/claude-sonnet-4.5",
        options: {
          anthropic: {
            thinking: { type: "enabled" },
          },
          gateway: {
            order: ["anthropic", "vertex", "bedrock"],
          },
        },
      },
    };

    cfg.models.main = {
      model: "sonnet",
      options: {
        // Override nested array; should replace, not merge.
        gateway: {
          order: ["anthropic", "bedrock"],
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.alias).toBe("sonnet");
    expect(resolved.spec).toBe("openrouter/anthropic/claude-sonnet-4.5");

    const opts = resolved.providerOptions;
    expect(opts).toBeDefined();
    expect(opts?.anthropic).toBeDefined();
    expect(opts?.gateway).toBeDefined();
    expect(opts?.gateway?.order).toEqual(["anthropic", "bedrock"]);
    expect(opts?.anthropic?.thinking).toEqual({ type: "enabled" });
  });

  it("treats top-level scalar options as shorthand and wraps under provider namespace", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
      options: {
        temperature: 0.2,
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions).toEqual({
      openai: { temperature: 0.2 },
    });
  });

  it("uses codex_instructions as a top-level meta option for codex", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "codex/gpt-4o",
      options: {
        codex_instructions: "hello",
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions?.openai?.instructions).toBe("hello");
    expect(resolved.providerOptions?.openai?.store).toBe(false);

    // Ensure the meta key is not forwarded.
    expect(resolved.providerOptions?.codex_instructions).toBeUndefined();
  });
});
