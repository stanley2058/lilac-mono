import type { ModelMessage } from "ai";

import type { AiErrorLogDetails } from "./ai-error";

const MAX_ROLE_TRACE_CHARS = 2_000;
const MAX_WINDOW_MESSAGES = 32;
const TAIL_WINDOW_SIZE = 20;
const FAILING_INDEX_RADIUS = 4;
const MAX_INPUT_SHAPE_DEPTH = 3;
const MAX_INPUT_SHAPE_KEYS = 20;
const MAX_ANOMALIES = 32;

const MESSAGE_INDEX_RE = /\bmessages(?:\.|\[)(\d+)/giu;
const INPUT_INDEX_RE = /\binput(?:\.|\[)(\d+)/giu;

export const DEFAULT_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "edit_file",
  "apply_patch",
  "glob",
  "grep",
  "fuzzy_search",
  "subagent_delegate",
  "orchestrate",
  "job",
  "question",
  "model_catalog",
  "web_search",
  "web_fetch",
  "computer",
  "tool_search",
]);

// Map prevents Object.prototype lookups (e.g. "constructor", "toString").
const BUILTIN_TOOL_ARG_KEYS = new Map<string, ReadonlySet<string>>([
  [
    "bash",
    new Set([
      "command",
      "cwd",
      "timeoutMs",
      "timeout",
      "description",
      "runInBackground",
      "background",
      "label",
    ]),
  ],
  ["read", new Set(["path", "filePath", "offset", "limit", "startLine", "endLine", "pages"])],
  ["write", new Set(["path", "filePath", "content"])],
  ["edit", new Set(["path", "filePath", "oldString", "newString", "replaceAll", "edits"])],
  ["edit_file", new Set(["path", "filePath", "oldString", "newString", "replaceAll", "edits"])],
  ["apply_patch", new Set(["patch", "input", "cwd"])],
  ["glob", new Set(["pattern", "path", "cwd", "limit"])],
  ["grep", new Set(["pattern", "path", "cwd", "glob", "type", "limit", "caseSensitive"])],
  ["fuzzy_search", new Set(["query", "path", "cwd", "limit"])],
  [
    "subagent_delegate",
    new Set([
      "prompt",
      "task",
      "model",
      "reasoning",
      "permissions",
      "profile",
      "cwd",
      "label",
      "options",
      "mode",
    ]),
  ],
  [
    "orchestrate",
    new Set([
      "action",
      "id",
      "client",
      "scope",
      "query",
      "message",
      "mode",
      "model",
      "reasoning",
      "options",
      "before",
      "after",
      "limit",
      "view",
      "itemId",
      "textOffset",
      "commandId",
    ]),
  ],
  [
    "job",
    new Set([
      "action",
      "command",
      "cwd",
      "mode",
      "jobId",
      "timeoutMs",
      "offset",
      "limit",
      "tailBytes",
      "fromByte",
    ]),
  ],
  ["question", new Set(["action", "questions", "mode", "timeoutMs"])],
  ["model_catalog", new Set(["query", "model", "provider", "limit"])],
  ["web_search", new Set(["query", "limit", "domain"])],
  ["web_fetch", new Set(["url", "mode", "maxChars"])],
  ["computer", new Set(["action", "sessionId", "code", "timeoutMs"])],
  ["tool_search", new Set(["query", "names", "limit"])],
]);

// Closed allowlist of known provider-option namespaces and keys (matching provider-history.ts).
const ALLOWED_PROVIDER_OPTION_KEYS = new Map<string, ReadonlySet<string>>([
  [
    "anthropic",
    new Set([
      "cacheControl",
      "cache_control",
      "signature",
      "redactedData",
      "citations",
      "title",
      "context",
      "containerUpload",
      "clearAt",
      "effort",
      "toolChanges",
      "type",
      "toolName",
      "serverName",
      "toolsetName",
      "caller",
      "from",
      "to",
    ]),
  ],
  [
    "openai",
    new Set([
      "itemId",
      "phase",
      "reasoningEncryptedContent",
      "encryptedContent",
      "type",
      "imageDetail",
      "promptCacheBreakpoint",
      "namespace",
      "async",
      "caller",
      "reasoningEffortUpdate",
      "parallelToolCall",
      "approvalId",
      "toolSearchSeed",
      "toolSearchTools",
      "toolSearchCall",
    ]),
  ],
  ["google", new Set(["thoughtSignature", "thought", "serverToolCallId", "serverToolType"])],
  ["googleVertex", new Set(["thoughtSignature", "thought", "serverToolCallId", "serverToolType"])],
  ["vertex", new Set(["thoughtSignature", "thought", "serverToolCallId", "serverToolType"])],
  ["openrouter", new Set(["cacheControl", "cache_control", "reasoning", "provider"])],
  ["gateway", new Set(["cacheControl", "cache_control"])],
  ["openaiCompatible", new Set(["cacheControl", "cache_control"])],
  ["lilac", new Set(["generated", "kind", "turnId", "compaction", "skipReply", "synthetic"])],
]);

