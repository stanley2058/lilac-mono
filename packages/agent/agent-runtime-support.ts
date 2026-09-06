import type {
  AssistantContent,
  AssistantModelMessage,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  ToolSet,
  CallWarning,
} from "ai";
import { TaggedError, type Result as ResultType } from "better-result";
import { isRecord } from "@stanley2058/lilac-utils/runtime-utils";
import type { ModelReasoningEffort } from "@stanley2058/lilac-utils/core-config/types";
import type {
  AtomicToolExecutionFailed,
  NormalizeSettledToolResultOutputsFn,
  NormalizeToolResultOutputFn,
  ToolResultOutput,
} from "./atomic-tool-execution";
import {
  captureAgentOperation,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "./failure-adapters";
import { cloneAgentMessage as cloneQueuedMessageValue } from "./message-clone";
import type { ExpandedToolCall } from "./tool-call-expansion";
import type { ToolBatchExecutionFailed } from "./agent-tool-host";
import type { AgentRecoveryRequired } from "./agent-adapter";
export type {
  StepToolSnapshot,
  ExecutedExpansionChild,
  ExternalToolExecutionOutcome,
} from "./agent-tool-host";
export const SETTLED_NORMALIZATION_FAILED = "[settled tool results could not be normalized]";
export const LENGTH_RECOVERY_CONTINUE_TEXT =
  "Continue from the compacted context. Do not retry any tool call that was truncated unless it is still necessary.";
export const LENGTH_RECOVERY_PROVIDER_OPTIONS = {
  lilac: { autoCompactionContinue: true },
} as const satisfies NonNullable<ModelMessage["providerOptions"]>;

export type {
  NormalizeSettledToolResultOutputsFn,
  NormalizeToolResultOutputFn,
  SettledToolResultOutputEntry,
  ToolResultOutput,
} from "./atomic-tool-execution";

export type SystemPrompt = string | SystemModelMessage | SystemModelMessage[];

/**
 * Controls how `steer()` messages are drained.
 *
 * - `one-at-a-time`: inject at most one steering message per check.
 * - `all`: drain the queue and inject all steering messages.
 */
export type SteeringMode = "one-at-a-time" | "all";

/**
 * Controls how `followUp()` messages are drained.
 *
 * Follow-ups are only injected when the model finishes a turn without tool calls.
 */
export type FollowUpMode = "one-at-a-time" | "all";

/** Stable identifier returned for an entry added to the steering queue. */
export type SteeringQueueId = string;

/** Agent path that will deliver a prepared steering batch. */
export type SteeringDeliveryKind = "queued" | "interrupt";

/** One stable queued steering entry exposed at the pre-delivery boundary. */
export type SteeringDeliveryEntry = {
  readonly id: SteeringQueueId;
  readonly message: ModelMessage;
};

/** Context supplied immediately before a steering batch becomes canonical. */
export type BeforeSteeringDeliveryContext = {
  readonly deliveryKind: SteeringDeliveryKind;
  /** Ordered snapshot of the exact steering entries selected for this delivery. */
  readonly batch: readonly SteeringDeliveryEntry[];
  /**
   * Exact canonical messages that will be appended and made provider-visible.
   * Every selected steering entry retains its own message boundary; selected follow-ups may
   * precede or merge into the first steering message.
   */
  readonly canonicalMessages: readonly ModelMessage[];
  /** Aborted when the active run is cancelled or interrupted while the hook is pending. */
  readonly abortSignal?: AbortSignal;
};

/**
 * Awaited hook that must finish before a selected steering batch is consumed or delivered.
 * Ordinary delivery uses `queued`; `interruptQueuedSteeringAsync()` uses `interrupt`.
 */
export type BeforeSteeringDeliveryHandler = (
  context: BeforeSteeringDeliveryContext,
) => void | Promise<void>;

/** Outcome of requesting an immediate interrupt from the current steering queue. */
export type InterruptQueuedSteeringResult =
  | { status: "interrupted"; steeringIds: SteeringQueueId[] }
  | { status: "empty" }
  | { status: "inactive" };

/** Outcome of the awaited, non-destructive-until-prepared interrupt path. */
export type AsyncInterruptQueuedSteeringResult =
  | InterruptQueuedSteeringResult
  | { status: "failed"; steeringIds: SteeringQueueId[]; error: string };

/**
 * Fine-grained events emitted while an assistant message is streaming.
 *
 * Adapters publish plain data after interpreting their provider stream.
 */
export type AgentStreamMetadata = { providerMetadata?: ModelMessage["providerOptions"] };

export type AgentGeneratedFile = {
  readonly base64: string;
  readonly uint8Array: Uint8Array;
  readonly mediaType: string;
};

export type AgentStreamData = AgentStreamMetadata &
  (
    | { type: "text-start"; id: string }
    | { type: "text-end"; id: string }
    | { type: "text-delta"; id: string; text: string }
    | { type: "reasoning-start"; id: string }
    | { type: "reasoning-end"; id: string }
    | { type: "reasoning-delta"; id: string; text: string }
    | {
        type: "tool-input-start";
        id: string;
        toolName: string;
        toolMetadata?: JSONObject;
        providerExecuted?: boolean;
        dynamic?: boolean;
        title?: string;
      }
    | { type: "tool-input-end"; id: string }
    | { type: "tool-input-delta"; id: string; delta: string }
    | { type: "custom"; kind: `${string}.${string}` }
    | { type: "source"; sourceType: "url"; id: string; url: string; title?: string }
    | {
        type: "source";
        sourceType: "document";
        id: string;
        mediaType: string;
        title: string;
        filename?: string;
      }
    | { type: "file"; file: AgentGeneratedFile }
    | { type: "reasoning-file"; file: AgentGeneratedFile }
  );

export type AgentAssistantMessageEvent<_TOOLS extends ToolSet = ToolSet> =
  | {
      type: "text_start";
      id: string;
      raw: Extract<AgentStreamData, { type: "text-start" }>;
    }
  | {
      type: "text_delta";
      id: string;
      delta: string;
      raw: Extract<AgentStreamData, { type: "text-delta" }>;
    }
  | {
      type: "text_end";
      id: string;
      raw: Extract<AgentStreamData, { type: "text-end" }>;
    }
  | {
      type: "thinking_start";
      id: string;
      raw: Extract<AgentStreamData, { type: "reasoning-start" }>;
    }
  | {
      type: "thinking_delta";
      id: string;
      delta: string;
      raw: Extract<AgentStreamData, { type: "reasoning-delta" }>;
    }
  | {
      type: "thinking_end";
      id: string;
      raw: Extract<AgentStreamData, { type: "reasoning-end" }>;
    }
  | {
      type: "toolcall_start";
      toolCallId: string;
      toolName: string;
      raw: Extract<AgentStreamData, { type: "tool-input-start" }>;
    }
  | {
      type: "toolcall_delta";
      toolCallId: string;
      delta: string;
      raw: Extract<AgentStreamData, { type: "tool-input-delta" }>;
    }
  | {
      type: "toolcall_end";
      toolCallId: string;
      raw: Extract<AgentStreamData, { type: "tool-input-end" }>;
    }
  | {
      type: "custom";
      raw: Extract<AgentStreamData, { type: "custom" }>;
    }
  | {
      type: "source";
      raw: Extract<AgentStreamData, { type: "source" }>;
    }
  | {
      type: "file";
      raw: Extract<AgentStreamData, { type: "file" }>;
    }
  | {
      type: "reasoning_file";
      raw: Extract<AgentStreamData, { type: "reasoning-file" }>;
    };

/** Why a turn ended without producing a `turn_end`. */
export type TurnAbortReason = "cancel" | "interrupt" | "manual" | "recovery";

/** Where the abort occurred: model streaming vs tool execution. */
export type TurnAbortPhase = "model" | "tools";

/**
 * High-level event stream for building a `pi-agent`-style UI.
 *
 * Downstream should treat `messages_reset` as authoritative and replace any
 * locally accumulated transcript state when it occurs.
 */
export type AgentEvent<TOOLS extends ToolSet = ToolSet> =
  /** Run started (triggered by `prompt()` or `continue()`). */
  | { type: "agent_start" }
  /** Run finished (success, manual abort, or error). */
  | {
      type: "agent_end";
      messages: ModelMessage[];
      /** Total usage across all successful turns in the run. */
      totalUsage?: LanguageModelUsage;
    }
  /** A new model request (turn) started. */
  | { type: "turn_start" }
  /** A model request (turn) completed normally. */
  | {
      type: "turn_end";
      finishReason: FinishReason;
      newMessages: ModelMessage[];
      /** Token usage of the last step for this turn. */
      usage: LanguageModelUsage;
      /** Token usage summed across steps for this turn. */
      totalUsage: LanguageModelUsage;
    }
  /** A failed model request will be replayed from the unchanged canonical transcript. */
  | {
      type: "turn_retry";
      hadPartialOutput: boolean;
      abandonedToolCallIds: string[];
    }
  /** Provider warnings emitted for the active model turn. */
  | {
      type: "turn_warnings";
      warnings: CallWarning[];
    }
  /** A steering batch remained queued because its pre-delivery hook rejected. */
  | {
      type: "steering_delivery_failed";
      deliveryKind: SteeringDeliveryKind;
      steeringIds: SteeringQueueId[];
      error: string;
    }
  /** A model request (turn) was aborted and will not emit `turn_end`. */
  | {
      type: "turn_abort";
      reason: TurnAbortReason;
      phase: TurnAbortPhase;
      detail?: string;
    }
  /**
   * Canonical transcript was replaced or rewound.
   *
   * Downstream should treat this as authoritative and replace any locally
   * accumulated transcript state.
   */
  | {
      type: "messages_reset";
      reason: "cancel" | "interrupt" | "recovery";
      messages: ModelMessage[];
      droppedMessageCount: number;
    }
  | {
      type: "messages_reset";
      reason: "replace" | "compaction";
      messages: ModelMessage[];
      previousMessageCount: number;
    }
  /** A message was appended to the transcript (or assistant streaming started). */
  | { type: "message_start"; message: ModelMessage }
  /** Incremental assistant updates (text/reasoning/toolcall deltas). */
  | {
      type: "message_update";
      message: ModelMessage;
      assistantMessageEvent: AgentAssistantMessageEvent<TOOLS>;
    }
  /** A message is complete (user/tool are immediate; assistant ends after stream). */
  | { type: "message_end"; message: ModelMessage }
  /** Local tool execution started (only for non-provider-executed tools). */
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  /** Local tool produced incremental output (AsyncIterable tool results). */
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  /** Local tool execution finished; a tool-result message will be appended. */
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      isError: boolean;
      output: ToolResultOutput;
      outcome: "success" | "invalid-input" | "denied" | "error";
    };

