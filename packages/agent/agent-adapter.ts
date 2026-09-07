import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
} from "ai";
import { isDeepStrictEqual } from "node:util";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { cloneAgentMessage, snapshotAgentMessage } from "./message-clone";
import type { OpaqueAgentValue } from "./failure-adapters";

export type AgentInput = {
  readonly id: string;
  readonly intent: "steer" | "follow-up" | "interrupt";
  readonly messages: readonly ModelMessage[];
};

export type AgentCapabilities = {
  readonly steering: "native" | "boundary" | "unsupported";
  readonly followUp: "boundary" | "unsupported";
  readonly interruption: "native" | "restart" | "unsupported";
};

export class AgentAdapterFailure extends TaggedError("AgentAdapterFailure")<{
  readonly reason: "protocol" | "unavailable" | "cancelled" | "invalid-state";
  readonly message: string;
  readonly replaySafety: "safe" | "reconcile";
  readonly cause?: OpaqueAgentValue;
}> {}

export type AgentRecoveryRequired = {
  readonly attemptId: string;
  readonly inputIds: readonly string[];
};

export type AgentToolRequest = {
  readonly callId: string;
  readonly name: string;
  readonly inputJson: string;
};

export type AgentToolResult = {
  readonly callId: string;
  readonly message: ToolModelMessage;
  readonly expansionMessages?: readonly ModelMessage[];
  readonly executedCallCount?: number;
};

export type AgentPreparedContext = {
  readonly scopeId: string;
  readonly step: number;
  readonly canonicalMessages: readonly ModelMessage[];
  readonly messages: readonly ModelMessage[];
  readonly system: string | SystemModelMessage | readonly SystemModelMessage[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchemaJson: string;
    readonly strict?: boolean;
    readonly providerOptions?: ModelMessage["providerOptions"];
    readonly outputSchemaJson?: string;
  }[];
};

export interface AgentHostServices {
  prepareContinuation(context: {
    readonly attemptId: string;
    readonly scopeId: string;
    readonly signal: AbortSignal;
  }): Promise<ResultType<AgentPreparedContext, AgentAdapterFailure>>;
  beginContinuation(context: {
    readonly attemptId: string;
    readonly scopeId: string;
    readonly signal: AbortSignal;
  }): Promise<ResultType<void, AgentAdapterFailure>>;
  awaitEvent(context: {
    readonly attemptId: string;
    readonly sequence: number;
  }): Promise<ResultType<void, AgentAdapterFailure>>;
  boundary(context: {
    readonly attemptId: string;
    readonly finishReason: FinishReason;
    readonly modelInputMessages: readonly ModelMessage[];
    readonly executedToolCallCount: number;
    readonly naturallyRequiresContinuation: boolean;
    readonly signal: AbortSignal;
  }): Promise<
    ResultType<
      | {
          readonly action: "continue";
          readonly inputs: readonly AgentInput[];
          readonly messages: readonly ModelMessage[];
        }
      | { readonly action: "complete"; readonly messages: readonly ModelMessage[] },
      AgentAdapterFailure
    >
  >;
  prepareContext(context: {
    readonly attemptId: string;
    readonly messages: readonly ModelMessage[];
    readonly step: number;
    readonly signal: AbortSignal;
  }): Promise<ResultType<AgentPreparedContext, AgentAdapterFailure>>;
  executeTools(context: {
    readonly attemptId: string;
    readonly scopeId: string;
    readonly calls: readonly AgentToolRequest[];
    readonly signal: AbortSignal;
    readonly onSettled?: (result: AgentToolResult) => void | Promise<void>;
  }): Promise<ResultType<readonly AgentToolResult[], AgentAdapterFailure>>;
}

export type AgentOutput = {
  readonly kind: "text" | "reasoning" | "tool-input";
  readonly phase: "start" | "delta" | "end";
  readonly id: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly messagePhase?: "commentary" | "final_answer";
  readonly providerOptions?: ModelMessage["providerOptions"];
};

export type AgentContentValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentContentValue[]
  | { readonly [key: string]: AgentContentValue };

