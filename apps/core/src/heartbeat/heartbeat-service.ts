import { captureError } from "../shared/error-capture.js";
import {
  lilacEventTypes,
  type CmdRequestMessageData,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  getCoreConfig,
  isPanic,
  opaqueErrorCause,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../tools/tool-result-adapters";

import {
  buildHeartbeatRequestMessages,
  HEARTBEAT_SESSION_ID,
  type HeartbeatWakeReason,
  isHeartbeatSessionId,
  resolveHeartbeatModelOverride,
} from "./common";
import { consumerId } from "../shared/event-bus-consumer";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { computeNextCronAtMs } from "../workflow/cron";

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

type HeartbeatTimers = {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

type HeartbeatLifecycleSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

const DEFAULT_HEARTBEAT_CRON = "*/30 * * * *";

export class HeartbeatLifecycleEventInvalid extends TaggedError("HeartbeatLifecycleEventInvalid")<{
  readonly missingHeaders: readonly ("request_id" | "session_id")[];
  readonly message: string;
}> {}

export class HeartbeatLifecycleDependencyUnavailable extends TaggedError(
  "HeartbeatLifecycleDependencyUnavailable",
)<{
  readonly dependency: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type HeartbeatLifecycleDeliveryError =
  | HeartbeatLifecycleEventInvalid
  | HeartbeatLifecycleDependencyUnavailable;

class HeartbeatConfigReloadError extends TaggedError("HeartbeatConfigReloadError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class HeartbeatCronInvalidError extends TaggedError("HeartbeatCronInvalidError")<{
  readonly cron: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class HeartbeatServiceStopFailed extends TaggedError("HeartbeatServiceStopFailed")<{
  readonly phase: "lifecycle" | "tick";
  readonly cause: unknown;
  readonly message: string;
}> {}

type HeartbeatServiceStartError = HeartbeatConfigReloadError | EventDeliveryStartFailed;
type HeartbeatServiceStopError =
  | EventDeliveryStopFailed
  | EventDeliveryDoneError
  | HeartbeatServiceStopFailed;

export type HeartbeatService = {
  tick(reason: HeartbeatWakeReason): Promise<void>;
  stopOutcome(): Promise<
    | { readonly kind: "result"; readonly result: ResultType<void, HeartbeatServiceStopError> }
    | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  >;
};

async function reloadHeartbeatCoreConfig(): Promise<
  ResultType<CoreConfig, HeartbeatConfigReloadError>
> {
  {
    const captured = await Result.tryPromise({
      try: async () => {
        return Result.ok(await getCoreConfig());
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const caught = captured.error.cause;
      if (isPanic(caught)) preserveToolPanic(caught);
      return Result.err(
        new HeartbeatConfigReloadError({
          cause: opaqueErrorCause(caught, "Opaque core-config reload failure"),
          message: "Core config reload failed",
        }),
      );
    }
    return captured.value;
  }
}

function computeHeartbeatCronAtMs(
  cron: string,
  currentMs: number,
): ResultType<number, HeartbeatCronInvalidError> {
  {
    const captured = Result.try({
      try: () => {
        return Result.ok(computeNextCronAtMs({ expr: cron }, currentMs));
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const caught = captured.error.cause;
      if (isPanic(caught)) preserveToolPanic(caught);
      return Result.err(
        new HeartbeatCronInvalidError({
          cron,
          cause: opaqueErrorCause(caught, "Opaque heartbeat cron failure"),
          message: "Heartbeat cron is invalid",
        }),
      );
    }
    return captured.value;
  }
}

export function applyHeartbeatLifecycleDeliveryPolicy(
  error: HeartbeatLifecycleDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "HeartbeatLifecycleEventInvalid":
      return "dead-letter";
    case "HeartbeatLifecycleDependencyUnavailable":
      return "park-pending";
  }
}

export async function startHeartbeatServiceResult(params: {
  bus: LilacBus;
  subscriptionId: string;
  config?: CoreConfig;
  dataDir?: string;
  initialExternalState?: {
    activeRequestIds?: readonly string[];
    lastExternalActivityAt?: number;
    lastActivityAt?: number;
  };
  now?: () => number;
  timers?: HeartbeatTimers;
}): Promise<ResultType<HeartbeatService, HeartbeatServiceStartError>> {
  const logger = createLogger({ module: "heartbeat-service" });
  const now = params.now ?? (() => Date.now());
  const timers: HeartbeatTimers = params.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let cfg: CoreConfig;
  if (params.config) {
    cfg = params.config;
  } else {
    const loaded = await reloadHeartbeatCoreConfig();
    const loadError = loaded.match({ err: (error) => error, ok: () => null });
    if (loadError) return Result.err(loadError);
    const loadedConfig = loaded.match({ ok: (value) => value, err: () => null });
    if (!loadedConfig) {
      return Result.err(
        new HeartbeatConfigReloadError({
          cause: null,
          message: "Core config reload returned no configuration",
        }),
      );
    }
    cfg = loadedConfig;
  }
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  const activeExternalRequestIds = new Set(params.initialExternalState?.activeRequestIds ?? []);
  const outstandingHeartbeatRequestIds = new Set<string>();
  let lastExternalActivityAt = params.initialExternalState?.lastExternalActivityAt ?? 0;
  let lastActivityAt = params.initialExternalState?.lastActivityAt ?? lastExternalActivityAt;
  let scheduledWakeHandle: TimerHandle | null = null;
  let retryHandle: TimerHandle | null = null;
  let scheduledWakeAtMs: number | null = null;
  let stopped = false;
  let activeTick: Promise<void> | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    const reloaded = await reloadHeartbeatCoreConfig();
    const reloadError = reloaded.match({
      err: (error) => error,
      ok: (value) => {
        cfg = value;
        return null;
      },
    });
    if (!reloadError) {
      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", { path: "core-config.yaml" });
      }
      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } else {
      const message = reloadError.message;
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== message) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          outcome: "retaining-last-known-config",
        });
      }

      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = message;
    }
  }

  function clearRetryTimer(): void {
    if (!retryHandle) return;
    timers.clearTimeout(retryHandle);
    retryHandle = null;
  }

  function resolveNextScheduledWakeAtMs(baseNowMs: number): number {
    const currentMs = Math.min(Number.MAX_SAFE_INTEGER, baseNowMs + 1);
    const configuredCron = cfg.surface.heartbeat.cron;
    const scheduled = computeHeartbeatCronAtMs(configuredCron, currentMs);
    const resolveScheduled = scheduled.match<() => number>({
      ok: (value) => () => value,
      err: (error) => () => {
        logger.warn("invalid heartbeat cron; falling back to */30 * * * *", {
          cron: configuredCron,
          ...formatTaggedErrorForLog(error),
          outcome: "using-default-cron",
        });
        const fallback = computeHeartbeatCronAtMs(DEFAULT_HEARTBEAT_CRON, currentMs);
        const resolveFallback = fallback.match<() => number>({
          ok: (value) => () => value,
          err: () => () => {
            logger.error("default heartbeat cron unexpectedly failed; using a 30-minute delay", {
              cron: DEFAULT_HEARTBEAT_CRON,
              outcome: "using-fixed-delay",
            });
            return Math.min(Number.MAX_SAFE_INTEGER, currentMs + 30 * 60 * 1000);
          },
        });
        return resolveFallback();
      },
    });
    return resolveScheduled();
  }

  function clearScheduledWakeTimer(): void {
    if (!scheduledWakeHandle) return;
    timers.clearTimeout(scheduledWakeHandle);
    scheduledWakeHandle = null;
    scheduledWakeAtMs = null;
  }

  function ensureScheduledWake(baseNowMs: number): void {
    const nextWakeAtMs = resolveNextScheduledWakeAtMs(baseNowMs);
    if (scheduledWakeHandle && scheduledWakeAtMs === nextWakeAtMs) return;

    if (scheduledWakeHandle) {
      timers.clearTimeout(scheduledWakeHandle);
    }

    scheduledWakeAtMs = nextWakeAtMs;
    scheduledWakeHandle = timers.setTimeout(
      () => {
        const callbackNowMs = now();
        scheduledWakeHandle = null;
        scheduledWakeAtMs = null;
        ensureScheduledWake(callbackNowMs);
        void tick("interval");
      },
      Math.max(0, nextWakeAtMs - baseNowMs),
    );
  }

  function scheduleRetry(): void {
    if (retryHandle || stopped) return;

    retryHandle = timers.setTimeout(() => {
      retryHandle = null;
      void tick("retry");
    }, cfg.surface.heartbeat.retryBusyMs);
  }

  async function publishHeartbeatRequest(reason: HeartbeatWakeReason): Promise<void> {
    const requestId = `heartbeat:${now()}`;
    const requestDeliveryId = crypto.randomUUID();
    const modelOverride = resolveHeartbeatModelOverride(cfg);
    const messages = buildHeartbeatRequestMessages({
      reason,
      nowMs: now(),
      lastActivityAt: lastActivityAt || undefined,
      heartbeat: cfg.surface.heartbeat,
      dataDir: params.dataDir,
    });

    const data: CmdRequestMessageData = {
      requestDeliveryId,
      queue: "prompt",
      runPolicy: "idle_only_global",
      origin: { kind: "heartbeat", reason },
      messages,
      ...(modelOverride ? { modelOverride } : {}),
    };

    outstandingHeartbeatRequestIds.add(requestId);
    let published = false;
    await (async () => {
      adaptEventPublishResultToHost(
        await params.bus.publish(lilacEventTypes.CmdRequestMessage, data, {
          headers: {
            request_id: requestId,
            session_id: HEARTBEAT_SESSION_ID,
            request_client: "unknown",
          },
        }),
      );
      published = true;
    })().finally(() => {
      if (!published) outstandingHeartbeatRequestIds.delete(requestId);
    });

    logger.info("heartbeat request published", {
      requestId,
      reason,
    });
  }

  async function tick(reason: HeartbeatWakeReason): Promise<void> {
    if (stopped) return;
    if (activeTick) {
      await activeTick;
      return;
    }

    const runningTick = (async () => {
      await reloadCoreConfigIfNeeded();
      if (stopped) return;

      ensureScheduledWake(now());

      const heartbeat = cfg.surface.heartbeat;
      if (!heartbeat.enabled) {
        clearRetryTimer();
        return;
      }

      if (outstandingHeartbeatRequestIds.size > 0) {
        scheduleRetry();
        return;
      }

      if (activeExternalRequestIds.size > 0) {
        logger.info("heartbeat wake suppressed", {
          reason,
          suppression: "external_request_running",
          activeExternalRequests: activeExternalRequestIds.size,
        });
        scheduleRetry();
        return;
      }

      const quietAfterActivityMs = heartbeat.quietAfterActivityMs;
      if (lastExternalActivityAt > 0 && now() - lastExternalActivityAt < quietAfterActivityMs) {
        logger.info("heartbeat wake suppressed", {
          reason,
          suppression: "recent_external_activity",
          quietAfterActivityMs,
          ageMs: now() - lastExternalActivityAt,
        });
        scheduleRetry();
        return;
      }

      clearRetryTimer();
      if (stopped) return;
      await publishHeartbeatRequest(reason);
    })();

    activeTick = runningTick;
    await runningTick.finally(() => {
      if (activeTick === runningTick) {
        activeTick = null;
      }
    });
  }

  async function startHeartbeatLifecycleResult(): Promise<
    ResultType<HeartbeatLifecycleSubscription, EventDeliveryStartFailed>
  > {
    return params.bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: `${params.subscriptionId}:lifecycle`,
        consumerId: consumerId(`${params.subscriptionId}:lifecycle`),
        batch: { maxWaitMs: 1000 },
      },
      async (msg): Promise<ResultType<void, HeartbeatLifecycleDeliveryError>> => {
        if (msg.type !== lilacEventTypes.EvtRequestLifecycleChanged) {
          return Result.ok(undefined);
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        if (!requestId || !sessionId) {
          const missingHeaders: Array<"request_id" | "session_id"> = [];
          if (!requestId) missingHeaders.push("request_id");
          if (!sessionId) missingHeaders.push("session_id");
          return Result.err(
            new HeartbeatLifecycleEventInvalid({
              missingHeaders,
              message: `evt.request.lifecycle.changed missing required headers: ${missingHeaders.join(", ")}`,
            }),
          );
        }

        const isHeartbeat = isHeartbeatSessionId(sessionId);

        if (isHeartbeat) {
          if (msg.data.state === "running" || msg.data.state === "queued") {
            outstandingHeartbeatRequestIds.add(requestId);
          }

          if (
            msg.data.state === "resolved" ||
            msg.data.state === "failed" ||
            msg.data.state === "cancelled"
          ) {
            outstandingHeartbeatRequestIds.delete(requestId);
          }

          return Result.ok(undefined);
        }

        const activityTs = msg.data.ts ?? msg.ts;
        lastExternalActivityAt = activityTs;
        lastActivityAt = Math.max(lastActivityAt, activityTs);

        if (msg.data.state === "running") {
          activeExternalRequestIds.add(requestId);
        }

        if (
          msg.data.state === "resolved" ||
          msg.data.state === "failed" ||
          msg.data.state === "cancelled"
        ) {
          activeExternalRequestIds.delete(requestId);
        }

        return Result.ok(undefined);
      },
      applyHeartbeatLifecycleDeliveryPolicy,
    );
  }

  const lifecycleStarted = await startHeartbeatLifecycleResult();
  const lifecycleStartError = lifecycleStarted.match({ err: (error) => error, ok: () => null });
  if (lifecycleStartError) return Result.err(lifecycleStartError);
  const lifecycleSub: HeartbeatLifecycleSubscription | null = lifecycleStarted.match({
    ok: (value) => value,
    err: () => null,
  });
  if (!lifecycleSub) {
    return Result.err(
      new HeartbeatConfigReloadError({
        cause: null,
        message: "Heartbeat lifecycle startup returned no subscription",
      }),
    );
  }
  const activeLifecycleSub = lifecycleSub;

  async function stopHeartbeatLifecycleResult(): Promise<
    ResultType<void, EventDeliveryStopFailed | EventDeliveryDoneError>
  > {
    const lifecycleStopped = await activeLifecycleSub.stop();
    const lifecycleStopError = lifecycleStopped.match({ err: (error) => error, ok: () => null });
    if (lifecycleStopError) return Result.err(lifecycleStopError);

    const lifecycleDone = await activeLifecycleSub.done;
    const lifecycleDoneError = lifecycleDone.match({ err: (error) => error, ok: () => null });
    if (lifecycleDoneError) return Result.err(lifecycleDoneError);
    return Result.ok(undefined);
  }

  ensureScheduledWake(now());

  const stopOutcome = async (): Promise<
    | { readonly kind: "result"; readonly result: ResultType<void, HeartbeatServiceStopError> }
    | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  > => {
    if (stopped) return { kind: "result", result: Result.ok(undefined) };
    stopped = true;

    clearRetryTimer();
    clearScheduledWakeTimer();

    const [lifecycleStop, tickSettled] = await Promise.allSettled([
      stopHeartbeatLifecycleResult(),
      activeTick,
    ]);
    activeExternalRequestIds.clear();
    outstandingHeartbeatRequestIds.clear();
    if (lifecycleStop.status === "rejected") {
      if (isPanic(lifecycleStop.reason)) return { kind: "panic", panic: lifecycleStop.reason };
    }
    if (tickSettled.status === "rejected" && isPanic(tickSettled.reason)) {
      return { kind: "panic", panic: tickSettled.reason };
    }
    if (lifecycleStop.status === "rejected") {
      return {
        kind: "result",
        result: Result.err(
          new HeartbeatServiceStopFailed({
            phase: "lifecycle",
            cause: opaqueErrorCause(
              lifecycleStop.reason,
              "Opaque heartbeat lifecycle stop failure",
            ),
            message: "Heartbeat lifecycle stop failed",
          }),
        ),
      };
    }
    const lifecycleStopError = lifecycleStop.value.match({
      err: (error) => error,
      ok: () => null,
    });
    if (lifecycleStopError) return { kind: "result", result: Result.err(lifecycleStopError) };
    if (tickSettled.status === "rejected") {
      return {
        kind: "result",
        result: Result.err(
          new HeartbeatServiceStopFailed({
            phase: "tick",
            cause: opaqueErrorCause(tickSettled.reason, "Opaque heartbeat tick failure"),
            message: "Heartbeat tick failed while stopping",
          }),
        ),
      };
    }
    return { kind: "result", result: Result.ok(undefined) };
  };

  return Result.ok({
    tick,
    stopOutcome,
  });
}
