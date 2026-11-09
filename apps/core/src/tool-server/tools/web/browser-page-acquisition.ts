import { captureError } from "../../../shared/error-capture";
import { Panic, Result, type Result as ResultType } from "better-result";
import type { Logger } from "@stanley2058/simple-module-logger";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";

import {
  buildSimpleHtmlContent,
  checkPageSignal,
  type PageAcquisitionInput,
  type PageContent,
  type PageContentResult,
} from "./page-content";
import { adaptToolResultToHost } from "../../../tools/tool-result-adapters";

const MAX_FULL_DOM_PARSE_BYTES = 750 * 1024;

export interface BrowserPageAcquisition {
  acquire(input: PageAcquisitionInput, opts?: { signal?: AbortSignal }): Promise<PageContentResult>;
  destroy(): Promise<void>;
}

export class DefaultBrowserPageAcquisition implements BrowserPageAcquisition {
  private browserContext: { browser: Browser; context: BrowserContext } | null = null;
  private browserInit: Promise<{ browser: Browser; context: BrowserContext }> | null = null;

  constructor(
    private readonly pageContent: PageContent,
    private readonly logger: Logger,
  ) {}

  async destroy(): Promise<void> {
    await this.browserContext?.browser.close();
    this.browserContext = null;
    this.browserInit = null;
  }

  async acquire(
    { url, timeout = 10_000, preprocessor = "none" }: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult> {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([timeoutSignal, ...(opts?.signal ? [opts.signal] : [])]);
    checkPageSignal(signal);
    const { context } = await this.ensureBrowserContext();

    this.logger.logDebug("Launching in new page...");
    const page = await context.newPage();
    let closePending:
      | Promise<ResultType<void, { readonly restoreCause: () => unknown }>>
      | undefined;
    const onAbort = () => {
      void closePage();
    };
    const closePage = (): Promise<ResultType<void, { readonly restoreCause: () => unknown }>> => {
      closePending ??= Result.tryPromise({
        try: () => page.close(),
        catch: (cause) => ({ restoreCause: () => cause }),
      });
      return closePending;
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return await (async () => {
      checkPageSignal(signal);
      this.logger.logDebug("Navigating to page:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      checkPageSignal(signal);
      await this.fastAutoScroll(page);

      this.logger.logDebug("Getting page content...");
      const html = await page.content();
      checkPageSignal(signal);
      const content =
        Buffer.byteLength(html, "utf8") > MAX_FULL_DOM_PARSE_BYTES
          ? buildSimpleHtmlContent(html, url)
          : this.pageContent.parse(html, url, { preprocessor, signal });
      return { isError: false, content, rawHtml: html } as const;
    })().finally(async () => {
      signal.removeEventListener("abort", onAbort);
      const closed = await closePage();
      const closeFailure = closed.match<Error | Panic | null>({
        ok: () => null,
        err: ({ restoreCause }) => {
          const classified = Result.try({
            try: () => {
              const cause = restoreCause();
              if (Panic.is(cause)) return { kind: "panic", panic: cause } as const;
              if (cause instanceof Error) return { kind: "error", error: cause } as const;
              return { kind: "opaque" } as const;
            },
            catch: () => ({ kind: "opaque" }) as const,
          }).match<
            | { readonly kind: "panic"; readonly panic: Panic }
            | { readonly kind: "error"; readonly error: Error }
            | { readonly kind: "opaque" }
          >({
            ok: (outcome) => outcome,
            err: () => ({ kind: "opaque" }) as const,
          });
          if (classified.kind === "panic") return classified.panic;
          if (classified.kind === "error") return classified.error;
          return new Error("Unknown operation failure", { cause: restoreCause() });
        },
      });
      if (closeFailure) adaptToolResultToHost(Result.err(closeFailure));
    });
  }

  private async pathExecutable(path: string): Promise<boolean> {
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          await fs.access(path, fsConstants.X_OK);
          return true;
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        return false;
      }
      return attempt.value;
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

    for (const candidate of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]) {
      if (await this.pathExecutable(candidate)) return candidate;
    }
    return null;
  }

  private async resolveChromiumLaunchOptions(): Promise<{
    executablePath?: string;
    strategy: "system" | "playwright";
  }> {
    const system = await this.findSystemChromiumExecutable();
    if (system) return { strategy: "system", executablePath: system };

    const { chromium } = await import("playwright");
    const playwrightPath = chromium.executablePath();
    if (!(await Bun.file(playwrightPath).exists())) {
      throw new Error(
        "Chromium is not available. Install system chromium, or run: tools onboarding.playwright",
      );
    }
    return { strategy: "playwright" };
  }

  private async ensureBrowserContext(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.browserContext) return this.browserContext;
    if (this.browserInit) return this.browserInit;

    this.browserInit = this.launchBrowser()
      .then((context) => {
        this.browserContext = context;
        return context;
      })
      .finally(() => {
        this.browserInit = null;
      });
    return this.browserInit;
  }

  private async launchBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    const launch = await this.resolveChromiumLaunchOptions();
    this.logger.logDebug("Launching browser...");
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      executablePath: launch.executablePath,
    });
    this.logger.logInfo(`Chrome launched (${launch.strategy})`, browser.version());
    const context = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
    return { browser, context };
  }

  private async fastAutoScroll(
    page: Page,
    { step = 1920, maxScrolls = 5, idleMs = 100 } = {},
  ): Promise<void> {
    await page.evaluate(
      async ({ step, maxScrolls, idleMs }) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        let lastHeight = document.body.scrollHeight;
        let sameHeightSince = performance.now();
        let scrolls = 0;

        while (true) {
          window.scrollBy(0, step);
          scrolls += 1;
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
}

export function createBrowserPageAcquisition(params: {
  pageContent: PageContent;
  logger: Logger;
}): BrowserPageAcquisition {
  return new DefaultBrowserPageAcquisition(params.pageContent, params.logger);
}
