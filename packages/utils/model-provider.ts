import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";

import { CODEX_BASE_INSTRUCTIONS } from "./codex-instructions";
import { env } from "./env";
import {
  extractAccountId,
  OAUTH_DUMMY_KEY,
  readCodexTokens,
  refreshAccessToken,
  type CodexOAuthFetch,
  type CodexOAuthTokens,
  writeCodexTokens,
} from "./codex-oauth";
import { createLogger } from "./logging";
import { createOpenAIResponsesWebSocketFetch } from "./openai-responses-websocket-fetch";
import { withLlmWireDebugFetch } from "./llm-wire-debug";
import { isRecord } from "./runtime-utils";

export type Providers =
  | "openai"
  | "openai-compatible"
  | "codex"
  | "xai"
  | "openrouter"
  | "anthropic"
  | "groq"
  | "vercel"
  | (string & {});

const CODEX_RESPONSES_REQUEST_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
]);
const CODEX_REASONING_INCLUDE = "reasoning.encrypted_content";
const CODEX_OAUTH_REFRESH_SKEW_MS = 30_000;

export function shouldRefreshCodexOAuthTokens(tokens: CodexOAuthTokens, now = Date.now()): boolean {
  return !tokens.access || tokens.expires <= now + CODEX_OAUTH_REFRESH_SKEW_MS;
}

function decodeCodexRequestBody(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return undefined;
}

export function normalizeCodexResponsesRequestRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record.stream !== true) {
    throw new Error(
      "Invalid Codex request: the ChatGPT Codex backend requires streaming; use streamText",
    );
  }
  const normalized = Object.fromEntries(
    Object.entries(record).filter(([key]) => CODEX_RESPONSES_REQUEST_KEYS.has(key)),
  );

  normalized.store = false;
  if (normalized.parallel_tool_calls === undefined) normalized.parallel_tool_calls = true;

  const include = Array.isArray(normalized.include)
    ? normalized.include.filter((value): value is string => typeof value === "string")
    : [];
  normalized.include = [...new Set([...include, CODEX_REASONING_INCLUDE])];

  const instructions = normalized.instructions;
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    normalized.instructions = CODEX_BASE_INSTRUCTIONS;
  }

  // The Codex backend defaults omitted function-tool strictness to true and
  // makes every declared property required, changing omission-based schemas.
  const tools = normalized.tools;
  if (Array.isArray(tools)) {
    normalized.tools = tools.map((tool) =>
      isRecord(tool) && tool.type === "function" && !("strict" in tool)
        ? { ...tool, strict: false }
        : tool,
    );
  }

  // Codex is stateless with store=false. Reject references and strip every input
  // item ID after AI SDK serialization, matching the native Codex client.
  const input = normalized.input;
  if (Array.isArray(input)) {
    normalized.input = input.map((item) => {
      if (!isRecord(item)) return item;
      const type = typeof item.type === "string" ? item.type : undefined;
      if (type === "item_reference") {
        throw new Error(
          "Invalid Codex stateless request: item_reference requires persisted response items, but store=false",
        );
      }
      if (!("id" in item)) return item;
      const entry = { ...item };
      delete entry.id;
      return entry;
    });
  }

  return normalized;
}

export type RefreshCodexOAuthTokensOptions = {
  fetch?: CodexOAuthFetch;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
  now?: () => number;
};

export async function refreshCodexOAuthTokens(
  current: CodexOAuthTokens,
  options: RefreshCodexOAuthTokensOptions = {},
): Promise<CodexOAuthTokens> {
  const tokens = await refreshAccessToken(current.refresh, options.fetch);
  const next: CodexOAuthTokens = {
    type: "oauth",
    refresh: tokens.refresh_token ?? current.refresh,
    access: tokens.access_token,
    expires: (options.now ?? Date.now)() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) ?? current.accountId,
    idToken: tokens.id_token ?? current.idToken,
  };
  await (options.writeTokens ?? writeCodexTokens)(next);
  return next;
}

function normalizeCodexResponsesEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "response.done") {
    return {
      ...event,
      type: "response.completed",
    };
  }

  // Codex can emit reasoning-summary done events without the corresponding
  // reasoning output item state expected by @ai-sdk/openai's Responses stream
  // transform. We don't consume reasoning in these summarization calls, so
  // normalize the event into a no-op delta that keeps the stream parser alive.
  if (event.type === "response.reasoning_summary_part.done") {
    return {
      ...event,
      type: "response.reasoning_summary_text.delta",
      delta: "",
    };
  }

  return event;
}

export type CreateCodexOAuthProviderOptions = {
  readTokens?: () => Promise<CodexOAuthTokens | null>;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
};

