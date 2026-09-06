import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { isDeepStrictEqual } from "node:util";
import type { ModelMessage } from "ai";
import { Result, type Result as ResultType } from "better-result";
import {
  AgentAdapterFailure,
  type AgentAdapter,
  type AgentExecution,
  type AgentExecutionEvent,
  type AgentInput,
  type AgentPreparedContext,
  type AgentToolResult,
} from "../../agent-adapter";
import { createAgentEventChannel } from "../../agent-execution-events";
import type { AgentExecutionHost } from "../../agent-execution-host";
import { captureAgentPromise, captureAgentOperation, isAgentPanic } from "../../failure-adapters";
import { resultOutcome, lengthRecoveryContinueMessage } from "../../agent-runtime-support";
import { snapshotAgentMessage } from "../../message-clone";
import { openAIRequestCodec } from "./input";
import { openAIResponseCodec } from "./output";
import type {
  OpenAIProjectedResponse,
  OpenAIProtocolEvent,
  OpenAIResponse,
  OpenAIResponseRequest,
  OpenAIRequestCodec,
} from "./protocol";
import type { ResponsesDiagnostics } from "./diagnostics";
import type { OpenAIResponsesConnect, OpenAIResponsesSocket } from "./socket";

export type OpenAIResponsesAdapterOptions = {
  readonly diagnostics?: ResponsesDiagnostics;
  readonly model: string;
  readonly transport: "auto" | "websocket";
  readonly connect: OpenAIResponsesConnect;
  readonly fallback?: AgentAdapter<AgentExecutionHost>;
  readonly executionMode?: "single-agent" | "multi-agent";
  readonly nativeSteering?: boolean;
  readonly requestCodec?: OpenAIRequestCodec;
};
type EventPayload = AgentExecutionEvent extends infer Event
  ? Event extends AgentExecutionEvent
    ? Omit<Event, "attemptId" | "sequence">
    : never
  : never;
type TerminalOutcome = Extract<AgentExecutionEvent, { type: "terminal" }>["outcome"];
type ParentResponse = {
  readonly id: string;
  readonly prepared: AgentPreparedContext;
  readonly request: OpenAIResponseRequest;
  complete?: OpenAIProjectedResponse;
  response?: OpenAIResponse;
  toolsStarted: boolean;
  toolsSettled: boolean;
  results?: readonly AgentToolResult[];
  continuationSent: boolean;
  committed: boolean;
  completedItems: ResponseOutputItem[];
  settledResults: AgentToolResult[];
};
type SubmittedInput = {
  readonly input: AgentInput;
  readonly parentId: string;
  readonly prepared: AgentPreparedContext;
  steerId?: string;
};
type SessionTask =
  | { type: "protocol"; event: OpenAIProtocolEvent }
  | { type: "failure"; error: AgentAdapterFailure }
  | {
      type: "tools";
      parentId: string;
      result: ResultType<readonly AgentToolResult[], AgentAdapterFailure>;
    }
  | { type: "control" }
  | { type: "abort" };

function failure(
  message: string,
  reason: AgentAdapterFailure["reason"] = "protocol",
  replaySafety: AgentAdapterFailure["replaySafety"] = "reconcile",
): AgentAdapterFailure {
  return new AgentAdapterFailure({ reason, message, replaySafety });
}

export function supportsOpenAINativeSteering(
  options: Pick<OpenAIResponsesAdapterOptions, "model" | "transport" | "executionMode">,
  providerOptions: ReturnType<AgentExecutionHost["readState"]>["providerOptions"],
): boolean {
  const settings = providerOptions?.openai;
  return (
    options.model === "gpt-6-astra" &&
    options.executionMode !== "multi-agent" &&
    !settings?.conversation &&
    !settings?.contextManagement &&
    !settings?.compactionTrigger
  );
}

export class OpenAIResponsesAgentAdapter implements AgentAdapter<AgentExecutionHost> {
  constructor(private readonly options: OpenAIResponsesAdapterOptions) {}
  createExecution(
    context: Parameters<AgentAdapter<AgentExecutionHost>["createExecution"]>[0],
  ): AgentExecution {
    return new OpenAIResponsesExecution(this.options, context);
  }
}

