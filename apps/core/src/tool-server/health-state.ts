import { captureError } from "../shared/error-capture";
import { Result } from "better-result";
import type { Logger } from "@stanley2058/simple-module-logger";
import type { ToolPluginStatus } from "@stanley2058/lilac-plugin-runtime";
import { formatTaggedErrorForLog, redactErrorTextForLog } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";
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
  memoryDiagnostics?: Record<string, unknown>;
};

export type ToolServerMemoryUsage = {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
};

export type ToolServerMemoryObservation = ToolServerMemoryUsage & {
  at: number;
};

export type ToolServerMemoryIncidentObservation = {
  at: number;
  streak: number;
  memory: ToolServerMemoryUsage;
  runtime?: RuntimeDiagnosticSample;
  activeLevel1Work: readonly ToolServerActiveLevel1Work[];
  components?: Record<string, unknown>;
};

export type ToolServerMemoryIncident = {
  status: "active" | "recovered";
  enteredAt: number;
  recoveredAt?: number;
  durationMs?: number;
  entry: ToolServerMemoryIncidentObservation;
  peak: ToolServerMemoryIncidentObservation;
  trigger?: ToolServerMemoryIncidentObservation;
  recovery?: ToolServerMemoryIncidentObservation;
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
      memory: ToolServerMemoryUsage;
      memoryHistory: readonly ToolServerMemoryObservation[];
      lastMemoryIncident?: ToolServerMemoryIncident;
      memoryDiagnostics?: Record<string, unknown>;
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
      pluginStatuses?: readonly ToolPluginStatus[];
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
  getStatuses?(): readonly ToolPluginStatus[];
};

export type ToolServerHealthConfig = {
  watchdogIntervalMs?: number;
  watchdogFailureThreshold?: number;
  eventLoopSampleIntervalMs?: number;
  eventLoopLagFailMs?: number;
  eventLoopLagFailStreak?: number;
  toolCallOverdueGraceMs?: number;
  maxRssBytes?: number;
  warnRssBytes?: number;
  maxMainIsolateBytes?: number;
};

type ToolServerHealthStateOptions = ToolServerHealthConfig & {
  logger: Logger;
  listeningProbe?: () => Promise<boolean>;
  pluginManager?: ToolPluginManagerLike;
  externalHealthProvider?: (options?: {
    includeMemoryDiagnostics?: boolean;
  }) => ToolServerHealthProviderResult | Promise<ToolServerHealthProviderResult>;
  activeLevel1WorkProvider?: () => readonly ToolServerActiveLevel1Work[];
  runtimeDiagnosticSampler?: (options?: { includeLinux?: boolean }) => RuntimeDiagnosticSample;
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  reportFatalDefect?: (defect: Panic | Error) => void;
};

const DEFAULT_EVENT_LOOP_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_EVENT_LOOP_FAIL_MS = 1_500;
const DEFAULT_EVENT_LOOP_FAIL_STREAK = 3;
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_WATCHDOG_FAILURE_THRESHOLD = 3;
const DEFAULT_TOOL_CALL_OVERDUE_GRACE_MS = 15_000;
// Worker isolates share this process, so RSS includes bursts that a restart cannot usefully bound.
// heapUsed and external exclude worker heaps, which makes them the restart signal for Core itself.
// The RSS ceiling still catches native leaks and runaway workers, which those counters cannot see.
const DEFAULT_MAX_MAIN_ISOLATE_BYTES = 768 * 1024 * 1024;
const DEFAULT_MAX_RSS_BYTES = 4_096 * 1024 * 1024;
const DEFAULT_WARN_RSS_BYTES = 1_500 * 1024 * 1024;
const MEMORY_HISTORY_SIZE = 60;

function previewReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  {
    const attempt = Result.try({
      try: () => {
        return JSON.stringify(reason);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      return String(reason);
    }
    return attempt.value;
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
  const warnRssBytes = options.warnRssBytes ?? DEFAULT_WARN_RSS_BYTES;
  const maxMainIsolateBytes = options.maxMainIsolateBytes ?? DEFAULT_MAX_MAIN_ISOLATE_BYTES;

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
  let activeMemoryIncident: ToolServerMemoryIncident | null = null;
  let lastMemoryIncident: ToolServerMemoryIncident | null = null;
  const memoryHistory: ToolServerMemoryObservation[] = [];
  const unhealthyStreaks = new Map<string, number>();
  let watchdogTriggered = false;
  let watchdogGeneration = 0;
  let watchdogInFlight: Promise<void> | null = null;
  let toolTokenSeq = 0;
  let expectedTickAt = performance.now() + eventLoopSampleIntervalMs;
  const activeCalls = new Map<string, ToolCallEntry>();
  const ownedRuntimeDiagnosticSampler = createRuntimeDiagnosticSampler();
  const sampleRuntimeDiagnostics =
    options.runtimeDiagnosticSampler ?? ownedRuntimeDiagnosticSampler.sample;

  function captureRuntimeDiagnostics(includeLinux: boolean): RuntimeDiagnosticSample | undefined {
    {
      const attempt = Result.try({
        try: () => {
          return sampleRuntimeDiagnostics({ includeLinux });
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        if (Panic.is(cause)) throw cause;
        return undefined;
      }
      return attempt.value;
    }
  }

  function captureActiveLevel1Work(): readonly ToolServerActiveLevel1Work[] {
    {
      const attempt = Result.try({
        try: () => {
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
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        if (Panic.is(cause)) throw cause;
        return [];
      }
      return attempt.value;
    }
  }

  function memoryUsageFromSnapshot(snapshot: ToolServerHealthSnapshot): ToolServerMemoryUsage {
    return snapshot.info.process.memory;
  }

  function createMemoryIncidentObservation(
    snapshot: ToolServerHealthSnapshot,
    streak: number,
    includeRuntime: boolean,
  ): ToolServerMemoryIncidentObservation {
    return {
      at: Date.now(),
      streak,
      memory: memoryUsageFromSnapshot(snapshot),
      ...(includeRuntime ? { runtime: captureRuntimeDiagnostics(true) } : {}),
      activeLevel1Work: captureActiveLevel1Work(),
      ...(snapshot.info.process.memoryDiagnostics
        ? { components: snapshot.info.process.memoryDiagnostics }
        : {}),
    };
  }

  function recordMemoryFailure(snapshot: ToolServerHealthSnapshot, streak: number): void {
    if (!activeMemoryIncident) {
      const entry = createMemoryIncidentObservation(snapshot, streak, true);
      activeMemoryIncident = {
        status: "active",
        enteredAt: entry.at,
        entry,
        peak: entry,
        ...(streak >= watchdogFailureThreshold ? { trigger: entry } : {}),
      };
      lastMemoryIncident = activeMemoryIncident;
      snapshot.info.process.lastMemoryIncident = activeMemoryIncident;
      options.logger.warn(
        streak > 0
          ? "process memory exceeded watchdog limit"
          : "process rss exceeded warning level",
        { incident: activeMemoryIncident },
      );
      return;
    }

    const current = createMemoryIncidentObservation(
      snapshot,
      streak,
      streak >= watchdogFailureThreshold,
    );
    const peak =
      current.memory.rss > activeMemoryIncident.peak.memory.rss
        ? current
        : activeMemoryIncident.peak;
    activeMemoryIncident = {
      ...activeMemoryIncident,
      peak,
      ...(streak >= watchdogFailureThreshold ? { trigger: current } : {}),
    };
    lastMemoryIncident = activeMemoryIncident;
    snapshot.info.process.lastMemoryIncident = activeMemoryIncident;
    if (streak === 1) {
      options.logger.warn("process memory exceeded watchdog limit", {
        incident: activeMemoryIncident,
      });
    }
  }

  function recordMemoryRecovery(snapshot: ToolServerHealthSnapshot): void {
    if (!activeMemoryIncident) return;
    const recovery = createMemoryIncidentObservation(snapshot, 0, true);
    const recovered: ToolServerMemoryIncident = {
      ...activeMemoryIncident,
      status: "recovered",
      recoveredAt: recovery.at,
      durationMs: recovery.at - activeMemoryIncident.enteredAt,
      recovery,
    };
    activeMemoryIncident = null;
    lastMemoryIncident = recovered;
    snapshot.info.process.lastMemoryIncident = recovered;
    options.logger.info("process memory watchdog recovered", { incident: recovered });
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

  function describeMemoryFailure(memory: ToolServerMemoryUsage): string | undefined {
    if (memory.rss >= maxRssBytes) return `rss ${memory.rss} exceeded limit ${maxRssBytes}`;
    const mainIsolateBytes = memory.heapUsed + memory.external;
    if (mainIsolateBytes < maxMainIsolateBytes) return undefined;
    return `main isolate memory ${mainIsolateBytes} exceeded limit ${maxMainIsolateBytes}`;
  }

  async function getSnapshot(): Promise<ToolServerHealthSnapshot> {
    const transportListening = listening && ((await options.listeningProbe?.()) ?? true);
    const now = Date.now();
    const memory = process.memoryUsage();
    const memoryUsage: ToolServerMemoryUsage = {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    };
    memoryHistory.push({ at: now, ...memoryUsage });
    if (memoryHistory.length > MEMORY_HISTORY_SIZE) memoryHistory.shift();
    const memoryFailureReason = describeMemoryFailure(memory);
    const memoryLimits = { maxRssBytes, warnRssBytes, maxMainIsolateBytes };
    const memoryCheck: ToolServerHealthCheck = {
      name: "process.memory",
      ok: memoryFailureReason === undefined,
      impact: "live",
      reason: memoryFailureReason,
      details: {
        ...memoryUsage,
        ...memoryLimits,
      },
    };
    const checks: ToolServerHealthCheck[] = [
      {
        name: "tool-server.initialized",
        ok: initialized,
        impact: "ready",
        reason: initialized ? undefined : "tool server has not finished initialization",
      },
      {
        name: "tool-server.listening",
        ok: transportListening,
        impact: "ready",
        reason: transportListening ? undefined : "tool server is not listening",
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
      memoryCheck,
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
      const failedPlugins = pluginStatuses.filter((status) => status.state === "failed");
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
    let memoryDiagnostics: Record<string, unknown> | undefined;
    if (options.externalHealthProvider) {
      {
        const attempt = await Result.tryPromise({
          try: async () => {
            const external = await options.externalHealthProvider!({
              includeMemoryDiagnostics:
                memoryFailureReason !== undefined || memory.rss >= warnRssBytes,
            });
            if (external.checks) checks.push(...external.checks);
            externalInfo = external.info;
            memoryDiagnostics = external.memoryDiagnostics;
          },
          catch: captureError,
        });

        if (attempt.isErr()) {
          const e = attempt.error.cause;
          if (Panic.is(e)) throw e;
          checks.push({
            name: "health.external",
            ok: false,
            impact: "live",
            reason: previewReason(e),
          });
        }
      }
    }
    if (memoryDiagnostics) {
      checks[3] = {
        name: "process.memory",
        ok: memoryFailureReason === undefined,
        impact: "live",
        reason: memoryFailureReason,
        details: { ...memoryUsage, ...memoryLimits, diagnostics: memoryDiagnostics },
      };
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
          memory: memoryUsage,
          memoryHistory: [...memoryHistory],
          ...(lastMemoryIncident ? { lastMemoryIncident } : {}),
          ...(memoryDiagnostics ? { memoryDiagnostics } : {}),
        },
        toolServer: {
          initialized,
          listening: transportListening,
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

  function updateUnhealthyStreaks(snapshot: ToolServerHealthSnapshot): {
    triggeringCheck?: string;
    triggeringStreak?: number;
  } {
    const liveChecks = new Map<string, boolean>();
    for (const check of snapshot.checks) {
      if (impactOf(check) !== "live") continue;
      liveChecks.set(check.name, (liveChecks.get(check.name) ?? true) && check.ok);
    }
    let triggeringCheck: string | undefined;
    let triggeringStreak: number | undefined;

    for (const [name, ok] of liveChecks) {
      if (ok) {
        unhealthyStreaks.delete(name);
        continue;
      }

      const streak = (unhealthyStreaks.get(name) ?? 0) + 1;
      unhealthyStreaks.set(name, streak);
      if (
        streak >= watchdogFailureThreshold &&
        (triggeringStreak === undefined || streak > triggeringStreak)
      ) {
        triggeringCheck = name;
        triggeringStreak = streak;
      }
    }

    for (const name of unhealthyStreaks.keys()) {
      if (!liveChecks.has(name)) unhealthyStreaks.delete(name);
    }

    return { triggeringCheck, triggeringStreak };
  }

  async function evaluateWatchdog(generation: number): Promise<void> {
    if (!options.onUnhealthy || watchdogTriggered) return;
    const snapshot = await getSnapshot();
    if (generation !== watchdogGeneration || watchdogTriggered) return;

    const memoryFailed =
      snapshot.checks.find((check) => check.name === "process.memory")?.ok === false;
    const { triggeringCheck, triggeringStreak } = updateUnhealthyStreaks(snapshot);
    const memoryStreak = unhealthyStreaks.get("process.memory") ?? 0;
    const memoryElevated = memoryFailed || snapshot.info.process.memory.rss >= warnRssBytes;
    if (memoryElevated) recordMemoryFailure(snapshot, memoryStreak);
    else recordMemoryRecovery(snapshot);

    if (!triggeringCheck || triggeringStreak === undefined) return;
    if (generation !== watchdogGeneration || watchdogTriggered) return;

    watchdogTriggered = true;
    options.logger.error("tool-server watchdog detected unhealthy runtime", {
      triggeringCheck,
      triggeringStreak,
      failedCheckStreaks: Object.fromEntries(unhealthyStreaks),
      checks: snapshot.checks.filter((check) => !check.ok),
      memoryIncident: snapshot.info.process.lastMemoryIncident,
    });
    await options.onUnhealthy(snapshot);
  }

  function runWatchdog(): Promise<void> {
    if (!options.onUnhealthy || watchdogTriggered) return Promise.resolve();
    if (watchdogInFlight) return watchdogInFlight;

    const generation = watchdogGeneration;
    const current = evaluateWatchdog(generation);
    const tracked = current.finally(() => {
      if (watchdogInFlight === tracked) watchdogInFlight = null;
    });
    watchdogInFlight = tracked;
    return tracked;
  }

  function reportWatchdogDefect(reason: Error): void {
    if (Panic.is(reason)) {
      options.logger.error("tool-server watchdog failed", formatTaggedErrorForLog(reason));
      signalWatchdogDefect(reason);
      return;
    }
    options.logger.error(`tool-server watchdog failed: ${redactErrorTextForLog(reason.message)}`);
    signalWatchdogDefect(reason);
  }

  function signalWatchdogDefect(defect: Panic | Error): void {
    if (options.reportFatalDefect) {
      options.reportFatalDefect(defect);
      return;
    }
    queueMicrotask(() => {
      throw defect;
    });
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
        void observeWatchdog();
      }, watchdogIntervalMs);
      watchdogTimer.unref?.();
    }

    async function observeWatchdog(): Promise<void> {
      const watched = await Result.tryPromise({
        try: runWatchdog,
        catch: captureError,
      });
      const failure = watched.match({ ok: () => null, err: ({ cause }) => cause });
      if (failure) reportWatchdogDefect(failure);
    }
  }

  function stopMonitoring() {
    watchdogGeneration += 1;
    watchdogInFlight = null;
    if (!options.runtimeDiagnosticSampler) ownedRuntimeDiagnosticSampler.stop();
    if (lagTimer) {
      clearInterval(lagTimer);
      lagTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    unhealthyStreaks.clear();
    watchdogTriggered = false;
    lagHighStreak = 0;
    lastEventLoopLagMs = 0;
    activeLagIncident = null;
    lastLagIncident = null;
    activeMemoryIncident = null;
    lastMemoryIncident = null;
    memoryHistory.length = 0;
  }

  return {
    markInitialized,
    markListening,
    recordUnhandledRejection,
    beginToolCall,
    endToolCall,
    recordEventLoopLagSample,
    getSnapshot,
    runWatchdog,
    startMonitoring,
    stopMonitoring,
  };
}