const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "codex",
  "google",
  "vertex",
  "openrouter",
  "vercel",
  "gateway",
  "xai",
  "groq",
  "cerebras",
  "openai-compatible",
  "typesafe",
  "claude-code",
  "azure",
  "custom",
]);

const ALLOWED_TRANSPORTS: ReadonlySet<string> = new Set([
  "ai-sdk",
  "openai-responses",
  "claude-code",
  "sse",
  "websocket",
  "auto",
]);

const ALLOWED_PROFILE_FAMILIES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "other",
]);

const ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  "wal-recovery",
  "compaction",
  "discord",
  "native",
  "github",
  "heartbeat",
  "unknown",
]);

const ALLOWED_CUSTOM_KINDS: ReadonlySet<string> = new Set([
  "anthropic.message_start",
  "anthropic.fallback",
  "anthropic.tool-reference",
  "openai.compaction",
]);

const ALLOWED_PHASES: ReadonlySet<string> = new Set(["commentary", "final_answer"]);

const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "video/mp4",
  "video/webm",
]);

const ALLOWED_PARAM_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "messages",
  "input",
  "content",
  "parts",
  "tools",
  "tool_use",
  "tool_result",
  "tool_call",
  "tool_calls",
  "function_call",
  "function_call_output",
  "call_id",
  "tool_use_id",
  "id",
  "name",
  "arguments",
  "role",
  "type",
  "thinking",
  "signature",
  "previous_response_id",
  "model",
]);

export type TranscriptErrorCategory =
  | "orphan_tool_call"
  | "orphan_tool_result"
  | "invalid_tool_call_id"
  | "invalid_tool_input"
  | "invalid_thinking_block"
  | "invalid_role_order"
  | "empty_content"
  | "previous_response_not_found"
  | "invalid_schema"
  | "invalid_request"
  | "unknown";

export type ToolCallIdShape = {
  readonly len: number;
  readonly prefix: string;
  readonly chars: string;
};

export type InputShapeNode =
  | string
  | {
      readonly kind: "array";
      readonly len: number;
      readonly item?: InputShapeNode;
    }
  | {
      readonly kind: "object";
      readonly keyCount: number;
      readonly keys?: Readonly<Record<string, InputShapeNode>>;
      readonly truncated?: boolean;
    };

export type ProviderOptionKeysMap = Readonly<Record<string, readonly string[]>>;

export type TranscriptPartShape = {
  readonly type: string;
  readonly len?: number;
  readonly empty?: boolean;
  readonly tool?: string;
  readonly callId?: string;
  readonly callIdShape?: ToolCallIdShape;
  readonly inputShape?: InputShapeNode;
  readonly providerExecuted?: boolean;
  readonly outputType?: string;
  readonly outputItemTypes?: readonly string[];
  readonly outputLen?: number;
  readonly isError?: boolean;
  readonly mediaType?: string;
  readonly dataKind?: string;
  readonly hasSignature?: boolean;
  readonly hasEncryptedContent?: boolean;
  readonly hasThoughtSignature?: boolean;
  readonly customKind?: string;
  readonly phase?: string;
  readonly providerOptions?: ProviderOptionKeysMap;
};

export type TranscriptMessageShape = {
  readonly i: number;
  readonly role: ModelMessage["role"];
  readonly contentKind: "string" | "array";
  readonly textLen?: number;
  readonly empty?: boolean;
  readonly providerOptions?: ProviderOptionKeysMap;
  readonly parts?: readonly TranscriptPartShape[];
};

export type TranscriptShapeTarget = {
  readonly provider?: string;
  readonly transport?: string;
  readonly profileFamily?: string;
  readonly routed?: boolean;
};

export type TranscriptShapeProvenance = {
  readonly source?: string;
  readonly compacted?: boolean;
  readonly didSwitchModel?: boolean;
  readonly step?: number;
  readonly sendKind?: "explicit" | "continuation" | "steer";
  readonly usedPreviousResponseId?: boolean;
  readonly sentItemCount?: number;
};

export type TranscriptShapeSnapshot = {
  readonly target: TranscriptShapeTarget;
  readonly provenance: TranscriptShapeProvenance;
  readonly totalMessages: number;
  readonly roleTrace: string;
  readonly anomalies: readonly string[];
  readonly errorCategory: TranscriptErrorCategory;
  readonly referencedMessageIndices?: readonly number[];
  readonly referencedInputIndices?: readonly number[];
  readonly referencedCallIds?: readonly string[];
  readonly referencedParamPath?: string;
  readonly preProjectionSummary?: {
    readonly totalMessages: number;
    readonly roleTrace: string;
  };
  readonly window: readonly TranscriptMessageShape[];
};

