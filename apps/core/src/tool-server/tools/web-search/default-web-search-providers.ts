import { ExaWebSearchProvider } from "./exa-web-search-provider";
import { TavilyWebSearchProvider } from "./tavily-web-search-provider";
import type { WebSearchProvider } from "./types";

export function createDefaultWebSearchProviders(config: {
  exa: {
    baseUrl?: string;
    apiKey?: string;
  };
  tavilyApiKey?: string;
  tavilyApiBaseUrl?: string;
}): readonly WebSearchProvider[] {
  return [
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
