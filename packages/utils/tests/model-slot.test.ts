import { describe, expect, it } from "bun:test";

import {
  fromDurableResolvedModelPlan,
  fromDurableResolvedModelRequest,
  parseCoreConfigV1ToUniversal,
  providers,
  resolveModelChain,
  resolveModelPlan,
  resolveModelRef,
  resolveModelSlot,
  resolveModelSlotResult,
  resolveModelSlotPlan,
  toDurableResolvedModelPlan,
  toDurableResolvedModelRequest,
  withModelPlanReasoning,
  type CoreConfig,
} from "../index";

function baseConfig(): CoreConfig {
  const parsed = parseCoreConfigV1ToUniversal({});
  return {
    ...parsed,
    agent: { ...parsed.agent, systemPrompt: "test" },
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

  it("inherits model alias reasoning and lets slots override it", () => {
    const cfg = baseConfig();

    cfg.models.def = {
      "gpt-5.5": {
        model: "openai/gpt-5.5",
        reasoning: "high",
      },
    };

    cfg.models.main = {
      model: "gpt-5.5",
    };

    expect(resolveModelSlot(cfg, "main").reasoning).toBe("high");

    cfg.models.main = {
      model: "gpt-5.5",
      reasoning: "medium",
    };

    expect(resolveModelSlot(cfg, "main").reasoning).toBe("medium");
  });

  it("lets direct model refs override alias reasoning", () => {
    const cfg = baseConfig();

    cfg.models.def = {
      "gpt-5.5": {
        model: "openai/gpt-5.5",
        reasoning: "high",
      },
    };

    const resolved = resolveModelRef(
      cfg,
      {
        model: "gpt-5.5",
        reasoning: "low",
      },
      "agent.subagents.profiles.explore.model",
    );

    expect(resolved.reasoning).toBe("low");
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
      openai: {
        temperature: 0.2,
        parallelToolCalls: true,
      },
    });
  });

  it("maps openai-compatible provider shorthand options to openaiCompatible namespace", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai-compatible/llama-3.1-8b",
      options: {
        temperature: 0.2,
      },
    };

    const providerMap = providers as unknown as Record<
      string,
      ((modelId: string) => unknown) | null
    >;
    const originalProvider = providerMap["openai-compatible"];
    providerMap["openai-compatible"] = (modelId: string) => ({ modelId });

    try {
      const resolved = resolveModelSlot(cfg, "main");
      expect(resolved.providerOptions).toEqual({
        openaiCompatible: {
          temperature: 0.2,
        },
      });
    } finally {
      providerMap["openai-compatible"] = originalProvider ?? null;
    }
  });

  it("reports not configured when provider exists but is disabled", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai-compatible/llama-3.1-8b",
    };

    const providerMap = providers as unknown as Record<
      string,
      ((modelId: string) => unknown) | null
    >;
    const originalProvider = providerMap["openai-compatible"];
    providerMap["openai-compatible"] = null;

    try {
      expect(() => resolveModelSlot(cfg, "main")).toThrow(
        "Provider 'openai-compatible' is not configured",
      );
      const result = resolveModelSlotResult(cfg, "main");
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error.issue).toBe("provider-not-configured");
    } finally {
      providerMap["openai-compatible"] = originalProvider ?? null;
    }
  });

  it("enables openai.parallelToolCalls by default for openai models", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions).toEqual({
      openai: {
        parallelToolCalls: true,
      },
    });
  });

  it("respects explicit openai.parallelToolCalls=false", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
      options: {
        openai: {
          parallelToolCalls: false,
          temperature: 0.1,
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions).toEqual({
      openai: {
        parallelToolCalls: false,
        temperature: 0.1,
      },
    });
  });

  it("ignores retired Codex instructions in v1 model options", () => {
    const cfg = baseConfig();
    cfg.basePrompt = "base prompt";
    cfg.models.main = {
      model: "codex/gpt-4o",
      options: {
        codex_instructions: "hello",
        openai: {
          instructions: "direct provider instruction",
          systemMessageMode: "remove",
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions).toEqual({
      openai: { parallelToolCalls: true, store: false, systemMessageMode: "developer" },
    });
  });

  it("restores old Codex plans with developer input and without retired instructions", () => {
    const restored = fromDurableResolvedModelRequest({
      spec: "codex/gpt-4o",
      provider: "codex",
      modelId: "gpt-4o",
      reasoningDisplay: "detailed",
      providerOptions: {
        openai: {
          instructions: "Former Codex prompt",
          systemMessageMode: "remove",
          parallelToolCalls: false,
        },
      },
    });
    expect(restored.providerOptions).toEqual({
      openai: { parallelToolCalls: false, store: false, systemMessageMode: "developer" },
    });
  });

  it("preserves explicitly configured Responses instructions for the OpenAI provider", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
      options: {
        openai: {
          instructions: "direct provider instruction",
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions?.openai?.instructions).toBe("direct provider instruction");
  });

  it("uses response_commentary as a top-level meta option for openai", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
      options: {
        response_commentary: true,
        openai: {
          temperature: 0.1,
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.responseCommentary).toBe(true);
    expect(resolved.providerOptions?.openai?.parallelToolCalls).toBe(true);
    expect(resolved.providerOptions?.openai?.temperature).toBe(0.1);

    // Ensure the meta key is not forwarded.
    expect(resolved.providerOptions?.response_commentary).toBeUndefined();
  });

  it("uses openai_server_compaction as a top-level meta option after alias and slot merging", () => {
    const cfg = baseConfig();
    cfg.models.def = {
      primary: {
        model: "openai/gpt-4o",
        options: {
          openai_server_compaction: true,
          openai: { temperature: 0.1 },
        },
      },
    };
    cfg.models.main = {
      model: "primary",
      options: {
        openai: { textVerbosity: "low" },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.openaiServerCompaction).toBe(true);
    expect(resolved.providerOptions?.openai?.temperature).toBe(0.1);
    expect(resolved.providerOptions?.openai?.textVerbosity).toBe("low");
    expect(resolved.providerOptions?.openai_server_compaction).toBeUndefined();
  });

  it("rejects invalid or unsupported openai_server_compaction options", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-4o",
      options: { openai_server_compaction: false },
    };
    expect(() => resolveModelSlot(cfg, "main")).toThrow(
      "Model option 'openai_server_compaction' must be literal boolean true",
    );

    cfg.models.main.options = { openai_server_compaction: "true" };
    expect(() => resolveModelSlot(cfg, "main")).toThrow(
      "Model option 'openai_server_compaction' must be literal boolean true",
    );

    cfg.models.main = {
      model: "openrouter/openai/gpt-4o",
      options: { openai_server_compaction: true },
    };
    expect(() => resolveModelSlot(cfg, "main")).toThrow(
      "Model option 'openai_server_compaction' is supported only by openai and codex providers",
    );

    cfg.models.main = {
      model: "codex/gpt-4o",
      options: { openai_server_compaction: true },
    };
    expect(resolveModelSlot(cfg, "main").openaiServerCompaction).toBe(true);
  });

  it.each([
    ["legacy", true],
    ["auto", undefined],
    [true, undefined],
    [false, false],
  ] as const)("resolves the %s cache policy without forwarding it", (setting, override) => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openrouter/anthropic/claude-sonnet-4.5",
      options: {
        anthropic_prompt_cache: setting,
        openrouter: {
          route: "fallback",
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    const durable = toDurableResolvedModelRequest(resolved, "none");
    expect(resolved.anthropicPromptCache).toBe(override);
    expect(durable.anthropicPromptCache).toBe(override);
    expect(fromDurableResolvedModelRequest(durable).anthropicPromptCache).toBe(override);
    expect(resolved.providerOptions?.openrouter?.route).toBe("fallback");
    expect(resolved.providerOptions?.anthropic_prompt_cache).toBeUndefined();
  });

  it("leaves anthropic_prompt_cache unset when omitted", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openrouter/anthropic/claude-sonnet-4.5",
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.anthropicPromptCache).toBeUndefined();
  });

  it("preserves an Anthropic cache opt-out through inheritance and durable model resolution", () => {
    const cfg = baseConfig();
    cfg.models.def = {
      sonnet: {
        model: "openrouter/anthropic/claude-sonnet-4.5",
        options: { anthropic_prompt_cache: "legacy" },
      },
    };
    cfg.models.main = {
      model: "sonnet",
      options: { anthropic_prompt_cache: false },
    };

    const resolved = resolveModelSlot(cfg, "main");
    const durable = toDurableResolvedModelRequest(resolved, "none");

    expect(resolved.anthropicPromptCache).toBe(false);
    expect(resolved.providerOptions?.anthropic_prompt_cache).toBeUndefined();
    expect(durable.anthropicPromptCache).toBe(false);
    expect(fromDurableResolvedModelRequest(durable).anthropicPromptCache).toBe(false);
  });

  it("keeps accepting an older configuration with a null Anthropic cache option", () => {
    const cfg = parseCoreConfigV1ToUniversal({
      models: {
        main: {
          model: "cerebras/gpt-oss-120b",
          options: { anthropic_prompt_cache: null },
        },
      },
    });

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.anthropicPromptCache).toBeUndefined();
    expect(resolved.providerOptions).toBeUndefined();
  });

  it("uses response_commentary as a top-level meta option for codex", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "codex/gpt-4o",
      options: {
        response_commentary: true,
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.responseCommentary).toBe(true);
    expect(resolved.providerOptions?.openai).not.toHaveProperty("instructions");
    expect(resolved.providerOptions?.openai?.parallelToolCalls).toBe(true);
    expect(resolved.providerOptions?.openai?.store).toBe(false);

    // Ensure the meta key is not forwarded.
    expect(resolved.providerOptions?.response_commentary).toBeUndefined();
  });

  it("ignores response_commentary for non-openai and non-codex providers", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openrouter/anthropic/claude-sonnet-4.5",
      options: {
        response_commentary: true,
        openrouter: {
          route: "fallback",
        },
      },
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.responseCommentary).toBeUndefined();
    expect(resolved.providerOptions?.openrouter?.route).toBe("fallback");
    expect(resolved.providerOptions?.response_commentary).toBeUndefined();
  });

  it("applies codex defaults when options are omitted", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "codex/gpt-4o",
    };

    const resolved = resolveModelSlot(cfg, "main");
    expect(resolved.providerOptions).toEqual({
      openai: {
        systemMessageMode: "developer",
        parallelToolCalls: true,
        store: false,
      },
    });
  });

  it("resolves alias refs and merges preset options with override options", () => {
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

    const resolved = resolveModelRef(
      cfg,
      {
        model: "sonnet",
        options: {
          gateway: {
            order: ["anthropic", "bedrock"],
          },
        },
      },
      "agent.subagents.profiles.explore.model",
    );

    expect(resolved.alias).toBe("sonnet");
    expect(resolved.spec).toBe("openrouter/anthropic/claude-sonnet-4.5");
    expect(resolved.providerOptions?.anthropic?.thinking).toEqual({ type: "enabled" });
    expect(resolved.providerOptions?.gateway?.order).toEqual(["anthropic", "bedrock"]);
  });
});

