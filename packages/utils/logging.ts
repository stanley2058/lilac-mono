import { Buffer } from "node:buffer";

import {
  Logger,
  type ITimer,
  type LogLevel,
  type LoggerOptions,
  type TimerOptions,
  type WriteStream,
} from "@stanley2058/simple-module-logger";

const LOG_LEVEL_VALUES: readonly LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

function hasTestGlobals(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof g.describe === "function" && typeof g.it === "function";
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
  return LOG_LEVEL_VALUES.includes(normalized as LogLevel) ? (normalized as LogLevel) : undefined;
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

function reportOpenObserveFailure(message: string): void {
  try {
    process.stderr.write(`[openobserve] ${message}\n`);
  } catch {
    // Ignore stderr write failures.
  }
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const MAX_OBJECT_FIELDS_PER_ARG = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function addNormalizedArgFields(
  target: Record<string, unknown>,
  index: number,
  value: unknown,
): void {
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

  target[prefix] = String(value);
}

function normalizeRecordForOpenObserve(record: unknown): Record<string, unknown> | null {
  if (!isRecord(record)) return null;

  const normalized: Record<string, unknown> = { ...record };
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
  private readonly queue: unknown[] = [];
  private flushScheduled = false;
  private flushing = false;

  constructor(private readonly config: OpenObserveConfig) {}

  write(chunk: string): unknown {
    const lines = chunk.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const normalized = normalizeRecordForOpenObserve(parsed);
        if (normalized) {
          this.queue.push(normalized);
        }
      } catch {
        // Ignore malformed lines; logger output should be valid JSONL.
      }
    }

    this.scheduleFlush();
    return true;
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

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 200);
        await this.postBatch(batch);
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private async postBatch(batch: readonly unknown[]): Promise<void> {
    if (batch.length === 0) return;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.authorizationHeader) {
      headers.Authorization = this.config.authorizationHeader;
    }

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        const details = await this.readResponseDetails(response);
        reportOpenObserveFailure(
          `log ingest failed (${response.status} ${response.statusText}) to ${this.config.endpoint}${details ? `: ${details}` : ""}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportOpenObserveFailure(`log ingest request failed to ${this.config.endpoint}: ${message}`);
    }
  }

  private async readResponseDetails(response: Response): Promise<string | undefined> {
    try {
      const text = (await response.text()).trim();
      if (!text) return undefined;
      const singleLine = toSingleLine(text);
      return singleLine.slice(0, 300);
    } catch {
      return undefined;
    }
  }
}

const OPEN_OBSERVE_STREAMS = new Map<string, OpenObserveJsonlStream>();

function getOpenObserveStream(config: OpenObserveConfig): OpenObserveJsonlStream {
  const key = `${config.endpoint}\n${config.authorizationHeader ?? ""}`;
  const existing = OPEN_OBSERVE_STREAMS.get(key);
  if (existing) return existing;

  const stream = new OpenObserveJsonlStream(config);
  OPEN_OBSERVE_STREAMS.set(key, stream);
  return stream;
}

function createMirroredTimer(localTimer: ITimer, mirrorTimer: ITimer): ITimer {
  return {
    log(level, message, ...args) {
      if (level === "fatal") {
        mirrorTimer.log(level, message, ...args);
        localTimer.log(level, message, ...args);
        return;
      }

      localTimer.log(level, message, ...args);
      mirrorTimer.log(level, message, ...args);
    },
    logDebug(message, ...args) {
      localTimer.logDebug(message, ...args);
      mirrorTimer.logDebug(message, ...args);
    },
    logInfo(message, ...args) {
      localTimer.logInfo(message, ...args);
      mirrorTimer.logInfo(message, ...args);
    },
    logWarn(message, ...args) {
      localTimer.logWarn(message, ...args);
      mirrorTimer.logWarn(message, ...args);
    },
    logError(message, ...args) {
      localTimer.logError(message, ...args);
      mirrorTimer.logError(message, ...args);
    },
    logFatal(message, ...args) {
      mirrorTimer.logFatal(message, ...args);
      localTimer.logFatal(message, ...args);
    },
    debug(message, ...args) {
      localTimer.debug(message, ...args);
      mirrorTimer.debug(message, ...args);
    },
    info(message, ...args) {
      localTimer.info(message, ...args);
      mirrorTimer.info(message, ...args);
    },
    warn(message, ...args) {
      localTimer.warn(message, ...args);
      mirrorTimer.warn(message, ...args);
    },
    error(message, ...args) {
      localTimer.error(message, ...args);
      mirrorTimer.error(message, ...args);
    },
    fatal(message, ...args) {
      mirrorTimer.fatal(message, ...args);
      localTimer.fatal(message, ...args);
    },
  };
}

class MirroredLogger extends Logger {
  constructor(
    private readonly localLogger: Logger,
    private readonly mirrorLogger: Logger,
  ) {
    super({
      logLevel: "fatal",
    });
  }

  override log(level: LogLevel, message: any, ...args: any[]): void {
    if (level === "fatal") {
      this.mirrorLogger.log(level, message, ...args);
      this.localLogger.log(level, message, ...args);
      return;
    }

    this.localLogger.log(level, message, ...args);
    this.mirrorLogger.log(level, message, ...args);
  }

  override logDebug(message: any, ...args: any[]): void {
    this.localLogger.logDebug(message, ...args);
    this.mirrorLogger.logDebug(message, ...args);
  }

  override logInfo(message: any, ...args: any[]): void {
    this.localLogger.logInfo(message, ...args);
    this.mirrorLogger.logInfo(message, ...args);
  }

  override logWarn(message: any, ...args: any[]): void {
    this.localLogger.logWarn(message, ...args);
    this.mirrorLogger.logWarn(message, ...args);
  }

  override logError(message: any, ...args: any[]): void {
    this.localLogger.logError(message, ...args);
    this.mirrorLogger.logError(message, ...args);
  }

  override logFatal(message: any, ...args: any[]): void {
    this.mirrorLogger.logFatal(message, ...args);
    this.localLogger.logFatal(message, ...args);
  }

  override debug(message: any, ...args: any[]): void {
    this.localLogger.debug(message, ...args);
    this.mirrorLogger.debug(message, ...args);
  }

  override info(message: any, ...args: any[]): void {
    this.localLogger.info(message, ...args);
    this.mirrorLogger.info(message, ...args);
  }

  override warn(message: any, ...args: any[]): void {
    this.localLogger.warn(message, ...args);
    this.mirrorLogger.warn(message, ...args);
  }

  override error(message: any, ...args: any[]): void {
    this.localLogger.error(message, ...args);
    this.mirrorLogger.error(message, ...args);
  }

  override fatal(message: any, ...args: any[]): void {
    this.mirrorLogger.fatal(message, ...args);
    this.localLogger.fatal(message, ...args);
  }

  override setLogLevel(level: LogLevel): void {
    this.localLogger.setLogLevel(level);
    this.mirrorLogger.setLogLevel(level);
  }

  override setModule(module: string): void {
    this.localLogger.setModule(module);
    this.mirrorLogger.setModule(module);
  }

  override timer(options?: TimerOptions): ITimer {
    return createMirroredTimer(this.localLogger.timer(options), this.mirrorLogger.timer(options));
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

  const openObserve = resolveOpenObserveConfig();
  if (!openObserve) {
    return localLogger;
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

  return new MirroredLogger(localLogger, mirrorLogger);
}
