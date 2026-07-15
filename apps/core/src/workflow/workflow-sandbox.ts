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

async function executableExists(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    try {
      await fs.access(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

export async function assertWorkflowSandboxAvailable(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("Workflow sandbox requires Linux namespaces and cgroup v2");
  }
  const requiredCommands = ["bwrap", "systemd-run", "systemctl"];
  const missing: string[] = [];
  for (const command of requiredCommands) {
    if (!(await executableExists(command))) missing.push(command);
  }
  if (missing.length > 0) {
    throw new Error(
      `Workflow sandbox unavailable: install ${missing.join(", ")} and provide Linux user namespaces plus a user systemd manager; unsandboxed execution is disabled`,
    );
  }
  try {
    await fs.access("/sys/fs/cgroup/cgroup.controllers", fs.constants.R_OK);
  } catch {
    throw new Error(
      "Workflow sandbox unavailable: cgroup v2 controllers are not mounted; unsandboxed execution is disabled",
    );
  }
  try {
    const probe = Bun.spawn(["systemctl", "--user", "show", "--property=Version", "--value"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await probe.exited) !== 0) {
      const stderr = (await new Response(probe.stderr).text()).trim();
      throw new Error(stderr || "systemctl --user failed");
    }
  } catch (error) {
    throw new Error(
      `Workflow sandbox unavailable: user systemd manager is not reachable (${error instanceof Error ? error.message : String(error)}); enable user lingering/session services and delegated cgroup-v2 memory/PID controls; unsandboxed execution is disabled`,
    );
  }
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
}): WorkflowSandboxRun {
  const helperPath = path.join(import.meta.dir, "workflow-sandbox-child.js");
  const unit = `lilac-workflow-${crypto.randomUUID()}`;
  const memoryBytes = Math.min(input.memoryBytes ?? SANDBOX_MEMORY_BYTES, SANDBOX_MEMORY_BYTES);
  const command = [
    "systemd-run",
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
    "bwrap",
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
  const subprocess = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let cancelled = false;
  let terminal = false;

  const cancel = async (): Promise<void> => {
    if (terminal || cancelled) return;
    cancelled = true;
    const stop = Bun.spawn(["systemctl", "--user", "kill", "--kill-whom=all", unit], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await stop.exited.catch(() => undefined);
    subprocess.kill("SIGKILL");
  };
  input.signal?.addEventListener("abort", () => void cancel(), { once: true });

  const result = (async (): Promise<JsonValue> => {
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
    subprocess.stdin.write(
      boundedJsonLine(
        jsonObjectSchema.parse({ type: "start", source: input.source, args: input.args }),
      ),
    );
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

  return { result, cancel };
}
