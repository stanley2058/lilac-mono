import { isGeneratedMessage } from "@stanley2058/lilac-agent";
import { type ModelMessage, type ToolContent } from "ai";
import { boundToolResultMediaForModelView } from "@stanley2058/lilac-tool-results/tool-result-media";
import { safeStringify } from "./formatting";

// OpenCode-style tool output pruning:
// - Keep full tool call/result structure for forkability.
// - Compact *old* tool results (replace output with a placeholder) only in the
//   model-facing view, right before sending.
// - Track compacted toolCallIds in-memory per session for stability (cache hits).
const TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";

const TOOL_OUTPUT_CHARS_PER_TOKEN = 4;

const TOOL_OUTPUT_PRUNE_PROTECTED_TOOLS = new Set(["skill", "subagent_result"]);

function estimateTokensFromValue(value: unknown): number {
  // Best-effort token estimate (OpenCode uses chars/4).
  const chars = safeStringify(value).length;
  return Math.max(0, Math.round(chars / TOOL_OUTPUT_CHARS_PER_TOKEN));
}

// Tool results are immutable once produced, so each one is stringified for its estimate once.
type ToolResultOutput = Extract<ToolContent[number], { type: "tool-result" }>["output"];

const toolOutputTokenEstimates = new WeakMap<ToolResultOutput, number>();

function estimateToolOutputTokens(output: ToolResultOutput): number {
  const cached = toolOutputTokenEstimates.get(output);
  if (cached !== undefined) return cached;
  const estimate = estimateTokensFromValue(output);
  toolOutputTokenEstimates.set(output, estimate);
  return estimate;
}

export function maybeMarkOldToolOutputsCompacted(params: {
  messages: readonly ModelMessage[];
  compactedToolCallIds: Set<string>;
  protectTokens: number;
  minimumTokens: number;
}): number {
  let turns = 0;
  let total = 0;
  let pruned = 0;
  const toCompact = new Set<string>();

  // Walk backwards; skip the last turn (turn = user message).
  // This mirrors OpenCode's "turns < 2" behavior.
  outer: for (let msgIndex = params.messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = params.messages[msgIndex]!;
    if (msg.role === "user" && !isGeneratedMessage(msg)) turns++;
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
      const estimate = estimateToolOutputTokens(output);
      total += estimate;

      if (total > params.protectTokens) {
        pruned += estimate;
        toCompact.add(toolCallId);
      }
    }
  }

  if (pruned <= params.minimumTokens) return 0;

  let changed = false;
  for (const id of toCompact) {
    if (params.compactedToolCallIds.has(id)) continue;
    params.compactedToolCallIds.add(id);
    changed = true;
  }
  return changed ? pruned : 0;
}

export function applyToolOutputCompactionView(params: {
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

export function scrubLargeBinaryForModelView(
  messages: readonly ModelMessage[],
  limits: { maxBytesPerPart: number; maxBytesTotal: number },
): ModelMessage[] {
  return boundToolResultMediaForModelView(messages, limits);
}