/**
 * Live agent state.
 *
 * This object is mutated during execution; treat it as read-only unless you
 * deliberately want to override internals.
 */
export interface AgentState<TOOLS extends ToolSet> {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** Optional canonical model spec (`provider/model`). */
  modelSpecifier?: string;
  /** Toolset available to the model. */
  tools: TOOLS;
  /** Canonical transcript (system is kept separately in `system`). */
  messages: ModelMessage[];
  /** True while the agent run loop is active. */
  isStreaming: boolean;
  /** Partial assistant message while streaming, otherwise `null`. */
  streamMessage: Extract<ModelMessage, { role: "assistant" }> | null;
  /** Tool call IDs currently executing locally. */
  pendingToolCalls: Set<string>;
  /** Set when the run terminates due to an error. */
  error?: string;
  recoveryRequired?: AgentRecoveryRequired;
  /** Provider-specific options. */
  providerOptions?: { [x: string]: JSONObject };
  /** Portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;

  /** Debug-only state (optional, can be large). */
  debug?: {
    /** The exact messages array sent to the model for the last completed turn. */
    lastModelViewMessages?: ModelMessage[];
    /** Monotonic turn counter for lastModelViewMessages (1-based). */
    lastModelViewTurn?: number;
    /** When lastModelViewMessages was captured (Date.now()). */
    lastModelViewCapturedAt?: number;
  };
}

