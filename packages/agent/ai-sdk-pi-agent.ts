import type { LanguageModel, ToolSet, Experimental_DownloadFunction as DownloadFunction } from "ai";
import type { ModelReasoningEffort } from "@stanley2058/lilac-utils/core-config/types";
import { AgentExecutor } from "./agent-executor";
import { AiSdkAgentAdapter } from "./adapters/ai-sdk/adapter";
import type {
  AiSdkPiAgentOptions,
  AiSdkPiAgentState,
  PrepareModelCall,
} from "./adapters/ai-sdk/support";
import type { JSONObject } from "./agent-runtime-support";
export * from "./agent-runtime-support";
export * from "./adapters/ai-sdk/support";
export type {
  ExternalToolExecutionOutcome,
  ExecutedExpansionChild,
  StepToolSnapshot,
} from "./agent-tool-host";
export type {
  NormalizeSettledToolResultOutputsFn,
  NormalizeToolResultOutputFn,
  SettledToolResultOutputEntry,
  ToolResultOutput,
} from "./atomic-tool-execution";

export class AiSdkPiAgent<TOOLS extends ToolSet = ToolSet> {
  private readonly executor: AgentExecutor<TOOLS>;
  private model: LanguageModel;
  private prepareModelCall: PrepareModelCall | undefined;
  private download: DownloadFunction | undefined;
  readonly state: AiSdkPiAgentState<TOOLS>;
  constructor(options: AiSdkPiAgentOptions<TOOLS>) {
    const { adapterFactory = (settings) => new AiSdkAgentAdapter(settings), ...initialOptions } =
      options;
    this.model = options.model;
    this.prepareModelCall = options.prepareModelCall;
    this.download = options.experimentalDownload;
    this.executor = new AgentExecutor({
      ...options,
      adapter: {
        createExecution: (context) =>
          adapterFactory({
            ...initialOptions,
            model: this.model,
            modelSpecifier: this.state.modelSpecifier,
            system: this.state.system,
            tools: this.state.tools,
            messages: this.state.messages,
            providerOptions: this.state.providerOptions,
            reasoning: this.state.reasoning,
            prepareModelCall: this.prepareModelCall,
            experimentalDownload: this.download,
          }).createExecution(context),
      },
    });
    this.state = Object.defineProperty(
      Object.assign(this.executor.state, { model: options.model }),
      "model",
      {
        enumerable: true,
        get: () => this.model,
        set: (model: LanguageModel) => {
          this.model = model;
          this.executor.requestAdapterRebind();
        },
      },
    );
  }
  setModel(
    model: LanguageModel,
    providerOptions?: { [x: string]: JSONObject },
    modelSpecifier?: string,
    reasoning?: ModelReasoningEffort,
  ): void {
    this.model = model;
    this.executor.requestAdapterRebind();
    this.state.modelSpecifier = modelSpecifier;
    this.state.providerOptions = providerOptions;
    this.state.reasoning = reasoning;
  }
  setPrepareModelCall(handler: PrepareModelCall | undefined): void {
    this.prepareModelCall = handler;
    this.executor.requestAdapterRebind();
  }
  setExperimentalDownload(download: DownloadFunction | undefined): void {
    this.download = download;
    this.executor.requestAdapterRebind();
  }
  subscribe(
    ...args: Parameters<AgentExecutor<TOOLS>["subscribe"]>
  ): ReturnType<AgentExecutor<TOOLS>["subscribe"]> {
    return this.executor.subscribe(...args);
  }
  setSystem(
    ...args: Parameters<AgentExecutor<TOOLS>["setSystem"]>
  ): ReturnType<AgentExecutor<TOOLS>["setSystem"]> {
    return this.executor.setSystem(...args);
  }
  setTools(
    ...args: Parameters<AgentExecutor<TOOLS>["setTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["setTools"]> {
    return this.executor.setTools(...args);
  }
  setActiveTools(
    ...args: Parameters<AgentExecutor<TOOLS>["setActiveTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["setActiveTools"]> {
    return this.executor.setActiveTools(...args);
  }
  clearActiveTools(
    ...args: Parameters<AgentExecutor<TOOLS>["clearActiveTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["clearActiveTools"]> {
    return this.executor.clearActiveTools(...args);
  }
  activateTools(
    ...args: Parameters<AgentExecutor<TOOLS>["activateTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["activateTools"]> {
    return this.executor.activateTools(...args);
  }
  getActiveToolNames(
    ...args: Parameters<AgentExecutor<TOOLS>["getActiveToolNames"]>
  ): ReturnType<AgentExecutor<TOOLS>["getActiveToolNames"]> {
    return this.executor.getActiveToolNames(...args);
  }
  getLastStepToolSnapshot(
    ...args: Parameters<AgentExecutor<TOOLS>["getLastStepToolSnapshot"]>
  ): ReturnType<AgentExecutor<TOOLS>["getLastStepToolSnapshot"]> {
    return this.executor.getLastStepToolSnapshot(...args);
  }
  setContext(
    ...args: Parameters<AgentExecutor<TOOLS>["setContext"]>
  ): ReturnType<AgentExecutor<TOOLS>["setContext"]> {
    return this.executor.setContext(...args);
  }
  getRecoverableMessages(
    ...args: Parameters<AgentExecutor<TOOLS>["getRecoverableMessages"]>
  ): ReturnType<AgentExecutor<TOOLS>["getRecoverableMessages"]> {
    return this.executor.getRecoverableMessages(...args);
  }
  executeExternalToolCall(
    ...args: Parameters<AgentExecutor<TOOLS>["executeExternalToolCall"]>
  ): ReturnType<AgentExecutor<TOOLS>["executeExternalToolCall"]> {
    return this.executor.executeExternalToolCall(...args);
  }
  setPrepareFullModelView(
    ...args: Parameters<AgentExecutor<TOOLS>["setPrepareFullModelView"]>
  ): ReturnType<AgentExecutor<TOOLS>["setPrepareFullModelView"]> {
    return this.executor.setPrepareFullModelView(...args);
  }
  setPrepareFullBudgetView(
    ...args: Parameters<AgentExecutor<TOOLS>["setPrepareFullBudgetView"]>
  ): ReturnType<AgentExecutor<TOOLS>["setPrepareFullBudgetView"]> {
    return this.executor.setPrepareFullBudgetView(...args);
  }
  setCanonicalModelCallPreflight(
    ...args: Parameters<AgentExecutor<TOOLS>["setCanonicalModelCallPreflight"]>
  ): ReturnType<AgentExecutor<TOOLS>["setCanonicalModelCallPreflight"]> {
    return this.executor.setCanonicalModelCallPreflight(...args);
  }
  setBuildEphemeralOverlay(
    ...args: Parameters<AgentExecutor<TOOLS>["setBuildEphemeralOverlay"]>
  ): ReturnType<AgentExecutor<TOOLS>["setBuildEphemeralOverlay"]> {
    return this.executor.setBuildEphemeralOverlay(...args);
  }
  setDecorateRequestPayload(
    ...args: Parameters<AgentExecutor<TOOLS>["setDecorateRequestPayload"]>
  ): ReturnType<AgentExecutor<TOOLS>["setDecorateRequestPayload"]> {
    return this.executor.setDecorateRequestPayload(...args);
  }
  appendDecorateRequestPayload(
    ...args: Parameters<AgentExecutor<TOOLS>["appendDecorateRequestPayload"]>
  ): ReturnType<AgentExecutor<TOOLS>["appendDecorateRequestPayload"]> {
    return this.executor.appendDecorateRequestPayload(...args);
  }
  setTurnErrorHandler(
    ...args: Parameters<AgentExecutor<TOOLS>["setTurnErrorHandler"]>
  ): ReturnType<AgentExecutor<TOOLS>["setTurnErrorHandler"]> {
    return this.executor.setTurnErrorHandler(...args);
  }
  setGenericOutputNormalizerBypassTools(
    ...args: Parameters<AgentExecutor<TOOLS>["setGenericOutputNormalizerBypassTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["setGenericOutputNormalizerBypassTools"]> {
    return this.executor.setGenericOutputNormalizerBypassTools(...args);
  }
  setAggregateOutputBudgetExemptTools(
    ...args: Parameters<AgentExecutor<TOOLS>["setAggregateOutputBudgetExemptTools"]>
  ): ReturnType<AgentExecutor<TOOLS>["setAggregateOutputBudgetExemptTools"]> {
    return this.executor.setAggregateOutputBudgetExemptTools(...args);
  }
  setTurnBoundaryHandler(
    ...args: Parameters<AgentExecutor<TOOLS>["setTurnBoundaryHandler"]>
  ): ReturnType<AgentExecutor<TOOLS>["setTurnBoundaryHandler"]> {
    return this.executor.setTurnBoundaryHandler(...args);
  }
  setBeforeSteeringDeliveryHandler(
    ...args: Parameters<AgentExecutor<TOOLS>["setBeforeSteeringDeliveryHandler"]>
  ): ReturnType<AgentExecutor<TOOLS>["setBeforeSteeringDeliveryHandler"]> {
    return this.executor.setBeforeSteeringDeliveryHandler(...args);
  }
  setBeforeStep(
    ...args: Parameters<AgentExecutor<TOOLS>["setBeforeStep"]>
  ): ReturnType<AgentExecutor<TOOLS>["setBeforeStep"]> {
    return this.executor.setBeforeStep(...args);
  }
  replaceMessages(
    ...args: Parameters<AgentExecutor<TOOLS>["replaceMessages"]>
  ): ReturnType<AgentExecutor<TOOLS>["replaceMessages"]> {
    return this.executor.replaceMessages(...args);
  }
  appendMessages(
    ...args: Parameters<AgentExecutor<TOOLS>["appendMessages"]>
  ): ReturnType<AgentExecutor<TOOLS>["appendMessages"]> {
    return this.executor.appendMessages(...args);
  }
  clearMessages(
    ...args: Parameters<AgentExecutor<TOOLS>["clearMessages"]>
  ): ReturnType<AgentExecutor<TOOLS>["clearMessages"]> {
    return this.executor.clearMessages(...args);
  }
  setSteeringMode(
    ...args: Parameters<AgentExecutor<TOOLS>["setSteeringMode"]>
  ): ReturnType<AgentExecutor<TOOLS>["setSteeringMode"]> {
    return this.executor.setSteeringMode(...args);
  }
  setFollowUpMode(
    ...args: Parameters<AgentExecutor<TOOLS>["setFollowUpMode"]>
  ): ReturnType<AgentExecutor<TOOLS>["setFollowUpMode"]> {
    return this.executor.setFollowUpMode(...args);
  }
  steer(
    ...args: Parameters<AgentExecutor<TOOLS>["steer"]>
  ): ReturnType<AgentExecutor<TOOLS>["steer"]> {
    return this.executor.steer(...args);
  }
  getQueuedSteeringIds(
    ...args: Parameters<AgentExecutor<TOOLS>["getQueuedSteeringIds"]>
  ): ReturnType<AgentExecutor<TOOLS>["getQueuedSteeringIds"]> {
    return this.executor.getQueuedSteeringIds(...args);
  }
  acknowledgeSteeringDeliveryResult(
    ...args: Parameters<AgentExecutor<TOOLS>["acknowledgeSteeringDeliveryResult"]>
  ): ReturnType<AgentExecutor<TOOLS>["acknowledgeSteeringDeliveryResult"]> {
    return this.executor.acknowledgeSteeringDeliveryResult(...args);
  }
  acknowledgeSteeringDelivery(
    ...args: Parameters<AgentExecutor<TOOLS>["acknowledgeSteeringDelivery"]>
  ): ReturnType<AgentExecutor<TOOLS>["acknowledgeSteeringDelivery"]> {
    return this.executor.acknowledgeSteeringDelivery(...args);
  }
  followUp(
    ...args: Parameters<AgentExecutor<TOOLS>["followUp"]>
  ): ReturnType<AgentExecutor<TOOLS>["followUp"]> {
    return this.executor.followUp(...args);
  }
  interruptQueuedSteering(
    ...args: Parameters<AgentExecutor<TOOLS>["interruptQueuedSteering"]>
  ): ReturnType<AgentExecutor<TOOLS>["interruptQueuedSteering"]> {
    return this.executor.interruptQueuedSteering(...args);
  }
  interruptQueuedSteeringAsync(
    ...args: Parameters<AgentExecutor<TOOLS>["interruptQueuedSteeringAsync"]>
  ): ReturnType<AgentExecutor<TOOLS>["interruptQueuedSteeringAsync"]> {
    return this.executor.interruptQueuedSteeringAsync(...args);
  }
  abort(
    ...args: Parameters<AgentExecutor<TOOLS>["abort"]>
  ): ReturnType<AgentExecutor<TOOLS>["abort"]> {
    return this.executor.abort(...args);
  }
  cancel(
    ...args: Parameters<AgentExecutor<TOOLS>["cancel"]>
  ): ReturnType<AgentExecutor<TOOLS>["cancel"]> {
    return this.executor.cancel(...args);
  }
  interruptResult(
    ...args: Parameters<AgentExecutor<TOOLS>["interruptResult"]>
  ): ReturnType<AgentExecutor<TOOLS>["interruptResult"]> {
    return this.executor.interruptResult(...args);
  }
  interrupt(
    ...args: Parameters<AgentExecutor<TOOLS>["interrupt"]>
  ): ReturnType<AgentExecutor<TOOLS>["interrupt"]> {
    return this.executor.interrupt(...args);
  }
  requestIdleRecovery(
    ...args: Parameters<AgentExecutor<TOOLS>["requestIdleRecovery"]>
  ): ReturnType<AgentExecutor<TOOLS>["requestIdleRecovery"]> {
    return this.executor.requestIdleRecovery(...args);
  }
  waitForIdle(
    ...args: Parameters<AgentExecutor<TOOLS>["waitForIdle"]>
  ): ReturnType<AgentExecutor<TOOLS>["waitForIdle"]> {
    return this.executor.waitForIdle(...args);
  }
  prompt(
    ...args: Parameters<AgentExecutor<TOOLS>["prompt"]>
  ): ReturnType<AgentExecutor<TOOLS>["prompt"]> {
    return this.executor.prompt(...args);
  }
  continue(
    ...args: Parameters<AgentExecutor<TOOLS>["continue"]>
  ): ReturnType<AgentExecutor<TOOLS>["continue"]> {
    return this.executor.continue(...args);
  }
}
