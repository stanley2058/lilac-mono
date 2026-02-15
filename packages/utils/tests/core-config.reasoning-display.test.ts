import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema agent.reasoningDisplay", () => {
  it("defaults to simple", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.agent.reasoningDisplay).toBe("simple");
  });

  it("accepts detailed mode", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        reasoningDisplay: "detailed",
      },
    });

    expect(parsed.agent.reasoningDisplay).toBe("detailed");
  });

  it("accepts none mode", () => {
    const parsed = coreConfigSchema.parse({
      agent: {
        reasoningDisplay: "none",
      },
    });

    expect(parsed.agent.reasoningDisplay).toBe("none");
  });
});
