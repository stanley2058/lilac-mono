import { createHash } from "node:crypto";

import type { AssistantContent, ModelMessage, ToolContent } from "ai";

export type ToolCallIdNormalizationMode = "strict" | "strict9";

export type ToolCallIdNormalizationPolicy = {
  mode: ToolCallIdNormalizationMode;
  maxLength: number;
};

const DEFAULT_MAX_TOOL_CALL_ID_LENGTH = 64;
const STRICT9_LENGTH = 9;
const DEFAULT_HASH_LENGTH = 8;
const MISTRAL_MODEL_HINTS = [
  "mistral",
  "mixtral",
  "codestral",
  "pixtral",
  "devstral",
  "ministral",
  "mistralai",
];

function shortHash(text: string, length = DEFAULT_HASH_LENGTH): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}

export function resolveToolCallIdNormalizationPolicy(
  modelSpecifier: string | undefined,
): ToolCallIdNormalizationPolicy | undefined {
  if (!modelSpecifier) return undefined;

  const normalized = modelSpecifier.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  if (MISTRAL_MODEL_HINTS.some((hint) => normalized.includes(hint))) {
    return {
      mode: "strict9",
      maxLength: STRICT9_LENGTH,
    };
  }

  const isAnthropic = normalized.includes("anthropic") || normalized.includes("claude");
  const isGoogle = normalized.includes("google") || normalized.includes("gemini");
  const isBedrock = normalized.startsWith("bedrock/");

  if (!isAnthropic && !isGoogle && !isBedrock) {
    return undefined;
  }

  return {
    mode: "strict",
    maxLength: DEFAULT_MAX_TOOL_CALL_ID_LENGTH,
  };
}

function sanitizeToolCallIdBase(id: string, policy: ToolCallIdNormalizationPolicy): string {
  if (policy.mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    const seed = alphanumericOnly.length > 0 ? alphanumericOnly : shortHash(id, STRICT9_LENGTH);
    if (seed.length >= policy.maxLength) {
      return seed.slice(0, policy.maxLength);
    }
    return `${seed}${shortHash(`${id}:pad`, policy.maxLength)}`.slice(0, policy.maxLength);
  }

  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (sanitized.length === 0) {
    return "tool_call".slice(0, policy.maxLength);
  }
  return sanitized.slice(0, policy.maxLength);
}

function makeUniqueToolCallId(params: {
  id: string;
  used: Set<string>;
  policy: ToolCallIdNormalizationPolicy;
}): string {
  const base = sanitizeToolCallIdBase(params.id, params.policy);
  if (!params.used.has(base)) {
    return base;
  }

  if (params.policy.mode === "strict9") {
    for (let i = 0; i < 1000; i += 1) {
      const candidate = shortHash(`${params.id}:${i}`, params.policy.maxLength);
      if (!params.used.has(candidate)) {
        return candidate;
      }
    }

    return shortHash(`${params.id}:${Date.now()}`, params.policy.maxLength);
  }

  const hash = shortHash(params.id);
  const separator = "_";
  const maxBaseLength = Math.max(1, params.policy.maxLength - separator.length - hash.length);
  const candidate = `${base.slice(0, maxBaseLength)}${separator}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = `_${i}`;
    const next = `${candidate.slice(0, params.policy.maxLength - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const tsSuffix = `_${Date.now()}`;
  return `${candidate.slice(0, params.policy.maxLength - tsSuffix.length)}${tsSuffix}`;
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<ModelMessage, { role: "assistant" }>;
  resolve: (id: string) => string;
}): Extract<ModelMessage, { role: "assistant" }> {
  if (!Array.isArray(params.message.content)) {
    return params.message;
  }

  let nextContent: AssistantContent | null = null;

  for (let i = 0; i < params.message.content.length; i += 1) {
    const part = params.message.content[i];
    if (part?.type !== "tool-call") continue;

    const nextId = params.resolve(part.toolCallId);
    if (nextId === part.toolCallId) continue;

    nextContent ??= params.message.content.map((contentPart) => ({ ...contentPart }));
    const nextPart = nextContent[i];
    if (nextPart?.type !== "tool-call") continue;
    nextPart.toolCallId = nextId;
  }

  if (!nextContent) {
    return params.message;
  }

  return {
    ...params.message,
    content: nextContent,
  };
}

function rewriteToolResultIds(params: {
  message: Extract<ModelMessage, { role: "tool" }>;
  resolve: (id: string) => string;
}): Extract<ModelMessage, { role: "tool" }> {
  let nextContent: ToolContent | null = null;

  for (let i = 0; i < params.message.content.length; i += 1) {
    const part = params.message.content[i];
    if (part?.type !== "tool-result") continue;

    const nextId = params.resolve(part.toolCallId);
    if (nextId === part.toolCallId) continue;

    nextContent ??= params.message.content.map((contentPart) => ({ ...contentPart }));
    const nextPart = nextContent[i];
    if (nextPart?.type !== "tool-result") continue;
    nextPart.toolCallId = nextId;
  }

  if (!nextContent) {
    return params.message;
  }

  return {
    ...params.message,
    content: nextContent,
  };
}

export function normalizeModelMessagesToolCallIds(params: {
  messages: readonly ModelMessage[];
  modelSpecifier: string | undefined;
}): ModelMessage[] {
  const policy = resolveToolCallIdNormalizationPolicy(params.modelSpecifier);
  if (!policy) {
    return [...params.messages];
  }

  const idMap = new Map<string, string>();
  const used = new Set<string>();

  const resolve = (id: string) => {
    const existing = idMap.get(id);
    if (existing) {
      return existing;
    }

    const next = makeUniqueToolCallId({
      id,
      used,
      policy,
    });
    idMap.set(id, next);
    used.add(next);
    return next;
  };

  return params.messages.map((message) => {
    if (message.role === "assistant") {
      return rewriteAssistantToolCallIds({
        message,
        resolve,
      });
    }

    if (message.role === "tool") {
      return rewriteToolResultIds({
        message,
        resolve,
      });
    }

    return message;
  });
}

export function buildSyntheticToolCallId(params: {
  prefix: string;
  seed: string;
  maxLength?: number;
}): string {
  const maxLength = Math.max(16, params.maxLength ?? DEFAULT_MAX_TOOL_CALL_ID_LENGTH);
  const hash = shortHash(params.seed, 10);
  const prefixMaxLength = Math.max(1, Math.min(24, maxLength - hash.length - 2));
  const safePrefix = sanitizeToolCallIdBase(params.prefix, {
    mode: "strict",
    maxLength: prefixMaxLength,
  });
  const safeSeed = params.seed.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  const seedMaxLength = Math.max(0, maxLength - safePrefix.length - hash.length - 2);
  const clippedSeed = safeSeed.slice(0, seedMaxLength);

  if (clippedSeed.length === 0) {
    return `${safePrefix}_${hash}`;
  }

  return `${safePrefix}_${clippedSeed}_${hash}`;
}
