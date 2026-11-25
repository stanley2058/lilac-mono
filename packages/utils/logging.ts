import { Buffer } from "node:buffer";

import {
  Logger,
  type ITimer,
  type LogLevel,
  type LoggerOptions,
  type TimerOptions,
  type WriteStream,
} from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { captureResultOutcome, isPanic, isRecord, settleSyncResult } from "./runtime-utils";
import {
  isTelemetryErrorCaptureActive,
  observeTelemetryLog,
  type TelemetryLogFields,
  type TelemetryLogLevel,
  type TelemetryPrimitive,
} from "./telemetry";

function hasTestGlobals(): boolean {
  return "describe" in globalThis && "it" in globalThis;
}

export function isTestEnv(): boolean {
  const env = process.env;

  // Common conventions across runners (Bun/Jest/Vitest).
  if (env.NODE_ENV === "test") return true;
  if (env.BUN_ENV === "test") return true;
  if (env.BUN_TEST === "1" || env.BUN_TEST === "true") return true;
  if (typeof env.VITEST === "string") return true;
  if (typeof env.JEST_WORKER_ID === "string") return true;

  // Fallback: Bun's test runner installs `describe`/`it` globals.
  return hasTestGlobals();
}

export function resolveLogLevel(override?: LogLevel): LogLevel {
  if (override) return override;
  if (isTestEnv()) return "error";
  const fromEnv = process.env.LOG_LEVEL as LogLevel | undefined;
  return fromEnv ?? "info";
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
      return normalized;
    default:
      return undefined;
  }
}

function resolveOutputFormat(override?: "text" | "jsonl"): "text" | "jsonl" {
  if (override) return override;
  return parseBoolean(process.env.LILAC_LOG_JSONL) ? "jsonl" : "text";
}

function resolveJsonlSplitStreams(override?: boolean): boolean | undefined {
  if (override !== undefined) return override;
  return parseBoolean(process.env.LILAC_LOG_JSONL_SPLIT_STREAMS) ? true : undefined;
}

type OpenObserveConfig = {
  endpoint: string;
  authorizationHeader?: string;
};

type ExtendedLoggerOptions = LoggerOptions & {
  outputFormat?: "text" | "jsonl";
  jsonlSplitStreams?: boolean;
};

function resolveOpenObserveConfig(): OpenObserveConfig | null {
  const baseUrl = process.env.LILAC_LOG_OPENOBSERVE_BASE_URL?.trim();
  if (!baseUrl) return null;

  const org = process.env.LILAC_LOG_OPENOBSERVE_ORG?.trim() || "default";
  const stream = process.env.LILAC_LOG_OPENOBSERVE_STREAM?.trim() || "lilac";

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL(
    `api/${encodeURIComponent(org)}/${encodeURIComponent(stream)}/_json`,
    normalizedBaseUrl,
  ).toString();

  const bearerToken = process.env.LILAC_LOG_OPENOBSERVE_BEARER_TOKEN?.trim();
  if (bearerToken) {
    return {
      endpoint,
      authorizationHeader: `Bearer ${bearerToken}`,
    };
  }

  const username = process.env.LILAC_LOG_OPENOBSERVE_USERNAME?.trim();
  const password = process.env.LILAC_LOG_OPENOBSERVE_PASSWORD;
  if (username && password) {
    const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return {
      endpoint,
      authorizationHeader: `Basic ${basic}`,
    };
  }

  return { endpoint };
}

function resolveOpenObserveLogLevel(fallback: LogLevel): LogLevel {
  const fromEnv = parseLogLevel(process.env.LILAC_LOG_OPENOBSERVE_LEVEL);
  return fromEnv ?? fallback;
}

const MAX_OBJECT_FIELDS_PER_ARG = 40;
const MAX_RETAINED_RECORDS = 2_000;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_BATCH_RECORDS = 200;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = MAX_RETAINED_BYTES - MAX_BATCH_BYTES;
const OPEN_OBSERVE_REQUEST_TIMEOUT_MS = 5_000;
const OPEN_OBSERVE_DIAGNOSTIC_INTERVAL_MS = 30_000;
let openObserveOutcomeSequence = 0;

