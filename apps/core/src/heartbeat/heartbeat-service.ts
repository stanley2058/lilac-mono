import {
  lilacEventTypes,
  type AdapterPlatform,
  type CmdRequestMessageData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger, getCoreConfig, type CoreConfig } from "@stanley2058/lilac-utils";

import {
  buildHeartbeatRequestMessages,
  HEARTBEAT_SESSION_ID,
  type HeartbeatWakeReason,
  isHeartbeatSessionId,
  resolveHeartbeatModelOverride,
} from "./common";
import { computeNextCronAtMs } from "../workflow/cron";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

type HeartbeatTimers = {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

const DEFAULT_HEARTBEAT_CRON = "*/30 * * * *";

export async function startHeartbeatService(params: {
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
}) {
  const logger = createLogger({ module: "heartbeat-service" });
  const now = params.now ?? (() => Date.now());
  const timers: HeartbeatTimers = params.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let cfg = params.config ?? (await getCoreConfig());
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

    try {
      cfg = await getCoreConfig();

      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", { path: "core-config.yaml" });
      }

      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== message) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: message,
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

    try {
      return computeNextCronAtMs({ expr: cfg.surface.heartbeat.cron }, currentMs);
    } catch (error) {
      logger.warn("invalid heartbeat cron; falling back to */30 * * * *", {
        cron: cfg.surface.heartbeat.cron,
        error: error instanceof Error ? error.message : String(error),
      });
      return computeNextCronAtMs({ expr: DEFAULT_HEARTBEAT_CRON }, currentMs);
    }
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
    const modelOverride = resolveHeartbeatModelOverride(cfg);
    const messages = buildHeartbeatRequestMessages({
      reason,
      nowMs: now(),
      lastActivityAt: lastActivityAt || undefined,
      heartbeat: cfg.surface.heartbeat,
      dataDir: params.dataDir,
    });

    const data: CmdRequestMessageData = {
      queue: "prompt",
      runPolicy: "idle_only_global",
      origin: { kind: "heartbeat", reason },
      messages,
      ...(modelOverride ? { modelOverride } : {}),
    };

    outstandingHeartbeatRequestIds.add(requestId);
    try {
      await params.bus.publish(lilacEventTypes.CmdRequestMessage, data, {
        headers: {
          request_id: requestId,
          session_id: HEARTBEAT_SESSION_ID,
          request_client: "unknown",
        },
      });
    } catch (error) {
      outstandingHeartbeatRequestIds.delete(requestId);
      throw error;
    }

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

      if (
        lastExternalActivityAt > 0 &&
        now() - lastExternalActivityAt < heartbeat.quietAfterActivityMs
      ) {
        logger.info("heartbeat wake suppressed", {
          reason,
          suppression: "recent_external_activity",
          quietAfterActivityMs: heartbeat.quietAfterActivityMs,
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
    try {
      await runningTick;
    } finally {
      if (activeTick === runningTick) {
        activeTick = null;
      }
    }
  }

  const lifecycleSub = await params.bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId: `${params.subscriptionId}:lifecycle`,
      consumerId: consumerId(`${params.subscriptionId}:lifecycle`),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtRequestLifecycleChanged) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = (msg.headers?.request_client ?? "unknown") as AdapterPlatform;
      if (!requestId || !sessionId) {
        throw new Error(
          "evt.request.lifecycle.changed missing required headers.request_id/session_id",
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

        await ctx.commit();
        return;
      }

      void requestClient;
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

      await ctx.commit();
    },
  );

  ensureScheduledWake(now());

  return {
    tick,
    stop: async () => {
      if (stopped) return;
      stopped = true;

      clearRetryTimer();
      clearScheduledWakeTimer();

      await lifecycleSub.stop();
      await activeTick;
      activeExternalRequestIds.clear();
      outstandingHeartbeatRequestIds.clear();
    },
  };
}
