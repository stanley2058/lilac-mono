import { createHash } from "node:crypto";

import type { ModelMessage, ToolSet } from "ai";
import type { AiSdkModelCallInput } from "@stanley2058/lilac-agent/adapters/ai-sdk/model-call";
import type { CoreConfig, JSONObject } from "@stanley2058/lilac-utils";

import { isAnthropicModelSpec } from "./anthropic-fallback-media";

const ANTHROPIC_PROMPT_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "5m",
} as const;

export const ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: ANTHROPIC_PROMPT_CACHE_CONTROL },
  openrouter: { cacheControl: ANTHROPIC_PROMPT_CACHE_CONTROL },
} as const satisfies NonNullable<ModelMessage["providerOptions"]>;

export function mergeProviderOptions(
  base: ModelMessage["providerOptions"],
  patch: NonNullable<ModelMessage["providerOptions"]>,
): NonNullable<ModelMessage["providerOptions"]> {
  const out =
    base && typeof base === "object" && !Array.isArray(base)
      ? ({ ...base } as NonNullable<ModelMessage["providerOptions"]>)
      : ({} as NonNullable<ModelMessage["providerOptions"]>);

  for (const [k, v] of Object.entries(patch)) {
    const existing = (out as Record<string, unknown>)[k];
    (out as Record<string, unknown>)[k] =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...v }
        : v;
  }

  return out;
}

export function withProviderOptionsOnLastUserMessage(
  messages: ModelMessage[],
  providerOptions: NonNullable<ModelMessage["providerOptions"]>,
): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;

    const merged = mergeProviderOptions(msg.providerOptions, providerOptions);
    const next = { ...msg, providerOptions: merged } satisfies ModelMessage;
    return [...messages.slice(0, i), next, ...messages.slice(i + 1)];
  }

  return messages;
}

function isOpenAIBackedModel(provider: string, modelId: string): boolean {
  if (provider === "openai" || provider === "codex") return true;
  return modelId.startsWith("openai/");
}

function isAnthropicBackedModel(provider: string, modelId: string): boolean {
  if (provider === "anthropic") return true;
  return modelId.startsWith("anthropic/");
}

export function shouldEnableAnthropicPromptCache(params: {
  spec: string;
  anthropicPromptCache?: boolean;
}): boolean {
  return params.anthropicPromptCache === true && isAnthropicModelSpec(params.spec);
}

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const OPENAI_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";

export function toOpenAIPromptCacheKey(sessionId: string): string {
  if (sessionId.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return sessionId;
  }

  return createHash("sha256").update(sessionId).digest("hex");
}

function jsonObjectOrEmpty(value: JSONObject | undefined): JSONObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isFirstPartyAnthropicEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return true;
  const endpoint = URL.parse(baseUrl);
  if (!endpoint || endpoint.origin !== "https://api.anthropic.com") return false;
  if (endpoint.href !== `${endpoint.origin}${endpoint.pathname}`) return false;
  const path = endpoint.pathname.replace(/\/$/u, "");
  return path === "" || path === "/v1";
}

function hasAnthropicCacheControl(providerOptions: ModelMessage["providerOptions"]): boolean {
  const anthropic = providerOptions?.anthropic;
  return Boolean(anthropic?.cacheControl ?? anthropic?.cache_control);
}

function hasAnthropicMessageCacheControl(message: ModelMessage): boolean {
  if (hasAnthropicCacheControl(message.providerOptions)) return true;
  if (typeof message.content === "string") return false;
  return message.content.some((part) => {
    if ("providerOptions" in part && hasAnthropicCacheControl(part.providerOptions)) return true;
    if (part.type !== "tool-result") return false;
    const { output } = part;
    if ("providerOptions" in output) return hasAnthropicCacheControl(output.providerOptions);
    return (
      output.type === "content" &&
      output.value.some((content) => hasAnthropicCacheControl(content.providerOptions))
    );
  });
}

export function withDefaultAnthropicAutomaticPromptCache(params: {
  provider: string;
  baseUrl?: string;
  anthropicPromptCache?: boolean;
  providerOptions?: Record<string, JSONObject>;
  system?: AiSdkModelCallInput["system"];
  messages?: readonly ModelMessage[];
  tools?: ToolSet;
}): Record<string, JSONObject> | undefined {
  const { provider, baseUrl, anthropicPromptCache, providerOptions, system, messages, tools } =
    params;
  if (provider !== "anthropic" || anthropicPromptCache !== undefined) return providerOptions;
  if (!isFirstPartyAnthropicEndpoint(baseUrl)) return providerOptions;

  const anthropic = jsonObjectOrEmpty(providerOptions?.anthropic);
  if ("cacheControl" in anthropic) return providerOptions;

  // A request-level marker can conflict with the final explicit marker or exceed the slot limit.
  const instructions = typeof system === "string" || system === undefined ? [] : [system].flat();
  if (instructions.some(hasAnthropicMessageCacheControl)) return providerOptions;
  if (messages?.some(hasAnthropicMessageCacheControl)) return providerOptions;
  if (Object.values(tools ?? {}).some((tool) => hasAnthropicCacheControl(tool.providerOptions))) {
    return providerOptions;
  }

  return {
    ...providerOptions,
    anthropic: { ...anthropic, cacheControl: ANTHROPIC_PROMPT_CACHE_CONTROL },
  };
}

