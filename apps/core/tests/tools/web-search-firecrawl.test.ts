import { afterEach, describe, expect, it } from "bun:test";

import {
  FirecrawlWebSearchProvider,
  webSearchInputSchema,
} from "../../src/tool-server/tools/web-search";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("web-search (firecrawl)", () => {
  it("sends the expected Firecrawl request payload", async () => {
    const requests: Array<{ headers: Headers; body: unknown; pathname: string }> = [];

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({
          headers: req.headers,
          body: (await req.json()) as unknown,
          pathname: url.pathname,
        });

        return new Response(JSON.stringify({ success: true, data: { news: [] } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    servers.push(server);

    const provider = new FirecrawlWebSearchProvider({
      apiKey: "firecrawl-test-key",
      apiBaseUrl: `http://127.0.0.1:${server.port}/`,
    });

    await provider.search(
      webSearchInputSchema.parse({
        query: "firecrawl",
        topic: "news",
        maxResults: 999,
        timeRange: "w",
      }),
    );

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.pathname).toBe("/v2/search");
    expect(request.headers.get("authorization")).toBe("Bearer firecrawl-test-key");

    expect(isRecord(request.body)).toBe(true);
    if (!isRecord(request.body)) {
      throw new Error("expected JSON request body");
    }

    expect(request.body.query).toBe("firecrawl");
    expect(request.body.limit).toBe(20);
    expect(request.body.sources).toEqual(["news"]);
    expect(request.body.tbs).toBe("qdr:w");
  });

  it("normalizes Firecrawl search responses with scraped content", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                sourceURL: "https://example.com/post",
                markdown: "# Example\n\nUseful content.",
                description: "Short description",
                metadata: {
                  title: "Example title",
                },
                score: 0.75,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    servers.push(server);

    const provider = new FirecrawlWebSearchProvider({
      apiKey: "firecrawl-test-key",
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
    });

    await expect(
      provider.search(webSearchInputSchema.parse({ query: "example" })),
    ).resolves.toEqual([
      {
        url: "https://example.com/post",
        title: "Example title",
        content: "# Example\n\nUseful content.",
        score: 0.75,
      },
    ]);
  });
});
