/* oxlint-disable eslint/no-control-regex */

import {
  asSchema,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolContent,
  type ToolSet,
} from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  discoverSkills,
  env,
  findWorkspaceRoot,
  formatAvailableSkillsSection,
  getCoreConfig,
  ModelCapability,
  resolveEditingToolMode,
  type JSONObject,
  resolveLogLevel,
  resolveModelRef,
  resolveModelSlot,
} from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
  type RequestLifecycleState,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import {
  AiSdkPiAgent,
  attachAutoCompaction,
  type AiSdkPiAgentEvent,
  type TransformMessagesFn,
} from "@stanley2058/lilac-agent";

import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

import { Logger } from "@stanley2058/simple-module-logger";

import { applyPatchTool } from "../../tools/apply-patch";
import { bashToolWithCwd } from "../../tools/bash";
import { batchTool } from "../../tools/batch";
import { fsTool } from "../../tools/fs/fs";
import { subagentTools } from "../../tools/subagent";
import { formatToolArgsForDisplay } from "../../tools/tool-args-display";

import type { TranscriptStore } from "../../transcript/transcript-store";
import { buildSafeRecoveryCheckpoint } from "./recovery-checkpoint";
import { resolveReplyDeliveryFromFinalText } from "./reply-directive";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function formatInt(n: number): string {
  // Locale-independent grouping.
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatSeconds(ms: number): string {
  const sec = ms / 1000;
  return `${sec.toFixed(1)}s`;
}

function sanitizeFilenameToken(raw: string): string {
  // Keep names mostly readable for humans (diff workflows) while preventing
  // directory traversal or weird control chars.
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "_")
    .replace(/[\\/]/g, "_")
    .slice(0, 200);
}

function debugJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof URL) return v.toString();
      if (v instanceof Error) {
        return {
          name: v.name,
          message: v.message,
          stack: v.stack,
        };
      }

      // Bun/Node Buffers are Uint8Array. Preserve byte identity as base64.
      if (v instanceof Uint8Array) {
        return {
          __type: "Uint8Array",
          base64: Buffer.from(v).toString("base64"),
          byteLength: v.byteLength,
        };
      }

      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }

      return v;
    },
    2,
  );
}

type ToolsLike = Record<string, { description?: string; inputSchema?: unknown }>;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value === undefined) return "undefined";
  try {
    const s = JSON.stringify(value);
    return s ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildResumePrompt(partialText: string): ModelMessage {
  const base =
    "System notice: the server restarted during your previous turn. Continue from the last stable boundary. If a tool was interrupted, treat it as failed with error: server restarted, and proceed safely.";
  const content =
    partialText.trim().length > 0
      ? `${base}\n\nPartial response already shown to user:\n\n${partialText}\n\nContinue from there without duplicating already visible text.`
      : `${base}\n\nNo visible partial response was persisted.`;

  return {
    role: "user",
    content,
  };
}

// OpenCode-style tool output pruning:
// - Keep full tool call/result structure for forkability.
// - Compact *old* tool results (replace output with a placeholder) only in the
//   model-facing view, right before sending.
// - Track compacted toolCallIds in-memory per session for stability (cache hits).
const TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";
const TOOL_OUTPUT_CHARS_PER_TOKEN = 4;
const TOOL_OUTPUT_PRUNE_PROTECT_TOKENS = 40_000;
const TOOL_OUTPUT_PRUNE_MINIMUM_TOKENS = 20_000;
const TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS = new Set(["skill"]);

const MODEL_VIEW_MAX_BINARY_BYTES_PER_PART = 256 * 1024;
const MODEL_VIEW_MAX_BINARY_BYTES_TOTAL = 2 * 1024 * 1024;
const MODEL_VIEW_BINARY_OMITTED = "[binary omitted]";

const ANTHROPIC_PROMPT_CACHE_CONTROL = {
  type: "ephemeral",
  ttl: "5m",
} as const;

const ANTHROPIC_UPSTREAM_PROVIDER_ORDER = ["anthropic", "vertex", "bedrock"] as const;

const ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS = {
  anthropic: { cacheControl: ANTHROPIC_PROMPT_CACHE_CONTROL },
  openrouter: { cacheControl: ANTHROPIC_PROMPT_CACHE_CONTROL },
} as const satisfies NonNullable<ModelMessage["providerOptions"]>;

function isAnthropicModelSpec(spec: string): boolean {
  // Canonical format is provider/model. For gateway-style specs, Claude models
  // typically appear as */anthropic/claude-... .
  return spec.startsWith("anthropic/") || spec.includes("/anthropic/");
}

function mergeProviderOptions(
  base: ModelMessage["providerOptions"],
  patch: NonNullable<ModelMessage["providerOptions"]>,
): NonNullable<ModelMessage["providerOptions"]> {
  const out = (isRecord(base) ? { ...base } : {}) as NonNullable<ModelMessage["providerOptions"]>;

  for (const [k, v] of Object.entries(patch)) {
    const existing = (out as Record<string, unknown>)[k];
    (out as Record<string, unknown>)[k] = isRecord(existing) ? { ...existing, ...v } : v;
  }

  return out;
}

function withProviderOptionsOnLastUserMessage(
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

function withStableAnthropicUpstreamOrder(
  provider: string,
  providerOptions: { [x: string]: JSONObject } | undefined,
): { [x: string]: JSONObject } | undefined {
  const base = providerOptions ?? {};

  if (provider === "vercel") {
    const existingGateway = isRecord(base["gateway"]) ? base["gateway"] : {};
    return {
      ...base,
      gateway: {
        ...existingGateway,
        order: [...ANTHROPIC_UPSTREAM_PROVIDER_ORDER],
      },
    };
  }

  if (provider === "openrouter") {
    const existingOpenRouter = isRecord(base["openrouter"]) ? base["openrouter"] : {};
    const existingProvider = isRecord(existingOpenRouter["provider"])
      ? existingOpenRouter["provider"]
      : {};

    return {
      ...base,
      openrouter: {
        ...existingOpenRouter,
        provider: {
          ...existingProvider,
          order: [...ANTHROPIC_UPSTREAM_PROVIDER_ORDER],
        },
      },
    };
  }

  return providerOptions;
}

function isOpenAIBackedModel(provider: string, modelId: string): boolean {
  if (provider === "openai" || provider === "codex") return true;
  return modelId.startsWith("openai/");
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
  const existingOpenAI = isRecord(base["openai"]) ? base["openai"] : {};

  if ("reasoningSummary" in existingOpenAI) {
    return params.providerOptions;
  }

  return {
    ...base,
    openai: {
      ...existingOpenAI,
      reasoningSummary: "detailed",
    },
  };
}

function estimateTokensFromValue(value: unknown): number {
  // Best-effort token estimate (OpenCode uses chars/4).
  const chars = safeStringify(value).length;
  return Math.max(0, Math.round(chars / TOOL_OUTPUT_CHARS_PER_TOKEN));
}

function maybeMarkOldToolOutputsCompacted(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: Set<string>;
}): boolean {
  let turns = 0;
  let total = 0;
  let pruned = 0;
  const toCompact = new Set<string>();

  // Walk backwards; skip the last turn (turn = user message).
  // This mirrors OpenCode's "turns < 2" behavior.
  outer: for (let msgIndex = params.messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = params.messages[msgIndex]!;
    if (msg.role === "user") turns++;
    if (turns < 2) continue;

    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.content[partIndex];
      if (part?.type !== "tool-result") continue;

      const toolName = part.toolName;
      if (toolName && TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS.has(toolName)) continue;
      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;

      // Once we reach already-compacted results, stop. Older ones should already be compacted.
      if (params.compactedToolCallIds.has(toolCallId)) break outer;

      const output = part.output;
      const estimate = estimateTokensFromValue(output);
      total += estimate;

      if (total > TOOL_OUTPUT_PRUNE_PROTECT_TOKENS) {
        pruned += estimate;
        toCompact.add(toolCallId);
      }
    }
  }

  if (pruned <= TOOL_OUTPUT_PRUNE_MINIMUM_TOKENS) return false;

  let changed = false;
  for (const id of toCompact) {
    if (params.compactedToolCallIds.has(id)) continue;
    params.compactedToolCallIds.add(id);
    changed = true;
  }
  return changed;
}

