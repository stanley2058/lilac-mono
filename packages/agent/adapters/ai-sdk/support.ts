import type {
  LanguageModel,
  Experimental_DownloadFunction as DownloadFunction,
  ToolSet,
  TextStreamPart,
  ModelMessage,
} from "ai";
import { z } from "zod";
import { normalizeToolCallInputValue } from "@stanley2058/lilac-utils/tool-call-input-normalization";
import type { OpaqueAgentValue } from "../../failure-adapters";
import {
  canonicalToolName,
  getToolResultToolCallIds,
  type AgentOptions,
  type AgentState,
  type TransformMessagesContext,
} from "../../agent-runtime-support";
const legacyBatchInputSchema = z.object({
  tool_calls: z.array(
    z.object({
      tool: z.string(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export function repairLegacyBatchInput(input: OpaqueAgentValue, tools: ToolSet): string | null {
  const decoded = legacyBatchInputSchema.safeParse(normalizeToolCallInputValue(input));
  if (!decoded.success) return null;
  let changed = false;
  const toolCalls = decoded.data.tool_calls.map((call) => {
    const requestedName = call.tool;
    const toolName = tools[requestedName] ? requestedName : canonicalToolName(requestedName);
    if (toolName === requestedName || !tools[toolName]) return call;
    changed = true;
    return {
      tool: toolName,
      ...(call.parameters === undefined ? {} : { parameters: call.parameters }),
    };
  });
  return changed ? JSON.stringify({ ...decoded.data, tool_calls: toolCalls }) : null;
}

type SupportedAiSdkTextStreamPartType =
  | "abort"
  | "start-step"
  | "text-start"
  | "text-delta"
  | "text-end"
  | "reasoning-start"
  | "reasoning-delta"
  | "reasoning-end"
  | "tool-input-start"
  | "tool-input-delta"
  | "tool-input-end"
  | "custom"
  | "source"
  | "file"
  | "reasoning-file"
  | "tool-call"
  | "tool-result"
  | "tool-error"
  | "tool-output-denied"
  | "tool-approval-response"
  | "tool-approval-request"
  | "error";

export type ProjectedAiSdkTextStreamPart<TOOLS extends ToolSet> =
  | {
      readonly [Kind in SupportedAiSdkTextStreamPartType]: {
        readonly kind: Kind;
        readonly raw: Extract<TextStreamPart<TOOLS>, { type: Kind }>;
      };
    }[SupportedAiSdkTextStreamPartType]
  | { readonly kind: "unsupported"; readonly partType: string };

/** Normalize the open AI SDK stream protocol before the agent run loop consumes it. */
export function projectAiSdkTextStreamPart<TOOLS extends ToolSet>(
  part: TextStreamPart<TOOLS>,
): ProjectedAiSdkTextStreamPart<TOOLS> {
  switch (part.type) {
    case "abort":
      return { kind: "abort", raw: part };
    case "start-step":
      return { kind: "start-step", raw: part };
    case "text-start":
      return { kind: "text-start", raw: part };
    case "text-delta":
      return { kind: "text-delta", raw: part };
    case "text-end":
      return { kind: "text-end", raw: part };
    case "reasoning-start":
      return { kind: "reasoning-start", raw: part };
    case "reasoning-delta":
      return { kind: "reasoning-delta", raw: part };
    case "reasoning-end":
      return { kind: "reasoning-end", raw: part };
    case "tool-input-start":
      return { kind: "tool-input-start", raw: part };
    case "tool-input-delta":
      return { kind: "tool-input-delta", raw: part };
    case "tool-input-end":
      return { kind: "tool-input-end", raw: part };
    case "custom":
      return { kind: "custom", raw: part };
    case "source":
      return { kind: "source", raw: part };
    case "file":
      return { kind: "file", raw: part };
    case "reasoning-file":
      return { kind: "reasoning-file", raw: part };
    case "tool-call":
      return { kind: "tool-call", raw: part };
    case "tool-result":
      return { kind: "tool-result", raw: part };
    case "tool-error":
      return { kind: "tool-error", raw: part };
    case "tool-output-denied":
      return { kind: "tool-output-denied", raw: part };
    case "tool-approval-response":
      return { kind: "tool-approval-response", raw: part };
    case "tool-approval-request":
      return { kind: "tool-approval-request", raw: part };
    case "error":
      return { kind: "error", raw: part };
    default:
      return { kind: "unsupported", partType: "unsupported" };
  }
}

export type ModelCallExecutionMode = "local-tools" | "provider-tools";

export type ModelCallRuntime = {
  readonly model: LanguageModel;
  readonly modelSpecifier?: string;
  readonly executionMode: ModelCallExecutionMode;
  /** Stable identity for outer calls that belong to one persistent provider attempt. */
  readonly persistentAttemptIdentity?: string;
  /** Per-call AI SDK retry limit. Omit to inherit the Agent constructor default. */
  readonly streamTextMaxRetries?: number;
};

export type CanonicalPayloadSelection =
  | { readonly mode: "full" }
  | { readonly mode: "suffix"; readonly startIndex: number };

export type PrepareModelCallContext = {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly fullBudgetView: readonly ModelMessage[];
  readonly runtime: ModelCallRuntime;
  readonly payload: CanonicalPayloadSelection;
  readonly transformContext: TransformMessagesContext;
};

export type PreparedModelCall = {
  readonly runtime: ModelCallRuntime;
  readonly payload: CanonicalPayloadSelection;
};

export type PrepareModelCall = (
  context: PrepareModelCallContext,
) => PreparedModelCall | Promise<PreparedModelCall>;

function hasOwnKey<T extends object, K extends PropertyKey>(
  obj: T,
  key: K,
): obj is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function extractToolCallsFromMessages(messages: readonly ModelMessage[]): Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
}> {
  const satisfiedToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const toolCallId of getToolResultToolCallIds(message)) {
      satisfiedToolCallIds.add(toolCallId);
    }
  }

  const toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid?: boolean;
    error?: unknown;
  }> = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") continue;

    for (const part of content) {
      // Ignore tool approval request prompts and other parts.
      if (part.type !== "tool-call") continue;

      // If this batch of messages already contains a tool result for the same
      // toolCallId, do not execute it again locally.
      if (satisfiedToolCallIds.has(part.toolCallId)) continue;

      // Provider-executed tools should produce tool messages without local execution.
      if (part.providerExecuted === true) continue;

      const invalid = hasOwnKey(part, "invalid") && part.invalid === true;
      const error = hasOwnKey(part, "error") ? part.error : undefined;

      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: normalizeToolCallInputValue(part.input),
        ...(invalid ? { invalid: true } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    }
  }

  return toolCalls;
}

export type AiSdkPiAgentState<TOOLS extends ToolSet = ToolSet> = AgentState<TOOLS> & {
  model: LanguageModel;
};
export type AiSdkPiAgentOptions<TOOLS extends ToolSet = ToolSet> = AgentOptions<TOOLS> & {
  model: LanguageModel;
  prepareModelCall?: PrepareModelCall;
  streamTextMaxRetries?: number;
  sendToolsToModel?: boolean;
  experimentalDownload?: DownloadFunction;
};

export { canonicalToolName } from "../../agent-runtime-support";

export { stripToolExecuteForModel } from "../../agent-runtime-support";

export type { AiSdkPiAgentEvent, AiSdkPiAssistantMessageEvent } from "../../agent-runtime-support";
