import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Panic } from "better-result";

import { createLogger } from "@stanley2058/lilac-utils";

import { createToolServerHealthState } from "../src/tool-server/health-state";
import {
  createRuntimeDiagnosticSampler,
  parseCgroupByteLimit,
  parseProcStatusMemory,
  parsePressureMetrics,
  parseSmapsRollupMemory,
  type RuntimeDiagnosticSample,
} from "../src/tool-server/runtime-diagnostics";
import { createToolServer } from "../src/tool-server/create-tool-server";

class MemoryWriteStream {
  readonly chunks: string[] = [];

  write(chunk: string): unknown {
    this.chunks.push(chunk);
    return true;
  }

  joined(): string {
    return this.chunks.join("");
  }
}

const RUNTIME_SAMPLE: RuntimeDiagnosticSample = {
  sampledAt: 1_000,
  intervalMs: 1_000,
  cpu: {
    userMicros: 20_000,
    systemMicros: 10_000,
    singleCorePercent: 3,
  },
  eventLoop: {
    utilization: {
      supported: true,
      activeMs: 30,
      idleMs: 970,
      ratio: 0.03,
    },
    delayMs: {
      mean: 2,
      max: 20,
      p50: 1,
      p95: 10,
      p99: 18,
    },
  },
  resources: {
    voluntaryContextSwitches: 4,
    involuntaryContextSwitches: 1,
    minorPageFaults: 2,
    majorPageFaults: 0,
    fsReads: 3,
    fsWrites: 1,
  },
  memory: {
    rss: 128 * 1024 * 1024,
    heapUsed: 32 * 1024 * 1024,
    heapTotal: 64 * 1024 * 1024,
    external: 1024,
    arrayBuffers: 512,
  },
};