function applyToolOutputCompactionView(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: ReadonlySet<string>;
}): ModelMessage[] {
  let changed = false;

  const out = params.messages.map((m) => {
    if (m.role !== "tool") return m;
    if (!Array.isArray(m.content)) return m;

    let nextContent: ToolContent | null = null;

    for (let i = 0; i < m.content.length; i++) {
      const part = m.content[i];
      if (part?.type !== "tool-result") continue;

      const toolCallId = part.toolCallId;
      if (!toolCallId) continue;
      if (!params.compactedToolCallIds.has(toolCallId)) continue;

      nextContent ??= m.content.map((p) => ({ ...p }));

      const nextPart = nextContent?.[i];
      if (nextPart?.type !== "tool-result") continue;

      nextPart["output"] = { type: "text", value: TOOL_OUTPUT_PLACEHOLDER };
      changed = true;
    }

    if (!nextContent) return m;
    return {
      ...m,
      content: nextContent,
    } satisfies ModelMessage;
  });

  return changed ? out : [...params.messages];
}

function scrubLargeBinaryForModelView(messages: readonly ModelMessage[]): ModelMessage[] {
  let totalBytes = 0;

  const estimateBase64Bytes = (b64: string): number => {
    // Approximate decoded bytes; good enough for bounding.
    const len = b64.length;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((len * 3) / 4) - padding;
    return Math.max(0, bytes);
  };

  const out: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    let nextContent: ToolContent | null = null;

    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (part?.type !== "tool-result") continue;

      const output = part.output;
      const outputType = output.type;
      if (outputType !== "content") continue;

      const rawValue = output["value"];
      if (!Array.isArray(rawValue)) continue;

      const value = rawValue;
      let nextValue: typeof rawValue | null = null;

      for (let j = 0; j < value.length; j++) {
        const item = value[j];
        if (!isRecord(item)) continue;

        const t = item.type;
        if (t !== "image-data" && t !== "file-data") continue;

        const data = item.data;
        if (typeof data !== "string") continue;

        const bytes = estimateBase64Bytes(data);
        const tooBig = bytes > MODEL_VIEW_MAX_BINARY_BYTES_PER_PART;
        const tooMuch = totalBytes + bytes > MODEL_VIEW_MAX_BINARY_BYTES_TOTAL;
        if (!tooBig && !tooMuch) {
          totalBytes += bytes;
          continue;
        }

        nextValue ??= value.map((v) => ({ ...v }));

        const mediaType =
          "mediaType" in item && typeof item.mediaType === "string" ? item.mediaType : "";
        const filename =
          "filename" in item && typeof item.filename === "string" ? item.filename : "";
        const detail =
          filename || mediaType ? ` (${[filename, mediaType].filter(Boolean).join(", ")})` : "";

        nextValue[j] = {
          type: "text",
          text: `${MODEL_VIEW_BINARY_OMITTED}${detail}`,
        };
      }

      if (!nextValue) continue;

      nextContent ??= msg.content.map((p) => ({ ...p }));
      const nextPart = nextContent[i];
      if (nextPart?.type !== "tool-result") continue;

      const nextOutput = {
        ...output,
        value: nextValue,
      };
      nextPart["output"] = nextOutput;
    }

    if (!nextContent) {
      out.push(msg);
      continue;
    }

    out.push({ ...msg, content: nextContent });
  }

  return out;
}

function getBatchOkFromResult(result: unknown): boolean | null {
  if (!isRecord(result)) return null;
  const v = result["ok"];
  return typeof v === "boolean" ? v : null;
}

function getSubagentOkFromResult(result: unknown): boolean | null {
  if (!isRecord(result)) return null;
  const v = result["ok"];
  return typeof v === "boolean" ? v : null;
}

function getToolDefsText(tools: ToolsLike | null): string {
  if (!tools) return "";
  const entries = Object.entries(tools);
  if (entries.length === 0) return "";

  const toolDesc = entries.map(([name, tool]) => {
    let jsonSchema: unknown = {};
    try {
      jsonSchema = asSchema(tool?.inputSchema as never).jsonSchema;
    } catch {
      jsonSchema = {};
    }
    return {
      name,
      description: tool?.description ?? "",
      jsonSchema,
    };
  });

  return JSON.stringify(toolDesc);
}

function isAssistantToolCallMessage(message: ModelMessage): boolean {
  if (message.role !== "assistant") return false;
  if (!Array.isArray(message.content)) return false;

  return message.content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return part.type === "tool-call";
  });
}

function countCharsInMessage(
  message: ModelMessage,
): Omit<InputCompositionChars, "toolDefsChars" | "callCount"> {
  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  const role = message.role;

  if (role === "tool") {
    toolResultChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "system") {
    systemChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "user") {
    userChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (role === "assistant") {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const t = part.type;
        if (t === "tool-result") {
          toolResultChars += safeStringify(part).length;
          continue;
        }
        assistantChars += safeStringify(part).length;
      }
      return { systemChars, assistantChars, userChars, toolResultChars };
    }

    assistantChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  // Unreachable with the current ModelMessage type; keep a conservative fallback.
  return { systemChars, assistantChars, userChars, toolResultChars };
}

type InputCompositionChars = {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
  callCount: number;
};

function buildPromptSnapshots(params: {
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
}): ModelMessage[][] {
  const snapshots: ModelMessage[][] = [];
  const state: ModelMessage[] = [...params.initialMessages];
  snapshots.push([...state]);

  for (let i = 0; i < params.responseMessages.length; i++) {
    const msg = params.responseMessages[i];
    if (!msg) continue;

    if (isAssistantToolCallMessage(msg)) {
      state.push(msg);

      // In tool mode, tool results come in as `role: "tool"` messages.
      let j = i + 1;
      while (j < params.responseMessages.length) {
        const next = params.responseMessages[j];
        if (!next || next.role !== "tool") break;
        state.push(next);
        j++;
      }

      snapshots.push([...state]);
      i = j - 1;
      continue;
    }

    state.push(msg);
  }

  return snapshots;
}

function estimateInputCompositionChars(input: {
  system: string;
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
}): InputCompositionChars {
  const tools = (
    input.tools && typeof input.tools === "object" ? (input.tools as ToolsLike) : null
  ) satisfies ToolsLike | null;

  const snapshots = buildPromptSnapshots({
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
  });

  const toolDefsText = getToolDefsText(tools);
  const perCallToolDefsChars = toolDefsText.length;
  const perCallSystemChars = input.system.length;

  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  for (const snapshot of snapshots) {
    // AI SDK sends the system prompt per model call (separate from `messages`).
    systemChars += perCallSystemChars;

    for (const message of snapshot) {
      const counts = countCharsInMessage(message);
      systemChars += counts.systemChars;
      assistantChars += counts.assistantChars;
      userChars += counts.userChars;
      toolResultChars += counts.toolResultChars;
    }
  }

  return {
    systemChars,
    assistantChars,
    userChars,
    toolDefsChars: perCallToolDefsChars * snapshots.length,
    toolResultChars,
    callCount: snapshots.length,
  };
}

