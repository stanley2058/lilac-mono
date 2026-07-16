import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./workflow-domain";

const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
const PREFLIGHT_OUTPUT_BYTES = 16 * 1024;
const PREFLIGHT_MANAGER_TIMEOUT_MS = 3_000;
const PREFLIGHT_SANDBOX_TIMEOUT_MS = 8_000;
const PREFLIGHT_CLEANUP_TIMEOUT_MS = 3_000;
const PREFLIGHT_CLEANUP_POLL_MS = 50;
const PREFLIGHT_CLEANUP_STABLE_MS = 200;
const SANDBOX_START_TIMEOUT_MS = 3_000;
const SANDBOX_CANCEL_TIMEOUT_MS = 3_000;
const SANDBOX_CANCEL_COMMAND_TIMEOUT_MS = 500;
const SANDBOX_CANCEL_POLL_MS = 50;
const SANDBOX_CANCEL_STABLE_MS = 200;
const REQUIRED_CGROUP_CONTROLLERS = ["memory", "pids"] as const;
const BWRAP_PATH = "/usr/bin/bwrap";
const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const REQUIRED_EXECUTABLES = [BWRAP_PATH, SYSTEMD_RUN_PATH, SYSTEMCTL_PATH] as const;

const sandboxCallSchema = z.strictObject({
  type: z.literal("call"),
  id: z.number().int().positive(),
  kind: z.enum(["agent", "parallel", "pipeline", "phase", "waitForReply", "sleep"]),
  callSiteId: z.string().min(1).max(200),
  occurrence: z.number().int().nonnegative(),
  path: z.string().min(1).max(1_000),
  parentPath: z.string().min(1).max(1_000).nullable(),
  phase: z.string().min(1).max(200).nullable(),
  depth: z.number().int().nonnegative(),
  input: jsonValueSchema,
});
export type WorkflowSandboxCall = z.infer<typeof sandboxCallSchema>;

const sandboxOutputSchema = z.discriminatedUnion("type", [
  sandboxCallSchema,
  z.strictObject({ type: z.literal("result"), result: jsonValueSchema }),
  z.strictObject({ type: z.literal("error"), error: z.string().max(16_384) }),
]);

function boundedJsonLine(value: JsonObject): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_BYTES) {
    throw new Error("Workflow sandbox protocol message exceeds limit");
  }
  return line;
}