export type JSONArray = JSONValue[];
export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type TransformMessagesContext = {
  /** The system prompt that will be sent via `streamText({ system })`. */
  system: SystemPrompt;
  /** Exact tool declarations that will be sent with this model request. */
  tools: ToolSet;
  /** Abort signal for this turn (if present). */
  abortSignal?: AbortSignal;
  /** Canonical offset for full-budget subset preparation; payload transforms normally omit it. */
  canonicalStartIndex?: number;
};

export type PrepareFullModelView = (
  canonicalMessages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => ModelMessage[] | Promise<ModelMessage[]>;

/** Prepares the complete target-protocol view used for estimation and compaction only. */
export type PrepareFullBudgetView = PrepareFullModelView;

export type CanonicalModelCallPreflight = (
  canonicalMessages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => void | Promise<void>;

export type BuildEphemeralOverlay = (
  context: TransformMessagesContext,
) => readonly ModelMessage[] | Promise<readonly ModelMessage[]>;

export type DecorateRequestPayload = (
  payload: readonly ModelMessage[],
  context: TransformMessagesContext,
) => ModelMessage[] | Promise<ModelMessage[]>;

export type TurnErrorHandlerDecision = "retry" | "fail";

export interface IdleRecoveryDecisionHandler {
  (
    error: OpaqueAgentValue,
    context: { readonly abortSignal: AbortSignal },
  ): TurnErrorHandlerDecision | Promise<TurnErrorHandlerDecision>;
}

export type IdleRecoveryResult =
  | { readonly status: "retried" }
  | { readonly status: "failed" }
  | { readonly status: "inactive" }
  | {
      readonly status: "superseded";
      readonly reason: Exclude<TurnAbortReason, "recovery">;
    };

export type TurnErrorPhase = "before-step" | "transform-messages" | "model-call" | "post-model";

export type TurnRetrySafety =
  | { canRetry: true }
  | {
      canRetry: false;
      reason: "invalid-transcript-boundary" | "post-model-phase" | "provider-executed-tool";
    };

export interface TurnErrorHandler {
  (
    error: OpaqueAgentValue,
    context: {
      abortSignal?: AbortSignal;
      retrySafety: TurnRetrySafety;
      /** Origin of the error. Optional for compatibility with direct handler callers. */
      phase?: TurnErrorPhase;
    },
  ): TurnErrorHandlerDecision | Promise<TurnErrorHandlerDecision>;
}

export type TurnBoundaryContext = {
  finishReason: FinishReason;
  /** Exact transformed messages used by the model call that just completed. */
  modelInputMessages: readonly ModelMessage[];
  /** Number of local tool calls completed before this boundary. */
  executedToolCallCount: number;
  abortSignal?: AbortSignal;
};

export type TurnBoundaryDecision = {
  append?: readonly ModelMessage[];
  /** Continue even when the messages were already present, such as after recovery. */
  forceNextTurn?: boolean;
};

export type TurnBoundaryHandler = (
  context: TurnBoundaryContext,
) => TurnBoundaryDecision | Promise<TurnBoundaryDecision>;

/** Hook run immediately before each model step's tool authority is frozen. */
export type BeforeStepHandler = (context: {
  step: number;
  abortSignal?: AbortSignal;
}) => void | Promise<void>;

/** Stable identifier for one queued steering or follow-up input. */
export type AgentInputQueueId = string;

/** Hook for handing off the current replay-safe transcript to its persistence owner. */
export type RecoveryCheckpointHandler = (
  messages: readonly ModelMessage[],
  canonicalInputIds: readonly AgentInputQueueId[],
) => void | Promise<void>;

export type AgentOptions<TOOLS extends ToolSet> = {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** Optional canonical model spec (`provider/model`). */
  modelSpecifier?: string;
  /** Optional toolset (defaults to empty). */
  tools?: TOOLS;
  /** Optional initial transcript (defaults to empty). */
  messages?: ModelMessage[];
  prepareFullModelView?: PrepareFullModelView;
  prepareFullBudgetView?: PrepareFullBudgetView;
  canonicalModelCallPreflight?: CanonicalModelCallPreflight;
  buildEphemeralOverlay?: BuildEphemeralOverlay;
  decorateRequestPayload?: DecorateRequestPayload;
  /** Optional hook to recover from turn errors (e.g. context overflow). */
  turnErrorHandler?: TurnErrorHandler;
  /** Inject messages after tools finish and before the next model turn. */
  turnBoundaryHandler?: TurnBoundaryHandler;
  /** Prepare selected steering entries before they are consumed or delivered. */
  beforeSteeringDelivery?: BeforeSteeringDeliveryHandler;
  /** Refresh active tools and other per-step state before tool authority is frozen. */
  beforeStep?: BeforeStepHandler;
  /** Hand off replay-safe messages without requiring persistence to finish before later work. */
  recoveryCheckpointHandler?: RecoveryCheckpointHandler;
  /** Normalize model-facing tool output before it enters the canonical transcript. */
  normalizeToolResultOutput?: NormalizeToolResultOutputFn;
  /** Normalize one fully settled expansion cohort in declared child order. */
  normalizeSettledToolResultOutputs?: NormalizeSettledToolResultOutputsFn;
  /** Tool names whose specs guarantee already-bounded model output. */
  genericOutputNormalizerBypassTools?: ReadonlySet<string>;
  /** Trusted tool names excluded from the settled cohort's aggregate output budget. */
  aggregateOutputBudgetExemptTools?: ReadonlySet<string>;
  /** When any of these tools are called, other tools in the same model turn are rejected. */
  exclusiveToolNames?: ReadonlySet<string>;
  /** Optional provider-specific options. */
  providerOptions?: {
    [x: string]: JSONObject;
  };
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;

  /** Optional debug features. */
  debug?: {
    /** Capture and store model-view messages per turn (can be large). */
    captureModelViewMessages?: boolean;
  };
};

export function cloneMessage(message: AssistantModelMessage): AssistantModelMessage;
export function cloneMessage(message: ToolModelMessage): ToolModelMessage;
export function cloneMessage(message: ModelMessage): ModelMessage;
export function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => Object.assign({}, part))
        : message.content,
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  return { ...message };
}

