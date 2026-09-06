import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Panic } from "better-result";
import { env } from "../env";
import { createLlmWireDebugTrace, withLlmWireDebugFetch } from "../llm-wire-debug";

const originalSettings = { ...env.debug.llmWire };
let directory: string;
const restore: Array<() => void> = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-wire-debug-test-"));
  Object.assign(env.debug.llmWire, {
    enabled: true,
    dir: path.join(directory, "traces"),
    maxBodyBytes: 65_536,
    maxEvents: 400,
  });
});

afterEach(async () => {
  for (const reset of restore.splice(0)) reset();
  Object.assign(env.debug.llmWire, originalSettings);
  await fs.rm(directory, { recursive: true, force: true });
});

async function readTrace() {
  const files = await fs.readdir(env.debug.llmWire.dir);
  expect(files).toHaveLength(1);
  const text = await fs.readFile(path.join(env.debug.llmWire.dir, files[0]!), "utf8");
  return {
    text,
    entries: text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

describe("native LLM wire traces", () => {
  it("does not create a directory for an enabled trace that receives no events", async () => {
    const trace = createLlmWireDebugTrace({ provider: "openai" });
    await trace.flush();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("does no serialization or file IO when disabled", async () => {
    Object.assign(env.debug.llmWire, { enabled: false });
    const payload = {
      get content() {
        throw new Error("must not inspect payload");
      },
    };
    const trace = createLlmWireDebugTrace({ provider: "openai" });
    trace.write("request", payload);
    await trace.flush();
    expect(await fs.readdir(directory)).toEqual([]);
    const fetchFn = globalThis.fetch;
    expect(withLlmWireDebugFetch({ provider: "openai", fetchFn })).toBe(fetchFn);
  });

  it("snapshots redacted payload and correlation synchronously without mutating inputs", async () => {
    const context = { requestId: "request-1", sessionId: "session-1", apiKey: "fake-key" };
    const details = { connectionId: 4, attemptId: "attempt-1", token: "fake-token" };
    const payload = {
      type: "response.create",
      authorization: "Bearer fake-credential",
      response: { model: "example-model", input: [{ role: "user", content: "original" }] },
      client_metadata: { "x-codex-turn-state": "fake-turn-state", request_id: "request-1" },
      error: "Invalid credential sk-example12345678 at https://provider.invalid/?token=fake-query",
    };
    const trace = createLlmWireDebugTrace({ provider: "codex", context });
    trace.write("request", payload, details);
    expect(payload.authorization).toBe("Bearer fake-credential");
    expect(payload.client_metadata["x-codex-turn-state"]).toBe("fake-turn-state");
    payload.response.input[0]!.content = "changed";
    context.requestId = "changed";
    details.connectionId = 8;
    trace.write("complete", { responseId: "response-1" });
    await trace.flush();
    const { text, entries } = await readTrace();
    expect(entries.map((entry) => entry.event)).toEqual(["request", "complete"]);
    expect(entries[0].context).toEqual({
      requestId: "request-1",
      sessionId: "session-1",
      apiKey: "<redacted>",
    });
    expect(entries[0].details).toEqual({
      connectionId: 4,
      attemptId: "attempt-1",
      token: "<redacted>",
    });
    expect(entries[0].data.response.input[0].content).toBe("original");
    expect(entries[0].data.authorization).toBe("<redacted>");
    expect(entries[0].data.client_metadata).toEqual({
      "x-codex-turn-state": "<redacted>",
      request_id: "request-1",
    });
    expect(entries[0].data.error).toBe(
      "Invalid credential <redacted> at https://provider.invalid/",
    );
    expect(entries[0].traceId).toBe(entries[1].traceId);
    expect(text).not.toContain("fake-");
  });

  it("limits events and redacts before limiting payload bytes", async () => {
    Object.assign(env.debug.llmWire, { maxEvents: 2, maxBodyBytes: 96 });
    const trace = createLlmWireDebugTrace({ provider: "openai" });
    trace.write("request", { api_key: "fake-credential", content: "😀".repeat(100) });
    trace.write("response", { type: "response.created" });
    trace.write("ignored", {
      get value() {
        throw new Error("must not inspect excess event");
      },
    });
    trace.write("also-ignored", {});
    await trace.flush();
    const { text, entries } = await readTrace();
    expect(entries.map((entry) => entry.event)).toEqual([
      "request",
      "response",
      "trace.events_truncated",
    ]);
    expect(entries[0].data.truncated).toBe(true);
    expect(entries[0].data.originalBytes).toBeGreaterThan(96);
    expect(Buffer.byteLength(entries[0].data.preview)).toBeLessThanOrEqual(96);
    expect(text).not.toContain("fake-credential");
    expect(entries[2].data).toEqual({ maxEvents: 2 });
  });

  it("disables an unwritable trace and tolerates an ordinary warning callback failure", async () => {
    const blocked = path.join(directory, "blocked");
    await fs.writeFile(blocked, "regular file");
    Object.assign(env.debug.llmWire, { dir: path.join(blocked, "traces") });
    let warnings = 0;
    const trace = createLlmWireDebugTrace({
      provider: "openai",
      warn() {
        warnings += 1;
        throw new Error("logger unavailable");
      },
    });
    trace.write("request", {});
    trace.write("complete", {});
    await trace.flush();
    expect(warnings).toBe(1);
  });

  it("stops appending after the first IO failure and does not fail execution", async () => {
    const append = spyOn(fs, "appendFile").mockRejectedValue(new Error("disk full"));
    restore.push(() => append.mockRestore());
    let warnings = 0;
    const trace = createLlmWireDebugTrace({
      provider: "openai",
      warn() {
        warnings += 1;
        throw new Error("logger unavailable");
      },
    });
    trace.write("request", {});
    trace.write("complete", {});
    await trace.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(warnings).toBe(1);
  });

  it("tolerates unreadable payloads while preserving a payload Panic", async () => {
    const trace = createLlmWireDebugTrace({ provider: "openai" });
    trace.write("request", {
      get value() {
        throw new Error("bad getter");
      },
    });
    const panic = new Panic({ message: "trace payload invariant" });
    expect(() =>
      trace.write("response", {
        get value() {
          throw panic;
        },
      }),
    ).toThrow(panic);
    await trace.flush();
    expect((await readTrace()).entries[0].data).toBe("<unserializable>");
  });

  it("preserves a warning callback Panic at flush", async () => {
    const append = spyOn(fs, "appendFile").mockRejectedValue(new Error("disk full"));
    restore.push(() => append.mockRestore());
    const panic = new Panic({ message: "trace logger invariant" });
    const trace = createLlmWireDebugTrace({
      provider: "openai",
      warn() {
        throw panic;
      },
    });
    trace.write("request", {});
    await expect(trace.flush()).rejects.toBe(panic);
  });

  for (const failure of ["append", "append-warning", "create", "create-warning"] as const) {
    it(`retains ${failure} Panic until a delayed flush without unhandled rejection`, async () => {
      const observed = Promise.withResolvers<void>();
      const panic = new Panic({ message: "trace asynchronous invariant" });
      const unhandled: unknown[] = [];
      const onUnhandled = (cause: unknown) => {
        unhandled.push(cause);
      };
      process.on("unhandledRejection", onUnhandled);
      restore.push(() => process.off("unhandledRejection", onUnhandled));
      const ioFailure = async () => {
        if (failure === "append-warning" || failure === "create-warning") {
          throw new Error("trace IO unavailable");
        }
        observed.resolve();
        throw panic;
      };
      if (failure === "create" || failure === "create-warning") {
        const mkdir = spyOn(fs, "mkdir").mockImplementation(ioFailure);
        restore.push(() => mkdir.mockRestore());
      } else {
        const append = spyOn(fs, "appendFile").mockImplementation(ioFailure);
        restore.push(() => append.mockRestore());
      }
      let warnings = 0;
      const trace = createLlmWireDebugTrace({
        provider: "openai",
        warn() {
          warnings += 1;
          observed.resolve();
          throw panic;
        },
      });
      trace.write("request", {});
      await observed.promise;
      // Cross the rejection-reporting turn before attaching a flush rejection handler.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      trace.write("response", {});
      await expect(trace.flush()).rejects.toBe(panic);
      expect(warnings).toBe(failure.endsWith("warning") ? 1 : 0);
    });
  }
});

describe("legacy fetch LLM wire traces", () => {
  it("retains request/header/SSE/completion event shapes and leaves the response readable", async () => {
    Object.assign(env.debug.llmWire, { maxEvents: 1 });
    const completed = Promise.withResolvers<void>();
    const appendFile = fs.appendFile.bind(fs);
    const append = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      await appendFile(...args);
      if (JSON.parse(String(args[1])).event === "response.complete") completed.resolve();
    });
    restore.push(() => append.mockRestore());
    const sse = 'data: {"type":"response.created","token":"fake-token"}\n\ndata: [DONE]\n\n';
    const requestBody = JSON.stringify({ model: "example-model", api_key: "fake-key" });
    const fetchFn = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.body).toBe(requestBody);
      return new Response(sse, {
        headers: { "content-type": "text/event-stream", "set-cookie": "fake-cookie" },
      });
    }) as typeof fetch;
    const response = await withLlmWireDebugFetch({ provider: "openai", fetchFn })(
      "https://provider.invalid/v1/responses",
      { method: "POST", headers: { authorization: "Bearer fake-auth" }, body: requestBody },
    );
    expect(await response.text()).toBe(sse);
    await completed.promise;
    const { text, entries } = await readTrace();
    expect(entries.map((entry) => entry.event)).toEqual([
      "request",
      "response.headers",
      "response.sse.event",
      "response.sse.events_truncated",
      "response.complete",
    ]);
    expect(entries[0].data.body).toEqual({
      kind: "json",
      truncated: false,
      value: { model: "example-model", api_key: "<redacted>" },
    });
    expect(entries[2].data).toEqual({
      index: 1,
      eventType: "response.created",
      payload: { type: "response.created", token: "<redacted>" },
    });
    expect(entries[4].data).toMatchObject({ transport: "sse", eventCount: 2 });
    expect(text).not.toContain("fake-");
  });
});
