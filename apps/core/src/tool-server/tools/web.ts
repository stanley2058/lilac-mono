import type { Logger } from "@stanley2058/simple-module-logger";
import {
  createLogger,
  env,
  errorMessage as getErrorMessage,
  formatTaggedErrorForLog,
  getCoreConfig,
  isRecord,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";
import { z } from "zod";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";

import { defineServerTool, type RequestContext, type ServerTool } from "../types";
import {
  createDefaultWebSearchProviders,
  resolveWebSearchProvider,
  webSearchInputSchema,
  type WebSearchProvider,
  type WebSearchProviderId,
} from "./web-search";
import {
  FirecrawlPermitPool,
  FirecrawlPermitQueueTimedOut,
  type FirecrawlPermit,
  type FirecrawlPermitFailure,
  type FirecrawlPermitPolicy,
} from "./web-search/firecrawl-permit-pool";
import {
  createBrowserPageAcquisition,
  type BrowserPageAcquisition,
} from "./web/browser-page-acquisition";
import {
  createDirectHttpPageAcquisition,
  type DirectHttpPageAcquisition,
} from "./web/direct-http-page-acquisition";
import {
  assessPageContent,
  buildSimpleHtmlContent,
  normalizePageWhitespace,
  PageContent,
  slicePageContent,
  type PageAcquisitionInput,
  type PageContentError,
  type PageContentResult,
  type PageFormat,
  type ParsedPageContent,
} from "./web/page-content";
import {
  createProviderPageExtractor,
  type ProviderPageExtractor,
  type WebProviderEnvironment,
} from "./web/provider-page-extraction";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

export {
  decodeFirecrawlScrapeResponse,
  FirecrawlScrapeResponseInvalid,
} from "./web/provider-page-extraction";

const getPageModeSchema = z.enum(["auto", "fetch", "browser", "extract", "provider-only"]);

const getPageSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).describe("HTTP or HTTPS URL to fetch"),
  mode: getPageModeSchema
    .optional()
    .describe(
      "Mode to use for fetching the page; `auto`: smart fallback flow; `fetch`: direct HTTP fetch; `browser`: render with a browser; `extract`: use the configured extract provider order, then browser fallback if needed; `provider-only`: go straight to the configured provider order with no simple fetch or browser fallback.",
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
      "Timeout in ms. Timeout for initial connection if using browser. Defaults to 120000 (120s) for Firecrawl extraction and 10000 (10s) otherwise.",
    ),
});

type GetPageMode = z.infer<typeof getPageModeSchema>;
type GetPageInput = z.infer<typeof getPageSchema>;
type WebProviderFailure = { providerId: WebSearchProviderId; failure: ServerToolFailure };

class WebProviderOperationFailed extends TaggedError("WebProviderOperationFailed")<{
  readonly cause: ServerToolFailure;
  readonly message: string;
}> {}
type WebPageContentError = PageContentError & { failure?: ServerToolFailure };
type WebPageContentResult = Exclude<PageContentResult, PageContentError> | WebPageContentError;
type WebFetchResult = ReturnType<typeof slicePageContent> | WebPageContentError;
type WebToolConfig = {
  extractProviders: readonly WebSearchProviderId[];
  fetchMode: GetPageMode;
  firecrawlPolicy: FirecrawlPermitPolicy | undefined;
};

const RETRIABLE_WEB_PROVIDER_ERROR_PATTERNS = [
  /credits? (are )?(exhausted|depleted|insufficient|used up)/i,
  /quota (is )?(exhausted|depleted|exceeded|reached)/i,
  /rate limit/i,
  /too many requests/i,
  /temporar(?:y|ily) unavailable/i,
  /try again later/i,
  /timeout/i,
  /timed out/i,
  /server error/i,
  /bad gateway/i,
  /gateway timeout/i,
  /service unavailable/i,
  /network error/i,
  /connection reset/i,
  /socket hang up/i,
  /fetch failed/i,
] as const;

const sharedFirecrawlFetchPermits = new FirecrawlPermitPool("fetch");
const sharedFirecrawlSearchPermits = new FirecrawlPermitPool("search");

