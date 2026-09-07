import type { LanguageModel, ToolSet, Experimental_DownloadFunction as DownloadFunction } from "ai";
import { Result } from "better-result";
import { AgentAdapterFailure, type AgentAdapter, type AgentExecution } from "../../agent-adapter";
import { createAgentEventChannel } from "../../agent-execution-events";
import type { AgentExecutionHost } from "../../agent-execution-host";
import { captureAgentPromise, rethrowAgentPanic } from "../../failure-adapters";
import {
  AgentExternalHostFailed,
  TurnAbortedError,
  resultOutcome,
  signalAgentStateHost,
  signalExternalToolCallHost,
  hasInlineToolResult,
  lengthRecoveryContinueMessage,
  type TurnErrorPhase,
} from "../../agent-runtime-support";
import { normalizeModelMessagesToolCallIds } from "../../tool-call-id-normalization";
import { executeAiSdkModelCall } from "./model-call";
import type { AiSdkPiAgentOptions, ModelCallRuntime, PrepareModelCall } from "./support";

export class AiSdkAgentAdapter<TOOLS extends ToolSet = ToolSet> implements AgentAdapter<
  AgentExecutionHost<TOOLS>
> {
  private model: LanguageModel;
  private modelSpecifier: string | undefined;
  private readonly prepareModelCall: PrepareModelCall | undefined;
  private download: DownloadFunction | undefined;
  private readonly sendTools: boolean;
  private readonly maxRetries: number | undefined;
  constructor(options: AiSdkPiAgentOptions<TOOLS>) {
    this.model = options.model;
    this.modelSpecifier = options.modelSpecifier;
    this.prepareModelCall = options.prepareModelCall;
    this.download = options.experimentalDownload;
    this.sendTools = options.sendToolsToModel !== false;
    this.maxRetries = options.streamTextMaxRetries;
  }
  getModel(): LanguageModel {
    return this.model;
  }
  setModel(model: LanguageModel, modelSpecifier?: string): void {
    this.model = model;
    this.modelSpecifier = modelSpecifier;
  }
  setExperimentalDownload(download: DownloadFunction | undefined): void {
    this.download = download;
  }
  createExecution(
    context: Parameters<AgentAdapter<AgentExecutionHost<TOOLS>>["createExecution"]>[0],
  ): AgentExecution {
    const channel = createAgentEventChannel();
    let sequence = 0;
    let started = false;
    let settled = false;
    let work: Promise<void> | undefined;
    const finish = async (): Promise<void> => {
      const outcome = resultOutcome(
        await captureAgentPromise(() =>
          this.run(context.host, context.attemptId, (responseId, usage) => {
            channel.push({
              attemptId: context.attemptId,
              sequence: sequence++,
              type: "usage",
              responseId,
              usage,
            });
          }),
        ),
      );
      context.host.observeExternalTools(undefined);
      const terminal = outcome.ok
        ? {
            status:
              context.host.abortReason() === "cancel"
                ? ("cancelled" as const)
                : ("completed" as const),
          }
        : {
            status: "failed" as const,
            error: new AgentAdapterFailure({
              reason: "unavailable",
              message:
                outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
              replaySafety: "reconcile",
              cause: outcome.error,
            }),
          };
      channel.push({
        attemptId: context.attemptId,
        sequence: sequence++,
        type: "terminal",
        outcome: terminal,
      });
      settled = true;
      channel.close();
    };
    return {
      attemptId: context.attemptId,
      retryOwner: "adapter",
      capabilities: { steering: "boundary", followUp: "boundary", interruption: "restart" },
      events: channel.events,
      start: () => {
        if (started)
          return Result.err(
            new AgentAdapterFailure({
              reason: "invalid-state",
              message: "Execution already started",
              replaySafety: "safe",
            }),
          );
        started = true;
        work = finish();
        return Result.ok(undefined);
      },
      submitInput: () =>
        Result.err(
          new AgentAdapterFailure({
            reason: "invalid-state",
            message: "This execution accepts input at host boundaries",
            replaySafety: "safe",
          }),
        ),
      interrupt: async () => Result.ok(undefined),
      cancel: async () => {
        if (work) await work;
        return Result.ok(undefined);
      },
      dispose: async () => {
        if (work && !settled) await work;
        channel.close();
        return Result.ok(undefined);
      },
    };
  }
  private async run(
    host: AgentExecutionHost<TOOLS>,
    attemptId: string,
    usage: (responseId: string, usage: import("ai").LanguageModelUsage) => void,
  ): Promise<void> {
    let lengthRecoveryAttempted = false;
    let providerExecutedTool = false;
    let activePersistentAttemptIdentity: string | undefined;
    host.observeExternalTools(() => {
      providerExecutedTool = true;
    });
    while (true) {
      const control = await host.controlBoundary();
      if (control === "stop") return;
      if (control === "again") continue;
      let modelTurnCompleted = false;
      let phase: TurnErrorPhase = "before-step";
      const localToolDraftIds = new Set<string>();
      const attempt = resultOutcome(
        await captureAgentPromise(async () => {
          if (activePersistentAttemptIdentity === undefined) providerExecutedTool = false;
          let runtime: ModelCallRuntime = {
            model: this.model,
            modelSpecifier: this.modelSpecifier,
            executionMode: this.sendTools ? "local-tools" : "provider-tools",
            streamTextMaxRetries: this.maxRetries,
          };
          const prepared = await host.prepareRequest({
            executionMode: runtime.executionMode,
            onErrorPhase: (value) => {
              phase = value;
            },
            selectRequest: async (preparation) => {
              const result = this.prepareModelCall
                ? await this.prepareModelCall({
                    ...preparation,
                    runtime,
                    payload: { mode: "full" },
                  })
                : { runtime, payload: { mode: "full" as const } };
              runtime = result.runtime;
              if (
                runtime.persistentAttemptIdentity === undefined ||
                runtime.persistentAttemptIdentity !== activePersistentAttemptIdentity
              ) {
                providerExecutedTool = false;
              }
              activePersistentAttemptIdentity = runtime.persistentAttemptIdentity;
              return { executionMode: runtime.executionMode, payload: result.payload };
            },
          });
          const messages = normalizeModelMessagesToolCallIds({
            messages: prepared.messages,
            modelSpecifier: runtime.modelSpecifier,
          });
          const state = host.readState();
          host.recordModelView(messages, prepared.step);
          phase = "model-call";
          const turn = await executeAiSdkModelCall({
            model: runtime.model,
            system: prepared.system,
            messages,
            ...(runtime.executionMode === "local-tools" ? { tools: prepared.tools } : {}),
            reasoning: state.reasoning,
            providerOptions: state.providerOptions,
            download: this.download,
            maxRetries: runtime.streamTextMaxRetries ?? this.maxRetries,
            abortSignal: host.signal(),
            host: {
              emit: (event) => host.publish(event),
              checkpointDraft: (message) => host.checkpointDraft(message),
              setStreamMessage: (message) => host.setStreamMessage(message),
              normalizeNewToolMessage: (message) => host.normalizeToolMessage(message),
              normalizeNewAssistantMessage: (message) => host.normalizeAssistantMessage(message),
              clearNormalizedToolCallIds: () => host.clearNormalizedCalls(),
              markProviderTool: () => {
                providerExecutedTool = true;
              },
              markLocalToolDraft: (id) => {
                localToolDraftIds.add(id);
              },
              onErrorPhase: (value) => {
                phase = value;
                if (value === "post-model") modelTurnCompleted = true;
              },
              getAbortReason: () => host.abortReason(),
              abortModel: (reason) =>
                signalAgentStateHost(new TurnAbortedError({ reason, phase: "model" })),
              failModel: (cause, message) =>
                signalExternalToolCallHost(new AgentExternalHostFailed({ cause, message })),
            },
          });
          modelTurnCompleted = true;
          phase = "post-model";
          await host.commitTurn(turn);
          usage(`${attemptId}:${prepared.step}`, turn.totalUsage);
          const hasLocalTools = turn.finishReason === "tool-calls" && turn.toolCalls.length > 0;
          const hasCompletedToolExchange =
            turn.finishReason === "tool-calls" &&
            turn.newMessages.some(
              (message) => message.role === "tool" || hasInlineToolResult(message),
            );
          const execution = hasLocalTools
            ? await host.executeToolBatch(turn.toolCalls, prepared.scopeId)
            : Result.ok(0);
          const executionOutcome = resultOutcome(execution);
          if (!executionOutcome.ok) return signalExternalToolCallHost(executionOutcome.error);
          const recoverFromLength = turn.finishReason === "length" && !lengthRecoveryAttempted;
          if (recoverFromLength) lengthRecoveryAttempted = true;
          return await host.finishBoundary({
            finishReason: turn.finishReason,
            modelInputMessages: turn.modelInputMessages,
            executedToolCallCount: executionOutcome.value,
            naturallyRequiresContinuation: hasLocalTools || hasCompletedToolExchange,
            ...(recoverFromLength ? { continuationMessage: lengthRecoveryContinueMessage() } : {}),
          });
        }),
      );
      if (attempt.ok) {
        if (attempt.value === "break") return;
        continue;
      }
      rethrowAgentPanic(attempt.error);
      const decision = await host.settleFailure(attempt.error, {
        modelTurnCompleted,
        providerExecutedTool,
        phase,
        localToolDraftIds,
      });
      if (decision === "break") return;
    }
  }
}
