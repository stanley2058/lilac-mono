import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { analyzeBashCommand } from "./bash-safety";
import { formatBlockedMessage, redactSecrets } from "./bash-safety/format";
import { expandTilde } from "./fs/fs-impl";

const DEFAULT_BASH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_KILL_SIGNAL = "SIGTERM";

const logger = new Logger({
  logLevel: resolveLogLevel(),
  module: "tool:bash",
});

export type BashToolInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** Bypass bash safety guardrails for this call. */
  dangerouslyAllow?: boolean;
};

export type BashExecutionError =
  | {
      type: "blocked";
      reason: string;
      segment?: string;
    }
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

export async function executeBash(
  { command, cwd, timeoutMs, dangerouslyAllow }: BashToolInput,
  {
    context,
  }: {
    context?: {
      requestId: string;
      sessionId: string;
      requestClient: string;
    };
  } = {},
): Promise<BashToolOutput> {
  const resolvedCwd = cwd ? expandTilde(cwd) : process.cwd();

  const redactedCommand = redactSecrets(command);
  const startedAt = Date.now();

  logger.info("bash exec", {
    command: redactedCommand,
    cwd: resolvedCwd,
    timeoutMs: timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
    requestId: context?.requestId,
    sessionId: context?.sessionId,
    requestClient: context?.requestClient,
  });

  if (!dangerouslyAllow) {
    const blocked = analyzeBashCommand(command, { cwd: resolvedCwd });
    if (blocked) {
      logger.warn("bash blocked", {
        command: redactedCommand,
        cwd: resolvedCwd,
        reason: blocked.reason,
        segment: blocked.segment,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      });

      return {
        stdout: "",
        stderr: formatBlockedMessage({
          reason: blocked.reason,
          command,
          segment: blocked.segment,
          redact: redactSecrets,
        }),
        exitCode: -1,
        executionError: {
          type: "blocked",
          reason: blocked.reason,
          segment: blocked.segment,
        },
      };
    }
  }

  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);

  try {
    // Intentionally avoid a login shell here.
    // Login shells source /etc/profile (and friends) which can clobber PATH
    // and diverge from the process environment we want the tool to inherit.
    const child = Bun.spawn(["bash", "-c", command], {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      killSignal: DEFAULT_KILL_SIGNAL,
      env: {
        ...process.env,
        LILAC_REQUEST_ID: context?.requestId,
        LILAC_SESSION_ID: context?.sessionId,
        LILAC_REQUEST_CLIENT: context?.requestClient,
        LILAC_CWD: resolvedCwd,
      },
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamText(child.stdout),
      readStreamText(child.stderr),
      child.exited,
    ]);

    const stdout =
      stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
    const stderr =
      stderrResult.status === "fulfilled" ? stderrResult.value : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    const durationMs = Date.now() - startedAt;

    if (timedOut && child.killed) {
      logger.warn("bash timeout", {
        command: redactedCommand,
        cwd: resolvedCwd,
        timeoutMs: effectiveTimeoutMs,
        signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      });

      return {
        stdout,
        stderr,
        exitCode,
        executionError: {
          type: "timeout",
          timeoutMs: effectiveTimeoutMs,
          signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
        },
      };
    }

    if (stdoutResult.status === "rejected") {
      logger.error(
        "bash stdout read failed",
        {
          command: redactedCommand,
          cwd: resolvedCwd,
          durationMs,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        },
        stdoutResult.reason,
      );

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
      logger.error(
        "bash stderr read failed",
        {
          command: redactedCommand,
          cwd: resolvedCwd,
          durationMs,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        },
        stderrResult.reason,
      );

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
      logger.error(
        "bash exit status read failed",
        {
          command: redactedCommand,
          cwd: resolvedCwd,
          durationMs,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        },
        exitResult.reason,
      );

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

    // Always log the outcome (exitCode can be non-zero without executionError).
    const ok = exitCode === 0;
    if (ok) {
      logger.info("bash done", {
        command: redactedCommand,
        cwd: resolvedCwd,
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      });
    } else {
      logger.warn("bash done (non-zero exit)", {
        command: redactedCommand,
        cwd: resolvedCwd,
        exitCode,
        durationMs,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      });
    }

    return { stdout, stderr, exitCode };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      "bash spawn failed",
      {
        command: redactedCommand,
        cwd: resolvedCwd,
        durationMs,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      },
      err,
    );

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
