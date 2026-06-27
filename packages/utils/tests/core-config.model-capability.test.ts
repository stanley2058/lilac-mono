import { describe, expect, it } from "bun:test";

import {
  coreConfigInputSchemaV2,
  coreConfigSchema,
  parseCoreConfigV1ToUniversal,
} from "../core-config";

describe("coreConfigSchema models.capability", () => {
  it("defaults conversation thread summarization and embedding config", () => {
    const v1 = parseCoreConfigV1ToUniversal({});
    expect(v1.conversation.thread.summarization).toEqual({
      enabled: false,
      model: "fast",
      concurrency: 1,
    });
    expect(v1.conversation.thread.embedding).toEqual({
      enabled: false,
      model: "openai/text-embedding-3-small",
    });

    const v2 = coreConfigInputSchemaV2.parse({ configVersion: 2 });
    expect(v2.conversation.thread.summarization).toEqual({
      enabled: false,
      model: "fast",
      concurrency: 1,
    });
    expect(v2.conversation.thread.embedding).toEqual({
      enabled: false,
      model: "openai/text-embedding-3-small",
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
          },
        },
      },
    });

    expect(parsed.conversation.thread.summarization).toEqual({
      enabled: true,
      model: "openrouter/openai/gpt-4o-mini",
      concurrency: 4,
    });
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