describe("resolved model plans", () => {
  it("uses an alias chain when the slot has no nearer chain and preserves head repeats", () => {
    const cfg = baseConfig();
    cfg.models.def = {
      primary: {
        model: "openai/gpt-5.5",
        reasoning: "high",
        fallback: [
          "primary",
          {
            model: "backup",
            reasoning: "low",
            options: { temperature: 0.1 },
          },
          "primary",
        ],
      },
      backup: {
        model: "openrouter/openai/gpt-4o",
        options: { gateway: { order: ["openai"] } },
      },
    };
    cfg.models.main = { model: "primary" };

    const plan = resolveModelSlotPlan(cfg, "main");

    expect(plan.head.spec).toBe("openai/gpt-5.5");
    expect(plan.fallbacks.map((candidate) => candidate.spec)).toEqual([
      "openai/gpt-5.5",
      "openrouter/openai/gpt-4o",
      "openai/gpt-5.5",
    ]);
    expect(plan.fallbacks.map((candidate) => candidate.reasoning)).toEqual(["high", "low", "high"]);
    expect(plan.fallbacks[1]?.providerOptions?.openrouter?.temperature).toBe(0.1);
    expect(plan.fallbacks[1]?.providerOptions?.openrouter?.gateway).toEqual({ order: ["openai"] });
  });

  it("lets an explicit empty or repeated slot chain override the alias chain", () => {
    const cfg = baseConfig();
    cfg.models.def.primary = {
      model: "openai/gpt-5.5",
      fallback: ["openai/gpt-4o-mini"],
    };
    cfg.models.main = { model: "primary", fallback: [] };

    expect(resolveModelSlotPlan(cfg, "main").fallbacks).toEqual([]);

    cfg.models.main.fallback = ["primary", "primary"];
    expect(resolveModelSlotPlan(cfg, "main").fallbacks.map((candidate) => candidate.spec)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5",
    ]);
  });

  it("applies a common reasoning override while resolving every candidate", () => {
    const cfg = baseConfig();
    cfg.models.def.primary = {
      model: "openai/gpt-5.5",
      reasoning: "high",
      fallback: [{ model: "openai/gpt-4o", reasoning: "low" }, "openrouter/openai/gpt-4o-mini"],
    };

    const plan = resolveModelPlan(cfg, {
      head: { model: "primary" },
      headSource: "agent.subagents.profiles.explore.model",
      fallbackSource: "agent.subagents.profiles.explore.fallback",
      reasoningOverride: "medium",
    });

    expect([plan.head, ...plan.fallbacks].map((candidate) => candidate.reasoning)).toEqual([
      "medium",
      "medium",
      "medium",
    ]);

    expect(
      withModelPlanReasoning(plan, "none").fallbacks.map((candidate) => candidate.reasoning),
    ).toEqual(["none", "none"]);
  });

  it("reports the indexed fallback source when resolution fails", () => {
    const cfg = baseConfig();

    expect(() =>
      resolveModelChain(
        cfg,
        ["openai/gpt-4o", "missing"],
        "agent.subagents.profiles.general.fallback",
      ),
    ).toThrow("Unknown model alias 'missing' (agent.subagents.profiles.general.fallback[1])");

    cfg.models.def.primary = {
      model: "openai/gpt-5.5",
      fallback: ["missing"],
    };
    cfg.models.main = { model: "primary" };
    expect(() => resolveModelSlotPlan(cfg, "main")).toThrow(
      "Unknown model alias 'missing' (models.def.primary.fallback[0])",
    );
  });

  it("round-trips durable plans and treats legacy requests as an empty chain", () => {
    const cfg = baseConfig();
    cfg.models.main = {
      model: "openai/gpt-5.5",
      options: { openai_server_compaction: true },
      fallback: [
        "openrouter/openai/gpt-4o",
        {
          model: "openai/gpt-4o-mini",
          reasoning: "none",
          options: { openai_server_compaction: true },
        },
      ],
    };
    const plan = resolveModelSlotPlan(cfg, "main");

    const durable = toDurableResolvedModelPlan(plan, "detailed");
    expect(durable.fallbacks?.map((candidate) => candidate.spec)).toEqual([
      "openrouter/openai/gpt-4o",
      "openai/gpt-4o-mini",
    ]);
    expect(durable.fallbacks?.every((candidate) => candidate.reasoningDisplay === "detailed")).toBe(
      true,
    );
    expect(durable.openaiServerCompaction).toBe(true);
    expect(durable.fallbacks?.[1]?.openaiServerCompaction).toBe(true);

    const restored = fromDurableResolvedModelPlan(durable);
    expect(restored.head.spec).toBe(plan.head.spec);
    expect(restored.fallbacks.map((candidate) => candidate.spec)).toEqual(
      plan.fallbacks.map((candidate) => candidate.spec),
    );
    expect(restored.fallbacks[1]?.reasoning).toBe("none");
    expect(restored.fallbacks[1]?.reasoningDisplay).toBe("detailed");
    expect(restored.head.openaiServerCompaction).toBe(true);
    expect(restored.fallbacks[1]?.openaiServerCompaction).toBe(true);

    const { fallbacks: _fallbacks, ...legacy } = durable;
    expect(fromDurableResolvedModelPlan(legacy).fallbacks).toEqual([]);
    expect(() =>
      fromDurableResolvedModelPlan({
        ...legacy,
        spec: "anthropic/claude-test",
        provider: "anthropic",
        modelId: "claude-test",
        openaiServerCompaction: true,
      }),
    ).toThrow("supported only by openai and codex providers");
  });
});
