import { describe, expect, it } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../src/workflow/workflow-definition";
import {
  startWorkflowSandbox,
  type WorkflowSandboxRuntimeProbes,
} from "../../src/workflow/workflow-sandbox";
import {
  compileWorkflowSource,
  parseWorkflowCallSiteManifest,
} from "../../src/workflow/workflow-source-compiler";
import type { JsonValue } from "../../src/workflow/workflow-domain";

function source(runBody: string): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "sandbox-test",
  description: "Sandbox test",
  input: { type: "object", properties: {} },
  resources: { agents: { maxConcurrent: 2, maxTotal: 10 }, waits: ["reply", "sleep"] },
  async run({ args, agent, parallel, pipeline, phase, waitForReply, sleep }) { ${runBody} },
});`;
}

function composedSource(): string {
  return `import { defineWorkflow } from "@lilac/workflow";
const PREFIX = "helper";
async function invoke(agent, value) {
  return await agent(PREFIX + ":" + value);
}
export default defineWorkflow({
  name: "sandbox-test",
  description: "Sandbox test",
  input: { type: "object", properties: {} },
  resources: { agents: { maxConcurrent: 1, maxTotal: 1 }, waits: [] },
  async run({ agent }) { return await invoke(agent, "called"); },
});`;
}

async function execute(runBody: string) {
  const workflowSource = source(runBody);
  const calls: Array<{ kind: string; phase: string | null; path: string; input: unknown }> = [];
  const sandbox = startWorkflowSandbox({
    source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
    args: {},
    maxWallTimeMs: 10_000,
    onCall: async (call) => {
      calls.push(call);
      if (call.kind !== "agent") return null;
      const input = call.input;
      return typeof input === "object" && input !== null && "prompt" in input
        ? String(input.prompt)
        : "missing";
    },
  });
  return { result: await sandbox.result, calls };
}

function controlledRuntime(input: { exitOnSigterm?: boolean } = {}) {
  let spawnCount = 0;
  let spawnCommand: string[] = [];
  let closed = false;
  let settled = false;
  let resolveExit: (exitCode: number) => void = () => {};
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const writes: string[] = [];
  const killSignals: Array<"SIGTERM" | "SIGKILL"> = [];
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    stdoutController?.close();
    stderrController?.close();
  };
  const exit = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    close();
    resolveExit(exitCode);
  };
  const runtime: WorkflowSandboxRuntimeProbes = {
    spawn: (command) => {
      spawnCount += 1;
      spawnCommand = [...command];
      return {
        stdin: {
          write: (value) => {
            writes.push(value);
          },
          end: () => {},
        },
        stdout: new ReadableStream<Uint8Array>({
          start: (controller) => {
            stdoutController = controller;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start: (controller) => {
            stderrController = controller;
          },
        }),
        exited,
        kill: (signal) => {
          killSignals.push(signal);
          if (signal === "SIGKILL" || input.exitOnSigterm) exit(signal === "SIGKILL" ? 137 : 143);
        },
      };
    },
    sleep: Bun.sleep,
  };
  return {
    runtime,
    writes,
    killSignals,
    get spawnCount() {
      return spawnCount;
    },
    spawnCommand: () => spawnCommand,
    emit: (message: JsonValue) => {
      stdoutController?.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
    },
    emitStdout: (bytes: Uint8Array) => stdoutController?.enqueue(bytes),
    emitStderr: (bytes: Uint8Array) => stderrController?.enqueue(bytes),
    exit,
  };
}

describe("workflow source compilation", () => {
  it("instruments host calls made through same-file helpers", async () => {
    const workflowSource = composedSource();
    const compiled = compileWorkflowSource(workflowSource, sha256(workflowSource));
    expect(parseWorkflowCallSiteManifest(compiled)).toEqual([
      { kind: "agent", callSiteId: expect.stringMatching(/^wfcs:[a-f0-9]{32}$/u) },
    ]);
    const sandboxGlobal: { __lilacWorkflow?: { run(context: unknown): Promise<unknown> } } = {};
    const evaluate = Object.getPrototypeOf(async function () {}).constructor(
      "globalThis",
      `"use strict";\n${compiled}\nreturn globalThis.__lilacWorkflow;`,
    ) as (globalValue: typeof sandboxGlobal) => Promise<typeof sandboxGlobal.__lilacWorkflow>;
    const definition = await evaluate(sandboxGlobal);
    if (!definition) throw new Error("Compiled workflow definition is missing");
    const calls: Array<{ callSiteId: string; prompt: string }> = [];

    const result = await definition.run({
      agent: async (callSiteId: string, prompt: string) => {
        calls.push({ callSiteId, prompt });
        return prompt;
      },
    });

    expect(result).toBe("helper:called");
    expect(calls).toEqual([
      { callSiteId: expect.stringMatching(/^wfcs:[a-f0-9]{32}$/u), prompt: "helper:called" },
    ]);
  });
});

describe("workflow sandbox process protocol", () => {
  it("spawns the current Bun executable directly and writes one start message", async () => {
    const fake = controlledRuntime();
    const sandbox = startWorkflowSandbox({
      source: "compiled source",
      args: { value: 7 },
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });

    expect(fake.spawnCommand()).toEqual([
      process.execPath,
      "--smol",
      expect.stringMatching(/workflow-sandbox-child\.js$/u),
    ]);
    expect(fake.writes).toHaveLength(1);
    expect(JSON.parse(fake.writes[0] ?? "")).toEqual({
      type: "start",
      source: "compiled source",
      args: { value: 7 },
    });

    fake.emit({ type: "result", result: { ok: true } });
    fake.exit(0);
    await expect(sandbox.result).resolves.toEqual({ ok: true });
    expect(fake.writes).toHaveLength(1);
  });

  it("rejects forged call kinds at the parent manifest boundary", async () => {
    const fake = controlledRuntime({ exitOnSigterm: true });
    const workflowSource = source('return await agent("approved");');
    const compiled = compileWorkflowSource(workflowSource, sha256(workflowSource));
    const approved = parseWorkflowCallSiteManifest(compiled)[0];
    if (!approved) throw new Error("Expected compiled call site");
    const sandbox = startWorkflowSandbox({
      source: compiled,
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => {
        throw new Error("forged call reached the host");
      },
      runtimeProbes: fake.runtime,
    });
    fake.emit({
      type: "call",
      id: 1,
      kind: "sleep",
      callSiteId: approved.callSiteId,
      occurrence: 0,
      path: `root:${approved.callSiteId}:0`,
      parentPath: null,
      phase: null,
      depth: 0,
      input: { prompt: "forged", options: {} },
    });

    await expect(sandbox.result).rejects.toThrow("emitted unapproved call site");
    expect(fake.killSignals).toEqual(["SIGTERM"]);
  });

  it("terminates a child whose cumulative stdout exceeds the protocol limit", async () => {
    const fake = controlledRuntime({ exitOnSigterm: true });
    const sandbox = startWorkflowSandbox({
      source: "unused",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    fake.emitStdout(new Uint8Array(16 * 1024 * 1024 + 1));

    await expect(sandbox.result).rejects.toThrow("cumulative stdout exceeded limit");
  });

  it("terminates a child whose stderr exceeds its diagnostic limit", async () => {
    const fake = controlledRuntime({ exitOnSigterm: true });
    const sandbox = startWorkflowSandbox({
      source: "unused",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    fake.emitStderr(new Uint8Array(16 * 1024 + 1));

    await expect(sandbox.result).rejects.toThrow("stderr exceeded limit");
  });
});

describe("workflow sandbox cancellation", () => {
  it("does not spawn for a pre-aborted signal and returns shared settled cancellation", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");
    const fake = controlledRuntime();
    const sandbox = startWorkflowSandbox({
      source: "unused",
      args: {},
      maxWallTimeMs: 10_000,
      signal: controller.signal,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    const first = sandbox.cancel();
    const second = sandbox.cancel();

    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await expect(sandbox.result).rejects.toThrow(/cancelled/u);
    expect(fake.spawnCount).toBe(0);
    expect(fake.killSignals).toHaveLength(0);
  });

  it("sends SIGTERM, escalates to SIGKILL, and shares cancellation", async () => {
    const fake = controlledRuntime();
    const sandbox = startWorkflowSandbox({
      source: "while (true) {}",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    const first = sandbox.cancel();
    const second = sandbox.cancel();

    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await expect(sandbox.result).rejects.toThrow(/cancelled/u);
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancels a busy child from an AbortSignal", async () => {
    const workflowSource = source("while (true) {} ");
    const controller = new AbortController();
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 10_000,
      signal: controller.signal,
      onCall: async () => null,
    });
    await Bun.sleep(50);
    controller.abort();

    await expect(sandbox.result).rejects.toThrow(/cancelled/u);
  }, 5_000);
});

describe("workflow sandbox runtime", () => {
  it("rejects concurrent reuse of one helper host-call site", async () => {
    const workflowSource = `import { defineWorkflow } from "@lilac/workflow";
