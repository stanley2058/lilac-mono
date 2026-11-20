import type { ProjectSettledToolResult } from "./agent-execution-host";
import { groupToolCalls } from "./tool-call-scheduling";
import type {
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  ToolSet,
  ToolResultPart,
} from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  executeAtomicToolCallResult,
  normalizeToolResultOutput,
  type AtomicToolExecutionOutcome,
  type AtomicToolExecutionFailed,
  type AtomicToolExecutionEvent,
  type NormalizeToolResultOutputFn,
  type ToolResultOutput,
} from "./atomic-tool-execution";
import { captureAgentPromise, rethrowAgentPanic, type OpaqueAgentValue } from "./failure-adapters";
import type { AgentToolCall } from "./tool-call";
import { cloneMessage, canonicalToolName } from "./agent-runtime-support";

type AssistantContentParts = Extract<AssistantContent, unknown[]>;
export type StepToolSnapshot<TOOLS extends ToolSet = ToolSet> = {
  /** Monotonic model-step number, 1-based. */
  readonly step: number;
  /** Exact tool implementations authorized for calls produced by this step. */
  readonly tools: TOOLS;
  /** Authorized names in toolset order. */
  readonly names: readonly string[];
};

export type ExternalToolExecutionOutcome = AtomicToolExecutionOutcome;

function hiddenToolRejection(toolName: string): string {
  return `Tool '${toolName}' was not offered on the step that produced this call, so it was not executed.`;
}

function toolExecutionRejection(options: {
  readonly toolName: string;
  readonly snapshotTools: ToolSet;
  readonly currentTools: ToolSet;
  readonly hasExclusiveTool: boolean;
  readonly exclusiveToolNames: ReadonlySet<string>;
}): string | undefined {
  if (
    options.snapshotTools[options.toolName] === undefined &&
    options.currentTools[options.toolName]
  ) {
    return hiddenToolRejection(options.toolName);
  }
  if (options.hasExclusiveTool && !options.exclusiveToolNames.has(options.toolName)) {
    return `Tool '${options.toolName}' was not executed because an exclusive tool was selected in the same turn. Retry it after processing the exclusive tool result.`;
  }
  return undefined;
}

export class ToolBatchExecutionFailed extends TaggedError("ToolBatchExecutionFailed")<{
  readonly cause: OpaqueAgentValue;
  readonly message: string;
}> {}

function signalExternalToolCallHost(
  error: AtomicToolExecutionFailed | ToolBatchExecutionFailed,
): never {
  throw error.cause;
}
function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export interface AgentToolHostOptions<TOOLS extends ToolSet> {
  readState(): { tools: TOOLS; messages: ModelMessage[]; pendingToolCalls: Set<string> };
  readContext(): OpaqueAgentValue;
  readAbortSignal(): AbortSignal | undefined;
  assertNotAborted(signal?: AbortSignal): void;
  makeAbortError(): Error;
  readLastStepSnapshot(): StepToolSnapshot<TOOLS> | null;
  readToolExchangeBaseLength(): number;
  emit(
    event:
      | AtomicToolExecutionEvent
      | { type: "message_start" | "message_end"; message: ModelMessage },
  ): void;
  appendMessage(message: ModelMessage): void;
  checkpointMessages(candidate?: ModelMessage[]): void;
  normalizeToolResultOutput?: NormalizeToolResultOutputFn;
  genericOutputNormalizerBypassTools?: ReadonlySet<string>;
  aggregateOutputBudgetExemptTools?: ReadonlySet<string>;
  exclusiveToolNames?: ReadonlySet<string>;
}

export class AgentToolHost<TOOLS extends ToolSet> {
  private normalizeToolResultOutput: NormalizeToolResultOutputFn | undefined;
  private genericOutputNormalizerBypassTools: ReadonlySet<string>;
  private aggregateOutputBudgetExemptTools: ReadonlySet<string>;
  private exclusiveToolNames: ReadonlySet<string>;
  private alreadyNormalizedExternalToolCallIds = new Set<string>();
  constructor(private readonly host: AgentToolHostOptions<TOOLS>) {
    this.normalizeToolResultOutput = host.normalizeToolResultOutput;
    this.genericOutputNormalizerBypassTools = new Set(host.genericOutputNormalizerBypassTools);
    this.aggregateOutputBudgetExemptTools = new Set(host.aggregateOutputBudgetExemptTools);
    this.exclusiveToolNames = new Set(host.exclusiveToolNames);
  }
  setNormalizeToolResultOutput(value: NormalizeToolResultOutputFn | undefined) {
    this.normalizeToolResultOutput = value;
  }
  setGenericOutputNormalizerBypassTools(value: ReadonlySet<string>) {
    this.genericOutputNormalizerBypassTools = new Set(value);
  }
  setAggregateOutputBudgetExemptTools(value: ReadonlySet<string>) {
    this.aggregateOutputBudgetExemptTools = new Set(value);
  }
  setExclusiveToolNames(value: ReadonlySet<string>) {
    this.exclusiveToolNames = new Set(value);
  }
  clearNormalizedCalls(): void {
    this.alreadyNormalizedExternalToolCallIds.clear();
  }
  private markExternalToolCallNormalized(toolCallId: string): void {
    this.alreadyNormalizedExternalToolCallIds.delete(toolCallId);
    this.alreadyNormalizedExternalToolCallIds.add(toolCallId);
    while (this.alreadyNormalizedExternalToolCallIds.size > 256) {
      const oldest = this.alreadyNormalizedExternalToolCallIds.values().next().value;
      if (oldest === undefined) break;
      this.alreadyNormalizedExternalToolCallIds.delete(oldest);
    }
  }