export function withOpenAIPromptCacheKey(
  providerOptions: { [x: string]: JSONObject } | undefined,
  promptCacheKey: string,
): { [x: string]: JSONObject } {
  const base = providerOptions ?? {};
  return {
    ...base,
    openai: {
      ...jsonObjectOrEmpty(base["openai"]),
      promptCacheKey,
    },
  };
}

export function withOpenAIServerCompaction(
  providerOptions: { [x: string]: JSONObject } | undefined,
): { [x: string]: JSONObject } {
  const base = providerOptions ?? {};
  const existingOpenAI = jsonObjectOrEmpty(base["openai"]);
  const rawInclude = existingOpenAI["include"];
  const include = Array.isArray(rawInclude)
    ? rawInclude.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...base,
    openai: {
      ...existingOpenAI,
      store: false,
      include: [...new Set([...include, OPENAI_REASONING_ENCRYPTED_CONTENT_INCLUDE])],
    },
  };
}

export function withReasoningSummaryDefaultForOpenAIModels(params: {
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"];
  provider: string;
  modelId: string;
  providerOptions: { [x: string]: JSONObject } | undefined;
}): { [x: string]: JSONObject } | undefined {
  if (params.reasoningDisplay === "none") return params.providerOptions;
  if (!isOpenAIBackedModel(params.provider, params.modelId)) return params.providerOptions;

  const base = params.providerOptions ?? {};
  const rawOpenAI = base["openai"];
  const existingOpenAI: JSONObject =
    rawOpenAI && typeof rawOpenAI === "object" && !Array.isArray(rawOpenAI)
      ? (rawOpenAI as JSONObject)
      : {};

  const include = existingOpenAI["include"];
  const openAIWithReasoningInclude =
    Array.isArray(include) && include.includes(OPENAI_REASONING_ENCRYPTED_CONTENT_INCLUDE)
      ? existingOpenAI
      : {
          ...existingOpenAI,
          include: Array.isArray(include)
            ? [...include, OPENAI_REASONING_ENCRYPTED_CONTENT_INCLUDE]
            : [OPENAI_REASONING_ENCRYPTED_CONTENT_INCLUDE],
        };

  if ("reasoningSummary" in existingOpenAI) {
    return {
      ...base,
      openai: openAIWithReasoningInclude,
    };
  }

  return {
    ...base,
    openai: {
      ...openAIWithReasoningInclude,
      reasoningSummary: "detailed",
    },
  };
}

export function withReasoningDisplayDefaultForAnthropicModels(params: {
  reasoningDisplay: CoreConfig["agent"]["reasoningDisplay"];
  provider: string;
  modelId: string;
  providerOptions: { [x: string]: JSONObject } | undefined;
}): { [x: string]: JSONObject } | undefined {
  if (params.reasoningDisplay === "none") return params.providerOptions;
  if (!isAnthropicBackedModel(params.provider, params.modelId)) return params.providerOptions;

  const base = params.providerOptions ?? {};
  const rawAnthropic = base["anthropic"];
  const existingAnthropic: JSONObject =
    rawAnthropic && typeof rawAnthropic === "object" && !Array.isArray(rawAnthropic)
      ? (rawAnthropic as JSONObject)
      : {};

  const rawThinking = existingAnthropic["thinking"];
  if (!rawThinking || typeof rawThinking !== "object" || Array.isArray(rawThinking)) {
    return params.providerOptions;
  }

  const existingThinking = rawThinking as JSONObject;
  if ("display" in existingThinking) {
    return params.providerOptions;
  }

  const thinkingType = existingThinking["type"];
  if (thinkingType === "disabled") {
    return params.providerOptions;
  }

  if (thinkingType !== "adaptive" && thinkingType !== "enabled") {
    return params.providerOptions;
  }

  const nextThinking: JSONObject = {
    ...existingThinking,
    display: "summarized",
  };

  return {
    ...base,
    anthropic: {
      ...existingAnthropic,
      thinking: nextThinking,
    },
  };
}