function computePercentages(chars: {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
}): { S: number; A: number; U: number; TD: number; TR: number } | null {
  const entries = [
    ["S", chars.systemChars],
    ["A", chars.assistantChars],
    ["U", chars.userChars],
    ["TD", chars.toolDefsChars],
    ["TR", chars.toolResultChars],
  ] as const;

  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  if (total <= 0) return null;

  const raw = entries.map(([k, v]) => {
    const pct = Math.round((v * 100) / total);
    return { k, v, pct };
  });

  let sum = raw.reduce((acc, e) => acc + e.pct, 0);
  const diff = 100 - sum;
  if (diff !== 0) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i]!.v > raw[maxIdx]!.v) maxIdx = i;
    }
    raw[maxIdx]!.pct += diff;
    sum += diff;
  }

  const map = Object.fromEntries(raw.map((e) => [e.k, Math.max(0, Math.min(100, e.pct))])) as {
    S: number;
    A: number;
    U: number;
    TD: number;
    TR: number;
  };

  return map;
}

function systemPromptToText(system: unknown): string {
  if (typeof system === "string") return system;

  if (Array.isArray(system)) {
    return system
      .map((m) => systemPromptToText(m))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }

  if (!isRecord(system)) return safeStringify(system);

  const content = system["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(safeStringify).join("");
  return safeStringify(content);
}

function buildInputCompositionLine(input: {
  system: string;
  initialMessages: ModelMessage[];
  responseMessages: ModelMessage[];
  tools: unknown;
}): string | null {
  const chars = estimateInputCompositionChars({
    system: input.system,
    initialMessages: input.initialMessages,
    responseMessages: input.responseMessages,
    tools: input.tools,
  });

  const pct = computePercentages(chars);
  if (!pct) return null;

  return `[IC] S: ${pct.S}%; A: ${pct.A}%; U: ${pct.U}%; TD: ${pct.TD}%; TR: ${pct.TR}%`;
}

type StatsForNerdsOptions = {
  enabled: boolean;
  verbose: boolean;
};

function getStatsForNerdsOptions(
  statsForNerds: CoreConfig["agent"]["statsForNerds"] | undefined,
): StatsForNerdsOptions {
  if (statsForNerds === true) {
    return { enabled: true, verbose: false };
  }

  if (statsForNerds && typeof statsForNerds === "object") {
    return { enabled: true, verbose: statsForNerds.verbose === true };
  }

  return { enabled: false, verbose: false };
}

function buildStatsLine(params: {
  modelLabel: string;
  usage: LanguageModelUsage | undefined;
  ttftMs: number | null;
  tps: number | null;
  icLine: string | null;
}): string {
  const u = params.usage;

  const inputTokens = typeof u?.inputTokens === "number" ? u.inputTokens : null;
  const outputTokens = typeof u?.outputTokens === "number" ? u.outputTokens : null;
  const noCache =
    typeof u?.inputTokenDetails?.noCacheTokens === "number"
      ? u.inputTokenDetails.noCacheTokens
      : null;

  const outputReasoning =
    typeof u?.outputTokenDetails?.reasoningTokens === "number"
      ? u.outputTokenDetails.reasoningTokens
      : null;

  const parts: string[] = [];
  parts.push(`[M]: ${params.modelLabel}`);

  if (inputTokens !== null || outputTokens !== null) {
    const tokenParts: string[] = [];
    if (inputTokens !== null) {
      tokenParts.push(
        `↑${formatInt(inputTokens)}${noCache !== null ? ` (NC: ${formatInt(noCache)})` : ""}`,
      );
    }
    if (outputTokens !== null) {
      tokenParts.push(
        `↓${formatInt(outputTokens)}${outputReasoning !== null ? ` (R: ${formatInt(outputReasoning)})` : ""}`,
      );
    }
    parts.push(`[T]: ${tokenParts.join(" ")}`);
  }

  if (params.ttftMs !== null) {
    parts.push(`[TTFT]: ${formatSeconds(params.ttftMs)}`);
  }

  if (params.tps !== null) {
    parts.push(`[TPS]: ${params.tps.toFixed(1)}`);
  }

  if (params.icLine) {
    parts.push(params.icLine);
  }

  return `*${parts.join("; ")}*`;
}

type Enqueued = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  messages: ModelMessage[];
  modelOverride?: string;
  raw?: unknown;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
};

export type AgentRunnerRecoveryEntry = {
  kind: "active" | "queued";
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  messages: ModelMessage[];
  modelOverride?: string;
  raw?: unknown;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
  };
};

class RestartDrainingAbort extends Error {
  constructor() {
    super("server restarting");
    this.name = "RestartDrainingAbort";
  }
}

function parseRouterSessionModeFromRaw(raw: unknown): "mention" | "active" | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>)["sessionMode"];
  if (v === "mention" || v === "active") return v;
  return null;
}

function parseSessionConfigIdFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["sessionConfigId"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRequestModelOverrideFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["modelOverride"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRequestControlFromRaw(raw: unknown): {
  requiresActive: boolean;
  cancel: boolean;
  cancelQueued: boolean;
  targetMessageId: string | null;
} {
  if (!raw || typeof raw !== "object") {
    return {
      requiresActive: false,
      cancel: false,
      cancelQueued: false,
      targetMessageId: null,
    };
  }

  const record = raw as Record<string, unknown>;
  return {
    requiresActive: record["requiresActive"] === true,
    cancel: record["cancel"] === true,
    cancelQueued: record["cancelQueued"] === true,
    targetMessageId: typeof record["messageId"] === "string" ? record["messageId"] : null,
  };
}

function getChainMessageIdsFromRaw(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== "object") return [];
  const value = (raw as Record<string, unknown>)["chainMessageIds"];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

function requestRawReferencesMessage(raw: unknown, messageId: string): boolean {
  return getChainMessageIdsFromRaw(raw).includes(messageId);
}

const SUBAGENT_PROFILES = ["explore", "general", "self"] as const;

type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];
type AgentRunProfile = "primary" | SubagentProfile;

type ParsedSubagentMeta = {
  profile: AgentRunProfile;
  depth: number;
};

type SubagentConfig = NonNullable<CoreConfig["agent"]["subagents"]>;

const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  enabled: true,
  maxDepth: 2,
  defaultTimeoutMs: 3 * 60 * 1000,
  maxTimeoutMs: 8 * 60 * 1000,
  profiles: {
    explore: {
      modelSlot: "main",
    },
    general: {
      modelSlot: "main",
    },
    self: {
      modelSlot: "main",
    },
  },
};

function isSubagentProfile(value: unknown): value is SubagentProfile {
  return typeof value === "string" && (SUBAGENT_PROFILES as readonly string[]).includes(value);
}

function parseSubagentMetaFromRaw(raw: unknown): ParsedSubagentMeta {
  if (!raw || typeof raw !== "object") {
    return { profile: "primary", depth: 0 };
  }

  const subagent = (raw as Record<string, unknown>)["subagent"];
  if (!subagent || typeof subagent !== "object") {
    return { profile: "primary", depth: 0 };
  }

  const o = subagent as Record<string, unknown>;

  const rawProfile = o["profile"];
  const profile: AgentRunProfile = isSubagentProfile(rawProfile) ? rawProfile : "primary";

  const depthRaw = o["depth"];
  const defaultDepth = profile === "primary" ? 0 : 1;
  const depth =
    typeof depthRaw === "number" && Number.isFinite(depthRaw)
      ? Math.max(0, Math.trunc(depthRaw))
      : defaultDepth;

  return { profile, depth };
}

