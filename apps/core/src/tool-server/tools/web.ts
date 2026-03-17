import { z } from "zod";
import type { Logger } from "@stanley2058/simple-module-logger";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";
import { tavily, type TavilyClient } from "@tavily/core";
import TurndownService from "turndown";
import { createLogger, env, getCoreConfig } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  createDefaultWebSearchProviders,
  resolveWebSearchProvider,
  webSearchInputSchema,
  type WebSearchProvider,
} from "./web-search";

const getPageSchema = z.object({
  url: z.string().describe("URL to fetch"),
  mode: z
    .enum(["fetch", "browser", "tavily"])
    .optional()
    .default("fetch")
    .describe(
      "Mode to use for fetching the page; `fetch`: simple & fast; `browser`: renders dynamic content; `tavily`: best request w/ usage limits",
    ),
  format: z
    .union([z.literal("markdown"), z.literal("text"), z.literal("html")])
    .optional()
    .default("markdown")
    .describe("Format of the output"),
  preprocessor: z
    .union([z.literal("none"), z.literal("readability")])
    .optional()
    .default("none")
    .describe(
      "Preprocessor to use for parsing the page; Only apply to `fetch` and `browser`; `readability` uses the Mozilla Readability library.",
    ),
  startOffset: z.coerce.number().optional(),
  maxCharacters: z.coerce.number().optional().describe("Max characters (default: 200000)"),
  timeout: z.coerce
    .number()
    .optional()
    .describe(
      "Timeout in ms. Timeout for initial connection if using browser. (default: 10000 = 10s)",
    ),
});

const MAX_FETCH_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_FULL_DOM_PARSE_BYTES = 750 * 1024;
const SUPPORTED_TEXT_MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/xhtml+xml",
]);

function createAbortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}

function parseMediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType && mediaType.length > 0 ? mediaType : null;
}

function isTextMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  if (SUPPORTED_TEXT_MEDIA_TYPES.has(mediaType)) return true;
  return mediaType.startsWith("text/");
}

function isHtmlMediaType(mediaType: string | null): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function contentLengthFromHeaders(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
}