type OpenObserveFieldValue = string | number | boolean | null;
type OpenObserveRecord = Record<string, OpenObserveFieldValue>;
type SerializedOpenObserveRecord = {
  readonly json: string;
  readonly bytes: number;
};

type OpenObserveFailureKind = "timeout" | "request" | "http";

class OpenObserveTimeout extends TaggedError("OpenObserveTimeout")<{
  readonly message: string;
}> {}

class OpenObserveRequestFailed extends TaggedError("OpenObserveRequestFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class OpenObserveHttpFailed extends TaggedError("OpenObserveHttpFailed")<{
  readonly status: number;
  readonly message: string;
}> {}

type OpenObserveDeliveryFailure =
  | OpenObserveTimeout
  | OpenObserveRequestFailed
  | OpenObserveHttpFailed;

type CapturedOpenObservePanic = { readonly kind: "panic"; readonly panic: Panic };
type CapturedOpenObserveRequestFailure =
  | CapturedOpenObservePanic
  | { readonly kind: "request"; readonly error: OpenObserveRequestFailed };

function captureOpenObservePanic(restoreCause: () => unknown): CapturedOpenObservePanic {
  const cause = restoreCause();
  const panic = Result.try({
    try: () => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  return {
    kind: "panic",
    panic:
      panic ?? new Panic({ cause, message: "OpenObserve operation failed with an opaque defect" }),
  };
}

function captureOpenObserveRequestFailure(
  restoreCause: () => unknown,
): CapturedOpenObserveRequestFailure {
  const cause = restoreCause();
  const panic = Result.try({
    try: () => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  return panic
    ? { kind: "panic", panic }
    : {
        kind: "request",
        error: new OpenObserveRequestFailed({ cause, message: "OpenObserve request failed" }),
      };
}

function signalOpenObservePanic(cause: unknown): void {
  const panic = isPanic(cause)
    ? cause
    : new Panic({ cause, message: "OpenObserve flush rejected with an opaque defect" });
  queueMicrotask(() => {
    throw panic;
  });
}

export type OpenObserveAggregateDiagnostics = {
  readonly streamCount: number;
  readonly retainedRecords: number;
  readonly retainedBytes: number;
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly activeRecords: number;
  readonly activeBytes: number;
  readonly inFlightRequests: number;
  readonly droppedRecords: number;
  readonly droppedBytes: number;
  readonly oversizeDroppedRecords: number;
  readonly overflowDroppedRecords: number;
  readonly succeededBatches: number;
  readonly failedBatches: number;
  readonly timeoutFailures: number;
  readonly requestFailures: number;
  readonly httpFailures: number;
  readonly lastSuccessAtMs: number | null;
  readonly lastFailureAtMs: number | null;
  readonly lastFailureKind: OpenObserveFailureKind | null;
  readonly lastHttpStatus: number | null;
};

type OpenObserveDiagnosticValues = Omit<OpenObserveAggregateDiagnostics, "streamCount">;
type OpenObserveStreamDiagnostics = OpenObserveDiagnosticValues & {
  readonly lastSuccessSequence: number;
  readonly lastFailureSequence: number;
};
type MutableOpenObserveAggregateDiagnostics = {
  -readonly [Key in keyof OpenObserveAggregateDiagnostics]: OpenObserveAggregateDiagnostics[Key];
};

function emptyOpenObserveDiagnostics(): OpenObserveDiagnosticValues {
  return {
    retainedRecords: 0,
    retainedBytes: 0,
    pendingRecords: 0,
    pendingBytes: 0,
    activeRecords: 0,
    activeBytes: 0,
    inFlightRequests: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    oversizeDroppedRecords: 0,
    overflowDroppedRecords: 0,
    succeededBatches: 0,
    failedBatches: 0,
    timeoutFailures: 0,
    requestFailures: 0,
    httpFailures: 0,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastFailureKind: null,
    lastHttpStatus: null,
  };
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sanitizeFieldSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? sanitized : "field";
}

function safeJsonStringify(value: unknown): string {
  const captured = Result.try({
    try: () => JSON.stringify(value) ?? "[unsupported]",
    catch: (cause) => ({ cause }),
  });
  const outcome = captureResultOutcome(captured);
  if (!outcome.ok && isPanic(outcome.error.cause)) throw outcome.error.cause;
  return outcome.ok ? outcome.value : "[unserializable]";
}

function addNormalizedArgFields(target: OpenObserveRecord, index: number, value: unknown): void {
  const prefix = `arg${index}`;

  if (isPrimitive(value)) {
    target[prefix] = value;
    return;
  }

  if (Array.isArray(value)) {
    target[`${prefix}Type`] = "array";
    target[`${prefix}Json`] = safeJsonStringify(value);
    return;
  }

  if (isRecord(value)) {
    target[`${prefix}Type`] = "object";

    let fieldCount = 0;
    for (const [key, nestedValue] of Object.entries(value)) {
      if (fieldCount >= MAX_OBJECT_FIELDS_PER_ARG) {
        target[`${prefix}_truncated`] = true;
        break;
      }

      const fieldName = `${prefix}_${sanitizeFieldSegment(key)}`;
      target[fieldName] = isPrimitive(nestedValue) ? nestedValue : safeJsonStringify(nestedValue);
      fieldCount += 1;
    }

    return;
  }

  if (typeof value === "bigint") {
    target[prefix] = value.toString();
    return;
  }

  target[prefix] = "[unsupported]";
}

function normalizeRecordForOpenObserve(record: unknown): OpenObserveRecord | null {
  if (!isRecord(record)) return null;

  const normalized: OpenObserveRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "args") continue;
    normalized[key] = isPrimitive(value) ? value : safeJsonStringify(value);
  }
  const args = record["args"];
  if (!Array.isArray(args)) {
    return normalized;
  }

  normalized.argsCount = args.length;
  delete normalized.args;

  for (const [index, value] of args.entries()) {
    addNormalizedArgFields(normalized, index, value);
  }

  return normalized;
}

class OpenObserveJsonlStream implements WriteStream {
  private readonly queue: SerializedOpenObserveRecord[] = [];
  private activeBatch: readonly SerializedOpenObserveRecord[] = [];
  private pendingBytes = 0;
  private activeBytes = 0;
  private flushScheduled = false;
  private flushing = false;
  private droppedRecords = 0;
  private droppedBytes = 0;
  private oversizeDroppedRecords = 0;
  private overflowDroppedRecords = 0;
  private succeededBatches = 0;
  private failedBatches = 0;
  private timeoutFailures = 0;
  private requestFailures = 0;
  private httpFailures = 0;
  private lastSuccessAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private lastFailureKind: OpenObserveFailureKind | null = null;
  private lastHttpStatus: number | null = null;
  private lastSuccessSequence = 0;
  private lastFailureSequence = 0;

  constructor(private readonly config: OpenObserveConfig) {}

  write(chunk: string): unknown {
    const lines = chunk.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const outcome = settleSyncResult(() => {
        const parsed = JSON.parse(line) as unknown;
        const normalized = normalizeRecordForOpenObserve(parsed);
        if (normalized) {
          const json = JSON.stringify(normalized);
          const bytes = Buffer.byteLength(json, "utf8");
          this.enqueue({ json, bytes });
        }
      });
      if (outcome.kind === "panic") throw outcome.panic;
    }

    this.scheduleFlush();
    return true;
  }

  diagnostics(): OpenObserveStreamDiagnostics {
    return {
      retainedRecords: this.activeBatch.length + this.queue.length,
      retainedBytes: this.activeBytes + this.pendingBytes,
      pendingRecords: this.queue.length,
      pendingBytes: this.pendingBytes,
      activeRecords: this.activeBatch.length,
      activeBytes: this.activeBytes,
      inFlightRequests: this.activeBatch.length > 0 ? 1 : 0,
      droppedRecords: this.droppedRecords,
      droppedBytes: this.droppedBytes,
      oversizeDroppedRecords: this.oversizeDroppedRecords,
      overflowDroppedRecords: this.overflowDroppedRecords,
      succeededBatches: this.succeededBatches,
      failedBatches: this.failedBatches,
      timeoutFailures: this.timeoutFailures,
      requestFailures: this.requestFailures,
      httpFailures: this.httpFailures,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
      lastFailureKind: this.lastFailureKind,
      lastHttpStatus: this.lastHttpStatus,
      lastSuccessSequence: this.lastSuccessSequence,
      lastFailureSequence: this.lastFailureSequence,
    };
  }

  private enqueue(record: SerializedOpenObserveRecord): void {
    if (record.bytes > MAX_RECORD_BYTES) {
      this.recordDrop(record, "oversize");
      return;
    }

    this.queue.push(record);
    this.pendingBytes += record.bytes;

    while (
      this.activeBatch.length + this.queue.length > MAX_RETAINED_RECORDS ||
      this.pendingBytes > MAX_PENDING_BYTES ||
      this.activeBytes + this.pendingBytes > MAX_RETAINED_BYTES
    ) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.pendingBytes -= evicted.bytes;
      this.recordDrop(evicted, "overflow");
    }
  }

  private recordDrop(record: SerializedOpenObserveRecord, reason: "oversize" | "overflow"): void {
    this.droppedRecords += 1;
    this.droppedBytes += record.bytes;
    if (reason === "oversize") {
      this.oversizeDroppedRecords += 1;
    } else {
      this.overflowDroppedRecords += 1;
    }
    reportOpenObserveDiagnostics();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    const flushed = await Result.tryPromise({
      try: async () => {
        while (this.queue.length > 0) {
          const batch = this.takeBatch();
          const result = captureResultOutcome(await this.postBatch(batch.body));
          if (result.ok) {
            this.succeededBatches += 1;
            this.lastSuccessAtMs = Date.now();
            this.lastSuccessSequence = ++openObserveOutcomeSequence;
          } else {
            this.recordFailure(result.error);
            reportOpenObserveDiagnostics();
          }
          this.activeBatch = [];
          this.activeBytes = 0;
        }
      },
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    this.activeBatch = [];
    this.activeBytes = 0;
    this.flushing = false;
    if (this.activeBatch.length === 0 && this.queue.length > 0) {
      this.scheduleFlush();
    }
    const flushOutcome = flushed.match<{ readonly kind: "completed" } | CapturedOpenObservePanic>({
      ok: () => ({ kind: "completed" }),
      err: ({ restoreCause }) => captureOpenObservePanic(restoreCause),
    });
    if (flushOutcome.kind === "panic") signalOpenObservePanic(flushOutcome.panic);
  }

  private takeBatch(): { readonly body: string } {
    const batch: SerializedOpenObserveRecord[] = [];
    let bodyBytes = 2;

    while (batch.length < MAX_BATCH_RECORDS) {
      const next = this.queue[0];
      if (!next) break;
      const addedBytes = next.bytes + (batch.length > 0 ? 1 : 0);
      if (bodyBytes + addedBytes > MAX_BATCH_BYTES) break;

      this.queue.shift();
      this.pendingBytes -= next.bytes;
      batch.push(next);
      bodyBytes += addedBytes;
    }

    const body = `[${batch.map((record) => record.json).join(",")}]`;
    this.activeBatch = batch;
    this.activeBytes =
      batch.reduce((total, record) => total + record.bytes, 0) + Buffer.byteLength(body, "utf8");
    return { body };
  }

  private async postBatch(body: string): Promise<ResultType<void, OpenObserveDeliveryFailure>> {
    const controller = new AbortController();

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.authorizationHeader) {
      headers.Authorization = this.config.authorizationHeader;
    }

    const request = Result.tryPromise({
      try: () =>
        fetch(this.config.endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        }),
      catch: (cause) => ({ restoreCause: () => cause }),
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly kind: "timeout"; readonly error: OpenObserveTimeout }>(
      (resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            kind: "timeout",
            error: new OpenObserveTimeout({
              message: "OpenObserve request exceeded its deadline",
            }),
          });
        }, OPEN_OBSERVE_REQUEST_TIMEOUT_MS);
        timeoutId.unref?.();
      },
    );

    const outcome = await Promise.race([
      request.then((result) => ({ kind: "response" as const, result })),
      timeout,
    ]);
    let result: ResultType<void, OpenObserveDeliveryFailure>;
    if (outcome.kind === "timeout") {
      controller.abort();
      await request;
      result = Result.err(outcome.error);
    } else {
      const response = outcome.result.match<
        | { readonly kind: "response"; readonly response: Response }
        | CapturedOpenObserveRequestFailure
      >({
        ok: (value) => ({ kind: "response", response: value }),
        err: ({ restoreCause }) => captureOpenObserveRequestFailure(restoreCause),
      });
      if (response.kind !== "response") {
        if (response.kind === "panic") {
          signalOpenObservePanic(response.panic);
          result = Result.err(
            new OpenObserveRequestFailed({
              cause: response.panic,
              message: "OpenObserve request failed",
            }),
          );
        } else {
          result = Result.err(response.error);
        }
      } else {
        result = response.response.ok
          ? Result.ok(undefined)
          : Result.err(
              new OpenObserveHttpFailed({
                status: response.response.status,
                message: "OpenObserve rejected a log batch",
              }),
            );
      }
    }
    const cleared = Result.try({
      try: () => {
        if (timeoutId) clearTimeout(timeoutId);
      },
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    const clearOutcome = cleared.match<{ readonly kind: "completed" } | CapturedOpenObservePanic>({
      ok: () => ({ kind: "completed" }),
      err: ({ restoreCause }) => captureOpenObservePanic(restoreCause),
    });
    if (clearOutcome.kind === "panic") signalOpenObservePanic(clearOutcome.panic);
    return result;
  }

  private recordFailure(error: OpenObserveDeliveryFailure): void {
    this.failedBatches += 1;
    this.lastFailureAtMs = Date.now();
    this.lastFailureSequence = ++openObserveOutcomeSequence;
    this.lastHttpStatus = null;

    switch (error._tag) {
      case "OpenObserveTimeout":
        this.timeoutFailures += 1;
        this.lastFailureKind = "timeout";
        return;
      case "OpenObserveRequestFailed":
        this.requestFailures += 1;
        this.lastFailureKind = "request";
        return;
      case "OpenObserveHttpFailed":
        this.httpFailures += 1;
        this.lastFailureKind = "http";
        this.lastHttpStatus = error.status;
        return;
    }
  }
}