async function loadDefaultWebToolConfig(): Promise<WebToolConfig> {
  const config = await getCoreConfig();
  return {
    extractProviders: config.tools.web.extract.providers,
    fetchMode: config.tools.web.fetch.mode,
    firecrawlPolicy: config.tools.web.firecrawl,
  };
}

function getDefaultWebProviderEnvironment(): WebProviderEnvironment {
  return {
    firecrawl: {
      apiKey: env.tools.web.firecrawl.apiKey,
      apiBaseUrl: env.tools.web.firecrawl.apiBaseUrl,
    },
    exa: {
      apiKey: env.tools.web.exa.apiKey,
      baseUrl: env.tools.web.exa.baseUrl,
    },
    tavily: {
      apiKey: env.tools.web.tavilyApiKey,
      apiBaseUrl: env.tools.web.tavilyApiBaseUrl,
    },
  };
}

export type WebDependencies = {
  createLogger: typeof createLogger;
  loadWebToolConfig: () => Promise<WebToolConfig>;
  getProviderEnvironment: () => WebProviderEnvironment;
  createSearchProviders: typeof createDefaultWebSearchProviders;
  createPageContent: () => PageContent;
  createDirectPageAcquisition: (params: { pageContent: PageContent }) => DirectHttpPageAcquisition;
  createBrowserPageAcquisition: (params: {
    pageContent: PageContent;
    logger: Logger;
  }) => BrowserPageAcquisition;
  createProviderPageExtractor: (params: {
    getEnvironment: () => WebProviderEnvironment;
    firecrawlPermits: FirecrawlPermitPool;
  }) => ProviderPageExtractor;
  firecrawlFetchPermits: FirecrawlPermitPool;
  firecrawlSearchPermits: FirecrawlPermitPool;
};

const defaultWebDependencies: WebDependencies = {
  createLogger,
  loadWebToolConfig: loadDefaultWebToolConfig,
  getProviderEnvironment: getDefaultWebProviderEnvironment,
  createSearchProviders: createDefaultWebSearchProviders,
  createPageContent: () => new PageContent(),
  createDirectPageAcquisition: createDirectHttpPageAcquisition,
  createBrowserPageAcquisition,
  createProviderPageExtractor,
  firecrawlFetchPermits: sharedFirecrawlFetchPermits,
  firecrawlSearchPermits: sharedFirecrawlSearchPermits,
};

function captureWebFailure(error: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(error)) return { cause: error };
  if (error instanceof Error) return { cause: error };
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Web operation failed";
  return { cause: new Error(message, { cause: error }) };
}

function getNumericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const directStatus = getNumericField(error, "status") ?? getNumericField(error, "statusCode");
  if (directStatus !== null) return directStatus;

  const response = error.response;
  if (isRecord(response)) {
    const responseStatus =
      getNumericField(response, "status") ?? getNumericField(response, "statusCode");
    if (responseStatus !== null) return responseStatus;
  }

  const cause = error.cause;
  if (isRecord(cause)) {
    const causeStatus = getNumericField(cause, "status") ?? getNumericField(cause, "statusCode");
    if (causeStatus !== null) return causeStatus;

    const causeResponse = cause.response;
    if (isRecord(causeResponse)) {
      return (
        getNumericField(causeResponse, "status") ?? getNumericField(causeResponse, "statusCode")
      );
    }
  }
  return null;
}

function isRetriableWebProviderError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500)
  ) {
    return true;
  }
  const message = getErrorMessage(error);
  return RETRIABLE_WEB_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function webFailure(error: unknown, signal?: AbortSignal): ServerToolFailure {
  if (Panic.is(error)) preserveToolPanic(error);
  const message =
    isRecord(error) && typeof error.message === "string" ? error.message : getErrorMessage(error);
  const status = getErrorStatus(error);
  const normalized = message.toLowerCase();
  let category: ServerToolFailure["kind"] = "unavailable";
  switch (true) {
    case signal?.aborted || /\babort(?:ed)?\b/.test(normalized):
      category = "cancelled";
      break;
    case status === 408 || /\b(?:timeout|timed out)\b/.test(normalized):
      category = "timeout";
      break;
    case status === 401 ||
      status === 403 ||
      /\b(?:401|403|unauthori[sz]ed|forbidden)\b/.test(normalized):
      category = "denied";
      break;
    case status === 404 || /\b(?:404|not found)\b/.test(normalized):
      category = "not_found";
      break;
    case /unsupported|invalid (?:url|format|content)|response too large/.test(normalized):
      category = "usage";
      break;
  }
  return serverToolFailure({
    kind: category,
    code: `web_${category}`,
    message,
    retryable: category === "unavailable" || category === "timeout",
  });
}