export class AgentStateTransitionFailed extends TaggedError("AgentStateTransitionFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class AgentExternalHostFailed extends TaggedError("AgentExternalHostFailed")<{
  readonly cause: OpaqueAgentValue;
  readonly message: string;
}> {}

export function signalExternalToolCallHost(
  error: AtomicToolExecutionFailed | ToolBatchExecutionFailed | AgentExternalHostFailed,
): never {
  throw error.cause;
}

export function signalAgentStateHost(error: AgentStateTransitionFailed | TurnAbortedError): never {
  if (error instanceof TurnAbortedError) throw error;
  throw new Error(error.message, { cause: error });
}

export function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export function cloneQueuedMessage(
  message: ModelMessage,
  operation: "queue" | "deliver",
): ModelMessage {
  const cloned = cloneQueuedMessageValue(message);
  const outcome = resultOutcome(cloned);
  if (outcome.ok) return outcome.value;
  return signalAgentStateHost(
    new AgentStateTransitionFailed({
      operation: `${operation} steering message`,
      message: `Cannot ${operation} steering message: messages must be safely cloneable (${outcome.error.message})`,
    }),
  );
}

export function cloneAssistantMessage(message: AssistantModelMessage): AssistantModelMessage {
  return cloneMessage(message);
}

export function sumOptionalNumber(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function sumLanguageModelUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;

  return {
    inputTokens: sumOptionalNumber(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sumOptionalNumber(
        a.inputTokenDetails.noCacheTokens,
        b.inputTokenDetails.noCacheTokens,
      ),
      cacheReadTokens: sumOptionalNumber(
        a.inputTokenDetails.cacheReadTokens,
        b.inputTokenDetails.cacheReadTokens,
      ),
      cacheWriteTokens: sumOptionalNumber(
        a.inputTokenDetails.cacheWriteTokens,
        b.inputTokenDetails.cacheWriteTokens,
      ),
    },
    outputTokens: sumOptionalNumber(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: sumOptionalNumber(
        a.outputTokenDetails.textTokens,
        b.outputTokenDetails.textTokens,
      ),
      reasoningTokens: sumOptionalNumber(
        a.outputTokenDetails.reasoningTokens,
        b.outputTokenDetails.reasoningTokens,
      ),
    },
    totalTokens: sumOptionalNumber(a.totalTokens, b.totalTokens),
    raw: undefined,
  };
}

