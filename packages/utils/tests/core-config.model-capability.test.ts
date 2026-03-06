import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema models.capability", () => {
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
