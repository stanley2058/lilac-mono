import { z } from "zod";
import type { Logger } from "@stanley2058/simple-module-logger";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import Exa from "exa-js";
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
  type WebSearchProviderId,
  type WebSearchProvider,
} from "./web-search";

const getPageModeSchema = z.enum(["auto", "fetch", "browser", "extract"]);

const getPageSchema = z.object({
  url: z.string().describe("URL to fetch"),
  mode: getPageModeSchema
    .optional()
    .describe(
      "Mode to use for fetching the page; `auto`: smart fallback flow; `fetch`: direct HTTP fetch; `browser`: render with a browser; `extract`: use the configured extract provider.",
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
const EXA_MAX_EXTRACT_CHARACTERS = 50_000;
const MIN_EXTRACT_USEFUL_CHARACTERS = 200;
const STRONG_EXTRACT_CHARACTERS = 600;
const TAVILY_MAX_TIMEOUT_SECONDS = 60;
const SUPPORTED_TEXT_MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/xhtml+xml",
]);
const WEAK_CONTENT_PATTERNS = [
  /enable javascript/i,
  /javascript (is )?required/i,
  /please wait/i,
  /loading/i,
  /sign in/i,
  /log in/i,
  /cookie/i,
  /privacy policy/i,
  /terms of service/i,
] as const;
const SPA_SHELL_MARKERS = [
  "__next",
  "__nuxt",
  "data-reactroot",
  'id="root"',
  'id="app"',
  "webpack",
  "hydration",
] as const;

type GetPageMode = z.infer<typeof getPageModeSchema>;
type GetPageInput = z.infer<typeof getPageSchema>;
type ParsedPageContent = {
  url: string;
  title: string;
  markdown: string;
  text: string;
  raw: string;
};
type PageContentSuccess = {
  isError: false;
  content: ParsedPageContent;
  sourceTruncated?: boolean;
  rawHtml?: string;
};
type PageContentError = {
  isError: true;
  error: string;
  status?: number;
  contentType?: string | null;
  contentLength?: number | null;
};
type PageContentResult = PageContentSuccess | PageContentError;

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function withAbortSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  checkSignal(signal);

  const pending = run();
  if (!signal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });

    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function buildTextContent(input: {
  url: string;
  title?: string | null;
  text: string;
  markdown?: string;
  raw?: string;
}): ParsedPageContent {
  const text = input.text.trim();
  const markdown = input.markdown ?? text;
  return {
    url: input.url,
    title: input.title?.trim() || input.url,
    markdown,
    text,
    raw: input.raw ?? markdown,
  };
}

function countUniqueWords(text: string): number {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).size;
}

function countSubstantiveParagraphs(markdown: string): number {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => normalizeWhitespace(paragraph.replace(/[#>*`\-_[\]()]/g, " ")))
    .filter((paragraph) => paragraph.length >= 80).length;
}

function assessExtractedContent(params: { content: ParsedPageContent; rawHtml?: string }): {
  isWeak: boolean;
  reasons: readonly string[];
} {
  const text = normalizeWhitespace(params.content.text);
  const uniqueWordCount = countUniqueWords(text);
  const paragraphCount = countSubstantiveParagraphs(params.content.markdown);
  const boilerplateHits = WEAK_CONTENT_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const normalizedHtml = params.rawHtml?.toLowerCase() ?? "";
  const hasSpaShell = SPA_SHELL_MARKERS.some((marker) => normalizedHtml.includes(marker));
  const reasons: string[] = [];

  if (text.length === 0) {
    reasons.push("empty text");
  }
  if (text.length < MIN_EXTRACT_USEFUL_CHARACTERS) {
    reasons.push("too short");
  }
  if (uniqueWordCount < 40) {
    reasons.push("low vocabulary");
  }
  if (paragraphCount === 0) {
    reasons.push("no substantive paragraphs");
  }
  if (boilerplateHits > 0) {
    reasons.push("boilerplate text");
  }
  if (hasSpaShell && text.length < STRONG_EXTRACT_CHARACTERS) {
    reasons.push("spa shell");
  }
  if (text.length > 0 && normalizeWhitespace(params.content.title) === text) {
    reasons.push("title only");
  }

  const suspicious = boilerplateHits > 0 || hasSpaShell || paragraphCount === 0;
  const isWeak =
    text.length === 0 ||
    text.length < 120 ||
    (text.length < MIN_EXTRACT_USEFUL_CHARACTERS && suspicious) ||
    (text.length < STRONG_EXTRACT_CHARACTERS && reasons.length >= 3);

  return {
    isWeak,
    reasons,
  };
}

function toTavilyTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.min(TAVILY_MAX_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000)));
}