export type BuildTranscriptShapeInput = {
  readonly messages: readonly ModelMessage[];
  readonly preProjectionMessages?: readonly ModelMessage[];
  readonly target?: TranscriptShapeTarget;
  readonly provenance?: TranscriptShapeProvenance;
  readonly errorDetails?: AiErrorLogDetails;
  readonly rawErrorMessage?: string;
  readonly builtinTools?: ReadonlySet<string>;
  readonly hashExternalName: (domain: string, raw: string) => string;
};

function sanitizeTarget(raw: TranscriptShapeTarget | undefined): TranscriptShapeTarget {
  if (!raw) return {};
  let provider: string | undefined;
  if (raw.provider) {
    provider = ALLOWED_PROVIDERS.has(raw.provider) ? raw.provider : "custom";
  }
  const transport =
    raw.transport && ALLOWED_TRANSPORTS.has(raw.transport) ? raw.transport : undefined;
  const profileFamily =
    raw.profileFamily && ALLOWED_PROFILE_FAMILIES.has(raw.profileFamily)
      ? raw.profileFamily
      : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(transport ? { transport } : {}),
    ...(profileFamily ? { profileFamily } : {}),
    ...(raw.routed !== undefined ? { routed: raw.routed } : {}),
  };
}

function sanitizeProvenance(raw: TranscriptShapeProvenance | undefined): TranscriptShapeProvenance {
  if (!raw) return {};
  let source: string | undefined;
  if (raw.source) {
    source = ALLOWED_SOURCES.has(raw.source) ? raw.source : "unknown";
  }
  return {
    ...(source ? { source } : {}),
    ...(raw.compacted !== undefined ? { compacted: raw.compacted } : {}),
    ...(raw.didSwitchModel !== undefined ? { didSwitchModel: raw.didSwitchModel } : {}),
    ...(typeof raw.step === "number" && Number.isFinite(raw.step) ? { step: raw.step } : {}),
    ...(raw.sendKind ? { sendKind: raw.sendKind } : {}),
    ...(raw.usedPreviousResponseId !== undefined
      ? { usedPreviousResponseId: raw.usedPreviousResponseId }
      : {}),
    ...(typeof raw.sentItemCount === "number" && Number.isFinite(raw.sentItemCount)
      ? { sentItemCount: raw.sentItemCount }
      : {}),
  };
}

function sanitizeMediaType(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  const base = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_MEDIA_TYPES.has(base)) return base;
  if (base.startsWith("image/")) return "image/other";
  if (base.startsWith("audio/")) return "audio/other";
  if (base.startsWith("video/")) return "video/other";
  if (base.startsWith("text/")) return "text/other";
  return "other";
}

function sanitizeCustomKind(kind: string): string {
  return ALLOWED_CUSTOM_KINDS.has(kind) ? kind : "custom_other";
}

function sanitizePhase(phase: string | undefined): string | undefined {
  if (!phase) return undefined;
  return ALLOWED_PHASES.has(phase) ? phase : "other";
}

