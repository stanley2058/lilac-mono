/** Providers the model catalog knows, in picker order. Safe to import in the browser. */
export const CATALOG_PROVIDERS = [
  "codex",
  "openai",
  "claude-code",
  "anthropic",
  "xai",
  "openrouter",
  "vercel",
  "groq",
  "google",
  "cerebras",
  "openai-compatible",
] as const;

export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];
