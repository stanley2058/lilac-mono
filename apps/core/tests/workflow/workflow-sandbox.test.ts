import { describe, expect, it } from "bun:test";

import { sha256 } from "../../src/workflow/workflow-definition";
import {
  assertWorkflowSandboxAvailable,
  startWorkflowSandbox,
} from "../../src/workflow/workflow-sandbox";
import { compileWorkflowSource } from "../../src/workflow/workflow-source-compiler";
import type { JsonValue } from "../../src/workflow/workflow-domain";

function source(runBody: string): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "sandbox-test",
  description: "Sandbox test",
  input: { type: "object", properties: {} },
  capabilities: { agents: { profiles: ["explore"], models: ["inherit"], maxConcurrent: 2, maxTotal: 10, editing: false, isolation: "shared" }, waits: ["reply", "sleep"] },
  async run({ args, agent, parallel, pipeline, phase, waitForReply, sleep }) { ${runBody} },
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

describe("workflow sandbox runtime", () => {
  it("fails closed with actionable dependency errors and no fallback", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(assertWorkflowSandboxAvailable()).rejects.toThrow(
        /install bwrap, systemd-run, systemctl.*unsandboxed execution is disabled/u,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
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

  it("transports reply and sleep host calls through the sandbox protocol", async () => {
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

  it("hides process/runtime/dynamic-code globals and has no filesystem, network, or shell mount", async () => {
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

  it("kills non-terminating JavaScript at the service runtime limit", async () => {
    const workflowSource = source("while (true) {} ");
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 1_000,
      onCall: async () => null,
    });
    await expect(sandbox.result).rejects.toThrow(/exited|signal|code/u);
  }, 10_000);

  it("kills JavaScript that exceeds the cgroup memory ceiling", async () => {
    const workflowSource = source(`
      const bytes = new Uint8Array(400 * 1024 * 1024);
      bytes.fill(1);
      return bytes.length;
    `);
    const sandbox = startWorkflowSandbox({
      source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
      args: {},
      maxWallTimeMs: 10_000,
      memoryBytes: 256 * 1024 * 1024,
      onCall: async () => null,
    });
    await expect(sandbox.result).rejects.toThrow(/exited|signal|code/u);
  }, 15_000);
});
