import type {
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  ToolSet,
} from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { createLogger } from "@stanley2058/lilac-utils/logging";
import { normalizeToolCallInputValue } from "@stanley2058/lilac-utils/tool-call-input-normalization";
import {
  executeAtomicToolCallResult,
  finalizeSettledAtomicToolCall,
  normalizeToolResultOutput,
  settleAtomicToolCallResult,
  type AtomicToolExecutionOutcome,
  type AtomicToolExecutionFailed,
  type AtomicToolExecutionOutcomeKind,
  type AtomicToolExecutionEvent,
  type ExecuteAtomicToolCallOptions,
  type NormalizeSettledToolResultOutputsFn,
  type NormalizeToolResultOutputFn,
  type SettledToolResultOutputEntry,
  type ToolResultOutput,
} from "./atomic-tool-execution";
import { captureAgentPromise, rethrowAgentPanic, type OpaqueAgentValue } from "./failure-adapters";
import type { ExpandedToolCall } from "./tool-call-expansion";
import { cloneMessage, canonicalToolName } from "./agent-runtime-support";

const logger = createLogger({ module: "agent-tool-host" });
const SETTLED_NORMALIZATION_FAILED = "[settled tool results could not be normalized]";
type AssistantContentParts = Extract<AssistantContent, unknown[]>;
export type StepToolSnapshot<TOOLS extends ToolSet = ToolSet> = {
  /** Monotonic model-step number, 1-based. */
  readonly step: number;
  /** Exact tool implementations authorized for calls produced by this step. */
  readonly tools: TOOLS;
  /** Authorized names in toolset order. */
  readonly names: readonly string[];
};

export type ExecutedExpansionChild = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  outcome: AtomicToolExecutionOutcomeKind;
  toolOutput: ToolResultOutput;
};

export type ExternalToolExecutionOutcome = AtomicToolExecutionOutcome & {
  executedExpansion?: {
    children: ExecutedExpansionChild[];
  };
};

export function projectExternalToolOutcome(outcome: ExternalToolExecutionOutcome): {
  expansionMessages?: readonly ModelMessage[];
  executedCallCount: number;
} {
  const children = outcome.expansion?.children;
  const executedChildren = outcome.executedExpansion?.children ?? [];
  const executedCallCount = 1 + executedChildren.length;
  if (!children?.length) return { executedCallCount };
  const assistant: AssistantModelMessage = {
    role: "assistant",
    content: children.map((child) => ({
      type: "tool-call",
      toolCallId: child.toolCallId,
      toolName: child.toolName,
      input: normalizeToolCallInputValue(child.input),
    })),
  };
  const toolMessages = executedChildren.map(
    (child): ToolModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: child.toolCallId,
          toolName: child.toolName,
          output: child.toolOutput,
        },
      ],
    }),
  );
  return { expansionMessages: [assistant, ...toolMessages], executedCallCount };
}

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
  normalizeSettledToolResultOutputs?: NormalizeSettledToolResultOutputsFn;
  genericOutputNormalizerBypassTools?: ReadonlySet<string>;
  aggregateOutputBudgetExemptTools?: ReadonlySet<string>;
  exclusiveToolNames?: ReadonlySet<string>;
}

