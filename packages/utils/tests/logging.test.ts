import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";

import { createLogger } from "../logging";

type EnvPatch = Record<string, string | undefined>;

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

type FetchCall = {
  url: string;
  init?: Parameters<typeof fetch>[1];
};

function asHeaderRecord(headers: RequestInit["headers"] | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
      result[key.toLowerCase()] = value;
    }
    return result;
  }

  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const entry of headers) {
      const key = entry[0];
      const value = entry[1];
      if (typeof key !== "string" || typeof value !== "string") continue;
      result[key.toLowerCase()] = value;
    }
    return result;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function parseJsonBody(body: RequestInit["body"] | undefined): unknown[] {
  if (typeof body !== "string") return [];
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withMockFetch<T>(
  fn: (calls: FetchCall[]) => Promise<T>,
  responseForCall?: (call: FetchCall) => Response | Promise<Response>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const globals = globalThis as unknown as { fetch: typeof fetch };
  const originalFetch = globals.fetch;

  globals.fetch = (async (...args: Parameters<typeof fetch>) => {
    const call: FetchCall = {
      url: String(args[0]),
      init: args[1],
    };
    calls.push(call);
    if (responseForCall) {
      return await responseForCall(call);
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    return await fn(calls);
  } finally {
    globals.fetch = originalFetch;
  }
}

async function withCapturedStderr<T>(fn: (chunks: string[]) => Promise<T>): Promise<T> {
  const stderr = process.stderr as unknown as {
    write: (chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => boolean;
  };
  const originalWrite = stderr.write;
  const chunks: string[] = [];

  stderr.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    }
    callback?.(null);
    return true;
  }) as typeof stderr.write;

  try {
    return await fn(chunks);
  } finally {
    stderr.write = originalWrite;
  }
}

async function waitForAsyncLogging(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("logging", () => {
  it("keeps local text output by default", async () => {
    await withEnv(
      {
        LILAC_LOG_JSONL: undefined,
        LILAC_LOG_OPENOBSERVE_BASE_URL: undefined,
      },
      async () => {
        const stdout = new MemoryWriteStream();
        const stderr = new MemoryWriteStream();

        const logger = createLogger({
          module: "logging-test",
          logLevel: "info",
          stdout,
          stderr,
        });

        logger.info("hello-text");

        const line = stdout.joined().trim();
        expect(line).toContain("hello-text");
        expect(line.startsWith("{")).toBe(false);
      },
    );
  });

  it("supports local jsonl output via env flag", async () => {
    await withEnv(
      {
        LILAC_LOG_JSONL: "1",
        LILAC_LOG_OPENOBSERVE_BASE_URL: undefined,
      },
      async () => {
        const stdout = new MemoryWriteStream();
        const stderr = new MemoryWriteStream();

        const logger = createLogger({
          module: "logging-test",
          logLevel: "info",
          stdout,
          stderr,
        });

        logger.info("hello-jsonl");

        const line = stdout.joined().trim();
        const record = JSON.parse(line) as Record<string, unknown>;
        expect(record.level).toBe("info");
        expect(record.message).toBe("hello-jsonl");
        expect(record.module).toBe("logging-test");
      },
    );
  });

  it("mirrors jsonl logs to OpenObserve while keeping local text", async () => {
    await withEnv(
      {
        LILAC_LOG_JSONL: undefined,
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
        LILAC_LOG_OPENOBSERVE_ORG: undefined,
        LILAC_LOG_OPENOBSERVE_STREAM: undefined,
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: undefined,
        LILAC_LOG_OPENOBSERVE_USERNAME: undefined,
        LILAC_LOG_OPENOBSERVE_PASSWORD: undefined,
      },
      async () => {
        await withMockFetch(async (calls) => {
          const stdout = new MemoryWriteStream();
          const stderr = new MemoryWriteStream();

          const logger = createLogger({
            module: "logging-test",
            logLevel: "info",
            stdout,
            stderr,
          });

          logger.info("hello-openobserve");
          await waitForAsyncLogging();

          expect(stdout.joined()).toContain("hello-openobserve");
          expect(stdout.joined().trim().startsWith("{")).toBe(false);

          expect(calls.length).toBe(1);
          expect(calls[0]?.url).toBe("https://observe.example/api/default/lilac/_json");

          const headers = asHeaderRecord(calls[0]?.init?.headers);
          expect(headers.authorization).toBeUndefined();

          const body = parseJsonBody(calls[0]?.init?.body);
          expect(body.length).toBe(1);
          const record = body[0] as Record<string, unknown>;
          expect(record.level).toBe("info");
          expect(record.message).toBe("hello-openobserve");
          expect(record.module).toBe("logging-test");
        });
      },
    );
  });

  it("uses bearer auth over basic auth for OpenObserve", async () => {
    await withEnv(
      {
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: "token-123",
        LILAC_LOG_OPENOBSERVE_USERNAME: "user@example.com",
        LILAC_LOG_OPENOBSERVE_PASSWORD: "secret",
      },
      async () => {
        await withMockFetch(async (calls) => {
          const logger = createLogger({
            module: "logging-test",
            logLevel: "info",
            stdout: new MemoryWriteStream(),
            stderr: new MemoryWriteStream(),
          });

          logger.info("hello-auth");
          await waitForAsyncLogging();

          const headers = asHeaderRecord(calls[0]?.init?.headers);
          expect(headers.authorization).toBe("Bearer token-123");
        });
      },
    );
  });

  it("supports different remote log level for OpenObserve", async () => {
    await withEnv(
      {
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
        LILAC_LOG_OPENOBSERVE_LEVEL: "warn",
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: undefined,
        LILAC_LOG_OPENOBSERVE_USERNAME: undefined,
        LILAC_LOG_OPENOBSERVE_PASSWORD: undefined,
      },
      async () => {
        await withMockFetch(async (calls) => {
          const stdout = new MemoryWriteStream();
          const stderr = new MemoryWriteStream();
          const logger = createLogger({
            module: "logging-test",
            logLevel: "info",
            stdout,
            stderr,
          });

          logger.info("local-only-info");
          logger.warn("local-and-remote-warn");
          await waitForAsyncLogging();

          expect(stdout.joined()).toContain("local-only-info");
          expect(stderr.joined()).toContain("local-and-remote-warn");

          const records = calls.flatMap((call) => parseJsonBody(call.init?.body));
          const messages = records
            .map((record) => (record as Record<string, unknown>).message)
            .filter((message): message is string => typeof message === "string");

          expect(messages).toContain("local-and-remote-warn");
          expect(messages).not.toContain("local-only-info");
        });
      },
    );
  });

  it("normalizes args into indexed fields for OpenObserve", async () => {
    await withEnv(
      {
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
      },
      async () => {
        await withMockFetch(async (calls) => {
          const logger = createLogger({
            module: "logging-test",
            logLevel: "info",
            stdout: new MemoryWriteStream(),
            stderr: new MemoryWriteStream(),
          });

          logger.info(
            "structured-event",
            {
              adapterEventType: "adapter.message.updated",
              durationMs: 1,
              nested: { hello: "world" },
            },
            "second-arg",
            42,
          );
          await waitForAsyncLogging();

          const records = calls.flatMap((call) => parseJsonBody(call.init?.body));
          expect(records.length).toBe(1);

          const record = records[0] as Record<string, unknown>;
          expect(record.message).toBe("structured-event");
          expect(record.args).toBeUndefined();
          expect(record.argsCount).toBe(3);

          expect(record.arg0Type).toBe("object");
          expect(record.arg0_adapterEventType).toBe("adapter.message.updated");
          expect(record.arg0_durationMs).toBe(1);
          expect(record.arg0_nested).toBe('{"hello":"world"}');

          expect(record.arg1).toBe("second-arg");
          expect(record.arg2).toBe(42);
        });
      },
    );
  });

  it("writes an error to stderr when OpenObserve ingestion fails", async () => {
    await withEnv(
      {
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
        LILAC_LOG_OPENOBSERVE_BEARER_TOKEN: "bad-token",
      },
      async () => {
        await withCapturedStderr(async (stderrChunks) => {
          await withMockFetch(
            async (calls) => {
              const logger = createLogger({
                module: "logging-test",
                logLevel: "info",
                stdout: new MemoryWriteStream(),
                stderr: new MemoryWriteStream(),
              });

              logger.info("hello-failed-ingest");
              await waitForAsyncLogging();

              expect(calls.length).toBe(1);
              const stderrText = stderrChunks.join("");
              expect(stderrText).toContain("[openobserve]");
              expect(stderrText).toContain("401 Unauthorized");
              expect(stderrText).toContain("https://observe.example/api/default/lilac/_json");
            },
            () =>
              new Response('{"error":"invalid token"}', {
                status: 401,
                statusText: "Unauthorized",
              }),
          );
        });
      },
    );
  });

  it("mirrors generic fatal logs before local process exit", async () => {
    await withEnv(
      {
        LILAC_LOG_OPENOBSERVE_BASE_URL: "https://observe.example",
        LILAC_LOG_OPENOBSERVE_LEVEL: "fatal",
      },
      async () => {
        await withMockFetch(async (calls) => {
          const proc = process as unknown as {
            exit: (code?: number) => never;
          };
          const originalExit = proc.exit;
          proc.exit = ((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`);
          }) as (code?: number) => never;

          try {
            const logger = createLogger({
              module: "logging-test",
              logLevel: "info",
              stdout: new MemoryWriteStream(),
              stderr: new MemoryWriteStream(),
            });

            expect(() => logger.log("fatal", "fatal-event")).toThrow("process.exit:1");
            await waitForAsyncLogging();

            const records = calls.flatMap((call) => parseJsonBody(call.init?.body));
            expect(records.length).toBe(1);
            const record = records[0] as Record<string, unknown>;
            expect(record.level).toBe("fatal");
            expect(record.message).toBe("fatal-event");
          } finally {
            proc.exit = originalExit;
          }
        });
      },
    );
  });
});