const OPEN_OBSERVE_STREAMS = new Map<string, OpenObserveJsonlStream>();
let lastOpenObserveDiagnosticAtMs = Number.NEGATIVE_INFINITY;

export function getOpenObserveDiagnostics(): OpenObserveAggregateDiagnostics {
  const aggregate: MutableOpenObserveAggregateDiagnostics = {
    streamCount: OPEN_OBSERVE_STREAMS.size,
    ...emptyOpenObserveDiagnostics(),
  };
  let lastSuccessSequence = 0;
  let lastFailureSequence = 0;

  for (const stream of OPEN_OBSERVE_STREAMS.values()) {
    const current = stream.diagnostics();
    aggregate.retainedRecords += current.retainedRecords;
    aggregate.retainedBytes += current.retainedBytes;
    aggregate.pendingRecords += current.pendingRecords;
    aggregate.pendingBytes += current.pendingBytes;
    aggregate.activeRecords += current.activeRecords;
    aggregate.activeBytes += current.activeBytes;
    aggregate.inFlightRequests += current.inFlightRequests;
    aggregate.droppedRecords += current.droppedRecords;
    aggregate.droppedBytes += current.droppedBytes;
    aggregate.oversizeDroppedRecords += current.oversizeDroppedRecords;
    aggregate.overflowDroppedRecords += current.overflowDroppedRecords;
    aggregate.succeededBatches += current.succeededBatches;
    aggregate.failedBatches += current.failedBatches;
    aggregate.timeoutFailures += current.timeoutFailures;
    aggregate.requestFailures += current.requestFailures;
    aggregate.httpFailures += current.httpFailures;

    if (current.lastSuccessAtMs !== null && current.lastSuccessSequence > lastSuccessSequence) {
      lastSuccessSequence = current.lastSuccessSequence;
      aggregate.lastSuccessAtMs = current.lastSuccessAtMs;
    }
    if (current.lastFailureAtMs !== null && current.lastFailureSequence > lastFailureSequence) {
      lastFailureSequence = current.lastFailureSequence;
      aggregate.lastFailureAtMs = current.lastFailureAtMs;
      aggregate.lastFailureKind = current.lastFailureKind;
      aggregate.lastHttpStatus = current.lastHttpStatus;
    }
  }

  return aggregate;
}