export class AgentToolHost<TOOLS extends ToolSet> {
  private normalizeToolResultOutput: NormalizeToolResultOutputFn | undefined;
  private normalizeSettledToolResultOutputs: NormalizeSettledToolResultOutputsFn | undefined;
  private genericOutputNormalizerBypassTools: ReadonlySet<string>;
  private aggregateOutputBudgetExemptTools: ReadonlySet<string>;
  private exclusiveToolNames: ReadonlySet<string>;
  private alreadyNormalizedExternalToolCallIds = new Set<string>();
  constructor(private readonly host: AgentToolHostOptions<TOOLS>) {
    this.normalizeToolResultOutput = host.normalizeToolResultOutput;
    this.normalizeSettledToolResultOutputs = host.normalizeSettledToolResultOutputs;
    this.genericOutputNormalizerBypassTools = new Set(host.genericOutputNormalizerBypassTools);
    this.aggregateOutputBudgetExemptTools = new Set(host.aggregateOutputBudgetExemptTools);
    this.exclusiveToolNames = new Set(host.exclusiveToolNames);
  }
  setNormalizeToolResultOutput(value: NormalizeToolResultOutputFn | undefined) {
    this.normalizeToolResultOutput = value;
  }
  setNormalizeSettledToolResultOutputs(value: NormalizeSettledToolResultOutputsFn | undefined) {
    this.normalizeSettledToolResultOutputs = value;
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
  ): Promise<ExternalToolExecutionOutcome> {
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
      expansionHandling: { type: "capture" },
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

    let executedExpansion: ExternalToolExecutionOutcome["executedExpansion"];
    if (outcome.expansion) {
      const childResult =
        outcome.expansion.children.length === 0
          ? Result.ok<AtomicToolExecutionOutcome[], ToolBatchExecutionFailed>([])
          : await this.executeExpansionChildren([...outcome.expansion.children], snapshot, {
              abortSignal,
              appendToTranscript: false,
            });
      const childResultOutcome = resultOutcome(childResult);
      if (!childResultOutcome.ok) {
        if (abortSignal?.aborted) this.alreadyNormalizedExternalToolCallIds.clear();
        return signalExternalToolCallHost(childResultOutcome.error);
      }
      const childOutcomes = childResultOutcome.value;
      executedExpansion = {
        children: outcome.expansion.children.map((child, index) => {
          const childOutcome = childOutcomes[index];
          if (!childOutcome) {
            throw new Error(`Missing tool execution outcome for toolCallId=${child.toolCallId}`);
          }
          return {
            toolCallId: child.toolCallId,
            toolName: child.toolName,
            isError: childOutcome.isError,
            outcome: childOutcome.outcome,
            toolOutput: childOutcome.toolOutput,
          };
        }),
      };
    }

    this.markExternalToolCallNormalized(input.toolCallId);
    return { ...outcome, ...(executedExpansion ? { executedExpansion } : {}) };
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

  private async executeExpansionChildren(
    toolCalls: ExpandedToolCall[],
    snapshot: StepToolSnapshot<TOOLS>,
    options: { abortSignal?: AbortSignal; appendToTranscript: boolean },
  ): Promise<ResultType<AtomicToolExecutionOutcome[], ToolBatchExecutionFailed>> {
    const MAX_PARALLEL_TOOLS = 8;
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));
    const isAborted = (): boolean => options.abortSignal?.aborted === true;
    const assertNotAborted = () => this.host.assertNotAborted(options.abortSignal);

    const atomicOptions = toolCalls.map(
      (call): ExecuteAtomicToolCallOptions => ({
        call,
        tools: snapshot.tools,
        messages: this.host.readState().messages,
        context: this.host.readContext(),
        abortSignal: options.abortSignal,
        pendingToolCalls: this.host.readState().pendingToolCalls,
        inputValidation: call.invalid
          ? { type: "invalid", error: call.error }
          : { type: "prevalidated" },
        expansionHandling: {
          type: "reject",
          message: "Nested tool-call expansions are not supported.",
        },
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
      }),
    );

