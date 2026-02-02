import { env, resolveLogLevel, resolveVcsEnv } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { analyzeBashCommand } from "./bash-safety";
import { formatBlockedMessage, redactSecrets } from "./bash-safety/format";
import { expandTilde } from "./fs/fs-impl";

import { getGithubEnvForBash } from "../github/github-app-token";

const DEFAULT_BASH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_KILL_SIGNAL = "SIGTERM";

// Keep tool output bounded so we don't blow up agent context.
const MAX_BASH_OUTPUT_CHARS = 200_000;

const BASH_TOOL_OUTPUT_TRUNCATED_SUFFIX =
  "\n<bash_tool_error>\n" +
  "output truncated due to length > 200,000 characters.\n" +
  "Tip: narrow output, or pipe it to a file and inspect with rg.\n" +
  "</bash_tool_error>\n";

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

type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
};

async function readStreamTextCapped(
  stream: unknown,
  maxChars: number,
): Promise<StreamTextResult> {
  if (!stream || typeof stream === "number") {
    return { text: "", totalChars: 0, capped: false };
  }

  // Bun.spawn pipes are ReadableStream<Uint8Array>.
  const maybeReadable = stream as { getReader?: unknown };
  if (typeof maybeReadable.getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    let text = "";
    let totalChars = 0;
    let capped = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const chunkText = decoder.decode(value, { stream: true });
        totalChars += chunkText.length;

        if (text.length < maxChars) {
          const remaining = maxChars - text.length;
          if (chunkText.length <= remaining) {
            text += chunkText;
          } else {
            text += chunkText.slice(0, remaining);
            capped = true;
          }
        } else {
          capped = true;
        }
      }

      const tail = decoder.decode();
      if (tail.length > 0) {
        totalChars += tail.length;
        if (text.length < maxChars) {
          const remaining = maxChars - text.length;
          text += tail.length <= remaining ? tail : tail.slice(0, remaining);
          if (tail.length > remaining) capped = true;
        } else {
          capped = true;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text, totalChars, capped };
  }

  // Fallback (should be rare): read everything, then cap.
  const full = await new Response(stream as any).text();
  return {
    text: full.length > maxChars ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    capped: full.length > maxChars,
  };
}

function limitBashOutput(
  input: { stdout: string; stderr: string },
  options?: { truncated?: boolean },
): {
  stdout: string;
  stderr: string;
  truncated: boolean;
} {
  const totalLen = input.stdout.length + input.stderr.length;
  const needsTruncation = totalLen > MAX_BASH_OUTPUT_CHARS;
  const shouldAddHint = Boolean(options?.truncated) || needsTruncation;
  if (!shouldAddHint) {
    return { ...input, truncated: false };
  }

  const suffix = BASH_TOOL_OUTPUT_TRUNCATED_SUFFIX;

  // If we can fit the hint without trimming, keep all content.
  if (totalLen + suffix.length <= MAX_BASH_OUTPUT_CHARS) {
    return {
      stdout: input.stdout,
      stderr: input.stderr + suffix,
      truncated: true,
    };
  }

  // Otherwise, reserve space for the hint so the agent always sees it.
  const available = Math.max(0, MAX_BASH_OUTPUT_CHARS - suffix.length);

  const stdoutPart = input.stdout.slice(0, available);
  const stderrPart =
    available > stdoutPart.length
      ? input.stderr.slice(0, available - stdoutPart.length)
      : "";

  return {
    stdout: stdoutPart,
    stderr: stderrPart + suffix,
    truncated: true,
  };
}

function withLimitedOutput(
  output: BashToolOutput,
  options?: { truncated?: boolean },
): BashToolOutput {
  const limited = limitBashOutput(
    { stdout: output.stdout, stderr: output.stderr },
    options,
  );
  if (!limited.truncated) return output;
  return { ...output, stdout: limited.stdout, stderr: limited.stderr };
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

  const githubEnv = await getGithubEnvForBash({ dataDir: env.dataDir });
  const vcsEnv = resolveVcsEnv({ dataDir: env.dataDir });

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
        ...githubEnv,
        ...vcsEnv,
        LILAC_REQUEST_ID: context?.requestId,
        LILAC_SESSION_ID: context?.sessionId,
        LILAC_REQUEST_CLIENT: context?.requestClient,
        LILAC_CWD: resolvedCwd,
      },
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamTextCapped(child.stdout, MAX_BASH_OUTPUT_CHARS),
      readStreamTextCapped(child.stderr, MAX_BASH_OUTPUT_CHARS),
      child.exited,
    ]);

    const stdout =
      stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr =
      stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    const safeStdout = redactSecrets(stdout);
    const safeStderr = redactSecrets(stderr);

    const durationMs = Date.now() - startedAt;

    const streamCapped =
      (stdoutResult.status === "fulfilled" && stdoutResult.value.capped) ||
      (stderrResult.status === "fulfilled" && stderrResult.value.capped);
    const outputTruncated =
      streamCapped ||
      safeStdout.length + safeStderr.length > MAX_BASH_OUTPUT_CHARS;

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

      return withLimitedOutput({
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode,
        executionError: {
          type: "timeout",
          timeoutMs: effectiveTimeoutMs,
          signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
        },
      }, { truncated: outputTruncated });
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

      return withLimitedOutput(
        {
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "stdout",
          message: toErrorMessage(stdoutResult.reason),
        },
      },
        { truncated: outputTruncated },
      );
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

      return withLimitedOutput(
        {
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "stderr",
          message: toErrorMessage(stderrResult.reason),
        },
      },
        { truncated: outputTruncated },
      );
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

      return withLimitedOutput(
        {
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: -1,
        executionError: {
          type: "exception",
          phase: "unknown",
          message: toErrorMessage(exitResult.reason),
        },
      },
        { truncated: outputTruncated },
      );
    }

    if (outputTruncated) {
      logger.warn("bash output truncated", {
        command: redactedCommand,
        cwd: resolvedCwd,
        exitCode,
        durationMs,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        stdoutTotalChars:
          stdoutResult.status === "fulfilled" ? stdoutResult.value.totalChars : 0,
        stderrTotalChars:
          stderrResult.status === "fulfilled" ? stderrResult.value.totalChars : 0,
        stdoutCapped:
          stdoutResult.status === "fulfilled" ? stdoutResult.value.capped : false,
        stderrCapped:
          stderrResult.status === "fulfilled" ? stderrResult.value.capped : false,
        requestId: context?.requestId,
        sessionId: context?.sessionId,
        requestClient: context?.requestClient,
      });
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

    return withLimitedOutput(
      { stdout: safeStdout, stderr: safeStderr, exitCode },
      { truncated: outputTruncated },
    );
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