async function readResponseTextWithLimit(params: {
  res: Response;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  checkSignal(params.signal);

  const contentLength = contentLengthFromHeaders(params.res.headers);
  if (contentLength !== null && contentLength > params.maxBytes) {
    throw new Error(`response too large (${contentLength} bytes > ${params.maxBytes} byte limit)`);
  }

  if (!params.res.body) {
    const fallback = await params.res.text();
    const bytes = Buffer.byteLength(fallback, "utf8");
    if (bytes > params.maxBytes) {
      return {
        text: fallback.slice(0, params.maxBytes),
        bytesRead: params.maxBytes,
        truncated: true,
      };
    }
    return { text: fallback, bytesRead: bytes, truncated: false };
  }

  const reader = params.res.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let truncated = false;

  const onAbort = () => {
    void reader.cancel(createAbortError()).catch(() => null);
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      checkSignal(params.signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      bytesRead += value.byteLength;
      if (bytesRead > params.maxBytes) {
        truncated = true;
        const allowedBytes = value.byteLength - (bytesRead - params.maxBytes);
        if (allowedBytes > 0) {
          text += decoder.decode(value.subarray(0, allowedBytes), { stream: true });
        }
        await reader.cancel("response byte limit reached").catch(() => null);
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytesRead: Math.min(bytesRead, params.maxBytes), truncated };
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}

function extractTitleFromHtml(html: string, url: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title && title.length > 0 ? title : url;
}

function simpleHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSimpleHtmlContent(html: string, url: string) {
  const text = simpleHtmlToText(html);
  return {
    url,
    title: extractTitleFromHtml(html, url),
    markdown: text,
    text,
    raw: html,
  };
}

export class Web implements ServerTool {
  id = "web";

  private tavily: TavilyClient | null = null;
  private webSearchProvider: WebSearchProvider | null = null;
  private webSearchProviderError: string | null = null;
  private webSearchProviderKey: string | null = null;
  private turndown = new TurndownService();
  private browserContext: { browser: Browser; context: BrowserContext } | null = null;
  private browserInit: Promise<{
    browser: Browser;
    context: BrowserContext;
  }> | null = null;
  private logger: Logger;

  constructor() {
    this.logger = createLogger({
      module: "server-tool:web",
    });
  }

  private async loadWebSearchProviderFromCoreConfig(): Promise<string | undefined> {
    const cfg = await getCoreConfig();
    return cfg.tools.web.search.provider;
  }

  private async refreshWebSearchProvider(): Promise<void> {
    let providerFromConfig: string | undefined;
    try {
      providerFromConfig = await this.loadWebSearchProviderFromCoreConfig();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.logError(`Failed to read core-config.yaml for web.search provider: ${msg}`);
      providerFromConfig = undefined;
    }

    const normalizedRequested = providerFromConfig?.trim().toLowerCase() ?? "";

    const exaBaseUrl = env.tools.web.exa.baseUrl;
    const exaApiKey = env.tools.web.exa.apiKey;
    const tavilyApiKey = env.tools.web.tavilyApiKey;
    const tavilyApiBaseUrl = env.tools.web.tavilyApiBaseUrl;

    const nextKey = JSON.stringify({
      requested: normalizedRequested || null,
      exaBaseUrl: exaBaseUrl ?? null,
      hasExaApiKey: Boolean(exaApiKey),
      hasTavilyApiKey: Boolean(tavilyApiKey),
      tavilyApiBaseUrl: tavilyApiBaseUrl ?? null,
    });
    if (nextKey === this.webSearchProviderKey) return;
    this.webSearchProviderKey = nextKey;

    const prevId = this.webSearchProvider?.id ?? null;

    const providers = createDefaultWebSearchProviders({
      exa: {
        baseUrl: exaBaseUrl,
        apiKey: exaApiKey,
      },
      tavilyApiKey,
      tavilyApiBaseUrl,
    });

    const resolved = resolveWebSearchProvider({
      requested: providerFromConfig,
      providers,
    });

    this.webSearchProvider = resolved.provider;
    this.webSearchProviderError = resolved.error;

    const nextId = this.webSearchProvider?.id ?? null;
    if (resolved.warning) {
      this.logger.logInfo(resolved.warning);
    }
    if (nextId && nextId !== prevId) {
      this.logger.logInfo(`web.search provider: ${nextId}`);
    }
    if (!nextId && this.webSearchProviderError) {
      this.logger.logError(this.webSearchProviderError);
    }
  }

  async init() {
    if (!env.tools.web.tavilyApiKey) {
      this.logger.logError(
        "Tavily API key not configured (missing env var TAVILY_API_KEY). fetch(mode=tavily) will fall back to browser mode.",
      );
    } else {
      this.tavily = tavily({
        apiKey: env.tools.web.tavilyApiKey,
        apiBaseURL: env.tools.web.tavilyApiBaseUrl,
      });
    }

    await this.refreshWebSearchProvider();

    this.logger.logInfo("Web extension initialized");
  }

  async destroy() {
    await this.browserContext?.browser.close();
    this.browserContext = null;
    this.browserInit = null;
  }

  async list() {
    return [
      {
        callableId: "fetch",
        name: "Fetch",
        description: "Fetch a web page",
        shortInput: zodObjectToCliLines(getPageSchema, { mode: "required" }),
        input: zodObjectToCliLines(getPageSchema),
      },
      {
        callableId: "search",
        name: "Web Search",
        description: "Search the web",
        shortInput: zodObjectToCliLines(webSearchInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(webSearchInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: unknown;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId === "fetch") return this.callFetch(rawInput, opts);
    if (callableId === "search") return this.callSearch(rawInput, opts);
    throw new Error("Invalid callable ID");
  }

  private async callFetch(
    rawInput: unknown,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const input = getPageSchema.parse(rawInput);
    try {
      switch (input.mode) {
        case "fetch": {
          return await this.getPageRaw(input, opts);
        }
        case "browser": {
          return await this.getPage(input, opts);
        }
        case "tavily": {
          checkSignal(opts?.signal);
          if (!this.tavily) {
            this.logger.logError(
              "Tavily API key not configured (missing env var TAVILY_API_KEY). Falling back to browser mode.",
            );
            return await this.getPage({ ...input, mode: "browser" }, opts);
          }
          const resp = await this.tavily.extract([input.url], {
            extractDepth: "advanced",
            format: input.format === "markdown" ? "markdown" : "text",
            timeout: input.timeout,
          });

          const response = resp.results[0];

          if (!response) {
            return {
              isError: true,
              error: "No results",
            } as const;
          }

          const offset = input.startOffset ?? 0;
          const maxCharacters = input.maxCharacters ?? 200_000;
          return {
            isError: false,
            title: "title" in response ? response.title : response.url,
            content: response.rawContent.slice(offset, offset + maxCharacters),
            length: response.rawContent.length,
            rearTruncated: response.rawContent.length > offset + maxCharacters,
          };
        }
      }
    } catch (e) {
      return {
        isError: true,
        error: e instanceof Error ? e.message : String(e),
      } as const;
    }
  }

  private async callSearch(
    rawInput: unknown,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const input = webSearchInputSchema.parse(rawInput);

    await this.refreshWebSearchProvider();

    if (!this.webSearchProvider) {
      return {
        isError: true as const,
        error: this.webSearchProviderError ?? "web.search is unavailable: no provider configured.",
      };
    }

    try {
      return await this.webSearchProvider.search(input, { signal: opts?.signal });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.logError(`web.search failed (${this.webSearchProvider.id}): ${msg}`);
      return {
        isError: true as const,
        error: msg,
      };
    }
  }

  private async findSystemChromiumExecutable(): Promise<string | null> {
    const fromEnv = process.env.LILAC_CHROMIUM_PATH ?? process.env.CHROMIUM_PATH ?? null;
    if (fromEnv && (await this.pathExecutable(fromEnv))) return fromEnv;

    const fromWhich =
      Bun.which("chromium") ??
      Bun.which("chromium-browser") ??
      Bun.which("google-chrome") ??
      Bun.which("google-chrome-stable") ??
      null;

    if (fromWhich && (await this.pathExecutable(fromWhich))) return fromWhich;

    const candidates = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ];
    for (const c of candidates) {
      if (await this.pathExecutable(c)) return c;
    }

    return null;
  }

  private async pathExecutable(p: string): Promise<boolean> {
    try {
      await fs.access(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveChromiumLaunchOptions(): Promise<{
    executablePath?: string;
    strategy: "system" | "playwright";
  }> {
    const system = await this.findSystemChromiumExecutable();
    if (system) return { strategy: "system", executablePath: system };

    const pwPath = chromium.executablePath();
    const pwExists = await Bun.file(pwPath).exists();
    if (!pwExists) {
      throw new Error(
        "Chromium is not available. Install system chromium, or run: tools onboarding.playwright",
      );
    }

    return { strategy: "playwright" };
  }

  private async ensureBrowserContext(): Promise<{
    browser: Browser;
    context: BrowserContext;
  }> {
    if (this.browserContext) return this.browserContext;
    if (this.browserInit) return this.browserInit;

    this.browserInit = this.launchBrowser()
      .then((ctx) => {
        this.browserContext = ctx;
        return ctx;
      })
      .finally(() => {
        this.browserInit = null;
      });

    return this.browserInit;
  }

  private async launchBrowser() {
    const launch = await this.resolveChromiumLaunchOptions();

    this.logger.logDebug("Launching browser...");
    const browser = await chromium.launch({
      headless: true,
      executablePath: launch.executablePath,
    });
    this.logger.logInfo(`Chrome launched (${launch.strategy})`, browser.version());
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
    });
    return { browser, context };
  }

  private async getPageRaw(
    {
      url,
      format = "markdown",
      startOffset = 0,
      maxCharacters = 200_000,
      timeout = 10_000,
      preprocessor = "none",
    }: z.infer<typeof getPageSchema>,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    let acceptHeader = "text/markdown, text/html;q=0.8, */*;q=0.1";
    switch (format) {
      case "markdown":
        acceptHeader = "text/markdown, text/html;q=0.8, */*;q=0.1";
        break;
      case "text":
        acceptHeader = "text/plain, text/html;q=0.8, */*;q=0.1";
        break;
      case "html":
        acceptHeader = "text/html, */*;q=0.1";
        break;
    }

    const requestSignal = opts?.signal;
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([timeoutSignal, ...(requestSignal ? [requestSignal] : [])]);
    const res = await fetch(url, {
      headers: {
        Accept: acceptHeader,
      },
      signal,
    });

    if (timeoutSignal.aborted && !requestSignal?.aborted) {
      return {
        isError: true,
        error: "timeout fetching page",
      } as const;
    }

    checkSignal(requestSignal);

    if (!res.ok) {
      const errorBody = await readResponseTextWithLimit({
        res,
        maxBytes: MAX_ERROR_RESPONSE_BYTES,
        signal: requestSignal,
      });
      return {
        isError: true,
        error: errorBody.truncated
          ? `${errorBody.text}\n\n[truncated after ${errorBody.bytesRead} bytes]`
          : errorBody.text,
        status: res.status,
      } as const;
    }

    const mediaType = parseMediaType(res.headers.get("content-type"));
    if (!isTextMediaType(mediaType)) {
      return {
        isError: true,
        error: `Unsupported content-type for text extraction: ${mediaType ?? "unknown"}`,
        contentType: mediaType,
        contentLength: contentLengthFromHeaders(res.headers),
      } as const;
    }

    const body = await readResponseTextWithLimit({
      res,
      maxBytes: MAX_FETCH_RESPONSE_BYTES,
      signal: requestSignal,
    });

    if (mediaType === "text/markdown" || mediaType === "text/plain") {
      return this.toOutputFormat({
        content: {
          markdown: body.text,
          raw: body.text,
          text: body.text,
          url,
          title: url,
        },
        format,
        startOffset,
        maxCharacters,
        sourceTruncated: body.truncated,
      });
    }

    checkSignal(requestSignal);

    const content = isHtmlMediaType(mediaType)
      ? body.bytesRead > MAX_FULL_DOM_PARSE_BYTES
        ? buildSimpleHtmlContent(body.text, url)
        : await this.parsePage(body.text, url, {
            preprocessor,
            signal: requestSignal,
          })
      : {
          url,
          title: url,
          markdown: body.text,
          text: body.text,
          raw: body.text,
        };
    return this.toOutputFormat({
      content,
      format,
      startOffset,
      maxCharacters,
      sourceTruncated: body.truncated,
    });
  }

  private async getPage(
    {
      url,
      format = "markdown",
      startOffset = 0,
      maxCharacters = 200_000,
      timeout = 10_000,
      preprocessor = "none",
    }: z.infer<typeof getPageSchema>,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([timeoutSignal, ...(opts?.signal ? [opts.signal] : [])]);
    checkSignal(signal);
    const { context } = await this.ensureBrowserContext();

    this.logger.logDebug("Launching in new page...");
    const page = await context.newPage();
    const onAbort = () => {
      void page.close().catch(() => null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      checkSignal(signal);
      this.logger.logDebug("Navigating to page:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      checkSignal(signal);
      await this.fastAutoScroll(page);

      this.logger.logDebug("Getting page content...");
      const html = await page.content();
      checkSignal(signal);
      const content =
        Buffer.byteLength(html, "utf8") > MAX_FULL_DOM_PARSE_BYTES
          ? buildSimpleHtmlContent(html, url)
          : await this.parsePage(html, url, {
              preprocessor,
              signal,
            });
      return this.toOutputFormat({
        content,
        format,
        startOffset,
        maxCharacters,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      await page.close().catch(() => null);
    }
  }

  private async fastAutoScroll(page: Page, { step = 1920, maxScrolls = 5, idleMs = 100 } = {}) {
    await page.evaluate(
      async ({ step, maxScrolls, idleMs }) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        let lastHeight = document.body.scrollHeight;
        let sameHeightSince = performance.now();
        let scrolls = 0;

        while (true) {
          window.scrollBy(0, step);
          scrolls++;

          if (scrolls >= maxScrolls) break;

          await sleep(50);

          const newHeight = document.body.scrollHeight;
          const now = performance.now();

          if (newHeight > lastHeight) {
            lastHeight = newHeight;
            sameHeightSince = now;
          } else if (now - sameHeightSince >= idleMs) {
            break;
          }
        }

        window.scrollTo(0, document.body.scrollHeight);
      },
      { step, maxScrolls, idleMs },
    );
  }

  private toOutputFormat({
    content,
    format,
    startOffset,
    maxCharacters,
    sourceTruncated = false,
  }: {
    content: Awaited<ReturnType<typeof Web.prototype.parsePage>>;
    format: z.infer<typeof getPageSchema>["format"];
    startOffset: number;
    maxCharacters: number;
    sourceTruncated?: boolean;
  }) {
    switch (format) {
      case "markdown": {
        return {
          isError: false,
          title: content.title,
          content: content.markdown.slice(startOffset, startOffset + maxCharacters),
          length: content.markdown.length,
          rearTruncated: content.markdown.length > startOffset + maxCharacters,
          sourceTruncated,
        } as const;
      }
      case "text": {
        return {
          isError: false,
          title: content.title,
          content: content.text.slice(startOffset, startOffset + maxCharacters),
          length: content.text.length,
          rearTruncated: content.text.length > startOffset + maxCharacters,
          sourceTruncated,
        } as const;
      }
      case "html": {
        return {
          isError: false,
          title: content.title,
          content: content.raw.slice(startOffset, startOffset + maxCharacters),
          length: content.raw.length,
          rearTruncated: content.raw.length > startOffset + maxCharacters,
          sourceTruncated,
        } as const;
      }
    }
  }

  private async parsePage(
    html: string,
    url: string,
    {
      preprocessor,
      signal,
    }: {
      preprocessor: z.infer<typeof getPageSchema>["preprocessor"];
      signal?: AbortSignal;
    },
  ) {
    checkSignal(signal);
    const dom = new JSDOM(html, { url });

    if (preprocessor === "readability") {
      checkSignal(signal);
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article) {
        const markdown = this.turndown.turndown(article.content || "");
        return {
          url,
          title: article.title || dom.window.document.title || url,
          markdown,
          text: article.textContent ?? "",
          raw: article.content ?? "",
        };
      }
    }

    // Fallback: whole document body
    checkSignal(signal);
    const body = dom.window.document.body?.innerHTML ?? "";
    const fallbackMarkdown = this.turndown.turndown(body);
    return {
      url,
      title: dom.window.document.title || url,
      markdown: fallbackMarkdown,
      text: dom.window.document.body?.textContent ?? "",
      raw: body,
    };
  }
}
