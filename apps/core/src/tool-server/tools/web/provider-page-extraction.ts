import Exa from "exa-js";
import type { TavilyClient } from "@tavily/core";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { WebSearchProviderId } from "../web-search";
import {
  FirecrawlPermitQueueAborted,
  type FirecrawlPermitPool,
} from "../web-search/firecrawl-permit-pool";
import {
  buildTextContent,
  markdownToText,
  simpleHtmlToText,
  type PageAcquisitionInput,
  type PageContentResult,
} from "./page-content";

const EXA_MAX_EXTRACT_CHARACTERS = 50_000;
const TAVILY_MAX_TIMEOUT_SECONDS = 60;

const firecrawlScrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  data: z
    .object({
      url: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      html: z.string().nullable().optional(),
      markdown: z.string().nullable().optional(),
      content: z.string().nullable().optional(),
      metadata: z
        .object({
          sourceURL: z.string().nullable().optional(),
          title: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

type FirecrawlScrapeResponse = z.output<typeof firecrawlScrapeResponseSchema>;

export class FirecrawlScrapeResponseInvalid extends TaggedError("FirecrawlScrapeResponseInvalid")<{
  readonly message: string;
}> {}

export function decodeFirecrawlScrapeResponse(
  value: unknown,
): ResultType<FirecrawlScrapeResponse, FirecrawlScrapeResponseInvalid> {
  const decoded = firecrawlScrapeResponseSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new FirecrawlScrapeResponseInvalid({ message: "Firecrawl returned an invalid response" }),
  );
}

export type WebProviderEnvironment = {
  firecrawl: { apiKey?: string; apiBaseUrl?: string };
  exa: { apiKey?: string; baseUrl?: string };
  tavily: { apiKey?: string; apiBaseUrl?: string };
};

export interface ProviderPageExtractor {
  extract(
    providerId: WebSearchProviderId,
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function toTavilyTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.min(TAVILY_MAX_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000)));
}

function buildExaExtractCharacterBudget(input: PageAcquisitionInput): {
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

function getFirecrawlTitle(payload: FirecrawlScrapeResponse, fallbackUrl: string): string {
  return payload.data?.metadata?.title?.trim() || payload.data?.title?.trim() || fallbackUrl;
}

function getAbortReasonError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "request aborted",
  );
  error.name = "AbortError";
  return error;
}

function withAbortSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw getAbortReasonError(signal);
  const pending = run();
  if (!signal) return pending;

  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(getAbortReasonError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([pending, aborted]).finally(removeAbortListener);
}

export class DefaultProviderPageExtractor implements ProviderPageExtractor {
  private tavilyClient: TavilyClient | null = null;
  private exaClient: Exa | null = null;

  constructor(
    private readonly dependencies: {
      getEnvironment: () => WebProviderEnvironment;
      firecrawlPermits: FirecrawlPermitPool;
      fetch: typeof fetch;
      createTavilyClient: (params: { apiKey: string; apiBaseURL?: string }) => TavilyClient;
      createExaClient: (apiKey: string, baseUrl?: string) => Exa;
    },
  ) {}

  async extract(
    providerId: WebSearchProviderId,
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult> {
    switch (providerId) {
      case "firecrawl":
        return this.extractFirecrawl(input, opts);
      case "tavily":
        return this.extractTavily(input, opts);
      case "exa":
        return this.extractExa(input, opts);
      default:
        return {
          isError: true,
          error: `web.extract provider '${providerId}' is not supported.`,
        };
    }
  }

  private getTavilyClient(): TavilyClient | null {
    if (this.tavilyClient) return this.tavilyClient;
    const environment = this.dependencies.getEnvironment().tavily;
    if (!environment.apiKey) return null;
    const apiBaseUrl = environment.apiBaseUrl?.trim();
    this.tavilyClient = this.dependencies.createTavilyClient({
      apiKey: environment.apiKey,
      apiBaseURL: apiBaseUrl ? normalizeBaseUrl(apiBaseUrl) : undefined,
    });
    return this.tavilyClient;
  }

  private getExaClient(): Exa | null {
    if (this.exaClient) return this.exaClient;
    const environment = this.dependencies.getEnvironment().exa;
    if (!environment.apiKey) return null;
    const baseUrl = environment.baseUrl?.trim();
    this.exaClient = this.dependencies.createExaClient(
      environment.apiKey,
      baseUrl ? normalizeBaseUrl(baseUrl) : undefined,
    );
    return this.exaClient;
  }

  private async extractFirecrawl(
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult> {
    const { url, format = "markdown", timeout = 120_000 } = input;
    const environment = this.dependencies.getEnvironment().firecrawl;
    if (!environment.apiKey) {
      return { isError: true, error: "FIRECRAWL_API_KEY is not configured." };
    }

    const apiBaseUrlRaw = environment.apiBaseUrl?.trim();
    const apiBaseUrl = apiBaseUrlRaw
      ? normalizeBaseUrl(apiBaseUrlRaw)
      : "https://api.firecrawl.dev";
    const acquired = (await this.dependencies.firecrawlPermits.acquire(opts?.signal)).match<
      { permit: { release(): void } } | { error: { message: string }; aborted: boolean }
    >({
      ok: (permit) => ({ permit }),
      err: (error) => ({ error, aborted: FirecrawlPermitQueueAborted.is(error) }),
    });
    if ("error" in acquired) {
      return {
        isError: true,
        error: acquired.error.message,
        ...(acquired.aborted ? { aborted: true as const } : {}),
      };
    }

    const outcome = await (async () => {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = AbortSignal.any([timeoutSignal, ...(opts?.signal ? [opts.signal] : [])]);
      const response = await this.dependencies.fetch(`${apiBaseUrl}/v2/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${environment.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats: format === "html" ? ["html"] : ["markdown"],
          onlyMainContent: true,
          timeout,
        }),
        signal,
      });

      const rawPayload = await Result.tryPromise({
        try: () => response.json(),
        catch: () => new FirecrawlScrapeResponseInvalid({ message: "invalid JSON response" }),
      });
      const payload = rawPayload
        .andThen(decodeFirecrawlScrapeResponse)
        .match({ ok: (value) => value, err: () => null });
      if (!payload) {
        const invalidKind = rawPayload.match({
          ok: () => "invalid response contract",
          err: () => "invalid JSON response",
        });
        return {
          status: "return",
          value: {
            isError: true,
            error: `Firecrawl scrape failed (${response.status}): ${invalidKind}.`,
          },
        } as const;
      }
      if (!response.ok || payload.success === false) {
        return {
          status: "return",
          value: {
            isError: true,
            error: `Firecrawl scrape failed (${response.status}): ${response.statusText || "request failed"}`,
          },
        } as const;
      }
      if (!payload.data)
        return {
          status: "return",
          value: { isError: true, error: "Firecrawl scrape returned no content." },
        } as const;

      const resultUrl = payload.data.metadata?.sourceURL?.trim() || payload.data.url?.trim() || url;
      const title = getFirecrawlTitle(payload, resultUrl);
      if (format === "html") {
        const html = payload.data.html?.trim();
        if (!html)
          return {
            status: "return",
            value: { isError: true, error: "Firecrawl scrape returned no html content." },
          } as const;
        const text = simpleHtmlToText(html);
        return {
          status: "return",
          value: {
            isError: false,
            content: { url: resultUrl, title, markdown: text, text, raw: html },
          },
        } as const;
      }

      const markdown = payload.data.markdown?.trim() ?? payload.data.content?.trim();
      if (!markdown)
        return {
          status: "return",
          value: { isError: true, error: "Firecrawl scrape returned no content." },
        } as const;
      const text = format === "text" ? markdownToText(markdown) : markdown;
      return {
        status: "return",
        value: {
          isError: false,
          content: buildTextContent({
            url: resultUrl,
            title,
            text,
            markdown,
            raw: markdown,
          }),
        },
      } as const;
    })().finally(() => {
      acquired.permit.release();
    });
    return outcome.value;
  }

  private async extractTavily(
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult> {
    const { url, format = "markdown", timeout = 10_000 } = input;
    if (format === "html") {
      return { isError: true, error: "Tavily extract does not support format=html." };
    }
    const client = this.getTavilyClient();
    if (!client) return { isError: true, error: "TAVILY_API_KEY is not configured." };

    const response = await withAbortSignal(opts?.signal, () =>
      client.extract([url], {
        extractDepth: "advanced",
        format: format === "text" ? "text" : "markdown",
        timeout: toTavilyTimeoutSeconds(timeout),
      }),
    );
    const result = response.results[0];
    if (!result) return { isError: true, error: "No extracted content returned." };
    return {
      isError: false,
      content: buildTextContent({
        url: result.url,
        title: "title" in result && typeof result.title === "string" ? result.title : result.url,
        text: result.rawContent,
        markdown: result.rawContent,
        raw: result.rawContent,
      }),
    };
  }

  private async extractExa(
    input: PageAcquisitionInput,
    opts?: { signal?: AbortSignal },
  ): Promise<PageContentResult> {
    const { url, format = "markdown", timeout = 10_000 } = input;
    if (format === "html") {
      return { isError: true, error: "Exa extract does not support format=html." };
    }
    const client = this.getExaClient();
    if (!client) return { isError: true, error: "EXA_API_KEY is not configured." };

    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([timeoutSignal, ...(opts?.signal ? [opts.signal] : [])]);
    const budget = buildExaExtractCharacterBudget(input);
    const response = await withAbortSignal(signal, () =>
      client.getContents([url], { text: { maxCharacters: budget.requestedCharacters } }),
    );
    const result = response.results[0];
    if (!result) return { isError: true, error: "No extracted content returned." };

    const text = "text" in result && typeof result.text === "string" ? result.text : "";
    return {
      isError: false,
      sourceTruncated: budget.truncatedByBudget || text.length >= budget.requestedCharacters,
      content: buildTextContent({
        url: result.url,
        title: typeof result.title === "string" ? result.title : result.url,
        text,
        markdown: text,
        raw: text,
      }),
    };
  }
}

export function createProviderPageExtractor(params: {
  getEnvironment: () => WebProviderEnvironment;
  firecrawlPermits: FirecrawlPermitPool;
}): ProviderPageExtractor {
  return new DefaultProviderPageExtractor({
    ...params,
    fetch,
    // Loaded on first use: the client costs about 12 MiB of RSS, and this factory is synchronous.
    createTavilyClient: (options) => {
      const { tavily }: typeof import("@tavily/core") = require("@tavily/core");
      return tavily(options);
    },
    createExaClient: (apiKey, baseUrl) => (baseUrl ? new Exa(apiKey, baseUrl) : new Exa(apiKey)),
  });
}
