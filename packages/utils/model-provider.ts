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
  OAUTH_DUMMY_KEY,
  readCodexTokens,
  refreshAccessToken,
  writeCodexTokens,
} from "./codex-oauth";
import { createLogger } from "./logging";
import { createOpenAIResponsesWebSocketFetch } from "./openai-responses-websocket-fetch";
import { withLlmWireDebugFetch } from "./llm-wire-debug";

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

function decodeCodexRequestBody(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return undefined;
}

export function normalizeCodexResponsesRequestRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...record };

  // Codex backend rejects requests unless store is explicitly false.
  if (normalized.store !== false) normalized.store = false;

  const instructions = normalized.instructions;
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    normalized.instructions = CODEX_BASE_INSTRUCTIONS;
  }

  // Codex does not persist response items when store=false.
  // Strip optional per-item `id` fields to avoid replaying rs_* item references.
  // Keep ids on item types that require them.
  const input = normalized.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object" || !("id" in item)) continue;
      const entry = item as Record<string, unknown>;
      const type = typeof entry.type === "string" ? entry.type : undefined;

      // item_reference.id is required.
      if (type === "item_reference") continue;
      // These tool call item types require id.
      if (type === "local_shell_call" || type === "shell_call" || type === "computer_call") {
        continue;
      }

      delete entry.id;
    }
  }

  // Ensure we don't try to thread via Responses replay.
  if ("previous_response_id" in normalized) {
    delete normalized.previous_response_id;
  }

  return normalized;
}

export function getModelProviders() {
  let codexRefreshInFlight: Promise<void> | null = null;
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

  const codexResponsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: env.providers.codex.responsesTransport,
    url: "wss://chatgpt.com/backend-api/codex/responses",
    completionEventTypes: ["response.completed", "response.done"],
    normalizeEvent: (event) => {
      if (event.type !== "response.done") return event;
      return {
        ...event,
        type: "response.completed",
      };
    },
    onTransportSelected: (details) => {
      logger.info("responses transport selected", {
        provider: "codex",
        ...details,
      });
    },
    onAutoFallback: (details) => {
      logger.warn("responses transport fallback to sse", {
        provider: "codex",
        ...details,
      });
    },
  });

  const openaiFetch = withLlmWireDebugFetch({
    provider: "openai",
    fetchFn: openaiResponsesFetch,
    warn: (message, details) => logger.warn(message, details),
  });

  const codexFetch = withLlmWireDebugFetch({
    provider: "codex",
    fetchFn: codexResponsesFetch,
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

    codex: createOpenAI({
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: OAUTH_DUMMY_KEY,
      // The OpenAI provider's FetchFunction type is `typeof globalThis.fetch`.
      // Bun's type may include extra properties; cast to avoid leaking that requirement here.
      fetch: (async (requestInput, init) => {
        const parsed =
          requestInput instanceof URL
            ? requestInput
            : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);

        // We want /responses to land on /backend-api/codex/responses.
        // If upstream ever changes and we get /v1/responses or /chat/completions,
        // rewrite to the Codex endpoint explicitly.
        const url =
          parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
            ? new URL("https://chatgpt.com/backend-api/codex/responses")
            : parsed;

        // Normalize + strip auth headers set by @ai-sdk/openai (dummy key).
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
        let auth = await readCodexTokens();
        if (!auth) {
          throw new Error("Codex OAuth not configured. Run tool 'codex.login' to authenticate.");
        }

        const refreshIfNeeded = async () => {
          if (auth && auth.access && auth.expires > Date.now() + 30_000) {
            return;
          }

          if (!codexRefreshInFlight) {
            codexRefreshInFlight = (async () => {
              const latest = await readCodexTokens();
              if (!latest) {
                throw new Error(
                  "Codex OAuth not configured. Run tool 'codex.login' to authenticate.",
                );
              }

              // Another call may have refreshed already.
              if (latest.access && latest.expires > Date.now() + 30_000) {
                auth = latest;
                return;
              }

              const tokens = await refreshAccessToken(latest.refresh);
              const next = {
                type: "oauth" as const,
                refresh: tokens.refresh_token,
                access: tokens.access_token,
                expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                accountId: latest.accountId,
                idToken: latest.idToken,
              };
              await writeCodexTokens(next);
              auth = next;
            })().finally(() => {
              codexRefreshInFlight = null;
            });
          }

          await codexRefreshInFlight;
        };

        // If the cached token is expired, refresh before request.
        if (!auth.access || auth.expires <= now) {
          await refreshIfNeeded();
          auth = await readCodexTokens();
          if (!auth?.access) {
            throw new Error("Codex OAuth token refresh failed. Run tool 'codex.login' again.");
          }
        }

        headers.set("authorization", `Bearer ${auth.access}`);
        if (auth.accountId) {
          headers.set("chatgpt-account-id", auth.accountId);
          headers.set("ChatGPT-Account-Id", auth.accountId);
        }

        // Helpful for server-side routing; Codex CLI always sends this.
        headers.set("originator", "lilac");

        let body = init?.body;
        // Codex backend requires `store` explicitly set to false.
        // It also expects a stable allowlisted `instructions` string.
        // Harden the transport path so fallback/full-request websocket payloads
        // still satisfy backend requirements even if upstream omitted them.
        if (
          url.origin === "https://chatgpt.com" &&
          url.pathname.endsWith("/backend-api/codex/responses") &&
          body !== null &&
          body !== undefined
        ) {
          const encoded = decodeCodexRequestBody(body);
          if (encoded !== undefined) {
            try {
              const parsed = JSON.parse(encoded) as unknown;
              if (parsed && typeof parsed === "object") {
                body = JSON.stringify(
                  normalizeCodexResponsesRequestRecord(parsed as Record<string, unknown>),
                );
              }
            } catch {
              // Ignore non-JSON bodies.
            }
          }
        }

        return codexFetch(url, {
          ...init,
          headers,
          body,
        });
      }) as typeof globalThis.fetch,
    }),
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
