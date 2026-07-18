import { asSchema, type CallWarning, type FinishReason, type LanguageModelUsage } from "ai";
import type { ModelMessage } from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import { formatInt, formatSeconds, safeStringify } from "./formatting";

type ToolsLike = Record<string, { description?: string; inputSchema?: unknown }>;

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

function countCharsInMessage(message: ModelMessage): {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolResultChars: number;
} {
  let systemChars = 0;
  let assistantChars = 0;
  let userChars = 0;
  let toolResultChars = 0;

  if (message.role === "system") {
    systemChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (message.role === "user") {
    userChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (message.role === "tool") {
    toolResultChars += safeStringify(message.content).length;
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  if (message.role !== "assistant") {
    return { systemChars, assistantChars, userChars, toolResultChars };
  }

  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
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

function buildPromptSnapshots(params: {
  initialMessages: readonly ModelMessage[];
  responseMessages: readonly ModelMessage[];
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

type InputCompositionChars = {
  systemChars: number;
  assistantChars: number;
  userChars: number;
  toolDefsChars: number;
  toolResultChars: number;
  callCount: number;
};

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

export function systemPromptToText(system: unknown): string {
  if (typeof system === "string") return system;

  if (Array.isArray(system)) {
    return system
      .map((m) => systemPromptToText(m))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }

  if (!system || typeof system !== "object" || Array.isArray(system)) return safeStringify(system);

  const content = (system as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(safeStringify).join("");
  return safeStringify(content);
}

export function buildInputCompositionLine(input: {
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

export function getStatsForNerdsOptions(
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

export function buildStatsLine(params: {
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

export function buildNoAssistantTextError(params: {
  provider: string;
  modelId: string;
  finishReason?: FinishReason;
  warningSummary?: string;
}): string {
  const finishReason = params.finishReason ? ` finishReason='${params.finishReason}'.` : "";

  const warningSuffix = params.warningSummary ? ` Provider warnings: ${params.warningSummary}` : "";

  if (params.finishReason === "tool-calls") {
    return `No assistant text was produced by provider '${params.provider}' model '${params.modelId}'.${finishReason} The model ended on a tool-call turn, but the provider output contained neither an executable tool call nor a completed tool result.${warningSuffix}`;
  }

  return `No assistant text was produced by provider '${params.provider}' model '${params.modelId}'.${finishReason} This often means the model is unavailable or unsupported by the upstream backend (for example, model_not_found).${warningSuffix}`;
}

export function formatCallWarning(warning: CallWarning): string {
  switch (warning.type) {
    case "unsupported":
      return warning.details
        ? `unsupported ${warning.feature} (${warning.details})`
        : `unsupported ${warning.feature}`;
    case "compatibility":
      return warning.details
        ? `compatibility ${warning.feature} (${warning.details})`
        : `compatibility ${warning.feature}`;
    case "other":
      return warning.message;
    case "deprecated":
      return warning.message;
    default: {
      const _exhaustive: never = warning;
      return String(_exhaustive);
    }
  }
}

export function summarizeCallWarnings(warnings: readonly CallWarning[]): string | null {
  if (warnings.length === 0) return null;

  const unique = [
    ...new Set(warnings.map(formatCallWarning).filter((item) => item.trim().length > 0)),
  ];
  if (unique.length === 0) return null;

  const visible = unique.slice(0, 3);
  const more = unique.length - visible.length;
  return more > 0 ? `${visible.join(" | ")} (+${more} more)` : visible.join(" | ");
}

export function maybeAppendWarningSummaryToUnclearError(
  message: string,
  warningSummary: string | null,
): string {
  if (!warningSummary) return message;
  if (message.includes("Provider warnings:")) return message;

  const normalized = message.trim().toLowerCase();
  const isUnclear =
    normalized === "response stream error" ||
    normalized.startsWith("responses request failed") ||
    normalized.startsWith("no assistant text was produced") ||
    normalized === "no content generated";

  return isUnclear ? `${message} Provider warnings: ${warningSummary}` : message;
}