function formatWebProviderFailureMessage(
  operation: "search" | "extract",
  failures: readonly WebProviderFailure[],
): string {
  if (failures.length === 0) return `web.${operation} failed.`;
  if (failures.length === 1) return failures[0]!.failure.message;
  return `web.${operation} failed across fallback providers: ${failures
    .map((failure) => `${failure.providerId}: ${failure.failure.message}`)
    .join(" | ")}`;
}

function aggregateWebProviderFailure(
  operation: "search" | "extract",
  failures: readonly WebProviderFailure[],
): ServerToolFailure {
  const message = formatWebProviderFailureMessage(operation, failures);
  const terminalFailure = failures.at(-1)?.failure;
  return terminalFailure ? serverToolFailure({ ...terminalFailure, message }) : webFailure(message);
}

function webPageContentFailure(
  result: WebPageContentError,
  signal?: AbortSignal,
): ServerToolFailure {
  return (
    result.failure ??
    webFailure(
      {
        message: result.error,
        ...(result.status === undefined ? {} : { status: result.status }),
      },
      signal,
    )
  );
}

function supportsHtmlExtractFormat(providerId: WebSearchProviderId): boolean {
  return providerId === "firecrawl";
}

export class Web implements ServerTool {
  id = "web";
  private readonly serverTool: ServerTool;
  private readonly logger: Logger;
  private readonly pageContent: PageContent;
  private readonly directPageAcquisition: DirectHttpPageAcquisition;
  private readonly browserPageAcquisition: BrowserPageAcquisition;
  private readonly providerPageExtractor: ProviderPageExtractor;
  private webSearchProviders: readonly WebSearchProvider[] = [];
  private webSearchProviderError: string | null = null;
  private webSearchProviderKey: string | null = null;
  private webFetchDefaultMode: GetPageMode = "auto";

  constructor(private readonly dependencies: WebDependencies = defaultWebDependencies) {
    this.logger = dependencies.createLogger({ module: "server-tool:web" });
    this.pageContent = dependencies.createPageContent();
    this.directPageAcquisition = dependencies.createDirectPageAcquisition({
      pageContent: this.pageContent,
    });
    this.browserPageAcquisition = dependencies.createBrowserPageAcquisition({
      pageContent: this.pageContent,
      logger: this.logger,
    });
    this.providerPageExtractor = dependencies.createProviderPageExtractor({
      getEnvironment: dependencies.getProviderEnvironment,
      firecrawlPermits: dependencies.firecrawlFetchPermits,
    });
    this.serverTool = defineServerTool({
      id: this.id,
      init: () => this.initialize(),
      destroy: () => this.browserPageAcquisition.destroy(),
      callables: ({ callable }) => ({
        fetch: callable({
          name: "Fetch",
          description: "Fetch a web page",
          inputSchema: getPageSchema,
          validation: "zod",
          primaryPositional: "url",
          run: (input, opts) => this.callFetch(input, opts),
        }),
        search: callable({
          name: "Web Search",
          description: "Search the web",
          inputSchema: webSearchInputSchema,
          validation: "zod",
          primaryPositional: "query",
          run: (input, opts) => this.callSearch(input, opts),
        }),
      }),
    });
  }

  init(): Promise<void> {
    return this.serverTool.init();
  }

  destroy(): Promise<void> {
    return this.serverTool.destroy();
  }

  list() {
    return this.serverTool.list();
  }

  call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<ServerToolResult> {
    return this.serverTool.call(callableId, rawInput, opts);
  }

  private async initialize(): Promise<void> {
    await this.refreshWebConfig();
    this.logger.logDebug("Web extension initialized");
  }

