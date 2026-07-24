/*
  ai-sdk-pi-agent.ts

  Demo wrapper that provides a pi-agent-like DX (event stream + steering/follow-up queues)
  on top of AI SDK `streamText().stream`.

  This is intentionally self-contained and not part of any package.
*/

import {
  type CallWarning,
  type Experimental_DownloadFunction as DownloadFunction,
  streamText,
  type AssistantContent,
  type AssistantModelMessage,
  type FinishReason,
  InvalidToolInputError,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type TextStreamPart,
  type Tool,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import {
  createLogger,
  errorMessage,
  type ModelReasoningEffort,
  normalizeReplayMessages,
  normalizeAssistantToolCallInputMessage,
  normalizeToolCallInputValue,
} from "@stanley2058/lilac-utils";

import { normalizeModelMessagesToolCallIds } from "./tool-call-id-normalization";
import { isToolExpansion, type ExpandedToolCall, type ToolExpansion } from "./tool-call-expansion";

const logger = createLogger({ module: "ai-sdk-pi-agent" });
const UNSERIALIZABLE_TOOL_RESULT = "[tool result is not JSON-serializable]";

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

/** Outcome of requesting an immediate interrupt from the current steering queue. */
export type InterruptQueuedSteeringResult =
  | { status: "interrupted"; steeringIds: SteeringQueueId[] }
  | { status: "empty" }
  | { status: "inactive" };

/**
 * Fine-grained events emitted while an assistant message is streaming.
 *
 * These are derived from AI SDK `streamText(...).stream` parts.
 */
export type AiSdkPiAssistantMessageEvent<TOOLS extends ToolSet> =
  | {
      type: "text_start";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-start" }>;
    }
  | {
      type: "text_delta";
      id: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-delta" }>;
    }
  | {
      type: "text_end";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "text-end" }>;
    }
  | {
      type: "thinking_start";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-start" }>;
    }
  | {
      type: "thinking_delta";
      id: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-delta" }>;
    }
  | {
      type: "thinking_end";
      id: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-end" }>;
    }
  | {
      type: "toolcall_start";
      toolCallId: string;
      toolName: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-start" }>;
    }
  | {
      type: "toolcall_delta";
      toolCallId: string;
      delta: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-delta" }>;
    }
  | {
      type: "toolcall_end";
      toolCallId: string;
      raw: Extract<TextStreamPart<TOOLS>, { type: "tool-input-end" }>;
    }
  | {
      type: "custom";
      raw: Extract<TextStreamPart<TOOLS>, { type: "custom" }>;
    }
  | {
      type: "source";
      raw: Extract<TextStreamPart<TOOLS>, { type: "source" }>;
    }
  | {
      type: "file";
      raw: Extract<TextStreamPart<TOOLS>, { type: "file" }>;
    }
  | {
      type: "reasoning_file";
      raw: Extract<TextStreamPart<TOOLS>, { type: "reasoning-file" }>;
    };

/** Why a turn ended without producing a `turn_end`. */
export type TurnAbortReason = "cancel" | "interrupt" | "manual";

/** Where the abort occurred: model streaming vs tool execution. */
export type TurnAbortPhase = "model" | "tools";

/**
 * High-level event stream for building a `pi-agent`-style UI.
 *
 * Downstream should treat `messages_reset` as authoritative and replace any
 * locally accumulated transcript state when it occurs.
 */