class OpenAIResponsesExecution implements AgentExecution {
  readonly attemptId: string;
  private readonly diagnostics: ResponsesDiagnostics | undefined;
  private readonly channel = createAgentEventChannel();
  readonly events = this.channel.events;
  private sequence = 0;
  private started = false;
  private ended = false;
  private closing = false;
  private readonly controller = new AbortController();
  private readonly tasks: SessionTask[] = [];
  private available = Promise.withResolvers<void>();
  private readonly inputs: AgentInput[] = [];
  private submitting: SubmittedInput | undefined;
  private readonly responses = new Map<string, ParentResponse>();
  private readonly outputMetadata = new Map<
    string,
    { callId?: string; toolName?: string; phase?: "commentary" | "final_answer" }
  >();
  private readonly startedOutput = new Set<string>();
  private readonly accounted = new Set<string>();
  private current: ParentResponse | undefined;
  private pendingRequest:
    | {
        prepared: AgentPreparedContext;
        request: OpenAIResponseRequest;
        continuationParentId?: string;
      }
    | undefined;
  private socket: OpenAIResponsesSocket | undefined;
  private work: Promise<void> | undefined;
  private readerWork: Promise<void> | undefined;
  private readonly hostWork = new Set<Promise<void>>();
  private history: ModelMessage[];
  private committedLength: number;
  private fallback: AgentExecution | undefined;
  private fallbackOutcome: TerminalOutcome | undefined;
  private interrupted = false;
  private controlDiagnosticFailure: AgentAdapterFailure | undefined;
  private boundaryDeliveryRequired = false;
  private lengthRecoveryAttempted = false;
  constructor(
    private readonly options: OpenAIResponsesAdapterOptions,
    private readonly context: Parameters<AgentAdapter<AgentExecutionHost>["createExecution"]>[0],
  ) {
    this.attemptId = context.attemptId;
    this.diagnostics = options.diagnostics?.withContext({ attemptId: context.attemptId });
    this.history = context.messages.map(snapshotAgentMessage);
    this.committedLength = this.history.length;
  }
  get retryOwner() {
    return this.fallback?.retryOwner ?? "host";
  }
  get capabilities() {
    if (this.fallback) return this.fallback.capabilities;
    return {
      steering:
        !this.closing &&
        !this.boundaryDeliveryRequired &&
        this.options.nativeSteering !== false &&
        supportsOpenAINativeSteering(this.options, this.context.host.readState().providerOptions)
          ? ("native" as const)
          : ("boundary" as const),
      followUp: "boundary" as const,
      interruption: "restart" as const,
    };
  }
  start(): ResultType<void, AgentAdapterFailure> {
    if (this.started)
      return Result.err(failure("Execution already started", "invalid-state", "safe"));
    this.started = true;
    this.work = this.run();
    return Result.ok(undefined);
  }
  submitInput(input: AgentInput): ResultType<void, AgentAdapterFailure> {
    if (this.ended || this.closing || this.controller.signal.aborted)
      return Result.err(failure("OpenAI execution is retired", "invalid-state", "safe"));
    if (this.capabilities.steering !== "native" || input.intent !== "steer")
      return Result.err(
        failure("This OpenAI execution uses boundary input delivery", "invalid-state", "safe"),
      );
    this.diagnostics?.log("execution.input_queued", { inputId: input.id, delivery: "native" });
    this.inputs.push({ ...input, messages: input.messages.map(snapshotAgentMessage) });
    this.enqueue({ type: "control" });
    return Result.ok(undefined);
  }
  async interrupt(): Promise<ResultType<void, AgentAdapterFailure>> {
    this.interrupted = true;
    this.stop("execution.interrupt");
    if (this.fallback) return await this.fallback.interrupt();
    if (this.work) await this.work;
    return Result.ok(undefined);
  }
  async cancel(): Promise<ResultType<void, AgentAdapterFailure>> {
    this.stop("execution.cancel");
    if (this.fallback) return await this.fallback.cancel();
    if (this.work) await this.work;
    return Result.ok(undefined);
  }
  async dispose(): Promise<ResultType<void, AgentAdapterFailure>> {
    this.stop();
    const disposal = this.fallback
      ? await this.fallback.dispose()
      : Result.ok<void, AgentAdapterFailure>(undefined);
    if (this.work) await this.work;
    this.channel.close();
    return disposal;
  }
  private stop(event?: "execution.cancel" | "execution.interrupt"): void {
    this.controller.abort();
    this.enqueue({ type: "abort" });
    if (!event) return;
    const logged = resultOutcome(captureAgentOperation(() => this.diagnostics?.log(event)));
    if (!logged.ok && isAgentPanic(logged.error))
      this.controlDiagnosticFailure ??= new AgentAdapterFailure({
        reason: "unavailable",
        message: "Responses control diagnostics failed",
        replaySafety: "reconcile",
        cause: logged.error,
      });
  }
  private get signal(): AbortSignal {
    const hostSignal = this.context.host.signal();
    return hostSignal
      ? AbortSignal.any([this.controller.signal, hostSignal])
      : this.controller.signal;
  }
  private emit(payload: EventPayload): number {
    const sequence = this.sequence++;
    this.channel.push({ ...payload, attemptId: this.attemptId, sequence });
    return sequence;
  }
  private enqueue(task: SessionTask): void {
    if (this.ended) return;
    this.tasks.push(task);
    this.available.resolve();
  }
  private async next(): Promise<SessionTask> {
    while (true) {
      const task = this.tasks.shift();
      if (task) return task;
      await this.available.promise;
      this.available = Promise.withResolvers<void>();
    }
  }
  private async run(): Promise<void> {
    const signal = this.signal;
    const onAbort = () => {
      this.enqueue({ type: "abort" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const result = resultOutcome(await captureAgentPromise(() => this.execute(signal)));
    const wasAborted = signal.aborted;
    this.closing = true;
    const closed = resultOutcome(captureAgentOperation(() => this.socket?.close()));
    this.controller.abort();
    await Promise.all(this.hostWork);
    if (this.readerWork) await this.readerWork;
    signal.removeEventListener("abort", onAbort);
    const flushed = resultOutcome(await captureAgentPromise(async () => this.diagnostics?.flush()));
    let outcome = result.ok
      ? resultOutcome(result.value)
      : {
          ok: false as const,
          error: new AgentAdapterFailure({
            reason: "unavailable",
            message:
              result.error instanceof Error ? result.error.message : "OpenAI execution failed",
            replaySafety: "reconcile",
            cause: result.error,
          }),
        };
    if (outcome.ok && this.fallbackOutcome?.status === "failed")
      outcome = { ok: false, error: this.fallbackOutcome.error };
    if (!outcome.ok && isAgentPanic(outcome.error.cause)) {
      this.fail(outcome.error);
      return;
    }
    if (!closed.ok && isAgentPanic(closed.error)) {
      this.fail(
        new AgentAdapterFailure({
          reason: "unavailable",
          message: "OpenAI socket cleanup failed",
          replaySafety: "reconcile",
          cause: closed.error,
        }),
      );
      return;
    }
    if (!flushed.ok && isAgentPanic(flushed.error)) {
      this.fail(
        new AgentAdapterFailure({
          reason: "unavailable",
          message: "Responses diagnostics cleanup failed",
          replaySafety: "reconcile",
          cause: flushed.error,
        }),
      );
      return;
    }
    if (!outcome.ok) {
      if (this.fallbackOutcome) {
        this.settleTerminal(this.fallbackOutcome);
        return;
      }
      if (wasAborted && !isAgentPanic(outcome.error.cause)) {
        this.complete(this.interrupted ? "interrupted" : "cancelled");
        return;
      }
      this.fail(outcome.error);
      return;
    }
    if (!closed.ok) {
      this.fail(
        new AgentAdapterFailure({
          reason: "unavailable",
          message: "OpenAI socket cleanup failed",
          replaySafety: "reconcile",
          cause: closed.error,
        }),
      );
      return;
    }
    if (this.ended) return;
    if (this.fallbackOutcome) {
      this.settleTerminal(this.fallbackOutcome);
      return;
    }
    if (!wasAborted) {
      this.complete("completed");
      return;
    }
    this.complete(this.interrupted ? "interrupted" : "cancelled");
  }
  private complete(status: "completed" | "cancelled" | "interrupted"): void {
    this.settleTerminal({ status });
  }
  private fail(error: AgentAdapterFailure): void {
    this.settleTerminal({ status: "failed", error });
  }
  private settleTerminal(outcome: TerminalOutcome): void {
    if (this.ended) return;
    if (
      this.controlDiagnosticFailure &&
      !(outcome.status === "failed" && isAgentPanic(outcome.error.cause))
    )
      outcome = { status: "failed", error: this.controlDiagnosticFailure };
    const logged = resultOutcome(
      captureAgentOperation(() =>
        this.diagnostics?.log(
          "execution.finished",
          {
            status: outcome.status,
            transport: this.fallback ? "sse" : "websocket",
            ...(outcome.status === "failed"
              ? {
                  reason: outcome.error.reason,
                  replaySafety: outcome.error.replaySafety,
                }
              : {}),
          },
          outcome.status === "failed" ? "warn" : "debug",
        ),
      ),
    );
    const originalPanic = outcome.status === "failed" && isAgentPanic(outcome.error.cause);
    if (!logged.ok && isAgentPanic(logged.error) && !originalPanic)
      outcome = {
        status: "failed",
        error: new AgentAdapterFailure({
          reason: "unavailable",
          message: "Responses terminal diagnostics failed",
          replaySafety: "reconcile",
          cause: logged.error,
        }),
      };
    this.returnQueued();
    if (this.submitting)
      this.emit({ type: "delivery", status: "unresolved", inputIds: [this.submitting.input.id] });
    this.ended = true;
    this.emit({ type: "terminal", outcome });
    this.channel.close();
  }
  private returnToBoundary(inputId: string, reason: string): void {
    this.diagnostics?.log("execution.input_boundary", { inputId, reason, steering: "boundary" });
    this.boundaryDeliveryRequired = true;
    this.emit({ type: "delivery", status: "returned", inputIds: [inputId] });
    this.returnQueued();
  }
  private returnQueued(): void {
    const inputIds = this.inputs.splice(0).map((input) => input.id);
    if (inputIds.length > 0) this.emit({ type: "delivery", status: "returned", inputIds });
  }
  private async execute(signal: AbortSignal): Promise<ResultType<void, AgentAdapterFailure>> {
    this.diagnostics?.log("execution.started", {
      adapter: "responses",
      model: this.options.model,
      transport: "websocket",
      transportMode: this.options.transport,
      steering: this.capabilities.steering,
      followUp: this.capabilities.followUp,
    });
    let boundary = await this.context.host.controlBoundary();
    while (boundary === "again") boundary = await this.context.host.controlBoundary();
    if (boundary === "stop") return Result.ok(undefined);
    const connected = resultOutcome(await this.options.connect(signal, this.diagnostics));
    if (!connected.ok) {
      if (this.options.transport === "auto" && this.options.fallback && !signal.aborted)
        return await this.runFallback(connected.error);
      return Result.err(connected.error);
    }
    this.socket = connected.value;
    this.readerWork = this.observeSocket();
    const initial = resultOutcome(await this.explicitRequest(signal));
    if (!initial.ok) return Result.err(initial.error);
    while (!signal.aborted) {
      const task = await this.next();
      if (task.type === "abort") break;
      if (task.type === "failure") return Result.err(task.error);
      const result = resultOutcome(await this.handleTask(task, signal));
      if (!result.ok) return Result.err(result.error);
      if (result.value === "complete") return Result.ok(undefined);
    }
    return Result.ok(undefined);
  }
  private async runFallback(
    connectionError: AgentAdapterFailure,
  ): Promise<ResultType<void, AgentAdapterFailure>> {
    this.diagnostics?.log(
      "execution.fallback",
      {
        transport: "sse",
        reason: connectionError.reason,
        replaySafety: connectionError.replaySafety,
        steering: "boundary",
      },
      "warn",
    );
    this.returnQueued();
    this.fallback = this.options.fallback!.createExecution(this.context);
    const started = resultOutcome(this.fallback.start());
    if (!started.ok) return Result.err(started.error);
    for await (const event of this.fallback.events) {
      if (event.type === "terminal") {
        this.fallbackOutcome = event.outcome;
        return Result.ok(undefined);
      }
      this.channel.push({ ...event, sequence: this.sequence++ });
    }
    return Result.err(failure("Fallback execution ended without a terminal event"));
  }
  private async observeSocket(): Promise<void> {
    const outcome = resultOutcome(await captureAgentPromise(() => this.readSocket()));
    if (outcome.ok) return;
    this.enqueue({
      type: "failure",
      error: new AgentAdapterFailure({
        reason: "unavailable",
        message: "OpenAI event reader failed",
        replaySafety: "reconcile",
        cause: outcome.error,
      }),
    });
  }
  private async readSocket(): Promise<void> {
    for await (const value of this.socket!.events) {
      const frame = resultOutcome(value);
      if (!frame.ok) {
        this.enqueue({ type: "failure", error: frame.error });
        return;
      }
      const parsed = resultOutcome(openAIResponseCodec.decode(frame.value));
      if (!parsed.ok) {
        this.enqueue({ type: "failure", error: parsed.error });
        return;
      }
      this.enqueue({ type: "protocol", event: parsed.value });
    }
    if (!this.ended && !this.signal.aborted)
      this.enqueue({ type: "failure", error: failure("OpenAI event stream ended", "unavailable") });
  }
  private async explicitRequest(
    signal: AbortSignal,
  ): Promise<ResultType<void, AgentAdapterFailure>> {
    const prepared = resultOutcome(
      await this.context.host.prepareContext({
        attemptId: this.attemptId,
        messages: this.history,
        step: this.responses.size + 1,
        signal,
      }),
    );
    if (!prepared.ok) return Result.err(prepared.error);
    this.history = prepared.value.canonicalMessages.map(snapshotAgentMessage);
    this.committedLength = this.history.length;
    this.boundaryDeliveryRequired = false;
    const state = this.context.host.readState();
    const encoded = resultOutcome(
      await (this.options.requestCodec ?? openAIRequestCodec).request({
        model: this.options.model,
        context: prepared.value,
        providerOptions: state.providerOptions,
        reasoning: state.reasoning,
      }),
    );
    if (!encoded.ok) return Result.err(encoded.error);
    const optimized = resultOutcome(await this.continuationRequest(encoded.value));
    if (!optimized.ok) return Result.err(optimized.error);
    this.pendingRequest = { prepared: prepared.value, request: encoded.value };
    if (this.current?.complete?.calls.length) this.current.continuationSent = true;
    this.context.host.recordModelView(prepared.value.messages, prepared.value.step);
    return this.socket!.send(optimized.value);
  }
  private async continuationRequest(
    request: OpenAIResponseRequest,
  ): Promise<ResultType<OpenAIResponseRequest, AgentAdapterFailure>> {
    if (
      this.socket?.managesContinuation ||
      request.conversation != null ||
      request.previous_response_id != null
    )
      return Result.ok(request);
    const parent = this.current;
    if (!parent?.committed || !parent.complete || this.submitting) return Result.ok(request);
    const state = this.context.host.readState();
    const prefixContext = {
      ...parent.prepared,
      messages: [...parent.prepared.messages, ...parent.complete.messages],
    };
    const prefix = resultOutcome(
      await (this.options.requestCodec ?? openAIRequestCodec).request({
        model: this.options.model,
        context: prefixContext,
        providerOptions: state.providerOptions,
        reasoning: state.reasoning,
      }),
    );
    if (!prefix.ok) return Result.err(prefix.error);
    if (
      !sameSettings(parent.request, request) ||
      !isDeepStrictEqual(prefix.value.input, request.input.slice(0, prefix.value.input.length))
    )
      return Result.ok(request);
    return Result.ok({
      ...request,
      previous_response_id: parent.id,
      input: request.input.slice(prefix.value.input.length),
    });
  }
  private async handleTask(
    task: Exclude<SessionTask, { type: "failure" | "abort" }>,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    if (task.type === "control")
      return (await this.pumpSteer(signal)).map(() => "continue" as const);
    if (task.type === "tools") return await this.finishTools(task, signal);
    const event = task.event;
    switch (event.type) {
      case "ignored":
        return Result.ok("continue");
      case "error": {
        if (event.response?.usage && !this.accounted.has(event.response.id)) {
          this.accounted.add(event.response.id);
          this.emit({ type: "usage", responseId: event.response.id, usage: event.response.usage });
        }
        return Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            message: event.message,
            replaySafety: "reconcile",
            cause: event.details,
          }),
        );
      }
      case "output": {
        const itemId =
          event.output.kind === "tool-input"
            ? event.output.id
            : event.output.id.slice(0, event.output.id.lastIndexOf(":"));
        const metadata = this.outputMetadata.get(itemId);
        const output = {
          ...event.output,
          ...(metadata?.callId ? { id: metadata.callId } : {}),
          ...(metadata?.toolName ? { toolName: metadata.toolName } : {}),
          ...(metadata?.phase ? { messagePhase: metadata.phase } : {}),
        };
        if (!this.startedOutput.has(output.id)) {
          this.startedOutput.add(output.id);
          this.emit({ type: "output", output: { ...output, phase: "start", delta: undefined } });
        }
        if (output.phase !== "start") this.emit({ type: "output", output });
        return Result.ok("continue");
      }
      case "item-start": {
        const item = event.item;
        if (typeof item.id === "string")
          this.outputMetadata.set(item.id, {
            ...(item.type === "function_call" ? { callId: item.call_id } : {}),
            ...(item.type === "function_call" ? { toolName: item.name } : {}),
            ...(item.type === "message" &&
            (item.phase === "commentary" || item.phase === "final_answer")
              ? { phase: item.phase }
              : {}),
          });
        return Result.ok("continue");
      }
      case "item-complete":
        return this.checkpointItem(event.item);
      case "block-complete": {
        const existing = this.current?.completedItems.find((item) => item.id === event.item.id);
        if (event.item.type === "reasoning") {
          if (event.item.summary.length !== 1)
            return Result.err(failure("OpenAI completed an invalid content block"));
          const summary = existing?.type === "reasoning" ? [...existing.summary] : [];
          summary[event.index] = event.item.summary[0]!;
          return this.checkpointItem({ ...event.item, summary });
        }
        if (event.item.type !== "message" || event.item.content.length !== 1)
          return Result.err(failure("OpenAI completed an invalid content block"));
        const content = existing?.type === "message" ? [...existing.content] : [];
        content[event.index] = event.item.content[0]!;
        const phase = this.outputMetadata.get(event.item.id)?.phase;
        return this.checkpointItem({ ...event.item, ...(phase ? { phase } : {}), content });
      }
      case "created":
        return await this.created(event.response, signal);
      case "finished":
        return await this.finished(event.response, signal);
      case "steer-accepted": {
        const pending = this.submitting;
        if (
          !pending ||
          pending.parentId !== event.previousResponseId ||
          (pending.steerId && pending.steerId !== event.steerId)
        )
          return Result.err(failure("Uncorrelated OpenAI steering acceptance"));
        if (!pending.steerId)
          this.emit({ type: "delivery", status: "provider-owned", inputIds: [pending.input.id] });
        this.diagnostics?.log("execution.input_accepted", {
          inputId: pending.input.id,
          responseId: pending.parentId,
          steerId: event.steerId,
        });
        pending.steerId = event.steerId;
        const parent = this.responses.get(pending.parentId);
        return parent ? await this.advance(parent, signal) : Result.ok("continue");
      }
      case "steer-pending": {
        const parent = this.responses.get(event.previousResponseId);
        if (!parent)
          return Result.err(failure("Steering notification references an unknown response"));
        if (
          !this.submitting ||
          this.submitting.parentId !== parent.id ||
          (event.steerId && this.submitting.steerId && event.steerId !== this.submitting.steerId)
        )
          return Result.err(failure("Uncorrelated OpenAI pending steering notification"));
        for (const required of event.requiredInput) {
          if (required.type !== "function_call_output" || typeof required.call_id !== "string")
            return Result.err(failure("OpenAI steering requested unsupported client input"));
          if (
            parent.complete &&
            !parent.complete.calls.some((call) => call.callId === required.call_id)
          )
            return Result.err(failure("OpenAI steering requested an unknown tool result"));
        }
        return await this.advance(parent, signal);
      }
      case "steer-failed": {
        const pending = this.submitting;
        if (
          !pending ||
          pending.parentId !== event.previousResponseId ||
          (event.steerId && pending.steerId && event.steerId !== pending.steerId)
        )
          return Result.err(failure("Uncorrelated OpenAI steering failure"));
        this.returnToBoundary(pending.input.id, "provider_rejected");
        this.submitting = undefined;
        if (!this.current) return Result.ok("continue");
        return await this.advance(this.current, signal);
      }
    }
  }
  private checkpointItem(item: ResponseOutputItem): ResultType<"continue", AgentAdapterFailure> {
    const parent = this.current;
    if (!parent) return Result.err(failure("OpenAI output item preceded response creation"));
    const index = parent.completedItems.findIndex((existing) => existing.id === item.id);
    if (index < 0) parent.completedItems.push(item);
    else parent.completedItems[index] = item;
    const pendingTool = parent.completedItems.findIndex((entry) => entry.type === "function_call");
    const output =
      pendingTool < 0 ? parent.completedItems : parent.completedItems.slice(0, pendingTool);
    const projected = resultOutcome(
      openAIResponseCodec.project({ id: parent.id, status: "in_progress", output }),
    );
    if (!projected.ok) return Result.err(projected.error);
    this.emit({
      type: "history-checkpoint",
      messages: [...this.history, ...projected.value.messages],
    });
    return Result.ok("continue");
  }
  private async pumpSteer(signal: AbortSignal): Promise<ResultType<void, AgentAdapterFailure>> {
    if (this.pendingRequest || this.boundaryDeliveryRequired) return Result.ok(undefined);
    while (!this.submitting && this.current && this.inputs.length > 0) {
      const input = this.inputs.shift()!;
      const encoded = resultOutcome(
        await (this.options.requestCodec ?? openAIRequestCodec).steer(input.messages),
      );
      if (!encoded.ok) {
        this.returnToBoundary(input.id, "input_encoding");
        return Result.ok(undefined);
      }
      const parent = this.current;
      // The preflight must prove that an automatic response may inherit this request's authority.
      const prepared = resultOutcome(
        await this.context.host.prepareContinuation({
          attemptId: this.attemptId,
          scopeId: parent.prepared.scopeId,
          signal,
        }),
      );
      if (!prepared.ok) {
        this.returnToBoundary(input.id, "continuation_preflight");
        return Result.ok(undefined);
      }
      const state = this.context.host.readState();
      const candidate = resultOutcome(
        await (this.options.requestCodec ?? openAIRequestCodec).request({
          model: this.options.model,
          context: prepared.value,
          providerOptions: state.providerOptions,
          reasoning: state.reasoning,
        }),
      );
      if (!candidate.ok || !sameInheritedRequest(parent.request, candidate.value)) {
        this.returnToBoundary(input.id, "inherited_request_changed");
        return Result.ok(undefined);
      }
      this.diagnostics?.log("execution.input_submitted", {
        inputId: input.id,
        responseId: parent.id,
        delivery: "native",
      });
      this.submitting = { input, parentId: parent.id, prepared: prepared.value };
      return this.socket!.send({
        type: "response.steer",
        previous_response_id: parent.id,
        input: encoded.value,
      });
    }
    return Result.ok(undefined);
  }
  private async created(
    response: OpenAIResponse,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    if (this.responses.has(response.id))
      return Result.err(failure("OpenAI repeated a response creation"));
    const pending = this.submitting;
    let prepared = this.pendingRequest?.prepared;
    let request = this.pendingRequest?.request;
    if (pending && response.previousResponseId === pending.parentId) {
      if (!pending.steerId)
        return Result.err(failure("OpenAI successor arrived without steering acceptance"));
      const parent = this.responses.get(pending.parentId)!;
      if (!parent.committed)
        return Result.err(failure("OpenAI successor preceded its complete parent exchange"));
      prepared = pending.prepared;
      request = parent.request;
      const begun = resultOutcome(
        await this.context.host.beginContinuation({
          attemptId: this.attemptId,
          scopeId: prepared.scopeId,
          signal,
        }),
      );
      if (!begun.ok) return Result.err(begun.error);
      this.history.push(...pending.input.messages.map(snapshotAgentMessage));
      const accepted = resultOutcome(await this.commit([pending.input.id]));
      if (!accepted.ok) return Result.err(accepted.error);
      this.submitting = undefined;
      const inheritedMessages = [
        ...parent.prepared.messages,
        ...parent.complete!.messages,
        ...(parent.results ?? []).flatMap((result) => [
          result.message,
          ...(result.expansionMessages ?? []),
        ]),
        ...pending.input.messages,
      ];
      prepared = {
        ...prepared,
        messages: inheritedMessages,
        canonicalMessages: this.history.map(snapshotAgentMessage),
      };
      const state = this.context.host.readState();
      const inherited = resultOutcome(
        await (this.options.requestCodec ?? openAIRequestCodec).request({
          model: this.options.model,
          context: prepared,
          providerOptions: state.providerOptions,
          reasoning: state.reasoning,
        }),
      );
      if (!inherited.ok) return Result.err(inherited.error);
      request = inherited.value;
    }
    if (!pending && this.pendingRequest?.continuationParentId && prepared) {
      if (response.previousResponseId !== this.pendingRequest.continuationParentId)
        return Result.err(failure("OpenAI tool continuation references the wrong parent"));
      const begun = resultOutcome(
        await this.context.host.beginContinuation({
          attemptId: this.attemptId,
          scopeId: prepared.scopeId,
          signal,
        }),
      );
      if (!begun.ok) return Result.err(begun.error);
    }
    if (!prepared || !request) return Result.err(failure("OpenAI created an unexpected response"));
    this.pendingRequest = undefined;
    const parent: ParentResponse = {
      id: response.id,
      prepared,
      request,
      toolsStarted: false,
      toolsSettled: false,
      continuationSent: false,
      committed: false,
      completedItems: [],
      settledResults: [],
    };
    this.responses.set(response.id, parent);
    this.current = parent;
    const steered = resultOutcome(await this.pumpSteer(signal));
    if (!steered.ok) return Result.err(steered.error);
    return Result.ok("continue");
  }
  private async finished(
    response: OpenAIResponse,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    const parent = this.responses.get(response.id);
    if (parent?.response) return Result.ok("continue");
    if (!parent || parent !== this.current)
      return Result.err(failure("OpenAI completed an unknown or inactive response"));
    const projected = resultOutcome(openAIResponseCodec.project(response));
    if (!projected.ok) return Result.err(projected.error);
    parent.complete = projected.value;
    parent.response = response;
    this.emit({ type: "message", phase: "end", message: projected.value.assistant });
    if (response.usage && !this.accounted.has(response.id)) {
      this.accounted.add(response.id);
      this.emit({ type: "usage", responseId: response.id, usage: response.usage });
    }
    if (projected.value.calls.length > 0) {
      parent.toolsStarted = true;
      const work = this.executeParentTools(parent, signal);
      this.hostWork.add(work);
      void work.then(() => this.hostWork.delete(work));
      return Result.ok("continue");
    }
    parent.toolsSettled = true;
    return await this.advance(parent, signal);
  }
  private checkpointTool(parent: ParentResponse, result: AgentToolResult): void {
    if (this.ended || this.closing || this.controller.signal.aborted) return;
    parent.settledResults.push(result);
    const settled = new Set(parent.settledResults.map((entry) => entry.callId));
    const messages = parent.complete!.messages.map((message): ModelMessage => {
      if (message.role !== "assistant" || typeof message.content === "string") return message;
      return {
        ...message,
        content: message.content.filter(
          (part) => part.type !== "tool-call" || settled.has(part.toolCallId),
        ),
      };
    });
    const results = parent.settledResults.flatMap((entry) => [
      entry.message,
      ...(entry.expansionMessages ?? []),
    ]);
    this.emit({ type: "history-checkpoint", messages: [...this.history, ...messages, ...results] });
  }
  private async executeParentTools(parent: ParentResponse, signal: AbortSignal): Promise<void> {
    const captured = resultOutcome(
      await captureAgentPromise(() =>
        this.context.host.executeTools({
          attemptId: this.attemptId,
          scopeId: parent.prepared.scopeId,
          calls: parent.complete!.calls,
          signal,
          onSettled: (result) => this.checkpointTool(parent, result),
        }),
      ),
    );
    if (!captured.ok) {
      this.enqueue({
        type: "failure",
        error: new AgentAdapterFailure({
          reason: "unavailable",
          message: "OpenAI host tool execution failed",
          replaySafety: "reconcile",
          cause: captured.error,
        }),
      });
      return;
    }
    this.enqueue({ type: "tools", parentId: parent.id, result: captured.value });
  }
  private async finishTools(
    task: Extract<SessionTask, { type: "tools" }>,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    const parent = this.responses.get(task.parentId);
    if (!parent || parent.toolsSettled)
      return Result.err(failure("Tool result references an inactive OpenAI response"));
    const result = resultOutcome(task.result);
    if (!result.ok) return Result.err(result.error);
    parent.results = result.value;
    parent.toolsSettled = true;
    return await this.advance(parent, signal);
  }
  private async commit(inputIds: string[]): Promise<ResultType<void, AgentAdapterFailure>> {
    const sequence = this.emit({
      type: "history-commit",
      messages: this.history.slice(this.committedLength).map(snapshotAgentMessage),
      inputIds,
    });
    const result = resultOutcome(
      await this.context.host.awaitEvent({ attemptId: this.attemptId, sequence }),
    );
    if (!result.ok) return Result.err(result.error);
    this.committedLength = this.history.length;
    return Result.ok(undefined);
  }
  private async advance(
    parent: ParentResponse,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    if (!parent.complete || !parent.toolsSettled) return Result.ok("continue");
    if (!parent.committed) {
      this.history.push(...parent.complete.messages.map(snapshotAgentMessage));
      for (const result of parent.results ?? [])
        this.history.push(
          ...[result.message, ...(result.expansionMessages ?? [])].map(snapshotAgentMessage),
        );
      const committed = resultOutcome(await this.commit([]));
      if (!committed.ok) return Result.err(committed.error);
      parent.committed = true;
      const usage = parent.response!.usage;
      if (usage)
        this.emit({
          type: "turn-end",
          finishReason: parent.complete.finishReason,
          messages: parent.complete.messages,
          usage,
          totalUsage: usage,
        });
    }
    if (parent.continuationSent) return Result.ok("continue");
    const steered = resultOutcome(await this.pumpSteer(signal));
    if (!steered.ok) return Result.err(steered.error);
    if (parent.complete.calls.length > 0 && !parent.continuationSent) {
      if (this.submitting && !this.submitting.steerId) return Result.ok("continue");
      if (this.submitting) return await this.continueTools(parent);
      return await this.boundary(parent, signal);
    }
    if (this.submitting || this.inputs.length > 0) return Result.ok("continue");
    if (parent.response?.incompleteReason === "steered")
      return Result.err(failure("OpenAI steered response has no owned input"));
    return await this.boundary(parent, signal);
  }
  private async continueTools(
    parent: ParentResponse,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    const results = (parent.results ?? []).flatMap((result) => [
      result.message,
      ...(result.expansionMessages ?? []),
    ]);
    const encoded = resultOutcome(
      await (this.options.requestCodec ?? openAIRequestCodec).messages(results, {
        outputSchemaToolNames: parent.prepared.tools
          .filter((tool) => tool.outputSchemaJson !== undefined)
          .map((tool) => tool.name),
      }),
    );
    if (!encoded.ok) return Result.err(encoded.error);
    const prepared = {
      ...this.submitting!.prepared,
      messages: [...parent.prepared.messages, ...parent.complete!.messages, ...results],
      canonicalMessages: this.history.map(snapshotAgentMessage),
    };
    const state = this.context.host.readState();
    const inherited = resultOutcome(
      await (this.options.requestCodec ?? openAIRequestCodec).request({
        model: this.options.model,
        context: prepared,
        providerOptions: state.providerOptions,
        reasoning: state.reasoning,
      }),
    );
    if (!inherited.ok) return Result.err(inherited.error);
    parent.continuationSent = true;
    this.pendingRequest = { prepared, request: inherited.value, continuationParentId: parent.id };
    return this.socket!.send({
      ...parent.request,
      previous_response_id: parent.id,
      input: encoded.value,
    }).map(() => "continue" as const);
  }
  private async boundary(
    parent: ParentResponse,
    signal: AbortSignal,
  ): Promise<ResultType<"continue" | "complete", AgentAdapterFailure>> {
    if (parent.complete!.finishReason === "length" && !this.lengthRecoveryAttempted) {
      this.lengthRecoveryAttempted = true;
      const action = await this.context.host.finishBoundary({
        finishReason: "length",
        modelInputMessages: parent.prepared.messages,
        executedToolCallCount: 0,
        naturallyRequiresContinuation: false,
        continuationMessage: lengthRecoveryContinueMessage(),
        signal,
      });
      if (action === "break") return Result.ok("complete");
      return (await this.explicitRequest(signal)).map(() => "continue" as const);
    }
    const boundary = resultOutcome(
      await this.context.host.boundary({
        attemptId: this.attemptId,
        finishReason: parent.complete!.finishReason,
        modelInputMessages: parent.prepared.messages,
        executedToolCallCount: (parent.results ?? []).reduce(
          (count, result) => count + (result.executedCallCount ?? 1),
          0,
        ),
        naturallyRequiresContinuation: parent.complete!.calls.length > 0,
        signal,
      }),
    );
    if (!boundary.ok) return Result.err(boundary.error);
    this.history = boundary.value.messages.map(snapshotAgentMessage);
    this.committedLength = this.history.length;
    if (boundary.value.action === "complete") return Result.ok("complete");
    return (await this.explicitRequest(signal)).map(() => "continue" as const);
  }
}

function sameInheritedRequest(
  previous: OpenAIResponseRequest,
  next: OpenAIResponseRequest,
): boolean {
  return sameSettings(previous, next) && isDeepStrictEqual(previous.input, next.input);
}
function sameSettings(previous: OpenAIResponseRequest, next: OpenAIResponseRequest): boolean {
  const {
    input: _previousInput,
    previous_response_id: _previousId,
    ...previousSettings
  } = previous;
  const { input: _nextInput, previous_response_id: _nextId, ...nextSettings } = next;
  return isDeepStrictEqual(previousSettings, nextSettings);
}