export function takeQueued<T>(mode: "one-at-a-time" | "all", queue: T[]): T[] {
  if (queue.length === 0) return [];
  if (mode === "one-at-a-time") {
    return [queue.shift()!];
  }
  const out = queue.slice();
  queue.length = 0;
  return out;
}

export function peekQueued<T>(mode: "one-at-a-time" | "all", queue: T[]): T[] {
  if (queue.length === 0) return [];
  return mode === "one-at-a-time" ? queue.slice(0, 1) : queue.slice();
}

export type FollowUpQueueEntry = {
  readonly id: AgentInputQueueId;
  readonly message: ModelMessage;
};

export type SteeringDeliverySelection = {
  readonly deliveryKind: SteeringDeliveryKind;
  readonly steeringEntries: readonly SteeringDeliveryEntry[];
  readonly followUpEntries: readonly FollowUpQueueEntry[];
  readonly canonicalMessages: readonly ModelMessage[];
};

export type SteeringDeliveryHookResult =
  | { readonly status: "prepared" }
  | { readonly status: "failed"; readonly error: string };

export type SteeringDeliveryPreparation = SteeringDeliverySelection & {
  readonly settled: Promise<void>;
  readonly settle: () => void;
  hookStatus: "pending" | "prepared";
};

export type AwaitedSteeringInterruptRequest = {
  settled: boolean;
  readonly resolve: (result: AsyncInterruptQueuedSteeringResult) => void;
};

