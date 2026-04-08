import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema tools.web.extract.providers", () => {
  it("defaults to tavily", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.web.extract.providers).toEqual(["tavily"]);
  });

  it("accepts ordered providers", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["tavily", "exa", "firecrawl"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["tavily", "exa", "firecrawl"]);
  });

  it("accepts legacy singular provider inside extract", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa"]);
  });

  it("accepts legacy search.provider as an alias", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          search: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa"]);
  });

  it("accepts legacy search.providers as an alias", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          search: {
            providers: ["exa", "tavily"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["exa", "tavily"]);
  });

  it("deduplicates providers while preserving order", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["tavily", "exa", "tavily"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["tavily", "exa"]);
  });

  it("rejects unknown providers", () => {
    expect(() =>
      coreConfigSchema.parse({
        tools: {
          web: {
            extract: {
              provider: "duckduckgo",
            },
          },
        },
      }),
    ).toThrow();
  });
});

describe("coreConfigSchema tools.web.fetch.mode", () => {
  it("defaults to auto", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.web.fetch.mode).toBe("auto");
  });

  it("accepts explicit fetch modes", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          fetch: {
            mode: "provider-only",
          },
        },
      },
    });

    expect(parsed.tools.web.fetch.mode).toBe("provider-only");
  });

  it("accepts firecrawl as a provider", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            providers: ["firecrawl"],
          },
        },
      },
    });

    expect(parsed.tools.web.extract.providers).toEqual(["firecrawl"]);
  });
});

describe("coreConfigSchema tools.experimental_hashline_edit", () => {
  it("defaults to false", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.experimental_hashline_edit).toBe(false);
  });

  it("accepts true", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        experimental_hashline_edit: true,
      },
    });
    expect(parsed.tools.experimental_hashline_edit).toBe(true);
  });
});