function buildExploreOverlay(extra?: string): string {
  const lines = [
    "You are running in explore subagent mode.",
    "Focus on repository exploration and evidence-backed findings.",
    "Prefer high-parallel search/read using glob, grep, read_file, and batch.",
    "Do not use bash.",
    "Do not edit files.",
    "Do not delegate to another subagent.",
  ];

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildGeneralOverlay(extra?: string): string {
  const lines = [
    "You are running in general subagent mode.",
    "Focus on completing the delegated task end-to-end.",
    "Use available tools directly, including edits and bash when needed.",
    "Prefer parallel tool usage when calls are independent.",
    "Do not delegate to another subagent.",
  ];

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildSelfOverlay(extra?: string): string {
  if (extra && extra.trim().length > 0) {
    return extra.trim();
  }
  return "";
}

function buildOverlayForProfile(params: {
  profile: SubagentProfile;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
}): string {
  if (params.profile === "general") {
    return buildGeneralOverlay(params.generalOverlay);
  }
  if (params.profile === "self") {
    return buildSelfOverlay(params.selfOverlay);
  }
  return buildExploreOverlay(params.exploreOverlay);
}

function subagentModeTitle(profile: SubagentProfile): string {
  if (profile === "general") return "General";
  if (profile === "self") return "Self";
  return "Explore";
}

function buildSystemPromptForProfile(params: {
  baseSystemPrompt: string;
  profile: AgentRunProfile;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
  skillsSection?: string | null;
  activeEditingTool?: "apply_patch" | "edit_file" | null;
}): string {
  if (params.profile === "primary") {
    const parts = [params.baseSystemPrompt];
    if (params.skillsSection && params.skillsSection.trim().length > 0) {
      parts.push(params.skillsSection.trim());
    }
    return parts.join("\n\n");
  }

  const baseParts = [params.baseSystemPrompt];
  if (params.skillsSection && params.skillsSection.trim().length > 0) {
    baseParts.push(params.skillsSection.trim());
  }

  const overlay = buildOverlayForProfile({
    profile: params.profile,
    exploreOverlay: params.exploreOverlay,
    generalOverlay: params.generalOverlay,
    selfOverlay: params.selfOverlay,
  });

  if (overlay.trim().length === 0) {
    return baseParts.join("\n\n");
  }

  return [...baseParts, "", `## Subagent Mode: ${subagentModeTitle(params.profile)}`, overlay].join(
    "\n",
  );
}

export type SessionAdditionalPromptWarning = {
  reason: "invalid_file_url" | "read_failed";
  value: string;
  filePath?: string;
  error: string;
};

export async function resolveSessionAdditionalPrompts(params: {
  entries: readonly string[] | undefined;
  readFileText?: (filePath: string) => Promise<string>;
  onWarn?: (warning: SessionAdditionalPromptWarning) => void;
}): Promise<string[]> {
  const readFileText = params.readFileText ?? ((filePath: string) => Bun.file(filePath).text());
  const out: string[] = [];

  for (const value of params.entries ?? []) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;

    if (!trimmed.startsWith("file://")) {
      out.push(trimmed);
      continue;
    }

    let filePath: string;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "file:") {
        throw new Error(`unsupported protocol '${url.protocol}'`);
      }
      filePath = fileURLToPath(url);
    } catch (e) {
      params.onWarn?.({
        reason: "invalid_file_url",
        value,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    try {
      const content = (await readFileText(filePath)).trim();
      const filename = path.basename(filePath) || filePath;
      out.push(`# ${filename} (${filePath})\n${content.length > 0 ? content : "(empty)"}`);
    } catch (e) {
      params.onWarn?.({
        reason: "read_failed",
        value,
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}

export function appendAdditionalSessionMemoBlock(
  baseSystemPrompt: string,
  prompts: readonly string[],
): string {
  const combined = prompts.join("\n\n").trim();
  if (combined.length === 0) {
    return baseSystemPrompt;
  }

  const base = baseSystemPrompt.trimEnd();
  if (base.length === 0) {
    return `Additional Session Memo:\n${combined}`;
  }

  return `${base}\n\nAdditional Session Memo:\n${combined}`;
}

async function maybeBuildSkillsSectionForPrimary(): Promise<string | null> {
  try {
    const workspaceRoot = findWorkspaceRoot();
    const { skills } = await discoverSkills({
      workspaceRoot,
      dataDir: env.dataDir,
    });
    return formatAvailableSkillsSection(skills);
  } catch {
    // Best-effort: never fail a run due to skill discovery.
    return null;
  }
}

type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
  activeRun: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    queue: RequestQueueMode;
    modelOverride?: string;
    raw?: unknown;
    partialText: string;
  } | null;
  /** Track toolCallIds whose outputs are compacted in the model-facing view. */
  compactedToolCallIds: Set<string>;
};

export async function startBusAgentRunner(params: {
  bus: LilacBus;
  subscriptionId: string;
  config?: CoreConfig;
  /** Where core tools operate (fs tool root). */
  cwd?: string;
  transcriptStore?: TranscriptStore;
}) {
  const { bus, subscriptionId } = params;

  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "bus-agent-runner",
  });

  let cfg = params.config ?? (await getCoreConfig());
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    try {
      cfg = await getCoreConfig();

      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", {
          path: "core-config.yaml",
        });
      }

      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== msg) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: msg,
        });
      }

      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = msg;
    }
  }
  const cwd = params.cwd ?? process.env.LILAC_WORKSPACE_DIR ?? process.cwd();

  const bySession = new Map<string, SessionQueue>();
  const cancelledByRequestId = new Set<string>();
  const restartAbortRequestIds = new Set<string>();
  const forcedRecoveryByRequestId = new Map<string, AgentRunnerRecoveryEntry>();
  let draining = false;

  const sub = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "work",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "begin" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client ?? "unknown";
      if (!requestId || !sessionId) {
        throw new Error("cmd.request.message missing required headers.request_id/session_id");
      }

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          (shouldWarn ? logger.warn : logger.info)("perf.bus_lag", {
            stage: "cmd.request->agent_runner",
            lagMs,
            requestId,
            sessionId,
            requestClient,
            queue: msg.data.queue,
          });
        }
      }

      logger.info("cmd.request.message received", {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        modelOverride: msg.data.modelOverride,
        messageCount: msg.data.messages.length,
      });

      // reload config opportunistically (mtime cached in getCoreConfig).
      // If reload fails, keep using the last known good config.
      await reloadCoreConfigIfNeeded();

      const entry: Enqueued = {
        requestId,
        sessionId,
        requestClient,
        queue: msg.data.queue,
        messages: msg.data.messages,
        modelOverride: msg.data.modelOverride,
        raw: msg.data.raw,
      };

      const requestControl = parseRequestControlFromRaw(entry.raw);

      if (draining) {
        logger.info("dropping request message while draining", {
          requestId,
          sessionId,
          queue: msg.data.queue,
        });
        await ctx.commit();
        return;
      }

      const state =
        bySession.get(sessionId) ??
        ({
          running: false,
          agent: null,
          queue: [] as Enqueued[],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        } satisfies SessionQueue);
      bySession.set(sessionId, state);

      const dropCancelNoTarget = async (reason: string) => {
        logger.info("dropping cancel request with no target", {
          requestId,
          sessionId,
          queue: entry.queue,
          activeRequestId: state.activeRequestId,
          reason,
        });
        await ctx.commit();
      };

      if (requestControl.cancel && requestControl.cancelQueued) {
        const removed = new Map<string, AdapterPlatform>();

        const removedByRequestId = removeQueuedEntries(
          state.queue,
          (queued) => queued.requestId === requestId,
        );
        for (const queued of removedByRequestId) {
          removed.set(queued.requestId, queued.requestClient);
        }

        const targetMessageId = requestControl.targetMessageId;
        if (targetMessageId) {
          const removedByMessage = removeQueuedEntries(state.queue, (queued) =>
            requestRawReferencesMessage(queued.raw, targetMessageId),
          );
          for (const queued of removedByMessage) {
            removed.set(queued.requestId, queued.requestClient);
          }
        }

        if (removed.size > 0) {
          for (const [cancelledRequestId, cancelledRequestClient] of removed) {
            await publishLifecycle({
              bus,
              headers: {
                request_id: cancelledRequestId,
                session_id: sessionId,
                request_client: cancelledRequestClient,
              },
              state: "cancelled",
              detail: "cancelled while queued",
            });
          }

          logger.info("queued request cancelled", {
            requestId,
            sessionId,
            cancelledRequestIds: [...removed.keys()],
            queueDepth: state.queue.length,
          });

          if (!state.running) {
            drainSessionQueue(sessionId, state).catch((e: unknown) => {
              logger.error("drainSessionQueue failed", { sessionId, requestId }, e);
            });
          }

          await ctx.commit();
          return;
        }

        const targetMessageIdForActive = requestControl.targetMessageId;
        const targetMatchesActive =
          typeof targetMessageIdForActive === "string" &&
          requestRawReferencesMessage(state.activeRun?.raw, targetMessageIdForActive);

        if (!state.running || !state.activeRequestId || !state.agent) {
          await dropCancelNoTarget("request not queued or active");
          return;
        }

        if (state.activeRequestId === requestId || targetMatchesActive) {
          const activeCancelEntry: Enqueued = {
            ...entry,
            requestId: state.activeRequestId,
            requestClient: state.activeRun?.requestClient ?? entry.requestClient,
          };
          await applyToRunningAgent(state.agent, activeCancelEntry, cancelledByRequestId);
          await ctx.commit();
          return;
        }

        await dropCancelNoTarget("request not queued or active");
        return;
      }

      if (!state.running) {
        if (requestControl.cancel) {
          await dropCancelNoTarget("request not active");
          return;
        }

        // Some messages only make sense when a run is already active.
        if (requestControl.requiresActive && entry.queue !== "prompt") {
          logger.info("dropping request message (requires active run)", {
            requestId,
            sessionId,
            queue: entry.queue,
          });
          await ctx.commit();
          return;
        }

        state.queue.push(entry);
        drainSessionQueue(sessionId, state).catch((e: unknown) => {
          logger.error("drainSessionQueue failed", { sessionId, requestId }, e);
        });
      } else {
        // If the message is intended for the currently active request, apply immediately.
        if (state.activeRequestId && state.activeRequestId === requestId && state.agent) {
          await applyToRunningAgent(state.agent, entry, cancelledByRequestId);
        } else {
          // Prevent stale surface controls (e.g. Cancel button) from enqueueing behind
          // an unrelated active request.
          if (requestControl.requiresActive || requestControl.cancel) {
            logger.info("dropping request message (requires active request id)", {
              requestId,
              sessionId,
              activeRequestId: state.activeRequestId,
              queue: entry.queue,
            });
            await ctx.commit();
            return;
          }

          // No parallel runs: queue prompt messages for later.
          state.queue.push(entry);

          await publishLifecycle({
            bus,
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
            state: "queued",
            detail: "queued behind active request",
          });

          logger.info("request queued behind active run", {
            requestId,
            sessionId,
            activeRequestId: state.activeRequestId,
            queueDepth: state.queue.length,
          });
        }
      }

      await ctx.commit();
    },
  );

  let subscriptionStopped = false;
  const stopSubscription = async () => {
    if (subscriptionStopped) return;
    subscriptionStopped = true;
    await sub.stop();
  };

  function buildActiveRecoveryEntry(state: SessionQueue): AgentRunnerRecoveryEntry | null {
    if (!state.running || !state.agent || !state.activeRun) return null;

    const checkpointMessages = buildSafeRecoveryCheckpoint(
      state.agent.state.messages,
      "server restarted",
    );

    return {
      kind: "active",
      requestId: state.activeRun.requestId,
      sessionId: state.activeRun.sessionId,
      requestClient: state.activeRun.requestClient,
      queue: "prompt",
      messages: [],
      ...(state.activeRun.modelOverride ? { modelOverride: state.activeRun.modelOverride } : {}),
      raw: state.activeRun.raw,
      recovery: {
        checkpointMessages,
        partialText: state.activeRun.partialText,
      },
    };
  }

  async function beginDrain(opts?: { deadlineMs?: number }) {
    draining = true;
    await stopSubscription();

    const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
    const startedAt = Date.now();

    const hasRunning = () => [...bySession.values()].some((s) => s.running);

    while (hasRunning() && Date.now() - startedAt < deadlineMs) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!hasRunning()) return;

    for (const state of bySession.values()) {
      if (!state.running || !state.agent || !state.activeRun) continue;

      const recovery = buildActiveRecoveryEntry(state);
      if (recovery) {
        forcedRecoveryByRequestId.set(recovery.requestId, recovery);
        restartAbortRequestIds.add(recovery.requestId);
      }

      state.agent.abort();
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  function snapshotRecoverables(): AgentRunnerRecoveryEntry[] {
    const out: AgentRunnerRecoveryEntry[] = [];
    const seenActive = new Set<string>();

    for (const forced of forcedRecoveryByRequestId.values()) {
      out.push(forced);
      seenActive.add(forced.requestId);
    }

    for (const state of bySession.values()) {
      const active = buildActiveRecoveryEntry(state);
      if (active && !seenActive.has(active.requestId)) {
        out.push(active);
        seenActive.add(active.requestId);
      }

      for (const queued of state.queue) {
        out.push({
          kind: "queued",
          requestId: queued.requestId,
          sessionId: queued.sessionId,
          requestClient: queued.requestClient,
          queue: queued.queue,
          messages: queued.messages,
          ...(queued.modelOverride ? { modelOverride: queued.modelOverride } : {}),
          raw: queued.raw,
        });
      }
    }

    return out;
  }

  function restoreRecoverables(entries: readonly AgentRunnerRecoveryEntry[]) {
    if (entries.length === 0) return;

    for (const entry of entries) {
      const state =
        bySession.get(entry.sessionId) ??
        ({
          running: false,
          agent: null,
          queue: [] as Enqueued[],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        } satisfies SessionQueue);
      bySession.set(entry.sessionId, state);

      state.queue.push({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        requestClient: entry.requestClient,
        queue: entry.queue,
        messages: entry.messages,
        modelOverride: entry.modelOverride,
        raw: entry.raw,
        recovery: entry.recovery,
      });

      if (!state.running) {
        drainSessionQueue(entry.sessionId, state).catch((e: unknown) => {
          logger.error("drainSessionQueue failed", { sessionId: entry.sessionId }, e);
        });
      }
    }
  }

  async function drainSessionQueue(sessionId: string, state: SessionQueue) {
    if (state.running) return;

    const next = state.queue.shift();
    if (!next) return;

    state.running = true;
    state.activeRequestId = next.requestId;
    state.activeRun = {
      requestId: next.requestId,
      sessionId: next.sessionId,
      requestClient: next.requestClient,
      queue: next.queue,
      modelOverride: next.modelOverride,
      raw: next.raw,
      partialText: next.recovery?.partialText ?? "",
    };

    const runStartedAt = Date.now();

    const subagentMeta = parseSubagentMetaFromRaw(next.raw);
    const runProfile = subagentMeta.profile;
    const subagents = cfg.agent.subagents ?? DEFAULT_SUBAGENT_CONFIG;

    const routerSessionMode = parseRouterSessionModeFromRaw(next.raw);

    const headers = {
      request_id: next.requestId,
      session_id: next.sessionId,
      request_client: next.requestClient,
      ...(routerSessionMode ? { router_session_mode: routerSessionMode } : {}),
    };

    let initialMessages: ModelMessage[] = [];
    let responseStartIndex = 0;
    const runStats: {
      totalUsage?: LanguageModelUsage;
      finalMessages?: ModelMessage[];
      firstTextDeltaAt?: number;
      lastTurnFinishReason?: FinishReason;
      lastTurnEndAt?: number;
    } = {};

    let resolvedModelLabel = "unknown";
    let activeAgent: AiSdkPiAgent<ToolSet> | null = null;
    let unsubscribe = () => {};
    let unsubscribeCompaction = () => {};

    try {
      const maxSubagentDepth = subagents.maxDepth;
      if (subagentMeta.depth > maxSubagentDepth) {
        const detail = `subagent depth ${subagentMeta.depth} exceeds maxDepth=${maxSubagentDepth}`;
        await publishLifecycle({
          bus,
          headers,
          state: "failed",
          detail,
        });
        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          { finalText: `Error: ${detail}` },
          { headers },
        );
        return;
      }

      await publishLifecycle({
        bus,
        headers,
        state: "running",
        detail: next.recovery
          ? "resumed after server restart"
          : next.queue !== "prompt"
            ? `coerced queue=${next.queue} to prompt (no active run)`
            : undefined,
      });
      await bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers });

      const subagentProfileConfig =
        runProfile === "primary" ? null : subagents.profiles[runProfile];

      const requestModelOverride =
        runProfile === "primary"
          ? (next.modelOverride ?? parseRequestModelOverrideFromRaw(next.raw) ?? undefined)
          : undefined;

      const resolved = requestModelOverride
        ? resolveModelRef(
            cfg,
            {
              model: requestModelOverride,
            },
            "cmd.request.message.modelOverride",
          )
        : subagentProfileConfig?.model
          ? resolveModelRef(
              cfg,
              {
                model: subagentProfileConfig.model,
                options: subagentProfileConfig.options,
              },
              `agent.subagents.profiles.${runProfile}.model`,
            )
          : resolveModelSlot(cfg, subagentProfileConfig?.modelSlot ?? "main");
      resolvedModelLabel = resolved.modelId;
      const editingToolMode = resolveEditingToolMode({
        provider: resolved.provider,
        modelId: resolved.modelId,
      });

      const anthropicPromptCachingEnabled = isAnthropicModelSpec(resolved.spec);

      // Improve prompt caching stability by providing a session-scoped cache key.
      // This helps when many requests share a large common prefix (e.g. a long system prompt).
      // Also, when reasoning display is enabled, request detailed reasoning summaries
      // for OpenAI-backed models (including gateway/openrouter openai/* model IDs).
      const providerOptionsWithReasoningSummary = withReasoningSummaryDefaultForOpenAIModels({
        reasoningDisplay: cfg.agent.reasoningDisplay,
        provider: resolved.provider,
        modelId: resolved.modelId,
        providerOptions: resolved.providerOptions,
      });

      // Prompt cache key only applies for direct OpenAI/Codex providers.
      const providerOptionsWithPromptCacheKey = (() => {
        const provider = resolved.provider;
        const supports = provider === "openai" || provider === "codex";
        if (!supports) return providerOptionsWithReasoningSummary;

        const base = providerOptionsWithReasoningSummary ?? {};
        const existingOpenAI = (base["openai"] ?? {}) as Record<string, unknown>;

        return {
          ...base,
          openai: {
            ...existingOpenAI,
            promptCacheKey: sessionId,
          },
        };
      })();

      const providerOptionsForAgent = anthropicPromptCachingEnabled
        ? withStableAnthropicUpstreamOrder(resolved.provider, providerOptionsWithPromptCacheKey)
        : providerOptionsWithPromptCacheKey;

      const baseSystemPrompt = buildSystemPromptForProfile({
        baseSystemPrompt: cfg.agent.systemPrompt,
        profile: runProfile,
        activeEditingTool: runProfile === "explore" ? null : editingToolMode,
        exploreOverlay: subagents.profiles.explore.promptOverlay,
        generalOverlay: subagents.profiles.general.promptOverlay,
        selfOverlay: subagents.profiles.self.promptOverlay,
        skillsSection: runProfile === "explore" ? null : await maybeBuildSkillsSectionForPrimary(),
      });

      const sessionConfigId = parseSessionConfigIdFromRaw(next.raw) ?? sessionId;

      const additionalSessionPrompts = await resolveSessionAdditionalPrompts({
        entries: cfg.surface.router.sessionModes[sessionConfigId]?.additionalPrompts,
        onWarn: (warning) => {
          logger.warn("skipping invalid session additionalPrompts entry", {
            requestId: next.requestId,
            sessionId,
            sessionConfigId,
            reason: warning.reason,
            value: warning.value,
            filePath: warning.filePath,
            error: warning.error,
          });
        },
      });

      const systemPrompt = appendAdditionalSessionMemoBlock(
        baseSystemPrompt,
        additionalSessionPrompts,
      );

      const agentSystem = anthropicPromptCachingEnabled
        ? {
            role: "system" as const,
            content: systemPrompt,
            providerOptions: ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
          }
        : systemPrompt;

      logger.info("agent run starting", {
        requestId: next.requestId,
        sessionId: next.sessionId,
        requestClient: next.requestClient,
        runProfile,
        subagentDepth: subagentMeta.depth,
        sessionConfigId,
        requestModelOverride,
        model: resolved.spec,
        editingToolMode: runProfile === "explore" ? "none" : editingToolMode,
        isRecoveryResume: Boolean(next.recovery),
        messageCount: next.messages.length,
        recoveryCheckpointMessageCount: next.recovery?.checkpointMessages.length ?? 0,
        queuedForSession: state.queue.length,
      });

      const tools: ToolSet = {} as ToolSet;
      if (runProfile === "explore") {
        Object.assign(tools, fsTool(cwd));
      } else {
        Object.assign(
          tools,
          bashToolWithCwd(cwd),
          fsTool(cwd, {
            includeEditFile: editingToolMode === "edit_file",
          }),
        );
        if (editingToolMode === "apply_patch") {
          Object.assign(tools, applyPatchTool({ cwd }));
        }

        if (subagents.enabled && subagentMeta.depth < subagents.maxDepth) {
          Object.assign(
            tools,
            subagentTools({
              bus,
              defaultTimeoutMs: subagents.defaultTimeoutMs,
              maxTimeoutMs: subagents.maxTimeoutMs,
              maxDepth: subagents.maxDepth,
            }),
          );
        }
      }

      Object.assign(
        tools,
        batchTool({
          defaultCwd: cwd,
          getTools: () => tools,
          editingMode: runProfile === "explore" ? "none" : editingToolMode,
          reportToolStatus: (update) => {
            bus
              .publish(lilacEventTypes.EvtAgentOutputToolCall, update, {
                headers,
              })
              .catch((e: unknown) => {
                logger.error(
                  "failed to publish batch tool status",
                  {
                    requestId: headers.request_id,
                    sessionId: headers.session_id,
                    toolCallId: update.toolCallId,
                  },
                  e,
                );
              });
          },
        }),
      );

      const agent = new AiSdkPiAgent<ToolSet>({
        system: agentSystem,
        model: resolved.model,
        modelSpecifier: resolved.spec,
        messages: next.recovery?.checkpointMessages ?? [],
        tools,
        providerOptions: providerOptionsForAgent,
        debug: {
          captureModelViewMessages: env.debug.contextDump.enabled,
        },
      });
      activeAgent = agent;

      agent.setContext({
        sessionId: next.sessionId,
        requestId: next.requestId,
        requestClient: next.requestClient,
        subagentDepth: subagentMeta.depth,
        subagentProfile: runProfile,
      });

      // Drain all buffered messages at boundaries (better UX in chat surfaces).
      agent.setFollowUpMode("all");
      agent.setSteeringMode("all");

      const toolPruneTransform: TransformMessagesFn = async (messages) => {
        // First, remove pathological binary blobs from the *model-facing* view.
        const scrubbed = scrubLargeBinaryForModelView(messages);

        // Then, compact older tool outputs (placeholder) with session-stable state.
        maybeMarkOldToolOutputsCompacted({
          messages: scrubbed,
          compactedToolCallIds: state.compactedToolCallIds,
        });

        const compacted = applyToolOutputCompactionView({
          messages: scrubbed,
          compactedToolCallIds: state.compactedToolCallIds,
        });

        if (!anthropicPromptCachingEnabled) return compacted;
        return withProviderOptionsOnLastUserMessage(
          compacted,
          ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS,
        );
      };

      unsubscribeCompaction = await attachAutoCompaction(agent, {
        model: resolved.spec,
        modelCapability: new ModelCapability(),
        resolveCurrentModelSpecifier: () => agent.state.modelSpecifier ?? resolved.spec,
        baseTransformMessages: toolPruneTransform,
        onUnknownCapability: ({ spec, reason, error }) => {
          logger.warn(
            "auto-compaction capability unknown; disabling threshold compaction",
            {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              modelSpec: spec,
              reason,
            },
            error,
          );
        },
        onOverflowRecoveryAttempt: ({ spec, attempt, maxAttempts }) => {
          logger.info("auto-compaction overflow recovery retry", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            modelSpec: spec,
            attempt,
            maxAttempts,
          });
        },
        onOverflowRecoveryExhausted: ({ spec, attempts, maxAttempts }) => {
          logger.warn("auto-compaction overflow recovery exhausted", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            modelSpec: spec,
            attempts,
            maxAttempts,
          });
        },
      });

      state.agent = agent;

      let finalText = "";
      const reasoningChunkById = new Map<string, string>();
      let reasoningChunkSeq = 0;

      const toolStartMs = new Map<string, number>();

      const contextDumpEnabled = env.debug.contextDump.enabled;
      const contextDumpDir = env.debug.contextDump.dir;
      let turnEndCount = 0;

      const dumpContextAfterTurn = async (
        event: Extract<AiSdkPiAgentEvent<ToolSet>, { type: "turn_end" }>,
      ) => {
        if (!contextDumpEnabled) return;

        const tsMs = Date.now();
        const safeSessionId = sanitizeFilenameToken(headers.session_id);
        const safeRequestId = sanitizeFilenameToken(headers.request_id);
        const fileName = `${safeSessionId}-${safeRequestId}-${tsMs}.json`;
        const filePath = path.join(contextDumpDir, fileName);

        const modelView = agent.state.debug?.lastModelViewMessages;
        const modelViewTurn = agent.state.debug?.lastModelViewTurn;

        const payload = {
          meta: {
            tsMs,
            ts: new Date(tsMs).toISOString(),
            sessionId: headers.session_id,
            requestId: headers.request_id,
            requestClient: headers.request_client,
            runProfile,
            subagentDepth: subagentMeta.depth,
            modelSpec: resolved.spec,
            modelId: resolved.modelId,
            turnEndIndex: turnEndCount,
            modelViewTurn,
          },
          system: agent.state.system,
          providerOptions: agent.state.providerOptions,
          tools: {
            names: Object.keys(agent.state.tools ?? {}),
          },
          usage: {
            lastTurn: event.usage,
            lastTurnTotal: event.totalUsage,
          },
          transcript: {
            messages: agent.state.messages,
          },
          modelViewMessagesForTurn: modelView,
        };

        try {
          await fs.mkdir(contextDumpDir, { recursive: true });
          await fs.writeFile(filePath, debugJsonStringify(payload), "utf8");
          logger.debug("context dump wrote", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            filePath,
          });
        } catch (e: unknown) {
          logger.warn(
            "context dump failed",
            {
              requestId: headers.request_id,
              sessionId: headers.session_id,
              filePath,
            },
            e,
          );
        }
      };

      unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
        if (event.type === "agent_end") {
          runStats.totalUsage = event.totalUsage;
          runStats.finalMessages = event.messages;
        }

        if (event.type === "turn_end") {
          turnEndCount++;
          runStats.lastTurnFinishReason = event.finishReason;
          runStats.lastTurnEndAt = Date.now();

          // Fire-and-forget debug dump; do not block the run.
          void dumpContextAfterTurn(event);
        }

        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          runStats.firstTextDeltaAt ??= Date.now();

          const delta = event.assistantMessageEvent.delta;
          finalText += delta;
          if (state.activeRun && state.activeRun.requestId === next.requestId) {
            state.activeRun.partialText += delta;
          }

          bus
            .publish(lilacEventTypes.EvtAgentOutputDeltaText, { delta }, { headers })
            .catch((e: unknown) => {
              logger.error(
                "failed to publish output delta",
                { requestId: headers.request_id, sessionId: headers.session_id },
                e,
              );
            });
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_start"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          if (!reasoningChunkById.has(chunkId)) {
            reasoningChunkById.set(chunkId, "");
          }

          bus
            .publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, { delta: "" }, { headers })
            .catch((e: unknown) => {
              logger.error(
                "failed to publish reasoning start",
                { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                e,
              );
            });
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_delta"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          const delta = event.assistantMessageEvent.delta;

          if (!reasoningChunkById.has(chunkId)) {
            reasoningChunkById.set(chunkId, "");

            bus
              .publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, { delta: "" }, { headers })
              .catch((e: unknown) => {
                logger.error(
                  "failed to publish implicit reasoning start",
                  { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                  e,
                );
              });
          }

          const prev = reasoningChunkById.get(chunkId) ?? "";
          reasoningChunkById.set(chunkId, `${prev}${delta}`);
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "thinking_end"
        ) {
          const chunkId = event.assistantMessageEvent.id;
          const chunk = reasoningChunkById.get(chunkId) ?? "";
          reasoningChunkById.delete(chunkId);

          if (chunk.trim().length === 0) {
            return;
          }

          reasoningChunkSeq += 1;

          bus
            .publish(
              lilacEventTypes.EvtAgentOutputDeltaReasoning,
              { delta: chunk, seq: reasoningChunkSeq },
              { headers },
            )
            .catch((e: unknown) => {
              logger.error(
                "failed to publish reasoning chunk",
                { requestId: headers.request_id, sessionId: headers.session_id, chunkId },
                e,
              );
            });
        }

        if (event.type === "tool_execution_start") {
          toolStartMs.set(event.toolCallId, Date.now());

          bus
            .publish(
              lilacEventTypes.EvtAgentOutputToolCall,
              {
                toolCallId: event.toolCallId,
                status: "start",
                display: `${event.toolName}${formatToolArgsForDisplay(event.toolName, event.args)}`,
              },
              { headers },
            )
            .catch((e: unknown) => {
              logger.error(
                "failed to publish tool start",
                {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                },
                e,
              );
            });
        }

        if (event.type === "tool_execution_end") {
          const started = toolStartMs.get(event.toolCallId);
          const toolDurationMs = started ? Date.now() - started : undefined;

          const ok =
            event.toolName === "batch"
              ? (getBatchOkFromResult(event.result) ?? !event.isError)
              : event.toolName === "subagent_delegate"
                ? (getSubagentOkFromResult(event.result) ?? !event.isError)
                : !event.isError;
          const interruptedForRestart = restartAbortRequestIds.has(headers.request_id);

          logger.debug("tool finished", {
            requestId: headers.request_id,
            sessionId: headers.session_id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ok,
            durationMs: toolDurationMs,
          });

          bus
            .publish(
              lilacEventTypes.EvtAgentOutputToolCall,
              {
                toolCallId: event.toolCallId,
                status: "end",
                display: `${event.toolName}${formatToolArgsForDisplay(event.toolName, event.args)}`,
                ok,
                error: ok
                  ? undefined
                  : interruptedForRestart
                    ? "server restarted"
                    : event.isError
                      ? typeof event.result === "string"
                        ? event.result
                        : "tool error"
                      : "batch failed",
              },
              { headers },
            )
            .catch((e: unknown) => {
              logger.error(
                "failed to publish tool end",
                {
                  requestId: headers.request_id,
                  sessionId: headers.session_id,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                },
                e,
              );
            });
        }

        if (event.type === "agent_end") {
          // Best-effort fallback: if deltas didn't populate finalText, take last assistant string.
          if (!finalText) {
            const last = event.messages[event.messages.length - 1];
            if (last && last.role === "assistant" && typeof last.content === "string") {
              finalText = last.content;
            }
          }
        }
      });

      if (next.recovery) {
        initialMessages = [buildResumePrompt(next.recovery.partialText)];
      } else {
        // First message should be a prompt.
        // If additional messages for the same request id were queued before the run started,
        // merge them into the initial prompt so they don't become separate runs.
        const mergedInitial = mergeQueuedForSameRequest(next, state.queue);
        initialMessages = [...mergedInitial];
      }

      responseStartIndex = agent.state.messages.length + initialMessages.length;

      await agent.prompt(initialMessages);

      await agent.waitForIdle();

      if (restartAbortRequestIds.delete(headers.request_id)) {
        throw new RestartDrainingAbort();
      }

      const isCancelled = cancelledByRequestId.has(headers.request_id);
      if (isCancelled && !finalText) {
        finalText = "Cancelled.";
      }

      const delivery = resolveReplyDeliveryFromFinalText(finalText);
      const shouldSkipSurfaceReply = delivery === "skip";
      if (shouldSkipSurfaceReply) {
        logger.info("agent requested skip reply", {
          requestId: headers.request_id,
          sessionId: headers.session_id,
        });
        finalText = "";
      }

      // Intentional: skip-reply turns are not persisted for transcript expansion.
      if (params.transcriptStore && !shouldSkipSurfaceReply) {
        try {
          const responseMessages = runStats.finalMessages
            ? runStats.finalMessages.slice(responseStartIndex)
            : agent.state.messages.slice(responseStartIndex);

          params.transcriptStore.saveRequestTranscript({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            requestClient: headers.request_client,
            // Store only this request's newly produced messages.
            // The request context is reconstructed from the surface thread.
            messages: responseMessages,
            finalText,
            modelLabel: resolvedModelLabel,
          });
        } catch (e) {
          logger.error(
            "failed to persist transcript",
            { requestId: headers.request_id, sessionId: headers.session_id },
            e,
          );
        }
      }

      // Build stats in the js-llmcord-ish one-liner format.
      const endAt = runStats.lastTurnEndAt ?? Date.now();
      const ttftMs = runStats.firstTextDeltaAt ? runStats.firstTextDeltaAt - runStartedAt : null;
      const outputTokens = runStats.totalUsage?.outputTokens;
      const rawTps =
        typeof outputTokens === "number" &&
        runStats.lastTurnFinishReason === "stop" &&
        endAt > runStartedAt
          ? outputTokens / ((endAt - runStartedAt) / 1000)
          : null;
      const tps = rawTps !== null && Number.isFinite(rawTps) ? rawTps : null;

      const responseMessages = runStats.finalMessages
        ? runStats.finalMessages.slice(responseStartIndex)
        : [];

      const icLine = buildInputCompositionLine({
        system: systemPromptToText(agent.state.system),
        initialMessages,
        responseMessages,
        tools: agent.state.tools,
      });

      const modelLabel = resolved.modelId;
      const statsLine = buildStatsLine({
        modelLabel,
        usage: runStats.totalUsage,
        ttftMs,
        tps,
        icLine,
      });

      const statsForNerds = getStatsForNerdsOptions(cfg.agent.statsForNerds);
      const statsForNerdsLine = statsForNerds.enabled
        ? buildStatsLine({
            modelLabel,
            usage: runStats.totalUsage,
            ttftMs,
            tps,
            icLine: statsForNerds.verbose ? icLine : null,
          })
        : undefined;

      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText, delivery, statsForNerdsLine },
        { headers },
      );

      logger.info(statsLine, {
        requestId: headers.request_id,
        sessionId: headers.session_id,
      });

      logger.info("agent run resolved", {
        requestId: headers.request_id,
        sessionId: headers.session_id,
        durationMs: Date.now() - runStartedAt,
        finalTextChars: finalText.length,
      });

      await publishLifecycle({
        bus,
        headers,
        state: isCancelled ? "cancelled" : "resolved",
        detail: isCancelled ? "cancelled by interrupt" : undefined,
      });
    } catch (e) {
      if (e instanceof RestartDrainingAbort) {
        logger.info("agent run interrupted for graceful restart", {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          durationMs: Date.now() - runStartedAt,
        });
        return;
      }

      const msg = e instanceof Error ? e.message : String(e);

      if (params.transcriptStore) {
        try {
          const responseMessages = runStats.finalMessages
            ? runStats.finalMessages.slice(responseStartIndex)
            : (activeAgent?.state.messages.slice(responseStartIndex) ?? []);

          params.transcriptStore.saveRequestTranscript({
            requestId: headers.request_id,
            sessionId: headers.session_id,
            requestClient: headers.request_client,
            messages: responseMessages,
            finalText: `Error: ${msg}`,
            modelLabel: resolvedModelLabel,
          });
        } catch (err) {
          logger.error(
            "failed to persist transcript after error",
            { requestId: headers.request_id, sessionId: headers.session_id },
            err,
          );
        }
      }

      await publishLifecycle({ bus, headers, state: "failed", detail: msg });
      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: `Error: ${msg}` },
        { headers },
      );

      logger.error(
        "agent run failed",
        {
          requestId: headers.request_id,
          sessionId: headers.session_id,
          durationMs: Date.now() - runStartedAt,
        },
        e,
      );
    } finally {
      unsubscribe();
      unsubscribeCompaction();
      state.agent = null;
      state.activeRequestId = null;
      state.activeRun = null;
      state.running = false;
      cancelledByRequestId.delete(headers.request_id);
      restartAbortRequestIds.delete(headers.request_id);
      drainSessionQueue(sessionId, state).catch((e: unknown) => {
        logger.error("drainSessionQueue failed", { sessionId }, e);
      });
    }
  }

  return {
    beginDrain,
    snapshotRecoverables,
    restoreRecoverables,
    stop: async () => {
      await stopSubscription();
      bySession.clear();
      forcedRecoveryByRequestId.clear();
      restartAbortRequestIds.clear();
    },
  };
}

