import { ExaWebSearchProvider } from "./exa-web-search-provider";
import { FirecrawlWebSearchProvider } from "./firecrawl-web-search-provider";
import { TavilyWebSearchProvider } from "./tavily-web-search-provider";
import type { WebSearchProvider } from "./types";

export function createDefaultWebSearchProviders(config: {
  firecrawl: {
    apiKey?: string;
    apiBaseUrl?: string;
  };
  exa: {
    baseUrl?: string;
    apiKey?: string;
  };
  tavilyApiKey?: string;
  tavilyApiBaseUrl?: string;
}): readonly WebSearchProvider[] {
  return [
    new FirecrawlWebSearchProvider({
      apiKey: config.firecrawl.apiKey,
      apiBaseUrl: config.firecrawl.apiBaseUrl,
    }),
    new ExaWebSearchProvider({
      baseUrl: config.exa.baseUrl,
      apiKey: config.exa.apiKey,
    }),
    new TavilyWebSearchProvider({
      apiBaseUrl: config.tavilyApiBaseUrl,
      apiKey: config.tavilyApiKey,
    }),
  ];
}