function reportOpenObserveDiagnostics(): void {
  const now = Date.now();
  if (now - lastOpenObserveDiagnosticAtMs < OPEN_OBSERVE_DIAGNOSTIC_INTERVAL_MS) return;
  lastOpenObserveDiagnosticAtMs = now;

  const diagnostics = getOpenObserveDiagnostics();
  const message =
    `[openobserve] delivery degraded failures=${diagnostics.failedBatches}` +
    ` timeout=${diagnostics.timeoutFailures} request=${diagnostics.requestFailures}` +
    ` http=${diagnostics.httpFailures} dropped_records=${diagnostics.droppedRecords}` +
    ` last_http_status=${diagnostics.lastHttpStatus ?? "none"}` +
    ` dropped_bytes=${diagnostics.droppedBytes} retained_records=${diagnostics.retainedRecords}` +
    ` retained_bytes=${diagnostics.retainedBytes} in_flight=${diagnostics.inFlightRequests}\n`;

  const outcome = settleSyncResult(() => process.stderr.write(message));
  if (outcome.kind === "panic") throw outcome.panic;
}

function getOpenObserveStream(config: OpenObserveConfig): OpenObserveJsonlStream {
  const key = `${config.endpoint}\n${config.authorizationHeader ?? ""}`;
  const existing = OPEN_OBSERVE_STREAMS.get(key);
  if (existing) return existing;

  const stream = new OpenObserveJsonlStream(config);
  OPEN_OBSERVE_STREAMS.set(key, stream);
  return stream;
}