  private async refreshWebConfig(): Promise<void> {
    const loaded = await Result.tryPromise({
      try: this.dependencies.loadWebToolConfig,
      catch: captureWebFailure,
    });
    const config = loaded.match<WebToolConfig>({
      ok: (value) => value,
      err: () => ({ extractProviders: [], fetchMode: "auto", firecrawlPolicy: undefined }),
    });
    const loadFailure = loaded.match<Error | Panic | null>({
      ok: () => null,
      err: ({ cause }) => cause,
    });
    if (loadFailure) {
      if (Panic.is(loadFailure)) preserveToolPanic(loadFailure);
      const failure = new WebProviderOperationFailed({
        cause: webFailure(loadFailure),
        message: "Failed to read core-config.yaml for web tool config",
      });
      this.logger.logError(
        "Failed to read core-config.yaml for web tool config",
        formatTaggedErrorForLog(failure),
      );
    }

    const normalizedRequested = config.extractProviders.map((providerId) =>
      providerId.trim().toLowerCase(),
    );
    const environment = this.dependencies.getProviderEnvironment();
    const nextKey = JSON.stringify({
      requested: normalizedRequested,
      fetchMode: config.fetchMode,
      firecrawlPolicy: config.firecrawlPolicy ?? null,
      firecrawlApiBaseUrl: environment.firecrawl.apiBaseUrl ?? null,
      hasFirecrawlApiKey: Boolean(environment.firecrawl.apiKey),
      exaBaseUrl: environment.exa.baseUrl ?? null,
      hasExaApiKey: Boolean(environment.exa.apiKey),
      hasTavilyApiKey: Boolean(environment.tavily.apiKey),
      tavilyApiBaseUrl: environment.tavily.apiBaseUrl ?? null,
    });
    if (nextKey === this.webSearchProviderKey) return;
    this.webSearchProviderKey = nextKey;
    if (!loadFailure) {
      this.dependencies.firecrawlFetchPermits.configure(config.firecrawlPolicy);
      this.dependencies.firecrawlSearchPermits.configure(config.firecrawlPolicy);
    }

    const previousIds = this.webSearchProviders.map((provider) => provider.id).join(" -> ") || null;
    const previousFetchMode = this.webFetchDefaultMode;
    const providers = this.dependencies.createSearchProviders({
      firecrawl: {
        apiKey: environment.firecrawl.apiKey,
        apiBaseUrl: environment.firecrawl.apiBaseUrl,
      },
      exa: { baseUrl: environment.exa.baseUrl, apiKey: environment.exa.apiKey },
      tavilyApiKey: environment.tavily.apiKey,
      tavilyApiBaseUrl: environment.tavily.apiBaseUrl,
    });
    const resolved = resolveWebSearchProvider({
      requested: config.extractProviders,
      providers,
    });
    this.webSearchProviders = resolved.providers;
    this.webSearchProviderError = resolved.error;
    this.webFetchDefaultMode = config.fetchMode;

    const nextIds = this.webSearchProviders.map((provider) => provider.id).join(" -> ") || null;
    if (resolved.warning) this.logger.logInfo(resolved.warning);
    if (nextIds && nextIds !== previousIds) {
      this.logger.logDebug(`web.extract providers: ${nextIds}`);
    }
    if (previousFetchMode !== this.webFetchDefaultMode) {
      this.logger.logDebug(`web.fetch mode: ${this.webFetchDefaultMode}`);
    }
    if (!nextIds && this.webSearchProviderError) this.logger.logError(this.webSearchProviderError);
  }

  private async callFetch(
    input: GetPageInput,
    opts?: { signal?: AbortSignal; context?: RequestContext },
  ): Promise<ServerToolResult> {
    await this.refreshWebConfig();
    const mode = input.mode ?? this.webFetchDefaultMode;
    let result: WebFetchResult;
    switch (mode) {
      case "auto":
        result = await this.getPageAuto(input, opts);
        break;
      case "fetch":
        result = await this.getPageFetch(input, opts);
        break;
      case "browser":
        result = await this.getPageBrowser(input, opts);
        break;
      case "extract":
        result = await this.getPageExtract(input, opts);
        break;
      case "provider-only":
        result = await this.getPageProviderOnly(input, opts);
        break;
    }
    return result.isError
      ? Result.err(webPageContentFailure(result, opts?.signal))
      : Result.ok(result);
  }

