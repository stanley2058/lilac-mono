import fs from "node:fs/promises";
import path from "node:path";

import { env } from "./env";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

type LogWarning = (message: string, details?: Record<string, unknown>) => void;

type WireDebugEvent = {
  ts: string;
  provider: string;
  traceId: string;
  event: string;
  data?: unknown;
};

const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|token|secret|password|cookie)/i;
const PREVIEW_TEXT_LIMIT = 2_000;

class JsonlWriter {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private failureLogged = false;

  constructor(
    private readonly filePath: string,
    private readonly onError: (details: { filePath: string; error: unknown }) => void,
  ) {}

  write(entry: WireDebugEvent): void {
    if (this.failed) return;

    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue
      .then(() => fs.appendFile(this.filePath, line, "utf8"))
      .catch((error) => {
        this.failed = true;
        if (!this.failureLogged) {
          this.failureLogged = true;
          this.onError({ filePath: this.filePath, error });
        }
      });
  }

  flush(): Promise<void> {
    return this.queue;
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

    let response: FetchResponse;
    try {
      response = await params.fetchFn(input, init);
    } catch (error) {
      writer?.write({
        ts: new Date().toISOString(),
        provider: params.provider,
        traceId,
        event: "request.error",
        data: {
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await writer?.flush();
      throw error;
    }

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
      }) as FetchResponse;
    }

    void captureNonStreamingResponse({
      response: response.clone() as unknown as FetchResponse,
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
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return new JsonlWriter(filePath, ({ filePath: failedPath, error }) => {
      warn?.("llm wire debug append failed", {
        provider,
        traceId,
        filePath: failedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    warn?.("llm wire debug disabled for request (failed to create trace file)", {
      provider,
      traceId,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
  response: FetchResponse;
  writer: JsonlWriter | null;
  provider: string;
  traceId: string;
  maxBodyBytes: number;
  startedAt: number;
}): Promise<void> {
  const { response, writer, provider, traceId, maxBodyBytes, startedAt } = input;

  let body: unknown;
  try {
    const text = await response.text();
    body = toRedactedBodyPreview(text, maxBodyBytes);
  } catch (error) {
    body = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

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

  try {
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
            eventType:
              parsed && typeof parsed === "object" && "type" in parsed
                ? String((parsed as Record<string, unknown>).type)
                : null,
            payload: parsed ? redactValue(parsed) : previewText(data, maxBodyBytes),
          },
        });
      }
    }
  } catch (error) {
    writer?.write({
      ts: new Date().toISOString(),
      provider,
      traceId,
      event: "response.sse.error",
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
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
    await writer?.flush();
    try {
      reader.releaseLock();
    } catch {}
  }
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
    return previewText(value, PREVIEW_TEXT_LIMIT);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
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
    text: sliced.toString("utf8"),
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
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }

  return undefined;
}
