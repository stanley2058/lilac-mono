import { createHash } from "node:crypto";

import { createCerebras } from "@ai-sdk/cerebras";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { claudeCodeExecutableSettings } from "./claude-code-executable";
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
import { withOpenAIImageEditFilenamesFetch } from "./openai-image-edit-fetch";
import { createOpenAIResponsesWebSocketFetch } from "./openai-responses-websocket-fetch";
import { withLlmWireDebugFetch } from "./llm-wire-debug";
import { captureResultOutcome, isPanic, isRecord } from "./runtime-utils";
import { withServerCompactionRequestFetch } from "./server-compaction-request";

export { claudeCodeExecutableSettings } from "./claude-code-executable";

export type Providers =
  | "openai"
  | "openai-compatible"
  | "cerebras"
  | "codex"
  | "xai"
  | "openrouter"
  | "anthropic"
  | "claude-code"
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

const codexResponsesRequestRecordSchema = z.record(z.string(), z.unknown());

export function decodeCodexResponsesRequestBody(body: string): Record<string, unknown> | undefined {
  const captured = Result.try({
    try: () => JSON.parse(body) as unknown,
    catch: (cause) => ({ cause }),
  });
  const outcome = captureResultOutcome(captured);
  if (!outcome.ok && isPanic(outcome.error.cause)) throw outcome.error.cause;
  const decoded = outcome.ok ? outcome.value : undefined;
  const parsed = codexResponsesRequestRecordSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

export class CodexRequestInvalid extends TaggedError("CodexRequestInvalid")<{
  readonly issue: "streaming-required" | "stateful-reference";
  readonly message: string;
}> {}

export function normalizeCodexResponsesRequestRecordResult(
  record: Record<string, unknown>,
): ResultType<Record<string, unknown>, CodexRequestInvalid> {
  if (record.stream !== true) {
    return Result.err(
      new CodexRequestInvalid({
        issue: "streaming-required",
        message:
          "Invalid Codex request: the ChatGPT Codex backend requires streaming; use streamText",
      }),
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
    const normalizedInput: unknown[] = [];
    for (const item of input) {
      if (!isRecord(item)) {
        normalizedInput.push(item);
        continue;
      }
      const type = typeof item.type === "string" ? item.type : undefined;
      if (type === "item_reference") {
        return Result.err(
          new CodexRequestInvalid({
            issue: "stateful-reference",
            message:
              "Invalid Codex stateless request: item_reference requires persisted response items, but store=false",
          }),
        );
      }
      if (!("id" in item)) {
        normalizedInput.push(item);
        continue;
      }
      const entry = { ...item };
      delete entry.id;
      normalizedInput.push(entry);
    }
    normalized.input = normalizedInput;
  }

  return Result.ok(normalized);
}

export function normalizeCodexResponsesRequestRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const result = normalizeCodexResponsesRequestRecordResult(record);
  const resolved = result.match<
    { readonly value: Record<string, unknown> } | { readonly error: CodexRequestInvalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export type RefreshCodexOAuthTokensOptions = {
  fetch?: CodexOAuthFetch;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

export async function refreshCodexOAuthTokens(
  current: CodexOAuthTokens,
  options: RefreshCodexOAuthTokensOptions = {},
): Promise<CodexOAuthTokens> {
  const tokens = await refreshAccessToken(current.refresh, options.fetch, options.signal);
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

function codexReasoningSummaryKey(event: Record<string, unknown>): string | undefined {
  return typeof event.item_id === "string" && typeof event.summary_index === "number"
    ? `${event.item_id}:${event.summary_index}`
    : undefined;
}

function completedSummaryDelta(streamed: string, completed: string): string {
  return completed.startsWith(streamed) ? completed.slice(streamed.length) : "";
}

function normalizeCodexCompactionItemId(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type !== "response.output_item.done" || !isRecord(event.item)) return event;
  if (event.item.type !== "compaction" || typeof event.item.id === "string") return event;

  const identity = JSON.stringify({
    responseId: event.response_id ?? null,
    outputIndex: event.output_index ?? null,
    encryptedContent: event.item.encrypted_content ?? null,
  });
  const id = `cmp_lilac_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
  return {
    ...event,
    output_index: typeof event.output_index === "number" ? event.output_index : 0,
    item: { ...event.item, id },
  };
}

export function createCodexResponsesEventNormalizer(): (
  event: Record<string, unknown>,
) => Record<string, unknown> {
  const summaries = new Map<string, string>();

  return (event) => {
    event = normalizeCodexCompactionItemId(event);
    const type = event.type;
    if (
      type === "response.done" ||
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed" ||
      type === "error"
    ) {
      summaries.clear();
      return type === "response.done" ? { ...event, type: "response.completed" } : event;
    }

    const key = codexReasoningSummaryKey(event);
    if (type === "response.reasoning_summary_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (key) summaries.set(key, `${summaries.get(key) ?? ""}${delta}`);
      return event;
    }

    if (type === "response.reasoning_summary_text.done") {
      const completed = typeof event.text === "string" ? event.text : "";
      const delta = completedSummaryDelta(key ? (summaries.get(key) ?? "") : "", completed);
      if (key) summaries.set(key, completed);
      return { ...event, type: "response.reasoning_summary_text.delta", delta };
    }

    // Codex can omit the reasoning output item state expected by @ai-sdk/openai.
    // Keep the parser alive while recovering any final text not already streamed.
    if (type === "response.reasoning_summary_part.done") {
      const part = isRecord(event.part) ? event.part : undefined;
      const completed =
        part?.type === "summary_text" && typeof part.text === "string" ? part.text : undefined;
      const delta =
        completed === undefined
          ? ""
          : completedSummaryDelta(key ? (summaries.get(key) ?? "") : "", completed);
      if (key && completed !== undefined) summaries.set(key, completed);
      return { ...event, type: "response.reasoning_summary_text.delta", delta };
    }

    return event;
  };
}

export type CreateCodexOAuthProviderOptions = {
  readTokens?: () => Promise<CodexOAuthTokens | null>;
  writeTokens?: (tokens: CodexOAuthTokens) => Promise<void>;
};

const CODEX_REFRESH_CALLER_ABORTED = Symbol("codex-refresh-caller-aborted");

type CapturedCodexRefreshFailure =
  | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  | { readonly kind: "defect"; readonly error: Error };
type CodexRefreshOutcome = { readonly kind: "success" } | CapturedCodexRefreshFailure;

function captureCodexRefreshFailure(restoreCause: () => unknown): CapturedCodexRefreshFailure {
  const cause = restoreCause();
  const panic = Result.try({
    try: () => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  if (panic) return { kind: "panic", panic };
  return {
    kind: "defect",
    error: cause instanceof Error ? cause : new Error("Codex OAuth token refresh failed"),
  };
}

async function waitForCodexRefresh(
  refresh: Promise<CodexRefreshOutcome>,
  signal: AbortSignal,
): Promise<CodexRefreshOutcome | typeof CODEX_REFRESH_CALLER_ABORTED> {
  if (signal.aborted) return CODEX_REFRESH_CALLER_ABORTED;
  let removeAbortListener = () => {};
  const aborted = new Promise<typeof CODEX_REFRESH_CALLER_ABORTED>((resolve) => {
    const onAbort = () => resolve(CODEX_REFRESH_CALLER_ABORTED);
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const outcome = await Promise.race([refresh, aborted]);
  removeAbortListener();
  return outcome;
}

export function createCodexOAuthProvider(options: CreateCodexOAuthProviderOptions = {}) {
  let refreshInFlight: Promise<CodexRefreshOutcome> | null = null;
  const readTokens = options.readTokens ?? readCodexTokens;
  const writeTokens = options.writeTokens ?? writeCodexTokens;
  const logger = createLogger({ module: "utils:model-provider" });
  const responsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: env.providers.codex.responsesTransport,
    url: "wss://chatgpt.com/backend-api/codex/responses",
    completionEventTypes: ["response.completed", "response.done"],
    createEventNormalizer: createCodexResponsesEventNormalizer,
    turnStateHeaderName: "x-codex-turn-state",
    onTransportSelected: (details) => {
      logger.debug("responses transport selected", { provider: "codex", ...details });
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
    fetch: withServerCompactionRequestFetch((async (requestInput, init) => {
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

      const refreshIfNeeded = async (): Promise<
        CodexRefreshOutcome | typeof CODEX_REFRESH_CALLER_ABORTED
      > => {
        if (auth && !shouldRefreshCodexOAuthTokens(auth)) return { kind: "success" };
        if (!refreshInFlight) {
          refreshInFlight = (async (): Promise<CodexRefreshOutcome> => {
            const captured = await Result.tryPromise({
              try: async () => {
                const latest = await readTokens();
                if (!latest) {
                  return {
                    kind: "defect" as const,
                    error: new Error(
                      "Codex OAuth not configured. Complete a Codex OAuth login to authenticate.",
                    ),
                  };
                }
                if (!shouldRefreshCodexOAuthTokens(latest)) {
                  auth = latest;
                  return { kind: "success" as const };
                }

                auth = await refreshCodexOAuthTokens(latest, { writeTokens });
                return { kind: "success" as const };
              },
              catch: (cause) => ({ restoreCause: () => cause }),
            });
            refreshInFlight = null;
            return captured.match<CodexRefreshOutcome>({
              ok: (outcome) => outcome,
              err: ({ restoreCause }) => captureCodexRefreshFailure(restoreCause),
            });
          })();
        }
        const activeRefresh = refreshInFlight;
        if (!activeRefresh) return { kind: "success" };
        const callerSignal = init?.signal ?? undefined;
        if (!callerSignal) {
          return activeRefresh;
        }
        return waitForCodexRefresh(activeRefresh, callerSignal);
      };

      if (shouldRefreshCodexOAuthTokens(auth, now)) {
        const refreshOutcome = await refreshIfNeeded();
        if (refreshOutcome === CODEX_REFRESH_CALLER_ABORTED) {
          throw init?.signal?.reason;
        }
        if (refreshOutcome.kind === "panic") throw refreshOutcome.panic;
        if (refreshOutcome.kind === "defect") throw refreshOutcome.error;
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
          const parsed = decodeCodexResponsesRequestBody(encoded);
          if (parsed) {
            body = JSON.stringify(normalizeCodexResponsesRequestRecord(parsed));
          }
        }
      }

      return codexFetch(url, { ...init, headers, body });
    }) as typeof globalThis.fetch),
  });
}

export function getModelProviders() {
  const logger = createLogger({
    module: "utils:model-provider",
  });

  const openaiResponsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: env.providers.openai.responsesTransport,
    onTransportSelected: (details) => {
      logger.debug("responses transport selected", {
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

  const openaiFetch = withServerCompactionRequestFetch(
    withLlmWireDebugFetch({
      provider: "openai",
      fetchFn: openaiResponsesFetch,
      warn: (message, details) => logger.warn(message, details),
    }),
  );

  const providers = {
    openai: env.providers.openai
      ? createOpenAI({
          baseURL: env.providers.openai.baseUrl,
          apiKey: env.providers.openai.apiKey,
          fetch: withOpenAIImageEditFilenamesFetch(openaiFetch),
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

    cerebras: createCerebras({
      apiKey: env.providers.cerebras.apiKey,
    }),
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
    "claude-code": createClaudeCode({
      defaultSettings: {
        ...claudeCodeExecutableSettings(),
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    }),
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