function emitTelemetryObservation(
  level: LogLevel,
  moduleName: string | undefined,
  message: unknown,
  args: readonly unknown[],
): void {
  if (!isTelemetryErrorCaptureActive()) return;
  Result.try({
    try: () => {
      const telemetryLevel: TelemetryLogLevel =
        level === "debug" ||
        level === "info" ||
        level === "warn" ||
        level === "error" ||
        level === "fatal"
          ? level
          : "info";

      let text = "";
      let errorName: string | undefined;
      let errorMessage: string | undefined;
      let errorCode: string | undefined;
      let errorStack: string | undefined;
      const fields: Record<string, TelemetryPrimitive | null | undefined> = {};
      let hasFields = false;

      const candidates: unknown[] = [];
      if (typeof message === "string") {
        text = message;
      } else if (message instanceof Error || isRecord(message)) {
        if (message instanceof Error) text = message.name;
        candidates.push(message);
      } else {
        text = String(message);
      }
      for (const arg of args) candidates.push(arg);

      const absorbError = (err: Error): void => {
        if (errorStack === undefined && typeof err.stack === "string") {
          errorStack = err.stack;
          if (typeof err.message === "string") errorMessage = err.message;
        }
        errorName ??= err.name;
        const errRec = err as Error & { code?: unknown; _tag?: unknown };
        if (typeof errRec.code === "string") errorCode ??= errRec.code;
        if (typeof errRec._tag === "string") {
          fields.errorTag = errRec._tag;
          hasFields = true;
        }
      };

      for (const item of candidates) {
        if (item instanceof Error) {
          absorbError(item);
          continue;
        }
        if (!isRecord(item)) continue;
        for (const [key, val] of Object.entries(item)) {
          if (val instanceof Error) {
            absorbError(val);
            continue;
          }
          if (isPrimitive(val)) {
            fields[key] = val;
            hasFields = true;
          }
        }
      }

      observeTelemetryLog({
        level: telemetryLevel,
        ...(moduleName ? { module: moduleName } : {}),
        message: text || errorName || "log",
        ...(hasFields ? { fields: fields as TelemetryLogFields } : {}),
        ...(errorName ? { errorName } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorStack ? { errorStack } : {}),
      });
    },
    catch: () => undefined,
  });
}

