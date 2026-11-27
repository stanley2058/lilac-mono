// Normalize process.env before SDK imports initialize their default providers.
import { env, type ResponsesTransportMode } from "./env";
import { createHash } from "node:crypto";

import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { claudeCodeExecutableSettings } from "./claude-code-executable";
import { OAUTH_DUMMY_KEY } from "./codex-oauth";
import {
  createCodexOAuthAuthorization,
  type CodexOAuthAuthorizationOptions,
} from "./codex-provider-auth";
export { refreshCodexOAuthTokens, shouldRefreshCodexOAuthTokens } from "./codex-provider-auth";
export type { RefreshCodexOAuthTokensOptions } from "./codex-provider-auth";
import { createLogger } from "./logging";
import {
  configureOpenAICompatibleServers,
  getActiveOpenAICompatibleServers,
  type OpenAICompatibleServers,
} from "./openai-compatible-servers";
import { withOpenAIImageEditFilenamesFetch } from "./openai-image-edit-fetch";
import { createOpenAIResponsesWebSocketFetch } from "./openai-responses-websocket-fetch";
import { withLlmWireDebugFetch } from "./llm-wire-debug";
import { captureResultOutcome, isPanic, isRecord } from "./runtime-utils";
import { withServerCompactionRequestFetch } from "./server-compaction-request";
import type { OpenAICompatibleServerConfig } from "./core-config/types";

export { claudeCodeExecutableSettings } from "./claude-code-executable";
export { configureOpenAICompatibleServers, type OpenAICompatibleServers };

// Keep provider SDKs lazy so importing utils or unused providers does not load every SDK.
function loadCerebras(): typeof import("@ai-sdk/cerebras") {
  const mod: typeof import("@ai-sdk/cerebras") = require("@ai-sdk/cerebras");
  return mod;
}
function loadOpenAI(): typeof import("@ai-sdk/openai") {
  const mod: typeof import("@ai-sdk/openai") = require("@ai-sdk/openai");
  return mod;
}
function loadOpenAICompatible(): typeof import("@ai-sdk/openai-compatible") {
  const mod: typeof import("@ai-sdk/openai-compatible") = require("@ai-sdk/openai-compatible");
  return mod;
}
function loadXai(): typeof import("@ai-sdk/xai") {
  const mod: typeof import("@ai-sdk/xai") = require("@ai-sdk/xai");
  return mod;
}
function loadOpenRouter(): typeof import("@openrouter/ai-sdk-provider") {
  const mod: typeof import("@openrouter/ai-sdk-provider") = require("@openrouter/ai-sdk-provider");
  return mod;
}
function loadAnthropic(): typeof import("@ai-sdk/anthropic") {
  const mod: typeof import("@ai-sdk/anthropic") = require("@ai-sdk/anthropic");
  return mod;
}
function loadGroq(): typeof import("@ai-sdk/groq") {
  const mod: typeof import("@ai-sdk/groq") = require("@ai-sdk/groq");
  return mod;
}
function loadGoogle(): typeof import("@ai-sdk/google") {
  const mod: typeof import("@ai-sdk/google") = require("@ai-sdk/google");
  return mod;
}
function loadAi(): typeof import("ai") {
  const mod: typeof import("ai") = require("ai");
  return mod;
}
function loadClaudeSdk(): typeof import("./claude-sdk") {
  const mod: typeof import("./claude-sdk") = require("./claude-sdk");
  return mod;
}

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
  | "google"
  | "vercel"
  | (string & {});

