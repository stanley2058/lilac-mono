import { z } from "zod";
import { Logger } from "@stanley2058/simple-module-logger";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { ServerTool } from "../types";
import { zodObjectToCliLines } from "./zod-cli";
import { tavily, type TavilyClient } from "@tavily/core";
import TurndownService from "turndown";
import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

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
  maxCharacters: z.coerce
    .number()
    .optional()
    .describe("Max characters (default: 200000)"),
  timeout: z.coerce
    .number()
    .optional()
    .describe(
      "Timeout in ms. Timeout for initial connection if using browser. (default: 10000 = 10s)",
    ),
});

const searchInputSchema = z.object({
  query: z.string().describe("Search query"),
  topic: z.enum(["general", "news", "finance"]).optional().default("general"),
  searchDepth: z
    .enum(["basic", "advanced"])
    .optional()
    .default("basic")
    .describe(
      '"advanced" search is tailored to retrieve the most relevant sources and content snippets for your query, while "basic" search provides generic content snippets from each source.',
    ),
  maxResults: z.coerce.number().optional().default(8).describe("Max results"),
  timeRange: z
    .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
    .optional()
    .describe(
      "The time range back from the current date based on publish date or last updated date.",
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start date. Must be in YYYY-MM-DD format."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End date. Must be in YYYY-MM-DD format."),
});

export class Web implements ServerTool {
  id = "web";

  private tavily: TavilyClient | null = null;
  private turndown = new TurndownService();
  private browserContext: { browser: Browser; context: BrowserContext } | null =
    null;
  private browserInit: Promise<{
    browser: Browser;
    context: BrowserContext;
  }> | null = null;
  private logger: Logger;

  constructor() {
    this.logger = new Logger({
      logLevel: resolveLogLevel(),
      module: "server-tool:web",
    });
  }

  async init() {
    if (!env.tools.web.tavilyApiKey) {
      this.logger.logError(
        "Tavily API key not configured (missing env var TAVILY_API_KEY). web.search is disabled and fetch(mode=tavily) will fall back to browser mode.",
      );
    } else {
      this.tavily = tavily({ apiKey: env.tools.web.tavilyApiKey });
    }
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
        shortInput: zodObjectToCliLines(searchInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(searchInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    _opts?: {
      signal?: AbortSignal;
      context?: unknown;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId === "fetch") return this.callFetch(rawInput);
    if (callableId === "search") return this.callSearch(rawInput);
    throw new Error("Invalid callable ID");
  }

  private async callFetch(rawInput: unknown) {
    const input = getPageSchema.parse(rawInput);
    try {
      switch (input.mode) {
        case "fetch": {
          return await this.getPageRaw(input);
        }
        case "browser": {
          return await this.getPage(input);
        }
        case "tavily": {
          if (!this.tavily) {
            this.logger.logError(
              "Tavily API key not configured (missing env var TAVILY_API_KEY). Falling back to browser mode.",
            );
            return await this.getPage({ ...input, mode: "browser" });
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
            truncated: response.rawContent.length > maxCharacters,
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

  private async callSearch(rawInput: unknown) {
    const {
      query,
      topic,
      maxResults = 8,
      searchDepth = "basic",
      timeRange,
      startDate,
      endDate,
    } = searchInputSchema.parse(rawInput);

    if (!this.tavily) {
      return {
        isError: true as const,
        error:
          "web.search is unavailable: TAVILY_API_KEY is not configured (set env var TAVILY_API_KEY).",
      };
    }

    const { results } = await this.tavily.search(query, {
      topic,
      searchDepth,
      maxResults,
      timeRange,
      startDate,
      endDate,
    });

    return results.map((r) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      score: r.score,
    }));
  }

  private async findSystemChromiumExecutable(): Promise<string | null> {
    const fromEnv =
      process.env.LILAC_CHROMIUM_PATH ?? process.env.CHROMIUM_PATH ?? null;
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
    this.logger.logInfo(
      `Chrome launched (${launch.strategy})`,
      browser.version(),
    );
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
    });
    return { browser, context };
  }

  private async getPageRaw({
    url,
    format = "markdown",
    startOffset = 0,
    maxCharacters = 200_000,
    timeout = 10_000,
    preprocessor = "none",
  }: z.infer<typeof getPageSchema>) {
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

    const timeoutSignal = AbortSignal.timeout(timeout);
    const res = await fetch(url, {
      headers: {
        Accept: acceptHeader,
      },
      signal: timeoutSignal,
    });

    if (timeoutSignal.aborted) {
      return {
        isError: true,
        error: "timeout fetching page",
      } as const;
    }

    if (!res.ok) {
      return {
        isError: true,
        error: await res.text(),
        status: res.status,
      } as const;
    }

    const contentType = res.headers.get("content-type");
    const text = await res.text();
    if (contentType === "text/markdown" || contentType === "text/plain") {
      return this.toOutputFormat({
        content: {
          markdown: text,
          raw: text,
          text,
          url,
          title: url,
        },
        format,
        startOffset,
        maxCharacters,
      });
    }

    const content = await this.parsePage(text, url, { preprocessor });
    return this.toOutputFormat({ content, format, startOffset, maxCharacters });
  }

  private async getPage({
    url,
    format = "markdown",
    startOffset = 0,
    maxCharacters = 200_000,
    timeout = 10_000,
    preprocessor = "none",
  }: z.infer<typeof getPageSchema>) {
    const { context } = await this.ensureBrowserContext();

    this.logger.logDebug("Launching in new page...");
    const page = await context.newPage();
    try {
      this.logger.logDebug("Navigating to page:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await this.fastAutoScroll(page);

      this.logger.logDebug("Getting page content...");
      const html = await page.content();
      const content = await this.parsePage(html, url, { preprocessor });
      return this.toOutputFormat({
        content,
        format,
        startOffset,
        maxCharacters,
      });
    } finally {
      await page.close();
    }
  }

  private async fastAutoScroll(
    page: Page,
    { step = 1920, maxScrolls = 5, idleMs = 100 } = {},
  ) {
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
  }: {
    content: Awaited<ReturnType<typeof Web.prototype.parsePage>>;
    format: z.infer<typeof getPageSchema>["format"];
    startOffset: number;
    maxCharacters: number;
  }) {
    switch (format) {
      case "markdown": {
        return {
          isError: false,
          title: content.title,
          content: content.markdown.slice(
            startOffset,
            startOffset + maxCharacters,
          ),
          length: content.markdown.length,
          truncated: content.markdown.length > maxCharacters,
        } as const;
      }
      case "text": {
        return {
          isError: false,
          title: content.title,
          content: content.text.slice(startOffset, startOffset + maxCharacters),
          length: content.text.length,
          truncated: content.text.length > maxCharacters,
        } as const;
      }
      case "html": {
        return {
          isError: false,
          title: content.title,
          content: content.raw.slice(startOffset, startOffset + maxCharacters),
          length: content.raw.length,
          truncated: content.raw.length > maxCharacters,
        } as const;
      }
    }
  }

  private async parsePage(
    html: string,
    url: string,
    {
      preprocessor,
    }: { preprocessor: z.infer<typeof getPageSchema>["preprocessor"] },
  ) {
    const dom = new JSDOM(html, { url });

    if (preprocessor === "readability") {
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
