import { afterEach, describe, expect, it } from "bun:test";

import { Web } from "../../src/tool-server/tools/web";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true);
  }
});

function startServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  servers.push(server);
  return server;
}

function stubWeb(tool: Web, stub: Record<string, unknown>): void {
  Object.assign(tool as unknown as Record<string, unknown>, stub);
}

function callExtractPageContent(
  tool: Web,
  input: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  const privateApi = tool as unknown as {
    extractPageContent: (
      input: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };

  return privateApi.extractPageContent(input, opts);
}

describe("web tool fetch", () => {
  it("propagates abort signals through fetch mode", async () => {
    const server = startServer(async () => {
      await Bun.sleep(200);
      return new Response("hello", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    });
    const tool = new Web();
    const controller = new AbortController();

    const promise = tool.call(
      "fetch",
      {
        url: `http://127.0.0.1:${server.port}/slow`,
        mode: "fetch",
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(promise).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/abort/i),
    });
  });

  it("rejects unsupported binary content types", async () => {
    const server = startServer(() => {
      return new Response("%PDF-1.7", {
        headers: {
          "content-type": "application/pdf",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/binary`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      contentType: "application/pdf",
    });
  });

  it("rejects oversized responses before buffering them", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024 + 10);
    const server = startServer(() => {
      return new Response(oversized, {
        headers: {
          "content-type": "text/plain",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/oversized`,
        mode: "fetch",
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: expect.stringContaining("response too large"),
    });
  });

  it("falls back to simple extraction for large html pages", async () => {
    const repeatedScript = "<script>" + "x".repeat(800_000) + "</script>";
    const html = [
      "<!doctype html>",
      "<html><head><title>Large Page</title></head><body>",
      repeatedScript,
      "<main><h1>Important content</h1><p>Readable fallback text.</p></main>",
      "</body></html>",
    ].join("");
    const server = startServer(() => {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    });
    const tool = new Web();

    await expect(
      tool.call("fetch", {
        url: `http://127.0.0.1:${server.port}/large`,
        mode: "fetch",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Large Page",
      content: expect.stringContaining("Important content"),
    });
  });

  it("auto returns direct markdown from fetch without extra fallbacks", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "# Hello",
          text: "# Hello",
          raw: "# Hello",
        },
        sourceTruncated: false,
      }),
      renderPageContent: async () => {
        throw new Error("browser fallback should not run");
      },
      extractPageContent: async () => {
        throw new Error("extract fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "# Hello",
    });
  });

  it("auto escalates from weak fetched html to browser rendering", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml:
          '<html><body><div id="__next">Loading...</div><script>webpack</script></body></html>',
        sourceTruncated: false,
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown:
            "Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.\n\nA second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.",
          text: "Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent. A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.",
          raw: "<article><p>Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.</p><p>A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.</p></article>",
        },
        rawHtml:
          "<html><body><article><p>Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.</p><p>A second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.</p></article></body></html>",
      }),
      extractPageContent: async () => {
        throw new Error("extract fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Rendered article"),
    });
  });

  it("auto escalates to extract after weak browser rendering", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown: "Sign in",
          text: "Sign in",
          raw: "<main>Sign in</main>",
        },
        rawHtml: "<html><body><main>Sign in</main></body></html>",
      }),
      extractPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Extracted Example",
          markdown: "Useful extracted content from the provider.",
          text: "Useful extracted content from the provider.",
          raw: "Useful extracted content from the provider.",
        },
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Extracted Example",
      content: "Useful extracted content from the provider.",
    });
  });

  it("auto prefers parsed browser content when extract is unavailable", async () => {
    const tool = new Web();

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webFetchDefaultMode: "auto",
      fetchPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Example",
          markdown: "Loading...",
          text: "Loading...",
          raw: '<div id="__next">Loading...</div>',
        },
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      renderPageContent: async () => ({
        isError: false,
        content: {
          url: "https://example.com",
          title: "Rendered Example",
          markdown:
            "![icon](data:image/svg+xml;base64,abc)\n\nPlay the kana quiz and review your progress.",
          text: "Play the kana quiz and review your progress.",
          raw: '<main><img src="data:image/svg+xml;base64,abc"><p>Play the kana quiz and review your progress.</p></main>',
        },
        rawHtml:
          '<html><body><main><img src="data:image/svg+xml;base64,abc"><p>Play the kana quiz and review your progress.</p></main></body></html>',
      }),
      extractPageContent: async () => ({
        isError: true,
        error: "web.extract is unavailable: no provider configured.",
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "auto",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Play the kana quiz"),
    });
  });

  it("uses configured fetch mode when mode is omitted", async () => {
    const tool = new Web();
    stubWeb(tool, {
      refreshWebConfig: async function (this: Record<string, unknown>) {
        this.webFetchDefaultMode = "extract";
      },
      getPageExtract: async () => ({
        isError: false,
        title: "Configured Extract",
        content: "Configured extract content",
        length: 24,
        rearTruncated: false,
        sourceTruncated: false,
      }),
      getPageAuto: async () => {
        throw new Error("auto mode should not run");
      },
      getPageFetch: async () => {
        throw new Error("fetch mode should not run");
      },
      getPageBrowser: async () => {
        throw new Error("browser mode should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Configured Extract",
      content: "Configured extract content",
    });
  });

  it("preserves sourceTruncated for Exa extract when content is capped by budget", async () => {
    const tool = new Web();
    const extractedText = "x".repeat(50_000);

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [{ id: "exa", isConfigured: () => true, search: async () => [] }],
      getExaClient: () => ({
        getContents: async () => ({
          results: [
            {
              url: "https://example.com",
              title: "Example",
              text: extractedText,
            },
          ],
        }),
      }),
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
        maxCharacters: 60_000,
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      length: 50_000,
      sourceTruncated: true,
    });
  });

  it("applies timeout to Exa extract mode", async () => {
    const tool = new Web();

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [{ id: "exa", isConfigured: () => true, search: async () => [] }],
      getExaClient: () => ({
        getContents: async () => {
          await Bun.sleep(50);
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                text: "slow",
              },
            ],
          };
        },
      }),
    });

    await expect(
      callExtractPageContent(tool, {
        url: "https://example.com",
        timeout: 10,
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: expect.stringMatching(/abort|timeout|timed out/i),
    });
  });

  it("falls back to the next search provider on retriable errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        {
          id: "tavily",
          isConfigured: () => true,
          search: async () => {
            calls.push("tavily");
            throw new Error("credits exhausted for current billing period");
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            calls.push("exa");
            return [
              {
                url: "https://example.com",
                title: "Example",
                content: "Recovered from fallback provider.",
                score: null,
              },
            ];
          },
        },
      ],
    });

    await expect(tool.call("search", { query: "fallback test" })).resolves.toEqual([
      {
        url: "https://example.com",
        title: "Example",
        content: "Recovered from fallback provider.",
        score: null,
      },
    ]);
    expect(calls).toEqual(["tavily", "exa"]);
  });

  it("does not fall back on non-retriable search errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        {
          id: "tavily",
          isConfigured: () => true,
          search: async () => {
            calls.push("tavily");
            throw new Error("401 unauthorized");
          },
        },
        {
          id: "exa",
          isConfigured: () => true,
          search: async () => {
            calls.push("exa");
            return [];
          },
        },
      ],
    });

    await expect(tool.call("search", { query: "no retry" })).resolves.toMatchObject({
      isError: true,
      error: "401 unauthorized",
    });
    expect(calls).toEqual(["tavily"]);
  });

  it("falls back to the next extract provider on retriable errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        { id: "tavily", isConfigured: () => true, search: async () => [] },
        { id: "exa", isConfigured: () => true, search: async () => [] },
      ],
      getTavilyClient: () => ({
        extract: async () => {
          calls.push("tavily");
          throw new Error("credits exhausted for current billing period");
        },
      }),
      getExaClient: () => ({
        getContents: async () => {
          calls.push("exa");
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                text: "Recovered from fallback provider.",
              },
            ],
          };
        },
      }),
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "Recovered from fallback provider.",
    });
    expect(calls).toEqual(["tavily", "exa"]);
  });

  it("falls back to the next extract provider on timeout errors", async () => {
    const tool = new Web();
    const calls: string[] = [];

    stubWeb(tool, {
      refreshWebConfig: async () => {},
      webSearchProviders: [
        { id: "exa", isConfigured: () => true, search: async () => [] },
        { id: "tavily", isConfigured: () => true, search: async () => [] },
      ],
      getExaClient: () => ({
        getContents: async () => {
          calls.push("exa");
          await Bun.sleep(50);
          return { results: [] };
        },
      }),
      getTavilyClient: () => ({
        extract: async () => {
          calls.push("tavily");
          return {
            results: [
              {
                url: "https://example.com",
                title: "Example",
                rawContent: "Recovered after timeout fallback.",
              },
            ],
          };
        },
      }),
      getPageBrowser: async () => {
        throw new Error("browser fallback should not run");
      },
    });

    await expect(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "extract",
        timeout: 10,
      }),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "Recovered after timeout fallback.",
    });
    expect(calls).toEqual(["exa", "tavily"]);
  });
});