export type AiSdkPiAgentEvent<TOOLS extends ToolSet> =
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
      reason: "cancel" | "interrupt";
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
      assistantMessageEvent: AiSdkPiAssistantMessageEvent<TOOLS>;
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
export interface AiSdkPiAgentState<TOOLS extends ToolSet> {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
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

type JSONArray = JSONValue[];
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type TransformMessagesContext = {
  /** The system prompt that will be sent via `streamText({ system })`. */
  system: SystemPrompt;
  /** Abort signal for this turn (if present). */
  abortSignal?: AbortSignal;
};

/**
 * Hook to transform the outbound `messages` array right before a model call.
 *
 * This is outbound-only: it affects what the model sees for this turn, but does
 * not rewrite the canonical transcript in `state.messages`.
 */
export type TransformMessagesFn = (
  messages: readonly ModelMessage[],
  context: TransformMessagesContext,
) => ModelMessage[] | Promise<ModelMessage[]>;

export type TurnErrorHandlerDecision = "retry" | "fail";

export type TurnRetrySafety =
  | { canRetry: true }
  | {
      canRetry: false;
      reason: "invalid-transcript-boundary" | "post-model-phase" | "provider-executed-tool";
    };

export type TurnErrorHandler = (
  error: unknown,
  context: {
    abortSignal?: AbortSignal;
    retrySafety: TurnRetrySafety;
  },
) => TurnErrorHandlerDecision | Promise<TurnErrorHandlerDecision>;

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

export type ToolResultOutput = Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
>["output"];

export type NormalizeToolResultOutputFn = (
  output: ToolResultOutput,
  context: {
    toolCallId: string;
    toolName: string;
    bypassGenericOutputNormalizer?: boolean;
  },
) => ToolResultOutput | Promise<ToolResultOutput>;

export type AiSdkPiAgentOptions<TOOLS extends ToolSet> = {
  /** System prompt for the model. */
  system: SystemPrompt;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
  /** Optional canonical model spec (`provider/model`). */
  modelSpecifier?: string;
  /** Optional toolset (defaults to empty). */
  tools?: TOOLS;
  /** Optional initial transcript (defaults to empty). */
  messages?: ModelMessage[];
  /**
   * Optional hook to transform the outbound context before each model call.
   *
   * The hook sees the exact message list that would be sent to the model,
   * including any messages injected by `steer()`/`followUp()` and tool results.
   */
  transformMessages?: TransformMessagesFn;
  /** Optional hook to recover from turn errors (e.g. context overflow). */
  turnErrorHandler?: TurnErrorHandler;
  /** Inject messages after tools finish and before the next model turn. */
  turnBoundaryHandler?: TurnBoundaryHandler;
  /** Normalize model-facing tool output before it enters the canonical transcript. */
  normalizeToolResultOutput?: NormalizeToolResultOutputFn;
  /** Tool names whose specs guarantee already-bounded model output. */
  genericOutputNormalizerBypassTools?: ReadonlySet<string>;
  /** When any of these tools are called, other tools in the same model turn are rejected. */
  exclusiveToolNames?: ReadonlySet<string>;
  /** Optional provider-specific options. */
  providerOptions?: {
    [x: string]: JSONObject;
  };
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;

  /** Optional custom URL download hook forwarded to AI SDK. */
  experimentalDownload?: DownloadFunction;

  /** Optional debug features. */
  debug?: {
    /** Capture and store model-view messages per turn (can be large). */
    captureModelViewMessages?: boolean;
  };
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function isInvalidToolInputError(error: unknown): boolean {
  if (InvalidToolInputError.isInstance(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError") return true;
  return isInvalidToolInputError(error.cause);
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((p) => ({ ...p }))
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

function sumOptionalNumber(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function sumLanguageModelUsage(
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

function takeQueued<T>(mode: "one-at-a-time" | "all", queue: T[]): T[] {
  if (queue.length === 0) return [];
  if (mode === "one-at-a-time") {
    return [queue.shift()!];
  }
  const out = queue.slice();
  queue.length = 0;
  return out;
}

function takeAll<T>(queue: T[]): T[] {
  if (queue.length === 0) return [];
  const out = queue.slice();
  queue.length = 0;
  return out;
}

function makeUserMessage(input: string | ModelMessage): ModelMessage {
  if (typeof input === "string") {
    return { role: "user", content: input };
  }
  return input;
}

function mergeUserMessages(messages: ModelMessage[]): ModelMessage[] {
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

function stripToolExecuteForModel<TOOLS extends ToolSet>(tools: TOOLS): ToolSet {
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

type AssistantContentParts = Extract<AssistantContent, unknown[]>;
type JsonToolOutputValue = Extract<ToolResultOutput, { type: "json" }>["value"];

function isJsonToolOutputValue(value: unknown): value is JsonToolOutputValue {
  return isJsonToolOutputValueInner(value, new WeakSet<object>());
}

function isJsonToolOutputValueInner(
  value: unknown,
  activeObjects: WeakSet<object>,
): value is JsonToolOutputValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (activeObjects.has(value)) return false;
      activeObjects.add(value);
      try {
        const values = Array.isArray(value) ? value : Object.values(value);
        return values.every((item) => isJsonToolOutputValueInner(item, activeObjects));
      } catch {
        return false;
      } finally {
        activeObjects.delete(value);
      }
    default:
      return false;
  }
}

function toJsonToolOutputValue(value: unknown): JsonToolOutputValue {
  if (typeof value === "undefined") return null;
  if (isJsonToolOutputValue(value)) return value;

  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    if (isJsonToolOutputValue(parsed)) return parsed;
  } catch {
    // Fall through to the stable string representation.
  }

  return String(value);
}

function upsertTextPart(
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

class TurnAbortedError extends Error {
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

function getAssistantToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-call" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool") return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-result" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function truncateToLastValidBoundary(messages: ModelMessage[]): {
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

    const toolCallIds = getAssistantToolCallIds(message);
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

/**
 * A small wrapper that provides a `pi-agent`-style event stream on top of
 * AI SDK `streamText(...).stream`.
 *
 * Notable behavior:
 * - The model can emit tool calls, but tools are executed locally by this wrapper.
 * - `steer()` is injected at turn boundaries (after the current tool phase).
 * - `interrupt()` aborts, rewinds to a valid boundary, appends a message, and reruns.
 */
export class AiSdkPiAgent<TOOLS extends ToolSet = ToolSet> {
  private listeners = new Set<(event: AiSdkPiAgentEvent<TOOLS>) => void>();
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  private turnCounter = 0;
  private readonly captureModelViewMessages: boolean;

  private steeringMode: SteeringMode = "one-at-a-time";
  private followUpMode: FollowUpMode = "one-at-a-time";
  private nextSteeringId = 1;
  private steeringQueue: Array<{ id: SteeringQueueId; message: ModelMessage }> = [];
  private followUpQueue: ModelMessage[] = [];

  private pendingInterrupt: ModelMessage[] | null = null;
  private cancelResetPending = false;
  private abortRequestedReason: TurnAbortReason | null = null;

  private transformMessages: TransformMessagesFn | undefined;
  private turnErrorHandler: TurnErrorHandler | undefined;
  private turnBoundaryHandler: TurnBoundaryHandler | undefined;
  private experimentalDownload: DownloadFunction | undefined;
  private normalizeToolResultOutput: NormalizeToolResultOutputFn | undefined;
  private genericOutputNormalizerBypassTools: ReadonlySet<string>;
  private exclusiveToolNames: ReadonlySet<string>;

  private context?: unknown;

  /** Live execution and transcript state. */
  readonly state: AiSdkPiAgentState<TOOLS>;

  /** Create a new agent instance. */
  constructor(options: AiSdkPiAgentOptions<TOOLS>) {
    this.transformMessages = options.transformMessages;
    this.turnErrorHandler = options.turnErrorHandler;
    this.turnBoundaryHandler = options.turnBoundaryHandler;
    this.experimentalDownload = options.experimentalDownload;
    this.normalizeToolResultOutput = options.normalizeToolResultOutput;
    this.genericOutputNormalizerBypassTools =
      options.genericOutputNormalizerBypassTools ?? new Set<string>();
    this.exclusiveToolNames = options.exclusiveToolNames ?? new Set<string>();

    this.captureModelViewMessages = options.debug?.captureModelViewMessages === true;

    this.state = {
      system: options.system,
      model: options.model,
      modelSpecifier: options.modelSpecifier,
      tools: (options.tools ?? ({} as TOOLS)) as TOOLS,
      messages: normalizeReplayMessages(options.messages ?? []),
      providerOptions: options.providerOptions,
      reasoning: options.reasoning,
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set<string>(),
      debug: this.captureModelViewMessages ? {} : undefined,
    };
  }

  /** Subscribe to streaming events. Returns an unsubscribe function. */
  subscribe(listener: (event: AiSdkPiAgentEvent<TOOLS>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AiSdkPiAgentEvent<TOOLS>) {
    // Avoid relying on Set iteration config (keeps this file tsconfig-agnostic).
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /** Replace the system prompt used for subsequent turns. */
  setSystem(system: SystemPrompt) {
    this.state.system = system;
  }

  /** Replace the model used for subsequent turns. */
  setModel(
    model: LanguageModel,
    providerOptions?: { [x: string]: JSONObject },
    modelSpecifier?: string,
    reasoning?: ModelReasoningEffort,
  ) {
    this.state.model = model;
    this.state.modelSpecifier = modelSpecifier;

    // (When not provided) Reset provider options in case incompatible.
    this.state.providerOptions = providerOptions;
    this.state.reasoning = reasoning;
  }

  /** Replace the toolset used for subsequent turns. */
  setTools(tools: TOOLS) {
    this.state.tools = tools;
  }

  /** Replace the tool context used for subsequent turns. */
  setContext(context: unknown) {
    this.context = context;
  }

  /** Replace the outbound message transform hook. */
  setTransformMessages(transformMessages: TransformMessagesFn | undefined) {
    this.transformMessages = transformMessages;
  }

  /** Append an outbound transform without replacing an existing transform. */
  appendTransformMessages(transformMessages: TransformMessagesFn) {
    const previous = this.transformMessages;
    this.transformMessages = previous
      ? async (messages, context) => transformMessages(await previous(messages, context), context)
      : transformMessages;
  }

  /** Replace the turn-error recovery hook. */
  setTurnErrorHandler(turnErrorHandler: TurnErrorHandler | undefined) {
    this.turnErrorHandler = turnErrorHandler;
  }

  /** Replace the post-tool, pre-model turn-boundary hook. */
  setTurnBoundaryHandler(turnBoundaryHandler: TurnBoundaryHandler | undefined) {
    this.turnBoundaryHandler = turnBoundaryHandler;
  }

  /** Replace the entire transcript. Use with care. */
  replaceMessages(messages: ModelMessage[], options?: { reason?: "replace" | "compaction" }) {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      throw new Error(
        "Cannot replace messages during a turn. Wait for the current model/tool step to finish.",
      );
    }

    const previousMessageCount = this.state.messages.length;
    this.state.messages = normalizeReplayMessages(messages);
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();

    this.emit({
      type: "messages_reset",
      reason: options?.reason ?? "replace",
      messages: this.state.messages.map(cloneMessage),
      previousMessageCount,
    });
  }

  /** Append messages to the existing transcript while idle. */
  appendMessages(messages: ModelMessage[]) {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      throw new Error(
        "Cannot append messages during a turn. Wait for the current model/tool step to finish.",
      );
    }

    for (const message of messages) {
      this.appendMessage(message);
    }
  }

  /** Clear the transcript. */
  clearMessages() {
    this.replaceMessages([], { reason: "replace" });
  }

  /** Configure how `steer()` messages are drained. */
  setSteeringMode(mode: SteeringMode) {
    this.steeringMode = mode;
  }

  /** Configure how `followUp()` messages are drained. */
  setFollowUpMode(mode: FollowUpMode) {
    this.followUpMode = mode;
  }

  /**
   * Queue a steering message.
   *
   * Steering is checked at turn boundaries. If a turn is executing tools,
   * queued steering messages are injected after the current tool phase completes.
   */
  steer(message: string | ModelMessage): SteeringQueueId {
    const id = `steering-${this.nextSteeringId++}`;
    this.steeringQueue.push({ id, message: makeUserMessage(message) });
    return id;
  }

  /** Snapshot entries that have not yet been drained at a steering boundary. */
  getQueuedSteeringIds(): SteeringQueueId[] {
    return this.steeringQueue.map((entry) => entry.id);
  }

  /**
   * Queue a follow-up user message.
   *
   * Follow-ups are only injected when a turn finishes without tool calls.
   */
  followUp(message: string | ModelMessage) {
    this.followUpQueue.push(makeUserMessage(message));
  }

  /**
   * Interrupt the active turn with a snapshot of every currently queued steering message.
   *
   * Buffered follow-ups are included ahead of steering messages, matching normal
   * steering-boundary behavior. Queued steering is left untouched while idle.
   */
  interruptQueuedSteering(): InterruptQueuedSteeringResult {
    if (this.steeringQueue.length === 0) return { status: "empty" };
    if (!this.state.isStreaming || this.cancelResetPending) return { status: "inactive" };

    const steering = takeAll(this.steeringQueue);
    const followUps = takeAll(this.followUpQueue);
    const pendingInterrupt = this.pendingInterrupt;
    this.pendingInterrupt = mergeUserMessages([
      ...(pendingInterrupt ?? []),
      ...followUps,
      ...steering.map((entry) => entry.message),
    ]);
    if (!pendingInterrupt) this.requestAbort("interrupt");

    return {
      status: "interrupted",
      steeringIds: steering.map((entry) => entry.id),
    };
  }

  private requestAbort(reason: TurnAbortReason) {
    if (reason === "cancel") {
      this.abortRequestedReason = "cancel";
    } else if (reason === "interrupt" && this.abortRequestedReason !== "cancel") {
      this.abortRequestedReason = "interrupt";
    } else if (!this.abortRequestedReason) {
      this.abortRequestedReason = "manual";
    }

    this.abortController?.abort();
  }

  private takePendingInterrupt(): ModelMessage[] | null {
    const messages = this.pendingInterrupt;
    this.pendingInterrupt = null;
    return messages;
  }

  /**
   * Abort the current run.
   *
   * Emits `turn_abort` (reason: `manual`) and ends the agent loop without
   * rewinding the transcript.
   */
  abort() {
    this.requestAbort("manual");
  }

  /**
   * Cancel the current run without adding a message.
   *
   * Cancellation clears queued work and rewinds the transcript to its last valid
   * boundary. A `messages_reset` event with reason `cancel` is authoritative.
   */
  cancel() {
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.pendingInterrupt = null;

    if (!this.state.isStreaming) {
      this.finishCancellation();
      return;
    }

    this.cancelResetPending = true;
    this.requestAbort("cancel");
  }

  /**
   * Interrupt the current run.
   *
   * Behavior:
   * - If streaming: abort, emit `turn_abort`/`messages_reset`, append the message, rerun.
   * - If idle: falls back to `prompt(message)`.
   *
   * Only one interrupt may be pending at a time; a second call throws.
   */
  async interrupt(message: string | ModelMessage) {
    if (!this.state.isStreaming) {
      await this.prompt(message);
      return;
    }

    if (this.pendingInterrupt) {
      throw new Error("Interrupt already pending");
    }

    this.pendingInterrupt = [makeUserMessage(message)];
    this.requestAbort("interrupt");
  }

  /** Wait until the agent finishes processing (or aborts/errors). */
  async waitForIdle() {
    await this.running;
  }

  /**
   * Start a new agent run by appending message(s) and executing turns until done.
   */
  async prompt(input: string | ModelMessage | ModelMessage[]) {
    if (this.state.isStreaming) {
      throw new Error("Agent is already processing. Use steer() or followUp(), or waitForIdle().");
    }

    const newMessages = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? [makeUserMessage(input)]
        : [input];

    await this.runLoop({ newMessages });
  }

  /**
   * Continue from the current transcript.
   *
   * The last message must not be an assistant message.
   */
  async continue() {
    if (this.state.isStreaming) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const messages = this.state.messages;
    if (messages.length === 0) throw new Error("No messages to continue from");
    const last = messages[messages.length - 1]!;
    if (last.role === "assistant") throw new Error("Cannot continue from assistant message");

    await this.runLoop({ newMessages: undefined });
  }

  private appendMessage(message: ModelMessage) {
    const normalizedMessage = normalizeAssistantToolCallInputMessage(message);
    this.state.messages.push(normalizedMessage);
    this.emit({ type: "message_start", message: cloneMessage(normalizedMessage) });
    this.emit({ type: "message_end", message: cloneMessage(normalizedMessage) });
  }

  private async normalizeToolOutput(
    output: ToolResultOutput,
    context: Parameters<NormalizeToolResultOutputFn>[1],
  ): Promise<ToolResultOutput> {
    if (!this.normalizeToolResultOutput) return output;

    try {
      return await this.normalizeToolResultOutput(output, context);
    } catch (error) {
      logger.warn("tool result normalization failed", {
        toolCallId: context.toolCallId,
        toolName: context.toolName,
        error: errorMessage(error),
      });
      return { type: "error-text", value: UNSERIALIZABLE_TOOL_RESULT };
    }
  }

  private async normalizeNewToolMessage(message: ToolModelMessage): Promise<ToolModelMessage> {
    if (!this.normalizeToolResultOutput) return message;

    const content: ToolModelMessage["content"] = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      content.push({
        ...part,
        output: await this.normalizeToolOutput(part.output, {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        }),
      });
    }
    return { ...message, content };
  }

  private resetMessagesAfterAbort(reason: "cancel" | "interrupt") {
    const truncated = truncateToLastValidBoundary(this.state.messages);
    this.state.messages = truncated.messages;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();

    this.emit({
      type: "messages_reset",
      reason,
      messages: this.state.messages.map(cloneMessage),
      droppedMessageCount: truncated.droppedMessageCount,
    });
  }

  private finishCancellation() {
    this.resetMessagesAfterAbort("cancel");
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
    this.pendingInterrupt = null;
    this.cancelResetPending = false;
  }

  private async runLoop(options: { newMessages: ModelMessage[] | undefined }) {
    this.state.isStreaming = true;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.state.error = undefined;

    this.abortController = new AbortController();
    this.abortRequestedReason = null;

    this.running = (async () => {
      this.emit({ type: "agent_start" });

      let runTotalUsage: LanguageModelUsage | undefined = undefined;

      try {
        if (options.newMessages) {
          for (const msg of options.newMessages) {
            this.appendMessage(msg);
          }
        }

        while (true) {
          if (this.cancelResetPending) {
            this.emit({ type: "turn_abort", reason: "cancel", phase: "tools" });
            this.finishCancellation();
            break;
          }

          // Handle "interrupt" that arrived between awaited operations.
          if (this.pendingInterrupt) {
            const interruptMessages = this.takePendingInterrupt();
            if (!interruptMessages) continue;

            this.emit({
              type: "turn_abort",
              reason: "interrupt",
              phase: "tools",
            });

            this.resetMessagesAfterAbort("interrupt");
            if (this.cancelResetPending) {
              this.finishCancellation();
              break;
            }
            for (const message of interruptMessages) this.appendMessage(message);

            // The current abort signal is consumed; create a fresh one.
            this.abortController = new AbortController();
            this.abortRequestedReason = null;
          } else if (this.abortController?.signal.aborted) {
            // Manual abort between turns.
            const reason: TurnAbortReason = this.abortRequestedReason ?? "manual";
            this.emit({ type: "turn_abort", reason, phase: "tools" });
            break;
          }

          let modelTurnCompleted = false;
          let providerExecutedToolObserved = false;
          const localToolDraftIds = new Set<string>();

          try {
            const turn = await this.runTurn({
              onProviderExecutedTool: () => {
                providerExecutedToolObserved = true;
              },
              onLocalToolDraft: (toolCallId) => {
                localToolDraftIds.add(toolCallId);
              },
            });
            modelTurnCompleted = true;
            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "model" });
            }

            for (const added of turn.newMessages) {
              this.state.messages.push(added);
            }

            runTotalUsage = sumLanguageModelUsage(runTotalUsage, turn.totalUsage);

            this.emit({
              type: "turn_end",
              finishReason: turn.finishReason,
              newMessages: turn.newMessages.map(cloneMessage),
              usage: turn.usage,
              totalUsage: turn.totalUsage,
            });

            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "tools" });
            }

            const hasLocalToolCalls =
              turn.finishReason === "tool-calls" && turn.toolCalls.length > 0;
            // AI SDK materializes rejected tool inputs as completed tool results.
            // Continue so the model can inspect the validation error and retry.
            const hasCompletedToolExchange =
              turn.finishReason === "tool-calls" && turn.newMessages.at(-1)?.role === "tool";
            const executedToolCallCount = hasLocalToolCalls
              ? await this.executeToolCalls(turn.toolCalls)
              : 0;

            const boundaryDecision = await this.applyTurnBoundary({
              finishReason: turn.finishReason,
              modelInputMessages: turn.modelInputMessages,
              executedToolCallCount,
            });

            if (this.cancelResetPending) {
              throw new TurnAbortedError({ reason: "cancel", phase: "tools" });
            }
            if (this.pendingInterrupt) continue;

            // Steering should pick up any buffered follow-ups and remains ahead of
            // the normal tool-result continuation decision.
            const steeringNow = takeQueued(this.steeringMode, this.steeringQueue);
            if (steeringNow.length > 0) {
              const followUpsAll = takeAll(this.followUpQueue);
              const merged = mergeUserMessages([
                ...followUpsAll,
                ...steeringNow.map((entry) => entry.message),
              ]);
              for (const msg of merged) {
                this.appendMessage(msg);
              }
              continue;
            }

            if (turn.finishReason !== "tool-calls") {
              const followUps = takeQueued(this.followUpMode, this.followUpQueue);
              if (followUps.length > 0) {
                const merged = mergeUserMessages(followUps);
                for (const msg of merged) {
                  this.appendMessage(msg);
                }
                continue;
              }
            }

            if (
              hasLocalToolCalls ||
              hasCompletedToolExchange ||
              boundaryDecision.requiresNextTurn
            ) {
              continue;
            }

            break;
          } catch (err) {
            if (err instanceof TurnAbortedError) {
              this.emit({
                type: "turn_abort",
                reason: err.reason,
                phase: err.phase,
                detail: err.detail,
              });

              if (this.cancelResetPending && err.reason !== "cancel") {
                this.finishCancellation();
                break;
              }

              if (err.reason === "interrupt") {
                const interruptMessages = this.takePendingInterrupt();

                if (!interruptMessages) {
                  break;
                }

                this.resetMessagesAfterAbort("interrupt");
                if (this.cancelResetPending) {
                  this.finishCancellation();
                  break;
                }
                for (const message of interruptMessages) this.appendMessage(message);

                // The current abort signal is consumed; create a fresh one.
                this.abortController = new AbortController();
                this.abortRequestedReason = null;

                continue;
              }

              if (err.reason === "cancel") {
                this.finishCancellation();
                break;
              }

              // Manual abort: stop agent loop cleanly.
              break;
            }

            if (this.cancelResetPending) {
              this.emit({
                type: "turn_abort",
                reason: "cancel",
                phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
                detail: err instanceof Error ? err.message : String(err),
              });
              this.finishCancellation();
              break;
            }

            if (this.turnErrorHandler) {
              const lastMessage = this.state.messages.at(-1);
              const retrySafety: TurnRetrySafety = modelTurnCompleted
                ? { canRetry: false, reason: "post-model-phase" }
                : providerExecutedToolObserved
                  ? { canRetry: false, reason: "provider-executed-tool" }
                  : lastMessage?.role === "assistant" || this.state.pendingToolCalls.size > 0
                    ? { canRetry: false, reason: "invalid-transcript-boundary" }
                    : { canRetry: true };
              let decision: TurnErrorHandlerDecision | undefined;
              try {
                decision = await this.turnErrorHandler(err, {
                  abortSignal: this.abortController?.signal,
                  retrySafety,
                });
              } catch (handlerError) {
                if (
                  !this.cancelResetPending &&
                  !this.pendingInterrupt &&
                  !this.abortController?.signal.aborted
                ) {
                  throw handlerError;
                }
              }
              if (this.cancelResetPending) {
                this.emit({
                  type: "turn_abort",
                  reason: "cancel",
                  phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
                });
                this.finishCancellation();
                break;
              }
              if (this.pendingInterrupt || this.abortController?.signal.aborted) {
                continue;
              }
              if (decision === "retry" && retrySafety.canRetry) {
                const hadPartialOutput = this.state.streamMessage !== null;
                this.state.streamMessage = null;
                this.emit({
                  type: "turn_retry",
                  hadPartialOutput,
                  abandonedToolCallIds: [...localToolDraftIds],
                });
                continue;
              }
            }

            throw err;
          }
        }

        this.emit({
          type: "agent_end",
          messages: this.state.messages.map(cloneMessage),
          totalUsage: runTotalUsage,
        });
      } catch (err) {
        this.state.error = err instanceof Error ? err.message : String(err);
        this.emit({
          type: "agent_end",
          messages: this.state.messages.map(cloneMessage),
          totalUsage: runTotalUsage,
        });
        throw err;
      } finally {
        this.state.isStreaming = false;
        this.state.streamMessage = null;
        this.state.pendingToolCalls = new Set();
        this.abortController = undefined;
        this.abortRequestedReason = null;
        this.pendingInterrupt = null;
        if (this.cancelResetPending) {
          this.steeringQueue.length = 0;
          this.followUpQueue.length = 0;
        }
        this.cancelResetPending = false;
      }
    })();

    await this.running;
  }

