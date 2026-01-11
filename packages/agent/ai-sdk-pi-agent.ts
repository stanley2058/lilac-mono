/*
  ai-sdk-pi-agent.ts

  Demo wrapper that provides a pi-agent-like DX (event stream + steering/follow-up queues)
  on top of AI SDK v6 `streamText().fullStream`.

  This is intentionally self-contained and not part of any package.
*/

import {
  streamText,
  type AssistantContent,
  type AssistantModelMessage,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type Tool,
  type ToolSet,
} from "ai";

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

/**
 * Fine-grained events emitted while an assistant message is streaming.
 *
 * These are derived from AI SDK `streamText(...).fullStream` parts.
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
    };

/** Why a turn ended without producing a `turn_end`. */
export type TurnAbortReason = "interrupt" | "manual";

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
      reason: "interrupt";
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
      result: unknown;
      isError: boolean;
    };

/**
 * Live agent state.
 *
 * This object is mutated during execution; treat it as read-only unless you
 * deliberately want to override internals.
 */
export interface AiSdkPiAgentState<TOOLS extends ToolSet> {
  /** System prompt for the model. */
  system: string;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
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
}

type JSONArray = JSONValue[];
type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type TransformMessagesContext = {
  /** The system prompt that will be sent via `streamText({ system })`. */
  system: string;
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

export type AiSdkPiAgentOptions<TOOLS extends ToolSet> = {
  /** System prompt for the model. */
  system: string;
  /** AI SDK model instance used for `streamText()`. */
  model: LanguageModel;
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
  /** Optional provider-specific options. */
  providerOptions?: {
    [x: string]: JSONObject;
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

function sumOptionalNumber(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
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
    reasoningTokens: sumOptionalNumber(a.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: sumOptionalNumber(
      a.cachedInputTokens,
      b.cachedInputTokens,
    ),
    raw: undefined,
  };
}

function takeQueued(
  mode: "one-at-a-time" | "all",
  queue: ModelMessage[],
): ModelMessage[] {
  if (queue.length === 0) return [];
  if (mode === "one-at-a-time") {
    return [queue.shift()!];
  }
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

function stripToolExecuteForModel<TOOLS extends ToolSet>(tools: TOOLS): TOOLS {
  // We keep the schema/description/title so the model can call tools,
  // but remove execution so we can run tools ourselves (enables steering).
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const {
        execute: _execute,
        needsApproval: _needsApproval,
        ...rest
      } = tool;
      return [name, rest];
    }),
  ) as TOOLS;
}

function upsertTextPart<A extends Array<any>>(
  content: A,
  partType: "text" | "reasoning",
  delta: string,
): void {
  const last = content.length > 0 ? content[content.length - 1] : undefined;
  if (last && last.type === partType) {
    last.text += delta;
    return;
  }
  content.push({ type: partType, text: delta });
}

class TurnAbortedError extends Error {
  readonly reason: TurnAbortReason;
  readonly phase: TurnAbortPhase;
  readonly detail?: string;

  constructor(options: {
    reason: TurnAbortReason;
    phase: TurnAbortPhase;
    detail?: string;
  }) {
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
    if (
      candidate.type === "tool-call" &&
      typeof candidate.toolCallId === "string"
    ) {
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
    if (
      candidate.type === "tool-result" &&
      typeof candidate.toolCallId === "string"
    ) {
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
 * AI SDK v6 `streamText(...).fullStream`.
 *
 * Notable behavior:
 * - The model can emit tool calls, but tools are executed locally by this wrapper.
 * - `steer()` can interrupt tool execution boundaries.
 * - `interrupt()` aborts, rewinds to a valid boundary, appends a message, and reruns.
 */
export class AiSdkPiAgent<TOOLS extends ToolSet = ToolSet> {
  private listeners = new Set<(event: AiSdkPiAgentEvent<TOOLS>) => void>();
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  private steeringMode: SteeringMode = "one-at-a-time";
  private followUpMode: FollowUpMode = "one-at-a-time";
  private steeringQueue: ModelMessage[] = [];
  private followUpQueue: ModelMessage[] = [];

  private pendingInterrupt: ModelMessage | null = null;
  private abortRequestedReason: TurnAbortReason | null = null;

  private transformMessages: TransformMessagesFn | undefined;

  /** Live execution and transcript state. */
  readonly state: AiSdkPiAgentState<TOOLS>;

  /** Create a new agent instance. */
  constructor(options: AiSdkPiAgentOptions<TOOLS>) {
    this.transformMessages = options.transformMessages;

    this.state = {
      system: options.system,
      model: options.model,
      tools: (options.tools ?? ({} as TOOLS)) as TOOLS,
      messages: options.messages ?? [],
      providerOptions: options.providerOptions,
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set<string>(),
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
  setSystem(system: string) {
    this.state.system = system;
  }

  /** Replace the model used for subsequent turns. */
  setModel(
    model: LanguageModel,
    providerOptions?: { [x: string]: JSONObject },
  ) {
    this.state.model = model;

    // (When not provided) Reset provider options in case incompatible.
    this.state.providerOptions = providerOptions;
  }

  /** Replace the toolset used for subsequent turns. */
  setTools(tools: TOOLS) {
    this.state.tools = tools;
  }

  /** Replace the outbound message transform hook. */
  setTransformMessages(transformMessages: TransformMessagesFn | undefined) {
    this.transformMessages = transformMessages;
  }

  /** Replace the entire transcript. Use with care. */
  replaceMessages(
    messages: ModelMessage[],
    options?: { reason?: "replace" | "compaction" },
  ) {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      throw new Error(
        "Cannot replace messages during a turn. Wait for the current model/tool step to finish.",
      );
    }

    const previousMessageCount = this.state.messages.length;
    this.state.messages = messages;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();

    this.emit({
      type: "messages_reset",
      reason: options?.reason ?? "replace",
      messages: this.state.messages.map(cloneMessage),
      previousMessageCount,
    });
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
   * Steering is checked after each locally executed tool call; if present, the
   * remaining tool calls are skipped and the steering message(s) are appended.
   */
  steer(message: string | ModelMessage) {
    this.steeringQueue.push(makeUserMessage(message));
  }

  /**
   * Queue a follow-up user message.
   *
   * Follow-ups are only injected when a turn finishes without tool calls.
   */
  followUp(message: string | ModelMessage) {
    this.followUpQueue.push(makeUserMessage(message));
  }

  private requestAbort(reason: TurnAbortReason) {
    if (reason === "interrupt") {
      this.abortRequestedReason = "interrupt";
    } else if (!this.abortRequestedReason) {
      this.abortRequestedReason = "manual";
    }

    this.abortController?.abort();
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

    this.pendingInterrupt = makeUserMessage(message);
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
      throw new Error(
        "Agent is already processing. Use steer() or followUp(), or waitForIdle().",
      );
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
      throw new Error(
        "Agent is already processing. Wait for completion before continuing.",
      );
    }

    const messages = this.state.messages;
    if (messages.length === 0) throw new Error("No messages to continue from");
    const last = messages[messages.length - 1]!;
    if (last.role === "assistant")
      throw new Error("Cannot continue from assistant message");

    await this.runLoop({ newMessages: undefined });
  }

  private appendMessage(message: ModelMessage) {
    this.state.messages.push(message);
    this.emit({ type: "message_start", message: cloneMessage(message) });
    this.emit({ type: "message_end", message: cloneMessage(message) });
  }

  private resetMessagesForInterrupt() {
    const truncated = truncateToLastValidBoundary(this.state.messages);
    this.state.messages = truncated.messages;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();

    this.emit({
      type: "messages_reset",
      reason: "interrupt",
      messages: this.state.messages.map(cloneMessage),
      droppedMessageCount: truncated.droppedMessageCount,
    });
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
          // Handle "interrupt" that arrived between awaited operations.
          if (this.pendingInterrupt) {
            const interruptMessage = this.pendingInterrupt;
            this.pendingInterrupt = null;

            this.emit({
              type: "turn_abort",
              reason: "interrupt",
              phase: "tools",
            });

            this.resetMessagesForInterrupt();
            this.appendMessage(interruptMessage);

            // The current abort signal is consumed; create a fresh one.
            this.abortController = new AbortController();
            this.abortRequestedReason = null;
          } else if (this.abortController?.signal.aborted) {
            // Manual abort between turns.
            const reason: TurnAbortReason =
              this.abortRequestedReason ?? "manual";
            this.emit({ type: "turn_abort", reason, phase: "tools" });
            break;
          }

          try {
            const turn = await this.runTurn();
            for (const added of turn.newMessages) {
              this.state.messages.push(added);
            }

            runTotalUsage = sumLanguageModelUsage(
              runTotalUsage,
              turn.totalUsage,
            );

            this.emit({
              type: "turn_end",
              finishReason: turn.finishReason,
              newMessages: turn.newMessages.map(cloneMessage),
              usage: turn.usage,
              totalUsage: turn.totalUsage,
            });

            if (
              turn.finishReason === "tool-calls" &&
              turn.toolCalls.length > 0
            ) {
              const steeringInjected = await this.executeToolCallsAndMaybeSteer(
                turn.toolCalls,
              );
              if (steeringInjected) {
                // continue immediately to respond to steering message(s)
                continue;
              }
              // otherwise continue normally (LLM responds to tool results)
              continue;
            }

            // No tools: inject follow-ups if present, otherwise stop.
            const followUps = takeQueued(this.followUpMode, this.followUpQueue);
            if (followUps.length > 0) {
              for (const msg of followUps) {
                this.appendMessage(msg);
              }
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

              if (err.reason === "interrupt") {
                const interruptMessage = this.pendingInterrupt;
                this.pendingInterrupt = null;

                if (!interruptMessage) {
                  break;
                }

                this.resetMessagesForInterrupt();
                this.appendMessage(interruptMessage);

                // The current abort signal is consumed; create a fresh one.
                this.abortController = new AbortController();
                this.abortRequestedReason = null;

                continue;
              }

              // Manual abort: stop agent loop cleanly.
              break;
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
      }
    })();

    await this.running;
  }

  private async runTurn(): Promise<{
    finishReason: FinishReason;
    newMessages: ModelMessage[];
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    usage: LanguageModelUsage;
    totalUsage: LanguageModelUsage;
  }> {
    this.emit({ type: "turn_start" });

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ??
      (this.pendingInterrupt ? "interrupt" : "manual");

    const abortSignal = this.abortController?.signal;

    let messagesForModel = this.state.messages.map(cloneMessage);
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

      if (abortSignal?.aborted) {
        throw new TurnAbortedError({
          reason: getAbortReason(),
          phase: "model",
        });
      }
    }

    const lastMessage =
      messagesForModel.length > 0
        ? messagesForModel[messagesForModel.length - 1]
        : undefined;
    if (lastMessage?.role === "assistant") {
      throw new Error(
        "transformMessages produced an invalid outbound context: last message is assistant.",
      );
    }

    const toolsForModel = stripToolExecuteForModel(this.state.tools);
    const result = streamText({
      model: this.state.model,
      system: this.state.system,
      messages: messagesForModel,
      tools: toolsForModel,
      abortSignal,
      providerOptions: this.state.providerOptions,
    });

    let assistantStarted = false;
    let partialAssistant: Omit<AssistantModelMessage, "content"> & {
      content: Exclude<AssistantContent, string>;
    } = {
      role: "assistant",
      content: [],
    };
    const toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }> = [];

    let aborted = false;

    for await (const part of result.fullStream) {
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
          part.type === "tool-call")
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
        case "tool-call": {
          const { toolCallId, toolName, input } = part;
          toolCalls.push({ toolCallId, toolName, input });
          partialAssistant.content.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input,
            providerExecuted: part.providerExecuted,
          });
          this.state.streamMessage = partialAssistant;
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
        this.abortRequestedReason ??
        (this.pendingInterrupt ? "interrupt" : "manual");

      throw new TurnAbortedError({ reason, phase: "model" });
    }

    let response: Awaited<typeof result.response>;
    let finishReason: FinishReason;
    let usage: LanguageModelUsage;
    let totalUsage: LanguageModelUsage;
    try {
      response = await result.response;
      finishReason = await result.finishReason;
      usage = await result.usage;
      totalUsage = await result.totalUsage;
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
          this.abortRequestedReason ??
          (this.pendingInterrupt ? "interrupt" : "manual");

        throw new TurnAbortedError({ reason, phase: "model" });
      }
      throw e;
    }

    const newMessages: ModelMessage[] = response.messages;

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
    };
  }

  private async executeToolCallsAndMaybeSteer(
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
  ): Promise<boolean> {
    for (let i = 0; i < toolCalls.length; i++) {
      if (this.abortController?.signal.aborted) {
        const reason: TurnAbortReason =
          this.abortRequestedReason ??
          (this.pendingInterrupt ? "interrupt" : "manual");
        throw new TurnAbortedError({ reason, phase: "tools" });
      }

      const call = toolCalls[i]!;
      const tool = this.state.tools[call.toolName] as
        | Tool<any, any>
        | undefined;

      this.state.pendingToolCalls.add(call.toolCallId);
      this.emit({
        type: "tool_execution_start",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.input,
      });

      let result: unknown;
      let isError = false;
      let toolOutput: any;

      try {
        if (!tool) throw new Error(`Tool not found: ${call.toolName}`);

        const needsApproval =
          typeof tool.needsApproval === "function"
            ? await tool.needsApproval(call.input, {
                toolCallId: call.toolCallId,
                messages: this.state.messages,
              })
            : Boolean(tool.needsApproval);

        if (needsApproval) {
          isError = true;
          result = { denied: true };
          toolOutput = {
            type: "execution-denied",
            reason: "Tool requires approval.",
          };
        } else if (!tool.execute) {
          throw new Error(`Tool has no execute(): ${call.toolName}`);
        } else {
          const raw = tool.execute(call.input, {
            toolCallId: call.toolCallId,
            messages: this.state.messages,
            abortSignal: this.abortController?.signal,
          });

          if (isAsyncIterable(raw)) {
            let last: unknown = undefined;
            for await (const chunk of raw) {
              last = chunk;
              this.emit({
                type: "tool_execution_update",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: call.input,
                partialResult: chunk,
              });
            }
            result = last;
          } else {
            result = await raw;
          }

          toolOutput = tool.toModelOutput
            ? await tool.toModelOutput({
                toolCallId: call.toolCallId,
                input: call.input,
                output: result,
              })
            : { type: "json", value: result ?? null };
        }
      } catch (e) {
        isError = true;
        result = e instanceof Error ? e.message : String(e);
        toolOutput = {
          type: "error-text",
          value: e instanceof Error ? e.message : String(e),
        };
      }

      this.state.pendingToolCalls.delete(call.toolCallId);
      this.emit({
        type: "tool_execution_end",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result,
        isError,
      });

      const toolMessage: ModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: toolOutput,
          },
        ],
      };

      this.state.messages.push(toolMessage);
      this.emit({ type: "message_start", message: cloneMessage(toolMessage) });
      this.emit({ type: "message_end", message: cloneMessage(toolMessage) });

      if (this.abortController?.signal.aborted) {
        const reason: TurnAbortReason =
          this.abortRequestedReason ??
          (this.pendingInterrupt ? "interrupt" : "manual");
        throw new TurnAbortedError({ reason, phase: "tools" });
      }

      const steering = takeQueued(this.steeringMode, this.steeringQueue);
      if (steering.length > 0) {
        // Skip remaining tools (pi-agent behavior)
        for (const skipped of toolCalls.slice(i + 1)) {
          this.emit({
            type: "tool_execution_start",
            toolCallId: skipped.toolCallId,
            toolName: skipped.toolName,
            args: skipped.input,
          });
          this.emit({
            type: "tool_execution_end",
            toolCallId: skipped.toolCallId,
            toolName: skipped.toolName,
            result: "Skipped due to steering message.",
            isError: true,
          });

          const skippedToolMessage: ModelMessage = {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: skipped.toolCallId,
                toolName: skipped.toolName,
                output: {
                  type: "error-text",
                  value: "Skipped due to steering message.",
                },
              },
            ],
          };
          this.state.messages.push(skippedToolMessage);
          this.emit({
            type: "message_start",
            message: cloneMessage(skippedToolMessage),
          });
          this.emit({
            type: "message_end",
            message: cloneMessage(skippedToolMessage),
          });
        }

        for (const msg of steering) {
          this.state.messages.push(msg);
          this.emit({ type: "message_start", message: cloneMessage(msg) });
          this.emit({ type: "message_end", message: cloneMessage(msg) });
        }

        return true;
      }
    }

    return false;
  }
}

// Optional smoke demo (requires you to provide a model instance).
// Run with: `bun ai-sdk-pi-agent.ts` or `node --loader tsx ai-sdk-pi-agent.ts`
if (import.meta.main) {
  console.log(
    "ai-sdk-pi-agent.ts loaded. Create an AiSdkPiAgent with your AI SDK model to run.",
  );
}
