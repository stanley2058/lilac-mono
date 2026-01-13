import { expandTilde } from "./fs/fs-impl";

const DEFAULT_BASH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_KILL_SIGNAL = "SIGTERM";

export type BashToolInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type BashExecutionError =
  | {
      type: "timeout";
      timeoutMs: number;
      signal: string;
    }
  | {
      type: "exception";
      phase: "spawn" | "stdout" | "stderr" | "unknown";
      message: string;
    };

export type BashToolOutput = {
  stdout: string;
  stderr: string;
  /**
   * Exit code of the command.
   *
   * Notes:
   * - Non-zero exit codes mean the command failed.
   * - A value of -1 means the tool failed to execute the command (see executionError).
   */
  exitCode: number;
  /**
   * Tool-level error (timeout, spawn failure, stream read failure).
   *
   * This is distinct from a command failure, which is represented by a non-zero exitCode.
   */
  executionError?: BashExecutionError;
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readStreamText(stream: unknown): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream as any).text();
}

export async function executeBash({
  command,
  cwd,
  timeoutMs,
}: BashToolInput): Promise<BashToolOutput> {
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);

  try {
    const process = Bun.spawn(["bash", "-lc", command], {
      cwd: cwd ? expandTilde(cwd) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      killSignal: DEFAULT_KILL_SIGNAL,
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamText(process.stdout),
      readStreamText(process.stderr),
      process.exited,
    ]);

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    if (timedOut && process.killed) {
      return {
        stdout,
        stderr,
        exitCode,
        executionError: {
          type: "timeout",
          timeoutMs: effectiveTimeoutMs,
          signal: process.signalCode ?? DEFAULT_KILL_SIGNAL,
        },
      };
    }

    if (stdoutResult.status === "rejected") {
      return {
        stdout,
        stderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "stdout",
          message: toErrorMessage(stdoutResult.reason),
        },
      };
    }

    if (stderrResult.status === "rejected") {
      return {
        stdout,
        stderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "stderr",
          message: toErrorMessage(stderrResult.reason),
        },
      };
    }

    if (exitResult.status === "rejected") {
      return {
        stdout,
        stderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "unknown",
          message: toErrorMessage(exitResult.reason),
        },
      };
    }

    return { stdout, stderr, exitCode };
  } catch (err) {
    return {
      stdout: "",
      stderr: "",
      exitCode: -1,
      executionError: {
        type: "exception",
        phase: "spawn",
        message: toErrorMessage(err),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