  /** Execute a provider-originated tool call through the same atomic path as local calls. */
  async executeExternalToolCall(
    input: {
      toolCallId: string;
      toolName: string;
      input: unknown;
      abortSignal?: AbortSignal;
      inputValidation?: "validate" | "prevalidated";
    },
    toolSnapshot?: StepToolSnapshot<TOOLS>,
    cohortNames?: readonly string[],
  ): Promise<AtomicToolExecutionOutcome> {
    const signals = [input.abortSignal, this.host.readAbortSignal()].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    let abortSignal: AbortSignal | undefined;
    if (signals.length > 1) abortSignal = AbortSignal.any(signals);
    else if (signals.length === 1) abortSignal = signals[0];

    const snapshot: StepToolSnapshot<TOOLS> = toolSnapshot ??
      this.host.readLastStepSnapshot() ?? {
        step: 0,
        tools: this.host.readState().tools,
        names: Object.keys(this.host.readState().tools),
      };
    const snapshotTools = snapshot.tools;
    const toolName =
      snapshotTools[input.toolName] || this.host.readState().tools[input.toolName]
        ? input.toolName
        : canonicalToolName(input.toolName);

    const executed = await executeAtomicToolCallResult({
      call: {
        toolCallId: input.toolCallId,
        toolName,
        input: input.input,
      },
      tools: snapshotTools,
      executionRejection: toolExecutionRejection({
        toolName,
        snapshotTools,
        currentTools: this.host.readState().tools,
        hasExclusiveTool:
          cohortNames?.some((name) =>
            this.exclusiveToolNames.has(
              snapshotTools[name] || this.host.readState().tools[name]
                ? name
                : canonicalToolName(name),
            ),
          ) ?? false,
        exclusiveToolNames: this.exclusiveToolNames,
      }),
      messages: this.host.readState().messages,
      context: this.host.readContext(),
      abortSignal,
      pendingToolCalls: this.host.readState().pendingToolCalls,
      inputValidation: { type: input.inputValidation ?? "validate" },
      normalizeToolResultOutput: this.normalizeToolResultOutput,
      bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(toolName),
      aggregateOutputBudgetExempt: this.aggregateOutputBudgetExemptTools.has(toolName),
      onEvent: (event) => this.host.emit(event),
    });
    const executedOutcome = resultOutcome(executed);
    if (!executedOutcome.ok) {
      if (abortSignal?.aborted) this.alreadyNormalizedExternalToolCallIds.clear();
      return signalExternalToolCallHost(executedOutcome.error);
    }
    const outcome = executedOutcome.value;

    this.markExternalToolCallNormalized(input.toolCallId);
    return outcome;
  }

  private async normalizeToolOutput(
    output: ToolResultOutput,
    context: Parameters<NormalizeToolResultOutputFn>[1],
  ): Promise<ToolResultOutput> {
    return normalizeToolResultOutput(output, context, this.normalizeToolResultOutput);
  }