async function inspectExecutable(filePath: string): Promise<string | null> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    return `is missing or inaccessible (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!stats.isFile()) return "is not a regular file";
  if (stats.uid !== 0) return `is not owned by root (uid ${stats.uid})`;
  if ((stats.mode & 0o022) !== 0) return "is writable by group or other users";
  try {
    await fs.access(filePath, fs.constants.X_OK);
  } catch (error) {
    return `is not executable (${error instanceof Error ? error.message : String(error)})`;
  }
  return null;
}

type PreflightCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type WorkflowSandboxPreflightProbes = {
  platform: string;
  inspectExecutable(filePath: string): Promise<string | null>;
  readFile(filePath: string): Promise<string>;
  run(command: readonly string[], timeoutMs: number): Promise<PreflightCommandResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  createUnitName(): string;
};

type WorkflowSandboxLauncher = {
  stdin: { write(value: string): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
};

export type WorkflowSandboxRuntimeProbes = {
  spawn(command: readonly string[]): WorkflowSandboxLauncher;
  run(command: readonly string[], timeoutMs: number): Promise<PreflightCommandResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  createUnitName(): string;
};

type PreflightOutputCapture = {
  result: Promise<string>;
  snapshot(): string;
};

function readPreflightOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): PreflightOutputCapture {
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  const result = (async (): Promise<string> => {
    for await (const chunk of stream) {
      const remaining = PREFLIGHT_OUTPUT_BYTES - bytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          output += decoder.decode(chunk.subarray(0, remaining), { stream: true });
        }
        onLimit();
        return `${output}\n[output exceeded ${PREFLIGHT_OUTPUT_BYTES} bytes]`;
      }
      bytes += chunk.byteLength;
      output += decoder.decode(chunk, { stream: true });
    }
    return output + decoder.decode();
  })();
  return { result, snapshot: () => output };
}

type PreflightCommandSpawner = (command: readonly string[]) => {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGKILL"): unknown;
};

export async function runWorkflowSandboxPreflightCommand(
  command: readonly string[],
  timeoutMs: number,
  spawn: PreflightCommandSpawner = (spawnCommand) =>
    Bun.spawn([...spawnCommand], { stdout: "pipe", stderr: "pipe" }),
): Promise<PreflightCommandResult> {
  const subprocess = spawn(command);
  const kill = (): void => {
    try {
      subprocess.kill("SIGKILL");
    } catch {}
  };
  const stdout = readPreflightOutput(subprocess.stdout, kill);
  const stderr = readPreflightOutput(subprocess.stderr, kill);
  const completed = Promise.all([subprocess.exited, stdout.result, stderr.result]).then(
    ([exitCode, stdoutOutput, stderrOutput]) => ({
      exitCode,
      stdout: stdoutOutput,
      stderr: stderrOutput,
      timedOut: false,
    }),
  );
  void completed.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome !== "timeout") return outcome;
  kill();
  return {
    exitCode: -1,
    stdout: stdout.snapshot(),
    stderr: stderr.snapshot(),
    timedOut: true,
  };
}

const defaultPreflightProbes: WorkflowSandboxPreflightProbes = {
  platform: process.platform,
  inspectExecutable,
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  run: runWorkflowSandboxPreflightCommand,
  now: Date.now,
  sleep: Bun.sleep,
  createUnitName: () => `lilac-workflow-preflight-${crypto.randomUUID()}`,
};

const defaultRuntimeProbes: WorkflowSandboxRuntimeProbes = {
  spawn: (command) =>
    Bun.spawn([...command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  run: runWorkflowSandboxPreflightCommand,
  now: Date.now,
  sleep: Bun.sleep,
  createUnitName: () => `lilac-workflow-${crypto.randomUUID()}`,
};

function unavailable(reason: string): Error {
  return new Error(`Workflow sandbox unavailable: ${reason}; unsandboxed execution is disabled`);
}

function commandFailure(result: PreflightCommandResult): string {
  if (result.timedOut) return "timed out";
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, PREFLIGHT_OUTPUT_BYTES);
  return `exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}`;
}

function unitWasAlreadyCollected(result: PreflightCommandResult): boolean {
  return (
    !result.timedOut &&
    result.exitCode !== 0 &&
    /(?:not loaded|not found|could not be found)/iu.test(`${result.stderr}\n${result.stdout}`)
  );
}

async function cleanupPreflightUnit(
  probes: WorkflowSandboxPreflightProbes,
  unit: string,
): Promise<string | null> {
  const commands = [
    [SYSTEMCTL_PATH, "--user", "stop", unit],
    [SYSTEMCTL_PATH, "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
    [SYSTEMCTL_PATH, "--user", "reset-failed", unit],
  ] as const;
  let cleanupCommandFailure: string | null = null;
  for (const command of commands) {
    let result: PreflightCommandResult;
    try {
      result = await probes.run(command, PREFLIGHT_CLEANUP_TIMEOUT_MS);
    } catch (error) {
      cleanupCommandFailure = `${command[2]} could not run (${error instanceof Error ? error.message : String(error)})`;
      continue;
    }
    if ((result.exitCode !== 0 || result.timedOut) && !unitWasAlreadyCollected(result)) {
      cleanupCommandFailure = `${command[2]} ${commandFailure(result)}`;
    }
  }

  const deadline = probes.now() + PREFLIGHT_CLEANUP_TIMEOUT_MS;
  let stableSince: number | null = null;
  let lastFailure = "transient unit state was not observed";
  while (probes.now() < deadline) {
    try {
      const status = await probes.run(
        [SYSTEMCTL_PATH, "--user", "show", unit, "--property=ActiveState", "--value"],
        Math.max(1, Math.min(SANDBOX_CANCEL_COMMAND_TIMEOUT_MS, deadline - probes.now())),
      );
      const inactive =
        status.exitCode === 0 && !status.timedOut && status.stdout.trim() === "inactive";
      const absent = unitWasAlreadyCollected(status);
      const observedAt = probes.now();
      if (inactive || absent) {
        stableSince ??= observedAt;
        if (observedAt - stableSince >= PREFLIGHT_CLEANUP_STABLE_MS) return null;
        lastFailure = `transient unit had not remained inactive or absent for ${PREFLIGHT_CLEANUP_STABLE_MS}ms`;
      } else {
        stableSince = null;
        lastFailure =
          status.exitCode !== 0 || status.timedOut
            ? `cleanup verification ${commandFailure(status)}`
            : `cleanup verification found ActiveState=${JSON.stringify(status.stdout.trim())}`;
      }
    } catch (error) {
      stableSince = null;
      lastFailure = `cleanup verification could not run (${error instanceof Error ? error.message : String(error)})`;
    }
    await probes.sleep(Math.min(PREFLIGHT_CLEANUP_POLL_MS, Math.max(0, deadline - probes.now())));
  }
  return `stable inactive or absent state was not observed within ${PREFLIGHT_CLEANUP_TIMEOUT_MS}ms (${lastFailure}${cleanupCommandFailure ? `; cleanup command failed: ${cleanupCommandFailure}` : ""}); RuntimeMaxSec=10s remains the final self-termination bound`;
}

function validControlGroup(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    path.posix.normalize(value) === value
  );
}

function isStrictControlGroupDescendant(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith("../");
}

function missingControllers(value: string): string[] {
  const available = new Set(value.split(/\s+/u).filter(Boolean));
  return REQUIRED_CGROUP_CONTROLLERS.filter((controller) => !available.has(controller));
}

async function readControllers(
  probes: WorkflowSandboxPreflightProbes,
  filePath: string,
  absentMessage: string,
): Promise<string> {
  try {
    return await probes.readFile(filePath);
  } catch (error) {
    throw unavailable(
      `${absentMessage} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export async function assertWorkflowSandboxAvailable(
  probes: WorkflowSandboxPreflightProbes = defaultPreflightProbes,
): Promise<void> {
  if (probes.platform !== "linux") {
    throw new Error("Workflow sandbox requires Linux namespaces and cgroup v2");
  }
  for (const executable of REQUIRED_EXECUTABLES) {
    const problem = await probes.inspectExecutable(executable);
    if (problem) {
      throw unavailable(
        `required executable ${executable} ${problem}; install trusted root-owned bubblewrap and systemd user tools at the required paths`,
      );
    }
  }

  const rootControllers = await readControllers(
    probes,
    "/sys/fs/cgroup/cgroup.controllers",
    "cgroup v2 is not mounted at /sys/fs/cgroup; mount a unified cgroup v2 hierarchy",
  );
  const missingAtRoot = missingControllers(rootControllers);
  if (missingAtRoot.length > 0) {
    throw unavailable(
      `the host cgroup v2 hierarchy does not expose required controllers: ${missingAtRoot.join(", ")}; enable the memory and pids cgroup v2 controllers`,
    );
  }

  let manager: PreflightCommandResult;
  try {
    manager = await probes.run(
      [SYSTEMCTL_PATH, "--user", "show", "--property=ControlGroup", "--value"],
      PREFLIGHT_MANAGER_TIMEOUT_MS,
    );
  } catch (error) {
    throw unavailable(
      `the current-user systemd manager probe could not run (${error instanceof Error ? error.message : String(error)}); start a user session or enable lingering for this user`,
    );
  }
  if (manager.exitCode !== 0 || manager.timedOut) {
    throw unavailable(
      `the current-user systemd manager is not reachable (${commandFailure(manager)}); start a user session or enable lingering for this user`,
    );
  }
  const managerControlGroup = manager.stdout.trim();
  if (!validControlGroup(managerControlGroup)) {
    throw unavailable(
      `the current-user systemd manager returned an invalid ControlGroup value: ${JSON.stringify(managerControlGroup)}`,
    );
  }

  const managerControllersPath = path.posix.join(
    "/sys/fs/cgroup",
    managerControlGroup,
    "cgroup.controllers",
  );
  const managerControllers = await readControllers(
    probes,
    managerControllersPath,
    `the current-user systemd manager cgroup ${managerControlGroup} is not available on the cgroup v2 hierarchy`,
  );
  const missingAtManager = missingControllers(managerControllers);
  if (missingAtManager.length > 0) {
    throw unavailable(
      `the current-user systemd manager cgroup ${managerControlGroup} is not delegated required controllers: ${missingAtManager.join(", ")}; delegate the memory and pids controllers to user@.service`,
    );
  }

  const unit = probes.createUnitName();
  let probeFailure: Error | null = null;
  try {
    const sandboxProbe = await probes.run(
      [
        SYSTEMD_RUN_PATH,
        "--user",
        "--collect",
        "--quiet",
        `--unit=${unit}`,
        "-p",
        `MemoryMax=${SANDBOX_MEMORY_BYTES}`,
        "-p",
        "MemorySwapMax=0",
        "-p",
        "TasksMax=16",
        "-p",
        "RuntimeMaxSec=10s",
        BWRAP_PATH,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr/lib",
        "/usr/lib",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib",
        "/lib64",
        "--dir",
        "/sandbox",
        "--ro-bind",
        process.execPath,
        "/sandbox/bun",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "/sandbox/bun",
        "-e",
        "setTimeout(() => {}, 30000)",
      ],
      PREFLIGHT_SANDBOX_TIMEOUT_MS,
    );
    if (sandboxProbe.exitCode !== 0 || sandboxProbe.timedOut) {
      probeFailure = unavailable(
        `the disposable systemd/bwrap sandbox probe ${commandFailure(sandboxProbe)}; verify unprivileged user namespaces (kernel.unprivileged_userns_clone and user.max_user_namespaces) and delegated memory/pids controller support`,
      );
    } else {
      const unitControlGroupResult = await probes.run(
        [SYSTEMCTL_PATH, "--user", "show", unit, "--property=ControlGroup", "--value"],
        PREFLIGHT_MANAGER_TIMEOUT_MS,
      );
      if (unitControlGroupResult.exitCode !== 0 || unitControlGroupResult.timedOut) {
        throw unavailable(
          `the disposable transient unit ControlGroup could not be read (${commandFailure(unitControlGroupResult)})`,
        );
      }
      const unitControlGroup = unitControlGroupResult.stdout.trim();
      if (!validControlGroup(unitControlGroup)) {
        throw unavailable(
          `the disposable transient unit returned an invalid ControlGroup value: ${JSON.stringify(unitControlGroup)}`,
        );
      }
      if (!isStrictControlGroupDescendant(managerControlGroup, unitControlGroup)) {
        throw unavailable(
          `the disposable transient unit ControlGroup ${unitControlGroup} is not a strict descendant of manager ControlGroup ${managerControlGroup}`,
        );
      }
      const cgroupRoot = path.posix.join("/sys/fs/cgroup", unitControlGroup);
      const expectedLimits = [
        ["memory.max", String(SANDBOX_MEMORY_BYTES)],
        ["memory.swap.max", "0"],
        ["pids.max", "16"],
      ] as const;
      for (const [property, expected] of expectedLimits) {
        const actual = await probes.readFile(path.posix.join(cgroupRoot, property));
        if (actual.trim() !== expected) {
          throw unavailable(
            `the disposable transient unit did not apply ${property}=${expected} (read ${JSON.stringify(actual.trim())})`,
          );
        }
      }
      const active = await probes.run(
        [SYSTEMCTL_PATH, "--user", "is-active", unit],
        PREFLIGHT_MANAGER_TIMEOUT_MS,
      );
      if (active.exitCode !== 0 || active.timedOut || active.stdout.trim() !== "active") {
        throw unavailable(
          `the disposable systemd/bwrap sandbox did not remain active (${commandFailure(active)}); verify unprivileged user namespaces and delegated memory/pids controller support`,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Workflow sandbox unavailable:")) {
      probeFailure = error;
    } else {
      probeFailure = unavailable(
        `the disposable systemd/bwrap sandbox probe could not run (${error instanceof Error ? error.message : String(error)}); verify unprivileged user namespaces and delegated memory/pids controller support`,
      );
    }
  }
  const cleanupFailure = await cleanupPreflightUnit(probes, unit);
  if (cleanupFailure) {
    throw unavailable(
      `could not clean up transient preflight unit ${unit} (${cleanupFailure}); run ${SYSTEMCTL_PATH} --user stop ${unit} and inspect the user manager${probeFailure ? `; the sandbox probe also failed: ${probeFailure.message}` : ""}`,
    );
  }
  if (probeFailure) throw probeFailure;
}

export type WorkflowSandboxRun = {
  result: Promise<JsonValue>;
  cancel(): Promise<void>;
};

export function startWorkflowSandbox(input: {
  source: string;
  args: JsonObject;
  maxWallTimeMs: number;
  memoryBytes?: number;
  signal?: AbortSignal;
  onCall(call: WorkflowSandboxCall): Promise<JsonValue>;
  runtimeProbes?: WorkflowSandboxRuntimeProbes;
}): WorkflowSandboxRun {
  if (input.signal?.aborted) {
    const result = Promise.reject<JsonValue>(new Error("Workflow sandbox cancelled"));
    void result.catch(() => undefined);
    const cancelPromise = Promise.resolve();
    return { result, cancel: () => cancelPromise };
  }

  const runtime = input.runtimeProbes ?? defaultRuntimeProbes;
  const helperPath = path.join(import.meta.dir, "workflow-sandbox-child.js");
  const unit = runtime.createUnitName();
  const memoryBytes = Math.min(input.memoryBytes ?? SANDBOX_MEMORY_BYTES, SANDBOX_MEMORY_BYTES);
  const command = [
    SYSTEMD_RUN_PATH,
    "--user",
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    `--unit=${unit}`,
    "-p",
    `MemoryMax=${memoryBytes}`,
    "-p",
    "MemorySwapMax=0",
    "-p",
    "TasksMax=16",
    "-p",
    `RuntimeMaxSec=${Math.max(1, Math.ceil(input.maxWallTimeMs / 1_000))}s`,
    BWRAP_PATH,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr/lib",
    "/usr/lib",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--dir",
    "/sandbox",
    "--ro-bind",
    process.execPath,
    "/sandbox/bun",
    "--ro-bind",
    helperPath,
    "/sandbox/runner.js",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    "/tmp",
    "/sandbox/bun",
    "--smol",
    "/sandbox/runner.js",
  ];
  const subprocess = runtime.spawn(command);
  let cancelled = false;
  let terminal = false;
  let activeConfirmed = false;
  let cancelPromise: Promise<void> | null = null;
  const cancellationError = new Error("Workflow sandbox cancelled");
  let terminationError: Error = cancellationError;
  let rejectForCancellation: (error: unknown) => void = () => {};
  const cancellationResult = new Promise<JsonValue>((_resolve, reject) => {
    rejectForCancellation = reject;
  });
  type LauncherExit = { type: "exit"; exitCode: number } | { type: "error"; error: unknown };
  let launcherExit: LauncherExit | null = null;
  const launcherExited = subprocess.exited.then(
    (exitCode): LauncherExit => {
      launcherExit = { type: "exit", exitCode };
      return launcherExit;
    },
    (error: unknown): LauncherExit => {
      launcherExit = { type: "error", error };
      return launcherExit;
    },
  );

  const launcherExitFailure = (outcome: LauncherExit): Error =>
    new Error(
      outcome.type === "exit"
        ? `Workflow sandbox launcher exited with code ${outcome.exitCode} before unit ${unit} became active`
        : `Workflow sandbox launcher failed before unit ${unit} became active: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
    );

  const waitForActiveUnit = async (): Promise<void> => {
    const deadline = runtime.now() + SANDBOX_START_TIMEOUT_MS;
    let lastFailure = "unit state was not observed";
    while (!cancelled && runtime.now() < deadline) {
      if (launcherExit) throw launcherExitFailure(launcherExit);
      const timeoutMs = Math.max(
        1,
        Math.min(SANDBOX_CANCEL_COMMAND_TIMEOUT_MS, deadline - runtime.now()),
      );
      const probe = runtime.run([SYSTEMCTL_PATH, "--user", "is-active", unit], timeoutMs).then(
        (result) => ({ type: "probe" as const, result }),
        (error: unknown) => ({ type: "probe-error" as const, error }),
      );
      const outcome = await Promise.race([probe, launcherExited]);
      if (outcome.type === "exit" || outcome.type === "error") {
        throw launcherExitFailure(outcome);
      }
      if (cancelled) throw terminationError;
      if (outcome.type === "probe") {
        if (
          outcome.result.exitCode === 0 &&
          !outcome.result.timedOut &&
          outcome.result.stdout.trim() === "active"
        ) {
          activeConfirmed = true;
          return;
        }
        lastFailure = commandFailure(outcome.result);
      } else {
        lastFailure = `unit activation probe could not run (${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)})`;
      }
      const sleep = runtime.sleep(
        Math.min(SANDBOX_CANCEL_POLL_MS, Math.max(0, deadline - runtime.now())),
      );
      const sleepOutcome = await Promise.race([sleep.then(() => null), launcherExited]);
      if (sleepOutcome) throw launcherExitFailure(sleepOutcome);
    }
    if (cancelled) throw terminationError;
    throw new Error(
      `Workflow sandbox unit ${unit} did not become active within ${SANDBOX_START_TIMEOUT_MS}ms: ${lastFailure}`,
    );
  };

  const performCancellation = async (): Promise<void> => {
    cancelled = true;
    const deadline = runtime.now() + SANDBOX_CANCEL_TIMEOUT_MS;
    let quiescentSince: number | null = null;
    let lastFailure = "transient unit state was not observed";
    try {
      subprocess.stdin.end();
    } catch {}
    try {
      subprocess.kill("SIGTERM");
    } catch (error) {
      lastFailure = `launcher SIGTERM failed (${error instanceof Error ? error.message : String(error)})`;
    }
    const launcherGraceDeadline = Math.min(deadline, runtime.now() + 100);
    while (!launcherExit && runtime.now() < launcherGraceDeadline) {
      await runtime.sleep(Math.min(SANDBOX_CANCEL_POLL_MS, launcherGraceDeadline - runtime.now()));
    }
    if (!launcherExit) {
      try {
        subprocess.kill("SIGKILL");
      } catch (error) {
        lastFailure = `launcher SIGKILL failed (${error instanceof Error ? error.message : String(error)})`;
      }
    }

    while (runtime.now() < deadline) {
      for (const command of [
        [SYSTEMCTL_PATH, "--user", "stop", unit],
        [SYSTEMCTL_PATH, "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
      ] as const) {
        if (runtime.now() >= deadline) break;
        const timeoutMs = Math.max(
          1,
          Math.min(SANDBOX_CANCEL_COMMAND_TIMEOUT_MS, deadline - runtime.now()),
        );
        try {
          const outcome = await runtime.run(command, timeoutMs);
          if ((outcome.exitCode !== 0 || outcome.timedOut) && !unitWasAlreadyCollected(outcome)) {
            lastFailure = `${command[2]} ${commandFailure(outcome)}`;
          }
        } catch (error) {
          lastFailure = `${command[2]} could not run (${error instanceof Error ? error.message : String(error)})`;
        }
      }

      if (runtime.now() >= deadline) break;
      const timeoutMs = Math.max(
        1,
        Math.min(SANDBOX_CANCEL_COMMAND_TIMEOUT_MS, deadline - runtime.now()),
      );
      try {
        const status = await runtime.run(
          [SYSTEMCTL_PATH, "--user", "show", unit, "--property=ActiveState", "--value"],
          timeoutMs,
        );
        const inactive =
          status.exitCode === 0 && !status.timedOut && status.stdout.trim() === "inactive";
        const absent = unitWasAlreadyCollected(status);
        const observedAt = runtime.now();
        if (launcherExit && (inactive || absent)) {
          quiescentSince ??= observedAt;
          if (observedAt - quiescentSince >= SANDBOX_CANCEL_STABLE_MS) return;
          lastFailure = `transient unit had not remained inactive or absent for ${SANDBOX_CANCEL_STABLE_MS}ms`;
        } else {
          quiescentSince = null;
          lastFailure = launcherExit
            ? `transient unit remained ActiveState=${JSON.stringify(status.stdout.trim())}`
            : activeConfirmed
              ? "systemd-run launcher did not terminate after the active unit was targeted"
              : "systemd-run launcher did not terminate; unit creation may still be pending";
        }
      } catch (error) {
        quiescentSince = null;
        lastFailure = `unit state probe could not run (${error instanceof Error ? error.message : String(error)})`;
      }
      await runtime.sleep(Math.min(SANDBOX_CANCEL_POLL_MS, Math.max(0, deadline - runtime.now())));
    }

    throw new Error(
      `Workflow sandbox cancellation could not clean up transient unit ${unit} within ${SANDBOX_CANCEL_TIMEOUT_MS}ms: ${lastFailure}`,
    );
  };

  const terminate = (error: Error): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    if (terminal) return Promise.resolve();
    terminationError = error;
    cancelPromise = performCancellation();
    void cancelPromise.then(
      () => rejectForCancellation(terminationError),
      (error: unknown) => rejectForCancellation(error),
    );
    return cancelPromise;
  };
  const cancel = (): Promise<void> => terminate(cancellationError);

  if (input.signal) {
    input.signal.addEventListener("abort", () => void cancel().catch(() => undefined), {
      once: true,
    });
    if (input.signal.aborted) void cancel().catch(() => undefined);
  }

  const executionResult = (async (): Promise<JsonValue> => {
    const stderrPromise = (async (): Promise<string> => {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      for await (const chunk of subprocess.stderr) {
        bytes += chunk.byteLength;
        if (bytes > 16_384) {
          await cancel();
          throw new Error("Workflow sandbox stderr exceeded limit");
        }
        text += decoder.decode(chunk, { stream: true });
      }
      return text;
    })();
    try {
      await waitForActiveUnit();
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      await terminate(startupError);
      throw startupError;
    }
    if (!cancelled && activeConfirmed) {
      subprocess.stdin.write(
        boundedJsonLine(
          jsonObjectSchema.parse({ type: "start", source: input.source, args: input.args }),
        ),
      );
    }
    const decoder = new TextDecoder();
    let buffered = "";
    let stdoutBytes = 0;
    let resolvedResult: JsonValue | undefined;
    let sandboxError: string | null = null;
    for await (const chunk of subprocess.stdout) {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PROTOCOL_BYTES) {
        await cancel();
        throw new Error("Workflow sandbox cumulative stdout exceeded limit");
      }
      buffered += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > MAX_PROTOCOL_BYTES) {
        await cancel();
        throw new Error("Workflow sandbox stdout exceeded limit");
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const message = sandboxOutputSchema.parse(JSON.parse(line));
        if (message.type === "call") {
          void input.onCall(message).then(
            (value) =>
              subprocess.stdin.write(
                boundedJsonLine(jsonObjectSchema.parse({ type: "resolve", id: message.id, value })),
              ),
            (error: unknown) =>
              subprocess.stdin.write(
                boundedJsonLine(
                  jsonObjectSchema.parse({
                    type: "reject",
                    id: message.id,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
          );
        } else if (message.type === "result") {
          resolvedResult = message.result;
          subprocess.stdin.end();
        } else {
          sandboxError = message.error;
          subprocess.stdin.end();
        }
      }
    }
    const exitCode = await subprocess.exited;
    terminal = true;
    const stderr = (await stderrPromise).slice(0, 16_384).trim();
    if (cancelled) throw new Error("Workflow sandbox cancelled");
    if (sandboxError) throw new Error(sandboxError);
    if (resolvedResult !== undefined && exitCode === 0) return resolvedResult;
    throw new Error(`Workflow sandbox exited with code ${exitCode}${stderr ? `: ${stderr}` : ""}`);
  })();

  const executionAfterCancellation = executionResult.then(
    async (value) => {
      const cancellation = cancelPromise;
      if (!cancellation) return value;
      await cancellation;
      throw terminationError;
    },
    async (error: unknown) => {
      const cancellation = cancelPromise;
      if (cancellation) {
        await cancellation;
        throw terminationError;
      }
      throw error;
    },
  );
  const result = Promise.race([executionAfterCancellation, cancellationResult]);

  return { result, cancel };
}