  private async runTurn(params: {
    onProviderExecutedTool: () => void;
    onLocalToolDraft: (toolCallId: string) => void;
  }): Promise<{
    finishReason: FinishReason;
    newMessages: ModelMessage[];
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid?: boolean;
      error?: unknown;
    }>;
    usage: LanguageModelUsage;
    totalUsage: LanguageModelUsage;
    modelInputMessages: ModelMessage[];
  }> {
    this.emit({ type: "turn_start" });

    const turnIndex = ++this.turnCounter;

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

    const abortSignal = this.abortController?.signal;

    let messagesForModel = normalizeReplayMessages(this.state.messages.map(cloneMessage));
    if (this.transformMessages) {
      if (abortSignal?.aborted) {
        throw new TurnAbortedError({
          reason: getAbortReason(),
          phase: "model",
        });
      }

      messagesForModel = await this.transformMessages(messagesForModel, {
        system: this.state.system,
        abortSignal,
      });

      messagesForModel = normalizeReplayMessages(messagesForModel);

      if (abortSignal?.aborted) {
        throw new TurnAbortedError({
          reason: getAbortReason(),
          phase: "model",
        });
      }
    }

    messagesForModel = normalizeModelMessagesToolCallIds({
      messages: messagesForModel,
      modelSpecifier: this.state.modelSpecifier,
    });

    if (this.captureModelViewMessages) {
      const cloned = messagesForModel.map(cloneMessage);
      this.state.debug ??= {};
      this.state.debug.lastModelViewMessages = cloned;
      this.state.debug.lastModelViewTurn = turnIndex;
      this.state.debug.lastModelViewCapturedAt = Date.now();
    }

    const lastMessage =
      messagesForModel.length > 0 ? messagesForModel[messagesForModel.length - 1] : undefined;
    if (lastMessage?.role === "assistant") {
      throw new Error(
        "transformMessages produced an invalid outbound context: last message is assistant.",
      );
    }

    const toolsForModel = stripToolExecuteForModel(this.state.tools);
    const result = streamText({
      model: this.state.model,
      instructions: this.state.system,
      messages: messagesForModel,
      tools: toolsForModel,
      reasoning: this.state.reasoning,
      providerOptions: this.state.providerOptions,
      experimental_download: this.experimentalDownload,
      abortSignal,
      onError: () => {},
    });

    let assistantStarted = false;
    let partialAssistant: Omit<AssistantModelMessage, "content"> & {
      content: Exclude<AssistantContent, string>;
    } = {
      role: "assistant",
      content: [],
    };
    // Tool calls observed in `stream` may still have raw/unvalidated JSON.
    // They are useful for UI events, but we must execute tools only from the
    // finalized `response.messages` (post-parse + schema validation).

    let aborted = false;

    for await (const part of result.stream) {
      if (part.type === "abort") {
        aborted = true;
        break;
      }
      if (part.type === "start-step") {
        continue;
      }

      if (
        !assistantStarted &&
        (part.type === "text-start" ||
          part.type === "text-delta" ||
          part.type === "reasoning-start" ||
          part.type === "reasoning-delta" ||
          part.type === "tool-input-start" ||
          part.type === "tool-input-delta" ||
          part.type === "tool-call" ||
          part.type === "custom" ||
          part.type === "source" ||
          part.type === "file" ||
          part.type === "reasoning-file")
      ) {
        assistantStarted = true;
        this.state.streamMessage = partialAssistant;
        this.emit({
          type: "message_start",
          message: cloneMessage(partialAssistant),
        });
      }

      switch (part.type) {
        case "text-start": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_start",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "text-delta": {
          upsertTextPart(partialAssistant.content, "text", part.text);
          this.state.streamMessage = partialAssistant;
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_delta",
              id: part.id,
              delta: part.text,
              raw: part,
            },
          });
          break;
        }
        case "text-end": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "text_end",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-start": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_start",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-delta": {
          upsertTextPart(partialAssistant.content, "reasoning", part.text);
          this.state.streamMessage = partialAssistant;
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_delta",
              id: part.id,
              delta: part.text,
              raw: part,
            },
          });
          break;
        }
        case "reasoning-end": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "thinking_end",
              id: part.id,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-start": {
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          } else {
            params.onLocalToolDraft(part.id);
          }
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_start",
              toolCallId: part.id,
              toolName: part.toolName,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-delta": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_delta",
              toolCallId: part.id,
              delta: part.delta,
              raw: part,
            },
          });
          break;
        }
        case "tool-input-end": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: {
              type: "toolcall_end",
              toolCallId: part.id,
              raw: part,
            },
          });
          break;
        }
        case "custom": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "custom", raw: part },
          });
          break;
        }
        case "source": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "source", raw: part },
          });
          break;
        }
        case "file": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "file", raw: part },
          });
          break;
        }
        case "reasoning-file": {
          this.emit({
            type: "message_update",
            message: cloneMessage(partialAssistant),
            assistantMessageEvent: { type: "reasoning_file", raw: part },
          });
          break;
        }
        case "tool-call": {
          const { toolCallId, toolName, input } = part;
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          } else {
            params.onLocalToolDraft(toolCallId);
          }
          partialAssistant.content.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: normalizeToolCallInputValue(input),
            providerExecuted: part.providerExecuted,
          });
          this.state.streamMessage = partialAssistant;
          break;
        }
        case "tool-result":
        case "tool-error":
        case "tool-output-denied":
        case "tool-approval-response": {
          if (part.providerExecuted === true) {
            params.onProviderExecutedTool();
          }
          break;
        }
        case "tool-approval-request": {
          if (part.toolCall.providerExecuted === true) {
            params.onProviderExecutedTool();
          }
          break;
        }
        case "error": {
          throw part.error;
        }
        default:
          break;
      }
    }

    if (aborted) {
      if (assistantStarted) {
        this.emit({
          type: "message_end",
          message: cloneMessage(partialAssistant),
        });
      }
      this.state.streamMessage = null;

      const reason: TurnAbortReason =
        this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

      throw new TurnAbortedError({ reason, phase: "model" });
    }

    let response: Awaited<typeof result.response>;
    let finishReason: FinishReason;
    let usage: LanguageModelUsage;
    let totalUsage: LanguageModelUsage;
    let warnings: CallWarning[] | undefined;
    try {
      response = await result.response;
      finishReason = await result.finishReason;
      usage = await result.usage;
      totalUsage = await result.totalUsage;
      warnings = await result.warnings;
    } catch (e) {
      if (this.abortController?.signal.aborted) {
        if (assistantStarted) {
          this.emit({
            type: "message_end",
            message: cloneMessage(partialAssistant),
          });
        }
        this.state.streamMessage = null;

        const reason: TurnAbortReason =
          this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

        throw new TurnAbortedError({ reason, phase: "model" });
      }
      throw e;
    }

    if (warnings && warnings.length > 0) {
      this.emit({
        type: "turn_warnings",
        warnings,
      });
    }

    const newMessages: ModelMessage[] = [];
    for (const message of normalizeReplayMessages(response.messages)) {
      newMessages.push(
        message.role === "tool" ? await this.normalizeNewToolMessage(message) : message,
      );
    }
    const toolCalls = extractToolCallsFromMessages(newMessages);

    // Emit message_end for assistant message (first assistant in response.messages)
    const assistantMessage = newMessages.find((m) => m.role === "assistant");
    if (assistantStarted) {
      if (assistantMessage) {
        this.emit({
          type: "message_end",
          message: cloneMessage(assistantMessage),
        });
      } else {
        this.emit({
          type: "message_end",
          message: cloneMessage(partialAssistant),
        });
      }
    }
    this.state.streamMessage = null;

    // If provider-executed tools produced tool messages, emit them too.
    for (const m of newMessages) {
      if (m.role === "tool") {
        this.emit({ type: "message_start", message: cloneMessage(m) });
        this.emit({ type: "message_end", message: cloneMessage(m) });
      }
    }

    return {
      finishReason,
      newMessages,
      toolCalls,
      usage,
      totalUsage,
      modelInputMessages: messagesForModel.map(cloneMessage),
    };
  }

  private async applyTurnBoundary(input: {
    finishReason: FinishReason;
    modelInputMessages: readonly ModelMessage[];
    executedToolCallCount: number;
  }): Promise<{ requiresNextTurn: boolean }> {
    if (!this.turnBoundaryHandler) return { requiresNextTurn: false };

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");
    const assertNotAborted = () => {
      if (this.abortController?.signal.aborted) {
        throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
      }
    };

    assertNotAborted();
    const decision = await this.turnBoundaryHandler({
      finishReason: input.finishReason,
      modelInputMessages: input.modelInputMessages.map(cloneMessage),
      executedToolCallCount: input.executedToolCallCount,
      abortSignal: this.abortController?.signal,
    });
    assertNotAborted();

    const appended: ModelMessage[] = [];
    for (const message of decision.append ?? []) {
      appended.push(
        message.role === "tool" ? await this.normalizeNewToolMessage(message) : message,
      );
    }
    assertNotAborted();
    for (const message of appended) this.appendMessage(message);
    return {
      requiresNextTurn: appended.length > 0 || decision.forceNextTurn === true,
    };
  }

  private async executeToolCalls(
    toolCalls: ExpandedToolCall[],
    expansionDepth = 0,
  ): Promise<number> {
    type ToolCall = (typeof toolCalls)[number];
    type ToolExecutionOutcome = {
      result: unknown;
      isError: boolean;
      toolOutput: ToolResultOutput;
      outcome: "success" | "invalid-input" | "denied" | "error";
      expansion?: ToolExpansion;
    };

    const MAX_PARALLEL_TOOLS = 8;
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

    const isAborted = (): boolean => this.abortController?.signal.aborted === true;
    const assertNotAborted = () => {
      if (isAborted()) {
        throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
      }
    };

    const executeOne = async (call: ToolCall): Promise<ToolExecutionOutcome> => {
      const tool = this.state.tools[call.toolName] as Tool | undefined;

      this.state.pendingToolCalls.add(call.toolCallId);
      this.emit({
        type: "tool_execution_start",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.input,
      });
      assertNotAborted();

      let result: unknown;
      let isError = false;
      let toolOutput: ToolResultOutput;
      let expansion: ToolExpansion | undefined;
      let outcome: ToolExecutionOutcome["outcome"] = "success";

      try {
        if (hasExclusiveTool && !this.exclusiveToolNames.has(call.toolName)) {
          isError = true;
          outcome = "error";
          const message = `Tool '${call.toolName}' was not executed because an exclusive tool was selected in the same turn. Retry it after processing the exclusive tool result.`;
          result = message;
          toolOutput = { type: "error-text", value: message };
        } else if (call.invalid) {
          isError = true;
          outcome = "invalid-input";
          const msg =
            call.error instanceof Error
              ? call.error.message
              : typeof call.error === "string"
                ? call.error
                : call.error
                  ? (() => {
                      try {
                        const s = JSON.stringify(call.error);
                        return s ?? String(call.error);
                      } catch {
                        return String(call.error);
                      }
                    })()
                  : "Invalid tool input.";
          result = msg;
          toolOutput = { type: "error-text", value: msg };
        } else if (!tool) {
          throw new Error(`Tool not found: ${call.toolName}`);
        } else {
          assertNotAborted();
          const needsApproval =
            typeof tool.needsApproval === "function"
              ? await tool.needsApproval(call.input, {
                  toolCallId: call.toolCallId,
                  messages: this.state.messages,
                  context: this.context,
                })
              : Boolean(tool.needsApproval);
          assertNotAborted();

          if (needsApproval) {
            isError = true;
            outcome = "denied";
            result = { denied: true };
            toolOutput = {
              type: "execution-denied",
              reason: "Tool requires approval.",
            };
          } else if (!tool.execute) {
            throw new Error(`Tool has no execute(): ${call.toolName}`);
          } else {
            assertNotAborted();
            const raw = tool.execute(call.input, {
              toolCallId: call.toolCallId,
              messages: this.state.messages,
              abortSignal: this.abortController?.signal,
              context: this.context,
            });

            let rawResult: unknown;
            if (isAsyncIterable(raw)) {
              let last: unknown = undefined;
              const iterator = raw[Symbol.asyncIterator]();
              let completed = false;
              try {
                while (true) {
                  const next = await iterator.next();
                  if (next.done) {
                    completed = true;
                    rawResult = next.value === undefined ? last : next.value;
                    break;
                  }
                  assertNotAborted();
                  last = next.value;
                  this.emit({
                    type: "tool_execution_update",
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    args: call.input,
                    partialResult: next.value,
                  });
                  assertNotAborted();
                }
              } finally {
                if (!completed) await iterator.return?.();
              }
            } else {
              rawResult = await raw;
            }
            assertNotAborted();

            if (isToolExpansion(rawResult)) {
              if (expansionDepth > 0) {
                throw new Error("Nested tool-call expansions are not supported.");
              }
              expansion = rawResult;
              result = rawResult.result;
              toolOutput = { type: "json", value: toJsonToolOutputValue(result) };
            } else {
              result = rawResult;
              toolOutput = tool.toModelOutput
                ? await tool.toModelOutput({
                    toolCallId: call.toolCallId,
                    input: call.input,
                    output: result,
                  })
                : { type: "json", value: toJsonToolOutputValue(result) };
              assertNotAborted();
            }
          }
        }
      } catch (e) {
        if (e instanceof TurnAbortedError) throw e;
        assertNotAborted();
        isError = true;
        const message = errorMessage(e);
        outcome =
          isInvalidToolInputError(e) || message.includes("AI_InvalidToolInputError")
            ? "invalid-input"
            : "error";
        result = message;
        toolOutput = {
          type: "error-text",
          value: message,
        };
      }

      assertNotAborted();
      toolOutput = await this.normalizeToolOutput(toolOutput, {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(call.toolName),
      });
      assertNotAborted();

      this.state.pendingToolCalls.delete(call.toolCallId);
      this.emit({
        type: "tool_execution_end",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.input,
        result,
        isError,
        output: toolOutput,
        outcome,
      });

      return {
        result,
        isError,
        toolOutput,
        outcome,
        ...(expansion ? { expansion } : {}),
      };
    };

    const outcomes: Array<ToolExecutionOutcome | undefined> = Array.from({
      length: toolCalls.length,
    });
    let nextAppendIndex = 0;

    const appendReadyOutcomes = () => {
      while (nextAppendIndex < toolCalls.length) {
        const call = toolCalls[nextAppendIndex]!;
        const outcome = outcomes[nextAppendIndex];
        if (!outcome) break;

        const toolMessage: ModelMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        };

        this.state.messages.push(toolMessage);
        this.emit({ type: "message_start", message: cloneMessage(toolMessage) });
        this.emit({ type: "message_end", message: cloneMessage(toolMessage) });

        nextAppendIndex += 1;
      }
    };

    let stoppedDueToAbort = false;
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, toolCalls.length) }, () =>
      (async () => {
        while (true) {
          if (isAborted()) return;
          const index = next;
          if (index >= toolCalls.length) return;
          next += 1;

          outcomes[index] = await executeOne(toolCalls[index]!);
          appendReadyOutcomes();
        }
      })(),
    );
    await Promise.all(workers);
    if (isAborted()) stoppedDueToAbort = true;

    if (!stoppedDueToAbort && nextAppendIndex !== toolCalls.length) {
      const missing = toolCalls[nextAppendIndex]!;
      throw new Error(`Missing tool execution outcome for toolCallId=${missing.toolCallId}`);
    }

    if (isAborted()) {
      throw new TurnAbortedError({ reason: getAbortReason(), phase: "tools" });
    }

    let executed = toolCalls.length;
    for (const outcome of outcomes) {
      const expansion = outcome?.expansion;
      if (!expansion || expansion.children.length === 0) continue;

      const syntheticAssistant: AssistantModelMessage = {
        role: "assistant",
        content: expansion.children.map((child) => ({
          type: "tool-call" as const,
          toolCallId: child.toolCallId,
          toolName: child.toolName,
          input: normalizeToolCallInputValue(child.input),
        })),
      };
      this.appendMessage(syntheticAssistant);
      executed += await this.executeToolCalls([...expansion.children], expansionDepth + 1);
    }

    return executed;
  }
}

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

// Optional smoke demo (requires you to provide a model instance).
// Run with: `bun ai-sdk-pi-agent.ts` or `node --loader tsx ai-sdk-pi-agent.ts`
if (import.meta.main) {
  // Intentionally silent when run directly.
}