function createMirroredTimer(
  localTimer: ITimer,
  mirrorTimer: ITimer | undefined,
  fatalMirrorTimer: ITimer | undefined,
  getModule: () => string | undefined,
): ITimer {
  return {
    log(level, message, ...args) {
      emitTelemetryObservation(level, getModule(), message, args);
      if (level === "fatal") {
        fatalMirrorTimer?.logError(message, ...args);
        localTimer.log(level, message, ...args);
        return;
      }

      localTimer.log(level, message, ...args);
      mirrorTimer?.log(level, message, ...args);
    },
    logDebug(message, ...args) {
      emitTelemetryObservation("debug", getModule(), message, args);
      localTimer.logDebug(message, ...args);
      mirrorTimer?.logDebug(message, ...args);
    },
    logInfo(message, ...args) {
      emitTelemetryObservation("info", getModule(), message, args);
      localTimer.logInfo(message, ...args);
      mirrorTimer?.logInfo(message, ...args);
    },
    logWarn(message, ...args) {
      emitTelemetryObservation("warn", getModule(), message, args);
      localTimer.logWarn(message, ...args);
      mirrorTimer?.logWarn(message, ...args);
    },
    logError(message, ...args) {
      emitTelemetryObservation("error", getModule(), message, args);
      localTimer.logError(message, ...args);
      mirrorTimer?.logError(message, ...args);
    },
    logFatal(message, ...args) {
      emitTelemetryObservation("fatal", getModule(), message, args);
      fatalMirrorTimer?.logError(message, ...args);
      localTimer.logFatal(message, ...args);
    },
    debug(message, ...args) {
      emitTelemetryObservation("debug", getModule(), message, args);
      localTimer.debug(message, ...args);
      mirrorTimer?.debug(message, ...args);
    },
    info(message, ...args) {
      emitTelemetryObservation("info", getModule(), message, args);
      localTimer.info(message, ...args);
      mirrorTimer?.info(message, ...args);
    },
    warn(message, ...args) {
      emitTelemetryObservation("warn", getModule(), message, args);
      localTimer.warn(message, ...args);
      mirrorTimer?.warn(message, ...args);
    },
    error(message, ...args) {
      emitTelemetryObservation("error", getModule(), message, args);
      localTimer.error(message, ...args);
      mirrorTimer?.error(message, ...args);
    },
    fatal(message, ...args) {
      emitTelemetryObservation("fatal", getModule(), message, args);
      fatalMirrorTimer?.error(message, ...args);
      localTimer.fatal(message, ...args);
    },
  };
}

