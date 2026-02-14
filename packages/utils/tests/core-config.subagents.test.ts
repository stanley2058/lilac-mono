import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema agent.subagents", () => {
  it("keeps legacy modelSlot default for explore profile", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.agent.subagents.profiles.explore.modelSlot).toBe("main");
    expect(parsed.agent.subagents.profiles.explore.model).toBeUndefined();
  });

  it("accepts explore profile model alias/spec with options", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        subagents: {
          profiles: {
            explore: {
              model: "sonnet",
              options: {
                anthropic: {
                  thinking: { type: "enabled" },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.agent.subagents.profiles.explore.model).toBe("sonnet");
    expect(parsed.agent.subagents.profiles.explore.options?.anthropic).toEqual({
      thinking: { type: "enabled" },
    });
  });

  it("rejects explore options when model is not set", () => {
    expect(() =>
      coreConfigSchema.parse({
        agent: {
          subagents: {
            profiles: {
              explore: {
                options: {
                  openai: {
                    temperature: 0.2,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow("options requires model to be set");
  });
});
