import { afterEach, describe, expect, it, jest } from "bun:test";
import { createLogger } from "@stanley2058/lilac-utils";
import type { ServerToolResult } from "@stanley2058/lilac-plugin-runtime";
import { Panic } from "better-result";

import { Web, type WebDependencies } from "../../src/tool-server/tools/web";
import {
  createDefaultWebSearchProviders,
  type WebSearchProvider,
} from "../../src/tool-server/tools/web-search";
import { FirecrawlPermitPool } from "../../src/tool-server/tools/web-search/firecrawl-permit-pool";
import {
  createBrowserPageAcquisition,
  type BrowserPageAcquisition,
} from "../../src/tool-server/tools/web/browser-page-acquisition";
import {
  createDirectHttpPageAcquisition,
  type DirectHttpPageAcquisition,
} from "../../src/tool-server/tools/web/direct-http-page-acquisition";
import { PageContent, type PageContentResult } from "../../src/tool-server/tools/web/page-content";
import {
  DefaultProviderPageExtractor,
  createProviderPageExtractor,
  type ProviderPageExtractor,
  type WebProviderEnvironment,
} from "../../src/tool-server/tools/web/provider-page-extraction";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  jest.useRealTimers();
  while (servers.length > 0) servers.pop()?.stop(true);
});

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

async function toolValue<T = unknown>(pending: Promise<ServerToolResult<T>>): Promise<T> {
  return (await pending).unwrap();
}

function startServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(server);
  return server;
}

function content(
  text: string,
  params: { title?: string; raw?: string; markdown?: string; url?: string } = {},
) {
  return {
    url: params.url ?? "https://example.com",
    title: params.title ?? "Example",
    markdown: params.markdown ?? text,
    text,
    raw: params.raw ?? params.markdown ?? text,
  };
}

const emptyEnvironment: WebProviderEnvironment = {
  firecrawl: {},
  exa: {},
  tavily: {},
};

const baseWebDependencies: WebDependencies = {
  createLogger,
  loadWebToolConfig: async () => ({
    extractProviders: [],
    fetchMode: "auto",
    firecrawlPolicy: undefined,
  }),
  getProviderEnvironment: () => emptyEnvironment,
  createSearchProviders: createDefaultWebSearchProviders,
  createPageContent: () => new PageContent(),
  createDirectPageAcquisition: createDirectHttpPageAcquisition,
  createBrowserPageAcquisition,
  createProviderPageExtractor,
  firecrawlFetchPermits: new FirecrawlPermitPool("fetch"),
  firecrawlSearchPermits: new FirecrawlPermitPool("search"),
};

function createTool(
  params: {
    mode?: "auto" | "fetch" | "browser" | "extract" | "provider-only";
    providers?: readonly WebSearchProvider[];
    direct?: DirectHttpPageAcquisition["acquire"];
    browser?: BrowserPageAcquisition["acquire"];
    extract?: ProviderPageExtractor["extract"];
    fetchPermits?: FirecrawlPermitPool;
    searchPermits?: FirecrawlPermitPool;
    firecrawlPolicy?: { maxConcurrency: number; queueTtlMs: number };
    loadWebToolConfig?: WebDependencies["loadWebToolConfig"];
    getProviderEnvironment?: WebDependencies["getProviderEnvironment"];
  } = {},
): Web {
  const providers = params.providers ?? [];
  const dependencies: WebDependencies = {
    ...baseWebDependencies,
    loadWebToolConfig:
      params.loadWebToolConfig ??
      (async () => ({
        extractProviders: providers.map((provider) => provider.id),
        fetchMode: params.mode ?? "auto",
        firecrawlPolicy: params.firecrawlPolicy,
      })),
    getProviderEnvironment: params.getProviderEnvironment ?? (() => emptyEnvironment),
    createSearchProviders: () => providers,
    createDirectPageAcquisition: () => ({
      acquire:
        params.direct ??
        (async () => ({ isError: true, error: "direct acquisition was not configured" })),
    }),
    createBrowserPageAcquisition: () => ({
      acquire:
        params.browser ??
        (async () => ({ isError: true, error: "browser acquisition was not configured" })),
      destroy: async () => {},
    }),
    createProviderPageExtractor: () => ({
      extract:
        params.extract ??
        (async () => ({ isError: true, error: "provider extraction was not configured" })),
    }),
    firecrawlFetchPermits: params.fetchPermits ?? new FirecrawlPermitPool("fetch"),
    firecrawlSearchPermits: params.searchPermits ?? new FirecrawlPermitPool("search"),
  };
  return new Web(dependencies);
}