class MirroredLogger extends Logger {
  private moduleName: string | undefined;

  constructor(
    private readonly localLogger: Logger,
    private readonly mirrorLogger?: Logger,
    private readonly fatalMirrorLogger?: Logger,
    moduleName?: string,
  ) {
    super({
      logLevel: "fatal",
    });
    this.moduleName = moduleName;
  }

  override log(level: LogLevel, message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation(level, this.moduleName, message, args);
    if (level === "fatal") {
      this.fatalMirrorLogger?.logError(message, ...args);
      this.localLogger.log(level, message, ...args);
      return;
    }

    this.localLogger.log(level, message, ...args);
    this.mirrorLogger?.log(level, message, ...args);
  }

  override logDebug(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("debug", this.moduleName, message, args);
    this.localLogger.logDebug(message, ...args);
    this.mirrorLogger?.logDebug(message, ...args);
  }

  override logInfo(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("info", this.moduleName, message, args);
    this.localLogger.logInfo(message, ...args);
    this.mirrorLogger?.logInfo(message, ...args);
  }

  override logWarn(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("warn", this.moduleName, message, args);
    this.localLogger.logWarn(message, ...args);
    this.mirrorLogger?.logWarn(message, ...args);
  }

  override logError(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("error", this.moduleName, message, args);
    this.localLogger.logError(message, ...args);
    this.mirrorLogger?.logError(message, ...args);
  }

