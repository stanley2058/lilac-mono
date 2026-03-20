import { describe, expect, it } from "bun:test";

import { coreConfigSchema } from "../core-config";

describe("coreConfigSchema tools.web.extract.provider", () => {
  it("defaults to tavily", () => {
    const parsed = coreConfigSchema.parse({});
    expect(parsed.tools.web.extract.provider).toBe("tavily");
  });

  it("accepts exa", () => {
    const parsed = coreConfigSchema.parse({
      tools: {
        web: {
          extract: {
            provider: "exa",
          },
        },
      },
    });

    expect(parsed.tools.web.extract.provider).toBe("exa");
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

    expect(parsed.tools.web.extract.provider).toBe("exa");
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
            mode: "extract",
          },
        },
      },
    });

    expect(parsed.tools.web.fetch.mode).toBe("extract");
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
