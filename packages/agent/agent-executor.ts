import { projectAgentOutput } from "./agent-output-projection";
import { snapshotAgentMessage } from "./message-clone";
import { asSchema } from "ai";
import { isDeepStrictEqual } from "node:util";
import type {
  AssistantModelMessage,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  ToolModelMessage,
  ToolSet,
} from "ai";
import { Panic, Result, type Result as ResultType } from "better-result";
import { errorMessage } from "@stanley2058/lilac-utils/runtime-utils";
import {
  normalizeReplayMessages,
  normalizeAssistantToolCallInputMessage,
  normalizeToolCallInputValue,
} from "@stanley2058/lilac-utils/tool-call-input-normalization";
import {
  captureAgentOperation,
  captureAgentPromise,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "./failure-adapters";
import {
  AgentToolHost,
  projectExternalToolOutcome,
  ToolBatchExecutionFailed,
  type StepToolSnapshot,
  type ExternalToolExecutionOutcome,
} from "./agent-tool-host";
import {
  AgentAttempt,
  AgentAdapterFailure,
  type AgentAdapter,
  type AgentExecution,
  type AgentExecutionEvent,
} from "./agent-adapter";
import {
  type SystemPrompt,
  type SteeringMode,
  type FollowUpMode,
  type SteeringQueueId,
  type SteeringDeliveryKind,
  type SteeringDeliveryEntry,
  type BeforeSteeringDeliveryHandler,
  type InterruptQueuedSteeringResult,
  type AsyncInterruptQueuedSteeringResult,
  type TurnAbortReason,
  type AgentState,
  type TransformMessagesContext,
  type PrepareFullModelView,
  type PrepareFullBudgetView,
  type CanonicalModelCallPreflight,
  type BuildEphemeralOverlay,
  type DecorateRequestPayload,
  type TurnErrorHandlerDecision,
  type IdleRecoveryDecisionHandler,
  type IdleRecoveryResult,
  type TurnRetrySafety,
  type TurnErrorHandler,
  type TurnBoundaryHandler,
  type BeforeStepHandler,
  type AgentInputQueueId,
  type RecoveryCheckpointHandler,
  type AgentOptions,
  cloneMessage,
  AgentStateTransitionFailed,
  AgentExternalHostFailed,
  signalExternalToolCallHost,
  signalAgentStateHost,
  resultOutcome,
  cloneQueuedMessage,
  sumLanguageModelUsage,
  takeQueued,
  peekQueued,
  type FollowUpQueueEntry,
  type SteeringDeliverySelection,
  type SteeringDeliveryHookResult,
  type SteeringDeliveryPreparation,
  type AwaitedSteeringInterruptRequest,
  type IdleRecoveryRequest,
  takeAll,
  makeUserMessage,
  mergeUserMessages,
  canonicalSteeringMessages,
  upsertTextPart,
  TurnAbortedError,
  getUnresolvedAssistantToolCallIds,
  truncatedToolCallResultMessage,
  completedAssistantPrefix,
  type RecoveryCheckpoint,
  cloneMessages,
  recoveryCheckpointForMessages,
  hasInlineToolResult,
  truncateToLastValidBoundary,
  type AgentEvent,
  stripToolExecuteForModel,
} from "./agent-runtime-support";
import type {
  AgentExecutionHost,
  AgentExecutionState,
  PreparedExecutionRequest,
  ExecutionRequestSelection,
  ExecutionTurn,
  ExecutionBoundaryInput,
  ExecutionFailureContext,
} from "./agent-execution-host";

export type AgentExecutorOptions<TOOLS extends ToolSet = ToolSet> = AgentOptions<TOOLS> & {
  adapter: AgentAdapter<AgentExecutionHost<TOOLS>>;
};

function presentationMessagePhase(type: "message_start" | "message_update" | "message_end") {
  switch (type) {
    case "message_start":
      return "start";
    case "message_update":
      return "update";
    case "message_end":
      return "end";
  }
}

export class AgentExecutor<TOOLS extends ToolSet = ToolSet> {
  private readonly adapter: AgentAdapter<AgentExecutionHost<TOOLS>>;
  private readonly toolHost: AgentToolHost<TOOLS>;
  private execution: AgentExecution | undefined;
  private attempt: AgentAttempt | undefined;
  private attemptCounter = 0;
  private runTotalUsage: LanguageModelUsage | undefined;
  private externalToolStarted: (() => void) | undefined;

  private listeners = new Set<(event: AgentEvent<TOOLS>) => void>();
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  private turnCounter = 0;
  private readonly captureModelViewMessages: boolean;

  /** `null` authorizes every tool in the current toolset. */
  private activeToolNames: ReadonlySet<string> | null = null;
  private lastStepToolSnapshot: StepToolSnapshot<TOOLS> | null = null;

  private steeringMode: SteeringMode = "one-at-a-time";
  private followUpMode: FollowUpMode = "one-at-a-time";
  private nextSteeringId = 1;
  private steeringQueue: SteeringDeliveryEntry[] = [];
  private steeringDeliveryPreparation: SteeringDeliveryPreparation | undefined;
  private deliveredSteeringMessages: SteeringDeliveryEntry[] = [];
  private followUpQueue: FollowUpQueueEntry[] = [];
  private nextFollowUpId = 1;
  private canonicalInputIdsSinceCheckpoint: AgentInputQueueId[] = [];
  private recoveryCheckpoint: RecoveryCheckpoint | null = null;

  private pendingInterrupt: ModelMessage[] | null = null;
  private pendingInterruptInputIds: AgentInputQueueId[] = [];
  private awaitedSteeringInterrupt: AwaitedSteeringInterruptRequest | null = null;
  private cancelResetPending = false;
  private abortRequestedReason: TurnAbortReason | null = null;
  private idleRecoveryRequest: IdleRecoveryRequest | null = null;

  private prepareFullModelView: PrepareFullModelView | undefined;
  private prepareFullBudgetView: PrepareFullBudgetView | undefined;
  private canonicalModelCallPreflight: CanonicalModelCallPreflight | undefined;
  private buildEphemeralOverlay: BuildEphemeralOverlay | undefined;
  private decorateRequestPayload: DecorateRequestPayload | undefined;
  private turnErrorHandler: TurnErrorHandler | undefined;
  private turnBoundaryHandler: TurnBoundaryHandler | undefined;
  private beforeSteeringDelivery: BeforeSteeringDeliveryHandler | undefined;
  private beforeStep: BeforeStepHandler | undefined;
  private recoveryCheckpointHandler: RecoveryCheckpointHandler | undefined;

  private context?: OpaqueAgentValue;

  /** Live execution and transcript state. */
  readonly state: AgentState<TOOLS>;

  /** Create a new agent instance. */
  constructor(options: AgentExecutorOptions<TOOLS>) {
    this.prepareFullModelView = options.prepareFullModelView;
    this.prepareFullBudgetView = options.prepareFullBudgetView;
    this.canonicalModelCallPreflight = options.canonicalModelCallPreflight;
    this.buildEphemeralOverlay = options.buildEphemeralOverlay;
    this.decorateRequestPayload = options.decorateRequestPayload;
    this.turnErrorHandler = options.turnErrorHandler;
    this.turnBoundaryHandler = options.turnBoundaryHandler;
    this.beforeSteeringDelivery = options.beforeSteeringDelivery;
    this.beforeStep = options.beforeStep;
    this.recoveryCheckpointHandler = options.recoveryCheckpointHandler;

    this.captureModelViewMessages = options.debug?.captureModelViewMessages === true;

    this.state = {
      system: options.system,
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
    this.adapter = options.adapter;
    this.toolHost = new AgentToolHost({
      readState: () => this.state,
      readContext: () => this.context,
      readAbortSignal: () => this.abortController?.signal,
      assertNotAborted: (signal) => this.assertToolNotAborted(signal),
      makeAbortError: () => new TurnAbortedError({ reason: this.getAbortReason(), phase: "tools" }),
      readLastStepSnapshot: () => this.lastStepToolSnapshot,
      readToolExchangeBaseLength: () =>
        truncateToLastValidBoundary(this.state.messages).messages.length,
      emit: (event) => this.emit(event),
      appendMessage: (message) => this.appendMessage(message),
      checkpointMessages: (messages) => {
        this.recoveryCheckpoint = recoveryCheckpointForMessages(messages ?? this.state.messages);
      },
      normalizeToolResultOutput: options.normalizeToolResultOutput,
      normalizeSettledToolResultOutputs: options.normalizeSettledToolResultOutputs,
      genericOutputNormalizerBypassTools: options.genericOutputNormalizerBypassTools,
      aggregateOutputBudgetExemptTools: options.aggregateOutputBudgetExemptTools,
      exclusiveToolNames: options.exclusiveToolNames,
    });
  }

  /** Subscribe to streaming events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent<TOOLS>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent<TOOLS>) {
    if (this.attempt && this.execution && !this.executionTerminated)
      this.acceptPresentation(this.attempt.attemptId, event);
    // Avoid relying on Set iteration config (keeps this file tsconfig-agnostic).
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /** Replace the system prompt used for subsequent turns. */
  setSystem(system: SystemPrompt) {
    this.state.system = system;
  }

  /** Replace the model used for subsequent turns. */
  /** Replace the toolset used for subsequent turns. */
  setTools(tools: TOOLS) {
    this.state.tools = tools;
  }

  /** Replace the tool names authorized on subsequent model steps. */
  setActiveTools(names: ReadonlySet<string>) {
    this.activeToolNames = new Set(names);
  }

  /** Authorize every tool in the current toolset on subsequent model steps. */
  clearActiveTools() {
    this.activeToolNames = null;
  }

  /** Add tool names to the authority of subsequent model steps. */
  activateTools(names: readonly string[]) {
    if (names.length === 0) return;
    const next = new Set(this.activeToolNames ?? Object.keys(this.state.tools));
    for (const name of names) next.add(name);
    this.activeToolNames = next;
  }

  /** Snapshot the configured active names, or `null` when unrestricted. */
  getActiveToolNames(): ReadonlySet<string> | null {
    return this.activeToolNames ? new Set(this.activeToolNames) : null;
  }

  /** Return the immutable authority used by the most recent model step. */
  getLastStepToolSnapshot(): StepToolSnapshot<TOOLS> | null {
    return this.lastStepToolSnapshot;
  }

  private createStepToolSnapshot(step: number): StepToolSnapshot<TOOLS> {
    const entries = Object.entries(this.state.tools).filter(
      ([name]) => this.activeToolNames === null || this.activeToolNames.has(name),
    );
    const tools = Object.freeze(
      Object.fromEntries(
        entries.map(([name, definition]) => [name, Object.freeze({ ...definition })]),
      ),
    ) as TOOLS;

    return Object.freeze({
      step,
      tools,
      names: Object.freeze(entries.map(([name]) => name)),
    });
  }

  /** Replace the tool context used for subsequent turns. */
  setContext(context: OpaqueAgentValue) {
    this.context = context;
  }

  /** Snapshot the last replay-safe boundary, including completed provider-executed tool activity. */
  getRecoverableMessages(): ModelMessage[] {
    const checkpoint = this.recoveryCheckpoint;
    return checkpoint
      ? [...cloneMessages(checkpoint.baseMessages), ...cloneMessages(checkpoint.suffixMessages)]
      : cloneMessages(this.state.messages);
  }

  private async persistRecoveryCheckpoint(): Promise<void> {
    this.synchronizeCanonicalHistory();
    const canonicalInputCount = this.canonicalInputIdsSinceCheckpoint.length;
    const canonicalInputIds = this.canonicalInputIdsSinceCheckpoint.slice(0, canonicalInputCount);
    await this.recoveryCheckpointHandler?.(
      this.getRecoverableMessages().map(cloneMessage),
      canonicalInputIds,
    );
    this.canonicalInputIdsSinceCheckpoint.splice(0, canonicalInputCount);
  }

  private recordCanonicalInputs(entries: readonly { readonly id: AgentInputQueueId }[]): void {
    for (const entry of entries) this.canonicalInputIdsSinceCheckpoint.push(entry.id);
  }

  /** Execute a provider-originated tool call through the same atomic path as local calls. */
  setPrepareFullModelView(prepareFullModelView: PrepareFullModelView | undefined) {
    this.prepareFullModelView = prepareFullModelView;
  }

  setPrepareFullBudgetView(prepareFullBudgetView: PrepareFullBudgetView | undefined) {
    this.prepareFullBudgetView = prepareFullBudgetView;
  }

  setCanonicalModelCallPreflight(
    canonicalModelCallPreflight: CanonicalModelCallPreflight | undefined,
  ) {
    this.canonicalModelCallPreflight = canonicalModelCallPreflight;
  }

  setBuildEphemeralOverlay(buildEphemeralOverlay: BuildEphemeralOverlay | undefined) {
    this.buildEphemeralOverlay = buildEphemeralOverlay;
  }

  setDecorateRequestPayload(decorateRequestPayload: DecorateRequestPayload | undefined) {
    this.decorateRequestPayload = decorateRequestPayload;
  }

  appendDecorateRequestPayload(decorateRequestPayload: DecorateRequestPayload) {
    const previous = this.decorateRequestPayload;
    this.decorateRequestPayload = previous
      ? async (messages, context) =>
          decorateRequestPayload(await previous(messages, context), context)
      : decorateRequestPayload;
  }

  /** Replace the turn-error recovery hook. */
  setTurnErrorHandler(turnErrorHandler: TurnErrorHandler | undefined) {
    this.turnErrorHandler = turnErrorHandler;
  }

  /** Replace the custom URL download hook used by subsequent model calls. */
  /** Replace tool names whose outputs bypass the generic output normalizer. */
  setGenericOutputNormalizerBypassTools(toolNames: ReadonlySet<string>) {
    this.toolHost.setGenericOutputNormalizerBypassTools(toolNames);
  }

  /** Replace trusted tool names excluded from settled aggregate output budgeting. */
  setAggregateOutputBudgetExemptTools(toolNames: ReadonlySet<string>) {
    this.toolHost.setAggregateOutputBudgetExemptTools(toolNames);
  }

  /** Replace the post-tool, pre-model turn-boundary hook. */
  setTurnBoundaryHandler(turnBoundaryHandler: TurnBoundaryHandler | undefined) {
    this.turnBoundaryHandler = turnBoundaryHandler;
  }

  /** Replace the awaited pre-steering-delivery hook. */
  setBeforeSteeringDeliveryHandler(
    beforeSteeringDelivery: BeforeSteeringDeliveryHandler | undefined,
  ) {
    this.beforeSteeringDelivery = beforeSteeringDelivery;
  }

  /** Replace the pre-model-step refresh hook. */
  setBeforeStep(beforeStep: BeforeStepHandler | undefined) {
    this.beforeStep = beforeStep;
  }

  /** Replace the entire transcript. Use with care. */
  replaceMessages(
    messages: ModelMessage[],
    options?: {
      reason?: "replace" | "compaction";
      /** Rebuild an existing crash-recovery checkpoint against the replacement transcript. */
      preserveRecoveryCheckpoint?: boolean;
    },
  ): ResultType<void, AgentStateTransitionFailed> {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "replace-messages",
          message:
            "Cannot replace messages during a turn. Wait for the current model/tool step to finish.",
        }),
      );
    }

    const previousMessageCount = this.state.messages.length;
    const hadRecoveryCheckpoint = this.recoveryCheckpoint !== null;
    this.state.messages = normalizeReplayMessages(messages);
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint =
      options?.preserveRecoveryCheckpoint && hadRecoveryCheckpoint
        ? recoveryCheckpointForMessages(this.state.messages)
        : null;
    this.toolHost.clearNormalizedCalls();

    this.emit({
      type: "messages_reset",
      reason: options?.reason ?? "replace",
      messages: this.state.messages.map(cloneMessage),
      previousMessageCount,
    });
    return Result.ok(undefined);
  }

  /** Append messages to the existing transcript while idle. */
  appendMessages(messages: ModelMessage[]): ResultType<void, AgentStateTransitionFailed> {
    if (this.state.streamMessage || this.state.pendingToolCalls.size > 0) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "append-messages",
          message:
            "Cannot append messages during a turn. Wait for the current model/tool step to finish.",
        }),
      );
    }

    for (const message of messages) {
      this.appendMessage(message);
    }
    return Result.ok(undefined);
  }

  /** Clear the transcript. */
  clearMessages(): ResultType<void, AgentStateTransitionFailed> {
    return this.replaceMessages([], { reason: "replace" });
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
    const queuedMessage = cloneQueuedMessage(makeUserMessage(message), "queue");
    const id = `steering-${this.nextSteeringId++}`;
    this.steeringQueue.push({
      id,
      message: queuedMessage,
    });
    this.scheduleNativeDelivery();
    return id;
  }

  /** Snapshot entries that have not yet been drained at a steering boundary. */
  getQueuedSteeringIds(): SteeringQueueId[] {
    return this.steeringQueue.map((entry) => entry.id);
  }

  /** Mark provider-injected steering as delivered and retain it in the canonical transcript. */
  acknowledgeSteeringDeliveryResult(
    id: SteeringQueueId,
  ): ResultType<boolean, AgentStateTransitionFailed> {
    if (this.awaitedSteeringInterrupt && this.steeringQueue.some((entry) => entry.id === id)) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "acknowledge-steering",
          message: `Cannot acknowledge steering '${id}' while an interrupt is pending`,
        }),
      );
    }
    if (this.steeringDeliveryPreparation?.steeringEntries.some((entry) => entry.id === id)) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "acknowledge-steering",
          message: `Cannot acknowledge steering '${id}' while its delivery is being prepared`,
        }),
      );
    }
    const index = this.steeringQueue.findIndex((entry) => entry.id === id);
    if (index < 0) return Result.ok(false);
    const [entry] = this.steeringQueue.splice(index, 1);
    if (!entry) return Result.ok(false);
    this.deliveredSteeringMessages.push(entry);
    return Result.ok(true);
  }

  acknowledgeSteeringDelivery(id: SteeringQueueId): boolean {
    const result = resultOutcome(this.acknowledgeSteeringDeliveryResult(id));
    if (!result.ok) return signalAgentStateHost(result.error);
    return result.value;
  }

  /**
   * Queue a follow-up user message.
   *
   * Follow-ups are only injected when a turn finishes without tool calls.
   */
  followUp(message: string | ModelMessage): AgentInputQueueId {
    const id = `follow-up-${this.nextFollowUpId++}`;
    this.followUpQueue.push({
      id,
      message: cloneQueuedMessage(makeUserMessage(message), "queue"),
    });
    return id;
  }

  /**
   * Interrupt the active turn with a snapshot of every currently queued steering message.
   *
   * Buffered follow-ups are included ahead of steering messages, matching normal
   * steering-boundary behavior. Queued steering is left untouched while idle.
   *
   * This legacy synchronous path cannot await `beforeSteeringDelivery` and therefore is
   * not a durable pre-delivery boundary. It refuses to race an ordinary preparation.
   * Durable integrations must use `interruptQueuedSteeringAsync()`, which passes the selected
   * entries to the hook with `deliveryKind: "interrupt"`, awaits it, and only then removes
   * them and requests the abort.
   */
  interruptQueuedSteering(): InterruptQueuedSteeringResult {
    if (this.steeringQueue.length === 0) return { status: "empty" };
    if (!this.state.isStreaming || this.cancelResetPending) return { status: "inactive" };
    if (this.awaitedSteeringInterrupt || this.steeringDeliveryPreparation) {
      return { status: "inactive" };
    }

    const steering = takeAll(this.steeringQueue);
    const followUps = takeAll(this.followUpQueue);
    const pendingInterrupt = this.pendingInterrupt;
    this.pendingInterrupt = mergeUserMessages([
      ...(pendingInterrupt ?? []),
      ...followUps.map((entry) => entry.message),
      ...steering.map((entry) => entry.message),
    ]);
    this.pendingInterruptInputIds.push(
      ...followUps.map((entry) => entry.id),
      ...steering.map((entry) => entry.id),
    );
    if (!pendingInterrupt) this.requestAbort("interrupt");

    return {
      status: "interrupted",
      steeringIds: steering.map((entry) => entry.id),
    };
  }

  /**
   * Request an awaited steering interrupt.
   *
   * The active model/tool phase is aborted and settled first. The run loop then rewinds to a
   * valid boundary, creates a fresh abort controller, and only there selects and prepares the
   * steering/follow-up prefixes. Selected entries remain queued until the hook succeeds.
   */
  async interruptQueuedSteeringAsync(): Promise<AsyncInterruptQueuedSteeringResult> {
    if (this.steeringQueue.length === 0) return { status: "empty" };
    if (
      !this.state.isStreaming ||
      this.cancelResetPending ||
      this.pendingInterrupt ||
      this.awaitedSteeringInterrupt ||
      this.steeringDeliveryPreparation
    ) {
      return { status: "inactive" };
    }

    return new Promise<AsyncInterruptQueuedSteeringResult>((resolve) => {
      this.awaitedSteeringInterrupt = { settled: false, resolve };
      this.requestAbort("interrupt");
    });
  }

  private requestAbort(reason: TurnAbortReason) {
    this.toolHost.clearNormalizedCalls();
    if (reason === "cancel") {
      this.abortRequestedReason = "cancel";
    } else if (reason === "interrupt" && this.abortRequestedReason !== "cancel") {
      this.abortRequestedReason = "interrupt";
    } else if (
      reason === "manual" &&
      this.abortRequestedReason !== "cancel" &&
      this.abortRequestedReason !== "interrupt"
    ) {
      this.abortRequestedReason = "manual";
    } else if (reason === "recovery" && !this.abortRequestedReason) {
      this.abortRequestedReason = "recovery";
    }

    this.abortController?.abort();
    const execution = this.execution;
    if (execution && reason === "cancel") this.controlWork = execution.cancel();
    else if (execution && execution.capabilities.interruption === "native")
      this.controlWork = execution.interrupt();
  }

  private takePendingInterrupt(): {
    readonly messages: ModelMessage[];
    readonly inputIds: readonly AgentInputQueueId[];
  } | null {
    const messages = this.pendingInterrupt;
    this.pendingInterrupt = null;
    if (!messages) return null;
    const inputIds = this.pendingInterruptInputIds;
    this.pendingInterruptInputIds = [];
    return { messages, inputIds };
  }

  /**
   * Abort the current run.
   *
   * Emits `turn_abort` (reason: `manual`) and ends the agent loop without
   * rewinding the transcript.
   */
  abort() {
    const awaitedInterrupt = this.awaitedSteeringInterrupt;
    if (awaitedInterrupt && !this.steeringDeliveryPreparation) {
      this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
      this.abortRequestedReason = "manual";
      this.abortController?.abort();
      return;
    }
    this.requestAbort("manual");
  }

  /**
   * Cancel the current run without adding a message.
   *
   * Cancellation clears queued work and rewinds the transcript to its last valid
   * boundary. A `messages_reset` event with reason `cancel` is authoritative.
   */
  cancel() {
    // Queued (undelivered) work is discarded, but messages the model already
    // received are committed by `finishCancellation`.
    if (!this.steeringDeliveryPreparation) {
      this.steeringQueue.length = 0;
      this.followUpQueue.length = 0;
    }
    this.pendingInterrupt = null;
    this.pendingInterruptInputIds = [];

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
  async interruptResult(
    message: string | ModelMessage,
  ): Promise<ResultType<void, AgentStateTransitionFailed>> {
    if (!this.state.isStreaming) {
      await this.prompt(message);
      return Result.ok(undefined);
    }

    if (this.pendingInterrupt) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "interrupt",
          message: "Interrupt already pending",
        }),
      );
    }
    if (this.awaitedSteeringInterrupt) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "interrupt",
          message: "Queued steering interrupt already pending",
        }),
      );
    }
    if (this.steeringDeliveryPreparation) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "interrupt",
          message: "Cannot interrupt while steering delivery is being prepared",
        }),
      );
    }

    this.pendingInterrupt = [makeUserMessage(message)];
    this.requestAbort("interrupt");
    return Result.ok(undefined);
  }

  async interrupt(message: string | ModelMessage): Promise<void> {
    const result = resultOutcome(await this.interruptResult(message));
    if (!result.ok) signalAgentStateHost(result.error);
  }

  /**
   * Abort and replay the active attempt from its latest recovery checkpoint.
   * The decision runs only after the model and tools have cooperatively settled.
   */
  async requestIdleRecovery(
    error: unknown,
    decideRetry: IdleRecoveryDecisionHandler,
  ): Promise<IdleRecoveryResult> {
    if (!this.state.isStreaming) return Promise.resolve({ status: "inactive" });
    if (this.idleRecoveryRequest) {
      return signalAgentStateHost(
        new AgentStateTransitionFailed({
          operation: "request-idle-recovery",
          message: "Idle recovery already pending",
        }),
      );
    }
    if (this.cancelResetPending) {
      return Promise.resolve({ status: "superseded", reason: "cancel" });
    }
    if (this.pendingInterrupt || this.awaitedSteeringInterrupt) {
      return Promise.resolve({ status: "superseded", reason: "interrupt" });
    }
    if (
      this.abortController?.signal.aborted &&
      this.abortRequestedReason &&
      this.abortRequestedReason !== "recovery"
    ) {
      return Promise.resolve({ status: "superseded", reason: this.abortRequestedReason });
    }

    return new Promise<IdleRecoveryResult>((resolve) => {
      this.idleRecoveryRequest = {
        error,
        decideRetry,
        resolve,
        settled: false,
      };
      this.requestAbort("recovery");
    });
  }

  /** Wait until the agent finishes processing (or aborts/errors). */
  async waitForIdle() {
    await this.running;
  }

  /**
   * Start a new agent run by appending message(s) and executing turns until done.
   */
  async prompt(input: string | ModelMessage | ModelMessage[]) {
    const valid = resultOutcome(this.validateRunStart("prompt"));
    if (!valid.ok) signalAgentStateHost(valid.error);

    let newMessages: ModelMessage[];
    if (Array.isArray(input)) newMessages = input;
    else if (typeof input === "string") newMessages = [makeUserMessage(input)];
    else newMessages = [input];

    await this.runLoop({ newMessages });
  }

  /**
   * Continue from the current transcript.
   *
   * The last message must not be an assistant message.
   */
  async continue() {
    const valid = resultOutcome(this.validateRunStart("continue"));
    if (!valid.ok) signalAgentStateHost(valid.error);

    await this.runLoop({ newMessages: undefined });
  }

  private validateRunStart(
    operation: "prompt" | "continue",
  ): ResultType<void, AgentStateTransitionFailed> {
    if (this.state.isStreaming) {
      const message =
        operation === "prompt"
          ? "Agent is already processing. Use steer() or followUp(), or waitForIdle()."
          : "Agent is already processing. Wait for completion before continuing.";
      return Result.err(new AgentStateTransitionFailed({ operation, message }));
    }
    if (operation === "continue") {
      const last = this.state.messages.at(-1);
      if (!last) {
        return Result.err(
          new AgentStateTransitionFailed({ operation, message: "No messages to continue from" }),
        );
      }
      if (last.role === "assistant") {
        return Result.err(
          new AgentStateTransitionFailed({
            operation,
            message: "Cannot continue from assistant message",
          }),
        );
      }
    }
    return Result.ok(undefined);
  }

  private appendMessage(message: ModelMessage) {
    const normalizedMessage = normalizeAssistantToolCallInputMessage(message);
    this.state.messages.push(normalizedMessage);
    this.emit({ type: "message_start", message: cloneMessage(normalizedMessage) });
    this.emit({ type: "message_end", message: cloneMessage(normalizedMessage) });
  }

  private selectSteeringDelivery(
    deliveryKind: SteeringDeliveryKind,
    mode: SteeringMode,
  ): SteeringDeliverySelection | undefined {
    const firstState = this.attempt?.inputState(this.steeringQueue[0]?.id ?? "");
    if (firstState === "reserved" || firstState === "provider-owned" || firstState === "unresolved")
      return undefined;
    const steeringEntries = Object.freeze(peekQueued(mode, this.steeringQueue));
    if (steeringEntries.length === 0) return undefined;
    const followUpEntries = Object.freeze(this.followUpQueue.slice());
    const canonicalMessages = Object.freeze(
      canonicalSteeringMessages(followUpEntries, steeringEntries).map((message) =>
        cloneQueuedMessage(normalizeAssistantToolCallInputMessage(message), "deliver"),
      ),
    );
    return Object.freeze({
      deliveryKind,
      steeringEntries,
      followUpEntries,
      canonicalMessages,
    });
  }

  private createSteeringDeliveryPreparation(
    selection: SteeringDeliverySelection,
  ): SteeringDeliveryPreparation {
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      ...selection,
      hookStatus: "pending",
      settled,
      settle,
    };
  }

  private steeringPreparationMatchesQueues(preparation: SteeringDeliveryPreparation): boolean {
    return (
      preparation.steeringEntries.every((entry, index) => this.steeringQueue[index] === entry) &&
      preparation.followUpEntries.every((entry, index) => this.followUpQueue[index] === entry)
    );
  }

  private async invokeSteeringDeliveryHook(
    preparation: SteeringDeliveryPreparation,
  ): Promise<SteeringDeliveryHookResult> {
    const attempted = resultOutcome(
      await captureAgentPromise(async (): Promise<SteeringDeliveryHookResult> => {
        if (this.beforeSteeringDelivery) {
          const batch = Object.freeze(
            preparation.steeringEntries.map((entry) =>
              Object.freeze({
                id: entry.id,
                message: cloneQueuedMessage(entry.message, "deliver"),
              }),
            ),
          );
          const canonicalMessages = Object.freeze(
            preparation.canonicalMessages.map((message) => cloneQueuedMessage(message, "deliver")),
          );
          const abortSignal = this.abortController?.signal;
          await this.beforeSteeringDelivery(
            Object.freeze({
              deliveryKind: preparation.deliveryKind,
              batch,
              canonicalMessages,
              ...(abortSignal ? { abortSignal } : {}),
            }),
          );
        }
        preparation.hookStatus = "prepared";
        return { status: "prepared" };
      }),
    );
    if (!attempted.ok) {
      rethrowAgentPanic(attempted.error);
      const message = errorMessage(attempted.error);
      this.emit({
        type: "steering_delivery_failed",
        deliveryKind: preparation.deliveryKind,
        steeringIds: preparation.steeringEntries.map((entry) => entry.id),
        error: message,
      });
      return { status: "failed", error: message };
    }
    return attempted.value;
  }

  private clearSteeringDeliveryPreparation(preparation: SteeringDeliveryPreparation): void {
    if (this.steeringDeliveryPreparation === preparation) {
      this.steeringDeliveryPreparation = undefined;
    }
    preparation.settle();
  }

  private consumeSteeringDelivery(
    preparation: SteeringDeliveryPreparation,
  ): ResultType<ModelMessage[], AgentStateTransitionFailed> {
    if (
      this.steeringDeliveryPreparation !== preparation ||
      preparation.hookStatus !== "prepared" ||
      !this.steeringPreparationMatchesQueues(preparation)
    ) {
      return Result.err(
        new AgentStateTransitionFailed({
          operation: "consume-steering",
          message: "Cannot consume steering entries without their successful preparation",
        }),
      );
    }

    this.prepareInputBatch(
      [...preparation.followUpEntries, ...preparation.steeringEntries],
      preparation.canonicalMessages,
    );
    this.steeringQueue.splice(0, preparation.steeringEntries.length);
    this.followUpQueue.splice(0, preparation.followUpEntries.length);
    const canonicalMessages = preparation.canonicalMessages.map((message) =>
      cloneQueuedMessage(message, "deliver"),
    );
    this.clearSteeringDeliveryPreparation(preparation);
    return Result.ok(canonicalMessages);
  }

  private settleAwaitedSteeringInterrupt(
    request: AwaitedSteeringInterruptRequest,
    result: AsyncInterruptQueuedSteeringResult,
  ): void {
    if (request.settled) return;
    request.settled = true;
    if (this.awaitedSteeringInterrupt === request) this.awaitedSteeringInterrupt = null;
    request.resolve(result);
  }

  private async deliverAwaitedSteeringInterrupt(
    request: AwaitedSteeringInterruptRequest,
  ): Promise<void> {
    if (request.settled || this.awaitedSteeringInterrupt !== request) return;
    if (this.cancelResetPending) {
      this.settleAwaitedSteeringInterrupt(request, { status: "inactive" });
      return;
    }

    const selection = this.selectSteeringDelivery("interrupt", "all");
    if (!selection) {
      this.settleAwaitedSteeringInterrupt(request, { status: "empty" });
      return;
    }

    const preparation = this.createSteeringDeliveryPreparation(selection);
    this.steeringDeliveryPreparation = preparation;
    const hookResult = await this.invokeSteeringDeliveryHook(preparation);
    if (hookResult.status === "failed") {
      this.clearSteeringDeliveryPreparation(preparation);
      this.settleAwaitedSteeringInterrupt(request, {
        status: "failed",
        steeringIds: preparation.steeringEntries.map((entry) => entry.id),
        error: hookResult.error,
      });
      return;
    }

    const consumed = this.consumeSteeringDelivery(preparation);
    const consumedOutcome = resultOutcome(consumed);
    if (!consumedOutcome.ok) {
      this.clearSteeringDeliveryPreparation(preparation);
      this.settleAwaitedSteeringInterrupt(request, {
        status: "failed",
        steeringIds: preparation.steeringEntries.map((entry) => entry.id),
        error: consumedOutcome.error.message,
      });
      return;
    }
    for (const message of consumedOutcome.value) this.appendMessage(message);
    this.recordCanonicalInputs([...preparation.followUpEntries, ...preparation.steeringEntries]);
    this.settleAwaitedSteeringInterrupt(request, {
      status: "interrupted",
      steeringIds: preparation.steeringEntries.map((entry) => entry.id),
    });
  }

  private beginFreshPostInterruptPhase(): AbortSignal {
    this.abortController = new AbortController();
    this.abortRequestedReason = null;
    return this.abortController.signal;
  }

  private async prepareQueuedSteeringDelivery(): Promise<
    | { readonly status: "empty" | "failed" | "external-settled" }
    | { readonly status: "prepared"; readonly preparation: SteeringDeliveryPreparation }
  > {
    const existing = this.steeringDeliveryPreparation;
    if (existing) {
      if (existing.deliveryKind === "interrupt") {
        await existing.settled;
        return { status: "external-settled" };
      }
      if (!this.steeringPreparationMatchesQueues(existing)) {
        this.clearSteeringDeliveryPreparation(existing);
        return { status: "failed" };
      }
      if (existing.hookStatus === "prepared") {
        return { status: "prepared", preparation: existing };
      }
      this.clearSteeringDeliveryPreparation(existing);
      return { status: "failed" };
    }

    const selection = this.selectSteeringDelivery("queued", this.steeringMode);
    if (!selection) return { status: "empty" };
    const preparation = this.createSteeringDeliveryPreparation(selection);
    this.steeringDeliveryPreparation = preparation;
    const hookResult = await this.invokeSteeringDeliveryHook(preparation);
    if (hookResult.status === "failed") {
      this.clearSteeringDeliveryPreparation(preparation);
      return { status: "failed" };
    }
    return { status: "prepared", preparation };
  }

  private resetMessagesAfterAbort(
    reason: "cancel" | "interrupt" | "recovery",
    appendBeforeRecovery: ModelMessage[] = [],
  ) {
    const truncated = truncateToLastValidBoundary(this.state.messages);
    const checkpoint = this.recoveryCheckpoint;
    const checkpointSuffix = checkpoint === null ? [] : cloneMessages(checkpoint.suffixMessages);
    const retryableSuffix =
      reason === "recovery" &&
      checkpointSuffix.at(-1)?.role === "assistant" &&
      !hasInlineToolResult(checkpointSuffix.at(-1)!)
        ? []
        : checkpointSuffix;
    this.state.messages = [
      ...(checkpoint === null ? truncated.messages : cloneMessages(checkpoint.baseMessages)),
      ...appendBeforeRecovery,
      ...retryableSuffix,
    ];
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint = null;
    this.toolHost.clearNormalizedCalls();

    this.emit({
      type: "messages_reset",
      reason,
      messages: this.state.messages.map(cloneMessage),
      droppedMessageCount: truncated.droppedMessageCount,
    });
  }

  private settleIdleRecovery(request: IdleRecoveryRequest, result: IdleRecoveryResult): void {
    if (request.settled) return;
    request.settled = true;
    if (this.idleRecoveryRequest === request) this.idleRecoveryRequest = null;
    request.resolve(result);
  }

  private idleRecoverySupersedingReason(): Exclude<TurnAbortReason, "recovery"> | null {
    if (this.cancelResetPending) return "cancel";
    if (this.pendingInterrupt || this.awaitedSteeringInterrupt) return "interrupt";
    if (!this.abortController?.signal.aborted) return null;
    const reason = this.abortRequestedReason;
    return reason && reason !== "recovery" ? reason : null;
  }

  private async finishIdleRecovery(request: IdleRecoveryRequest): Promise<void> {
    const beforeResetReason = this.idleRecoverySupersedingReason();
    if (beforeResetReason) {
      this.settleIdleRecovery(request, { status: "superseded", reason: beforeResetReason });
      return;
    }

    this.resetMessagesAfterAbort("recovery");
    const abortSignal = this.beginFreshPostInterruptPhase();

    let decision: TurnErrorHandlerDecision = "fail";
    const decided = resultOutcome(
      await captureAgentPromise(
        async () =>
          await request.decideRetry(request.error, {
            abortSignal,
          }),
      ),
    );
    if (decided.ok) decision = decided.value;
    else {
      rethrowAgentPanic(decided.error);
      // A failed retry decision refuses recovery; the original idle error remains authoritative.
    }

    const supersedingReason = this.idleRecoverySupersedingReason();
    if (supersedingReason) {
      this.settleIdleRecovery(request, { status: "superseded", reason: supersedingReason });
      return;
    }
    if (decision === "retry") {
      this.settleIdleRecovery(request, { status: "retried" });
      return;
    }

    this.settleIdleRecovery(request, { status: "failed" });
    throw request.error;
  }

  private checkpointRecoveryDraft(message: AssistantModelMessage): void {
    const checkpoint = completedAssistantPrefix(message);
    if (checkpoint === null) return;
    this.recoveryCheckpoint = {
      baseMessages: cloneMessages(truncateToLastValidBoundary(this.state.messages).messages),
      suffixMessages: [checkpoint],
    };
  }

  private checkpointCurrentToolExchange(): void {
    this.recoveryCheckpoint = recoveryCheckpointForMessages(this.state.messages);
  }

  private finishCancellation() {
    const recoveryRequest = this.idleRecoveryRequest;
    if (recoveryRequest) {
      this.settleIdleRecovery(recoveryRequest, { status: "superseded", reason: "cancel" });
    }
    const awaitedInterrupt = this.awaitedSteeringInterrupt;
    if (awaitedInterrupt) {
      this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
    }
    // Steering the model already received stays in the transcript even though
    // the run was cancelled. Provider-executed work it caused is preserved by
    // recovery, so dropping the message would leave an answer to a question no
    // user turn ever asked. Undelivered steering is still discarded.
    const deliveredSteering = takeAll(this.deliveredSteeringMessages);
    this.resetMessagesAfterAbort(
      "cancel",
      deliveredSteering.map((entry) => entry.message),
    );
    this.recordCanonicalInputs(deliveredSteering);
    this.steeringQueue.length = 0;
    this.steeringDeliveryPreparation = undefined;
    this.followUpQueue.length = 0;
    this.pendingInterrupt = null;
    this.pendingInterruptInputIds = [];
    this.cancelResetPending = false;
  }

  private getAbortReason(): TurnAbortReason {
    return this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");
  }
  private assertToolNotAborted(signal?: AbortSignal): void {
    if (signal && !signal.aborted) return;
    if (this.abortController?.signal.aborted) {
      signalAgentStateHost(new TurnAbortedError({ reason: this.getAbortReason(), phase: "tools" }));
    }
    signal?.throwIfAborted();
  }
  async executeExternalToolCall(
    input: Parameters<AgentToolHost<TOOLS>["executeExternalToolCall"]>[0],
  ): Promise<ExternalToolExecutionOutcome> {
    this.externalToolStarted?.();
    return await this.toolHost.executeExternalToolCall(input);
  }
  private normalizeNewToolMessage(message: ToolModelMessage): Promise<ToolModelMessage> {
    return this.toolHost.normalizeNewToolMessage(message);
  }
  private async checkControlBoundary(): Promise<"stop" | "again" | "ready"> {
    if (this.cancelResetPending) {
      this.emit({ type: "turn_abort", reason: "cancel", phase: "tools" });
      this.finishCancellation();
      return "stop";
    }

    const idleRecoveryRequest = this.idleRecoveryRequest;
    if (idleRecoveryRequest) {
      const supersedingReason = this.idleRecoverySupersedingReason();
      if (supersedingReason) {
        this.settleIdleRecovery(idleRecoveryRequest, {
          status: "superseded",
          reason: supersedingReason,
        });
      } else {
        this.emit({ type: "turn_abort", reason: "recovery", phase: "tools" });
        await this.finishIdleRecovery(idleRecoveryRequest);
        return "again";
      }
    }

    // Awaited steering interrupts prepare only after the active phase has settled.
    const awaitedInterrupt = this.awaitedSteeringInterrupt;
    if (awaitedInterrupt) {
      this.emit({
        type: "turn_abort",
        reason: "interrupt",
        phase: "tools",
      });
      this.resetMessagesAfterAbort("interrupt");
      this.beginFreshPostInterruptPhase();
      await this.deliverAwaitedSteeringInterrupt(awaitedInterrupt);
      if (this.cancelResetPending) {
        this.finishCancellation();
        return "stop";
      }
      if (this.abortController?.signal.aborted) {
        const reason = this.abortRequestedReason ?? "manual";
        this.emit({ type: "turn_abort", reason, phase: "tools" });
        return "stop";
      }
      return "again";
    }

    // Handle a legacy interrupt that arrived between awaited operations.
    if (this.pendingInterrupt) {
      const pendingInterrupt = this.takePendingInterrupt();
      if (!pendingInterrupt) return "again";

      this.emit({
        type: "turn_abort",
        reason: "interrupt",
        phase: "tools",
      });

      this.resetMessagesAfterAbort("interrupt");
      if (this.cancelResetPending) {
        this.finishCancellation();
        return "stop";
      }
      for (const message of pendingInterrupt.messages) this.appendMessage(message);
      this.canonicalInputIdsSinceCheckpoint.push(...pendingInterrupt.inputIds);

      this.beginFreshPostInterruptPhase();
    } else if (this.abortController?.signal.aborted) {
      // Manual abort between turns.
      const reason: TurnAbortReason = this.abortRequestedReason ?? "manual";
      this.emit({ type: "turn_abort", reason, phase: "tools" });
      return "stop";
    }

    return "ready";
  }
  private async prepareExecutionRequest(
    request: Parameters<AgentExecutionHost<TOOLS>["prepareRequest"]>[0],
  ): Promise<PreparedExecutionRequest> {
    request.onErrorPhase("before-step");
    await this.persistRecoveryCheckpoint();
    this.emit({ type: "turn_start" });

    const turnIndex = ++this.turnCounter;

    if (this.beforeStep) {
      const preStepSignal = request.signal ?? this.abortController?.signal;
      if (preStepSignal?.aborted) {
        signalAgentStateHost(
          new TurnAbortedError({
            reason: this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual"),
            phase: "model",
          }),
        );
      }
      await this.beforeStep({
        step: turnIndex,
        ...(preStepSignal ? { abortSignal: preStepSignal } : {}),
      });
      if (preStepSignal?.aborted) {
        signalAgentStateHost(
          new TurnAbortedError({
            reason: this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual"),
            phase: "model",
          }),
        );
      }
    }

    const toolSnapshot = this.createStepToolSnapshot(turnIndex);
    this.lastStepToolSnapshot = toolSnapshot;
    const allModelTools = stripToolExecuteForModel(toolSnapshot.tools);

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");

    const abortSignal = request.signal ?? this.abortController?.signal;

    request.onErrorPhase("transform-messages");
    const throwIfPreparationAborted = () => {
      if (!abortSignal?.aborted) return;
      signalAgentStateHost(new TurnAbortedError({ reason: getAbortReason(), phase: "model" }));
    };
    const contextForMode = (
      executionMode: ExecutionRequestSelection["executionMode"],
    ): TransformMessagesContext => ({
      system: this.state.system,
      tools: executionMode === "local-tools" ? allModelTools : {},
      abortSignal,
    });
    const initialRuntime = { executionMode: request.executionMode };
    let canonicalMessages: ModelMessage[] = [];
    let preparedCanonical: ModelMessage[] = [];
    let preparationContext = contextForMode(initialRuntime.executionMode);
    throwIfPreparationAborted();
    canonicalMessages = normalizeReplayMessages(this.state.messages.map(cloneMessage));
    await this.canonicalModelCallPreflight?.(canonicalMessages, preparationContext);
    canonicalMessages = normalizeReplayMessages(this.state.messages.map(cloneMessage));
    if (this.prepareFullBudgetView) {
      preparedCanonical = await this.prepareFullBudgetView(canonicalMessages, {
        ...preparationContext,
        canonicalStartIndex: 0,
      });
    } else if (this.prepareFullModelView) {
      preparedCanonical = await this.prepareFullModelView(canonicalMessages, preparationContext);
    } else {
      preparedCanonical = canonicalMessages;
    }
    preparedCanonical = normalizeReplayMessages(preparedCanonical);
    throwIfPreparationAborted();

    const budgetOverlay = this.buildEphemeralOverlay
      ? await this.buildEphemeralOverlay(preparationContext)
      : [];
    const fullBudgetView = normalizeReplayMessages([...preparedCanonical, ...budgetOverlay]);
    const callPreparation = await request.selectRequest({
      canonicalMessages,
      fullBudgetView,
      transformContext: preparationContext,
    });
    throwIfPreparationAborted();

    const suffixStart =
      callPreparation.payload.mode === "full" ? 0 : callPreparation.payload.startIndex;
    if (
      !Number.isInteger(suffixStart) ||
      suffixStart < 0 ||
      suffixStart > canonicalMessages.length
    ) {
      signalAgentStateHost(
        new AgentStateTransitionFailed({
          operation: "prepare model call",
          message: `prepareModelCall selected invalid canonical suffix index ${suffixStart}`,
        }),
      );
    }
    preparationContext = contextForMode(callPreparation.executionMode);
    const selectedCanonical = canonicalMessages.slice(suffixStart);
    let messagesForModel = this.prepareFullModelView
      ? await this.prepareFullModelView(selectedCanonical, preparationContext)
      : selectedCanonical;
    messagesForModel = normalizeReplayMessages(messagesForModel);
    if (messagesForModel.at(-1)?.role === "assistant") {
      signalAgentStateHost(
        new AgentStateTransitionFailed({
          operation: "prepare model view",
          message: `Cannot append an ephemeral overlay after an assistant message (suffixStart=${suffixStart}, canonicalMessageCount=${canonicalMessages.length})`,
        }),
      );
    }
    const payloadOverlay = this.buildEphemeralOverlay
      ? await this.buildEphemeralOverlay(preparationContext)
      : [];
    messagesForModel = normalizeReplayMessages([...messagesForModel, ...payloadOverlay]);
    if (this.decorateRequestPayload) {
      messagesForModel = normalizeReplayMessages(
        await this.decorateRequestPayload(messagesForModel, preparationContext),
      );
    }
    throwIfPreparationAborted();

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
      signalAgentStateHost(
        new AgentStateTransitionFailed({
          operation: "prepare outbound context",
          message:
            "Request preparation produced an invalid outbound context: last message is assistant.",
        }),
      );
    }

    return {
      scopeId: String(turnIndex),
      step: turnIndex,
      system: this.state.system,
      messages: messagesForModel,
      canonicalMessages: canonicalMessages.map(cloneMessage),
      tools: allModelTools,
      selection: callPreparation,
    };
  }
  private async commitExecutionTurn(turn: ExecutionTurn): Promise<void> {
    if (this.cancelResetPending)
      signalAgentStateHost(new TurnAbortedError({ reason: "cancel", phase: "model" }));
    const deliveredSteering = takeAll(this.deliveredSteeringMessages);
    for (const delivered of deliveredSteering) {
      this.appendMessage(delivered.message);
    }
    this.recordCanonicalInputs(deliveredSteering);
    const truncatedToolResult =
      turn.finishReason === "length" ? truncatedToolCallResultMessage(turn.toolCalls) : null;
    const normalizedTruncatedToolResult = truncatedToolResult
      ? await this.normalizeNewToolMessage(truncatedToolResult)
      : null;
    for (const added of turn.newMessages) {
      this.state.messages.push(added);
    }
    if (normalizedTruncatedToolResult) {
      this.appendMessage(normalizedTruncatedToolResult);
    }
    const newMessages = normalizedTruncatedToolResult
      ? [...turn.newMessages, normalizedTruncatedToolResult]
      : turn.newMessages;
    this.recoveryCheckpoint = null;
    for (const added of newMessages) {
      if (added.role === "assistant" && getUnresolvedAssistantToolCallIds(added).length > 0) {
        this.checkpointCurrentToolExchange();
      }
    }
    if (truncateToLastValidBoundary(this.state.messages).droppedMessageCount === 0) {
      this.recoveryCheckpoint = null;
    }

    this.emit({
      type: "turn_end",
      finishReason: turn.finishReason,
      newMessages: newMessages.map(cloneMessage),
      usage: turn.usage,
      totalUsage: turn.totalUsage,
    });
    await this.persistRecoveryCheckpoint();
  }
  private async finishExecutionBoundary(
    input: ExecutionBoundaryInput,
  ): Promise<"continue" | "break"> {
    const recoverFromLength = input.continuationMessage !== undefined;
    const boundaryDecision = await this.applyTurnBoundary({
      finishReason: input.finishReason,
      modelInputMessages: input.modelInputMessages,
      executedToolCallCount: input.executedToolCallCount,
      signal: input.signal,
    });
    if (recoverFromLength) {
      this.appendMessage(input.continuationMessage!);
    }

    if (this.cancelResetPending) {
      return signalAgentStateHost(new TurnAbortedError({ reason: "cancel", phase: "tools" }));
    }
    if (this.awaitedSteeringInterrupt) return "continue" as const;
    if (this.pendingInterrupt) return "continue" as const;

    // Steering should pick up any buffered follow-ups and remains ahead of
    // the normal tool-result continuation decision.
    const steeringPreparation = await this.prepareQueuedSteeringDelivery();
    if (steeringPreparation.status === "prepared") {
      const consumed = this.consumeSteeringDelivery(steeringPreparation.preparation);
      const consumedOutcome = resultOutcome(consumed);
      if (!consumedOutcome.ok) {
        this.clearSteeringDeliveryPreparation(steeringPreparation.preparation);
        return "break" as const;
      }
      for (const msg of consumedOutcome.value) {
        this.appendMessage(msg);
      }
      this.recordCanonicalInputs([
        ...steeringPreparation.preparation.followUpEntries,
        ...steeringPreparation.preparation.steeringEntries,
      ]);
      return "continue" as const;
    }

    if (this.cancelResetPending) {
      return signalAgentStateHost(new TurnAbortedError({ reason: "cancel", phase: "tools" }));
    }
    if (this.pendingInterrupt || this.abortController?.signal.aborted) {
      return "continue" as const;
    }

    const naturallyRequiresNextTurn =
      input.naturallyRequiresContinuation || boundaryDecision.requiresNextTurn || recoverFromLength;
    if (
      steeringPreparation.status === "failed" ||
      steeringPreparation.status === "external-settled"
    ) {
      if (naturallyRequiresNextTurn) return "continue" as const;
      this.recoveryCheckpoint = null;
      return "break" as const;
    }

    if (input.finishReason !== "tool-calls") {
      const followUps = takeQueued(this.followUpMode, this.followUpQueue);
      if (followUps.length > 0) {
        const merged = mergeUserMessages(followUps.map((entry) => entry.message));
        this.prepareInputBatch(followUps, merged);
        for (const msg of merged) {
          this.appendMessage(msg);
        }
        this.recordCanonicalInputs(followUps);
        return "continue" as const;
      }
    }

    if (naturallyRequiresNextTurn) {
      return "continue" as const;
    }

    // A normally completed run persists its finalized messages. The
    // checkpoint is only authoritative when the active block aborts.
    this.recoveryCheckpoint = null;
    return "break" as const;
  }
  private async settleExecutionFailure(
    err: OpaqueAgentValue,
    context: ExecutionFailureContext,
  ): Promise<"continue" | "break"> {
    rethrowAgentPanic(err);
    if (err instanceof TurnAbortedError) {
      const idleRecoveryRequest = this.idleRecoveryRequest;
      if (idleRecoveryRequest && err.reason !== "recovery") {
        this.settleIdleRecovery(idleRecoveryRequest, {
          status: "superseded",
          reason: err.reason,
        });
      }
      this.emit({
        type: "turn_abort",
        reason: err.reason,
        phase: err.phase,
        detail: err.detail,
      });

      if (err.reason === "recovery" && idleRecoveryRequest) {
        await this.finishIdleRecovery(idleRecoveryRequest);
        return "continue";
      }

      if (this.cancelResetPending && err.reason !== "cancel") {
        this.finishCancellation();
        return "break";
      }

      if (err.reason === "interrupt") {
        const awaitedInterrupt = this.awaitedSteeringInterrupt;
        if (awaitedInterrupt) {
          this.resetMessagesAfterAbort("interrupt");
          this.beginFreshPostInterruptPhase();
          await this.deliverAwaitedSteeringInterrupt(awaitedInterrupt);
          if (this.cancelResetPending) {
            this.finishCancellation();
            return "break";
          }
          if (this.abortController?.signal.aborted) {
            const reason = this.abortRequestedReason ?? "manual";
            this.emit({ type: "turn_abort", reason, phase: "tools" });
            return "break";
          }
          return "continue";
        }

        const interruptMessages = this.takePendingInterrupt();

        if (!interruptMessages) {
          return "break";
        }

        this.resetMessagesAfterAbort("interrupt");
        if (this.cancelResetPending) {
          this.finishCancellation();
          return "break";
        }
        for (const message of interruptMessages.messages) this.appendMessage(message);
        this.canonicalInputIdsSinceCheckpoint.push(...interruptMessages.inputIds);

        this.beginFreshPostInterruptPhase();

        return "continue";
      }

      if (err.reason === "cancel") {
        this.finishCancellation();
        return "break";
      }

      // Manual abort: stop agent loop cleanly.
      return "break";
    }

    if (this.cancelResetPending) {
      this.emit({
        type: "turn_abort",
        reason: "cancel",
        phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
        detail: err instanceof Error ? err.message : String(err),
      });
      this.finishCancellation();
      return "break";
    }

    const deliveredSteering = takeAll(this.deliveredSteeringMessages);
    for (const delivered of deliveredSteering) {
      this.appendMessage(delivered.message);
    }
    this.recordCanonicalInputs(deliveredSteering);

    if (this.turnErrorHandler) {
      const lastMessage = this.state.messages.at(-1);
      let retrySafety: TurnRetrySafety;
      if (context.modelTurnCompleted) {
        retrySafety = { canRetry: false, reason: "post-model-phase" };
      } else if (context.providerExecutedTool) {
        retrySafety = { canRetry: false, reason: "provider-executed-tool" };
      } else if (lastMessage?.role === "assistant" || this.state.pendingToolCalls.size > 0) {
        retrySafety = { canRetry: false, reason: "invalid-transcript-boundary" };
      } else {
        retrySafety = { canRetry: true };
      }
      const handled = resultOutcome(
        await captureAgentPromise(
          async () =>
            await this.turnErrorHandler!(err, {
              abortSignal: this.abortController?.signal,
              retrySafety,
              phase: context.phase,
            }),
        ),
      );
      let decision: TurnErrorHandlerDecision | undefined;
      if (handled.ok) decision = handled.value;
      else {
        rethrowAgentPanic(handled.error);
        if (
          !this.cancelResetPending &&
          !this.pendingInterrupt &&
          !this.abortController?.signal.aborted
        ) {
          return signalExternalToolCallHost(
            new AgentExternalHostFailed({
              cause: handled.error,
              message: "Turn error handler failed",
            }),
          );
        }
      }
      if (this.cancelResetPending) {
        this.emit({
          type: "turn_abort",
          reason: "cancel",
          phase: this.state.pendingToolCalls.size > 0 ? "tools" : "model",
        });
        this.finishCancellation();
        return "break";
      }
      if (this.pendingInterrupt || this.abortController?.signal.aborted) {
        return "continue";
      }
      if (decision === "retry" && retrySafety.canRetry) {
        const hadPartialOutput = this.state.streamMessage !== null;
        this.state.streamMessage = null;
        this.emit({
          type: "turn_retry",
          hadPartialOutput,
          abandonedToolCallIds: [...context.localToolDraftIds],
        });
        return "continue";
      }
    }

    return signalExternalToolCallHost(
      new AgentExternalHostFailed({ cause: err, message: "Agent turn failed" }),
    );
  }
  private async runLoop(options: { newMessages: ModelMessage[] | undefined }) {
    this.state.isStreaming = true;
    this.state.streamMessage = null;
    this.state.pendingToolCalls = new Set();
    this.recoveryCheckpoint = null;
    this.state.error = undefined;

    this.abortController = new AbortController();
    this.abortRequestedReason = null;

    this.running = (async () => {
      this.emit({ type: "agent_start" });

      this.runTotalUsage = undefined;

      const runAttempt = resultOutcome(
        await captureAgentPromise(async () => {
          if (options.newMessages) {
            for (const msg of options.newMessages) {
              this.appendMessage(msg);
            }
          }

          await this.runAdapterExecution();
          await this.persistRecoveryCheckpoint();
          this.emit({
            type: "agent_end",
            messages: this.getRecoverableMessages().map(cloneMessage),
            totalUsage: this.runTotalUsage,
          });
        }),
      );
      let runError: OpaqueAgentValue;
      if (!runAttempt.ok) {
        const err = runAttempt.error;
        if (err instanceof Panic) {
          runError = err;
        } else {
          const handled = resultOutcome(
            captureAgentOperation(() => {
              this.state.error = err instanceof Error ? err.message : String(err);
              this.emit({
                type: "agent_end",
                messages: this.getRecoverableMessages().map(cloneMessage),
                totalUsage: this.runTotalUsage,
              });
            }),
          );
          runError = handled.ok ? err : handled.error;
        }
      }
      const cleanupAttempt = resultOutcome(
        captureAgentOperation(() => {
          const awaitedInterrupt = this.awaitedSteeringInterrupt;
          if (awaitedInterrupt) {
            this.settleAwaitedSteeringInterrupt(awaitedInterrupt, { status: "inactive" });
          }
          const idleRecoveryRequest = this.idleRecoveryRequest;
          if (idleRecoveryRequest) {
            this.settleIdleRecovery(idleRecoveryRequest, { status: "inactive" });
          }
          this.state.isStreaming = false;
          this.state.streamMessage = null;
          this.state.pendingToolCalls = new Set();
          this.abortController = undefined;
          this.abortRequestedReason = null;
          this.pendingInterrupt = null;
          this.pendingInterruptInputIds = [];
          this.canonicalInputIdsSinceCheckpoint.length = 0;
          this.toolHost.clearNormalizedCalls();
          if (this.cancelResetPending) {
            this.steeringQueue.length = 0;
            this.steeringDeliveryPreparation = undefined;
            this.deliveredSteeringMessages.length = 0;
            this.followUpQueue.length = 0;
          }
          this.cancelResetPending = false;
        }),
      );
      if (!cleanupAttempt.ok) throw cleanupAttempt.error;
      if (!runAttempt.ok) throw runError;
    })();

    await this.running;
  }

  private controlWork: Promise<ResultType<void, AgentAdapterFailure>> | undefined;
  private nativeDeliveryWork: Promise<ResultType<void, OpaqueAgentValue>> | undefined;
  private nativeDeliveryFailure: OpaqueAgentValue;
  private readonly nativeInputGroups = new Map<string, readonly string[]>();
  private nativeDeliveryRequested = false;
  private nativeDeliveryScheduled = false;
  private executionTerminated = false;
  private scheduleNativeDelivery(): void {
    if (this.execution?.capabilities.steering !== "native" || this.executionTerminated) return;
    this.nativeDeliveryRequested = true;
    if (this.nativeDeliveryWork || this.nativeDeliveryScheduled) return;
    this.nativeDeliveryScheduled = true;
    queueMicrotask(() => this.beginNativeDelivery());
  }
  private beginNativeDelivery(): void {
    this.nativeDeliveryScheduled = false;
    if (!this.nativeDeliveryRequested || this.executionTerminated || this.nativeDeliveryWork)
      return;
    this.nativeDeliveryRequested = false;
    const work = captureAgentPromise(() => this.transferNativeInput());
    this.nativeDeliveryWork = work;
    void work.then((result) => this.settleNativeDelivery(work, result));
  }
  private settleNativeDelivery(
    work: Promise<ResultType<void, OpaqueAgentValue>>,
    result: ResultType<void, OpaqueAgentValue>,
  ): void {
    if (this.nativeDeliveryWork !== work) return;
    this.nativeDeliveryWork = undefined;
    const outcome = resultOutcome(result);
    if (!outcome.ok) {
      this.nativeDeliveryFailure = outcome.error;
      this.abortController?.abort();
      const execution = this.execution;
      if (execution) this.controlWork = execution.cancel();
      return;
    }
    if (this.nativeDeliveryRequested) this.scheduleNativeDelivery();
  }
  private async transferNativeInput(): Promise<void> {
    const execution = this.execution;
    const attempt = this.attempt;
    if (!execution || !attempt || this.cancelResetPending) return;
    const preparation = await this.prepareQueuedSteeringDelivery();
    if (preparation.status !== "prepared") return;
    if (this.executionTerminated) {
      this.clearSteeringDeliveryPreparation(preparation.preparation);
      return;
    }
    this.requireActiveAttempt(execution.attemptId);
    const batch = preparation.preparation;
    const entries = [...batch.followUpEntries, ...batch.steeringEntries];
    this.prepareInputBatch(entries, batch.canonicalMessages);
    this.clearSteeringDeliveryPreparation(batch);
    const first = entries[0];
    if (!first) return;
    this.nativeInputGroups.set(
      first.id,
      entries.map((entry) => entry.id),
    );
    const submitted = resultOutcome(
      execution.submitInput({ id: first.id, intent: "steer", messages: batch.canonicalMessages }),
    );
    if (submitted.ok) return;
    if (submitted.error.replaySafety !== "safe") return this.failAdapter(submitted.error);
    this.nativeInputGroups.delete(first.id);
    const returned = resultOutcome(attempt.returnPrepared(entries.map((entry) => entry.id)));
    if (!returned.ok) this.failAdapter(returned.error);
  }
  private attemptSequence = 0;
  private adapterSequence = 0;
  private readonly scopes = new Map<string, StepToolSnapshot<TOOLS>>();

  private failAdapter(error: AgentAdapterFailure): never {
    rethrowAgentPanic(error.cause);
    return signalExternalToolCallHost(
      new AgentExternalHostFailed({ cause: error.cause ?? error, message: error.message }),
    );
  }
  private requireSuppliedAttempt(expected: string, supplied: string): void {
    if (expected === supplied) return;
    this.failAdapter(
      new AgentAdapterFailure({
        reason: "invalid-state",
        message: "Host request belongs to a different attempt",
        replaySafety: "safe",
      }),
    );
  }
  private requireActiveAttempt(attemptId: string): void {
    if (this.attempt?.attemptId === attemptId && this.execution?.attemptId === attemptId) return;
    this.failAdapter(
      new AgentAdapterFailure({
        reason: "invalid-state",
        message: "Execution attempt is retired",
        replaySafety: "reconcile",
      }),
    );
  }
  private acceptAttemptEvent(event: AgentExecutionEvent): void {
    const attempt = this.attempt;
    if (!attempt)
      return this.failAdapter(
        new AgentAdapterFailure({
          reason: "invalid-state",
          message: "Execution attempt is missing",
          replaySafety: "reconcile",
        }),
      );
    const accepted = resultOutcome(attempt.accept({ ...event, sequence: this.attemptSequence }));
    if (!accepted.ok) return this.failAdapter(accepted.error);
    this.attemptSequence += 1;
  }
  private synchronizeCanonicalHistory(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    const canonical = truncateToLastValidBoundary(this.state.messages).messages;
    const previous = attempt.messages;
    const prefixMatches = isDeepStrictEqual(canonical.slice(0, previous.length), previous);
    if (!prefixMatches) {
      const rebased = resultOutcome(attempt.rebase(canonical));
      if (!rebased.ok) this.failAdapter(rebased.error);
      return;
    }
    const added = canonical.slice(previous.length);
    if (added.length === 0) return;
    const inputIds = this.canonicalInputIdsSinceCheckpoint.filter((id) => {
      const state = attempt.inputState(id);
      return state === "reserved" || state === "provider-owned";
    });
    this.acceptAttemptEvent({
      attemptId: attempt.attemptId,
      sequence: 0,
      type: "history-commit",
      messages: added,
      inputIds,
    });
  }
  private prepareInputBatch(
    entries: readonly SteeringDeliveryEntry[],
    messages: readonly ModelMessage[],
  ): void {
    const attempt = this.attempt;
    if (!attempt || entries.length === 0) return;
    for (const entry of entries) {
      if (attempt.inputState(entry.id) !== undefined) continue;
      const registered = resultOutcome(
        attempt.register({
          id: entry.id,
          intent: entry.id.startsWith("follow-up-") ? "follow-up" : "steer",
          messages: [entry.message],
        }),
      );
      if (!registered.ok) this.failAdapter(registered.error);
    }
    const ids = entries.map((entry) => entry.id);
    const reserved = resultOutcome(attempt.reserve(ids));
    if (!reserved.ok) this.failAdapter(reserved.error);
    const prepared = resultOutcome(attempt.preparedBatch(ids, messages));
    if (!prepared.ok) this.failAdapter(prepared.error);
  }
  private async hostResult<T>(
    operation: () => Promise<T>,
  ): Promise<ResultType<T, AgentAdapterFailure>> {
    const result = resultOutcome(await captureAgentPromise(operation));
    if (result.ok) return Result.ok(result.value);
    rethrowAgentPanic(result.error);
    return Result.err(
      new AgentAdapterFailure({
        reason: "unavailable",
        message: errorMessage(result.error),
        replaySafety: "reconcile",
        cause: result.error,
      }),
    );
  }
  private snapshotSystemPrompt(system: SystemPrompt): SystemPrompt {
    if (typeof system === "string") return system;
    const sourceSystem = Array.isArray(system) ? system : [system];
    const systemMessages = sourceSystem.map((message) => {
      const snapshot = snapshotAgentMessage(message);
      if (snapshot.role === "system") return snapshot;
      return signalAgentStateHost(
        new AgentStateTransitionFailed({
          operation: "snapshot execution state",
          message: "System snapshot has a different role",
        }),
      );
    });
    if (Array.isArray(system)) return systemMessages;
    return systemMessages[0]!;
  }
  private snapshotExecutionState(): AgentExecutionState<TOOLS> {
    const options = snapshotAgentMessage({
      role: "system",
      content: "",
      providerOptions: this.state.providerOptions,
    });
    const partial = this.state.streamMessage
      ? snapshotAgentMessage(this.state.streamMessage)
      : null;
    const debug = this.state.debug;
    return Object.freeze({
      system: this.snapshotSystemPrompt(this.state.system),
      modelSpecifier: this.state.modelSpecifier,
      messages: this.state.messages.map(snapshotAgentMessage),
      isStreaming: this.state.isStreaming,
      streamMessage: partial?.role === "assistant" ? partial : null,
      pendingToolCalls: new Set(this.state.pendingToolCalls),
      error: this.state.error,
      providerOptions: options.providerOptions,
      reasoning: this.state.reasoning,
      debug: debug
        ? Object.freeze({
            ...debug,
            lastModelViewMessages: debug.lastModelViewMessages?.map(snapshotAgentMessage),
          })
        : undefined,
    });
  }
  private createExecutionHost(attemptId: string): AgentExecutionHost<TOOLS> {
    const active = () => this.requireActiveAttempt(attemptId);
    return {
      controlBoundary: async () => {
        active();
        return await this.checkControlBoundary();
      },
      prepareRequest: async (request) => {
        active();
        const prepared = await this.prepareExecutionRequest(request);
        active();
        this.scopes.set(prepared.scopeId, this.lastStepToolSnapshot!);
        this.synchronizeCanonicalHistory();
        return prepared;
      },
      commitTurn: async (turn) => {
        active();
        await this.commitExecutionTurn(turn);
        active();
      },
      finishBoundary: async (input) => {
        active();
        const result = await this.finishExecutionBoundary(input);
        active();
        this.synchronizeCanonicalHistory();
        return result;
      },
      settleFailure: async (error, context) => {
        active();
        return await this.settleExecutionFailure(error, context);
      },
      executeToolBatch: async (calls, scopeId) => {
        active();
        const snapshot = this.scopes.get(scopeId);
        if (!snapshot)
          return Result.err(
            new ToolBatchExecutionFailed({
              cause: new Error("Unknown tool authority scope"),
              message: "Unknown tool authority scope",
            }),
          );
        const result = await this.toolHost.executeToolCalls(calls, snapshot);
        active();
        const outcome = resultOutcome(result);
        if (outcome.ok) this.recoveryCheckpoint = null;
        this.synchronizeCanonicalHistory();
        return result;
      },
      readState: () => {
        active();
        return this.snapshotExecutionState();
      },
      recordModelView: (messages, step) => {
        active();
        if (!this.captureModelViewMessages) return;
        this.state.debug ??= {};
        this.state.debug.lastModelViewMessages = messages.map(snapshotAgentMessage);
        this.state.debug.lastModelViewTurn = step;
        this.state.debug.lastModelViewCapturedAt = Date.now();
      },
      signal: () => this.abortController?.signal,
      abortReason: () => this.getAbortReason(),
      publish: (event) => {
        active();
        this.emit(event);
      },
      checkpointDraft: (message) => {
        active();
        this.checkpointRecoveryDraft(message);
      },
      setStreamMessage: (message) => {
        active();
        this.state.streamMessage = message;
      },
      normalizeToolMessage: (message) => this.toolHost.normalizeNewToolMessage(message),
      normalizeAssistantMessage: (message) => this.toolHost.normalizeNewAssistantMessage(message),
      clearNormalizedCalls: () => this.toolHost.clearNormalizedCalls(),
      observeExternalTools: (handler) => {
        active();
        this.externalToolStarted = handler;
      },
      prepareContext: (context) =>
        this.hostResult(async () => {
          active();
          this.requireSuppliedAttempt(attemptId, context.attemptId);
          context.signal.throwIfAborted();
          const prepared = await this.prepareExecutionRequest({
            executionMode: "local-tools",
            signal: AbortSignal.any([
              context.signal,
              ...(this.abortController ? [this.abortController.signal] : []),
            ]),
            onErrorPhase: () => {},
            selectRequest: async () => ({
              executionMode: "local-tools",
              payload: { mode: "full" },
            }),
          });
          active();
          this.scopes.set(prepared.scopeId, this.lastStepToolSnapshot!);
          const tools = await Promise.all(
            Object.entries(prepared.tools).map(async ([name, definition]) => ({
              name,
              description:
                typeof definition.description === "function"
                  ? definition.description({ context: this.context })
                  : (definition.description ?? ""),
              inputSchemaJson: JSON.stringify(await asSchema(definition.inputSchema).jsonSchema),
            })),
          );
          return {
            scopeId: prepared.scopeId,
            messages: prepared.messages,
            canonicalMessages: this.state.messages.map(cloneMessage),
            system: prepared.system,
            tools,
          };
        }),
      executeTools: (context) =>
        this.hostResult(async () => {
          active();
          if (context.attemptId !== attemptId)
            this.failAdapter(
              new AgentAdapterFailure({
                reason: "invalid-state",
                message: "Tool request belongs to another attempt",
                replaySafety: "safe",
              }),
            );
          const snapshot = this.scopes.get(context.scopeId);
          if (!snapshot)
            this.failAdapter(
              new AgentAdapterFailure({
                reason: "invalid-state",
                message: "Tool authority scope is unknown",
                replaySafety: "safe",
              }),
            );
          const results = [];
          for (const call of context.calls) {
            const outcome = await this.toolHost.executeExternalToolCall(
              {
                toolCallId: call.callId,
                toolName: call.name,
                input: normalizeToolCallInputValue(call.inputJson),
                abortSignal: context.signal,
              },
              snapshot,
              context.calls.map((request) => request.name),
            );
            active();
            results.push({
              callId: call.callId,
              ...projectExternalToolOutcome(outcome),
              message: {
                role: "tool" as const,
                content: [
                  {
                    type: "tool-result" as const,
                    toolCallId: call.callId,
                    toolName: call.name,
                    output: outcome.toolOutput,
                  },
                ],
              },
            });
          }
          return results;
        }),
      boundary: (context) =>
        this.hostResult(async () => {
          active();
          this.requireSuppliedAttempt(attemptId, context.attemptId);
          context.signal.throwIfAborted();
          const action = await this.finishExecutionBoundary(context);
          active();
          this.synchronizeCanonicalHistory();
          return action === "continue"
            ? {
                action: "continue" as const,
                inputs: [],
                messages: this.state.messages.map(cloneMessage),
              }
            : { action: "complete" as const, messages: this.state.messages.map(cloneMessage) };
        }),
    };
  }
  private async runAdapterExecution(): Promise<void> {
    const attemptId = `execution-${++this.attemptCounter}`;
    this.attempt = new AgentAttempt(attemptId, this.state.messages);
    this.attemptSequence = 0;
    this.adapterSequence = 0;
    this.executionTerminated = false;
    this.nativeDeliveryFailure = undefined;
    const execution = this.adapter.createExecution({
      attemptId,
      messages: this.state.messages.map(cloneMessage),
      host: this.createExecutionHost(attemptId),
    });
    this.execution = execution;
    const outcome = resultOutcome(
      await captureAgentPromise(async () => {
        const started = resultOutcome(execution.start());
        if (!started.ok) this.failAdapter(started.error);
        for await (const received of execution.events) {
          const event = this.expandNativeInputIds(received);
          this.requireActiveAttempt(attemptId);
          if (event.sequence !== this.adapterSequence)
            this.failAdapter(
              new AgentAdapterFailure({
                reason: "protocol",
                message: "Adapter event is out of order",
                replaySafety: "reconcile",
              }),
            );
          this.adapterSequence += 1;
          if (event.type === "terminal") this.executionTerminated = true;
          this.acceptAttemptEvent(event);
          if (event.type === "terminal") {
            if (event.outcome.status === "failed") this.failAdapter(event.outcome.error);
            if (this.cancelResetPending) this.finishCancellation();
            return;
          }
          this.projectExecutionEvent(event);
        }
        this.failAdapter(
          new AgentAdapterFailure({
            reason: "protocol",
            message: "Adapter ended without a terminal event",
            replaySafety: "reconcile",
          }),
        );
      }),
    );
    const nativeWork = this.nativeDeliveryWork;
    if (nativeWork) {
      const delivered = resultOutcome(await nativeWork);
      if (!delivered.ok) this.nativeDeliveryFailure = delivered.error;
    }
    const controlled = resultOutcome(
      await captureAgentPromise(async () =>
        this.controlWork ? await this.controlWork : Result.ok<void, AgentAdapterFailure>(undefined),
      ),
    );
    const disposed = resultOutcome(await captureAgentPromise(() => execution.dispose()));
    this.attempt.retire();
    this.attempt = undefined;
    this.execution = undefined;
    this.controlWork = undefined;
    this.nativeDeliveryWork = undefined;
    this.nativeDeliveryRequested = false;
    this.externalToolStarted = undefined;
    this.scopes.clear();
    this.nativeInputGroups.clear();
    if (!outcome.ok)
      return signalExternalToolCallHost(
        new AgentExternalHostFailed({ cause: outcome.error, message: errorMessage(outcome.error) }),
      );
    if (this.nativeDeliveryFailure !== undefined)
      return signalExternalToolCallHost(
        new AgentExternalHostFailed({
          cause: this.nativeDeliveryFailure,
          message: errorMessage(this.nativeDeliveryFailure),
        }),
      );
    if (!controlled.ok)
      return signalExternalToolCallHost(
        new AgentExternalHostFailed({
          cause: controlled.error,
          message: errorMessage(controlled.error),
        }),
      );
    const controlResult = resultOutcome(controlled.value);
    if (!controlResult.ok) this.failAdapter(controlResult.error);
    if (!disposed.ok)
      return signalExternalToolCallHost(
        new AgentExternalHostFailed({
          cause: disposed.error,
          message: errorMessage(disposed.error),
        }),
      );
    const disposeResult = resultOutcome(disposed.value);
    if (!disposeResult.ok) this.failAdapter(disposeResult.error);
  }

  private acceptPresentation(attemptId: string, event: AgentEvent<ToolSet>): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "message",
          phase: presentationMessagePhase(event.type),
          message: event.message,
        });
        return;
      case "turn_warnings":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "warnings",
          warnings: event.warnings,
        });
        return;
      case "turn_start":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "turn-start",
          step: this.turnCounter,
        });
        return;
      case "turn_end":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "turn-end",
          finishReason: event.finishReason,
          messages: event.newMessages,
          usage: event.usage,
          totalUsage: event.totalUsage,
        });
        return;
      case "turn_retry":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "turn-retry",
          hadPartialOutput: event.hadPartialOutput,
          abandonedToolCallIds: event.abandonedToolCallIds,
        });
        return;
      case "turn_abort":
        this.acceptAttemptEvent({
          attemptId,
          sequence: 0,
          type: "turn-abort",
          reason: event.reason,
          phase: event.phase,
          detail: event.detail,
        });
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "agent_start":
      case "agent_end":
      case "steering_delivery_failed":
      case "messages_reset":
        return;
    }
  }

  private expandNativeInputIds(event: AgentExecutionEvent): AgentExecutionEvent {
    if (event.type !== "delivery" && event.type !== "history-commit") return event;
    const inputIds = [
      ...new Set(event.inputIds.flatMap((id) => this.nativeInputGroups.get(id) ?? [id])),
    ];
    return { ...event, inputIds };
  }
  private projectExecutionEvent(event: AgentExecutionEvent): void {
    switch (event.type) {
      case "history-commit":
        for (const message of event.messages) this.appendMessage(cloneMessage(message));
        this.canonicalInputIdsSinceCheckpoint.push(...event.inputIds);
        this.steeringQueue = this.steeringQueue.filter(
          (entry) => !event.inputIds.includes(entry.id),
        );
        this.followUpQueue = this.followUpQueue.filter(
          (entry) => !event.inputIds.includes(entry.id),
        );
        this.state.streamMessage = null;
        this.scheduleNativeDelivery();
        return;
      case "history-checkpoint":
        this.recoveryCheckpoint = recoveryCheckpointForMessages(event.messages);
        return;
      case "usage":
        this.runTotalUsage = sumLanguageModelUsage(this.runTotalUsage, event.usage);
        return;
      case "message":
        this.emit({
          type: event.phase === "start" ? "message_start" : "message_end",
          message: cloneMessage(event.message),
        });
        return;
      case "output": {
        const output = event.output;
        const partial = this.state.streamMessage ?? { role: "assistant" as const, content: [] };
        if (!this.state.streamMessage)
          this.emit({ type: "message_start", message: cloneMessage(partial) });
        if (
          Array.isArray(partial.content) &&
          output.phase === "delta" &&
          output.kind !== "tool-input"
        )
          upsertTextPart(partial.content, output.kind, output.delta ?? "");
        this.state.streamMessage = partial;
        this.emit({
          type: "message_update",
          message: cloneMessage(partial),
          assistantMessageEvent: projectAgentOutput(output),
        });
        if (output.phase === "end")
          this.emit({ type: "message_end", message: cloneMessage(partial) });
        return;
      }
      case "turn-start":
        this.emit({ type: "turn_start" });
        return;
      case "turn-end":
        this.emit({
          type: "turn_end",
          finishReason: event.finishReason,
          newMessages: [...event.messages],
          usage: event.usage,
          totalUsage: event.totalUsage,
        });
        return;
      case "turn-retry":
        this.emit({
          type: "turn_retry",
          hadPartialOutput: event.hadPartialOutput,
          abandonedToolCallIds: [...event.abandonedToolCallIds],
        });
        return;
      case "turn-abort":
        this.emit({
          type: "turn_abort",
          reason: event.reason,
          phase: event.phase,
          detail: event.detail,
        });
        return;
      case "warnings":
        this.emit({ type: "turn_warnings", warnings: [...event.warnings] });
        return;
      case "delivery":
      case "tool-activity":
      case "content":
      case "terminal":
        return;
    }
  }

  private async applyTurnBoundary(input: {
    finishReason: FinishReason;
    modelInputMessages: readonly ModelMessage[];
    executedToolCallCount: number;
    signal?: AbortSignal;
  }): Promise<{ requiresNextTurn: boolean }> {
    if (!this.turnBoundaryHandler) return { requiresNextTurn: false };

    const getAbortReason = (): TurnAbortReason =>
      this.abortRequestedReason ?? (this.pendingInterrupt ? "interrupt" : "manual");
    const assertNotAborted = () => {
      if ((input.signal ?? this.abortController?.signal)?.aborted) {
        signalAgentStateHost(new TurnAbortedError({ reason: getAbortReason(), phase: "tools" }));
      }
    };

    assertNotAborted();
    const decision = await this.turnBoundaryHandler({
      finishReason: input.finishReason,
      modelInputMessages: input.modelInputMessages.map(cloneMessage),
      executedToolCallCount: input.executedToolCallCount,
      abortSignal: input.signal ?? this.abortController?.signal,
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
}