export type IdleRecoveryRequest = {
  readonly error: unknown;
  readonly decideRetry: IdleRecoveryDecisionHandler;
  readonly resolve: (result: IdleRecoveryResult) => void;
  settled: boolean;
};

export function takeAll<T>(queue: T[]): T[] {
  if (queue.length === 0) return [];
  const out = queue.slice();
  queue.length = 0;
  return out;
}

export function makeUserMessage(input: string | ModelMessage): ModelMessage {
  if (typeof input === "string") {
    return { role: "user", content: input };
  }
  return input;
}

export function mergeUserMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return [];

  // If any user message has non-string content (multipart), do not merge.
  for (let i = messages.length - 1; i >= 0; i--) {
    const newest = messages[i]!;
    if (newest.role !== "user") continue;
    if (typeof newest.content !== "string") {
      return messages;
    }
  }

  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  const merged = parts.join("\n\n").trim();
  if (!merged) return messages;

  return [{ role: "user", content: merged }];
}

export function canonicalSteeringMessages(
  followUps: readonly FollowUpQueueEntry[],
  steeringEntries: readonly SteeringDeliveryEntry[],
): ModelMessage[] {
  const firstSteering = steeringEntries[0];
  if (!firstSteering) return [];
  return [
    ...mergeUserMessages([...followUps.map((entry) => entry.message), firstSteering.message]),
    ...steeringEntries.slice(1).map((entry) => entry.message),
  ];
}

