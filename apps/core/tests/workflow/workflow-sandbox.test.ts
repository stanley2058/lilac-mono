import { describe, expect, it } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../src/workflow/workflow-definition";
import {
  assertWorkflowSandboxAvailable,
  runWorkflowSandboxPreflightCommand,
  startWorkflowSandbox,
  type WorkflowSandboxPreflightProbes,
  type WorkflowSandboxRuntimeProbes,
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

const successfulCommand = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
};

const MANAGER_CONTROL_GROUP = "/user.slice/user-1000.slice/user@1000.service";
const UNIT_CONTROL_GROUP = `${MANAGER_CONTROL_GROUP}/app.slice/lilac-workflow-preflight-test.service`;

function preflightProbes(
  overrides: Partial<WorkflowSandboxPreflightProbes> = {},
): WorkflowSandboxPreflightProbes {
  let now = 0;
  return {
    platform: "linux",
    inspectExecutable: async () => null,
    readFile: async (filePath) => {
      if (filePath.endsWith("/memory.max")) return "268435456\n";
      if (filePath.endsWith("/memory.swap.max")) return "0\n";
      if (filePath.endsWith("/pids.max")) return "16\n";
      return "cpu memory pids\n";
    },
    run: async (command) => {
      if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
        return {
          ...successfulCommand,
          stdout: `${command.includes("lilac-workflow-preflight-test") ? UNIT_CONTROL_GROUP : MANAGER_CONTROL_GROUP}\n`,
        };
      }
      if (command.includes("is-active")) return { ...successfulCommand, stdout: "active\n" };
      if (command.includes("--property=ActiveState")) {
        return { ...successfulCommand, stdout: "inactive\n" };
      }
      return successfulCommand;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    createUnitName: () => "lilac-workflow-preflight-test",
    ...overrides,
  };
}

