import type { WebSearchProvider, WebSearchProviderId } from "./types";

const DEFAULT_WEB_SEARCH_PROVIDER = "tavily" as const;

function missingConfigMessage(id: WebSearchProviderId): string | null {
  if (id === "exa") {
    return "web.search is unavailable: EXA_API_KEY is not configured (set env var EXA_API_KEY).";
  }
  if (id === "tavily") {
    return "web.search is unavailable: TAVILY_API_KEY is not configured (set env var TAVILY_API_KEY).";
  }
  return null;
}

export function resolveWebSearchProvider(params: {
  requested?: string;
  providers: readonly WebSearchProvider[];
}): {
  provider: WebSearchProvider | null;
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

  const normalized = params.requested?.trim().toLowerCase() ?? "";

  const requested =
    normalized.length > 0
      ? normalized
      : byId.has(DEFAULT_WEB_SEARCH_PROVIDER)
        ? DEFAULT_WEB_SEARCH_PROVIDER
        : (ids[0] ?? DEFAULT_WEB_SEARCH_PROVIDER);

  const provider = byId.get(requested);
  if (!provider) {
    return {
      provider: null,
      error: `web.search is unavailable: unknown provider '${requested}'. Registered: ${ids.join(", ") || "none"}.`,
      warning: null,
    };
  }

  if (provider.isConfigured()) {
    return { provider, error: null, warning: null };
  }

  const fallback = params.providers.find((candidate) => candidate.isConfigured()) ?? null;

  if (!fallback) {
    return {
      provider: null,
      error:
        missingConfigMessage(provider.id) ??
        `web.search is unavailable: provider '${provider.id}' is not configured.`,
      warning: null,
    };
  }

  return {
    provider: fallback,
    error: null,
    warning: `web.search provider '${provider.id}' is not configured; falling back to '${fallback.id}'.`,
  };
}
