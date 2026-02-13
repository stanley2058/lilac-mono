import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema agent.statsForNerds", () => {
  it("defaults to false", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.agent.statsForNerds).toBe(false);
  });

  it("accepts boolean true", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        statsForNerds: true,
      },
    });

    expect(parsed.agent.statsForNerds).toBe(true);
  });

  it("accepts object mode with verbose flag", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        statsForNerds: { verbose: true },
      },
    });

    expect(parsed.agent.statsForNerds).toEqual({ verbose: true });
  });
});
