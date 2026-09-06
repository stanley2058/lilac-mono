import type {
  AssistantModelMessage,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  SystemModelMessage,
  ToolSet,
} from "ai";
import type { Result as ResultType } from "better-result";
import type { AgentHostServices } from "./agent-adapter";
import type {
  AgentState,
  AgentEvent,
  SystemPrompt,
  TransformMessagesContext,
  TurnAbortReason,
  TurnErrorPhase,
} from "./agent-runtime-support";
import type { AgentToolHost, ToolBatchExecutionFailed } from "./agent-tool-host";
import type { ExpandedToolCall } from "./tool-call-expansion";
import type { OpaqueAgentValue } from "./failure-adapters";

export type ExecutionRequestSelection = {
  executionMode: "local-tools" | "provider-tools";
  payload: { readonly mode: "full" } | { readonly mode: "suffix"; readonly startIndex: number };
};
export type PreparedExecutionRequest = {
  scopeId: string;
  step: number;
  system: SystemPrompt;
  messages: ModelMessage[];
  canonicalMessages: ModelMessage[];
  tools: ToolSet;
  selection: ExecutionRequestSelection;
};
export type ExecutionTurn = {
  finishReason: FinishReason;
  newMessages: ModelMessage[];
  toolCalls: ExpandedToolCall[];
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  modelInputMessages: ModelMessage[];
};
export type ExecutionBoundaryInput = {
  finishReason: FinishReason;
  modelInputMessages: readonly ModelMessage[];
  executedToolCallCount: number;
  naturallyRequiresContinuation: boolean;
  continuationMessage?: ModelMessage;
  signal?: AbortSignal;
};
export type ExecutionFailureContext = {
  modelTurnCompleted: boolean;
  providerExecutedTool: boolean;
  phase: TurnErrorPhase;
  localToolDraftIds: ReadonlySet<string>;
};
export type AgentExecutionState<TOOLS extends ToolSet = ToolSet> = Omit<
  Readonly<AgentState<TOOLS>>,
  "tools" | "messages" | "system" | "pendingToolCalls" | "debug"
> & {
  readonly messages: readonly ModelMessage[];
  readonly system: string | SystemModelMessage | readonly SystemModelMessage[];
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly debug?: Readonly<NonNullable<AgentState<TOOLS>["debug"]>>;
};
export interface AgentExecutionHost<TOOLS extends ToolSet = ToolSet> extends AgentHostServices {
  controlBoundary(): Promise<"stop" | "again" | "ready">;
  prepareRequest(request: {
    executionMode: "local-tools" | "provider-tools";
    signal?: AbortSignal;
    onErrorPhase(phase: TurnErrorPhase): void;
    selectRequest(context: {
      canonicalMessages: readonly ModelMessage[];
      fullBudgetView: readonly ModelMessage[];
      transformContext: TransformMessagesContext;
    }): Promise<ExecutionRequestSelection>;
  }): Promise<PreparedExecutionRequest>;
  commitTurn(turn: ExecutionTurn): Promise<void>;
  finishBoundary(input: ExecutionBoundaryInput): Promise<"continue" | "break">;
  settleFailure(
    error: OpaqueAgentValue,
    context: ExecutionFailureContext,
  ): Promise<"continue" | "break">;
  executeToolBatch(
    calls: ExpandedToolCall[],
    scopeId: string,
  ): Promise<ResultType<number, ToolBatchExecutionFailed>>;
  readState(): AgentExecutionState<TOOLS>;
  recordModelView(messages: readonly ModelMessage[], step: number): void;
  signal(): AbortSignal | undefined;
  abortReason(): TurnAbortReason;
  publish(event: AgentEvent<ToolSet>): void;
  checkpointDraft(message: AssistantModelMessage): void;
  setStreamMessage(message: AssistantModelMessage | null): void;
  normalizeToolMessage: AgentToolHost<TOOLS>["normalizeNewToolMessage"];
  normalizeAssistantMessage: AgentToolHost<TOOLS>["normalizeNewAssistantMessage"];
  clearNormalizedCalls(): void;
  observeExternalTools(handler: (() => void) | undefined): void;
}