describe("workflow sandbox preflight", () => {
  it("bounds process exit and output closure with one command timeout", async () => {
    let killed = false;
    const output = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode("partial output")),
    });
    const command = runWorkflowSandboxPreflightCommand(["fake-command"], 10, () => ({
      stdout: output,
      stderr: new ReadableStream<Uint8Array>(),
      exited: Promise.resolve(0),
      kill: () => {
        killed = true;
      },
    }));

    const outcome = await Promise.race([
      command,
      Bun.sleep(250).then(() => "command did not settle" as const),
    ]);
    expect(outcome).not.toBe("command did not settle");
    if (outcome === "command did not settle") throw new Error(outcome);
    expect(outcome).toEqual({
      exitCode: -1,
      stdout: "partial output",
      stderr: "",
      timedOut: true,
    });
    expect(killed).toBe(true);
  });

  for (const missingCommand of ["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"]) {
    it(`fails closed when ${missingCommand} is missing or unsafe`, async () => {
      const probes = preflightProbes({
        inspectExecutable: async (filePath) =>
          filePath === missingCommand ? "is not a regular file" : null,
      });
      await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
        new RegExp(`required executable ${missingCommand} is not a regular file.*unsandboxed`, "u"),
      );
    });
  }

  it("rejects a host without cgroup v2", async () => {
    const probes = preflightProbes({
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /cgroup v2 is not mounted.*ENOENT.*unsandboxed/u,
    );
  });

  for (const missingController of ["memory", "pids"]) {
    it(`rejects a user manager without delegated ${missingController}`, async () => {
      const probes = preflightProbes({
        readFile: async (filePath) =>
          filePath === "/sys/fs/cgroup/cgroup.controllers"
            ? "cpu memory pids\n"
            : `cpu ${missingController === "memory" ? "pids" : "memory"}\n`,
      });
      await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
        new RegExp(`not delegated required controllers: ${missingController}.*unsandboxed`, "u"),
      );
    });
  }

  it("rejects an unavailable current-user systemd manager", async () => {
    const probes = preflightProbes({
      run: async (command) =>
        command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")
          ? { ...successfulCommand, exitCode: 1, stderr: "Failed to connect to bus" }
          : successfulCommand,
    });
    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /current-user systemd manager is not reachable.*Failed to connect to bus.*unsandboxed/u,
    );
  });

  it("rejects a failed transient bwrap probe and cleans up its unit", async () => {
    const commands: string[][] = [];
    const probes = preflightProbes({
      run: async (command) => {
        commands.push([...command]);
        if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
          return {
            ...successfulCommand,
            stdout: `${command.includes("lilac-workflow-preflight-test") ? UNIT_CONTROL_GROUP : MANAGER_CONTROL_GROUP}\n`,
          };
        }
        if (command[0] === "/usr/bin/systemd-run") {
          return {
            ...successfulCommand,
            exitCode: 1,
            stderr: "No permissions to create namespace",
          };
        }
        if (command.includes("--property=ActiveState")) {
          return { ...successfulCommand, stdout: "inactive\n" };
        }
        return successfulCommand;
      },
    });
    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /disposable systemd\/bwrap sandbox probe exited with code 1.*user namespaces.*unsandboxed/u,
    );
    expect(commands).toContainEqual([
      "/usr/bin/systemctl",
      "--user",
      "stop",
      "lilac-workflow-preflight-test",
    ]);
    expect(commands).toContainEqual([
      "/usr/bin/systemctl",
      "--user",
      "reset-failed",
      "lilac-workflow-preflight-test",
    ]);
  });

  it("surfaces a bounded transient-unit cleanup failure", async () => {
    const probes = preflightProbes({
      run: async (command) => {
        if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
          return {
            ...successfulCommand,
            stdout: `${command.includes("lilac-workflow-preflight-test") ? UNIT_CONTROL_GROUP : MANAGER_CONTROL_GROUP}\n`,
          };
        }
        if (command[0] === "/usr/bin/systemctl" && command.includes("stop")) {
          return { ...successfulCommand, exitCode: -1, timedOut: true };
        }
        if (command.includes("--property=ActiveState")) {
          return { ...successfulCommand, stdout: "active\n" };
        }
        return successfulCommand;
      },
    });
    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /could not clean up transient preflight unit lilac-workflow-preflight-test \(stable inactive or absent state was not observed.*cleanup command failed: stop timed out.*RuntimeMaxSec=10s.*\/usr\/bin\/systemctl --user stop.*unsandboxed/u,
    );
  });

  it("surfaces failure when cleanup never observes a stable inactive state", async () => {
    const probes = preflightProbes({
      run: async (command) => {
        if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
          return {
            ...successfulCommand,
            stdout: `${command.includes("lilac-workflow-preflight-test") ? UNIT_CONTROL_GROUP : MANAGER_CONTROL_GROUP}\n`,
          };
        }
        if (command.includes("is-active")) return { ...successfulCommand, stdout: "active\n" };
        if (command.includes("--property=ActiveState")) {
          return { ...successfulCommand, stdout: "active\n" };
        }
        return successfulCommand;
      },
    });

    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /stable inactive or absent state was not observed within 3000ms.*RuntimeMaxSec=10s remains the final self-termination bound/u,
    );
  });

  it("accepts delegated controllers and a successful behavioral sandbox probe", async () => {
    const commands: string[][] = [];
    const probes = preflightProbes({
      run: async (command, timeoutMs) => {
        commands.push([...command, String(timeoutMs)]);
        if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
          return {
            ...successfulCommand,
            stdout: `${command.includes("lilac-workflow-preflight-test") ? UNIT_CONTROL_GROUP : MANAGER_CONTROL_GROUP}\n`,
          };
        }
        if (command.includes("is-active")) return { ...successfulCommand, stdout: "active\n" };
        if (command.includes("--property=ActiveState")) {
          return { ...successfulCommand, stdout: "inactive\n" };
        }
        return successfulCommand;
      },
    });
    await expect(assertWorkflowSandboxAvailable(probes)).resolves.toBeUndefined();
    const transient = commands.find((command) => command[0] === "/usr/bin/systemd-run");
    expect(transient).toContain("MemoryMax=268435456");
    expect(transient).toContain("MemorySwapMax=0");
    expect(transient).toContain("TasksMax=16");
    expect(transient).toContain("--unshare-all");
    expect(transient).toContain("/usr/bin/bwrap");
    expect(transient).toContain("--proc");
    expect(commands.every((command) => command[0]?.startsWith("/usr/bin/"))).toBe(true);
  });

  it("rejects a transient unit outside the manager ControlGroup", async () => {
    const probes = preflightProbes({
      run: async (command) => {
        if (command[0] === "/usr/bin/systemctl" && command.includes("--property=ControlGroup")) {
          return {
            ...successfulCommand,
            stdout: command.includes("lilac-workflow-preflight-test")
              ? "/system.slice/escaped.service\n"
              : `${MANAGER_CONTROL_GROUP}\n`,
          };
        }
        return command.includes("--property=ActiveState")
          ? { ...successfulCommand, stdout: "inactive\n" }
          : successfulCommand;
      },
    });
    await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
      /not a strict descendant of manager ControlGroup/u,
    );
  });

  for (const [property, actual] of [
    ["memory.max", "max"],
    ["memory.swap.max", "max"],
    ["pids.max", "512"],
  ] as const) {
    it(`rejects a transient unit that did not apply ${property}`, async () => {
      const probes = preflightProbes({
        readFile: async (filePath) => {
          if (filePath.endsWith(`/${property}`)) return `${actual}\n`;
          if (filePath.endsWith("/memory.max")) return "268435456\n";
          if (filePath.endsWith("/memory.swap.max")) return "0\n";
          if (filePath.endsWith("/pids.max")) return "16\n";
          return "cpu memory pids\n";
        },
      });
      await expect(assertWorkflowSandboxAvailable(probes)).rejects.toThrow(
        new RegExp(`did not apply ${property.replace(".", "\\.")}`, "u"),
      );
    });
  }

  const integrationIt = process.env.LILAC_WORKFLOW_SANDBOX_INTEGRATION === "1" ? it : it.skip;
  integrationIt("passes the live systemd, cgroup, and bwrap integration preflight", async () => {
    await expect(assertWorkflowSandboxAvailable()).resolves.toBeUndefined();
  });
});