    const settled: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
      length: toolCalls.length,
    });
    let executionError: AtomicToolExecutionFailed | undefined;
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, toolCalls.length) }, () =>
      (async () => {
        while (true) {
          if (isAborted()) return;
          const index = next;
          if (index >= toolCalls.length) return;
          next += 1;
          const result = await settleAtomicToolCallResult(atomicOptions[index]!);
          result.match({
            ok: (value) => {
              settled[index] = value;
            },
            err: (error) => {
              executionError ??= error;
            },
          });
          if (isAborted()) return;
        }
      })(),
    );
    await Promise.all(workers);

    const entryFor = (index: number): SettledToolResultOutputEntry | undefined => {
      const child = settled[index];
      if (!child) return undefined;
      const callOptions = atomicOptions[index]!;
      return {
        output: child.toolOutput,
        context: {
          toolCallId: callOptions.call.toolCallId,
          toolName: callOptions.call.toolName,
          ...(callOptions.bypassGenericOutputNormalizer === undefined
            ? {}
            : {
                bypassGenericOutputNormalizer: callOptions.bypassGenericOutputNormalizer,
              }),
          ...(callOptions.aggregateOutputBudgetExempt === undefined
            ? {}
            : {
                aggregateOutputBudgetExempt: callOptions.aggregateOutputBudgetExempt,
              }),
        },
      };
    };

    const normalizeEntries = async (
      entries: readonly SettledToolResultOutputEntry[],
    ): Promise<ToolResultOutput[]> => {
      if (!this.normalizeSettledToolResultOutputs) {
        return await Promise.all(
          entries.map((entry) => this.normalizeToolOutput(entry.output, entry.context)),
        );
      }
      const normalized = resultOutcome(
        await captureAgentPromise(() =>
          this.normalizeSettledToolResultOutputs!(entries, (output, context) =>
            this.normalizeToolOutput(output, context),
          ),
        ),
      );
      if (normalized.ok) {
        const outputs = normalized.value;
        if (outputs.length !== entries.length) {
          logger.warn("settled expansion output normalization returned wrong output count", {
            expected: entries.length,
            actual: outputs.length,
          });
          return entries.map(() => ({
            type: "error-text" as const,
            value: SETTLED_NORMALIZATION_FAILED,
          }));
        }
        return outputs;
      }
      rethrowAgentPanic(normalized.error);
      logger.warn("settled expansion output normalization failed", {
        error:
          normalized.error instanceof Error ? normalized.error.message : String(normalized.error),
      });
      return entries.map(() => ({
        type: "error-text" as const,
        value: SETTLED_NORMALIZATION_FAILED,
      }));
    };

    const checkpointCompleted = (
      completed: readonly (AtomicToolExecutionOutcome | undefined)[],
    ): void => {
      if (!options.appendToTranscript) return;
      const baseLength = this.host.readToolExchangeBaseLength();
      const assistant = this.host.readState().messages[baseLength];
      if (assistant?.role !== "assistant") return;
      const candidate = this.host
        .readState()
        .messages.slice(0, baseLength + 1)
        .map(cloneMessage);
      for (let index = 0; index < completed.length; index += 1) {
        const outcome = completed[index];
        if (!outcome) continue;
        const call = toolCalls[index]!;
        candidate.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        });
      }
      this.host.checkpointMessages(candidate);
    };

    const finalizeCompleted = async (): Promise<void> => {
      const completed: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
        length: settled.length,
      });
      const completedIndexes = settled.flatMap((child, index) => (child ? [index] : []));
      const entries = completedIndexes.flatMap((index) => {
        const entry = entryFor(index);
        return entry ? [entry] : [];
      });
      const outputs = await normalizeEntries(entries);
      for (let offset = 0; offset < completedIndexes.length; offset += 1) {
        const index = completedIndexes[offset]!;
        completed[index] = finalizeSettledAtomicToolCall(
          atomicOptions[index]!,
          settled[index]!,
          outputs[offset]!,
        );
      }
      checkpointCompleted(completed);
    };

    if (isAborted() || executionError) {
      await finalizeCompleted();
      if (executionError) {
        return Result.err(
          new ToolBatchExecutionFailed({
            cause: executionError.cause,
            message: executionError.message,
          }),
        );
      }
      assertNotAborted();
    }

    if (settled.some((outcome) => outcome === undefined)) {
      await finalizeCompleted();
      const missingIndex = settled.findIndex((outcome) => outcome === undefined);
      return Result.err(
        new ToolBatchExecutionFailed({
          cause: new Error(
            `Missing tool execution outcome for toolCallId=${toolCalls[missingIndex]!.toolCallId}`,
          ),
          message: `Missing tool execution outcome for toolCallId=${toolCalls[missingIndex]!.toolCallId}`,
        }),
      );
    }

    const entries = settled.flatMap((_child, index) => {
      const entry = entryFor(index);
      return entry ? [entry] : [];
    });
    const normalizedOutputs = await normalizeEntries(entries);

    const outcomes: AtomicToolExecutionOutcome[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      outcomes.push(
        finalizeSettledAtomicToolCall(
          atomicOptions[index]!,
          settled[index]!,
          normalizedOutputs[index]!,
        ),
      );
    }

    checkpointCompleted(outcomes);
    if (isAborted()) assertNotAborted();

    if (options.appendToTranscript) {
      for (let index = 0; index < outcomes.length; index += 1) {
        const call = toolCalls[index]!;
        const toolMessage: ModelMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcomes[index]!.toolOutput,
            },
          ],
        };
        this.host.appendMessage(toolMessage);
        this.host.checkpointMessages();
      }
    }

    return Result.ok(outcomes);
  }

  async executeToolCalls(
    toolCalls: ExpandedToolCall[],
    snapshot: StepToolSnapshot<TOOLS>,
  ): Promise<ResultType<number, ToolBatchExecutionFailed>> {
    const MAX_PARALLEL_TOOLS = 8;
    const hasExclusiveTool = toolCalls.some((call) => this.exclusiveToolNames.has(call.toolName));

    const isAborted = (): boolean => this.host.readAbortSignal()?.aborted === true;
    const assertNotAborted = () => this.host.assertNotAborted();

    const executeOne = (call: ExpandedToolCall) =>
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
        expansionHandling: { type: "capture" },
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

    const outcomes: Array<AtomicToolExecutionOutcome | undefined> = Array.from({
      length: toolCalls.length,
    });
    let nextAppendIndex = 0;

    const checkpointCompletedOutcomes = () => {
      const baseLength = this.host.readToolExchangeBaseLength();
      const assistant = this.host.readState().messages[baseLength];
      if (assistant?.role !== "assistant") return;
      const candidate = this.host
        .readState()
        .messages.slice(0, baseLength + 1)
        .map(cloneMessage);
      for (let index = 0; index < toolCalls.length; index += 1) {
        const outcome = outcomes[index];
        if (outcome === undefined) continue;
        const call = toolCalls[index]!;
        candidate.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: outcome.toolOutput,
            },
          ],
        });
      }
      this.host.checkpointMessages(candidate);
    };

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

        this.host.readState().messages.push(toolMessage);
        this.host.emit({ type: "message_start", message: cloneMessage(toolMessage) });
        this.host.emit({ type: "message_end", message: cloneMessage(toolMessage) });
        this.host.checkpointMessages();

        nextAppendIndex += 1;
      }
    };

    let stoppedDueToAbort = false;
    let executionError: AtomicToolExecutionFailed | undefined;
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_TOOLS, toolCalls.length) }, () =>
      (async () => {
        while (true) {
          if (isAborted()) return;
          const index = next;
          if (index >= toolCalls.length) return;
          next += 1;

          const result = await executeOne(toolCalls[index]!);
          const outcome = resultOutcome(result);
          if (!outcome.ok) {
            executionError ??= outcome.error;
            return;
          }
          outcomes[index] = outcome.value;
          checkpointCompletedOutcomes();
          appendReadyOutcomes();
        }
      })(),
    );
    await Promise.all(workers);
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
      this.host.appendMessage(syntheticAssistant);
      const childOutcomes = await this.executeExpansionChildren([...expansion.children], snapshot, {
        abortSignal: this.host.readAbortSignal(),
        appendToTranscript: true,
      });
      const childOutcome = resultOutcome(childOutcomes);
      if (!childOutcome.ok) return Result.err(childOutcome.error);
      executed += childOutcome.value.length;
    }

    return Result.ok(executed);
  }
}