export type AssistantContentParts = Extract<AssistantContent, unknown[]>;
export function upsertTextPart(
  content: AssistantContentParts,
  partType: "text" | "reasoning",
  delta: string,
): void {
  const last = content.length > 0 ? content[content.length - 1] : undefined;
  if (last && last.type === partType && "text" in last && typeof last.text === "string") {
    last.text += delta;
    return;
  }
  if (partType === "text") {
    content.push({ type: "text", text: delta });
    return;
  }
  content.push({ type: "reasoning", text: delta });
}

export class TurnAbortedError extends Error {
  readonly reason: TurnAbortReason;
  readonly phase: TurnAbortPhase;
  readonly detail?: string;

  constructor(options: { reason: TurnAbortReason; phase: TurnAbortPhase; detail?: string }) {
    super(`Turn aborted (${options.reason}, ${options.phase})`);
    this.name = "TurnAbortedError";
    this.reason = options.reason;
    this.phase = options.phase;
    this.detail = options.detail;
  }
}

export function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool" && message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const ids: string[] = [];
  for (const part of message.content) {
    if (part.type === "tool-result") {
      ids.push(part.toolCallId);
    }
  }
  return ids;
}

export function getUnresolvedAssistantToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

  const open = new Set<string>();
  for (const part of message.content) {
    if (part.type === "tool-call") open.add(part.toolCallId);
    if (part.type === "tool-result") open.delete(part.toolCallId);
  }
  return [...open];
}

export function truncatedToolCallResultMessage(
  toolCalls: readonly ExpandedToolCall[],
): ToolModelMessage | null {
  if (toolCalls.length === 0) return null;
  return {
    role: "tool",
    content: toolCalls.map((toolCall) => ({
      type: "tool-result" as const,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: {
        type: "error-text" as const,
        value: "Tool call was not executed because the model output was truncated.",
      },
    })),
  };
}

export function lengthRecoveryContinueMessage(): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: LENGTH_RECOVERY_CONTINUE_TEXT }],
    providerOptions: LENGTH_RECOVERY_PROVIDER_OPTIONS,
  };
}

export function completedAssistantPrefix(
  message: AssistantModelMessage,
): AssistantModelMessage | null {
  if (!Array.isArray(message.content)) {
    return message.content.length === 0 ? null : cloneAssistantMessage(message);
  }

  const openToolCallIds = new Set<string>();
  let lastValidIndex = -1;
  for (let index = 0; index < message.content.length; index += 1) {
    const part = message.content[index]!;
    if (part.type === "tool-call") openToolCallIds.add(part.toolCallId);
    if (part.type === "tool-result") openToolCallIds.delete(part.toolCallId);
    if (openToolCallIds.size === 0) lastValidIndex = index;
  }
  if (lastValidIndex < 0) return null;
  return {
    ...message,
    content: message.content.slice(0, lastValidIndex + 1).map((part) => ({ ...part })),
  };
}

export type RecoveryCheckpoint = {
  baseMessages: ModelMessage[];
  suffixMessages: ModelMessage[];
};

export function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(cloneMessage);
}

