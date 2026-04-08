import type { WebSearchProvider, WebSearchProviderId } from "./types";

const DEFAULT_WEB_SEARCH_PROVIDER = "tavily" as const;

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function formatProviderList(ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}

function missingConfigMessage(id: WebSearchProviderId): string | null {
  if (id === "firecrawl") {
    return "web.search is unavailable: FIRECRAWL_API_KEY is not configured (set env var FIRECRAWL_API_KEY).";
  }
  if (id === "exa") {
    return "web.search is unavailable: EXA_API_KEY is not configured (set env var EXA_API_KEY).";
  }
  if (id === "tavily") {
    return "web.search is unavailable: TAVILY_API_KEY is not configured (set env var TAVILY_API_KEY).";
  }
  return null;
}

export function resolveWebSearchProvider(params: {
  requested?: string | readonly string[];
  providers: readonly WebSearchProvider[];
}): {
  providers: readonly WebSearchProvider[];
  error: string | null;
  warning: string | null;
} {
  const byId = new Map<string, WebSearchProvider>();
  const ids: WebSearchProviderId[] = [];

  for (const provider of params.providers) {
    const normalizedId = provider.id.trim().toLowerCase();
    if (!byId.has(normalizedId)) {
      ids.push(provider.id);
    }
    byId.set(normalizedId, provider);
  }

  const normalizedRequested = uniqueStrings(
    (Array.isArray(params.requested) ? params.requested : [params.requested])
      .flatMap((value) => (typeof value === "string" ? [value.trim().toLowerCase()] : []))
      .filter((value) => value.length > 0),
  );

  const requestedIds =
    normalizedRequested.length > 0
      ? normalizedRequested
      : byId.has(DEFAULT_WEB_SEARCH_PROVIDER)
        ? [
            DEFAULT_WEB_SEARCH_PROVIDER,
            ...ids.filter((id) => id.toLowerCase() !== DEFAULT_WEB_SEARCH_PROVIDER),
          ]
        : ids;

  const unknownRequested = requestedIds.find((requestedId) => !byId.has(requestedId));
  if (unknownRequested) {
    return {
      providers: [],
      error: `web.search is unavailable: unknown provider '${unknownRequested}'. Registered: ${ids.join(", ") || "none"}.`,
      warning: null,
    };
  }

  const requestedProviders = requestedIds
    .map((requestedId) => byId.get(requestedId))
    .filter((provider): provider is WebSearchProvider => provider !== undefined);

  const configuredProviders = requestedProviders.filter((provider) => provider.isConfigured());
  if (configuredProviders.length > 0) {
    const unconfiguredIds = requestedProviders
      .filter((provider) => !provider.isConfigured())
      .map((provider) => provider.id);

    return {
      providers: configuredProviders,
      error: null,
      warning:
        unconfiguredIds.length > 0
          ? `web.search providers ${formatProviderList(unconfiguredIds)} are not configured; using configured fallback order: ${configuredProviders.map((provider) => provider.id).join(" -> ")}.`
          : null,
    };
  }

  if (requestedProviders.length === 0) {
    return {
      providers: [],
      error: "web.search is unavailable: no provider configured.",
      warning: null,
    };
  }

  if (requestedProviders.length === 1) {
    const provider = requestedProviders[0]!;
    return {
      providers: [],
      error:
        missingConfigMessage(provider.id) ??
        `web.search is unavailable: provider '${provider.id}' is not configured.`,
      warning: null,
    };
  }

  return {
    providers: [],
    error: `web.search is unavailable: none of the requested providers are configured. Missing configuration for ${formatProviderList(requestedProviders.map((provider) => provider.id))}.`,
    warning: null,
  };
}
