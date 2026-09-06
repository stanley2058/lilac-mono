import type { ModelMessage, ToolSet } from "ai";
import { Result, type Result as ResultType } from "better-result";
import {
  AgentAdapterFailure,
  captureAgentOperation,
  captureAgentPromise,
  rethrowAgentPanic,
  isAgentPanic,
  type AgentAdapter,
  type AgentExecution,
  type AgentExecutionEvent,
  type AgentInput,
  type AiSdkPiAgentOptions,
  type PrepareModelCall,
} from "@stanley2058/lilac-agent";
import { AiSdkAgentAdapter } from "@stanley2058/lilac-agent/adapters/ai-sdk/adapter";
import { createAgentEventChannel } from "@stanley2058/lilac-agent/agent-execution-events";
import type { AgentExecutionHost } from "@stanley2058/lilac-agent/agent-execution-host";
import { resultOutcome } from "@stanley2058/lilac-agent/agent-runtime-support";
import type { MaterializedClaudeCodeRun } from "./claude-code-run";

export type ClaudeCodeAgentLifecycle = {
  currentRun(): MaterializedClaudeCodeRun | null;
  prepareModelCall?: PrepareModelCall;
  recordSuccessfulModelCall?(messages: readonly ModelMessage[]): Promise<void>;
  retireForRetry?(): Promise<void>;
};

type EventPayload = AgentExecutionEvent extends infer Event
  ? Event extends AgentExecutionEvent
    ? Omit<Event, "attemptId" | "sequence">
    : never
  : never;
type Injection = {
  input: AgentInput;
  state:
    | "submitting"
    | "pending"
    | "delivered"
    | "returned"
    | "committing"
    | "committed"
    | "unresolved";
  callback?: boolean;
};

export class ClaudeCodeAgentAdapter<TOOLS extends ToolSet = ToolSet> implements AgentAdapter<
  AgentExecutionHost<TOOLS>
