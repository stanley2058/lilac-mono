import fs from "node:fs/promises";
import path from "node:path";
import { Panic, Result } from "better-result";

import { env } from "./env";
import { createLogger } from "./logging";
import { isPanic, isRecord, opaqueErrorMessage, settlePromiseResult } from "./runtime-utils";
import { redactErrorTextForLog } from "./tagged-error-log";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

type LogWarning = (message: string, details?: Record<string, unknown>) => void;
type WireDebugContext = Readonly<Record<string, string | number | boolean | undefined>>;

export type LlmWireDebugTrace = {
  write(event: string, payload?: {} | null, details?: WireDebugContext): void;
  flush(): Promise<void>;
};

type WireDebugEvent = {
  ts: string;
  provider: string;
  traceId: string;
  event: string;
  data?: unknown;
  context?: unknown;
  details?: unknown;
};

const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|token|secret|password|cookie|turn[_-]state)/i;
const PREVIEW_TEXT_LIMIT = 2_000;

class JsonlWriter {
  private queue: Promise<boolean> = Promise.resolve(true);
  private failed = false;
  private failureLogged = false;
  private deferredPanic: Panic | undefined;

  constructor(
    private readonly filePath: string,
    private readonly onError: (details: { filePath: string; restoreError: () => unknown }) => void,
  ) {}