export type AgentExecutionEvent = {
  readonly attemptId: string;
  readonly sequence: number;
} & (
  | { readonly type: "output"; readonly output: AgentOutput }
  | {
      readonly type: "message";
      readonly phase: "start" | "update" | "end";
      readonly message: ModelMessage;
    }
  | { readonly type: "turn-start"; readonly step: number }
  | {
      readonly type: "turn-end";
      readonly finishReason: FinishReason;
      readonly messages: readonly ModelMessage[];
      readonly usage: LanguageModelUsage;
      readonly totalUsage: LanguageModelUsage;
    }
  | {
      readonly type: "turn-retry";
      readonly hadPartialOutput: boolean;
      readonly abandonedToolCallIds: readonly string[];
    }
  | {
      readonly type: "turn-abort";
      readonly reason: "cancel" | "interrupt" | "manual" | "recovery";
      readonly phase: "model" | "tools";
      readonly detail?: string;
    }
  | {
      readonly type: "warnings";
      readonly warnings: readonly import("ai").CallWarning[];
    }
  | {
      readonly type: "content";
      readonly kind: "source" | "file" | "reasoning-file" | "custom";
      readonly data: AgentContentValue;
    }
  | {
      readonly type: "history-checkpoint";
      readonly messages: readonly ModelMessage[];
    }
  | {
      readonly type: "delivery";
      readonly inputIds: readonly string[];
      readonly status: "provider-owned" | "returned" | "unresolved";
    }
  | {
      readonly type: "history-commit";
      readonly messages: readonly ModelMessage[];
      readonly inputIds: readonly string[];
    }
  | {
      readonly type: "tool-activity";
      readonly callId: string;
      readonly phase: "start" | "end";
    }
  | {
      readonly type: "usage";
      readonly responseId: string;
      readonly usage: LanguageModelUsage;
    }
  | {
      readonly type: "terminal";
      readonly outcome:
        | { readonly status: "completed" | "cancelled" | "interrupted" }
        | { readonly status: "failed"; readonly error: AgentAdapterFailure };
    }
);

export interface AgentExecution {
  readonly attemptId: string;
  readonly retryOwner?: "host" | "adapter";
  readonly capabilities: AgentCapabilities;
  readonly events: AsyncIterable<AgentExecutionEvent>;
  // Construction is dormant so the host can install observers before any work begins.
  start(): ResultType<void, AgentAdapterFailure>;
  // Success acknowledges local submission. Only ordered events transfer delivery ownership.
  submitInput(input: AgentInput): ResultType<void, AgentAdapterFailure>;
  interrupt(): Promise<ResultType<void, AgentAdapterFailure>>;
  cancel(): Promise<ResultType<void, AgentAdapterFailure>>;
  dispose(): Promise<ResultType<void, AgentAdapterFailure>>;
}

export interface AgentAdapter<HOST extends AgentHostServices = AgentHostServices> {
  createExecution(context: {
    readonly attemptId: string;
    readonly messages: readonly ModelMessage[];
    readonly host: HOST;
  }): AgentExecution;
}

export type AgentInputState =
  | "queued"
  | "reserved"
  | "provider-owned"
  | "committed"
  | "returned"
  | "unresolved";

type OwnedInput = {
  readonly input: AgentInput;
  state: AgentInputState;
  preparedMessages: readonly ModelMessage[];
  preparedInputIds: readonly string[];
};

function invalidState(message: string): ResultType<never, AgentAdapterFailure> {
  return Result.err(
    new AgentAdapterFailure({ reason: "invalid-state", message, replaySafety: "reconcile" }),
  );
}

function validateToolExchange(messages: readonly ModelMessage[]): string | undefined {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          if (!pending.delete(part.toolCallId))
            return "Canonical history contains an orphan tool result";
          continue;
        }
        if (part.type !== "tool-call") continue;
        if (seen.has(part.toolCallId)) return "Canonical history repeats a tool call";
        seen.add(part.toolCallId);
        pending.add(part.toolCallId);
      }
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        if (!pending.delete(part.toolCallId))
          return "Canonical history contains an orphan tool result";
      }
      continue;
    }
    if (pending.size > 0) return "Canonical history interrupts an unsettled tool exchange";
  }
  if (pending.size > 0) return "Canonical history contains an unsettled tool exchange";
  return undefined;
}

/** Process-local arbitration. Durable acceptance and replay remain host responsibilities. */
export class AgentAttempt {
  private readonly inputs = new Map<string, OwnedInput>();
  private readonly responseUsage = new Set<string>();
  private nextSequence = 0;
  private retired = false;
  private terminal = false;
  private history: ModelMessage[];

