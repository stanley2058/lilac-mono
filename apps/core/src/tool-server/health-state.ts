import type { Logger } from "@stanley2058/simple-module-logger";
import { performance } from "node:perf_hooks";

import {
  createRuntimeDiagnosticSampler,
  type RuntimeDiagnosticSample,
} from "./runtime-diagnostics";

export type ToolServerHealthImpact = "live" | "ready";

export type ToolServerHealthCheck = {
  name: string;
  ok: boolean;
  impact?: ToolServerHealthImpact;
  reason?: string;
  details?: unknown;
};

export type ToolServerHealthProviderResult = {
  checks?: readonly ToolServerHealthCheck[];
  info?: Record<string, unknown>;
};

export type ToolServerActiveLevel1Work = {
  requestId: string;
  requestClient: string;
  runProfile: string;
  phase: "preparing" | "model" | "tool";
  runAgeMs: number;
  tools: readonly {
    toolCallId: string;
    toolName: string;
    ageMs: number;
  }[];
};

export type ToolServerLagIncidentObservation = {
  at: number;
  lagMs: number;
  streak: number;
  runtime?: RuntimeDiagnosticSample;
  activeLevel1Work: readonly ToolServerActiveLevel1Work[];
};

export type ToolServerLagIncident = {
  status: "active" | "recovered";
  enteredAt: number;
  recoveredAt?: number;
  durationMs?: number;
  maxHighLagStreak: number;
  entry: ToolServerLagIncidentObservation;
  peak: ToolServerLagIncidentObservation;
  recovery?: ToolServerLagIncidentObservation;
};

export type ToolServerHealthSnapshot = {
  ok: boolean;
  live: boolean;
  ready: boolean;
  startedAt: number;
  checks: ToolServerHealthCheck[];
  info: {
    process: {
      pid: number;
      uptimeMs: number;
      eventLoopLagMs: number;
      highLagStreak: number;
      lastLagIncident?: ToolServerLagIncident;
      memory: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
      };
    };
    toolServer: {
      initialized: boolean;
      listening: boolean;
      totalCalls: number;
      timedOutCalls: number;
      failedCalls: number;
      cancelledCalls: number;
      activeCalls: Array<{
        token: string;
        toolId: string;
        callableId: string;
        startedAt: number;
        deadlineAt: number;
        overdueMs: number;
        requestId?: string;
      }>;
      pluginStatuses?: readonly unknown[];
    };
    external?: Record<string, unknown>;
    unhandledRejection?: {
      count: number;
      lastAt: number;
      lastReason: string;
    };
  };
};

type ToolCallEntry = {
  token: string;
  toolId: string;
  callableId: string;
  startedAt: number;
  deadlineAt: number;
  requestId?: string;
};

type ToolPluginManagerLike = {
  getStatuses?(): readonly unknown[];
};

export type ToolServerHealthConfig = {
  watchdogIntervalMs?: number;
  watchdogFailureThreshold?: number;
  eventLoopSampleIntervalMs?: number;
  eventLoopLagFailMs?: number;
  eventLoopLagFailStreak?: number;
  toolCallOverdueGraceMs?: number;
  maxRssBytes?: number;
};

type ToolServerHealthStateOptions = ToolServerHealthConfig & {
  logger: Logger;
  pluginManager?: ToolPluginManagerLike;
  externalHealthProvider?: () =>
    | ToolServerHealthProviderResult
    | Promise<ToolServerHealthProviderResult>;
  activeLevel1WorkProvider?: () => readonly ToolServerActiveLevel1Work[];
  runtimeDiagnosticSampler?: (options?: { includeLinux?: boolean }) => RuntimeDiagnosticSample;
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
};

const DEFAULT_EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_EVENT_LOOP_FAIL_MS = 1_500;
const DEFAULT_EVENT_LOOP_FAIL_STREAK = 3;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_WATCHDOG_FAILURE_THRESHOLD = 3;
const DEFAULT_TOOL_CALL_OVERDUE_GRACE_MS = 15_000;
const DEFAULT_MAX_RSS_BYTES = 1_500 * 1024 * 1024;

function previewReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function impactOf(check: ToolServerHealthCheck): ToolServerHealthImpact {
  return check.impact ?? "live";
}