async function invoke(agent, prompt) { return await agent(prompt); }
export default defineWorkflow({
  name: "sandbox-test",
  description: "Sandbox test",
  input: { type: "object", properties: {} },
  resources: { agents: { maxConcurrent: 2, maxTotal: 2 }, waits: [] },
  async run({ agent }) { return await Promise.all([invoke(agent, "a"), invoke(agent, "b")]); },
});`;
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => {
        await Bun.sleep(20);
        return "completed";
      },
    });

    await expect(sandbox.result).rejects.toThrow("Concurrent workflow call-site reuse");
  });

  it("rejects a forged call-site ID inside the child boundary", async () => {
    const workflowSource = source('return await agent("approved");');
    const compiled = compileWorkflowSource(workflowSource, sha256(workflowSource));
    const approved = parseWorkflowCallSiteManifest(compiled)[0];
    if (!approved) throw new Error("Expected compiled call site");
    const forged = compiled.replace(approved.callSiteId, `wfcs:${"0".repeat(32)}`);
    const sandbox = startWorkflowSandbox({
      source: forged,
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => {
        throw new Error("forged call escaped child boundary");
      },
    });

    await expect(sandbox.result).rejects.toThrow("attempted unapproved call site");
  });

  it("protects transport primordials and exposes only deterministic globals", async () => {
    const { result, calls } = await execute(`
      const protectedValues = [];
      for (const mutate of [
        () => { JSON.stringify = () => '{"type":"result","result":"forged"}'; },
        () => { Map.prototype.get = () => "forged"; },
        () => { Object.prototype.toJSON = () => ({ type: "result", result: "forged" }); },
      ]) {
        try { mutate(); protectedValues.push(false); } catch { protectedValues.push(true); }
      }
      const agentResult = await agent("transport-safe");
      return {
        protectedValues,
        agentResult,
        intl: typeof Intl,
        abortSignal: typeof AbortSignal,
        atomics: typeof Atomics,
        sharedArrayBuffer: typeof SharedArrayBuffer,
      };
    `);

    expect(result).toEqual({
      protectedValues: [true, true, true],
      agentResult: "transport-safe",
      intl: "undefined",
      abortSignal: "undefined",
      atomics: "undefined",
      sharedArrayBuffer: "undefined",
    });
    expect(calls.filter((call) => call.kind === "agent")).toHaveLength(1);
  });

  it("executes instrumented host calls through same-file helpers deterministically", async () => {
    const workflowSource = composedSource();
    const executeHelper = async () => {
      const calls: Array<{ callSiteId: string; path: string; prompt: string }> = [];
      const sandbox = startWorkflowSandbox({
        source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
        args: {},
        maxWallTimeMs: 10_000,
        onCall: async (call) => {
          const input = call.input;
          const prompt =
            typeof input === "object" && input !== null && "prompt" in input
              ? String(input.prompt)
              : "missing";
          calls.push({ callSiteId: call.callSiteId, path: call.path, prompt });
          return prompt;
        },
      });
      return { result: await sandbox.result, calls };
    };

    const first = await executeHelper();
    const replay = await executeHelper();
    expect(first.result).toBe("helper:called");
    expect(first.calls).toEqual([
      {
        callSiteId: expect.stringMatching(/^wfcs:[a-f0-9]{32}$/u),
        path: expect.stringMatching(/^root:wfcs:[a-f0-9]{32}:0$/u),
        prompt: "helper:called",
      },
    ]);
    expect(replay).toEqual(first);
  });

  it("locks globals before evaluating direct compiled workflow source", async () => {
    const sandbox = startWorkflowSandbox({
      source: `
        const capturedTopLevelThis = this;
        const capturedBun = Bun;
        const capturedProcess = process;
        const capturedDate = Date;
        const escapeUnavailable = (constructor) => {
          try {
            return constructor("return this")() === undefined;
          } catch {
            return true;
          }
        };
        const evaluation = {
          topLevelThisUnavailable: capturedTopLevelThis === undefined,
          bunUnavailable: capturedBun === undefined,
          processUnavailable: capturedProcess === undefined,
          dateUnavailable: capturedDate === undefined,
          objectConstructorEscapeUnavailable: escapeUnavailable(({}).constructor?.constructor),
          functionConstructorEscapeUnavailable: escapeUnavailable((function () {}).constructor),
        };
        globalThis.__lilacWorkflow = {
          async run() {
            return { ...evaluation, transport: "ok" };
          },
        };
      `,
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
    });

    await expect(sandbox.result).resolves.toEqual({
      topLevelThisUnavailable: true,
      bunUnavailable: true,
      processUnavailable: true,
      dateUnavailable: true,
      objectConstructorEscapeUnavailable: true,
      functionConstructorEscapeUnavailable: true,
      transport: "ok",
    });
  });

  it("does not resolve Bun from a hostile PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lilac-hostile-path-"));
    const sentinel = join(directory, "launcher-ran");
    const fakeBun = join(directory, "bun");
    const originalPath = process.env.PATH;
    try {
      await writeFile(fakeBun, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 99\n`);
      await chmod(fakeBun, 0o755);
      process.env.PATH = directory;

      await expect(execute("return 42;")).resolves.toMatchObject({ result: 42 });
      expect(
        await access(sentinel).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports branches, loops, pipelines, parallel calls, phases, and stable call sites", async () => {
    const runBody = `
      const prefix = args.missing ? "bad" : "item";
      const loop = [];
      for (let i = 0; i < 2; i++) loop.push(await agent(prefix + i));
      const piped = await phase("verify", () => pipeline([2, 3], (item) => agent("p" + item), { concurrency: 2 }));
      const joined = await parallel([agent("a"), agent("b")]);
      return { loop, piped, joined };
    `;
    const first = await execute(runBody);
    const second = await execute(runBody);
    expect(first.result).toEqual({
      loop: ["item0", "item1"],
      piped: ["p2", "p3"],
      joined: ["a", "b"],
    });
    expect(first.calls.some((call) => call.kind === "pipeline")).toBe(true);
    expect(first.calls.some((call) => call.kind === "parallel")).toBe(true);
    expect(first.calls.filter((call) => call.phase === "verify")).toHaveLength(3);
    expect(first.calls.map((call) => call.path)).toEqual(second.calls.map((call) => call.path));
  });

  it("transports reply and sleep host calls through NDJSON", async () => {
    const workflowSource = source(`
      const reply = await waitForReply({ messageId: "anchor", timeoutMs: 1000 });
      const slept = await sleep(25);
      return { reply, slept };
    `);
    const calls: string[] = [];
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async (call): Promise<JsonValue> => {
        calls.push(call.kind);
        if (call.kind === "waitForReply") return { text: "continue" };
        return { kind: "sleep" };
      },
    });
    await expect(sandbox.result).resolves.toEqual({
      reply: { text: "continue" },
      slept: { kind: "sleep" },
    });
    expect(calls).toEqual(["waitForReply", "sleep"]);
  });

  it("hides process/runtime/dynamic-code globals and denies randomness", async () => {
    const { result } = await execute(`
      const constructor = Object.getPrototypeOf(async function() {}).constructor;
      return {
        bun: typeof globalThis.Bun,
        process: typeof globalThis.process,
        fetch: typeof globalThis.fetch,
        worker: typeof globalThis.Worker,
        crypto: typeof globalThis.crypto,
        global: typeof global,
        require: typeof require,
        randomDenied: (() => { try { Math.random(); return false; } catch { return true; } })(),
        constructorDenied: constructor === undefined,
      };
    `);
    expect(result).toEqual({
      bun: "undefined",
      process: "undefined",
      fetch: "undefined",
      worker: "undefined",
      crypto: "undefined",
      global: "undefined",
      require: "undefined",
      randomDenied: true,
      constructorDenied: true,
    });
  });

  it("kills non-terminating JavaScript at the host wall-time limit", async () => {
    const workflowSource = source("while (true) {} ");
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 250,
      onCall: async () => null,
    });

    await expect(sandbox.result).rejects.toThrow("timed out after 250ms");
  }, 5_000);
});
