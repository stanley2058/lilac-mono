import { isPanic } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { type EventDeliveryDoneError } from "@stanley2058/lilac-event-bus";
import { type ResidualDiscordRequestRouter } from "../surface/discord/discord-request-router";

function normalizeRouterDoneDefect(cause: unknown): Error {
  if (isPanic(cause)) return cause;
  if (cause instanceof Error) return cause;
  return new Panic({ message: "Discord request router subscription rejected" });
}

export function superviseCoreRouterDone(params: {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  readonly isStopping: () => boolean;
  readonly markUnhealthy: () => void;
  readonly reportFatalError: (error: Error) => void;
}): Promise<void> {
  return supervise();

  async function supervise(): Promise<void> {
    const [settled] = await Promise.allSettled([params.done]);
    if (params.isStopping()) return;
    params.markUnhealthy();
    if (settled.status === "rejected") {
      params.reportFatalError(normalizeRouterDoneDefect(settled.reason));
      return;
    }
    const fatalError = settled.value.match<Error>({
      err: (error) => error,
      ok: () =>
        new Panic({
          message: "Discord request router subscriptions completed unexpectedly",
        }),
    });
    params.reportFatalError(fatalError);
  }
}

export class CoreResidualDiscordRequestRouterStopRejected extends TaggedError(
  "CoreResidualDiscordRequestRouterStopRejected",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreResidualDiscordRequestRouterDoneRejected extends TaggedError(
  "CoreResidualDiscordRequestRouterDoneRejected",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CoreResidualDiscordRequestRouterDoneTimedOut extends TaggedError(
  "CoreResidualDiscordRequestRouterDoneTimedOut",
)<{
  readonly deadlineMs: number;
  readonly message: string;
}> {}

export type CoreResidualDiscordRequestRouterDoneOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<
        void,
        EventDeliveryDoneError | CoreResidualDiscordRequestRouterDoneRejected
      >;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

export function superviseCoreResidualDiscordRequestRouterDone(
  done: Promise<ResultType<void, EventDeliveryDoneError>>,
): Promise<CoreResidualDiscordRequestRouterDoneOutcome> {
  return supervise();

  async function supervise(): Promise<CoreResidualDiscordRequestRouterDoneOutcome> {
    const [settled] = await Promise.allSettled([done]);
    if (settled.status === "rejected") {
      if (isPanic(settled.reason)) return { kind: "panic", panic: settled.reason };
      return {
        kind: "result",
        result: Result.err(
          new CoreResidualDiscordRequestRouterDoneRejected({
            cause: settled.reason,
            message: "Residual Discord request router done rejected",
          }),
        ),
      };
    }
    return { kind: "result", result: settled.value };
  }
}

export function retainCoreResidualDiscordRequestRouter(params: {
  readonly router: ResidualDiscordRequestRouter;
  readonly retainRouter: (router: ResidualDiscordRequestRouter) => void;
  readonly retainDoneSupervision: (
    supervision: Promise<CoreResidualDiscordRequestRouterDoneOutcome>,
  ) => void;
}): void {
  params.retainRouter(params.router);
  params.retainDoneSupervision(superviseCoreResidualDiscordRequestRouterDone(params.router.done));
}

type CoreResidualRouterCleanupRecorder = {
  record(label: string, cause: Error): void;
};

export async function stopCoreResidualDiscordRequestRouter(params: {
  readonly router: ResidualDiscordRequestRouter;
  readonly cleanup: CoreResidualRouterCleanupRecorder;
}): Promise<ResidualDiscordRequestRouter | null> {
  const [settled] = await Promise.allSettled([Promise.resolve().then(() => params.router.stop())]);
  if (settled.status === "rejected") {
    params.cleanup.record(
      "residualRouter.stop",
      isPanic(settled.reason)
        ? settled.reason
        : new CoreResidualDiscordRequestRouterStopRejected({
            cause: settled.reason,
            message: "Residual Discord request router stop rejected",
          }),
    );
    return params.router;
  }

  const outcome = settled.value;
  if (outcome.kind === "panic") {
    params.cleanup.record("residualRouter.stop.panic", outcome.panic);
    for (const panic of outcome.additionalPanics) {
      params.cleanup.record("residualRouter.stop.panic", panic);
    }
    if (outcome.ordinaryFailure) {
      params.cleanup.record("residualRouter.stop", outcome.ordinaryFailure);
    }
    return outcome.residualRouter;
  }
  return outcome.result.match({
    ok: () => outcome.residualRouter,
    err: (error) => {
      params.cleanup.record("residualRouter.stop", error);
      return outcome.residualRouter ?? params.router;
    },
  });
}

export function settleCoreResidualDiscordRequestRouterDone(params: {
  readonly supervision: Promise<CoreResidualDiscordRequestRouterDoneOutcome>;
  readonly cleanup: CoreResidualRouterCleanupRecorder;
  readonly reportLatePanic: (panic: Panic) => void;
  readonly deadlineMs: number;
  readonly scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}): Promise<void> {
  return settle();

  async function settle(): Promise<void> {
    const deadline = Promise.withResolvers<{ readonly kind: "deadline" }>();
    const scheduleDeadline =
      params.scheduleDeadline ??
      ((callback: () => void, delayMs: number) => {
        const timeout = setTimeout(callback, delayMs);
        return () => clearTimeout(timeout);
      });
    const cancelDeadline = scheduleDeadline(
      () => deadline.resolve({ kind: "deadline" }),
      params.deadlineMs,
    );
    const settled = await Promise.race([
      params.supervision.then((outcome) => ({
        kind: "outcome" as const,
        outcome,
      })),
      deadline.promise,
    ]).finally(cancelDeadline);
    if (settled.kind === "deadline") {
      void reportLatePanic();
      params.cleanup.record(
        "residualRouter.done",
        new CoreResidualDiscordRequestRouterDoneTimedOut({
          deadlineMs: params.deadlineMs,
          message: `Residual Discord request router done exceeded ${params.deadlineMs}ms cleanup deadline`,
        }),
      );
      return;
    }
    const { outcome } = settled;
    if (outcome.kind === "panic") {
      params.cleanup.record("residualRouter.done", outcome.panic);
      return;
    }
    outcome.result.match({
      ok: () => undefined,
      err: (error) => params.cleanup.record("residualRouter.done", error),
    });

    async function reportLatePanic(): Promise<void> {
      const [late] = await Promise.allSettled([params.supervision]);
      if (late?.status === "fulfilled" && late.value.kind === "panic") {
        params.reportLatePanic(late.value.panic);
      }
    }
  }
}