function configuredProvider(
  id: WebSearchProvider["id"],
  search: WebSearchProvider["search"] = async () => [],
): WebSearchProvider {
  return { id, isConfigured: () => true, search };
}

function mockFetch(run: () => Promise<Response>): typeof fetch {
  return Object.assign(run, { preconnect: fetch.preconnect });
}

describe("web tool direct fetch", () => {
  it("propagates abort signals through fetch mode", async () => {
    const server = startServer(async () => {
      // test-wait-justification: keeps the real local HTTP response pending so abort propagation wins the race
      await Bun.sleep(200);
      return new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } });
    });
    const pageContent = new PageContent();
    const direct = createDirectHttpPageAcquisition({ pageContent });
    const tool = createTool({ mode: "fetch", direct: direct.acquire.bind(direct) });
    const controller = new AbortController();
    const pending = tool.call(
      "fetch",
      { url: `http://127.0.0.1:${server.port}/slow`, mode: "fetch" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("rejects unsupported binary content types", async () => {
    const server = startServer(
      () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    );
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
    });

    await expect(
      direct.acquire({ url: `http://127.0.0.1:${server.port}/binary` }),
    ).resolves.toMatchObject({ isError: true, contentType: "application/pdf" });
  });

  it("rejects oversized responses before buffering them", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024 + 10);
    const server = startServer(
      () => new Response(oversized, { headers: { "content-type": "text/plain" } }),
    );
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
    });
    const browser = jest.fn(
      async (): Promise<PageContentResult> => ({ isError: true, error: "browser ran" }),
    );
    const tool = createTool({ direct: direct.acquire.bind(direct), browser });

    await expect(
      tool.call("fetch", { url: `http://127.0.0.1:${server.port}/oversized`, mode: "auto" }),
    ).rejects.toThrow("response too large");
    expect(browser).not.toHaveBeenCalled();
  });

  it("cancels Content-Length oversized response bodies before signaling the size limit", async () => {
    const cancel = jest.fn(() => undefined);
    const body = new ReadableStream<Uint8Array>({ cancel });
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
      fetch: mockFetch(
        async () =>
          new Response(body, {
            headers: {
              "content-length": String(5 * 1024 * 1024 + 1),
              "content-type": "text/plain",
            },
          }),
      ),
    });

    await expect(direct.acquire({ url: "https://example.com/oversized" })).rejects.toThrow(
      "response too large",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("gives Content-Length cancellation failure precedence and preserves its identity", async () => {
    const failure = new Error("header response cancellation failed");
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(failure),
    });
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
      fetch: mockFetch(
        async () =>
          new Response(body, {
            headers: {
              "content-length": String(5 * 1024 * 1024 + 1),
              "content-type": "text/plain",
            },
          }),
      ),
    });

    await expect(direct.acquire({ url: "https://example.com/oversized" })).rejects.toBe(failure);
  });

  it("preserves streamed overflow cancellation failure identity", async () => {
    const failure = new Error("stream cancellation failed");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
      },
      cancel: () => Promise.reject(failure),
    });
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
      fetch: mockFetch(
        async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      ),
    });

    await expect(direct.acquire({ url: "https://example.com/streamed" })).rejects.toBe(failure);
  });

  it("preserves Panic from streamed overflow cancellation", async () => {
    const panic = new Panic({ message: "stream cancellation invariant" });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
      },
      cancel: () => Promise.reject(panic),
    });
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
      fetch: mockFetch(
        async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      ),
    });

    await expect(direct.acquire({ url: "https://example.com/streamed" })).rejects.toBe(panic);
  });

  it("falls back to simple extraction for large html pages", async () => {
    const html = [
      "<!doctype html><html><head><title>Large Page</title></head><body>",
      `<script>${"x".repeat(800_000)}</script>`,
      "<main><h1>Important content</h1><p>Readable fallback text.</p></main></body></html>",
    ].join("");
    const server = startServer(
      () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const direct = createDirectHttpPageAcquisition({
      pageContent: new PageContent(),
    });

    await expect(
      direct.acquire({ url: `http://127.0.0.1:${server.port}/large`, format: "text" }),
    ).resolves.toMatchObject({
      isError: false,
      content: { title: "Large Page", text: expect.stringContaining("Important content") },
    });
  });
});