describe("tool server health state", () => {
  it("tracks fatal streaks independently by check name", async () => {
    let failedCheck = "dependency.a";
    const unhealthySnapshots: unknown[] = [];
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      watchdogFailureThreshold: 2,
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      externalHealthProvider: () => ({
        checks: [{ name: failedCheck, ok: false, impact: "live" }],
      }),
      onUnhealthy: (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
    });

    await health.runWatchdog();
    failedCheck = "dependency.b";
    await health.runWatchdog();
    failedCheck = "dependency.a";
    await health.runWatchdog();
    expect(unhealthySnapshots).toEqual([]);

    await health.runWatchdog();
    expect(unhealthySnapshots).toHaveLength(1);
  });

  it("shares one in-flight watchdog evaluation", async () => {
    const provider = Promise.withResolvers<{ checks: [] }>();
    let providerCalls = 0;
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      externalHealthProvider: () => {
        providerCalls += 1;
        return provider.promise;
      },
      onUnhealthy: () => {},
    });

    const first = health.runWatchdog();
    const second = health.runWatchdog();
    expect(second).toBe(first);
    expect(providerCalls).toBe(1);
    provider.resolve({ checks: [] });
    await first;
  });

  it("invalidates a watchdog evaluation completed after monitoring stops", async () => {
    const provider = Promise.withResolvers<{
      checks: Array<{ name: string; ok: boolean; impact: "live" }>;
    }>();
    const unhealthySnapshots: unknown[] = [];
    let providerCalls = 0;
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      watchdogFailureThreshold: 1,
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      externalHealthProvider: () => {
        providerCalls += 1;
        if (providerCalls === 1) return provider.promise;
        return { checks: [{ name: "dependency", ok: false, impact: "live" as const }] };
      },
      onUnhealthy: (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
    });

    const evaluation = health.runWatchdog();
    health.stopMonitoring();
    await health.runWatchdog();
    expect(providerCalls).toBe(2);
    expect(unhealthySnapshots).toHaveLength(1);

    provider.resolve({ checks: [{ name: "dependency", ok: false, impact: "live" }] });
    await evaluation;
    expect(unhealthySnapshots).toHaveLength(1);
  });

  it("preserves Panic from external health providers", async () => {
    const panic = new Panic({ message: "health provider invariant" });
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      externalHealthProvider: () => {
        throw panic;
      },
      onUnhealthy: () => {},
    });

    await expect(health.runWatchdog()).rejects.toBe(panic);
  });

  it("records bounded memory history and component diagnostics", async () => {
    const unhealthySnapshots: unknown[] = [];
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      watchdogFailureThreshold: 2,
      maxRssBytes: 0,
      runtimeDiagnosticSampler: () => RUNTIME_SAMPLE,
      externalHealthProvider: () => ({
        memoryDiagnostics: { discord: { members: 12 }, openObserve: { retainedBytes: 34 } },
      }),
      onUnhealthy: (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
    });

    for (let index = 0; index < 65; index += 1) await health.getSnapshot();
    await health.runWatchdog();
    await health.runWatchdog();

    expect(unhealthySnapshots).toHaveLength(1);
    const snapshot = unhealthySnapshots[0] as Awaited<ReturnType<typeof health.getSnapshot>>;
    expect(snapshot.info.process.memoryHistory).toHaveLength(60);
    expect(snapshot.info.process.memory.external).toBeNumber();
    expect(snapshot.info.process.memory.arrayBuffers).toBeNumber();
    expect(snapshot.info.process.lastMemoryIncident?.trigger).toMatchObject({
      streak: 2,
      components: {
        discord: { members: 12 },
        openObserve: { retainedBytes: 34 },
      },
    });
  });

  it("records the entry as the trigger when the memory threshold is one", async () => {
    let unhealthySnapshot:
      | Awaited<ReturnType<ReturnType<typeof createToolServerHealthState>["getSnapshot"]>>
      | undefined;
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      watchdogFailureThreshold: 1,
      maxRssBytes: 0,
      runtimeDiagnosticSampler: () => RUNTIME_SAMPLE,
      onUnhealthy: (snapshot) => {
        unhealthySnapshot = snapshot;
      },
    });

    await health.runWatchdog();
    expect(unhealthySnapshot?.info.process.lastMemoryIncident?.trigger).toMatchObject({
      streak: 1,
    });
  });

  describe("memory limits", () => {
    const MiB = 1024 * 1024;
    const originalMemoryUsage = process.memoryUsage;
    afterEach(() => {
      process.memoryUsage = originalMemoryUsage;
    });

    function setMemory(input: { rss: number; heapUsed: number; external: number }) {
      const memory = {
        rss: input.rss * MiB,
        heapUsed: input.heapUsed * MiB,
        heapTotal: input.heapUsed * MiB,
        external: input.external * MiB,
        arrayBuffers: 0,
      };
      process.memoryUsage = Object.assign(() => memory, { rss: () => memory.rss });
    }

    function createWatchedHealth() {
      const logger = createLogger({ module: "health-state-test" });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      const onUnhealthy = mock(() => undefined);
      const health = createToolServerHealthState({
        logger,
        watchdogFailureThreshold: 2,
        runtimeDiagnosticSampler: () => RUNTIME_SAMPLE,
        onUnhealthy,
      });
      const warnings = () => warn.mock.calls.map(([message]) => message);
      return { health, onUnhealthy, warnings };
    }

    async function memoryCheck(health: ReturnType<typeof createToolServerHealthState>) {
      const snapshot = await health.getSnapshot();
      return snapshot.checks.find((check) => check.name === "process.memory");
    }

    it("stays healthy at the largest usage recorded in production incidents", async () => {
      const { health, onUnhealthy } = createWatchedHealth();
      // 2026-11-09 summarization burst, then the 2026-11-06 main heap peak.
      for (const memory of [
        { rss: 1534, heapUsed: 169, external: 34 },
        { rss: 1763, heapUsed: 243, external: 20 },
        { rss: 1662, heapUsed: 603, external: 88 },
      ]) {
        setMemory(memory);
        expect((await memoryCheck(health))?.ok).toBe(true);
        await health.runWatchdog();
        await health.runWatchdog();
      }
      expect(onUnhealthy).not.toHaveBeenCalled();
    });

    it("warns without restarting while only rss is elevated, then recovers", async () => {
      const { health, onUnhealthy, warnings } = createWatchedHealth();
      setMemory({ rss: 1600, heapUsed: 170, external: 40 });
      await health.runWatchdog();
      await health.runWatchdog();
      await health.runWatchdog();

      expect(onUnhealthy).not.toHaveBeenCalled();
      expect(warnings()).toEqual(["process rss exceeded warning level"]);
      const active = await health.getSnapshot();
      expect(active.info.process.lastMemoryIncident?.status).toBe("active");

      setMemory({ rss: 900, heapUsed: 170, external: 40 });
      await health.runWatchdog();
      const recovered = await health.getSnapshot();
      expect(recovered.info.process.lastMemoryIncident?.status).toBe("recovered");
    });

    it("restarts when the main isolate exceeds its limit with low rss", async () => {
      const { health, onUnhealthy, warnings } = createWatchedHealth();
      setMemory({ rss: 1000, heapUsed: 700, external: 68 });

      expect(await memoryCheck(health)).toMatchObject({
        ok: false,
        reason: `main isolate memory ${768 * MiB} exceeded limit ${768 * MiB}`,
      });
      await health.runWatchdog();
      expect(onUnhealthy).not.toHaveBeenCalled();
      await health.runWatchdog();
      expect(onUnhealthy).toHaveBeenCalledTimes(1);
      expect(warnings()).toEqual(["process memory exceeded watchdog limit"]);
    });

    it("restarts at the rss ceiling even when the main isolate is small", async () => {
      const { health, onUnhealthy } = createWatchedHealth();
      setMemory({ rss: 4096, heapUsed: 170, external: 40 });

      expect(await memoryCheck(health)).toMatchObject({
        ok: false,
        reason: `rss ${4096 * MiB} exceeded limit ${4096 * MiB}`,
      });
      await health.runWatchdog();
      await health.runWatchdog();
      expect(onUnhealthy).toHaveBeenCalledTimes(1);
    });

    it("logs the limit when an rss warning escalates into a failure", async () => {
      const { health, onUnhealthy, warnings } = createWatchedHealth();
      setMemory({ rss: 1600, heapUsed: 170, external: 40 });
      await health.runWatchdog();
      setMemory({ rss: 1600, heapUsed: 800, external: 40 });
      await health.runWatchdog();
      await health.runWatchdog();

      expect(warnings()).toEqual([
        "process rss exceeded warning level",
        "process memory exceeded watchdog limit",
      ]);
      expect(onUnhealthy).toHaveBeenCalledTimes(1);
    });
  });

  it("treats sustained event-loop lag as non-fatal readiness degradation", async () => {
    const unhealthySnapshots: unknown[] = [];
    const server = createToolServer({
      tools: [],
      onUnhealthy: (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
      healthConfig: {
        eventLoopSampleIntervalMs: 2,
        eventLoopLagFailMs: 0,
        eventLoopLagFailStreak: 1,
        watchdogIntervalMs: 2,
        watchdogFailureThreshold: 1,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    await server.init();
    await server.start(0);
    // test-wait-justification: allows real event-loop and watchdog samples to produce readiness degradation
    await Bun.sleep(25);

    const healthResponse = await server.app.handle(new Request("http://localhost/healthz"));
    const health = (await healthResponse.json()) as {
      live: boolean;
      ready: boolean;
      checks: Array<{ name: string; ok: boolean; impact?: string }>;
    };
    expect(healthResponse.status).toBe(200);
    expect(health.live).toBe(true);
    expect(health.ready).toBe(false);
    expect(health.checks.find((check) => check.name === "event-loop.lag")).toMatchObject({
      ok: false,
      impact: "ready",
    });

    const readyResponse = await server.app.handle(new Request("http://localhost/readyz"));
    expect(readyResponse.status).toBe(503);
    expect(unhealthySnapshots).toEqual([]);

    await server.stop();
  });

  it("retains one redacted lag incident and logs entry and recovery once", async () => {
    const output = new MemoryWriteStream();
    const unsafeWork = {
      requestId: "request-1",
      requestClient: "discord",
      runProfile: "primary",
      phase: "tool" as const,
      runAgeMs: 5_000,
      secretPrompt: "do not expose",
      tools: [
        {
          toolCallId: "tool-1",
          toolName: "bash",
          ageMs: 2_000,
          args: "secret command",
        },
      ],
    };
    const health = createToolServerHealthState({
      logger: createLogger({
        module: "health-state-test",
        logLevel: "info",
        stdout: output,
        stderr: output,
      }),
      eventLoopLagFailMs: 100,
      eventLoopLagFailStreak: 3,
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      activeLevel1WorkProvider: () => [unsafeWork],
      runtimeDiagnosticSampler: () => RUNTIME_SAMPLE,
    });
    health.markInitialized(true);
    health.markListening(true);

    health.recordEventLoopLagSample(100);
    health.recordEventLoopLagSample(150);
    expect((await health.getSnapshot()).ready).toBe(true);

    health.recordEventLoopLagSample(200);
    health.recordEventLoopLagSample(350);
    health.recordEventLoopLagSample(250);
    const degraded = await health.getSnapshot();
    expect(degraded.live).toBe(true);
    expect(degraded.ready).toBe(false);
    expect(degraded.info.process.lastLagIncident).toMatchObject({
      status: "active",
      maxHighLagStreak: 5,
      entry: {
        lagMs: 200,
        streak: 3,
      },
      peak: {
        lagMs: 350,
        streak: 4,
        activeLevel1Work: [
          {
            requestId: "request-1",
            tools: [{ toolCallId: "tool-1", toolName: "bash", ageMs: 2_000 }],
          },
        ],
      },
    });

    health.recordEventLoopLagSample(10);
    health.recordEventLoopLagSample(5);
    const recovered = await health.getSnapshot();
    expect(recovered.ready).toBe(true);
    expect(recovered.info.process.lastLagIncident).toMatchObject({
      status: "recovered",
      maxHighLagStreak: 5,
      recovery: {
        lagMs: 10,
        streak: 0,
      },
    });
    expect(JSON.stringify(recovered.info.process.lastLagIncident)).not.toContain("secret");

    const logs = output.joined();
    expect(logs.match(/event loop lag degraded runtime/gu)).toHaveLength(1);
    expect(logs.match(/event loop lag recovered/gu)).toHaveLength(1);
  });

  it("keeps diagnostic provider failures out of health semantics", async () => {
    const health = createToolServerHealthState({
      logger: createLogger({ module: "health-state-test" }),
      eventLoopLagFailMs: 100,
      eventLoopLagFailStreak: 1,
      maxRssBytes: Number.MAX_SAFE_INTEGER,
      activeLevel1WorkProvider: () => {
        throw new Error("active work unavailable");
      },
      runtimeDiagnosticSampler: () => {
        throw new Error("diagnostics unavailable");
      },
    });
    health.markInitialized(true);
    health.markListening(true);
    health.recordEventLoopLagSample(100);

    const snapshot = await health.getSnapshot();
    expect(snapshot.live).toBe(true);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.info.process.lastLagIncident?.entry.runtime).toBeUndefined();
    expect(snapshot.info.process.lastLagIncident?.entry.activeLevel1Work).toEqual([]);
  });

  it("parses Linux pressure metrics used in incident diagnostics", () => {
    expect(
      parsePressureMetrics(
        "some avg10=35.15 avg60=10.20 avg300=4.00 total=123456\nfull avg10=30.27 avg60=8.00 avg300=2.00 total=654321\n",
      ),
    ).toEqual({
      some: { avg10: 35.15, avg60: 10.2, avg300: 4, totalMicros: 123456 },
      full: { avg10: 30.27, avg60: 8, avg300: 2, totalMicros: 654321 },
    });
  });

  it("parses Linux process and cgroup memory diagnostics", () => {
    expect(parseCgroupByteLimit("max")).toBe("max");
    expect(parseCgroupByteLimit("4096")).toBe(4096);
    expect(parseCgroupByteLimit("invalid")).toBeUndefined();
    expect(
      parseProcStatusMemory(
        "VmRSS:\t100 kB\nRssAnon:\t40 kB\nRssFile:\t50 kB\nRssShmem:\t10 kB\nVmSwap:\t2 kB\nThreads:\t7\n",
      ),
    ).toEqual({
      vmRssBytes: 102_400,
      rssAnonBytes: 40_960,
      rssFileBytes: 51_200,
      rssShmemBytes: 10_240,
      vmSwapBytes: 2_048,
      threads: 7,
    });
    expect(
      parseSmapsRollupMemory(
        "Pss: 90 kB\nPrivate_Clean: 3 kB\nPrivate_Dirty: 70 kB\nShared_Clean: 4 kB\nShared_Dirty: 5 kB\nAnonymous: 60 kB\nSwap: 1 kB\n",
      ),
    ).toEqual({
      pssBytes: 92_160,
      privateCleanBytes: 3_072,
      privateDirtyBytes: 71_680,
      sharedCleanBytes: 4_096,
      sharedDirtyBytes: 5_120,
      anonymousBytes: 61_440,
      swapBytes: 1_024,
    });
  });

  it("preserves the optional pressure kind output shape", () => {
    expect(parsePressureMetrics("some avg10=1 avg60=2 avg300=3 total=4")).toEqual({
      some: { avg10: 1, avg60: 2, avg300: 3, totalMicros: 4 },
    });
    expect(parsePressureMetrics("full avg10=5 avg60=6 avg300=7 total=8")).toEqual({
      full: { avg10: 5, avg60: 6, avg300: 7, totalMicros: 8 },
    });
    expect(parsePressureMetrics("not pressure metrics")).toBeUndefined();
  });

  it("marks unavailable event-loop utilization instead of reporting misleading zeros", async () => {
    const sampler = createRuntimeDiagnosticSampler();
    sampler.start();
    // test-wait-justification: allows the runtime sampler to collect a real event-loop delay and utilization interval
    await Bun.sleep(25);
    const sample = sampler.sample();
    sampler.stop();

    expect(Number.isFinite(sample.eventLoop.delayMs.max)).toBe(true);
    if (sample.eventLoop.utilization.supported) {
      expect(Number.isFinite(sample.eventLoop.utilization.ratio)).toBe(true);
    } else {
      expect(sample.eventLoop.utilization).toEqual({ supported: false });
    }
  });
});