function sanitizeParamPath(rawParam: string | undefined): string | undefined {
  if (!rawParam) return undefined;
  const rawSegments = rawParam
    .replace(/\[(\d+)\]/gu, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (rawSegments.length === 0) return undefined;

  const safe: string[] = [];
  for (const segment of rawSegments.slice(0, 8)) {
    if (/^\d{1,5}$/u.test(segment)) {
      safe.push(segment);
      continue;
    }
    const lower = segment.toLowerCase();
    safe.push(ALLOWED_PARAM_PATH_SEGMENTS.has(lower) ? lower : "<field>");
  }
  return safe.join(".");
}

function classifyProviderErrorCategory(
  details: AiErrorLogDetails | undefined,
  rawMessage: string | undefined,
): TranscriptErrorCategory {
  const combined = `${details?.providerCode ?? ""} ${details?.providerType ?? ""} ${details?.providerMessage ?? ""} ${details?.aiErrorMessage ?? ""} ${rawMessage ?? ""}`;

  switch (true) {
    case /previous_response_not_found|previous_response_id/iu.test(combined):
      return "previous_response_not_found";
    case /no output found for (?:function|tool) call|tool_use.*without.*tool_result|missing.*tool_result/iu.test(
      combined,
    ):
      return "orphan_tool_call";
    case /unexpected.*tool_use_id|tool_result.*without.*tool_use|orphan.*tool_result|no tool call found for function call output/iu.test(
      combined,
    ):
      return "orphan_tool_result";
    case /tool_use\.id|call_id|tool_call_id.*(?:match|invalid|length|pattern)/iu.test(combined):
      return "invalid_tool_call_id";
    case /thinking|redacted_thinking|signature|thought_signature|reasoning.*encrypted/iu.test(
      combined,
    ):
      return "invalid_thinking_block";
    case /tool.*input|function.*arguments|input.*must be.*object|invalid json/iu.test(combined):
      return "invalid_tool_input";
    case /roles? must alternate|must start with|unexpected role|role.*order/iu.test(combined):
      return "invalid_role_order";
    case /empty.*content|non-empty|must contain at least one/iu.test(combined):
      return "empty_content";
    case /schema|validation|invalid_type|required property|additionalProperties|tool (?:parameters|output) must be/iu.test(
      combined,
    ):
      return "invalid_schema";
    case details?.providerType === "invalid_request_error" ||
      details?.providerType === "invalid_argument" ||
      details?.providerCode === "invalid_prompt" ||
      details?.statusCode === 400 ||
      details?.statusCode === 422:
      return "invalid_request";
    default:
      return "unknown";
  }
}

function classifyCallIdPrefix(id: string): string {
  if (id.length === 0) return "empty";
  if (id.startsWith("toolu_")) return "toolu_";
  if (id.startsWith("call_")) return "call_";
  if (id.startsWith("fc_")) return "fc_";
  if (id.startsWith("srvtoolu_")) return "srvtoolu_";
  if (id.startsWith("mcptoolu_")) return "mcptoolu_";
  const underscore = id.indexOf("_");
  if (underscore > 0 && underscore <= 8) return "prefixed";
  return "other";
}

function classifyCallIdChars(id: string): string {
  if (id.length === 0) return "empty";
  if (/^[A-Za-z0-9_-]+$/u.test(id)) return "alnum_dash_underscore";
  const flags: string[] = [];
  if (/\s/u.test(id)) flags.push("space");
  if (/:/u.test(id)) flags.push("colon");
  if (/\./u.test(id)) flags.push("dot");
  if (/\//u.test(id)) flags.push("slash");
  if (/[^\x20-\x7E]/u.test(id)) flags.push("non_ascii");
  if (flags.length === 0) flags.push("special");
  return flags.join("+");
}

function describeCallIdShape(id: string): ToolCallIdShape {
  return {
    len: id.length,
    prefix: classifyCallIdPrefix(id),
    chars: classifyCallIdChars(id),
  };
}

function extractProviderOptionKeys(
  options: ModelMessage["providerOptions"],
  hashExternalName: (domain: string, raw: string) => string,
): ProviderOptionKeysMap | undefined {
  if (!options) return undefined;
  const result: Record<string, readonly string[]> = {};
  let count = 0;
  for (const [namespace, value] of Object.entries(options)) {
    if (!value || typeof value !== "object") continue;
    const allowedKeys = ALLOWED_PROVIDER_OPTION_KEYS.get(namespace);
    const safeNamespace = allowedKeys
      ? namespace
      : `ns_${hashExternalName("ns", namespace).slice(0, 8)}`;
    const keys = Object.keys(value)
      .map((key) =>
        allowedKeys?.has(key)
          ? key
          : `k_${hashExternalName("opt", `${namespace}:${key}`).slice(0, 8)}`,
      )
      .sort();
    result[safeNamespace] = keys;
    count += 1;
  }
  return count > 0 ? result : undefined;
}

function readNamespaceString(
  options: ModelMessage["providerOptions"],
  namespace: string,
  key: string,
): string | undefined {
  const ns = options && Object.hasOwn(options, namespace) ? options[namespace] : undefined;
  if (!ns || typeof ns !== "object") return undefined;
  const val = Object.hasOwn(ns, key) ? ns[key] : undefined;
  return typeof val === "string" ? val : undefined;
}

function hasNamespaceNonEmptyString(
  options: ModelMessage["providerOptions"],
  namespace: string,
  key: string,
): boolean | undefined {
  const ns = options && Object.hasOwn(options, namespace) ? options[namespace] : undefined;
  if (!ns || typeof ns !== "object" || !Object.hasOwn(ns, key)) return undefined;
  const val = ns[key];
  return typeof val === "string" && val.length > 0;
}

function summarizeJsonValueShape(
  value: object | string | number | boolean | null | undefined,
  depth: number,
  allowedTopKeys: ReadonlySet<string> | undefined,
  hashExternalName: (domain: string, raw: string) => string,
): InputShapeNode {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) {
    if (depth >= MAX_INPUT_SHAPE_DEPTH || value.length === 0) {
      return { kind: "array", len: value.length };
    }
    const first = value[0] as object | string | number | boolean | null | undefined;
    return {
      kind: "array",
      len: value.length,
      item: summarizeJsonValueShape(first, depth + 1, undefined, hashExternalName),
    };
  }
  const entries = Object.entries(value);
  if (depth >= MAX_INPUT_SHAPE_DEPTH) {
    return { kind: "object", keyCount: entries.length };
  }
  const keys: Record<string, InputShapeNode> = {};
  const limit = Math.min(entries.length, MAX_INPUT_SHAPE_KEYS);
  for (let idx = 0; idx < limit; idx += 1) {
    const entry = entries[idx];
    if (!entry) continue;
    const [rawKey, nested] = entry;
    const keyName =
      depth === 0 && allowedTopKeys?.has(rawKey)
        ? rawKey
        : `k_${hashExternalName("arg", rawKey).slice(0, 8)}`;
    keys[keyName] = summarizeJsonValueShape(
      nested as object | string | number | boolean | null | undefined,
      depth + 1,
      undefined,
      hashExternalName,
    );
  }
  return {
    kind: "object",
    keyCount: entries.length,
    keys,
    ...(entries.length > MAX_INPUT_SHAPE_KEYS ? { truncated: true } : {}),
  };
}

function describeToolName(
  rawToolName: string,
  builtinTools: ReadonlySet<string>,
  hashExternalName: (domain: string, raw: string) => string,
  externalToolAliases: Map<string, string>,
): { readonly label: string; readonly allowedTopKeys?: ReadonlySet<string> } {
  if (builtinTools.has(rawToolName)) {
    return { label: rawToolName, allowedTopKeys: BUILTIN_TOOL_ARG_KEYS.get(rawToolName) };
  }
  const existing = externalToolAliases.get(rawToolName);
  if (existing) {
    return { label: existing };
  }
  const alias = `ext_${hashExternalName("tool", rawToolName).slice(0, 10)}`;
  externalToolAliases.set(rawToolName, alias);
  return { label: alias };
}

function aliasToolCallId(rawId: string, aliases: Map<string, string>): string {
  const existing = aliases.get(rawId);
  if (existing) return existing;
  const alias = `tc_${aliases.size + 1}`;
  aliases.set(rawId, alias);
  return alias;
}

function describeDataKind(data: object | string | number | boolean | null | undefined): {
  readonly dataKind: string;
  readonly len?: number;
} {
  if (data instanceof URL) return { dataKind: "url" };
  if (data instanceof Uint8Array) return { dataKind: "bytes", len: data.byteLength };
  if (typeof data === "string") {
    if (/^https?:\/\//iu.test(data)) return { dataKind: "url" };
    if (data.startsWith("data:")) return { dataKind: "data_url", len: data.length };
    return { dataKind: "string", len: data.length };
  }
  return { dataKind: typeof data };
}

type ToolResultOutputShape = {
  readonly outputType: string;
  readonly outputItemTypes?: readonly string[];
  readonly outputLen?: number;
  readonly isError?: boolean;
};

type ToolOutputPart = Extract<
  Exclude<
    Extract<ModelMessage, { role: "tool" }>["content"][number],
    { type: "tool-approval-response" }
  >,
  { type: "tool-result" }
>["output"];

function summarizeToolOutput(output: ToolOutputPart): ToolResultOutputShape {
  switch (output.type) {
    case "text":
      return { outputType: "text", outputLen: output.value.length, isError: false };
    case "error-text":
      return { outputType: "error-text", outputLen: output.value.length, isError: true };
    case "json":
      return { outputType: "json", isError: false };
    case "error-json":
      return { outputType: "error-json", isError: true };
    case "execution-denied":
      return { outputType: "execution-denied", isError: true };
    case "content": {
      const itemTypes: string[] = [];
      for (const item of output.value.slice(0, 20)) {
        if (item.type === "file") {
          itemTypes.push(`file:${sanitizeMediaType(item.mediaType) ?? "other"}`);
        } else if (item.type === "custom") {
          const nsKeys = Object.keys(item.providerOptions ?? {});
          const firstNs = nsKeys[0] ?? "";
          const safeNs = ALLOWED_PROVIDER_OPTION_KEYS.has(firstNs) ? firstNs : "other";
          itemTypes.push(`custom:${safeNs}`);
        } else {
          itemTypes.push(item.type);
        }
      }
      return {
        outputType: "content",
        outputItemTypes: itemTypes,
        isError: false,
      };
    }
  }
}

type MessagePartUnion =
  | Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number]
  | Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number]
  | Extract<ModelMessage, { role: "tool" }>["content"][number];

