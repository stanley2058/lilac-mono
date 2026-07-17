import { readFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type PressureMetrics = {
  some?: {
    avg10: number;
    avg60: number;
    avg300: number;
    totalMicros: number;
  };
  full?: {
    avg10: number;
    avg60: number;
    avg300: number;
    totalMicros: number;
  };
};

export type LinuxRuntimeDiagnostics = {
  hostPressure?: {
    cpu?: PressureMetrics;
    io?: PressureMetrics;
    memory?: PressureMetrics;
  };
  cgroupV2?: {
    cpuMax?: string;
    cpuStat?: Record<string, number>;
    cpuPressure?: PressureMetrics;
    ioPressure?: PressureMetrics;
    memoryPressure?: PressureMetrics;
  };
};

export type RuntimeDiagnosticSample = {
  sampledAt: number;
  intervalMs: number;
  cpu: {
    userMicros: number;
    systemMicros: number;
    singleCorePercent: number;
  };
  eventLoop: {
    utilization: {
      supported: boolean;
      activeMs?: number;
      idleMs?: number;
      ratio?: number;
    };
    delayMs: {
      mean: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
  };
  resources: {
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
    minorPageFaults: number;
    majorPageFaults: number;
    fsReads: number;
    fsWrites: number;
  };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  linux?: LinuxRuntimeDiagnostics;
};

type PressureLine = NonNullable<PressureMetrics["some"]>;

const CGROUP_ROOT = "/sys/fs/cgroup";

function nonNegativeDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? value / 1_000_000 : 0;
}

function parsePressureLine(line: string): { kind: "some" | "full"; metrics: PressureLine } | null {
  const match =
    /^(some|full)\s+avg10=([0-9.]+)\s+avg60=([0-9.]+)\s+avg300=([0-9.]+)\s+total=(\d+)$/u.exec(
      line.trim(),
    );
  if (!match) return null;

  const kind = match[1];
  const avg10 = Number(match[2]);
  const avg60 = Number(match[3]);
  const avg300 = Number(match[4]);
  const totalMicros = Number(match[5]);
  if (
    (kind !== "some" && kind !== "full") ||
    !Number.isFinite(avg10) ||
    !Number.isFinite(avg60) ||
    !Number.isFinite(avg300) ||
    !Number.isSafeInteger(totalMicros)
  ) {
    return null;
  }

  return {
    kind,
    metrics: { avg10, avg60, avg300, totalMicros },
  };
}

export function parsePressureMetrics(input: string): PressureMetrics | undefined {
  const result: PressureMetrics = {};
  for (const line of input.split("\n")) {
    const parsed = parsePressureLine(line);
    if (!parsed) continue;
    result[parsed.kind] = parsed.metrics;
  }
  return result.some || result.full ? result : undefined;
}

function parseNumericStats(input: string): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  for (const line of input.split("\n")) {
    const [key, rawValue, ...rest] = line.trim().split(/\s+/u);
    if (!key || !rawValue || rest.length > 0) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readOptional(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return undefined;
  }
}

function readPressure(filePath: string): PressureMetrics | undefined {
  const raw = readOptional(filePath);
  return raw ? parsePressureMetrics(raw) : undefined;
}

function resolveCgroupV2Path(): string | undefined {
  const membership = readOptional("/proc/self/cgroup");
  if (!membership) return undefined;
  const unified = membership
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!unified?.startsWith("/")) return undefined;

  const resolved = path.resolve(CGROUP_ROOT, `.${unified}`);
  if (resolved !== CGROUP_ROOT && !resolved.startsWith(`${CGROUP_ROOT}${path.sep}`))
    return undefined;
  return resolved;
}

