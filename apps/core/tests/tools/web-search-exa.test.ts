import { describe, expect, it } from "bun:test";

import {
  ExaWebSearchProvider,
  TavilyWebSearchProvider,
  resolveWebSearchProvider,
  type WebSearchProvider,
  webSearchInputSchema,
} from "../../src/tool-server/tools/web-search";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("web-search (exa)", () => {
  it("resolveWebSearchProvider falls back to first configured provider", () => {
    const exa = new ExaWebSearchProvider({});
    const tavily = new TavilyWebSearchProvider({ apiKey: "tavily" });

    const resolved = resolveWebSearchProvider({
      requested: "exa",
      providers: [exa, tavily],
    });

    expect(resolved.provider?.id).toBe("tavily");
    expect(resolved.error).toBeNull();
    expect(resolved.warning).toBe(
      "web.search provider 'exa' is not configured; falling back to 'tavily'.",
    );
  });

  it("resolveWebSearchProvider returns a clear missing-config error when no provider is configured", () => {
    const exa = new ExaWebSearchProvider({});
    const tavily = new TavilyWebSearchProvider({});

    const resolved = resolveWebSearchProvider({
      requested: "exa",
      providers: [exa, tavily],
    });

    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBe(
      "web.search is unavailable: EXA_API_KEY is not configured (set env var EXA_API_KEY).",
    );
    expect(resolved.warning).toBeNull();
  });

  it("resolveWebSearchProvider rejects unknown provider ids", () => {
    const exa = new ExaWebSearchProvider({ apiKey: "exa" });
    const tavily = new TavilyWebSearchProvider({ apiKey: "tavily" });

    const resolved = resolveWebSearchProvider({
      requested: "duckduckgo",
      providers: [exa, tavily],
    });

    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBe(
      "web.search is unavailable: unknown provider 'duckduckgo'. Registered: exa, tavily.",
    );
    expect(resolved.warning).toBeNull();
  });

  it("resolveWebSearchProvider supports registered custom providers", () => {
    const custom: WebSearchProvider = {
      id: "MyProvider",
      isConfigured: () => true,
      search: async () => [],
    };

    const resolved = resolveWebSearchProvider({
      requested: "myprovider",
      providers: [custom],
    });

    expect(resolved.provider?.id).toBe("MyProvider");
    expect(resolved.error).toBeNull();
    expect(resolved.warning).toBeNull();
  });

  it("clamps maxResults in schema for all providers", () => {
    expect(webSearchInputSchema.parse({ query: "x", maxResults: 0 }).maxResults).toBe(1);
    expect(webSearchInputSchema.parse({ query: "x", maxResults: -5 }).maxResults).toBe(1);
    expect(webSearchInputSchema.parse({ query: "x", maxResults: 999.9 }).maxResults).toBe(100);
    expect(webSearchInputSchema.parse({ query: "x", maxResults: 3.9 }).maxResults).toBe(3);
  });

  it("sends the expected Exa request payload (clamp + topic + searchDepth + date filters)", async () => {
    type CapturedRequest = {
      pathname: string;
      method: string;
      headers: Headers;
      body: unknown;
    };

    const requests: CapturedRequest[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const text = await req.text();

        let body: unknown = undefined;
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            body = text;
          }
        }

        requests.push({
          pathname: url.pathname,
          method: req.method,
          headers: req.headers,
          body,
        });

        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com",
                title: "Example",
                highlights: [" highlight "],
                score: 0.25,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const provider = new ExaWebSearchProvider({
        apiKey: "exa-test-key",
        baseUrl: `${baseUrl}/`,
      });

      const input = webSearchInputSchema.parse({
        query: "hello",
        topic: "finance",
        searchDepth: "advanced",
        maxResults: 999.9,
        startDate: "2020-01-01",
        endDate: "2020-01-31",
      });

      const results = await provider.search(input);

      expect(results).toEqual([
        {
          url: "https://example.com",
          title: "Example",
          content: "highlight",
          score: 0.25,
        },
      ]);

      expect(requests.length).toBe(1);
      const req = requests[0]!;

      // baseUrl normalization should avoid double slashes like "//search".
      expect(req.pathname).toBe("/search");
      expect(req.method).toBe("POST");
      expect(req.headers.get("x-api-key")).toBe("exa-test-key");

      expect(isRecord(req.body)).toBe(true);
      if (!isRecord(req.body)) {
        throw new Error("expected request body to be a JSON object");
      }

      expect(req.body.query).toBe("hello");
      expect(req.body.type).toBe("deep");
      // clampInt(Math.trunc(999.9), 1, 100)
      expect(req.body.numResults).toBe(100);
      expect(req.body.category).toBe("financial report");
      expect(req.body.startPublishedDate).toBe("2020-01-01");
      expect(req.body.endPublishedDate).toBe("2020-01-31");

      const contents = req.body.contents;
      expect(isRecord(contents)).toBe(true);
      if (!isRecord(contents)) {
        throw new Error("expected request contents to be a JSON object");
      }

      const text = contents.text;
      expect(isRecord(text)).toBe(true);
      if (!isRecord(text)) {
        throw new Error("expected request contents.text to be a JSON object");
      }
      expect(text.maxCharacters).toBe(1000);
      expect(contents.highlights).toBe(true);

      const summary = contents.summary;
      expect(isRecord(summary)).toBe(true);
      if (!isRecord(summary)) {
        throw new Error("expected request contents.summary to be a JSON object");
      }
      expect(summary.query).toBe("hello");
    } finally {
      await server.stop();
    }
  });

  it("maps Exa results into stable WebSearchResult content snippets", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        const longText = "x".repeat(2500);

        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://a.com",
                title: "A",
                highlights: [" first ", "", "second"],
                score: 1,
              },
              {
                url: "https://b.com",
                title: "",
                summary: "  b summary  ",
                score: "bad",
              },
              {
                url: "https://c.com",
                title: "C",
                text: `  ${longText}  `,
              },
              {
                url: "https://d.com",
                title: "D",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      const provider = new ExaWebSearchProvider({
        apiKey: "exa-test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
      });

      const input = webSearchInputSchema.parse({
        query: "hello",
      });

      const results = await provider.search(input);
      expect(results.length).toBe(4);

      expect(results[0]).toEqual({
        url: "https://a.com",
        title: "A",
        content: "first [...] second",
        score: 1,
      });

      expect(results[1]).toEqual({
        url: "https://b.com",
        title: "https://b.com",
        content: "b summary",
        score: null,
      });

      expect(results[2]?.url).toBe("https://c.com");
      expect(results[2]?.title).toBe("C");
      expect(results[2]?.content.length).toBe(2000);
      expect(results[2]?.content).toBe("x".repeat(2000));
      expect(results[2]?.score).toBeNull();

      expect(results[3]).toEqual({
        url: "https://d.com",
        title: "D",
        content: "",
        score: null,
      });
    } finally {
      await server.stop();
    }
  });
});
