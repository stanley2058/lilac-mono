import { z } from "zod";

export const DEFAULT_WORKER_WATCHDOG_INTERVAL_MS = 5_000;
export const DEFAULT_WORKER_WATCHDOG_FAILURE_THRESHOLD = 3;
export const DEFAULT_SEARCH_WORKER_MAX_ISOLATE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MATERIALIZER_WORKER_MAX_ISOLATE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SUMMARIZATION_WORKER_MAX_ISOLATE_BYTES = 768 * 1024 * 1024;

const nonNegativeNumberSchema = z.number().nonnegative();
const nonNegativeIntSchema = z.number().int().nonnegative();

export const workerMemoryUsageSchema = z.strictObject({
  rss: nonNegativeNumberSchema,
  heapUsed: nonNegativeNumberSchema,
  heapTotal: nonNegativeNumberSchema,
  external: nonNegativeNumberSchema,
  arrayBuffers: nonNegativeNumberSchema,
});

export type WorkerMemoryUsage = z.infer<typeof workerMemoryUsageSchema>;

export const workerMemorySampleMessageSchema = z.strictObject({
  type: z.literal("worker-memory"),
  at: nonNegativeIntSchema,
  memory: workerMemoryUsageSchema,
  limitBytes: nonNegativeNumberSchema,
  streak: nonNegativeIntSchema,
});

export type WorkerMemorySampleMessage = z.infer<typeof workerMemorySampleMessageSchema>;

export const workerMemoryWatchdogExceededMessageSchema = z.strictObject({
  type: z.literal("worker-watchdog-exceeded"),
  at: nonNegativeIntSchema,
  memory: workerMemoryUsageSchema,
  limitBytes: nonNegativeNumberSchema,
  streak: z.number().int().positive(),
  reason: z.string().min(1),
});

export type WorkerMemoryWatchdogExceededMessage = z.infer<
  typeof workerMemoryWatchdogExceededMessageSchema
>;

export type WorkerMemoryWatchdogEvent =
  | WorkerMemorySampleMessage
  | WorkerMemoryWatchdogExceededMessage;

export type WorkerMemoryDiagnostics = {
  status: "running" | "idle" | "stopped";
  restarts: number;
  limitBytes: number;
  lastRestartAt?: number;
  lastRestartReason?: string;
  lastMemory?: WorkerMemoryUsage;
  lastSampleAt?: number;
  streak?: number;
};

export type WorkerMemoryTracker = {
  recordSample(event: WorkerMemoryWatchdogEvent): void;
  recordRestart(reason: string, at?: number): void;
  clearSample(): void;
  snapshot(status: WorkerMemoryDiagnostics["status"]): WorkerMemoryDiagnostics;
};

export function createWorkerMemoryTracker(defaultLimitBytes: number): WorkerMemoryTracker {
  let restarts = 0;
  let limitBytes = defaultLimitBytes;
  let lastRestartAt: number | undefined;
  let lastRestartReason: string | undefined;
  let lastMemory: WorkerMemoryUsage | undefined;
  let lastSampleAt: number | undefined;
  let streak: number | undefined;

  return {
    recordSample(event) {
      lastMemory = event.memory;
      lastSampleAt = event.at;
      limitBytes = event.limitBytes;
      streak = event.streak;
    },
    recordRestart(reason, at = Date.now()) {
      restarts += 1;
      lastRestartAt = at;
      lastRestartReason = reason;
      lastMemory = undefined;
      lastSampleAt = undefined;
      streak = 0;
    },
    clearSample() {
      lastMemory = undefined;
      lastSampleAt = undefined;
      streak = 0;
    },
    snapshot(status) {
      return {
        status,
        restarts,
        limitBytes,
        ...(lastRestartAt !== undefined ? { lastRestartAt } : {}),
        ...(lastRestartReason !== undefined ? { lastRestartReason } : {}),
        ...(lastMemory !== undefined ? { lastMemory } : {}),
        ...(lastSampleAt !== undefined ? { lastSampleAt } : {}),
        ...(streak !== undefined ? { streak } : {}),
      };
    },
  };
}

export type WorkerMemoryWatchdogOptions = {
  workerName: string;
  maxIsolateBytes: number;
  intervalMs?: number;
  failureThreshold?: number;
  sampleMemory?: () => WorkerMemoryUsage;
  now?: () => number;
  emit: (event: WorkerMemoryWatchdogEvent) => void;
  onExceeded?: (event: WorkerMemoryWatchdogExceededMessage) => void;
};

function readIsolateMemoryUsage(): WorkerMemoryUsage {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

export function startWorkerMemoryWatchdog(options: WorkerMemoryWatchdogOptions): {
  sampleNow(): void;
  stop(): void;
} {
  const intervalMs = options.intervalMs ?? DEFAULT_WORKER_WATCHDOG_INTERVAL_MS;
  const failureThreshold = options.failureThreshold ?? DEFAULT_WORKER_WATCHDOG_FAILURE_THRESHOLD;
  const sampleMemory = options.sampleMemory ?? readIsolateMemoryUsage;
  const now = options.now ?? Date.now;

  let streak = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const sampleNow = () => {
    if (stopped) return;
    const at = now();
    const memory = sampleMemory();
    // In Bun/JSC, heapUsed (jsc.heapSize) is per-isolate and already includes external memory.
    const exceeded = memory.heapUsed >= options.maxIsolateBytes;
    streak = exceeded ? streak + 1 : 0;

    options.emit({
      type: "worker-memory",
      at,
      memory,
      limitBytes: options.maxIsolateBytes,
      streak,
    });

    if (streak < failureThreshold) return;
    stop();
    const event: WorkerMemoryWatchdogExceededMessage = {
      type: "worker-watchdog-exceeded",
      at,
      memory,
      limitBytes: options.maxIsolateBytes,
      streak,
      reason: `${options.workerName} isolate memory ${memory.heapUsed} exceeded limit ${options.maxIsolateBytes} for ${streak} consecutive samples`,
    };
    options.emit(event);
    options.onExceeded?.(event);
  };

  sampleNow();
  if (!stopped) {
    timer = setInterval(sampleNow, intervalMs);
    timer.unref?.();
  }

  return { sampleNow, stop };
}
