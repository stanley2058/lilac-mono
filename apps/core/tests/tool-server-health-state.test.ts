import { describe, expect, it } from "bun:test";

import { createLogger } from "@stanley2058/lilac-utils";

import { createToolServerHealthState } from "../src/tool-server/health-state";
import {
  createRuntimeDiagnosticSampler,
  parsePressureMetrics,
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

  it("marks unavailable event-loop utilization instead of reporting misleading zeros", async () => {
    const sampler = createRuntimeDiagnosticSampler();
    sampler.start();
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