const CODEX_RESPONSES_REQUEST_KEYS = new Set([
  "model",
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

export type CreateCodexOAuthProviderOptions = CodexOAuthAuthorizationOptions & {
  responsesTransport?: ResponsesTransportMode;
};

export function createCodexOAuthProvider(options: CreateCodexOAuthProviderOptions = {}) {
  const authorize = createCodexOAuthAuthorization(options);
  const logger = createLogger({ module: "utils:model-provider" });
  const responsesFetch = createOpenAIResponsesWebSocketFetch({
    mode: options.responsesTransport ?? env.providers.codex.responsesTransport,
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

  return loadOpenAI().createOpenAI({
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

      const authorization = await authorize(init?.signal ?? undefined);
      for (const [key, value] of Object.entries(authorization)) headers.set(key, value);

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

function createOpenAIProviderForTransport(mode: ResponsesTransportMode) {
  const logger = createLogger({
    module: "utils:model-provider",
  });

  const openaiResponsesFetch = createOpenAIResponsesWebSocketFetch({
    mode,
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

  return loadOpenAI().createOpenAI({
    baseURL: env.providers.openai.baseUrl,
    apiKey: env.providers.openai.apiKey,
    fetch: withOpenAIImageEditFilenamesFetch(openaiFetch),
  });
}

export function createOpenAIResponsesSseModelProvider() {
  return createOpenAIProviderForTransport("sse");
}

// Keyed by config object so clients for replaced config snapshots can be collected.
const openAICompatibleClients = new WeakMap<
  OpenAICompatibleServerConfig,
  OpenAICompatibleProvider
>();

function openAICompatibleServerClient(
  name: string,
  server: OpenAICompatibleServerConfig,
): OpenAICompatibleProvider {
  const cached = openAICompatibleClients.get(server);
  if (cached) return cached;
  const client = createOpenAICompatibleServer(name, server);
  openAICompatibleClients.set(server, client);
  return client;
}

function createOpenAICompatibleServer(
  name: string,
  server: OpenAICompatibleServerConfig,
): OpenAICompatibleProvider {
  const apiKey = server.apiKeyEnv ? process.env[server.apiKeyEnv]?.trim() : undefined;
  if (server.apiKeyEnv && !apiKey) {
    createLogger({ module: "utils:model-provider" }).warn(
      "openai-compatible server api key env var is not set",
      { server: name, apiKeyEnv: server.apiKeyEnv },
    );
  }
  return createOpenAICompatibleClient(server.baseUrl, apiKey || undefined);
}

function createOpenAICompatibleClient(baseURL: string, apiKey: string | undefined) {
  // Every server shares the `openaiCompatible` options namespace that rules and aliases target.
  return loadOpenAICompatible().createOpenAICompatible({
    name: "openaiCompatible",
    baseURL,
    apiKey,
    includeUsage: true,
  });
}

export type OpenAICompatibleRoute = { provider: OpenAICompatibleProvider; modelId: string };

export class OpenAICompatibleModelUnrouted extends TaggedError("OpenAICompatibleModelUnrouted")<{
  readonly modelId: string;
  readonly reason: "no-server" | "no-model";
  readonly message: string;
}> {}

export function routeOpenAICompatibleModel(
  modelId: string,
  servers: OpenAICompatibleServers = getActiveOpenAICompatibleServers(),
): ResultType<OpenAICompatibleRoute, OpenAICompatibleModelUnrouted> {
  const slash = modelId.indexOf("/");
  const name = slash > 0 ? modelId.slice(0, slash) : "";
  const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
  const serverModelId = modelId.slice(slash + 1);
  if (server && !serverModelId) {
    return Result.err(
      new OpenAICompatibleModelUnrouted({
        modelId,
        reason: "no-model",
        message: `'${modelId}' names OpenAI-compatible server '${name}' without a model`,
      }),
    );
  }
  if (server) {
    return Result.ok({
      provider: openAICompatibleServerClient(name, server),
      modelId: serverModelId,
    });
  }
  const legacy = providers["openai-compatible"];
  if (legacy) return Result.ok({ provider: legacy, modelId });
  return Result.err(
    new OpenAICompatibleModelUnrouted({
      modelId,
      reason: "no-server",
      message: `No OpenAI-compatible server for '${modelId}': name a server from models.providers.openaiCompatible or set OPENAI_COMPATIBLE_BASE_URL`,
    }),
  );
}

type BuiltinModelProviders = {
  openai: ReturnType<(typeof import("@ai-sdk/openai"))["createOpenAI"]> | null;
  "openai-compatible": OpenAICompatibleProvider | null;
  cerebras: ReturnType<(typeof import("@ai-sdk/cerebras"))["createCerebras"]>;
  codex: ReturnType<typeof createCodexOAuthProvider>;
  xai: ReturnType<(typeof import("@ai-sdk/xai"))["createXai"]> | null;
  anthropic: ReturnType<(typeof import("@ai-sdk/anthropic"))["createAnthropic"]> | null;
  "claude-code": ReturnType<(typeof import("./claude-sdk"))["createClaudeCode"]>;
  openrouter: ReturnType<(typeof import("@openrouter/ai-sdk-provider"))["createOpenRouter"]> | null;
  groq: ReturnType<(typeof import("@ai-sdk/groq"))["createGroq"]> | null;
  google: ReturnType<(typeof import("@ai-sdk/google"))["createGoogleGenerativeAI"]> | null;
  vercel: ReturnType<(typeof import("ai"))["createGateway"]> | null;
};

function lazySlot<T>(factory: () => T): { get: () => T; set: (next: T) => void } {
  let initialized = false;
  let value: T;
  return {
    get() {
      if (!initialized) {
        value = factory();
        initialized = true;
      }
      return value;
    },
    set(next: T) {
      value = next;
      initialized = true;
    },
  };
}

export function getModelProviders() {
  const openaiSlot = lazySlot(() =>
    env.providers.openai
      ? createOpenAIProviderForTransport(env.providers.openai.responsesTransport)
      : null,
  );
  const openaiCompatibleSlot = lazySlot(() =>
    env.providers.openaiCompatible.baseUrl
      ? createOpenAICompatibleClient(
          env.providers.openaiCompatible.baseUrl,
          env.providers.openaiCompatible.apiKey,
        )
      : null,
  );
  const cerebrasSlot = lazySlot(() =>
    loadCerebras().createCerebras({
      apiKey: env.providers.cerebras.apiKey,
    }),
  );
  const codexSlot = lazySlot(() => createCodexOAuthProvider());
  const xaiSlot = lazySlot(() =>
    env.providers.xai
      ? loadXai().createXai({
          baseURL: env.providers.xai.baseUrl,
          apiKey: env.providers.xai.apiKey,
        })
      : null,
  );
  const anthropicSlot = lazySlot(() =>
    env.providers.anthropic
      ? loadAnthropic().createAnthropic({
          baseURL: env.providers.anthropic.baseUrl,
          apiKey: env.providers.anthropic.apiKey,
        })
      : null,
  );
  const claudeCodeSlot = lazySlot(() =>
    loadClaudeSdk().createClaudeCode({
      defaultSettings: {
        ...claudeCodeExecutableSettings(),
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    }),
  );
  const openrouterSlot = lazySlot(() =>
    env.providers.openrouter
      ? loadOpenRouter().createOpenRouter({
          baseURL: env.providers.openrouter.baseUrl,
          apiKey: env.providers.openrouter.apiKey,
        })
      : null,
  );
  const groqSlot = lazySlot(() =>
    env.providers.groq
      ? loadGroq().createGroq({
          baseURL: env.providers.groq.baseUrl,
          apiKey: env.providers.groq.apiKey,
        })
      : null,
  );
  const googleSlot = lazySlot(() =>
    env.providers.google
      ? loadGoogle().createGoogleGenerativeAI({
          baseURL: env.providers.google.baseUrl,
          apiKey: env.providers.google.apiKey,
        })
      : null,
  );
  const vercelSlot = lazySlot(() =>
    env.providers.vercel
      ? loadAi().createGateway({
          baseURL: env.providers.vercel.baseUrl,
          apiKey: env.providers.vercel.apiKey,
        })
      : null,
  );

  const providers: BuiltinModelProviders = {
    get openai() {
      return openaiSlot.get();
    },
    set openai(next) {
      openaiSlot.set(next);
    },
    // Named servers live outside this table; resolve them with routeOpenAICompatibleModel.
    get "openai-compatible"() {
      return openaiCompatibleSlot.get();
    },
    set "openai-compatible"(next) {
      openaiCompatibleSlot.set(next);
    },
    get cerebras() {
      return cerebrasSlot.get();
    },
    set cerebras(next) {
      cerebrasSlot.set(next);
    },
    get codex() {
      return codexSlot.get();
    },
    set codex(next) {
      codexSlot.set(next);
    },
    get xai() {
      return xaiSlot.get();
    },
    set xai(next) {
      xaiSlot.set(next);
    },
    get anthropic() {
      return anthropicSlot.get();
    },
    set anthropic(next) {
      anthropicSlot.set(next);
    },
    get "claude-code"() {
      return claudeCodeSlot.get();
    },
    set "claude-code"(next) {
      claudeCodeSlot.set(next);
    },
    get openrouter() {
      return openrouterSlot.get();
    },
    set openrouter(next) {
      openrouterSlot.set(next);
    },
    get groq() {
      return groqSlot.get();
    },
    set groq(next) {
      groqSlot.set(next);
    },
    get google() {
      return googleSlot.get();
    },
    set google(next) {
      googleSlot.set(next);
    },
    get vercel() {
      return vercelSlot.get();
    },
    set vercel(next) {
      vercelSlot.set(next);
    },
  };
  return providers as BuiltinModelProviders & Record<string, OpenAICompatibleProvider>;
}

export const providers = getModelProviders();