export function recoveryCheckpointForMessages(
  messages: readonly ModelMessage[],
): RecoveryCheckpoint {
  const truncated = truncateToLastValidBoundary([...messages]);
  const baseMessages = cloneMessages(truncated.messages);
  if (truncated.droppedMessageCount === 0) return { baseMessages, suffixMessages: [] };

  const assistant = messages[baseMessages.length];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    return { baseMessages, suffixMessages: [] };
  }
  const completedToolCallIds = new Set(getToolResultToolCallIds(assistant));
  for (const message of messages.slice(baseMessages.length + 1)) {
    for (const toolCallId of getToolResultToolCallIds(message))
      completedToolCallIds.add(toolCallId);
  }
  const assistantContent = assistant.content.filter(
    (part) => part.type !== "tool-call" || completedToolCallIds.has(part.toolCallId),
  );
  const suffixMessages: ModelMessage[] = [];
  if (assistantContent.length > 0) {
    suffixMessages.push({
      ...assistant,
      content: assistantContent.map((part) => Object.assign({}, part)),
    });
  }
  for (const message of messages.slice(baseMessages.length + 1)) {
    if (message.role !== "tool") continue;
    const content = message.content
      .filter((part) => part.type === "tool-result" && completedToolCallIds.has(part.toolCallId))
      .map((part) => ({ ...part }));
    if (content.length > 0) suffixMessages.push({ ...message, content });
  }
  return { baseMessages, suffixMessages };
}

export function hasInlineToolResult(message: ModelMessage): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "tool-result")
  );
}

export function recoveryToolOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") return { type: "text", value };
  if (isRecord(value)) {
    if (value.type === "text" && typeof value.value === "string") {
      return { type: "text", value: value.value };
    }
    if (value.type === "error-text" && typeof value.value === "string") {
      return { type: "error-text", value: value.value };
    }
    if (value.type === "execution-denied") {
      return {
        type: "execution-denied",
        reason: typeof value.reason === "string" ? value.reason : undefined,
      };
    }
  }
  const serialized = resultOutcome(
    captureAgentOperation(() => JSON.stringify(value) ?? String(value)),
  );
  if (serialized.ok) return { type: "text", value: serialized.value };
  rethrowAgentPanic(serialized.error);
  return { type: "text", value: String(value) };
}

export function truncateToLastValidBoundary(messages: ModelMessage[]): {
  messages: ModelMessage[];
  droppedMessageCount: number;
} {
  let lastValidIndex = -1;
  let openToolCallIds: Set<string> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (openToolCallIds) {
      if (message.role !== "tool") {
        break;
      }

      for (const toolCallId of getToolResultToolCallIds(message)) {
        openToolCallIds.delete(toolCallId);
      }

      if (openToolCallIds.size === 0) {
        openToolCallIds = null;
        lastValidIndex = i;
      }

      continue;
    }

    if (message.role === "tool") {
      break;
    }

    const toolCallIds = getUnresolvedAssistantToolCallIds(message);
    if (toolCallIds.length > 0) {
      openToolCallIds = new Set(toolCallIds);
      continue;
    }

    lastValidIndex = i;
  }

  const nextLength = lastValidIndex + 1;
  return {
    messages: messages.slice(0, nextLength),
    droppedMessageCount: messages.length - nextLength,
  };
}

export type AiSdkPiAgentEvent<TOOLS extends ToolSet = ToolSet> = AgentEvent<TOOLS>;
export type AiSdkPiAssistantMessageEvent<TOOLS extends ToolSet = ToolSet> =
  AgentAssistantMessageEvent<TOOLS>;

export function canonicalToolName(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "edit_file":
      return "edit";
    case "apply_patch":
      return "patch";
    default:
      return name;
  }
}

export function stripToolExecuteForModel<TOOLS extends ToolSet>(tools: TOOLS): ToolSet {
  // We keep the schema/description/title so the model can call tools,
  // but remove execution so we can run tools ourselves (enables steering).
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const {
        execute: _execute,
        needsApproval: _needsApproval,
        contextSchema: _contextSchema,
        ...rest
      } = tool;
      return [name, rest];
    }),
  ) as ToolSet;
}
