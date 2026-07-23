import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import { z } from "zod";

import { parseModelRef } from "./model-catalog";
import type { LoadedProviderRegistry } from "./providers";

export const webSearchProviderSchema = z.enum(["openai", "anthropic", "codex"]);
export type WebSearchProvider = z.infer<typeof webSearchProviderSchema>;
export type WebSearchProviderResolver = (modelSpecifier: string) => WebSearchProvider | undefined;

export function createWebSearchProviderResolver(
  providers: Pick<LoadedProviderRegistry, "config" | "supersededProviderIds"> | undefined,
): WebSearchProviderResolver {
  if (!providers) return () => undefined;
  const codexProviderIds = new Set(providers.supersededProviderIds);
  return (modelSpecifier) => {
    const { providerId } = parseModelRef(modelSpecifier);
    if (codexProviderIds.has(providerId)) return "codex";
    const providerType = providers.config.providers[providerId]?.type;
    if (providerType === "openai" || providerType === "anthropic") return providerType;
    return undefined;
  };
}

export function createWebsearchTool(provider: WebSearchProvider): ToolSet {
  return {
    websearch:
      provider === "anthropic"
        ? anthropic.tools.webSearch_20250305({ maxUses: 3 })
        : openai.tools.webSearch({ externalWebAccess: true, searchContextSize: "medium" }),
  };
}