export function createCodexOAuthProvider(options: CreateCodexOAuthProviderOptions = {}) {
  let refreshInFlight: Promise<void> | null = null;
  const readTokens = options.readTokens ?? readCodexTokens;
  const writeTokens = options.writeTokens ?? writeCodexTokens;
  const logger = createLogger({ module: "utils:model-provider" });
  const responsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: env.providers.codex.responsesTransport,
    url: "wss://chatgpt.com/backend-api/codex/responses",
    completionEventTypes: ["response.completed", "response.done"],
    normalizeEvent: normalizeCodexResponsesEvent,
    turnStateHeaderName: "x-codex-turn-state",
    onTransportSelected: (details) => {
      logger.info("responses transport selected", { provider: "codex", ...details });
    },
    onAutoFallback: (details) => {
      logger.warn("responses transport fallback to sse", { provider: "codex", ...details });
    },
  });
  const codexFetch = withLlmWireDebugFetch({
    provider: "codex",
    fetchFn: responsesFetch,
    warn: (message, details) => logger.warn(message, details),
  });

  return createOpenAI({
    baseURL: "https://chatgpt.com/backend-api/codex",
    apiKey: OAUTH_DUMMY_KEY,
    fetch: (async (requestInput, init) => {
      const parsedUrl =
        requestInput instanceof URL
          ? requestInput
          : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
      const url =
        parsedUrl.pathname.includes("/v1/responses") ||
        parsedUrl.pathname.includes("/chat/completions")
          ? new URL("https://chatgpt.com/backend-api/codex/responses")
          : parsedUrl;

      const headers = new Headers();
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => headers.set(key, value));
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            if (key && value !== undefined) headers.set(key, String(value));
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            if (value !== undefined) headers.set(key, String(value));
          }
        }
      }
      headers.delete("authorization");
      headers.delete("Authorization");

      const now = Date.now();
      let auth = await readTokens();
      if (!auth) {
        throw new Error(
          "Codex OAuth not configured. Complete a Codex OAuth login to authenticate.",
        );
      }

      const refreshIfNeeded = async () => {
        if (auth && !shouldRefreshCodexOAuthTokens(auth)) return;
        if (!refreshInFlight) {
          refreshInFlight = (async () => {
            const latest = await readTokens();
            if (!latest) {
              throw new Error(
                "Codex OAuth not configured. Complete a Codex OAuth login to authenticate.",
              );
            }
            if (!shouldRefreshCodexOAuthTokens(latest)) {
              auth = latest;
              return;
            }

            auth = await refreshCodexOAuthTokens(latest, { writeTokens });
          })().finally(() => {
            refreshInFlight = null;
          });
        }
        await refreshInFlight;
      };

      if (shouldRefreshCodexOAuthTokens(auth, now)) {
        await refreshIfNeeded();
        auth = await readTokens();
        if (!auth?.access) {
          throw new Error("Codex OAuth token refresh failed. Complete a new Codex OAuth login.");
        }
      }

      headers.set("authorization", `Bearer ${auth.access}`);
      if (auth.accountId) {
        headers.set("chatgpt-account-id", auth.accountId);
        headers.set("ChatGPT-Account-Id", auth.accountId);
      }
      headers.set("originator", "lilac");

      let body = init?.body;
      if (
        url.origin === "https://chatgpt.com" &&
        url.pathname.endsWith("/backend-api/codex/responses") &&
        body !== null &&
        body !== undefined
      ) {
        const encoded = decodeCodexRequestBody(body);
        if (encoded !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(encoded) as unknown;
          } catch {
            // Ignore non-JSON bodies.
          }
          if (isRecord(parsed)) {
            body = JSON.stringify(normalizeCodexResponsesRequestRecord(parsed));
          }
        }
      }

      return codexFetch(url, { ...init, headers, body });
    }) as typeof globalThis.fetch,
  });
}

export function getModelProviders() {
  const logger = createLogger({
    module: "utils:model-provider",
  });

  const openaiResponsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: env.providers.openai.responsesTransport,
    onTransportSelected: (details) => {
      logger.info("responses transport selected", {
        provider: "openai",
        ...details,
      });
    },
    onAutoFallback: (details) => {
      logger.warn("responses transport fallback to sse", {
        provider: "openai",
        ...details,
      });
    },
  });

  const openaiFetch = withLlmWireDebugFetch({
    provider: "openai",
    fetchFn: openaiResponsesFetch,
    warn: (message, details) => logger.warn(message, details),
  });

  const providers = {
    openai: env.providers.openai
      ? createOpenAI({
          baseURL: env.providers.openai.baseUrl,
          apiKey: env.providers.openai.apiKey,
          fetch: openaiFetch,
        })
      : null,

    "openai-compatible": env.providers.openaiCompatible.baseUrl
      ? createOpenAICompatible({
          name: "openaiCompatible",
          baseURL: env.providers.openaiCompatible.baseUrl,
          apiKey: env.providers.openaiCompatible.apiKey,
          includeUsage: true,
        })
      : null,

    codex: createCodexOAuthProvider(),
    xai: env.providers.xai
      ? createXai({
          baseURL: env.providers.xai.baseUrl,
          apiKey: env.providers.xai.apiKey,
        })
      : null,
    anthropic: env.providers.anthropic
      ? createAnthropic({
          baseURL: env.providers.anthropic.baseUrl,
          apiKey: env.providers.anthropic.apiKey,
        })
      : null,
    openrouter: env.providers.openrouter
      ? createOpenRouter({
          baseURL: env.providers.openrouter.baseUrl,
          apiKey: env.providers.openrouter.apiKey,
        })
      : null,
    groq: env.providers.groq
      ? createGroq({
          baseURL: env.providers.groq.baseUrl,
          apiKey: env.providers.groq.apiKey,
        })
      : null,
    vercel: env.providers.vercel
      ? createGateway({
          baseURL: env.providers.vercel.baseUrl,
          apiKey: env.providers.vercel.apiKey,
        })
      : null,
  } satisfies Record<Providers, unknown>;
  return providers as typeof providers & Record<string, OpenAICompatibleProvider>;
}

export const providers = getModelProviders();