  private async callSearch(
    input: z.output<typeof webSearchInputSchema>,
    opts?: { signal?: AbortSignal },
  ): Promise<ServerToolResult> {
    await this.refreshWebConfig();
    if (this.webSearchProviders.length === 0) {
      return Result.err(
        serverToolFailure({
          kind: "unavailable",
          code: "web_provider_unavailable",
          message:
            this.webSearchProviderError ?? "web.search is unavailable: no provider configured.",
          retryable: true,
        }),
      );
    }

    const failures: WebProviderFailure[] = [];
    for (const [index, provider] of this.webSearchProviders.entries()) {
      if (index > 0) {
        this.logger.logInfo(`web.search retrying with fallback provider '${provider.id}'.`);
      }

      let permit: FirecrawlPermit | undefined;
      if (provider.id === "firecrawl") {
        const acquired = (
          await this.dependencies.firecrawlSearchPermits.acquire(opts?.signal)
        ).match<{ permit: FirecrawlPermit } | { error: FirecrawlPermitFailure; timedOut: boolean }>(
          {
            ok: (value) => ({ permit: value }),
            err: (error) => ({ error, timedOut: FirecrawlPermitQueueTimedOut.is(error) }),
          },
        );
        if ("error" in acquired) {
          const failure = webFailure(acquired.error, opts?.signal);
          failures.push({ providerId: provider.id, failure });
          if (acquired.timedOut && index < this.webSearchProviders.length - 1) {
            this.logger.logInfo(
              `web.search retryable failure (${provider.id}); falling back to next provider.`,
              formatTaggedErrorForLog(acquired.error),
            );
            continue;
          }
          this.logger.logError(
            `web.search failed (${provider.id}).`,
            formatTaggedErrorForLog(acquired.error),
          );
          return Result.err(failure);
        }
        permit = acquired.permit;
      }

      const outcome = await (async () => {
        const searched = await Result.tryPromise({
          try: () => provider.search(input, { signal: opts?.signal }),
          catch: captureWebFailure,
        });
        return searched.match<
          | { readonly kind: "return"; readonly value: ServerToolResult }
          | { readonly kind: "panic"; readonly panic: Panic }
          | {
              readonly kind: "failure";
              readonly failure: ServerToolFailure;
              readonly retryable: boolean;
            }
        >({
          ok: (value) => ({ kind: "return", value: Result.ok(value) }),
          err: ({ cause }) =>
            Panic.is(cause)
              ? ({ kind: "panic", panic: cause } as const)
              : ({
                  kind: "failure",
                  failure: webFailure(cause, opts?.signal),
                  retryable: isRetriableWebProviderError(cause),
                } as const),
        });
      })().finally(() => permit?.release());
      if (outcome.kind === "return") return outcome.value;
      if (outcome.kind === "panic") preserveToolPanic(outcome.panic);
      failures.push({ providerId: provider.id, failure: outcome.failure });
      if (outcome.retryable && index < this.webSearchProviders.length - 1) {
        this.logger.logInfo(
          `web.search retryable failure (${provider.id}); falling back to next provider.`,
          formatTaggedErrorForLog(
            new WebProviderOperationFailed({
              cause: outcome.failure,
              message: outcome.failure.message,
            }),
          ),
        );
        continue;
      }
      this.logger.logError(
        `web.search failed (${provider.id}).`,
        formatTaggedErrorForLog(
          new WebProviderOperationFailed({
            cause: outcome.failure,
            message: outcome.failure.message,
          }),
        ),
      );
      break;
    }
    return Result.err(aggregateWebProviderFailure("search", failures));
  }