export function createToolServerHealthState(options: ToolServerHealthStateOptions) {
  const startedAt = Date.now();
  const watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  const watchdogFailureThreshold =
    options.watchdogFailureThreshold ?? DEFAULT_WATCHDOG_FAILURE_THRESHOLD;
  const eventLoopSampleIntervalMs =
    options.eventLoopSampleIntervalMs ?? DEFAULT_EVENT_LOOP_SAMPLE_INTERVAL_MS;
  const eventLoopLagFailMs = options.eventLoopLagFailMs ?? DEFAULT_EVENT_LOOP_FAIL_MS;
  const eventLoopLagFailStreak = options.eventLoopLagFailStreak ?? DEFAULT_EVENT_LOOP_FAIL_STREAK;
  const toolCallOverdueGraceMs =
    options.toolCallOverdueGraceMs ?? DEFAULT_TOOL_CALL_OVERDUE_GRACE_MS;
  const maxRssBytes = options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES;

  let initialized = false;
  let listening = false;
  let totalCalls = 0;
  let timedOutCalls = 0;
  let failedCalls = 0;
  let cancelledCalls = 0;
  let unhandledRejectionCount = 0;
  let lastUnhandledRejectionAt: number | null = null;
  let lastUnhandledRejectionReason: string | null = null;
  let lagTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lagHighStreak = 0;
  let lastEventLoopLagMs = 0;
  let activeLagIncident: ToolServerLagIncident | null = null;
  let lastLagIncident: ToolServerLagIncident | null = null;
  let unhealthyStreak = 0;
  let watchdogTriggered = false;
  let toolTokenSeq = 0;
  let expectedTickAt = performance.now() + eventLoopSampleIntervalMs;
  const activeCalls = new Map<string, ToolCallEntry>();
  const ownedRuntimeDiagnosticSampler = createRuntimeDiagnosticSampler();
  const sampleRuntimeDiagnostics =
    options.runtimeDiagnosticSampler ?? ownedRuntimeDiagnosticSampler.sample;

  function captureRuntimeDiagnostics(includeLinux: boolean): RuntimeDiagnosticSample | undefined {
    try {
      return sampleRuntimeDiagnostics({ includeLinux });
    } catch {
      return undefined;
    }
  }

  function captureActiveLevel1Work(): readonly ToolServerActiveLevel1Work[] {
    try {
      return (options.activeLevel1WorkProvider?.() ?? []).map((work) => ({
        requestId: work.requestId,
        requestClient: work.requestClient,
        runProfile: work.runProfile,
        phase: work.phase,
        runAgeMs: work.runAgeMs,
        tools: work.tools.map((tool) => ({
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          ageMs: tool.ageMs,
        })),
      }));
    } catch {
      return [];
    }
  }

  function createLagObservation(
    lagMs: number,
    runtime: RuntimeDiagnosticSample | undefined,
  ): ToolServerLagIncidentObservation {
    return {
      at: Date.now(),
      lagMs,
      streak: lagHighStreak,
      runtime,
      activeLevel1Work: captureActiveLevel1Work(),
    };
  }

  function recordEventLoopLagSample(lagMs: number) {
    lastEventLoopLagMs = lagMs;
    const high = lagMs >= eventLoopLagFailMs;
    lagHighStreak = high ? lagHighStreak + 1 : 0;

    const entering = high && lagHighStreak >= eventLoopLagFailStreak && !activeLagIncident;
    const recovering = !high && activeLagIncident !== null;
    const runtime = captureRuntimeDiagnostics(entering || recovering);

    if (entering) {
      const entry = createLagObservation(lagMs, runtime);
      activeLagIncident = {
        status: "active",
        enteredAt: entry.at,
        maxHighLagStreak: lagHighStreak,
        entry,
        peak: entry,
      };
      lastLagIncident = activeLagIncident;
      options.logger.warn("event loop lag degraded runtime", {
        incident: activeLagIncident,
      });
      return;
    }

    if (high && activeLagIncident) {
      const nextPeak =
        lagMs > activeLagIncident.peak.lagMs
          ? createLagObservation(lagMs, runtime)
          : activeLagIncident.peak;
      activeLagIncident = {
        ...activeLagIncident,
        maxHighLagStreak: Math.max(activeLagIncident.maxHighLagStreak, lagHighStreak),
        peak: nextPeak,
      };
      lastLagIncident = activeLagIncident;
      return;
    }

    if (recovering && activeLagIncident) {
      const recovery = createLagObservation(lagMs, runtime);
      const recovered: ToolServerLagIncident = {
        ...activeLagIncident,
        status: "recovered",
        recoveredAt: recovery.at,
        durationMs: recovery.at - activeLagIncident.enteredAt,
        recovery,
      };
      activeLagIncident = null;
      lastLagIncident = recovered;
      options.logger.info("event loop lag recovered", {
        incident: recovered,
      });
    }
  }

  function markInitialized(value: boolean) {
    initialized = value;
  }

  function markListening(value: boolean) {
    listening = value;
  }

  function recordUnhandledRejection(reason: unknown) {
    unhandledRejectionCount += 1;
    lastUnhandledRejectionAt = Date.now();
    lastUnhandledRejectionReason = previewReason(reason);
  }

  function beginToolCall(input: {
    toolId: string;
    callableId: string;
    deadlineAt: number;
    requestId?: string;
  }): string {
    const token = `tool:${++toolTokenSeq}`;
    totalCalls += 1;
    activeCalls.set(token, {
      token,
      toolId: input.toolId,
      callableId: input.callableId,
      startedAt: Date.now(),
      deadlineAt: input.deadlineAt,
      requestId: input.requestId,
    });
    return token;
  }

  function endToolCall(
    token: string,
    outcome: {
      settled?: boolean;
      timedOut?: boolean;
      failed?: boolean;
      cancelled?: boolean;
    },
  ) {
    if (outcome.timedOut) timedOutCalls += 1;
    if (outcome.failed) failedCalls += 1;
    if (outcome.cancelled) cancelledCalls += 1;
    if (outcome.settled !== false) {
      activeCalls.delete(token);
    }
  }

  async function getSnapshot(): Promise<ToolServerHealthSnapshot> {
    const now = Date.now();
    const memory = process.memoryUsage();
    const checks: ToolServerHealthCheck[] = [
      {
        name: "tool-server.initialized",
        ok: initialized,
        impact: "ready",
        reason: initialized ? undefined : "tool server has not finished initialization",
      },
      {
        name: "tool-server.listening",
        ok: listening,
        impact: "ready",
        reason: listening ? undefined : "tool server is not listening",
      },
      {
        name: "event-loop.lag",
        ok: lagHighStreak < eventLoopLagFailStreak,
        impact: "ready",
        reason:
          lagHighStreak < eventLoopLagFailStreak
            ? undefined
            : `event loop lag exceeded ${eventLoopLagFailMs}ms for ${lagHighStreak} consecutive samples`,
        details: {
          lastLagMs: lastEventLoopLagMs,
          thresholdMs: eventLoopLagFailMs,
          streak: lagHighStreak,
        },
      },
      {
        name: "process.memory",
        ok: memory.rss < maxRssBytes,
        impact: "live",
        reason:
          memory.rss >= maxRssBytes ? `rss ${memory.rss} exceeded limit ${maxRssBytes}` : undefined,
        details: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          maxRssBytes,
        },
      },
    ];

    const overdueCalls = [...activeCalls.values()].filter(
      (entry) => now > entry.deadlineAt + toolCallOverdueGraceMs,
    );
    checks.push({
      name: "tool-calls.overdue",
      ok: overdueCalls.length === 0,
      impact: "live",
      reason:
        overdueCalls.length === 0
          ? undefined
          : `${overdueCalls.length} tool call(s) exceeded deadline grace window`,
      details:
        overdueCalls.length === 0
          ? undefined
          : overdueCalls.map((entry) => ({
              callableId: entry.callableId,
              toolId: entry.toolId,
              overdueMs: now - entry.deadlineAt,
              requestId: entry.requestId,
            })),
    });

    const pluginStatuses = options.pluginManager?.getStatuses?.();
    if (pluginStatuses) {
      const failedPlugins = pluginStatuses.filter((status) => {
        if (!status || typeof status !== "object") return false;
        return (status as { state?: unknown }).state === "failed";
      });
      checks.push({
        name: "plugins.load",
        ok: failedPlugins.length === 0,
        impact: "ready",
        reason:
          failedPlugins.length === 0
            ? undefined
            : `${failedPlugins.length} plugin(s) failed to load`,
        details: failedPlugins,
      });
    }

    let externalInfo: Record<string, unknown> | undefined;
    if (options.externalHealthProvider) {
      try {
        const external = await options.externalHealthProvider();
        if (external.checks) checks.push(...external.checks);
        externalInfo = external.info;
      } catch (e) {
        checks.push({
          name: "health.external",
          ok: false,
          impact: "live",
          reason: previewReason(e),
        });
      }
    }

    const live = checks.filter((check) => impactOf(check) === "live").every((check) => check.ok);
    const ready = live && checks.every((check) => check.ok);

    return {
      ok: live,
      live,
      ready,
      startedAt,
      checks,
      info: {
        process: {
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
          eventLoopLagMs: lastEventLoopLagMs,
          highLagStreak: lagHighStreak,
          ...(lastLagIncident ? { lastLagIncident } : {}),
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
          },
        },
        toolServer: {
          initialized,
          listening,
          totalCalls,
          timedOutCalls,
          failedCalls,
          cancelledCalls,
          activeCalls: [...activeCalls.values()].map((entry) => ({
            token: entry.token,
            toolId: entry.toolId,
            callableId: entry.callableId,
            startedAt: entry.startedAt,
            deadlineAt: entry.deadlineAt,
            overdueMs: Math.max(0, now - entry.deadlineAt),
            requestId: entry.requestId,
          })),
          pluginStatuses,
        },
        ...(externalInfo ? { external: externalInfo } : {}),
        ...(lastUnhandledRejectionAt && lastUnhandledRejectionReason
          ? {
              unhandledRejection: {
                count: unhandledRejectionCount,
                lastAt: lastUnhandledRejectionAt,
                lastReason: lastUnhandledRejectionReason,
              },
            }
          : {}),
      },
    };
  }

  async function runWatchdog() {
    if (!options.onUnhealthy || watchdogTriggered) return;
    const snapshot = await getSnapshot();
    if (snapshot.live) {
      unhealthyStreak = 0;
      return;
    }
    unhealthyStreak += 1;
    if (unhealthyStreak < watchdogFailureThreshold) return;

    watchdogTriggered = true;
    options.logger.error("tool-server watchdog detected unhealthy runtime", {
      unhealthyStreak,
      checks: snapshot.checks.filter((check) => !check.ok),
    });
    await options.onUnhealthy(snapshot);
  }

  function startMonitoring() {
    if (!lagTimer) {
      if (!options.runtimeDiagnosticSampler) ownedRuntimeDiagnosticSampler.start();
      expectedTickAt = performance.now() + eventLoopSampleIntervalMs;
      lagTimer = setInterval(() => {
        const now = performance.now();
        const lagMs = Math.max(0, now - expectedTickAt);
        expectedTickAt = now + eventLoopSampleIntervalMs;
        recordEventLoopLagSample(lagMs);
      }, eventLoopSampleIntervalMs);
      lagTimer.unref?.();
    }

    if (!watchdogTimer && options.onUnhealthy) {
      watchdogTimer = setInterval(() => {
        void runWatchdog().catch((e) => {
          options.logger.error("tool-server watchdog failed", e);
        });
      }, watchdogIntervalMs);
      watchdogTimer.unref?.();
    }
  }

  function stopMonitoring() {
    if (!options.runtimeDiagnosticSampler) ownedRuntimeDiagnosticSampler.stop();
    if (lagTimer) {
      clearInterval(lagTimer);
      lagTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    unhealthyStreak = 0;
    watchdogTriggered = false;
    lagHighStreak = 0;
    lastEventLoopLagMs = 0;
    activeLagIncident = null;
    lastLagIncident = null;
  }

  return {
    markInitialized,
    markListening,
    recordUnhandledRejection,
    beginToolCall,
    endToolCall,
    recordEventLoopLagSample,
    getSnapshot,
    startMonitoring,
    stopMonitoring,
  };
}
