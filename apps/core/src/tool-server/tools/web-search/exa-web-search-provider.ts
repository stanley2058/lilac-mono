import Exa from "exa-js";

import {
  normalizeBaseUrl,
  startDateFromTimeRange,
  toSearchContentSnippet,
  withAbortSignal,
} from "./shared";
import type { WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

type ExaCategory = "news" | "financial report";

function mapTopicToExaCategory(topic: WebSearchInput["topic"]): ExaCategory | undefined {
  switch (topic) {
    case "news":
      return "news";
    case "finance":
      return "financial report";
    case "general":
      return undefined;
  }
}

export class ExaWebSearchProvider implements WebSearchProvider {
  readonly id = "exa" as const;

  private client: Exa | null = null;

  constructor(
    private readonly config: {
      baseUrl?: string;
      apiKey?: string;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private getClient(): Exa {
    if (this.client) return this.client;

    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error("EXA_API_KEY is not configured.");
    }

    const baseUrlRaw = this.config.baseUrl?.trim();
    this.client = baseUrlRaw ? new Exa(apiKey, normalizeBaseUrl(baseUrlRaw)) : new Exa(apiKey);
    return this.client;
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const client = this.getClient();

    const startPublishedDate =
      input.startDate ?? (input.timeRange ? startDateFromTimeRange(input.timeRange) : undefined);
    const endPublishedDate = input.endDate;

    const category = mapTopicToExaCategory(input.topic);
    const type = input.searchDepth;

    const response = await withAbortSignal(opts?.signal, () =>
      client.search(input.query, {
        type,
        numResults: input.maxResults,
        ...(category ? { category } : {}),
        ...(startPublishedDate ? { startPublishedDate } : {}),
        ...(endPublishedDate ? { endPublishedDate } : {}),
        contents: {
          highlights: {
            query: input.query,
            maxCharacters: 4000,
          },
          text: {
            maxCharacters: 4000,
          },
        },
      }),
    );

    return response.results.map((result) => {
      const title =
        typeof result.title === "string" && result.title.length > 0 ? result.title : result.url;
      const score = typeof result.score === "number" ? result.score : null;

      return {
        url: result.url,
        title,
        content: toSearchContentSnippet(result),
        score,
      } satisfies WebSearchResult;
    });
  }
}