> {
  constructor(
    private readonly options: AiSdkPiAgentOptions<TOOLS>,
    private readonly lifecycle: ClaudeCodeAgentLifecycle,
  ) {}

  createExecution(
    context: Parameters<AgentAdapter<AgentExecutionHost<TOOLS>>["createExecution"]>[0],
  ): AgentExecution {
    const channel = createAgentEventChannel();
    const injections: Injection[] = [];
    let sequence = 0;
    let started = false;
    let retired = false;
    let retryOwner: "host" | "adapter" = "adapter";
    let boundaryDeliveryRequired = false;
    let nativeAccepting = false;
    let uncertainSubmission = false;
    let pumping: Promise<void> | undefined;
    const emit = (event: EventPayload): number => {
      const current = sequence++;
      channel.push({ ...event, attemptId: context.attemptId, sequence: current });
      return current;
    };
    const fail = (message: string, replaySafety: "safe" | "reconcile" = "safe") =>
      new AgentAdapterFailure({ reason: "unavailable", message, replaySafety });
    const returnAtBoundary = (message: string): ResultType<void, AgentAdapterFailure> => {
      boundaryDeliveryRequired = true;
      return Result.err(fail(message));
    };
    const settleInjection = (entry: Injection, delivered: boolean): void => {
      if (retired || entry.state === "committed" || entry.state === "returned") return;
      if (entry.state === "submitting") {
        entry.callback = delivered;
        return;
      }
      if (entry.state !== "pending") return;
      entry.state = delivered ? "delivered" : "returned";
      if (!delivered) emit({ type: "delivery", inputIds: [entry.input.id], status: "returned" });
    };
    const flushDelivered = async (): Promise<ResultType<void, AgentAdapterFailure>> => {
      const delivered = injections.filter((entry) => entry.state === "delivered");
      if (delivered.length === 0) return Result.ok(undefined);
      for (const entry of delivered) entry.state = "committing";
      const committedSequence = emit({
        type: "history-commit",
        messages: delivered.flatMap((entry) => [...entry.input.messages]),
        inputIds: delivered.map((entry) => entry.input.id),
      });
      const accepted = await context.host.awaitEvent({
        attemptId: context.attemptId,
        sequence: committedSequence,
      });
      accepted.match({
        ok: () => {
          for (const entry of delivered) entry.state = "committed";
        },
        err: () => {
          retryOwner = "host";
          for (const entry of delivered) entry.state = "unresolved";
        },
      });
      return accepted;
    };
    const unresolvedInputs = () =>
      injections.filter(
        (entry) =>
          entry.state === "pending" || entry.state === "unresolved" || entry.state === "committing",
      );
    const closeDeliveryWindow = (): void => {
      nativeAccepting = false;
      // A later acknowledgement cannot establish where its input belongs before the completed turn.
      for (const entry of injections) {
        if (entry.state !== "pending") continue;
        entry.state = "unresolved";
        retryOwner = "host";
      }
    };
    const wrappedHost: AgentExecutionHost<TOOLS> = {
      ...context.host,
      prepareRequest: async (request) => {
        const prepared = await context.host.prepareRequest(request);
        nativeAccepting = true;
        return prepared;
      },
      commitTurn: async (turn) => {
        closeDeliveryWindow();
        const committed = resultOutcome(await flushDelivered());
        if (!committed.ok) return signalClaudeAdapterHost(committed.error);
        await context.host.commitTurn(turn);
      },
      finishBoundary: async (input) => {
        if (unresolvedInputs().length > 0) {
          retryOwner = "host";
          return "break";
        }
        await this.lifecycle.recordSuccessfulModelCall?.(context.host.readState().messages);
        const decision = await context.host.finishBoundary(input);
        for (let index = injections.length - 1; index >= 0; index -= 1) {
          const entry = injections[index];
          if (entry?.state === "committed" || entry?.state === "returned")
            injections.splice(index, 1);
        }
        boundaryDeliveryRequired = false;
        return decision;
      },
      settleFailure: async (error, failureContext) => {
        closeDeliveryWindow();
        rethrowAgentPanic(error);
        const committed = resultOutcome(await flushDelivered());
        if (!committed.ok) return signalClaudeAdapterHost(committed.error);
        if (unresolvedInputs().length > 0) {
          retryOwner = "host";
          return "break";
        }
        const decision = await context.host.settleFailure(error, failureContext);
        if (decision === "continue") await this.lifecycle.retireForRetry?.();
        return decision;
      },
    };
    const sdk = new AiSdkAgentAdapter({
      ...this.options,
      prepareModelCall: this.lifecycle.prepareModelCall ?? this.options.prepareModelCall,
      sendToolsToModel: false,
    }).createExecution({ ...context, host: wrappedHost });
    const drain = async (): Promise<void> => {
      for await (const event of sdk.events) {
        if (event.type !== "terminal") {
          emit(event);
          continue;
        }
        closeDeliveryWindow();
        const committed = resultOutcome(await flushDelivered());
        const unresolved = unresolvedInputs();
        for (const entry of unresolved)
          emit({ type: "delivery", inputIds: [entry.input.id], status: "unresolved" });
        retired = true;
        if (event.outcome.status === "failed" && isAgentPanic(event.outcome.error.cause)) {
          emit(event);
          break;
        }
        if (!committed.ok) {
          emit({ type: "terminal", outcome: { status: "failed", error: committed.error } });
          break;
        }
        if (unresolved.length > 0 && event.outcome.status !== "cancelled") {
          emit({
            type: "terminal",
            outcome: {
              status: "failed",
              error: fail(
                "Claude input delivery remained unresolved when execution ended",
                "reconcile",
              ),
            },
          });
          break;
        }
        emit(event);
        break;
      }
      channel.close();
    };
    const pump = async (): Promise<void> => {
      const drained = resultOutcome(await captureAgentPromise(drain));
      if (!drained.ok) {
        retired = true;
        if (unresolvedInputs().length > 0 || uncertainSubmission) retryOwner = "host";
        emit({
          type: "terminal",
          outcome: {
            status: "failed",
            error: new AgentAdapterFailure({
              reason: "unavailable",
              message: "Claude execution event processing failed",
              replaySafety: "reconcile",
              cause: drained.error,
            }),
          },
        });
      }
      channel.close();
    };
    const interrupt = async (): Promise<ResultType<void, AgentAdapterFailure>> => {
      if (retired) return Result.ok(undefined);
      const run = this.lifecycle.currentRun();
      if (!run) return Result.ok(undefined);
      const captured = resultOutcome(
        await captureAgentPromise(() => run.control.interruptResult()),
      );
      if (!captured.ok) {
        rethrowAgentPanic(captured.error);
        return Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            message: "Claude interruption failed",
            replaySafety: "reconcile",
            cause: captured.error,
          }),
        );
      }
      return captured.value
        .map(() => undefined)
        .mapError(
          (cause) =>
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "Claude interruption failed",
              replaySafety: "reconcile",
              cause,
            }),
        );
    };
    return {
      attemptId: context.attemptId,
      get retryOwner() {
        return retryOwner;
      },
      capabilities: { steering: "native", followUp: "boundary", interruption: "native" },
      events: channel.events,
      start: () => {
        if (started || retired)
          return Result.err(fail("Claude execution is already started or retired"));
        started = true;
        pumping = pump();
        return sdk.start();
      },
      submitInput: (input) => {
        if (!started || retired || !nativeAccepting)
          return returnAtBoundary("Claude execution is not active");
        if (boundaryDeliveryRequired || injections.some((entry) => entry.state !== "committed")) {
          return returnAtBoundary("An earlier Claude input still owns the next delivery position");
        }
        if (input.messages.length !== 1)
          return returnAtBoundary("Claude native injection requires one user text message");
        const message = input.messages[0];
        if (message?.role !== "user" || typeof message.content !== "string")
          return returnAtBoundary("Claude native injection requires one user text message");
        const run = this.lifecycle.currentRun();
        if (!run) return returnAtBoundary("Claude query is not available for injection");
        const text = message.content;
        const entry: Injection = { input, state: "submitting" };
        const submitted = resultOutcome(
          captureAgentOperation(() =>
            run.control.inject(text, (delivered) => settleInjection(entry, delivered)),
          ),
        );
        if (!submitted.ok) {
          retryOwner = "host";
          uncertainSubmission = true;
          rethrowAgentPanic(submitted.error);
          return Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "Claude injection failed",
              replaySafety: "reconcile",
              cause: submitted.error,
            }),
          );
        }
        if (!submitted.value) return returnAtBoundary("Claude query declined native injection");
        injections.push(entry);
        entry.state = "pending";
        emit({ type: "delivery", inputIds: [input.id], status: "provider-owned" });
        if (entry.callback !== undefined) settleInjection(entry, entry.callback);
        return Result.ok(undefined);
      },
      interrupt,
      cancel: async () => {
        const interrupted = resultOutcome(await captureAgentPromise(interrupt));
        const cancelled = resultOutcome(await captureAgentPromise(() => sdk.cancel()));
        if (!interrupted.ok) rethrowAgentPanic(interrupted.error);
        if (!cancelled.ok) rethrowAgentPanic(cancelled.error);
        if (!interrupted.ok)
          return Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "Claude interruption failed",
              replaySafety: "reconcile",
              cause: interrupted.error,
            }),
          );
        if (!cancelled.ok)
          return Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "Claude cancellation failed",
              replaySafety: "reconcile",
              cause: cancelled.error,
            }),
          );
        return interrupted.value.andThen(() => cancelled.value);
      },
      dispose: async () => {
        retired = true;
        const disposed = await sdk.dispose();
        if (pumping) await pumping;
        channel.close();
        if (unresolvedInputs().length > 0 || uncertainSubmission) {
          if (this.lifecycle.retireForRetry) {
            await this.lifecycle.retireForRetry();
            return disposed;
          }
          const run = this.lifecycle.currentRun();
          if (!run?.settleExecutionResult)
            return Result.err(
              fail("Claude runtime cannot prove unresolved execution settlement", "reconcile"),
            );
          const settled = await run.settleExecutionResult();
          return settled
            .mapError(
              (cause) =>
                new AgentAdapterFailure({
                  reason: "unavailable",
                  message: "Claude execution settlement failed",
                  replaySafety: "reconcile",
                  cause,
                }),
            )
            .andThen(() => disposed);
        }
        return disposed;
      },
    };
  }
}

function signalClaudeAdapterHost(error: AgentAdapterFailure): never {
  throw error;
}