export function collectLinuxRuntimeDiagnostics(): LinuxRuntimeDiagnostics | undefined {
  if (process.platform !== "linux") return undefined;

  const hostPressure = {
    cpu: readPressure("/proc/pressure/cpu"),
    io: readPressure("/proc/pressure/io"),
    memory: readPressure("/proc/pressure/memory"),
  };

  const cgroupPath = resolveCgroupV2Path();
  const cpuStat = cgroupPath ? readOptional(path.join(cgroupPath, "cpu.stat")) : undefined;
  const cgroupV2 = cgroupPath
    ? {
        cpuMax: readOptional(path.join(cgroupPath, "cpu.max")),
        cpuStat: cpuStat ? parseNumericStats(cpuStat) : undefined,
        cpuPressure: readPressure(path.join(cgroupPath, "cpu.pressure")),
        ioPressure: readPressure(path.join(cgroupPath, "io.pressure")),
        memoryPressure: readPressure(path.join(cgroupPath, "memory.pressure")),
      }
    : undefined;

  const hasHostPressure = hostPressure.cpu || hostPressure.io || hostPressure.memory;
  const hasCgroup =
    cgroupV2 &&
    (cgroupV2.cpuMax ||
      cgroupV2.cpuStat ||
      cgroupV2.cpuPressure ||
      cgroupV2.ioPressure ||
      cgroupV2.memoryPressure);
  if (!hasHostPressure && !hasCgroup) return undefined;

  return {
    ...(hasHostPressure ? { hostPressure } : {}),
    ...(hasCgroup ? { cgroupV2 } : {}),
  };
}

export function createRuntimeDiagnosticSampler() {
  let previousSampleAt = performance.now();
  let previousCpu = process.cpuUsage();
  let previousResources = process.resourceUsage();
  let previousEventLoop = performance.eventLoopUtilization();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  return {
    start() {
      previousSampleAt = performance.now();
      previousCpu = process.cpuUsage();
      previousResources = process.resourceUsage();
      previousEventLoop = performance.eventLoopUtilization();
      eventLoopDelay.reset();
      eventLoopDelay.enable();
    },
    stop() {
      eventLoopDelay.disable();
    },
    sample(options: { includeLinux?: boolean } = {}): RuntimeDiagnosticSample {
      const sampledAt = Date.now();
      const now = performance.now();
      const intervalMs = Math.max(0, now - previousSampleAt);
      const currentCpu = process.cpuUsage();
      const currentResources = process.resourceUsage();
      const currentEventLoop = performance.eventLoopUtilization();
      const eventLoopDelta = performance.eventLoopUtilization(currentEventLoop, previousEventLoop);
      const memory = process.memoryUsage();

      const userMicros = nonNegativeDelta(currentCpu.user, previousCpu.user);
      const systemMicros = nonNegativeDelta(currentCpu.system, previousCpu.system);
      const cpuMicros = userMicros + systemMicros;
      const eventLoopUtilizationSupported = eventLoopDelta.active > 0 || eventLoopDelta.idle > 0;

      const sample: RuntimeDiagnosticSample = {
        sampledAt,
        intervalMs,
        cpu: {
          userMicros,
          systemMicros,
          singleCorePercent: intervalMs > 0 ? (cpuMicros / (intervalMs * 1000)) * 100 : 0,
        },
        eventLoop: {
          utilization: eventLoopUtilizationSupported
            ? {
                supported: true,
                activeMs: eventLoopDelta.active,
                idleMs: eventLoopDelta.idle,
                ratio: eventLoopDelta.utilization,
              }
            : { supported: false },
          delayMs: {
            mean: nanosecondsToMilliseconds(eventLoopDelay.mean),
            max: nanosecondsToMilliseconds(eventLoopDelay.max),
            p50: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
            p95: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
            p99: nanosecondsToMilliseconds(eventLoopDelay.percentile(99)),
          },
        },
        resources: {
          voluntaryContextSwitches: nonNegativeDelta(
            currentResources.voluntaryContextSwitches,
            previousResources.voluntaryContextSwitches,
          ),
          involuntaryContextSwitches: nonNegativeDelta(
            currentResources.involuntaryContextSwitches,
            previousResources.involuntaryContextSwitches,
          ),
          minorPageFaults: nonNegativeDelta(
            currentResources.minorPageFault,
            previousResources.minorPageFault,
          ),
          majorPageFaults: nonNegativeDelta(
            currentResources.majorPageFault,
            previousResources.majorPageFault,
          ),
          fsReads: nonNegativeDelta(currentResources.fsRead, previousResources.fsRead),
          fsWrites: nonNegativeDelta(currentResources.fsWrite, previousResources.fsWrite),
        },
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        ...(options.includeLinux ? { linux: collectLinuxRuntimeDiagnostics() } : {}),
      };

      eventLoopDelay.reset();
      previousSampleAt = now;
      previousCpu = currentCpu;
      previousResources = currentResources;
      previousEventLoop = currentEventLoop;
      return sample;
    },
  };
}