  private async extractPageContent(
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebPageContentResult> {
    const { format = "markdown" } = input;
    if (this.webSearchProviders.length === 0) {
      return {
        isError: true,
        error: this.webSearchProviderError ?? "web.extract is unavailable: no provider configured.",
      };
    }

    const failures: WebProviderFailure[] = [];
    for (const [index, provider] of this.webSearchProviders.entries()) {
      if (index > 0) {
        this.logger.logInfo(`web.extract retrying with fallback provider '${provider.id}'.`);
      }
      const extracted = await Result.tryPromise({
        try: () => this.providerPageExtractor.extract(provider.id, input, opts),
        catch: captureWebFailure,
      });
      const outcome = extracted.match<
        | { readonly kind: "result"; readonly result: WebPageContentResult }
        | { readonly kind: "panic"; readonly panic: Panic }
        | {
            readonly kind: "failure";
            readonly failure: ServerToolFailure;
            readonly retryable: boolean;
          }
      >({
        ok: (result) => ({ kind: "result", result }),
        err: ({ cause }) =>
          Panic.is(cause)
            ? ({ kind: "panic", panic: cause } as const)
            : ({
                kind: "failure",
                failure: webFailure(cause, opts?.signal),
                retryable: isRetriableWebProviderError(cause),
              } as const),
      });
      if (outcome.kind === "panic") preserveToolPanic(outcome.panic);
      if (outcome.kind === "failure") {
        failures.push({ providerId: provider.id, failure: outcome.failure });
        if (outcome.retryable && index < this.webSearchProviders.length - 1) {
          this.logger.logInfo(
            `web.extract retryable failure (${provider.id}); falling back to next provider.`,
            formatTaggedErrorForLog(
              new WebProviderOperationFailed({
                cause: outcome.failure,
                message: outcome.failure.message,
              }),
            ),
          );
          continue;
        }
        this.logger.logError(
          `web.extract failed (${provider.id}).`,
          formatTaggedErrorForLog(
            new WebProviderOperationFailed({
              cause: outcome.failure,
              message: outcome.failure.message,
            }),
          ),
        );
        break;
      }
      const { result } = outcome;
      if (!result.isError || result.aborted) return result;
      const failure = webFailure(
        {
          message: result.error,
          ...(result.status === undefined ? {} : { status: result.status }),
        },
        opts?.signal,
      );
      failures.push({
        providerId: provider.id,
        failure,
      });
      const canTryNextProviderForFormat =
        format === "html" && !supportsHtmlExtractFormat(provider.id);
      if (
        (isRetriableWebProviderError(result.error) || canTryNextProviderForFormat) &&
        index < this.webSearchProviders.length - 1
      ) {
        this.logger.logInfo(
          `web.extract fallback failure (${provider.id}); falling back to next provider.`,
          formatTaggedErrorForLog(
            new WebProviderOperationFailed({ cause: failure, message: failure.message }),
          ),
        );
        continue;
      }
      this.logger.logError(
        `web.extract failed (${provider.id}).`,
        formatTaggedErrorForLog(
          new WebProviderOperationFailed({ cause: failure, message: failure.message }),
        ),
      );
      break;
    }
    const failure = aggregateWebProviderFailure("extract", failures);
    return { isError: true, error: failure.message, failure };
  }

  private async getPageFetch(
    input: GetPageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebFetchResult> {
    const { format = "markdown", startOffset = 0, maxCharacters = 200_000 } = input;
    const result = await this.directPageAcquisition.acquire(input, opts);
    return this.formatPageResult(result, format, startOffset, maxCharacters);
  }

  private async getPageBrowser(
    input: GetPageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebFetchResult> {
    const { format = "markdown", startOffset = 0, maxCharacters = 200_000 } = input;
    const result = await this.browserPageAcquisition.acquire(input, opts);
    return this.formatPageResult(result, format, startOffset, maxCharacters);
  }

  private async getPageExtract(
    input: GetPageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebFetchResult> {
    const { format = "markdown", startOffset = 0, maxCharacters = 200_000 } = input;
    const result = await this.extractPageContent(input, opts);
    if (result.isError) {
      if (result.aborted) return result;
      this.logger.logError(`${result.error} Falling back to browser mode.`);
      return this.getPageBrowser({ ...input, format, mode: "browser" }, opts);
    }
    return slicePageContent({
      content: result.content,
      format,
      startOffset,
      maxCharacters,
      sourceTruncated: result.sourceTruncated,
    });
  }

  private async getPageProviderOnly(
    input: GetPageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebFetchResult> {
    const { format = "markdown", startOffset = 0, maxCharacters = 200_000 } = input;
    const result = await this.extractPageContent(input, opts);
    return this.formatPageResult(result, format, startOffset, maxCharacters);
  }

  private formatPageResult(
    result: WebPageContentResult,
    format: PageFormat,
    startOffset: number,
    maxCharacters: number,
  ): WebFetchResult {
    if (result.isError) return result;
    return slicePageContent({
      content: result.content,
      format,
      startOffset,
      maxCharacters,
      sourceTruncated: result.sourceTruncated,
    });
  }

  private async getPageAuto(
    input: GetPageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<WebFetchResult> {
    const { url, format = "markdown", startOffset = 0, maxCharacters = 200_000, timeout } = input;
    const acquisitionInput = {
      url,
      format,
      timeout,
      preprocessor: "readability" as const,
    };
    const fetchResult = await this.directPageAcquisition.acquire(acquisitionInput, opts);
    if (!fetchResult.isError) {
      const assessment = fetchResult.rawHtml
        ? assessPageContent({ content: fetchResult.content, rawHtml: fetchResult.rawHtml })
        : { isWeak: false, reasons: [] as const };
      if (!fetchResult.rawHtml || !assessment.isWeak) {
        return slicePageContent({
          content: fetchResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: fetchResult.sourceTruncated,
        });
      }
      this.logger.logDebug(
        `web.fetch auto escalating to browser after weak fetch extraction: ${assessment.reasons.join(", ")}`,
      );
    }

    const browserResult = await this.browserPageAcquisition.acquire(acquisitionInput, opts);
    let browserParsedFallbackContent: ParsedPageContent | null = null;
    let browserWholePageFallbackContent: ParsedPageContent | null = null;
    let browserRawFallbackContent: ParsedPageContent | null = null;
    if (!browserResult.isError) {
      browserParsedFallbackContent = browserResult.content;
      if (browserResult.rawHtml) {
        browserWholePageFallbackContent = this.pageContent.parse(browserResult.rawHtml, url, {
          preprocessor: "none",
          signal: opts?.signal,
        });
      }
      browserRawFallbackContent = browserResult.rawHtml
        ? buildSimpleHtmlContent(browserResult.rawHtml, url)
        : browserResult.content;
      const assessment = assessPageContent({
        content: browserResult.content,
        rawHtml: browserResult.rawHtml,
      });
      if (!assessment.isWeak) {
        return slicePageContent({
          content: browserResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: browserResult.sourceTruncated,
        });
      }
      this.logger.logDebug(
        `web.fetch auto escalating to extract after weak browser extraction: ${assessment.reasons.join(", ")}`,
      );
    }

    if (format !== "html") {
      const extractResult = await this.extractPageContent(
        { url, format, preprocessor: "none", timeout },
        opts,
      );
      if (extractResult.isError && extractResult.aborted) return extractResult;
      if (
        !extractResult.isError &&
        normalizePageWhitespace(extractResult.content.text).length > 0
      ) {
        return slicePageContent({
          content: extractResult.content,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: extractResult.sourceTruncated,
        });
      }

      const preferredBrowserFallback =
        browserWholePageFallbackContent &&
        normalizePageWhitespace(browserWholePageFallbackContent.text).length >
          normalizePageWhitespace(browserParsedFallbackContent?.text ?? "").length
          ? browserWholePageFallbackContent
          : browserParsedFallbackContent;
      if (
        preferredBrowserFallback &&
        normalizePageWhitespace(preferredBrowserFallback.text).length > 0
      ) {
        return slicePageContent({
          content: preferredBrowserFallback,
          format,
          startOffset,
          maxCharacters,
          sourceTruncated: browserResult.isError ? false : browserResult.sourceTruncated,
        });
      }
    }

    if (browserRawFallbackContent) {
      return slicePageContent({
        content: browserRawFallbackContent,
        format,
        startOffset,
        maxCharacters,
        sourceTruncated: browserResult.isError ? false : browserResult.sourceTruncated,
      });
    }
    if (!fetchResult.isError) {
      return slicePageContent({
        content: fetchResult.content,
        format,
        startOffset,
        maxCharacters,
        sourceTruncated: fetchResult.sourceTruncated,
      });
    }
    return browserResult.isError ? browserResult : fetchResult;
  }
}