function buildExaExtractCharacterBudget(input: GetPageInput): {
  requestedCharacters: number;
  truncatedByBudget: boolean;
} {
  const desiredCharacters = Math.max(
    1,
    (input.startOffset ?? 0) + (input.maxCharacters ?? 200_000),
  );
  const requestedCharacters = Math.min(desiredCharacters, EXA_MAX_EXTRACT_CHARACTERS);

  return {
    requestedCharacters,
    truncatedByBudget: desiredCharacters > requestedCharacters,
  };
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
  private exa: Exa | null = null;
  private webSearchProvider: WebSearchProvider | null = null;
  private webSearchProviderError: string | null = null;
  private webSearchProviderKey: string | null = null;
  private webFetchDefaultMode: GetPageMode = "auto";
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

  private async loadWebToolConfigFromCoreConfig(): Promise<{
    extractProvider: WebSearchProviderId;
    fetchMode: GetPageMode;
  }> {
    const cfg = await getCoreConfig();
    return {
      extractProvider: cfg.tools.web.extract.provider,
      fetchMode: cfg.tools.web.fetch.mode,
    };
  }

  private async refreshWebConfig(): Promise<void> {
    let extractProviderFromConfig: string | undefined;
    let fetchModeFromConfig: GetPageMode = "auto";
    try {
      const config = await this.loadWebToolConfigFromCoreConfig();
      extractProviderFromConfig = config.extractProvider;
      fetchModeFromConfig = config.fetchMode;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.logError(`Failed to read core-config.yaml for web tool config: ${msg}`);
      extractProviderFromConfig = undefined;
    }

    const normalizedRequested = extractProviderFromConfig?.trim().toLowerCase() ?? "";

    const exaBaseUrl = env.tools.web.exa.baseUrl;
    const exaApiKey = env.tools.web.exa.apiKey;
    const tavilyApiKey = env.tools.web.tavilyApiKey;
    const tavilyApiBaseUrl = env.tools.web.tavilyApiBaseUrl;

    const nextKey = JSON.stringify({
      requested: normalizedRequested || null,
      fetchMode: fetchModeFromConfig,
      exaBaseUrl: exaBaseUrl ?? null,
      hasExaApiKey: Boolean(exaApiKey),
      hasTavilyApiKey: Boolean(tavilyApiKey),
      tavilyApiBaseUrl: tavilyApiBaseUrl ?? null,
    });
    if (nextKey === this.webSearchProviderKey) return;
    this.webSearchProviderKey = nextKey;

    const prevId = this.webSearchProvider?.id ?? null;
    const prevFetchMode = this.webFetchDefaultMode;

    const providers = createDefaultWebSearchProviders({
      exa: {
        baseUrl: exaBaseUrl,
        apiKey: exaApiKey,
      },
      tavilyApiKey,
      tavilyApiBaseUrl,
    });

    const resolved = resolveWebSearchProvider({
      requested: extractProviderFromConfig,
      providers,
    });

    this.webSearchProvider = resolved.provider;
    this.webSearchProviderError = resolved.error;
    this.webFetchDefaultMode = fetchModeFromConfig;

    const nextId = this.webSearchProvider?.id ?? null;
    if (resolved.warning) {
      this.logger.logInfo(resolved.warning);
    }
    if (nextId && nextId !== prevId) {
      this.logger.logInfo(`web.extract provider: ${nextId}`);
    }
    if (prevFetchMode !== this.webFetchDefaultMode) {
      this.logger.logInfo(`web.fetch mode: ${this.webFetchDefaultMode}`);
    }
    if (!nextId && this.webSearchProviderError) {
      this.logger.logError(this.webSearchProviderError);
    }
  }

  private getTavilyClient(): TavilyClient {
    if (this.tavily) return this.tavily;

    const apiKey = env.tools.web.tavilyApiKey;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY is not configured.");
    }

    const apiBaseUrlRaw = env.tools.web.tavilyApiBaseUrl?.trim();
    this.tavily = tavily({
      apiKey,
      apiBaseURL: apiBaseUrlRaw ? normalizeBaseUrl(apiBaseUrlRaw) : undefined,
    });
    return this.tavily;
  }

  private getExaClient(): Exa {
    if (this.exa) return this.exa;

    const apiKey = env.tools.web.exa.apiKey;
    if (!apiKey) {
      throw new Error("EXA_API_KEY is not configured.");
    }

    const baseUrlRaw = env.tools.web.exa.baseUrl?.trim();
    this.exa = baseUrlRaw ? new Exa(apiKey, normalizeBaseUrl(baseUrlRaw)) : new Exa(apiKey);
    return this.exa;
  }

  async init() {
    await this.refreshWebConfig();

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
        primaryPositional: {
          field: "url",
        },
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
    await this.refreshWebConfig();

    const mode = input.mode ?? this.webFetchDefaultMode;
    try {
      switch (mode) {
        case "auto": {
          return await this.getPageAuto({ ...input, mode }, opts);
        }
        case "fetch": {
          return await this.getPageFetch({ ...input, mode }, opts);
        }
        case "browser": {
          return await this.getPageBrowser({ ...input, mode }, opts);
        }
        case "extract": {
          return await this.getPageExtract({ ...input, mode }, opts);
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

    await this.refreshWebConfig();

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

  private async fetchPageContent(
    { url, format = "markdown", timeout = 10_000, preprocessor = "none" }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<PageContentResult> {
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
      return {
        isError: false,
        content: buildTextContent({
          url,
          title: url,
          text: body.text,
          markdown: body.text,
          raw: body.text,
        }),
        sourceTruncated: body.truncated,
      };
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
    return {
      isError: false,
      content,
      sourceTruncated: body.truncated,
      rawHtml: isHtmlMediaType(mediaType) ? body.text : undefined,
    };
  }

  private async renderPageContent(
    { url, timeout = 10_000, preprocessor = "none" }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<PageContentResult> {
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
      return {
        isError: false,
        content,
        rawHtml: html,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await page.close().catch(() => null);
    }
  }

  private async extractPageContent(
    input: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<PageContentResult> {
    const { url, format = "markdown", timeout = 10_000 } = input;

    if (format === "html") {
      return {
        isError: true,
        error: "extract mode does not support format=html",
      };
    }

    if (!this.webSearchProvider) {
      return {
        isError: true,
        error: this.webSearchProviderError ?? "web.extract is unavailable: no provider configured.",
      };
    }

    switch (this.webSearchProvider.id) {
      case "tavily": {
        const client = this.getTavilyClient();
        const response = await withAbortSignal(opts?.signal, () =>
          client.extract([url], {
            extractDepth: "advanced",
            format: format === "text" ? "text" : "markdown",
            timeout: toTavilyTimeoutSeconds(timeout),
          }),
        );

        const result = response.results[0];
        if (!result) {
          return {
            isError: true,
            error: "No extracted content returned.",
          };
        }

        return {
          isError: false,
          content: buildTextContent({
            url: result.url,
            title:
              "title" in result && typeof result.title === "string" ? result.title : result.url,
            text: result.rawContent,
            markdown: result.rawContent,
            raw: result.rawContent,
          }),
        };
      }
      case "exa": {
        const client = this.getExaClient();
        const timeoutSignal = AbortSignal.timeout(timeout);
        const signal = AbortSignal.any([timeoutSignal, ...(opts?.signal ? [opts.signal] : [])]);
        const exaBudget = buildExaExtractCharacterBudget(input);

        const response = await withAbortSignal(signal, () =>
          client.getContents([url], {
            text: {
              maxCharacters: exaBudget.requestedCharacters,
            },
          }),
        );

        const result = response.results[0];
        if (!result) {
          return {
            isError: true,
            error: "No extracted content returned.",
          };
        }

        const text = "text" in result && typeof result.text === "string" ? result.text : "";
        return {
          isError: false,
          sourceTruncated:
            exaBudget.truncatedByBudget || text.length >= exaBudget.requestedCharacters,
          content: buildTextContent({
            url: result.url,
            title: typeof result.title === "string" ? result.title : result.url,
            text,
            markdown: text,
            raw: text,
          }),
        };
      }
      default: {
        return {
          isError: true,
          error: `web.extract provider '${this.webSearchProvider.id}' is not supported.`,
        };
      }
    }
  }

  private async getPageFetch(
    { format = "markdown", startOffset = 0, maxCharacters = 200_000, ...rest }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const result = await this.fetchPageContent({ ...rest, format }, opts);
    if (result.isError) return result;

    return this.toOutputFormat({
      content: result.content,
      format,
      startOffset,
      maxCharacters,
      sourceTruncated: result.sourceTruncated,
    });
  }

  private async getPageBrowser(
    { format = "markdown", startOffset = 0, maxCharacters = 200_000, ...rest }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const result = await this.renderPageContent({ ...rest, format }, opts);
    if (result.isError) return result;

    return this.toOutputFormat({
      content: result.content,
      format,
      startOffset,
      maxCharacters,
      sourceTruncated: result.sourceTruncated,
    });
  }

  private async getPageExtract(
    { format = "markdown", ...rest }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    if (format === "html") {
      this.logger.logInfo(
        "web.fetch mode=extract does not support html; falling back to browser mode.",
      );
      return await this.getPageBrowser({ ...rest, format, mode: "browser" }, opts);
    }

    const result = await this.extractPageContent({ ...rest, format }, opts);
    if (result.isError) {
      this.logger.logError(`${result.error} Falling back to browser mode.`);
      return await this.getPageBrowser({ ...rest, format, mode: "browser" }, opts);
    }

    return this.toOutputFormat({
      content: result.content,
      format,
      startOffset: rest.startOffset ?? 0,
      maxCharacters: rest.maxCharacters ?? 200_000,
      sourceTruncated: result.sourceTruncated,
    });
  }

  private async getPageAuto(
    {
      url,
      format = "markdown",
      startOffset = 0,
      maxCharacters = 200_000,
      timeout = 10_000,
    }: GetPageInput,
    opts?: {
      signal?: AbortSignal;
    },
  ) {
    const autoPreprocessor = "readability" as const;

    const fetchResult = await this.fetchPageContent(
      {
        url,
        format,
        timeout,
        preprocessor: autoPreprocessor,
      },
      opts,
    );

    if (!fetchResult.isError) {
      const fetchAssessment = fetchResult.rawHtml
        ? assessExtractedContent({
            content: fetchResult.content,
            rawHtml: fetchResult.rawHtml,
          })
        : { isWeak: false, reasons: [] as const };

      if (!fetchResult.rawHtml || !fetchAssessment.isWeak) {
        return this.toOutputFormat({
          content: fetchResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: fetchResult.sourceTruncated,
        });
      }

      this.logger.logDebug(
        `web.fetch auto escalating to browser after weak fetch extraction: ${fetchAssessment.reasons.join(", ")}`,
      );
    }

    const browserResult = await this.renderPageContent(
      {
        url,
        format,
        timeout,
        preprocessor: autoPreprocessor,
      },
      opts,
    );

    let browserParsedFallbackContent: ParsedPageContent | null = null;
    let browserWholePageFallbackContent: ParsedPageContent | null = null;
    let browserRawFallbackContent: ParsedPageContent | null = null;
    if (!browserResult.isError) {
      browserParsedFallbackContent = browserResult.content;
      if (browserResult.rawHtml) {
        browserWholePageFallbackContent = await this.parsePage(browserResult.rawHtml, url, {
          preprocessor: "none",
          signal: opts?.signal,
        });
      }
      browserRawFallbackContent = browserResult.rawHtml
        ? buildSimpleHtmlContent(browserResult.rawHtml, url)
        : browserResult.content;
      const browserAssessment = assessExtractedContent({
        content: browserResult.content,
        rawHtml: browserResult.rawHtml,
      });

      if (!browserAssessment.isWeak) {
        return this.toOutputFormat({
          content: browserResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: browserResult.sourceTruncated,
        });
      }

      this.logger.logDebug(
        `web.fetch auto escalating to extract after weak browser extraction: ${browserAssessment.reasons.join(", ")}`,
      );
    }

    if (format !== "html") {
      const extractResult = await this.extractPageContent(
        {
          url,
          format,
          preprocessor: "none",
          timeout,
        },
        opts,
      );

      if (!extractResult.isError && normalizeWhitespace(extractResult.content.text).length > 0) {
        return this.toOutputFormat({
          content: extractResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: extractResult.sourceTruncated,
        });
      }

      const preferredBrowserFallback =
        browserWholePageFallbackContent &&
        normalizeWhitespace(browserWholePageFallbackContent.text).length >
          normalizeWhitespace(browserParsedFallbackContent?.text ?? "").length
          ? browserWholePageFallbackContent
          : browserParsedFallbackContent;

      if (
        preferredBrowserFallback &&
        normalizeWhitespace(preferredBrowserFallback.text).length > 0
      ) {
        return this.toOutputFormat({
          content: preferredBrowserFallback,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: browserResult.isError ? false : browserResult.sourceTruncated,
        });
      }
    }

    if (browserRawFallbackContent) {
      return this.toOutputFormat({
        content: browserRawFallbackContent,
        format,
        startOffset,
        maxCharacters,
        sourceTruncated: browserResult.isError ? false : browserResult.sourceTruncated,
      });
    }

    if (!fetchResult.isError) {
      return this.toOutputFormat({
        content: fetchResult.content,
        format,
        startOffset,
        maxCharacters,
        sourceTruncated: fetchResult.sourceTruncated,
      });
    }

    return browserResult.isError ? browserResult : fetchResult;
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
    content: ParsedPageContent;
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
  ): Promise<ParsedPageContent> {
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