  override logFatal(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("fatal", this.moduleName, message, args);
    this.fatalMirrorLogger?.logError(message, ...args);
    this.localLogger.logFatal(message, ...args);
  }

  override debug(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("debug", this.moduleName, message, args);
    this.localLogger.debug(message, ...args);
    this.mirrorLogger?.debug(message, ...args);
  }

  override info(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("info", this.moduleName, message, args);
    this.localLogger.info(message, ...args);
    this.mirrorLogger?.info(message, ...args);
  }

  override warn(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("warn", this.moduleName, message, args);
    this.localLogger.warn(message, ...args);
    this.mirrorLogger?.warn(message, ...args);
  }

  override error(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("error", this.moduleName, message, args);
    this.localLogger.error(message, ...args);
    this.mirrorLogger?.error(message, ...args);
  }

  override fatal(message: unknown, ...args: unknown[]): void {
    emitTelemetryObservation("fatal", this.moduleName, message, args);
    this.fatalMirrorLogger?.error(message, ...args);
    this.localLogger.fatal(message, ...args);
  }

  override setLogLevel(level: LogLevel): void {
    this.localLogger.setLogLevel(level);
    this.mirrorLogger?.setLogLevel(level);
  }

  override setModule(module: string): void {
    this.moduleName = module;
    this.localLogger.setModule(module);
    this.mirrorLogger?.setModule(module);
    this.fatalMirrorLogger?.setModule(module);
  }

  override timer(options?: TimerOptions): ITimer {
    return createMirroredTimer(
      this.localLogger.timer(options),
      this.mirrorLogger?.timer(options),
      this.fatalMirrorLogger?.timer(options),
      () => this.moduleName,
    );
  }
}

export type CreateLoggerOptions = Omit<LoggerOptions, "logLevel"> & {
  logLevel?: LogLevel;
  outputFormat?: "text" | "jsonl";
  jsonlSplitStreams?: boolean;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { logLevel, outputFormat, jsonlSplitStreams, ...rest } = options;
  const localLogLevel = resolveLogLevel(logLevel);
  const localLoggerOptions: ExtendedLoggerOptions = {
    ...rest,
    logLevel: localLogLevel,
    outputFormat: resolveOutputFormat(outputFormat),
    jsonlSplitStreams: resolveJsonlSplitStreams(jsonlSplitStreams),
  };

  const localLogger = new Logger(localLoggerOptions);
  const moduleName = typeof rest.module === "string" ? rest.module : undefined;

  const openObserve = resolveOpenObserveConfig();
  if (!openObserve) {
    return new MirroredLogger(localLogger, undefined, undefined, moduleName);
  }

  const openObserveStream = getOpenObserveStream(openObserve);
  const mirrorLoggerOptions: ExtendedLoggerOptions = {
    ...rest,
    logLevel: resolveOpenObserveLogLevel(localLogLevel),
    outputFormat: "jsonl",
    jsonlSplitStreams: false,
    stdout: openObserveStream,
    stderr: openObserveStream,
  };
  const mirrorLogger = new Logger(mirrorLoggerOptions);
  const fatalMirrorLogger = new Logger({
    ...mirrorLoggerOptions,
    logLevel: "error",
  });

  return new MirroredLogger(localLogger, mirrorLogger, fatalMirrorLogger, moduleName);
}
