import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema tools.web.search.provider", () => {
  it("defaults to tavily", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.web.search.provider).toBe("tavily");
  });

  it("accepts exa", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          search: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.search.provider).toBe("exa");
  });

  it("rejects unknown providers", () => {
    expect(() =>
      coreConfigSchema.parse({
        tools: {
          web: {
            search: {
              provider: "duckduckgo",
            },
          },
        },
      }),
    ).toThrow();
  });
});