  constructor(
    readonly attemptId: string,
    messages: readonly ModelMessage[] = [],
  ) {
    this.history = messages.map(snapshotAgentMessage);
  }

  get messages(): readonly ModelMessage[] {
    return this.history.map(snapshotAgentMessage);
  }

  get pendingInputs(): readonly AgentInput[] {
    return [...this.inputs.values()]
      .filter((entry) => entry.state !== "committed")
      .map((entry) => ({
        ...entry.input,
        messages: entry.input.messages.map(snapshotAgentMessage),
      }));
  }

  get boundaryInputs(): readonly AgentInput[] {
    return [...this.inputs.values()]
      .filter((entry) => entry.state === "queued" || entry.state === "returned")
      .map((entry) => ({
        ...entry.input,
        messages: entry.input.messages.map(snapshotAgentMessage),
      }));
  }

  inputState(id: string): AgentInputState | undefined {
    return this.inputs.get(id)?.state;
  }

  register(input: AgentInput): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    if (input.messages.length === 0) return invalidState("Input must contain canonical messages");
    if (this.inputs.has(input.id)) return invalidState("Input ID is already registered");
    return Result.all(input.messages.map(cloneAgentMessage))
      .mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: error.message,
            replaySafety: "safe",
          }),
      )
      .map((messages) => {
        this.inputs.set(input.id, {
          input: { ...input, messages },
          state: "queued",
          preparedMessages: messages,
          preparedInputIds: [input.id],
        });
      });
  }

  reserve(inputIds: readonly string[]): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    return this.transition(inputIds, ["queued", "returned"], "reserved");
  }

  prepared(input: AgentInput): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    const entry = this.inputs.get(input.id);
    if (!entry || entry.state !== "reserved")
      return invalidState("Input is not reserved for preparation");
    if (entry.preparedInputIds.length !== 1)
      return invalidState("Merged input must be prepared as a complete batch");
    if (input.intent !== entry.input.intent)
      return invalidState("Preparation cannot change input intent");
    if (input.messages.length === 0)
      return invalidState("Prepared input must contain canonical messages");
    return Result.all(input.messages.map(cloneAgentMessage))
      .mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: error.message,
            replaySafety: "safe",
          }),
      )
      .map((messages) => {
        entry.preparedMessages = messages;
      });
  }

  returnPrepared(inputIds: readonly string[]): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    return this.transition(inputIds, ["reserved"], "returned");
  }

  preparedBatch(
    inputIds: readonly string[],
    messages: readonly ModelMessage[],
  ): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    if (inputIds.length === 0 || messages.length === 0)
      return invalidState("Prepared batch must contain inputs and canonical messages");
    return Result.gen(function* (this: AgentAttempt) {
      const cloned = yield* Result.all(messages.map(cloneAgentMessage)).mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: error.message,
            replaySafety: "safe",
          }),
      );
      yield* this.transition(inputIds, ["reserved"], "reserved");
      const batchIds = [...inputIds];
      for (const entry of this.inputs.values()) {
        if (!batchIds.includes(entry.input.id)) continue;
        entry.preparedMessages = cloned;
        entry.preparedInputIds = batchIds;
      }
      return Result.ok(undefined);
    }, this);
  }

  retire(): void {
    this.retired = true;
    this.unresolveOutstanding();
  }

  rebase(messages: readonly ModelMessage[]): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    const invalid = validateToolExchange(messages);
    if (invalid) return invalidState(invalid);
    return Result.all(messages.map(cloneAgentMessage))
      .mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: error.message,
            replaySafety: "safe",
          }),
      )
      .map((cloned) => {
        this.history = cloned;
      });
  }

  accept(event: AgentExecutionEvent): ResultType<void, AgentAdapterFailure> {
    if (this.retired || this.terminal) return invalidState("Attempt is no longer active");
    if (event.attemptId !== this.attemptId)
      return invalidState("Event belongs to a different attempt");
    if (event.sequence !== this.nextSequence) return invalidState("Event is out of order");
    return this.apply(event).map(() => {
      this.nextSequence += 1;
    });
  }

  private apply(event: AgentExecutionEvent): ResultType<void, AgentAdapterFailure> {
    switch (event.type) {
      case "delivery":
        return this.transition(event.inputIds, ["reserved", "provider-owned"], event.status);
      case "history-commit":
        return this.commit(event.messages, event.inputIds);
      case "history-checkpoint": {
        const invalid = validateToolExchange(event.messages);
        if (invalid) return invalidState(invalid);
        return Result.ok(undefined);
      }
      case "usage":
        if (this.responseUsage.has(event.responseId))
          return invalidState("Response usage was already accepted");
        this.responseUsage.add(event.responseId);
        return Result.ok(undefined);
      case "terminal":
        if (event.outcome.status === "completed" && this.pendingInputs.length > 0) {
          return invalidState("Completed execution has uncommitted inputs");
        }
        this.terminal = true;
        this.unresolveOutstanding();
        return Result.ok(undefined);
      case "message":
      case "output":
      case "tool-activity":
      case "turn-start":
      case "turn-end":
      case "turn-retry":
      case "turn-abort":
      case "warnings":
      case "content":
        return Result.ok(undefined);
    }
  }

  private commit(
    messages: readonly ModelMessage[],
    inputIds: readonly string[],
  ): ResultType<void, AgentAdapterFailure> {
    const history = [...this.history, ...messages];
    const invalid = validateToolExchange(history);
    if (invalid) return invalidState(invalid);
    const invalidInputs = this.validateCommittedInputs(messages, inputIds);
    if (invalidInputs) return invalidState(invalidInputs);
    return Result.gen(function* (this: AgentAttempt) {
      const cloned = yield* Result.all(history.map(cloneAgentMessage)).mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: error.message,
            replaySafety: "safe",
          }),
      );
      yield* this.transition(inputIds, ["reserved", "provider-owned"], "committed");
      this.history = cloned;
      return Result.ok(undefined);
    }, this);
  }

  private validateCommittedInputs(
    messages: readonly ModelMessage[],
    inputIds: readonly string[],
  ): string | undefined {
    let offset = 0;
    const matchedBatches = new Set<readonly string[]>();
    for (const id of inputIds) {
      const entry = this.inputs.get(id);
      if (!entry) return "Canonical commit references an unregistered input";
      for (const predecessor of this.inputs.values()) {
        if (predecessor.input.id === id) break;
        if (predecessor.input.intent !== entry.input.intent) continue;
        if (predecessor.state === "committed" || inputIds.includes(predecessor.input.id)) continue;
        return "Canonical commit skips an earlier input with the same intent";
      }
      if (matchedBatches.has(entry.preparedInputIds)) continue;
      matchedBatches.add(entry.preparedInputIds);
      const expected = entry.preparedMessages;
      let found = false;
      for (; offset + expected.length <= messages.length; offset += 1) {
        if (!isDeepStrictEqual(messages.slice(offset, offset + expected.length), expected))
          continue;
        offset += expected.length;
        found = true;
        break;
      }
      if (!found) return "Canonical commit omits or reorders an input";
    }
    return undefined;
  }

  private transition(
    inputIds: readonly string[],
    allowed: readonly AgentInputState[],
    next: AgentInputState,
  ): ResultType<void, AgentAdapterFailure> {
    if (new Set(inputIds).size !== inputIds.length)
      return invalidState("Input IDs repeat within a delivery");
    const registeredIds = [...this.inputs.keys()];
    let previousIndex = -1;
    for (const id of inputIds) {
      const index = registeredIds.indexOf(id);
      if (index <= previousIndex) return invalidState("Input IDs are out of queue order");
      previousIndex = index;
    }
    const entries: OwnedInput[] = [];
    for (const id of inputIds) {
      const entry = this.inputs.get(id);
      if (!entry || !allowed.includes(entry.state))
        return invalidState("Input ownership transition is invalid");
      if (entry.preparedInputIds.some((id) => !inputIds.includes(id)))
        return invalidState("Merged input ownership must move as a complete batch");
      entries.push(entry);
    }
    for (const entry of entries) entry.state = next;
    return Result.ok(undefined);
  }

  private unresolveOutstanding(): void {
    for (const entry of this.inputs.values()) {
      if (entry.state !== "reserved" && entry.state !== "provider-owned") continue;
      entry.state = "unresolved";
    }
  }
}