function summarizePart(
  part: MessagePartUnion,
  callIdAliases: Map<string, string>,
  externalToolAliases: Map<string, string>,
  builtinTools: ReadonlySet<string>,
  hashExternalName: (domain: string, raw: string) => string,
): { readonly shape: TranscriptPartShape; readonly traceToken: string } {
  const providerOptions =
    "providerOptions" in part
      ? extractProviderOptionKeys(part.providerOptions, hashExternalName)
      : undefined;
  const rawOptions = "providerOptions" in part ? part.providerOptions : undefined;

  switch (part.type) {
    case "text":
      return {
        shape: {
          type: "text",
          len: part.text.length,
          ...(part.text.length === 0 ? { empty: true } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: part.text.length === 0 ? "t0" : "t",
      };
    case "reasoning": {
      const hasSignature = hasNamespaceNonEmptyString(rawOptions, "anthropic", "signature");
      const hasEncryptedContent =
        hasNamespaceNonEmptyString(rawOptions, "openai", "reasoningEncryptedContent") ??
        hasNamespaceNonEmptyString(rawOptions, "openai", "encryptedContent");
      const hasThoughtSignature =
        hasNamespaceNonEmptyString(rawOptions, "google", "thoughtSignature") ??
        hasNamespaceNonEmptyString(rawOptions, "vertex", "thoughtSignature") ??
        hasNamespaceNonEmptyString(rawOptions, "googleVertex", "thoughtSignature");
      return {
        shape: {
          type: "reasoning",
          len: part.text.length,
          ...(part.text.length === 0 ? { empty: true } : {}),
          ...(hasSignature !== undefined ? { hasSignature } : {}),
          ...(hasEncryptedContent !== undefined ? { hasEncryptedContent } : {}),
          ...(hasThoughtSignature !== undefined ? { hasThoughtSignature } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: "r",
      };
    }
    case "tool-call": {
      const callId = aliasToolCallId(part.toolCallId, callIdAliases);
      const toolInfo = describeToolName(
        part.toolName,
        builtinTools,
        hashExternalName,
        externalToolAliases,
      );
      const inputShape = summarizeJsonValueShape(
        part.input as object | string | number | boolean | null | undefined,
        0,
        toolInfo.allowedTopKeys,
        hashExternalName,
      );
      const phase = sanitizePhase(readNamespaceString(rawOptions, "openai", "phase"));
      return {
        shape: {
          type: "tool-call",
          tool: toolInfo.label,
          callId,
          callIdShape: describeCallIdShape(part.toolCallId),
          inputShape,
          ...(part.providerExecuted !== undefined
            ? { providerExecuted: part.providerExecuted }
            : {}),
          ...(phase ? { phase } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: callId,
      };
    }
    case "tool-result": {
      const callId = aliasToolCallId(part.toolCallId, callIdAliases);
      const toolInfo = describeToolName(
        part.toolName,
        builtinTools,
        hashExternalName,
        externalToolAliases,
      );
      const outputSummary = summarizeToolOutput(part.output);
      return {
        shape: {
          type: "tool-result",
          tool: toolInfo.label,
          callId,
          callIdShape: describeCallIdShape(part.toolCallId),
          ...outputSummary,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: `tr_${callId.slice(3)}`,
      };
    }
    case "image": {
      const dataInfo = describeDataKind(
        part.image as object | string | number | boolean | null | undefined,
      );
      const mediaType = sanitizeMediaType(part.mediaType);
      return {
        shape: {
          type: "image",
          ...(mediaType ? { mediaType } : {}),
          ...dataInfo,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: "img",
      };
    }
    case "file": {
      const dataInfo = describeDataKind(
        part.data as object | string | number | boolean | null | undefined,
      );
      return {
        shape: {
          type: "file",
          mediaType: sanitizeMediaType(part.mediaType) ?? "other",
          ...dataInfo,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: "file",
      };
    }
    case "reasoning-file": {
      const dataInfo = describeDataKind(
        part.data as object | string | number | boolean | null | undefined,
      );
      return {
        shape: {
          type: "reasoning-file",
          mediaType: sanitizeMediaType(part.mediaType) ?? "other",
          ...dataInfo,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: "reasoning-file",
      };
    }
    case "tool-approval-request":
    case "tool-approval-response":
      return {
        shape: {
          type: part.type,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: part.type,
      };
    case "custom": {
      const customKind = sanitizeCustomKind(part.kind);
      return {
        shape: {
          type: "custom",
          customKind,
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: `c:${customKind}`,
      };
    }
    default:
      return {
        shape: {
          type: "other",
          ...(providerOptions ? { providerOptions } : {}),
        },
        traceToken: "other",
      };
  }
}

function truncateSingleRoleSegment(seg: string, budget: number): string {
  const openIdx = seg.indexOf("(");
  if (openIdx <= 0 || !seg.endsWith(")")) return "";
  const prefix = seg.slice(0, openIdx + 1);
  if (prefix.length + 1 > budget) return "";
  const tokens = seg.slice(openIdx + 1, -1).split(",");
  let inner = "";
  for (const tok of tokens) {
    const nextInner = inner.length === 0 ? tok : `${inner},${tok}`;
    if (prefix.length + nextInner.length + 1 > budget) break;
    inner = nextInner;
  }
  return `${prefix}${inner})`;
}

function buildBoundedRoleTrace(segments: readonly string[], maxChars: number): string {
  if (segments.length === 0) return "";
  let out = "";
  let truncated = false;
  const budget = maxChars - 3;

  for (const seg of segments) {
    const candidate = out.length === 0 ? seg : `${out},${seg}`;
    if (candidate.length <= maxChars) {
      out = candidate;
      continue;
    }
    truncated = true;
    if (out.length === 0) {
      out = truncateSingleRoleSegment(seg, budget);
    }
    break;
  }

  if (!truncated) return out;
  while (out.length > budget) {
    const lastSep = out.lastIndexOf("),");
    if (lastSep < 0) {
      out = truncateSingleRoleSegment(out, budget);
      break;
    }
    out = out.slice(0, lastSep + 1);
  }
  return out.length > 0 ? `${out}...` : "";
}

function summarizeMessageList(
  messages: readonly ModelMessage[],
  callIdAliases: Map<string, string>,
  externalToolAliases: Map<string, string>,
  builtinTools: ReadonlySet<string>,
  hashExternalName: (domain: string, raw: string) => string,
): { readonly shapes: readonly TranscriptMessageShape[]; readonly roleTrace: string } {
  const shapes: TranscriptMessageShape[] = [];
  const traceSegments: string[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    const roleShort = message.role[0] ?? "?";
    const providerOptions = extractProviderOptionKeys(message.providerOptions, hashExternalName);

    if (typeof message.content === "string") {
      shapes.push({
        i,
        role: message.role,
        contentKind: "string",
        textLen: message.content.length,
        ...(message.content.length === 0 ? { empty: true } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      });
      traceSegments.push(`${roleShort}(${message.content.length === 0 ? "s0" : "s"})`);
      continue;
    }

    const parts: TranscriptPartShape[] = [];
    const partTokens: string[] = [];
    for (const part of message.content) {
      const projected = summarizePart(
        part as MessagePartUnion,
        callIdAliases,
        externalToolAliases,
        builtinTools,
        hashExternalName,
      );
      parts.push(projected.shape);
      partTokens.push(projected.traceToken);
    }

    shapes.push({
      i,
      role: message.role,
      contentKind: "array",
      ...(parts.length === 0 ? { empty: true } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      parts,
    });
    traceSegments.push(`${roleShort}(${partTokens.join(",")})`);
  }

  return {
    shapes,
    roleTrace: buildBoundedRoleTrace(traceSegments, MAX_ROLE_TRACE_CHARS),
  };
}

function detectAnomalies(
  shapes: readonly TranscriptMessageShape[],
  targetFamily?: string,
): readonly string[] {
  const anomalies: string[] = [];
  const push = (entry: string): void => {
    if (anomalies.length < MAX_ANOMALIES) anomalies.push(entry);
  };

  const seenCallIds = new Map<string, number>();
  const resolvedCallIds = new Set<string>();
  let pendingCallIds = new Set<string>();

  for (let i = 0; i < shapes.length; i += 1) {
    const msg = shapes[i];
    if (!msg) continue;
    const prev = i > 0 ? shapes[i - 1] : undefined;

    if (prev && prev.role === msg.role && (msg.role === "assistant" || msg.role === "user")) {
      push(`consecutive_${msg.role}:${i - 1},${i}`);
    }

    if (msg.contentKind === "array" && (msg.parts?.length ?? 0) === 0) {
      push(`empty_content_array:msg=${i}`);
    }

    if (msg.role !== "tool" && pendingCallIds.size > 0) {
      for (const pending of pendingCallIds) {
        push(`unmatched_tool_call_before_${msg.role}:${pending}@msg=${i}`);
      }
      pendingCallIds = new Set<string>();
    }

    const parts = msg.parts ?? [];
    for (const part of parts) {
      if (part.type === "text" && part.empty) {
        push(`empty_text_part:msg=${i}`);
      }
      if (
        part.type === "reasoning" &&
        targetFamily === "anthropic" &&
        part.hasSignature === false
      ) {
        push(`missing_anthropic_signature:msg=${i}`);
      }
      if (part.type === "tool-call" && part.callId) {
        if (seenCallIds.has(part.callId)) {
          push(`duplicate_tool_call_id:${part.callId}@msg=${i}`);
        }
        seenCallIds.set(part.callId, i);
        if (part.providerExecuted !== true) {
          pendingCallIds.add(part.callId);
        }
        if (part.callIdShape && part.callIdShape.chars !== "alnum_dash_underscore") {
          push(`tool_call_id_chars:${part.callId}=${part.callIdShape.chars}`);
        }
        if (typeof part.inputShape === "string" || part.inputShape?.kind !== "object") {
          const kind =
            typeof part.inputShape === "string" ? part.inputShape : part.inputShape?.kind;
          push(`non_object_tool_input:${part.callId}=${kind ?? "unknown"}`);
        }
      }
      if (part.type === "tool-result" && part.callId) {
        resolvedCallIds.add(part.callId);
        if (!seenCallIds.has(part.callId)) {
          push(`orphan_tool_result:${part.callId}@msg=${i}`);
        } else if (msg.role === "tool" && !pendingCallIds.has(part.callId)) {
          push(`tool_result_not_immediately_after_call:${part.callId}@msg=${i}`);
        } else {
          pendingCallIds.delete(part.callId);
        }
      }
    }
  }

  for (const [callId, msgIndex] of seenCallIds) {
    if (!resolvedCallIds.has(callId)) {
      push(`orphan_tool_call:${callId}@msg=${msgIndex}`);
    }
  }

  return anomalies;
}

function extractReferencedCallIds(
  sources: readonly (string | undefined)[],
  callIdAliases: ReadonlyMap<string, string>,
): readonly string[] {
  const matched = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const [rawId, alias] of callIdAliases) {
      if (rawId.length >= 4 && source.includes(rawId)) {
        matched.add(alias);
      }
    }
  }
  return [...matched].slice(0, 16);
}

function parseIndices(
  sources: readonly (string | undefined)[],
  pattern: RegExp,
): readonly number[] {
  const indices = new Set<number>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed >= 0) {
        indices.add(parsed);
      }
    }
  }
  return [...indices].sort((a, b) => a - b).slice(0, 16);
}

function selectWindow(
  shapes: readonly TranscriptMessageShape[],
  failingMessageIndices: readonly number[],
): readonly TranscriptMessageShape[] {
  if (shapes.length <= MAX_WINDOW_MESSAGES) return shapes;
  const selected = new Set<number>();

  // Reserve slots for every explicitly referenced failing message index first.
  for (const center of failingMessageIndices) {
    if (selected.size >= MAX_WINDOW_MESSAGES) break;
    if (center >= 0 && center < shapes.length) selected.add(center);
  }

  // Add neighboring context around referenced indices while budget remains.
  for (const center of failingMessageIndices) {
    if (selected.size >= MAX_WINDOW_MESSAGES) break;
    const start = Math.max(0, center - FAILING_INDEX_RADIUS);
    const end = Math.min(shapes.length - 1, center + FAILING_INDEX_RADIUS);
    for (let i = start; i <= end; i += 1) {
      if (selected.size >= MAX_WINDOW_MESSAGES) break;
      selected.add(i);
    }
  }

  // Fill remaining slots from the tail backwards without evicting referenced indices.
  const tailFloor = Math.max(0, shapes.length - TAIL_WINDOW_SIZE);
  for (let i = shapes.length - 1; i >= tailFloor && selected.size < MAX_WINDOW_MESSAGES; i -= 1) {
    selected.add(i);
  }

  const sorted = [...selected].sort((a, b) => a - b);
  const window: TranscriptMessageShape[] = [];
  for (const index of sorted) {
    const item = shapes[index];
    if (item) window.push(item);
  }
  return window;
}

export function buildTranscriptShapeSnapshot(
  input: BuildTranscriptShapeInput,
): TranscriptShapeSnapshot {
  const builtinTools = input.builtinTools ?? DEFAULT_BUILTIN_TOOL_NAMES;
  const callIdAliases = new Map<string, string>();
  const externalToolAliases = new Map<string, string>();
  const target = sanitizeTarget(input.target);
  const provenance = sanitizeProvenance(input.provenance);

  const post = summarizeMessageList(
    input.messages,
    callIdAliases,
    externalToolAliases,
    builtinTools,
    input.hashExternalName,
  );

  let preProjectionSummary: TranscriptShapeSnapshot["preProjectionSummary"];
  if (input.preProjectionMessages) {
    const pre = summarizeMessageList(
      input.preProjectionMessages,
      callIdAliases,
      externalToolAliases,
      builtinTools,
      input.hashExternalName,
    );
    if (pre.shapes.length !== post.shapes.length || pre.roleTrace !== post.roleTrace) {
      preProjectionSummary = {
        totalMessages: pre.shapes.length,
        roleTrace: pre.roleTrace,
      };
    }
  }

  const errorSources = [
    input.errorDetails?.providerParam,
    input.errorDetails?.providerMessage,
    input.errorDetails?.aiErrorMessage,
    input.rawErrorMessage,
  ];
  // Only center the ModelMessage[] window on explicit `messages.<n>` indices; OpenAI Responses
  // `input.<n>` indices include system/multi-item expansions and are reported separately.
  const referencedMessageIndices = parseIndices(errorSources, MESSAGE_INDEX_RE);
  const referencedInputIndices = parseIndices(errorSources, INPUT_INDEX_RE);
  const referencedCallIds = extractReferencedCallIds(errorSources, callIdAliases);
  const referencedParamPath = sanitizeParamPath(input.errorDetails?.providerParam);
  const errorCategory = classifyProviderErrorCategory(input.errorDetails, input.rawErrorMessage);

  const anomalies = detectAnomalies(post.shapes, target.profileFamily);
  const window = selectWindow(post.shapes, referencedMessageIndices);

  return {
    target,
    provenance,
    totalMessages: post.shapes.length,
    roleTrace: post.roleTrace,
    anomalies,
    errorCategory,
    ...(referencedMessageIndices.length > 0 ? { referencedMessageIndices } : {}),
    ...(referencedInputIndices.length > 0 ? { referencedInputIndices } : {}),
    ...(referencedCallIds.length > 0 ? { referencedCallIds } : {}),
    ...(referencedParamPath ? { referencedParamPath } : {}),
    ...(preProjectionSummary ? { preProjectionSummary } : {}),
    window,
  };
}
