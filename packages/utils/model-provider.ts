import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { env } from "./env";
import {
  OAUTH_DUMMY_KEY,
  readCodexTokens,
  refreshAccessToken,
  writeCodexTokens,
} from "./codex-oauth";

export type Providers =
  | "openai"
  | "codex"
  | "xai"
  | "openrouter"
  | "anthropic"
  | "groq"
  | "vercel"
  | (string & {});

export function getModelProviders() {
  let codexRefreshInFlight: Promise<void> | null = null;

  const providers = {
    openai: env.providers.openai
      ? createOpenAI({
          baseURL: env.providers.openai.baseUrl,
          apiKey: env.providers.openai.apiKey,
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

        // Codex backend expects a stable allowlisted `instructions` string.
        // App-level providerOptions mapping provides it; do not set it here.

        let body = init?.body;
        // Codex backend requires `store` explicitly set to false.
        // The OpenAI Responses API defaults may omit it, causing a 400.
        if (
          url.origin === "https://chatgpt.com" &&
          url.pathname.endsWith("/backend-api/codex/responses") &&
          body !== null &&
          body !== undefined
        ) {
          const decodeBody = (b: unknown): string | undefined => {
            if (typeof b === "string") return b;
            if (b instanceof Uint8Array) return new TextDecoder().decode(b);
            if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b));
            return undefined;
          };

          const encoded = decodeBody(body);
          if (encoded !== undefined) {
            try {
              const parsed = JSON.parse(encoded) as unknown;
              if (parsed && typeof parsed === "object") {
                const record = parsed as Record<string, unknown>;
                // Codex backend rejects requests unless store is explicitly false.
                if (record.store !== false) record.store = false;

                // Codex does not persist response items when store=false.
                // Strip optional per-item `id` fields to avoid replaying rs_* item references.
                // Keep ids on item types that require them.
                const input = record.input;
                if (Array.isArray(input)) {
                  for (const item of input) {
                    if (!item || typeof item !== "object" || !("id" in item)) continue;
                    const r = item as Record<string, unknown>;
                    const type = typeof r.type === "string" ? r.type : undefined;

                    // item_reference.id is required.
                    if (type === "item_reference") continue;
                    // These tool call item types require id.
                    if (
                      type === "local_shell_call" ||
                      type === "shell_call" ||
                      type === "computer_call"
                    ) {
                      continue;
                    }

                    delete r.id;
                  }
                }

                // Ensure we don't try to thread via Responses replay.
                if ("previous_response_id" in record) {
                  delete record.previous_response_id;
                }
                body = JSON.stringify(record);
              }
            } catch {
              // Ignore non-JSON bodies.
            }
          }
        }

        return fetch(url, {
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
