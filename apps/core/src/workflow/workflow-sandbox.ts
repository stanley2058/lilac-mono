import path from "node:path";

import { z } from "zod";

import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./workflow-domain";
import { parseWorkflowCallSiteManifest } from "./workflow-source-compiler";

const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 100;
const KILL_EXIT_TIMEOUT_MS = 3_000;

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

type WorkflowSandboxLauncher = {
  stdin: { write(value: string): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
};

export type WorkflowSandboxRuntimeProbes = {
  spawn(command: readonly string[]): WorkflowSandboxLauncher;
  sleep(ms: number): Promise<void>;
};

const defaultRuntimeProbes: WorkflowSandboxRuntimeProbes = {
  spawn: (command) =>
    Bun.spawn([...command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  sleep: Bun.sleep,
};

export type WorkflowSandboxRun = {
  result: Promise<JsonValue>;
  cancel(): Promise<void>;
};

type LauncherExit = { type: "exit"; exitCode: number } | { type: "error"; error: unknown };

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function startWorkflowSandbox(input: {
  source: string;
  args: JsonObject;
  maxWallTimeMs: number;
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
  if (!Number.isFinite(input.maxWallTimeMs) || input.maxWallTimeMs <= 0) {
    throw new Error("Workflow sandbox maxWallTimeMs must be positive and finite");
  }

  const allowedCallSites = new Map(
    parseWorkflowCallSiteManifest(input.source).map((entry) => [entry.callSiteId, entry.kind]),
  );
  const runtime = input.runtimeProbes ?? defaultRuntimeProbes;
  const helperPath = path.join(import.meta.dir, "workflow-sandbox-child.js");
  const command = [process.execPath, "--smol", helperPath] as const;
  const subprocess = runtime.spawn(command);

  let processExited = false;
  const launcherExited = subprocess.exited.then(
    (exitCode): LauncherExit => {
      processExited = true;
      return { type: "exit", exitCode };
    },
    (error: unknown): LauncherExit => {
      processExited = true;
      return { type: "error", error };
    },
  );

  let terminationError: Error | null = null;
  let terminationPromise: Promise<void> | null = null;
  let rejectForTermination: (error: unknown) => void = () => {};
  const terminationResult = new Promise<JsonValue>((_resolve, reject) => {
    rejectForTermination = reject;
  });

  const performTermination = async (): Promise<void> => {
    try {
      subprocess.stdin.end();
    } catch {}
    if (processExited) return;

    try {
      subprocess.kill("SIGTERM");
    } catch {}
    const exitedDuringGrace = await Promise.race([
      launcherExited.then(() => true),
      runtime.sleep(TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (exitedDuringGrace) return;

    try {
      subprocess.kill("SIGKILL");
    } catch {}
    const exitedAfterKill = await Promise.race([
      launcherExited.then(() => true),
      runtime.sleep(KILL_EXIT_TIMEOUT_MS).then(() => false),
    ]);
    if (!exitedAfterKill) {
      throw new Error(
        `Workflow sandbox process did not exit within ${KILL_EXIT_TIMEOUT_MS}ms after SIGKILL`,
      );
    }
  };

  const terminate = (error: Error): Promise<void> => {
    if (terminationPromise) return terminationPromise;
    if (processExited) return Promise.resolve();
    terminationError = error;
    terminationPromise = performTermination();
    void terminationPromise.then(
      () => rejectForTermination(error),
      (terminationFailure: unknown) => rejectForTermination(terminationFailure),
    );
    return terminationPromise;
  };
  const cancellationError = new Error("Workflow sandbox cancelled");
  const cancel = (): Promise<void> => terminate(cancellationError);

  const abort = (): void => {
    void cancel().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  const wallTimer = setTimeout(() => {
    void terminate(new Error(`Workflow sandbox timed out after ${input.maxWallTimeMs}ms`)).catch(
      () => undefined,
    );
  }, input.maxWallTimeMs);
  wallTimer.unref?.();

  const executionResult = (async (): Promise<JsonValue> => {
    const stderrPromise = (async (): Promise<string> => {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      for await (const chunk of subprocess.stderr) {
        bytes += chunk.byteLength;
        if (bytes > MAX_STDERR_BYTES) {
          const error = new Error("Workflow sandbox stderr exceeded limit");
          await terminate(error);
          throw error;
        }
        text += decoder.decode(chunk, { stream: true });
      }
      return text + decoder.decode();
    })();
    void stderrPromise.catch(() => undefined);

    try {
      subprocess.stdin.write(
        boundedJsonLine(
          jsonObjectSchema.parse({ type: "start", source: input.source, args: input.args }),
        ),
      );

      const decoder = new TextDecoder();
      let buffered = "";
      let stdoutBytes = 0;
      let resolvedResult: JsonValue | undefined;
      let receivedResult = false;
      let sandboxError: string | null = null;

      for await (const chunk of subprocess.stdout) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_PROTOCOL_BYTES) {
          const error = new Error("Workflow sandbox cumulative stdout exceeded limit");
          await terminate(error);
          throw error;
        }
        buffered += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffered, "utf8") > MAX_PROTOCOL_BYTES) {
          const error = new Error("Workflow sandbox stdout exceeded limit");
          await terminate(error);
          throw error;
        }

        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const message = sandboxOutputSchema.parse(JSON.parse(line));
          if (message.type === "call") {
            if (allowedCallSites.get(message.callSiteId) !== message.kind) {
              const error = new Error(
                `Workflow sandbox emitted unapproved call site ${message.kind}:${message.callSiteId}`,
              );
              await terminate(error);
              throw error;
            }
            void input
              .onCall(message)
              .then(
                (value) =>
                  subprocess.stdin.write(
                    boundedJsonLine(
                      jsonObjectSchema.parse({ type: "resolve", id: message.id, value }),
                    ),
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
              )
              .catch((error: unknown) => terminate(errorFrom(error)))
              .catch(() => undefined);
          } else if (message.type === "result") {
            receivedResult = true;
            resolvedResult = message.result;
            subprocess.stdin.end();
          } else {
            sandboxError = message.error;
            subprocess.stdin.end();
          }
        }
      }

      buffered += decoder.decode();
      if (buffered.length > 0) {
        throw new Error("Workflow sandbox emitted an incomplete protocol message");
      }
      const exit = await launcherExited;
      const stderr = (await stderrPromise).trim();
      if (terminationError) throw terminationError;
      if (exit.type === "error") {
        throw new Error(`Workflow sandbox process failed: ${errorFrom(exit.error).message}`);
      }
      if (sandboxError) throw new Error(sandboxError);
      if (receivedResult && exit.exitCode === 0) return resolvedResult ?? null;
      throw new Error(
        `Workflow sandbox exited with code ${exit.exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    } catch (error) {
      const executionError = errorFrom(error);
      if (!processExited && !terminationPromise) await terminate(executionError);
      if (terminationError && terminationError !== cancellationError) throw terminationError;
      throw executionError;
    }
  })();

  const result = Promise.race([executionResult, terminationResult]).finally(() => {
    clearTimeout(wallTimer);
    input.signal?.removeEventListener("abort", abort);
  });
  void result.catch(() => undefined);

  return { result, cancel };
}