describe("workflow sandbox unit-start handshake", () => {
  function controlledRuntime() {
    let now = 0;
    let resolveActive: (result: typeof successfulCommand) => void = () => {};
    let resolveExit: (exitCode: number) => void = () => {};
    let resolveFirstWrite: () => void = () => {};
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const writes: string[] = [];
    const commands: string[][] = [];
    const activeProbe = new Promise<typeof successfulCommand>((resolve) => {
      resolveActive = resolve;
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const runtime: WorkflowSandboxRuntimeProbes = {
      spawn: () => ({
        stdin: {
          write: (value) => {
            writes.push(value);
            resolveFirstWrite();
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
        kill: () => {},
      }),
      run: async (command) => {
        commands.push([...command]);
        if (command.includes("is-active")) return activeProbe;
        if (command.includes("--property=ActiveState")) {
          return {
            ...successfulCommand,
            exitCode: 1,
            stderr: "Unit lilac-workflow-handshake-test.service could not be found",
          };
        }
        return {
          ...successfulCommand,
          exitCode: 1,
          stderr: "Unit lilac-workflow-handshake-test.service could not be found",
        };
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      createUnitName: () => "lilac-workflow-handshake-test",
    };
    return {
      runtime,
      writes,
      commands,
      firstWrite,
      activate: () => resolveActive({ ...successfulCommand, stdout: "active\n" }),
      finish: (result: JsonValue) => {
        stdoutController?.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ type: "result", result })}\n`),
        );
        stdoutController?.close();
        stderrController?.close();
        resolveExit(0);
      },
      exit: (exitCode: number) => {
        stdoutController?.close();
        stderrController?.close();
        resolveExit(exitCode);
      },
    };
  }

  it("does not write workflow source before the exact unit is active", async () => {
    const fake = controlledRuntime();
    const sandbox = startWorkflowSandbox({
      source: "held source",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });

    expect(fake.commands[0]).toEqual([
      "/usr/bin/systemctl",
      "--user",
      "is-active",
      "lilac-workflow-handshake-test",
    ]);
    expect(fake.writes).toHaveLength(0);

    fake.exit(1);
    await expect(sandbox.result).rejects.toThrow(/launcher exited with code 1 before unit/u);
    expect(fake.writes).toHaveLength(0);
  });

  it("writes start exactly once after activation and allows the workflow result", async () => {
    const fake = controlledRuntime();
    const sandbox = startWorkflowSandbox({
      source: "active source",
      args: { value: 7 },
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });

    expect(fake.writes).toHaveLength(0);
    fake.activate();
    await fake.firstWrite;
    expect(fake.writes).toHaveLength(1);
    expect(JSON.parse(fake.writes[0] ?? "")).toEqual({
      type: "start",
      source: "active source",
      args: { value: 7 },
    });

    fake.finish({ ok: true });
    await expect(sandbox.result).resolves.toEqual({ ok: true });
    expect(fake.writes).toHaveLength(1);
  });
});

describe("workflow sandbox cancellation", () => {
  function fakeRuntime(
    input: { unitNeverStops?: boolean; lateUnitAppears?: boolean; onStatus?: () => void } = {},
  ) {
    let now = 0;
    let launcherSettled = false;
    let streamsClosed = false;
    let spawnCount = 0;
    let stopCount = 0;
    let statusCount = 0;
    const statusStates: string[] = [];
    let resolveExit: (exitCode: number) => void = () => {};
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const killSignals: string[] = [];
    const commands: string[][] = [];
    const writes: string[] = [];
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const closeLauncherStreams = (): void => {
      if (streamsClosed) return;
      streamsClosed = true;
      stdoutController?.close();
      stderrController?.close();
    };
    const settleLauncher = (): void => {
      if (launcherSettled) return;
      launcherSettled = true;
      resolveExit(137);
    };
    const finishLauncher = (): void => {
      settleLauncher();
      closeLauncherStreams();
    };
    const runtime: WorkflowSandboxRuntimeProbes = {
      spawn: () => {
        spawnCount += 1;
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
              if (streamsClosed) controller.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start: (controller) => {
              stderrController = controller;
              if (streamsClosed) controller.close();
            },
          }),
          exited: exitedPromise,
          kill: (signal) => {
            killSignals.push(signal);
          },
        };
      },
      run: async (command) => {
        commands.push([...command]);
        if (command.includes("stop")) stopCount += 1;
        if (command.includes("--property=ActiveState")) {
          statusCount += 1;
          input.onStatus?.();
          if (input.unitNeverStops) {
            statusStates.push("active");
            return { ...successfulCommand, stdout: "active\n" };
          }
          if (input.lateUnitAppears && statusCount === 2) {
            statusStates.push("active");
            return { ...successfulCommand, stdout: "active\n" };
          }
          statusStates.push("absent");
          return {
            ...successfulCommand,
            exitCode: 1,
            stderr: "Unit lilac-workflow-cancel-test.service could not be found",
          };
        }
        return {
          ...successfulCommand,
          exitCode: 1,
          stderr: "Unit lilac-workflow-cancel-test.service could not be found",
        };
      },
      now: () => {
        if (input.unitNeverStops) now += 100;
        return now;
      },
      sleep: async (ms) => {
        now += ms;
      },
      createUnitName: () => "lilac-workflow-cancel-test",
    };
    return {
      runtime,
      commands,
      killSignals,
      statusStates,
      writes,
      closeLauncherStreams,
      finishLauncher,
      settleLauncher,
      get spawnCount() {
        return spawnCount;
      },
      get statusCount() {
        return statusCount;
      },
      get stopCount() {
        return stopCount;
      },
    };
  }

  it("does not spawn for a pre-aborted signal and returns shared settled cancellation", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");
    const fake = fakeRuntime();
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
    const resultExpectation = expect(sandbox.result).rejects.toThrow(/cancelled/u);
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await resultExpectation;
    expect(fake.spawnCount).toBe(0);
    expect(fake.commands).toHaveLength(0);
    expect(fake.killSignals).toHaveLength(0);
  });

  it("never writes source when a unit appears late after launcher exit", async () => {
    const fake = fakeRuntime({
      lateUnitAppears: true,
    });
    const sandbox = startWorkflowSandbox({
      source: "must not execute",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    const resultError = sandbox.result.then(
      () => new Error("Expected sandbox result to reject"),
      (error: unknown) => error,
    );
    fake.finishLauncher();
    const error = await resultError;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected sandbox result error");
    expect(error.message).toMatch(/launcher exited with code 137 before unit/u);
    expect(fake.writes).toHaveLength(0);
    expect(fake.statusStates.slice(0, 3)).toEqual(["absent", "active", "absent"]);
    expect(fake.statusCount).toBeGreaterThan(2);
    expect(fake.stopCount).toBeGreaterThan(2);
    expect(fake.commands.some((command) => command.includes("--kill-whom=all"))).toBe(true);
  });

  it("settles the result with a bounded cleanup failure", async () => {
    const fake = fakeRuntime({ unitNeverStops: true });
    const sandbox = startWorkflowSandbox({
      source: "unused",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    const resultError = sandbox.result.then(
      () => new Error("Expected sandbox result to reject"),
      (error: unknown) => error,
    );
    const cancellation = sandbox.cancel();
    try {
      await expect(cancellation).rejects.toThrow(
        /could not clean up transient unit.*within 3000ms/u,
      );
      const error = await resultError;
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected sandbox result error");
      expect(error.message).toMatch(/could not clean up transient unit.*within 3000ms/u);
    } finally {
      fake.finishLauncher();
    }
  });

  it("preserves cleanup failure after launcher streams close", async () => {
    const fake = fakeRuntime({ unitNeverStops: true });
    const sandbox = startWorkflowSandbox({
      source: "unused",
      args: {},
      maxWallTimeMs: 10_000,
      onCall: async () => null,
      runtimeProbes: fake.runtime,
    });
    const resultError = sandbox.result.catch((error: unknown) => error);
    const cancellation = sandbox.cancel();
    fake.settleLauncher();
    fake.closeLauncherStreams();

    const cancelError = await cancellation.catch((error: unknown) => error);
    const executionError = await resultError;
    expect(cancelError).toBeInstanceOf(Error);
    expect(executionError).toBe(cancelError);
    if (!(executionError instanceof Error)) throw new Error("Expected sandbox result error");
    expect(executionError.message).toMatch(/could not clean up transient unit.*within 3000ms/u);
    expect(executionError.message).not.toMatch(/^Workflow sandbox cancelled$/u);
  });
});

const integrationDescribe =
  process.env.LILAC_WORKFLOW_SANDBOX_INTEGRATION === "1" ? describe : describe.skip;
integrationDescribe("workflow sandbox runtime", () => {
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

  it("does not resolve launchers from a hostile PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lilac-hostile-path-"));
    const sentinel = join(directory, "launcher-ran");
    const originalPath = process.env.PATH;
    try {
      for (const command of ["bwrap", "systemd-run", "systemctl"]) {
        const filePath = join(directory, command);
        await writeFile(filePath, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nexit 99\n`);
        await chmod(filePath, 0o755);
      }
      process.env.PATH = directory;
      await expect(assertWorkflowSandboxAvailable()).resolves.toBeUndefined();
      await expect(execute("return 42;")).resolves.toMatchObject({ result: 42 });

      const workflowSource = source("while (true) {} ");
      const sandbox = startWorkflowSandbox({
        source: compileWorkflowSource(workflowSource, sha256(workflowSource)),
        args: {},
        maxWallTimeMs: 10_000,
        onCall: async () => null,
      });
      await Bun.sleep(100);
      const cancellation = sandbox.cancel();
      const resultExpectation = expect(sandbox.result).rejects.toThrow(/cancelled/u);
      await expect(cancellation).resolves.toBeUndefined();
      await resultExpectation;
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