describe("web tool mode orchestration", () => {
  it("rejects unexpected acquisition defects", async () => {
    const defect = new TypeError("invalid direct acquisition state");
    const tool = createTool({
      mode: "fetch",
      direct: async () => {
        throw defect;
      },
    });

    await expect(tool.call("fetch", { url: "https://example.com", mode: "fetch" })).rejects.toBe(
      defect,
    );
  });

  it("maps expected acquisition failures to semantic errors", async () => {
    const tool = createTool({
      mode: "fetch",
      direct: async () => ({ isError: true, error: "upstream stopped", status: 408 }),
    });

    await expect(
      tool.call("fetch", { url: "https://example.com", mode: "fetch" }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "timeout", code: "web_timeout", retryable: true },
    });
  });

  it("auto returns direct markdown without extra fallbacks", async () => {
    const browser = jest.fn(async (): Promise<PageContentResult> => {
      throw new Error("browser fallback should not run");
    });
    const extract = jest.fn(async (): Promise<PageContentResult> => {
      throw new Error("extract fallback should not run");
    });
    const tool = createTool({
      direct: async () => ({ isError: false, content: content("# Hello") }),
      browser,
      extract,
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com", mode: "auto" })),
    ).resolves.toMatchObject({
      isError: false,
      title: "Example",
      content: "# Hello",
    });
    expect(browser).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("auto escalates from weak fetched html to strong browser rendering", async () => {
    const rendered =
      "Rendered article with useful details and enough substance to keep. It has several sentences and useful context for an agent.\n\nA second paragraph adds even more concrete information so the auto flow treats the rendered page as strong content.";
    const extract = jest.fn(async (): Promise<PageContentResult> => {
      throw new Error("extract fallback should not run");
    });
    const tool = createTool({
      direct: async () => ({
        isError: false,
        content: content("Loading...", { raw: '<div id="__next">Loading...</div>' }),
        rawHtml:
          '<html><body><div id="__next">Loading...</div><script>webpack</script></body></html>',
      }),
      browser: async () => ({
        isError: false,
        content: content(rendered, {
          title: "Rendered Example",
          raw: `<article><p>${rendered}</p></article>`,
        }),
        rawHtml: `<html><body><article><p>${rendered}</p></article></body></html>`,
      }),
      extract,
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com", mode: "auto", format: "text" })),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Rendered article"),
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("auto escalates to a provider after weak browser rendering", async () => {
    const providers = [configuredProvider("exa")];
    const tool = createTool({
      providers,
      direct: async () => ({
        isError: false,
        content: content("Loading..."),
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      browser: async () => ({
        isError: false,
        content: content("Sign in", { title: "Rendered Example" }),
        rawHtml: "<html><body><main>Sign in</main></body></html>",
      }),
      extract: async () => ({
        isError: false,
        content: content("Useful extracted content from the provider.", {
          title: "Extracted Example",
        }),
      }),
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com", mode: "auto" })),
    ).resolves.toMatchObject({
      isError: false,
      title: "Extracted Example",
      content: "Useful extracted content from the provider.",
    });
  });

  it("auto prefers parsed browser content when provider extraction is unavailable", async () => {
    const rawHtml =
      '<html><body><main><img src="data:image/svg+xml;base64,abc"><p>Play the kana quiz and review your progress.</p></main></body></html>';
    const tool = createTool({
      direct: async () => ({
        isError: false,
        content: content("Loading..."),
        rawHtml: '<html><body><div id="__next">Loading...</div></body></html>',
      }),
      browser: async () => ({
        isError: false,
        content: content("Play the kana quiz and review your progress.", {
          title: "Rendered Example",
          markdown:
            "![icon](data:image/svg+xml;base64,abc)\n\nPlay the kana quiz and review your progress.",
        }),
        rawHtml,
      }),
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com", mode: "auto" })),
    ).resolves.toMatchObject({
      isError: false,
      title: "Rendered Example",
      content: expect.stringContaining("Play the kana quiz"),
    });
  });

  it("uses the configured mode when mode is omitted", async () => {
    const direct = jest.fn(
      async (): Promise<PageContentResult> => ({
        isError: false,
        content: content("direct"),
      }),
    );
    const extract = jest.fn(
      async (): Promise<PageContentResult> => ({
        isError: false,
        content: content("Configured extract content", { title: "Configured Extract" }),
      }),
    );
    const tool = createTool({
      mode: "extract",
      providers: [configuredProvider("exa")],
      direct,
      extract,
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com" })),
    ).resolves.toMatchObject({
      isError: false,
      title: "Configured Extract",
      content: "Configured extract content",
    });
    expect(direct).not.toHaveBeenCalled();
  });

  it("provider-only returns provider errors without browser fallback", async () => {
    const browser = jest.fn(
      async (): Promise<PageContentResult> => ({
        isError: true,
        error: "browser fallback ran",
      }),
    );
    const tool = createTool({
      providers: [configuredProvider("exa")],
      browser,
      extract: async () => ({ isError: true, error: "provider unavailable" }),
    });

    await expect(
      tool.call("fetch", { url: "https://example.com", mode: "provider-only" }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "unavailable", message: "provider unavailable" },
    });
    expect(browser).not.toHaveBeenCalled();
  });

  it("extract mode falls back to browser after provider failure", async () => {
    const tool = createTool({
      providers: [configuredProvider("exa")],
      extract: async () => ({ isError: true, error: "provider unavailable" }),
      browser: async () => ({
        isError: false,
        content: content("Browser fallback", { title: "Browser" }),
      }),
    });

    await expect(
      toolValue(tool.call("fetch", { url: "https://example.com", mode: "extract" })),
    ).resolves.toMatchObject({ isError: false, title: "Browser", content: "Browser fallback" });
  });
});

describe("web provider extraction", () => {
  it("preserves the terminal status category in an aggregated fallback failure", async () => {
    const tool = createTool({
      providers: [configuredProvider("tavily"), configuredProvider("exa")],
      extract: async (providerId) => {
        if (providerId === "tavily") {
          throw { message: "primary provider failed", response: { status: 503 } };
        }
        throw Object.assign(new Error("access blocked"), { status: 403 });
      },
    });

    await expect(
      tool.call("fetch", { url: "https://example.com", mode: "provider-only" }),
    ).resolves.toMatchObject({
      status: "error",
      error: {
        kind: "denied",
        code: "web_denied",
        message:
          "web.extract failed across fallback providers: tavily: primary provider failed | exa: access blocked",
      },
    });
  });

  it("falls through unsupported html providers to Firecrawl", async () => {
    const calls: string[] = [];
    const tool = createTool({
      providers: [configuredProvider("tavily"), configuredProvider("firecrawl")],
      extract: async (providerId) => {
        calls.push(providerId);
        return providerId === "tavily"
          ? { isError: true, error: "Tavily extract does not support format=html." }
          : {
              isError: false,
              content: content("Firecrawl HTML", {
                title: "Firecrawl HTML",
                raw: "<main>Firecrawl HTML</main>",
              }),
            };
      },
    });

    await expect(
      toolValue(
        tool.call("fetch", {
          url: "https://example.com",
          mode: "provider-only",
          format: "html",
        }),
      ),
    ).resolves.toMatchObject({
      isError: false,
      title: "Firecrawl HTML",
      content: "<main>Firecrawl HTML</main>",
    });
    expect(calls).toEqual(["tavily", "firecrawl"]);
  });

  it("maps Firecrawl scrape payloads for html extraction", async () => {
    const server = startServer(async (request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer firecrawl-test-key");
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        url: "https://example.com/article",
        formats: ["html"],
        timeout: 120_000,
      });
      return Response.json({
        success: true,
        data: {
          html: "<html><body><main>Rendered Firecrawl article</main></body></html>",
          metadata: {
            title: "Firecrawl Article",
            sourceURL: "https://example.com/final-article",
          },
        },
      });
    });
    const extractor = createProviderPageExtractor({
      getEnvironment: () => ({
        ...emptyEnvironment,
        firecrawl: {
          apiKey: "firecrawl-test-key",
          apiBaseUrl: `http://127.0.0.1:${server.port}`,
        },
      }),
      firecrawlPermits: new FirecrawlPermitPool("fetch"),
    });

    await expect(
      extractor.extract("firecrawl", {
        url: "https://example.com/article",
        format: "html",
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: {
        url: "https://example.com/final-article",
        title: "Firecrawl Article",
        raw: "<html><body><main>Rendered Firecrawl article</main></body></html>",
      },
    });
  });

  it("maps Firecrawl markdown to plain text", async () => {
    const server = startServer(() =>
      Response.json({
        success: true,
        data: {
          markdown: "# Firecrawl Article\n\n[Useful link](https://example.com)\n\n- Bullet point",
          metadata: {
            title: "Firecrawl Text Article",
            sourceURL: "https://example.com/text-article",
          },
        },
      }),
    );
    const extractor = createProviderPageExtractor({
      getEnvironment: () => ({
        ...emptyEnvironment,
        firecrawl: {
          apiKey: "firecrawl-test-key",
          apiBaseUrl: `http://127.0.0.1:${server.port}`,
        },
      }),
      firecrawlPermits: new FirecrawlPermitPool("fetch"),
    });

    await expect(
      extractor.extract("firecrawl", {
        url: "https://example.com/article",
        format: "text",
      }),
    ).resolves.toMatchObject({
      isError: false,
      content: {
        url: "https://example.com/text-article",
        title: "Firecrawl Text Article",
        text: "Firecrawl Article Useful link Bullet point",
      },
    });
  });

  it("preserves provider source truncation in exact output slicing", async () => {
    const extracted = "x".repeat(50_000);
    const tool = createTool({
      providers: [configuredProvider("exa")],
      extract: async () => ({
        isError: false,
        sourceTruncated: true,
        content: content(extracted),
      }),
    });

    await expect(
      toolValue(
        tool.call("fetch", {
          url: "https://example.com",
          mode: "provider-only",
          maxCharacters: 60_000,
        }),
      ),
    ).resolves.toMatchObject({
      isError: false,
      length: 50_000,
      sourceTruncated: true,
    });
  });

  it("applies the Exa character budget and reports source truncation", async () => {
    const requestedBudgets: number[] = [];
    const extracted = "x".repeat(50_000);
    const extractor = new DefaultProviderPageExtractor({
      getEnvironment: () => ({ ...emptyEnvironment, exa: { apiKey: "exa-test-key" } }),
      firecrawlPermits: new FirecrawlPermitPool("fetch"),
      fetch,
      createTavilyClient: () => {
        throw new Error("Tavily client should not be created");
      },
      createExaClient: () =>
        ({
          getContents: async (_urls: string[], options: { text: { maxCharacters: number } }) => {
            requestedBudgets.push(options.text.maxCharacters);
            return {
              results: [{ url: "https://example.com", title: "Example", text: extracted }],
            };
          },
        }) as never,
    });

    await expect(
      extractor.extract("exa", {
        url: "https://example.com",
        startOffset: 20_000,
        maxCharacters: 60_000,
      }),
    ).resolves.toMatchObject({
      isError: false,
      sourceTruncated: true,
      content: { text: extracted },
    });
    expect(requestedBudgets).toEqual([50_000]);
  });

  it("applies timeout to Exa extraction", async () => {
    const extractor = new DefaultProviderPageExtractor({
      getEnvironment: () => ({ ...emptyEnvironment, exa: { apiKey: "exa-test-key" } }),
      firecrawlPermits: new FirecrawlPermitPool("fetch"),
      fetch,
      createTavilyClient: () => {
        throw new Error("Tavily client should not be created");
      },
      createExaClient: () =>
        ({
          getContents: async () => {
            // test-wait-justification: keeps the fake Exa request pending beyond the extraction timeout
            await Bun.sleep(50);
            return { results: [] };
          },
        }) as never,
    });

    await expect(
      extractor.extract("exa", { url: "https://example.com", timeout: 10 }),
    ).rejects.toThrow(/abort|timeout|timed out/i);
  });

  it("falls back on retriable extraction errors but not terminal errors", async () => {
    const calls: string[] = [];
    const providers = [configuredProvider("tavily"), configuredProvider("exa")];
    const retriable = createTool({
      providers,
      extract: async (providerId) => {
        calls.push(providerId);
        if (providerId === "tavily")
          throw new Error("credits exhausted for current billing period");
        return { isError: false, content: content("Recovered from fallback provider.") };
      },
    });
    await expect(
      toolValue(retriable.call("fetch", { url: "https://example.com", mode: "provider-only" })),
    ).resolves.toMatchObject({ isError: false, content: "Recovered from fallback provider." });
    expect(calls).toEqual(["tavily", "exa"]);

    calls.length = 0;
    const terminal = createTool({
      providers,
      extract: async (providerId) => {
        calls.push(providerId);
        throw new Error("401 unauthorized");
      },
    });
    await expect(
      terminal.call("fetch", { url: "https://example.com", mode: "provider-only" }),
    ).resolves.toMatchObject({
      status: "error",
      error: { kind: "denied", message: "401 unauthorized" },
    });
    expect(calls).toEqual(["tavily"]);
  });
});

describe("web search and permits", () => {
  it("preserves the terminal status category in an aggregated fallback failure", async () => {
    const tool = createTool({
      providers: [
        configuredProvider("tavily", async () => {
          throw { message: "primary provider failed", response: { status: 503 } };
        }),
        configuredProvider("exa", async () => {
          throw Object.assign(new Error("resource absent"), { status: 404 });
        }),
      ],
    });

    await expect(tool.call("search", { query: "fallback categories" })).resolves.toMatchObject({
      status: "error",
      error: {
        kind: "not_found",
        code: "web_not_found",
        message:
          "web.search failed across fallback providers: tavily: primary provider failed | exa: resource absent",
      },
    });
  });

  it("preserves Panic identity from search providers", async () => {
    const panic = new Panic({ message: "search provider invariant" });
    const tool = createTool({
      providers: [
        configuredProvider("exa", async () => {
          throw panic;
        }),
      ],
    });

    const [settled] = await Promise.allSettled([tool.call("search", { query: "panic" })]);
    expect(settled).toEqual({ status: "rejected", reason: panic });
  });

  it("preserves Panic from web config loading", async () => {
    const panic = new Panic({ message: "web config invariant" });
    const tool = createTool({
      loadWebToolConfig: async () => {
        throw panic;
      },
    });

    const [settled] = await Promise.allSettled([
      tool.call("fetch", { url: "https://example.com", mode: "fetch" }),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });

  it("falls back to the next search provider only on retriable errors", async () => {
    const calls: string[] = [];
    const fallback = configuredProvider("exa", async () => {
      calls.push("exa");
      return [
        {
          url: "https://example.com",
          title: "Example",
          content: "Recovered from fallback provider.",
          score: null,
        },
      ];
    });
    const retriable = createTool({
      providers: [
        configuredProvider("tavily", async () => {
          calls.push("tavily");
          throw new Error("credits exhausted for current billing period");
        }),
        fallback,
      ],
    });
    await expect(
      toolValue(retriable.call("search", { query: "fallback test" })),
    ).resolves.toHaveLength(1);
    expect(calls).toEqual(["tavily", "exa"]);

    calls.length = 0;
    const terminal = createTool({
      providers: [
        configuredProvider("tavily", async () => {
          calls.push("tavily");
          throw new Error("401 unauthorized");
        }),
        fallback,
      ],
    });
    await expect(terminal.call("search", { query: "no retry" })).resolves.toMatchObject({
      status: "error",
      error: { kind: "denied", message: "401 unauthorized" },
    });
    expect(calls).toEqual(["tavily"]);
  });

  it("queues Firecrawl searches and falls back when queue TTL expires", async () => {
    jest.useFakeTimers({ now: 0 });
    const pool = new FirecrawlPermitPool("search");
    pool.configure({ maxConcurrency: 2, queueTtlMs: 3_000 });
    const twoStarted = deferred();
    const releaseActive = deferred();
    const thirdAcquireStarted = deferred();
    let firecrawlCalls = 0;
    let acquisitions = 0;
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquisitions += 1;
      if (acquisitions === 3) thirdAcquireStarted.resolve();
      return acquire(signal);
    };
    const tool = createTool({
      searchPermits: pool,
      firecrawlPolicy: { maxConcurrency: 2, queueTtlMs: 3_000 },
      providers: [
        configuredProvider("firecrawl", async () => {
          firecrawlCalls += 1;
          if (firecrawlCalls === 2) twoStarted.resolve();
          await releaseActive.promise;
          return [];
        }),
        configuredProvider("exa", async () => [
          {
            url: "https://example.com",
            title: "Fallback",
            content: "Search fallback",
            score: null,
          },
        ]),
      ],
    });

    const first = toolValue(tool.call("search", { query: "first" }));
    const second = toolValue(tool.call("search", { query: "second" }));
    await twoStarted.promise;
    const third = toolValue(tool.call("search", { query: "third" }));
    await thirdAcquireStarted.promise;
    jest.advanceTimersByTime(3_000);
    await expect(third).resolves.toEqual([
      { url: "https://example.com", title: "Fallback", content: "Search fallback", score: null },
    ]);
    expect(firecrawlCalls).toBe(2);
    releaseActive.resolve();
    await Promise.all([first, second]);
  });

  it("does not invoke providers for an aborted Firecrawl search waiter", async () => {
    const pool = new FirecrawlPermitPool("search");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let firecrawlCalls = 0;
    let fallbackCalls = 0;
    const tool = createTool({
      searchPermits: pool,
      firecrawlPolicy: { maxConcurrency: 1, queueTtlMs: 3_000 },
      providers: [
        configuredProvider("firecrawl", async () => {
          firecrawlCalls += 1;
          firstStarted.resolve();
          await releaseFirst.promise;
          return [];
        }),
        configuredProvider("exa", async () => {
          fallbackCalls += 1;
          return [];
        }),
      ],
    });

    const first = toolValue(tool.call("search", { query: "first" }));
    await firstStarted.promise;
    const controller = new AbortController();
    const second = tool.call("search", { query: "second" }, { signal: controller.signal });
    controller.abort();
    await expect(second).resolves.toMatchObject({
      status: "error",
      error: { kind: "cancelled", message: expect.stringMatching(/aborted/i) },
    });
    expect(firecrawlCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
    releaseFirst.resolve();
    await first;
  });

  it("falls back after a Firecrawl fetch queue timeout", async () => {
    jest.useFakeTimers({ now: 0 });
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const active = (await pool.acquire()).match({
      ok: (permit) => permit,
      err: (error) => {
        throw new Error(error.message);
      },
    });
    const acquireStarted = deferred();
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquireStarted.resolve();
      return acquire(signal);
    };
    const extractor = createProviderPageExtractor({
      getEnvironment: () => ({
        ...emptyEnvironment,
        firecrawl: { apiKey: "firecrawl-test-key" },
      }),
      firecrawlPermits: pool,
    });
    const calls: string[] = [];
    const tool = createTool({
      fetchPermits: pool,
      firecrawlPolicy: { maxConcurrency: 1, queueTtlMs: 3_000 },
      providers: [configuredProvider("firecrawl"), configuredProvider("exa")],
      extract: async (providerId, input, opts) => {
        calls.push(providerId);
        if (providerId === "firecrawl") return extractor.extract(providerId, input, opts);
        return { isError: false, content: content("Fetch fallback", { title: "Fallback" }) };
      },
    });

    const pending = toolValue(
      tool.call("fetch", {
        url: "https://example.com",
        mode: "provider-only",
      }),
    );
    await acquireStarted.promise;
    jest.advanceTimersByTime(3_000);
    await expect(pending).resolves.toMatchObject({
      isError: false,
      title: "Fallback",
      content: "Fetch fallback",
    });
    expect(calls).toEqual(["firecrawl", "exa"]);
    active.release();
  });

  it("does not enter browser fallback for an aborted Firecrawl fetch waiter", async () => {
    const pool = new FirecrawlPermitPool("fetch");
    pool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const active = (await pool.acquire()).match({
      ok: (permit) => permit,
      err: (error) => {
        throw new Error(error.message);
      },
    });
    const acquireStarted = deferred();
    const acquire = pool.acquire.bind(pool);
    pool.acquire = (signal) => {
      acquireStarted.resolve();
      return acquire(signal);
    };
    const extractor = createProviderPageExtractor({
      getEnvironment: () => ({
        ...emptyEnvironment,
        firecrawl: { apiKey: "firecrawl-test-key" },
      }),
      firecrawlPermits: pool,
    });
    const browser = jest.fn(
      async (): Promise<PageContentResult> => ({ isError: true, error: "browser ran" }),
    );
    const tool = createTool({
      fetchPermits: pool,
      firecrawlPolicy: { maxConcurrency: 1, queueTtlMs: 3_000 },
      providers: [configuredProvider("firecrawl")],
      browser,
      extract: (providerId, input, opts) => extractor.extract(providerId, input, opts),
    });
    const controller = new AbortController();
    const pending = tool.call(
      "fetch",
      { url: "https://example.com", mode: "extract" },
      { signal: controller.signal },
    );
    await acquireStarted.promise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "error",
      error: { kind: "cancelled", message: expect.stringMatching(/aborted/i) },
    });
    expect(browser).not.toHaveBeenCalled();
    active.release();
  });

  it("preserves active Firecrawl policy when config refresh fails", async () => {
    const fetchPool = new FirecrawlPermitPool("fetch");
    fetchPool.configure({ maxConcurrency: 1, queueTtlMs: 3_000 });
    const active = (await fetchPool.acquire()).match({
      ok: (permit) => permit,
      err: (error) => {
        throw new Error(error.message);
      },
    });
    let queuedAdmitted = false;
    const queued = fetchPool.acquire().then((result) =>
      result.match({
        ok: (permit) => {
          queuedAdmitted = true;
          return permit;
        },
        err: (error) => {
          throw new Error(error.message);
        },
      }),
    );
    const tool = createTool({
      fetchPermits: fetchPool,
      loadWebToolConfig: async () => {
        throw new Error("config unavailable");
      },
    });

    await tool.call("fetch", { url: "https://example.com", mode: "fetch" });
    await Promise.resolve();
    expect(queuedAdmitted).toBe(false);
    active.release();
    const admitted = await queued;
    admitted.release();
  });

  it("creates browser and provider state per Web while sharing injected permit pools", () => {
    const browsers: BrowserPageAcquisition[] = [];
    const extractors: ProviderPageExtractor[] = [];
    const observedPools: FirecrawlPermitPool[] = [];
    const sharedFetchPermits = new FirecrawlPermitPool("fetch");
    const dependencies: WebDependencies = {
      ...baseWebDependencies,
      firecrawlFetchPermits: sharedFetchPermits,
      createBrowserPageAcquisition: () => {
        const browser = {
          acquire: async (): Promise<PageContentResult> => ({ isError: true, error: "unused" }),
          destroy: async () => {},
        };
        browsers.push(browser);
        return browser;
      },
      createProviderPageExtractor: ({ firecrawlPermits }) => {
        const extractor = {
          extract: async (): Promise<PageContentResult> => ({ isError: true, error: "unused" }),
        };
        observedPools.push(firecrawlPermits);
        extractors.push(extractor);
        return extractor;
      },
    };

    new Web(dependencies);
    new Web(dependencies);
    expect(browsers).toHaveLength(2);
    expect(browsers[0]).not.toBe(browsers[1]);
    expect(extractors).toHaveLength(2);
    expect(extractors[0]).not.toBe(extractors[1]);
    expect(observedPools).toEqual([sharedFetchPermits, sharedFetchPermits]);
  });
});

describe("fetch URL protocols", () => {
  it("rejects non-HTTP URLs before any acquisition in every mode", async () => {
    const web = new Web(baseWebDependencies);
    for (const mode of ["auto", "fetch", "browser", "extract", "provider-only"]) {
      for (const url of [
        "file:///etc/passwd",
        "data:text/plain,hello",
        "javascript:alert(1)",
        "ftp://example.com",
      ]) {
        const result = await web.call(
          "fetch",
          { url, mode },
          { context: { safetyMode: "restricted" } },
        );
        expect(result.isErr()).toBe(true);
      }
    }
  });
});