  async normalizeNewToolMessage(message: ToolModelMessage): Promise<ToolModelMessage> {
    const content: ToolModelMessage["content"] = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      if (this.alreadyNormalizedExternalToolCallIds.delete(part.toolCallId)) {
        content.push(part);
        continue;
      }
      if (!this.normalizeToolResultOutput) {
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

  async normalizeNewAssistantMessage(
    message: AssistantModelMessage,
  ): Promise<AssistantModelMessage> {
    if (!Array.isArray(message.content)) return message;

    const content: AssistantContentParts = [];
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        content.push(part);
        continue;
      }
      if (this.alreadyNormalizedExternalToolCallIds.delete(part.toolCallId)) {
        content.push(part);
        continue;
      }
      if (!this.normalizeToolResultOutput) {
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

  async executeToolCalls(
    toolCalls: AgentToolCall[],
    snapshot: StepToolSnapshot<TOOLS>,
    projectResult?: ProjectSettledToolResult,
  ): Promise<ResultType<number, ToolBatchExecutionFailed>> {
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));

    const isAborted = (): boolean => this.host.readAbortSignal()?.aborted === true;
    const assertNotAborted = () => this.host.assertNotAborted();

    const executeOne = (call: AgentToolCall) =>
      executeAtomicToolCallResult({
        call,
        tools: snapshot.tools,
        messages: this.host.readState().messages,
        context: this.host.readContext(),
        abortSignal: this.host.readAbortSignal(),
        pendingToolCalls: this.host.readState().pendingToolCalls,
        inputValidation: call.invalid
          ? { type: "invalid", error: call.error }
          : { type: "prevalidated" },
        normalizeToolResultOutput: this.normalizeToolResultOutput,
        bypassGenericOutputNormalizer: this.genericOutputNormalizerBypassTools.has(call.toolName),
        aggregateOutputBudgetExempt: this.aggregateOutputBudgetExemptTools.has(call.toolName),
        executionRejection: toolExecutionRejection({
          toolName: call.toolName,
          snapshotTools: snapshot.tools,
          currentTools: this.host.readState().tools,
          hasExclusiveTool,
          exclusiveToolNames: this.exclusiveToolNames,
        }),
        assertNotAborted,
        onEvent: (event) => this.host.emit(event),
      });

    const settledParts: Array<ToolResultPart | undefined> = Array.from({
      length: toolCalls.length,
    });
    let nextAppendIndex = 0;

    const projectPart = (
      call: AgentToolCall,
      outcome: AtomicToolExecutionOutcome,
    ): ToolResultPart => {
      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: outcome.toolOutput,
      };
      return projectResult?.(part, outcome) ?? part;
    };

    const checkpointCompletedOutcomes = () => {
      const baseLength = this.host.readToolExchangeBaseLength();
      const assistant = this.host.readState().messages[baseLength];
      if (assistant?.role !== "assistant") return;
      const candidate = this.host
        .readState()
        .messages.slice(0, baseLength + 1)
        .map(cloneMessage);
      for (let index = 0; index < toolCalls.length; index += 1) {
        const part = settledParts[index];
        if (part === undefined) continue;
        candidate.push({
          role: "tool",
          content: [part],
        });
      }
      this.host.checkpointMessages(candidate);
    };

    const appendReadyOutcomes = () => {
      while (nextAppendIndex < toolCalls.length) {
        const part = settledParts[nextAppendIndex];
        if (!part) break;

        const toolMessage: ModelMessage = {
          role: "tool",
          content: [part],
        };

        this.host.readState().messages.push(toolMessage);
        this.host.emit({ type: "message_start", message: cloneMessage(toolMessage) });
        this.host.emit({ type: "message_end", message: cloneMessage(toolMessage) });
        this.host.checkpointMessages();

        nextAppendIndex += 1;
      }
    };

    let stoppedDueToAbort = false;
    let executionError: AtomicToolExecutionFailed | undefined;
    const indexed = toolCalls.map((call, index) => ({ call, index }));
    for (const group of groupToolCalls(indexed, ({ call }) => call.toolName)) {
      if (isAborted() || executionError) break;
      const completed = await Promise.all(
        group.map(({ call, index }) =>
          captureAgentPromise(async () => {
            if (isAborted()) return;
            const outcome = resultOutcome(await executeOne(call));
            if (!outcome.ok) {
              executionError ??= outcome.error;
              return;
            }
            settledParts[index] = projectPart(call, outcome.value);
            checkpointCompletedOutcomes();
            appendReadyOutcomes();
          }),
        ),
      );
      for (const captured of completed) {
        const outcome = resultOutcome(captured);
        if (outcome.ok) continue;
        rethrowAgentPanic(outcome.error);
        return Result.err(
          new ToolBatchExecutionFailed({ cause: outcome.error, message: "Tool execution failed" }),
        );
      }
    }
    if (isAborted()) stoppedDueToAbort = true;
    if (executionError) {
      return Result.err(
        new ToolBatchExecutionFailed({
          cause: executionError.cause,
          message: executionError.message,
        }),
      );
    }

    if (!stoppedDueToAbort && nextAppendIndex !== toolCalls.length) {
      const missing = toolCalls[nextAppendIndex]!;
      const message = `Missing tool execution outcome for toolCallId=${missing.toolCallId}`;
      return Result.err(new ToolBatchExecutionFailed({ cause: new Error(message), message }));
    }

    if (isAborted()) {
      const cause = this.host.makeAbortError();
      return Result.err(new ToolBatchExecutionFailed({ cause, message: cause.message }));
    }

    return Result.ok(toolCalls.length);
  }
}
