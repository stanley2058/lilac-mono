import { describe, expect, it } from "bun:test";

import {
  coreConfigInputSchemaV2,
  coreConfigInputSchemaV3,
  coreConfigSchema,
  parseCoreConfigV1ToUniversal,
} from "../core-config";

import type { ModelCapabilityOverride } from "../core-config/types";

describe("coreConfigSchema models.capability", () => {
  it("defaults conversation thread summarization, embedding, and auto injection config", () => {
    const v2 = coreConfigInputSchemaV2.parse({ configVersion: 2 });
    expect(v2.conversation.thread.summarization).toEqual({
      enabled: false,
      model: "fast",
      concurrency: 1,
      batchSize: 32,
      includePromptContext: false,
    });
    expect(v2.conversation.thread.embedding).toEqual({
      enabled: false,
      model: "openai/text-embedding-3-small",
    });
    expect(v2.conversation.thread.autoInject).toEqual({
      enabled: false,
      minTextUnits: 10,
      followUpMinTextUnits: 10,
      limit: 3,
      minScore: 0.1,
      expansionMinConfidence: 0.65,
      mode: "hybrid",
      filterCurrentParticipants: false,
    });
  });

  it("accepts conversation thread summarization model override", () => {
    const parsed = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          summarization: {
            enabled: true,
            model: "openrouter/openai/gpt-4o-mini",
            concurrency: 4,
            batchSize: 24,
            includePromptContext: true,
          },
        },
      },
    });

    expect(parsed.conversation.thread.summarization).toEqual({
      enabled: true,
      model: "openrouter/openai/gpt-4o-mini",
      concurrency: 4,
      batchSize: 24,
      includePromptContext: true,
    });
  });

  it("accepts conversation thread auto inject planner model overrides", () => {
    const parsed = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          autoInject: {
            enabled: true,
            plannerModel: "openrouter/openai/gpt-4o-mini",
            textPlannerModel: "openai/gpt-5.3-codex-spark",
            minTextUnits: 120,
            followUpMinTextUnits: 150,
            limit: 4,
            minScore: 0.2,
            expansionMinConfidence: 0.68,
            mode: "semantic",
            filterCurrentParticipants: true,
          },
        },
      },
    });

    expect(parsed.conversation.thread.autoInject).toEqual({
      enabled: true,
      plannerModel: "openrouter/openai/gpt-4o-mini",
      textPlannerModel: "openai/gpt-5.3-codex-spark",
      minTextUnits: 120,
      followUpMinTextUnits: 150,
      limit: 4,
      minScore: 0.2,
      expansionMinConfidence: 0.68,
      mode: "semantic",
      filterCurrentParticipants: true,
    });
  });

  it("rejects auto-inject expansion confidence outside zero through one", () => {
    expect(() =>
      coreConfigInputSchemaV2.parse({
        configVersion: 2,
        conversation: {
          thread: {
            autoInject: { expansionMinConfidence: 1.01 },
          },
        },
      }),
    ).toThrow();
  });

  it("defaults conversation thread auto inject to the LLM lane with Decision options", () => {
    const v2 = coreConfigInputSchemaV2.parse({ configVersion: 2 });
    const v1 = parseCoreConfigV1ToUniversal({ configVersion: 1 });
    const expectedDecision = {
      model: ["typesafe/jev-1.13.0"],
      limit: 3,
      candidateLimit: 40,
      semanticFallback: true,
      jev: {
        recallMinProbability: 0,
        durableSubjectMinProbability: 0.6,
        casualMaxProbability: 0.6,
        relevanceMinProbability: 0.2,
      },
      luna: {
        recallMinProbability: 0,
        durableSubjectMinProbability: 0.5,
        casualMaxProbability: 0.3,
        relevanceMinProbability: 0.1,
      },
    };

    expect(v2.conversation.thread.autoInjectMode).toBe("llm");
    expect(v2.conversation.thread.decisionAutoInject).toEqual(expectedDecision);
    expect(v1.conversation.thread.autoInjectMode).toBe("llm");
    expect(v1.conversation.thread.decisionAutoInject).toEqual(expectedDecision);
  });

  it("migrates legacy decision modes to shadow and gives explicit gates precedence", () => {
    for (const autoInjectMode of ["decision", "jev"]) {
      const migrated = coreConfigInputSchemaV2.parse({
        conversation: {
          thread: {
            autoInjectMode,
            decisionAutoInject: { model: "openai/gpt-6-luna", relevanceMinProbability: 0.99 },
          },
        },
      });
      expect(migrated.conversation.thread.autoInject.gate).toEqual({
        mode: "shadow",
        model: ["openai/gpt-6-luna"],
        skipMinProbability: 0.8,
      });
      const explicit = coreConfigInputSchemaV2.parse({
        conversation: {
          thread: {
            autoInjectMode,
            autoInject: { gate: { mode: "off" } },
          },
        },
      });
      expect(explicit.conversation.thread.autoInject.gate?.mode).toBe("off");
    }
    const configured = coreConfigInputSchemaV2.parse({
      conversation: {
        thread: {
          autoInject: { gate: { model: ["typesafe/jev-1.13.0", "openai/gpt-6-luna"] } },
        },
      },
    });
    expect(configured.conversation.thread.autoInject.gate?.mode).toBe("shadow");
    for (const gate of [
      { model: [] },
      { mode: "invalid" },
      { skipMinProbability: 0.4 },
      { skipMinProbability: 1.1 },
    ]) {
      expect(() =>
        coreConfigInputSchemaV2.parse({ conversation: { thread: { autoInject: { gate } } } }),
      ).toThrow();
    }
  });

  it("accepts Decision auto inject mode and partial option overrides", () => {
    const parsed = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          autoInjectMode: "decision",
          decisionAutoInject: { candidateLimit: 12, relevanceMinProbability: 0.75 },
        },
      },
    });

    expect(parsed.conversation.thread.autoInjectMode).toBe("decision");
    expect(parsed.conversation.thread.decisionAutoInject).toMatchObject({
      model: ["typesafe/jev-1.13.0"],
      candidateLimit: 12,
      jev: { relevanceMinProbability: 0.75 },
    });
  });

  it("normalizes legacy Jev settings and gives explicit decision settings precedence", () => {
    const legacy = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          autoInjectMode: "jev",
          jevAutoInject: { candidateLimit: 12, relevanceMinProbability: 0.75 },
        },
      },
    });
    expect(legacy.conversation.thread.autoInjectMode).toBe("decision");
    expect(legacy.conversation.thread.decisionAutoInject).toMatchObject({
      candidateLimit: 12,
      jev: { relevanceMinProbability: 0.75 },
    });
    expect("jevAutoInject" in legacy.conversation.thread).toBe(false);
    const both = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          jevAutoInject: { candidateLimit: 12 },
          decisionAutoInject: { model: "openai/gpt-6-luna", candidateLimit: 20 },
        },
      },
    });
    expect(both.conversation.thread.decisionAutoInject).toMatchObject({
      model: ["openai/gpt-6-luna"],
      candidateLimit: 20,
    });
  });

  it("keeps model order and independent scoped thresholds, overriding legacy fields", () => {
    const parsed = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      conversation: {
        thread: {
          decisionAutoInject: {
            model: ["typesafe/jev-1.13.0", "openai/gpt-6-luna"],
            recallMinProbability: 0.8,
            jev: { relevanceMinProbability: 0.72 },
            luna: { recallMinProbability: 0.55, relevanceMinProbability: 0.92 },
          },
        },
      },
    });
    expect(parsed.conversation.thread.decisionAutoInject).toMatchObject({
      model: ["typesafe/jev-1.13.0", "openai/gpt-6-luna"],
      jev: { recallMinProbability: 0.8, relevanceMinProbability: 0.72 },
      luna: { recallMinProbability: 0.55, relevanceMinProbability: 0.92 },
    });
    expect("recallMinProbability" in parsed.conversation.thread.decisionAutoInject).toBe(false);
    for (const value of [
      { model: [] },
      { model: [""] },
      { jev: { recallMinProbability: -0.1 } },
      { luna: { relevanceMinProbability: 1.1 } },
    ]) {
      expect(() =>
        coreConfigInputSchemaV2.parse({
          configVersion: 2,
          conversation: { thread: { decisionAutoInject: value } },
        }),
      ).toThrow();
    }
  });

  it("rejects unknown auto inject modes and Decision probabilities outside zero through one", () => {
    expect(() =>
      coreConfigInputSchemaV2.parse({
        configVersion: 2,
        conversation: { thread: { autoInjectMode: "planner" } },
      }),
    ).toThrow();
    expect(() =>
      coreConfigInputSchemaV2.parse({
        configVersion: 2,
        conversation: { thread: { decisionAutoInject: { casualMaxProbability: 1.2 } } },
      }),
    ).toThrow();
  });

  it("defaults forceUnknownProviders and empty overrides", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.models.capability.forceUnknownProviders).toEqual(["openai-compatible"]);
    expect(parsed.models.capability.overrides).toEqual({});
  });

  it("accepts inherited override patches", () => {
    const parsed = coreConfigSchema.parse({
      models: {
        capability: {
          overrides: {
            "openai-compatible/new-model": {
              inherit: "openai/gpt-4o-mini",
              limit: {
                context: 262144,
              },
            },
          },
        },
      },
    });

    expect(parsed.models.capability.overrides["openai-compatible/new-model"]?.inherit).toBe(
      "openai/gpt-4o-mini",
    );
    expect(parsed.models.capability.overrides["openai-compatible/new-model"]?.limit?.context).toBe(
      262144,
    );
  });

  it("accepts over-200k cost tier in inherited overrides", () => {
    const parsed = coreConfigSchema.parse({
      models: {
        capability: {
          overrides: {
            "openai-compatible/new-model": {
              inherit: "anthropic/claude-opus-4-6",
              cost: {
                context_over_200k: {
                  input: 10,
                  output: 37.5,
                  cache_read: 1,
                  cache_write: 12.5,
                },
              },
            },
          },
        },
      },
    });

    expect(
      parsed.models.capability.overrides["openai-compatible/new-model"]?.cost?.context_over_200k,
    ).toEqual({
      input: 10,
      output: 37.5,
      cache_read: 1,
      cache_write: 12.5,
    });
  });

  it("accepts full manual overrides without inherit", () => {
    const parsed = coreConfigSchema.parse({
      models: {
        capability: {
          overrides: {
            "custom/private-model": {
              limit: {
                context: 131072,
                output: 8192,
              },
              cost: {
                input: 0.6,
                output: 2.4,
              },
              modalities: {
                input: ["text"],
                output: ["text"],
              },
            },
          },
        },
      },
    });

    expect(parsed.models.capability.overrides["custom/private-model"]?.limit?.context).toBe(131072);
    expect(parsed.models.capability.overrides["custom/private-model"]?.cost?.input).toBe(0.6);
  });

  it("accepts attachment support in v2 overrides", () => {
    const parsed = coreConfigInputSchemaV2.parse({
      configVersion: 2,
      models: {
        capability: {
          overrides: {
            "custom/private-model": {
              limit: {
                context: 131072,
                output: 8192,
              },
              cost: {
                input: 0.6,
                output: 2.4,
              },
              attachment: true,
              modalities: {
                input: ["text", "image", "pdf"],
                output: ["text"],
              },
            },
          },
        },
      },
    });

    expect(parsed.models.capability.overrides["custom/private-model"]?.attachment).toBe(true);
  });

  it.each([2, 3])("accepts partial upstream capability overrides in v%i", (configVersion) => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "codex/gpt-6-astra": { limit: { context: 395000 } },
      "openai/gpt-6-astra": { cost: { input: 0.6, context_over_200k: { input: 1 } } },
      "openai/gpt-6.1-sol": { attachment: false, modalities: { output: ["text"] } },
    };
    const schema = configVersion === 2 ? coreConfigInputSchemaV2 : coreConfigInputSchemaV3;
    const parsed = schema.parse({ configVersion, models: { capability: { overrides } } });
    expect(parsed.models.capability.overrides).toEqual(overrides);
  });

  it("rejects direct override without limit.context", () => {
    expect(() =>
      coreConfigSchema.parse({
        models: {
          capability: {
            overrides: {
              "custom/private-model": {
                cost: {
                  input: 0.6,
                  output: 2.4,
                },
              },
            },
          },
        },
      }),
    ).toThrow("limit.context is required when inherit is not set");
  });

  it("rejects direct partial cost patches without inherit", () => {
    expect(() =>
      coreConfigSchema.parse({
        models: {
          capability: {
            overrides: {
              "custom/private-model": {
                limit: {
                  context: 131072,
                },
                cost: {
                  input: 0.6,
                },
              },
            },
          },
        },
      }),
    ).toThrow("cost.input and cost.output are required when inherit is not set");
  });
});