  write(entry: WireDebugEvent): void {
    if (this.failed) return;

    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue.then(async () => {
      // Flush may run much later than the write, so retain defects without rejecting the queue.
      const outcome = await settlePromiseResult(() => this.append(line));
      if (outcome.kind === "value") return outcome.value;
      this.failed = true;
      if (outcome.kind === "panic") this.deferredPanic ??= outcome.panic;
      return false;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.deferredPanic !== undefined) throw this.deferredPanic;
  }

  private async append(line: string): Promise<boolean> {
    if (this.failed) return false;
    const outcome = await settlePromiseResult(() => fs.appendFile(this.filePath, line, "utf8"));
    if (outcome.kind === "value") return true;
    if (outcome.kind === "panic") throw outcome.panic;
    this.failed = true;
    if (!this.failureLogged) {
      this.failureLogged = true;
      this.onError({ filePath: this.filePath, restoreError: outcome.restoreCause });
    }
    return false;
  }
}

const disabledWireTrace: LlmWireDebugTrace = { write() {}, async flush() {} };

export function createLlmWireDebugTrace(params: {
  provider: string;
  context?: WireDebugContext;
  warn?: LogWarning;
}): LlmWireDebugTrace {
  if (!env.debug.llmWire.enabled) return disabledWireTrace;

  const { maxBodyBytes, maxEvents } = env.debug.llmWire;
  const traceId = createTraceId();
  const context = captureWireDebugSnapshot(params.context, maxBodyBytes);
  const logger = createLogger({ module: "llm-wire-debug" });
  let writer: JsonlWriter | null | undefined;
  let queue: Promise<void> = Promise.resolve();
  let failed = false;
  let deferredPanic: Panic | undefined;
  let eventCount = 0;

  return {
    write(event, payload, details) {
      eventCount += 1;
      if (eventCount > maxEvents + 1) return;
      const truncated = eventCount > maxEvents;
      const entry: WireDebugEvent = {
        ts: new Date().toISOString(),
        provider: params.provider,
        traceId,
        event: truncated ? "trace.events_truncated" : event,
        context,
        details: truncated ? undefined : captureWireDebugSnapshot(details, maxBodyBytes),
        data: truncated ? { maxEvents } : captureWireDebugSnapshot(payload, maxBodyBytes),
      };
      queue = queue.then(async () => {
        if (failed) return;
        const outcome = await settlePromiseResult(async () => {
          if (writer === undefined) {
            writer = await createWriter(
              buildTraceFilePath(params.provider, traceId),
              params.warn ?? ((message, details) => logger.warn(message, details)),
              params.provider,
              traceId,
            );
          }
          writer?.write(entry);
        });
        if (outcome.kind === "value") return;
        failed = true;
        if (outcome.kind === "panic") deferredPanic ??= outcome.panic;
      });
    },
    async flush() {
      await queue;
      if (deferredPanic !== undefined) throw deferredPanic;
      await writer?.flush();
    },
  };
}

function captureWireDebugSnapshot(value: unknown, maxBytes: number): unknown {
  const captured = Result.try({
    try: () => {
      const snapshot = redactValue(value);
      const serialized = JSON.stringify(snapshot);
      if (serialized === undefined) return undefined;
      const preview = truncateUtf8(serialized, maxBytes);
      if (!preview.truncated) return snapshot;
      return {
        truncated: true,
        originalBytes: Buffer.byteLength(serialized, "utf8"),
        preview: preview.text,
      };
    },
    catch: (cause) => ({ cause }),
  });
  if (captured.isErr()) {
    if (isPanic(captured.error.cause)) throw captured.error.cause;
    return "<unserializable>";
  }
  return captured.match({ ok: (snapshot) => snapshot, err: () => "<unserializable>" });
}

function warnSafely(
  warn: LogWarning | undefined,
  message: string,
  details: Record<string, unknown>,
): void {
  const captured = Result.try({
    try: () => warn?.(message, details),
    catch: (cause) => ({ cause }),
  });
  if (captured.isErr()) {
    if (isPanic(captured.error.cause)) throw captured.error.cause;
  }
}

export function withLlmWireDebugFetch(params: {
  provider: string;
  fetchFn: typeof globalThis.fetch;
  warn?: LogWarning;
}): typeof globalThis.fetch {
  if (!env.debug.llmWire.enabled) {
    return params.fetchFn;
  }

  const maxBodyBytes = env.debug.llmWire.maxBodyBytes;
  const maxEvents = env.debug.llmWire.maxEvents;

  return (async (input: FetchInput, init?: FetchInit): Promise<FetchResponse> => {
    const traceId = createTraceId();
    const traceFilePath = buildTraceFilePath(params.provider, traceId);
    const writer = await createWriter(traceFilePath, params.warn, params.provider, traceId);
    const startedAt = Date.now();

    const requestSnapshot = await captureRequestSnapshot({
      input,
      init,
      maxBodyBytes,
    });

    writer?.write({
      ts: new Date().toISOString(),
      provider: params.provider,
      traceId,
      event: "request",
      data: requestSnapshot,
    });

    const fetchOutcome = await settlePromiseResult(() => params.fetchFn(input, init));
    if (fetchOutcome.kind !== "value") {
      const error =
        fetchOutcome.kind === "panic" ? fetchOutcome.panic : fetchOutcome.restoreCause();
      writer?.write({
        ts: new Date().toISOString(),
        provider: params.provider,
        traceId,
        event: "request.error",
        data: {
          elapsedMs: Date.now() - startedAt,
          error: redactErrorTextForLog(opaqueErrorMessage(error, "Unknown LLM request failure")),
        },
      });
      await writer?.flush();
      throw error;
    }
    const response = fetchOutcome.value;

    const responseInfo = {
      status: response.status,
      statusText: response.statusText,
      headers: redactHeaders(Object.fromEntries(response.headers.entries())),
      elapsedMs: Date.now() - startedAt,
    };

    writer?.write({
      ts: new Date().toISOString(),
      provider: params.provider,
      traceId,
      event: "response.headers",
      data: responseInfo,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const isSse = /text\/event-stream/i.test(contentType);

    if (!response.body) {
      writer?.write({
        ts: new Date().toISOString(),
        provider: params.provider,
        traceId,
        event: "response.complete",
        data: {
          elapsedMs: Date.now() - startedAt,
          hasBody: false,
        },
      });
      void writer?.flush();
      return response;
    }

    if (isSse) {
      const [userBody, debugBody] = response.body.tee();

      void consumeSseDebugStream({
        stream: debugBody,
        writer,
        provider: params.provider,
        traceId,
        maxEvents,
        maxBodyBytes,
        startedAt,
      });

      return new Response(userBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    void captureNonStreamingResponse({
      response: response.clone(),
      writer,
      provider: params.provider,
      traceId,
      maxBodyBytes,
      startedAt,
    });

    return response;
  }) as typeof globalThis.fetch;
}

async function createWriter(
  filePath: string,
  warn: LogWarning | undefined,
  provider: string,
  traceId: string,
): Promise<JsonlWriter | null> {
  const outcome = await settlePromiseResult(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return new JsonlWriter(filePath, ({ filePath: failedPath, restoreError }) => {
      warnSafely(warn, "llm wire debug append failed", {
        provider,
        traceId,
        filePath: failedPath,
        error: redactErrorTextForLog(
          opaqueErrorMessage(restoreError(), "Unknown trace-file creation failure"),
        ),
      });
    });
  });
  if (outcome.kind === "value") return outcome.value;
  if (outcome.kind === "panic") throw outcome.panic;
  warnSafely(warn, "llm wire debug disabled for request (failed to create trace file)", {
    provider,
    traceId,
    filePath,
    error: redactErrorTextForLog(
      opaqueErrorMessage(outcome.restoreCause(), "Unknown response body read failure"),
    ),
  });
  return null;
}

function buildTraceFilePath(provider: string, traceId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(env.debug.llmWire.dir, `${stamp}-${provider}-${traceId}.jsonl`);
}

function createTraceId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${process.pid}-${Date.now()}-${rand}`;
}

async function captureRequestSnapshot(input: {
  input: FetchInput;
  init?: FetchInit;
  maxBodyBytes: number;
}): Promise<Record<string, unknown>> {
  const { input: fetchInput, init, maxBodyBytes } = input;
  const url = getRequestUrl(fetchInput).toString();
  const method = getRequestMethod(fetchInput, init);
  const headers = redactHeaders(getRequestHeaders(fetchInput, init));

  const rawBody = await decodeRequestBody(fetchInput, init);
  const body = toRedactedBodyPreview(rawBody, maxBodyBytes);

  return {
    url,
    method,
    headers,
    body,
  };
}

async function captureNonStreamingResponse(input: {
  response: { text(): Promise<string> };
  writer: JsonlWriter | null;
  provider: string;
  traceId: string;
  maxBodyBytes: number;
  startedAt: number;
}): Promise<void> {
  const { response, writer, provider, traceId, maxBodyBytes, startedAt } = input;

  const readOutcome = await settlePromiseResult(async () => {
    const body = toRedactedBodyPreview(await response.text(), maxBodyBytes);
    return () => body;
  });
  if (readOutcome.kind === "panic") throw readOutcome.panic;
  const body =
    readOutcome.kind === "value"
      ? readOutcome.value()
      : {
          error: redactErrorTextForLog(
            opaqueErrorMessage(readOutcome.restoreCause(), "Unknown response body read failure"),
          ),
        };

  writer?.write({
    ts: new Date().toISOString(),
    provider,
    traceId,
    event: "response.body",
    data: body,
  });

  writer?.write({
    ts: new Date().toISOString(),
    provider,
    traceId,
    event: "response.complete",
    data: {
      elapsedMs: Date.now() - startedAt,
      transport: "http",
    },
  });

  await writer?.flush();
}

async function consumeSseDebugStream(input: {
  stream: ReadableStream<Uint8Array>;
  writer: JsonlWriter | null;
  provider: string;
  traceId: string;
  maxEvents: number;
  maxBodyBytes: number;
  startedAt: number;
}): Promise<void> {
  const { stream, writer, provider, traceId, maxEvents, maxBodyBytes, startedAt } = input;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffered = "";
  let eventCount = 0;
  let truncated = false;
  let deferredPanic: Panic | undefined;

  const consumed = await settlePromiseResult(async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      while (true) {
        const splitIdx = buffered.indexOf("\n\n");
        if (splitIdx < 0) break;

        const frame = buffered.slice(0, splitIdx);
        buffered = buffered.slice(splitIdx + 2);

        const data = extractSseData(frame);
        if (!data) continue;

        eventCount += 1;

        if (eventCount > maxEvents) {
          if (!truncated) {
            truncated = true;
            writer?.write({
              ts: new Date().toISOString(),
              provider,
              traceId,
              event: "response.sse.events_truncated",
              data: {
                maxEvents,
              },
            });
          }
          continue;
        }

        if (data === "[DONE]") {
          writer?.write({
            ts: new Date().toISOString(),
            provider,
            traceId,
            event: "response.sse.done",
            data: {
              index: eventCount,
            },
          });
          continue;
        }

        const parsed = safeParseJson(data);

        writer?.write({
          ts: new Date().toISOString(),
          provider,
          traceId,
          event: "response.sse.event",
          data: {
            index: eventCount,
            eventType: projectWireDebugEventType(isRecord(parsed) ? parsed : null),
            payload: parsed ? redactValue(parsed) : previewText(data, maxBodyBytes),
          },
        });
      }
    }
  });
  if (consumed.kind !== "value") {
    if (consumed.kind === "panic") deferredPanic = consumed.panic;
    else {
      writer?.write({
        ts: new Date().toISOString(),
        provider,
        traceId,
        event: "response.sse.error",
        data: {
          error: redactErrorTextForLog(
            opaqueErrorMessage(consumed.restoreCause(), "Unknown SSE debug stream failure"),
          ),
        },
      });
    }
  }
  writer?.write({
    ts: new Date().toISOString(),
    provider,
    traceId,
    event: "response.complete",
    data: {
      elapsedMs: Date.now() - startedAt,
      transport: "sse",
      eventCount,
    },
  });
  const flushed = await settlePromiseResult(async () => writer?.flush());
  if (flushed.kind === "panic" && deferredPanic === undefined) deferredPanic = flushed.panic;
  const released = Result.try({
    try: () => reader.releaseLock(),
    catch: (cause) => ({ cause }),
  });
  const releaseOutcome = released.match<
    | { readonly kind: "released" }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure" }
  >({
    ok: () => ({ kind: "released" }),
    err: ({ cause }) => (isPanic(cause) ? { kind: "panic", panic: cause } : { kind: "failure" }),
  });
  if (releaseOutcome.kind === "panic" && deferredPanic === undefined)
    deferredPanic = releaseOutcome.panic;
  if (deferredPanic !== undefined) throw deferredPanic;
}

function extractSseData(frame: string): string {
  const out: string[] = [];
  const lines = frame.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    out.push(line.slice(5).trimStart());
  }
  return out.join("\n");
}

function safeParseJson(text: string): unknown | null {
  const captured = Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => ({ cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "value"; readonly restoreValue: () => unknown }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "invalid" }
  >({
    ok: (value) => ({ kind: "value", restoreValue: () => value }),
    err: ({ cause }) => (isPanic(cause) ? { kind: "panic", panic: cause } : { kind: "invalid" }),
  });
  if (outcome.kind === "panic") throw outcome.panic;
  return outcome.kind === "value" ? outcome.restoreValue() : null;
}

function projectWireDebugEventType(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  return typeof value.type === "string" ? value.type : null;
}

function toRedactedBodyPreview(body: string | undefined, maxBytes: number): unknown {
  if (!body) return null;

  const truncated = truncateUtf8(body, maxBytes);
  const parsed = safeParseJson(truncated.text);
  if (parsed !== null) {
    return {
      kind: "json",
      truncated: truncated.truncated,
      value: redactValue(parsed),
    };
  }

  return {
    kind: "text",
    truncated: truncated.truncated,
    value: previewText(truncated.text, PREVIEW_TEXT_LIMIT),
  };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "<redacted>" : value;
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (depth > 8) return "<max_depth>";

  if (typeof value === "string") {
    if (looksSensitiveText(value)) return "<redacted>";
    return previewText(redactErrorTextForLog(value, value.length), PREVIEW_TEXT_LIMIT);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "<redacted>";
      } else {
        out[key] = redactValue(item, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

function looksSensitiveText(value: string): boolean {
  const compact = value.trim();
  if (compact.length === 0) return false;
  if (/^Bearer\s+/i.test(compact)) return true;
  if (compact.length > 40 && !compact.includes(" ")) {
    if (/(sk-|xoxp-|ghp_|gho_|AIza)/.test(compact)) return true;
  }
  return false;
}

function previewText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...<truncated>`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }

  const sliced = bytes.subarray(0, maxBytes);
  return {
    text: new TextDecoder().decode(sliced, { stream: true }),
    truncated: true,
  };
}

function getRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function getRequestMethod(input: FetchInput, init?: FetchInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

function normalizeHeaders(headers: RequestInit["headers"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (typeof key === "string" && value != null) {
        out[key.toLowerCase()] = String(value);
      }
    }
    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      out[key.toLowerCase()] = String(value);
    }
  }

  return out;
}

function getRequestHeaders(input: FetchInput, init?: FetchInit): Record<string, string> {
  const base = input instanceof Request ? normalizeHeaders(input.headers) : {};
  const over = normalizeHeaders(init?.headers);
  return {
    ...base,
    ...over,
  };
}

async function decodeRequestBody(input: FetchInput, init?: FetchInit): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));

  if (input instanceof Request) {
    const outcome = await settlePromiseResult(() => input.clone().text());
    if (outcome.kind === "panic") throw outcome.panic;
    return outcome.kind === "value" ? outcome.value : undefined;
  }

  return undefined;
}