async function publishLifecycle(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
    router_session_mode?: "mention" | "active";
  };
  state: RequestLifecycleState;
  detail?: string;
}) {
  await params.bus.publish(
    lilacEventTypes.EvtRequestLifecycleChanged,
    { state: params.state, detail: params.detail, ts: Date.now() },
    { headers: params.headers },
  );
}

function mergeQueuedForSameRequest(first: Enqueued, queue: Enqueued[]): ModelMessage[] {
  const merged: ModelMessage[] = [...first.messages];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    queue.splice(i, 1);
  }

  return merged;
}

function removeQueuedEntries(
  queue: Enqueued[],
  shouldRemove: (entry: Enqueued) => boolean,
): Enqueued[] {
  const removed: Enqueued[] = [];

  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (!shouldRemove(next)) {
      i += 1;
      continue;
    }

    removed.push(next);
    queue.splice(i, 1);
  }

  return removed;
}

async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
  cancelledByRequestId: Set<string>,
) {
  const merged = mergeToSingleUserMessage(entry.messages);

  const cancel = (() => {
    const raw = entry.raw;
    if (!raw || typeof raw !== "object") return false;
    const v = (raw as Record<string, unknown>)["cancel"];
    return v === true;
  })();

  switch (entry.queue) {
    case "steer": {
      agent.steer(merged);
      return;
    }
    case "followUp": {
      agent.followUp(merged);
      return;
    }
    case "interrupt": {
      if (cancel) {
        cancelledByRequestId.add(entry.requestId);
        agent.abort();
        return;
      }
      await agent.interrupt(merged);
      return;
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      agent.followUp(merged);
      return;
    }
    default: {
      const _exhaustive: never = entry.queue;
      return _exhaustive;
    }
  }
}

function mergeToSingleUserMessage(messages: ModelMessage[]): ModelMessage {
  // If any user message has non-string content (multipart), do not merge.
  // Preserve raw parts for downstream processing.
  for (let i = messages.length - 1; i >= 0; i--) {
    const newest = messages[i]!;
    if (newest.role !== "user") continue;
    if (typeof newest.content !== "string") {
      return newest;
    }
  }

  // Preserve existing behavior: merge batches into one user message separated by blank lines.
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  return {
    role: "user",
    content: parts.join("\n\n").trim(),
  };
}
