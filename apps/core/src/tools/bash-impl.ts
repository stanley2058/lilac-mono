import { env, resolveLogLevel, resolveVcsEnv } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { analyzeBashCommand } from "./bash-safety";
import { formatBlockedMessage, redactSecrets } from "./bash-safety/format";
import { expandTilde } from "./fs/fs-impl";

import { getGithubEnvForBash } from "../github/github-auth";

import {
  formatRemoteDisplayPath,
  parseSshCwdTarget,
  toBashSafetyCwdForRemote,
} from "../ssh/ssh-cwd";
import { sshExecBash } from "../ssh/ssh-exec";

const DEFAULT_BASH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_KILL_SIGNAL = "SIGTERM";
const DEFAULT_BASH_STDIN_MODE: BashStdinMode = "error";
const BASH_TRUNCATED_OUTPUT_DIR = "/tmp";

// Keep tool output bounded so we don't blow up agent context.
const MAX_BASH_OUTPUT_CHARS = 50 * 1024;

function buildBashOutputTruncationMessage(outputPath?: string): string {
  if (typeof outputPath === "string" && outputPath.length > 0) {
    return `Bash output truncated: exceeded ${MAX_BASH_OUTPUT_CHARS.toLocaleString()} characters. Full raw output saved to: ${outputPath}`;
  }

  return `Bash output truncated: exceeded ${MAX_BASH_OUTPUT_CHARS.toLocaleString()} characters. Full output file could not be written; narrow output and retry.`;
}

const logger = new Logger({
  logLevel: resolveLogLevel(),
  module: "tool:bash",
});

export type BashToolInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * stdin behavior for child commands.
   * - "error" (default): stdin reads fail immediately (EBADF).
   * - "eof": stdin is /dev/null (reads return EOF).
   */
  stdinMode?: BashStdinMode;
  /** Bypass bash safety guardrails for this call. */
  dangerouslyAllow?: boolean;
};

export type BashStdinMode = "error" | "eof";

export type BashExecutionError =
  | {
      type: "blocked";
      reason: string;
      segment?: string;
    }
  | {
      type: "aborted";
      signal?: string;
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
    }
  | {
      type: "truncated";
      message: string;
      outputPath?: string;
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
   * Tool-level error (timeout, spawn failure, stream read failure, output truncation).
   *
   * This is distinct from a command failure, which is represented by a non-zero exitCode.
   */
  executionError?: BashExecutionError;
  truncation?: {
    outputPath: string;
  };
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function stripAnsiEscapeSequences(input: string): string {
  return Bun.stripANSI(input);
}

type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
  overflowFilePath?: string;
};

async function appendOverflowChunk(params: {
  overflowFilePath: string;
  chunk: string;
  initialized: boolean;
}): Promise<boolean> {
  try {
    if (!params.initialized) {
      await fs.writeFile(params.overflowFilePath, params.chunk, {
        encoding: "utf8",
        mode: 0o600,
      });
    } else {
      await fs.appendFile(params.overflowFilePath, params.chunk, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

async function readStreamTextCapped(
  stream: unknown,
  maxChars: number,
  options?: { overflowFilePath?: string },
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
    let overflowInitialized = false;
    let overflowWriteFailed = false;
    let overflowFilePath: string | undefined;

    const writeOverflowChunk = async (chunk: string) => {
      if (chunk.length === 0) return;
      if (overflowWriteFailed) return;
      const target = options?.overflowFilePath;
      if (!target) return;

      const ok = await appendOverflowChunk({
        overflowFilePath: target,
        chunk,
        initialized: overflowInitialized,
      });
      if (!ok) {
        overflowWriteFailed = true;
        return;
      }
      overflowInitialized = true;
      overflowFilePath = target;
    };

    const consumeChunkText = async (chunkText: string) => {
      if (chunkText.length === 0) return;

      totalChars += chunkText.length;

      if (capped) {
        await writeOverflowChunk(chunkText);
        return;
      }

      const previousText = text;
      const nextLen = previousText.length + chunkText.length;
      if (nextLen <= maxChars) {
        text = previousText + chunkText;
        return;
      }

      capped = true;
      const remaining = Math.max(0, maxChars - previousText.length);
      text = previousText + chunkText.slice(0, remaining);
      await writeOverflowChunk(previousText + chunkText);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const chunkText = decoder.decode(value, { stream: true });
        await consumeChunkText(chunkText);
      }

      const tail = decoder.decode();
      if (tail.length > 0) {
        await consumeChunkText(tail);
      }
    } finally {
      reader.releaseLock();
    }

    return { text, totalChars, capped, overflowFilePath };
  }

  // Fallback (should be rare): read everything, then cap.
  const full = await new Response(stream as any).text();
  const capped = full.length > maxChars;
  let overflowFilePath: string | undefined;
  if (capped && options?.overflowFilePath) {
    const ok = await appendOverflowChunk({
      overflowFilePath: options.overflowFilePath,
      chunk: full,
      initialized: false,
    });
    if (ok) overflowFilePath = options.overflowFilePath;
  }

  return {
    text: full.length > maxChars ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    capped,
    overflowFilePath,
  };
}

function sanitizeTempFileToken(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return fallback;

  const safe = trimmed
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return safe.length > 0 ? safe : fallback;
}

function buildTruncatedOutputPaths(params: { requestId?: string; toolCallId?: string }): {
  outputPath: string;
  stdoutOverflowPath: string;
  stderrOverflowPath: string;
} {
  const requestToken = sanitizeTempFileToken(params.requestId, "unknown-request");
  const toolToken = sanitizeTempFileToken(params.toolCallId, "unknown-tool");
  const fileName = `${requestToken}-${toolToken}.log`;
  const outputPath = path.join(BASH_TRUNCATED_OUTPUT_DIR, fileName);
  return {
    outputPath,
    stdoutOverflowPath: `${outputPath}.stdout.part`,
    stderrOverflowPath: `${outputPath}.stderr.part`,
  };
}

async function appendSectionOutput(params: {
  outputPath: string;
  label: "stdout" | "stderr";
  captured: string;
  overflowFilePath?: string;
}) {
  await fs.appendFile(params.outputPath, `--- ${params.label} ---\n`, "utf8");

  if (params.overflowFilePath) {
    try {
      await fs.stat(params.overflowFilePath);
      await pipeline(
        createReadStream(params.overflowFilePath),
        createWriteStream(params.outputPath, { flags: "a", mode: 0o600 }),
      );
      await fs.appendFile(params.outputPath, "\n", "utf8");
      return;
    } catch {
      // Fall back to captured fragment when spill file is unavailable.
    }
  }

  if (params.captured.length > 0) {
    await fs.appendFile(params.outputPath, params.captured, "utf8");
  }
  await fs.appendFile(params.outputPath, "\n", "utf8");
}

async function maybeWriteTruncatedOutputFile(params: {
  outputPath: string;
  requestId?: string;
  toolCallId?: string;
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Promise<string | undefined> {
  try {
    const header =
      "<bash_tool_full_output>\n" +
      `requestId: ${params.requestId ?? "unknown"}\n` +
      `toolCallId: ${params.toolCallId ?? "unknown"}\n\n`;
    await fs.writeFile(params.outputPath, header, {
      encoding: "utf8",
      mode: 0o600,
    });

    await appendSectionOutput({
      outputPath: params.outputPath,
      label: "stdout",
      captured: params.stdout,
      overflowFilePath: params.stdoutOverflowPath,
    });

    await fs.appendFile(params.outputPath, "\n", "utf8");

    await appendSectionOutput({
      outputPath: params.outputPath,
      label: "stderr",
      captured: params.stderr,
      overflowFilePath: params.stderrOverflowPath,
    });

    await fs.appendFile(params.outputPath, "</bash_tool_full_output>\n", "utf8");
    await fs.chmod(params.outputPath, 0o600);
  } catch {
    return undefined;
  }

  if (params.stdoutOverflowPath) {
    await fs.unlink(params.stdoutOverflowPath).catch(() => undefined);
  }
  if (params.stderrOverflowPath) {
    await fs.unlink(params.stderrOverflowPath).catch(() => undefined);
  }

  return params.outputPath;
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
  const truncated = Boolean(options?.truncated) || totalLen > MAX_BASH_OUTPUT_CHARS;
  if (!truncated) {
    return { ...input, truncated: false };
  }

  if (totalLen <= MAX_BASH_OUTPUT_CHARS) {
    return {
      stdout: input.stdout,
      stderr: input.stderr,
      truncated: true,
    };
  }

  const available = Math.max(0, MAX_BASH_OUTPUT_CHARS);

  const stdoutPart = input.stdout.slice(0, available);
  const stderrPart =
    available > stdoutPart.length ? input.stderr.slice(0, available - stdoutPart.length) : "";

  return {
    stdout: stdoutPart,
    stderr: stderrPart,
    truncated: true,
  };
}

function withLimitedOutput(
  output: BashToolOutput,
  options?: { truncated?: boolean; outputPath?: string },
): BashToolOutput {
  const limited = limitBashOutput(
    { stdout: output.stdout, stderr: output.stderr },
    { truncated: options?.truncated },
  );
  if (!limited.truncated) return output;

  const truncationMessage = buildBashOutputTruncationMessage(options?.outputPath);
  const executionError =
    output.executionError ??
    ({
      type: "truncated",
      message: truncationMessage,
      ...(options?.outputPath ? { outputPath: options.outputPath } : {}),
    } satisfies BashExecutionError);

  const truncation =
    typeof options?.outputPath === "string" && options.outputPath.length > 0
      ? { outputPath: options.outputPath }
      : output.truncation;

  return {
    ...output,
    stdout: limited.stdout,
    stderr: limited.stderr,
    executionError,
    ...(truncation ? { truncation } : {}),
  };
}

function buildBashChildEnv(params: {
  githubEnv: Record<string, string>;
  vcsEnv: Record<string, string>;
  context?: {
    requestId: string;
    sessionId: string;
    requestClient: string;
  };
  resolvedCwd: string;
}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.githubEnv,
    ...params.vcsEnv,
    LILAC_REQUEST_ID: params.context?.requestId,
    LILAC_SESSION_ID: params.context?.sessionId,
    LILAC_REQUEST_CLIENT: params.context?.requestClient,
    LILAC_CWD: params.resolvedCwd,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

function buildLocalSpawnArgs(command: string, stdinMode: BashStdinMode): string[] {
  if (stdinMode === "eof") {
    return ["bash", "-c", command];
  }

  return ["bash", "-c", `exec 0>/dev/null; ${command}`];
}

export async function executeBash(
  { command, cwd, timeoutMs, stdinMode, dangerouslyAllow }: BashToolInput,
  {
    context,
    abortSignal,
    toolCallId,
  }: {
    context?: {
      requestId: string;
      sessionId: string;
      requestClient: string;
    };
    abortSignal?: AbortSignal;
    toolCallId?: string;
  } = {},
): Promise<BashToolOutput> {
  const cwdTarget = parseSshCwdTarget(cwd);
  const resolvedCwd =
    cwdTarget.kind === "local"
      ? cwdTarget.cwd
        ? expandTilde(cwdTarget.cwd)
        : process.cwd()
      : cwdTarget.cwd;
  const displayCwd =
    cwdTarget.kind === "ssh" ? formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd) : resolvedCwd;
  const remoteLogMeta =
    cwdTarget.kind === "ssh" ? { sshHost: cwdTarget.host, remoteCwd: cwdTarget.cwd } : {};

  const redactedCommand = redactSecrets(command);
  const effectiveStdinMode = stdinMode ?? DEFAULT_BASH_STDIN_MODE;
  const startedAt = Date.now();
  const truncatedOutputPaths = buildTruncatedOutputPaths({
    requestId: context?.requestId,
    toolCallId,
  });

  logger.info("bash exec", {
    command: redactedCommand,
    cwd: displayCwd,
    target: cwdTarget.kind,
    ...remoteLogMeta,
    timeoutMs: timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
    stdinMode: effectiveStdinMode,
    dangerouslyAllow: dangerouslyAllow === true,
    requestId: context?.requestId,
    sessionId: context?.sessionId,
    requestClient: context?.requestClient,
    toolCallId,
  });

  if (!dangerouslyAllow) {
    const safetyCwd =
      cwdTarget.kind === "ssh" ? toBashSafetyCwdForRemote(cwdTarget.cwd) : resolvedCwd;
    const blocked = analyzeBashCommand(command, { cwd: safetyCwd });
    if (blocked) {
      logger.warn("bash blocked", {
        command: redactedCommand,
        cwd: displayCwd,
        ...remoteLogMeta,
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
  let aborted = false;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const killProcessGroupBestEffort = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    // Best-effort: kill the whole subprocess group (tools cli, ssh, etc.).
    // Requires the child to be spawned as a new process group leader.
    try {
      // Negative pid means "process group" on POSIX.
      process.kill(-pid, signal);
    } catch {
      // ignore
    }
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  };

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = (child as { pid?: unknown } | null)?.pid;
      if (typeof pid === "number" && pid > 0) {
        killProcessGroupBestEffort(pid, "SIGKILL");
      }
    }, HARD_KILL_DELAY_MS);
  };

  let abortListener: (() => void) | null = null;
  if (abortSignal) {
    const onAbort = () => {
      aborted = true;
      controller.abort();
      const pid = child?.pid;
      if (pid) {
        killProcessGroupBestEffort(pid, "SIGTERM");
        scheduleHardKill();
      }
    };
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => abortSignal.removeEventListener("abort", onAbort);
    }
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      killProcessGroupBestEffort(pid, "SIGTERM");
      scheduleHardKill();
    }
  }, effectiveTimeoutMs);

  try {
    const execResult =
      cwdTarget.kind === "ssh"
        ? await sshExecBash({
            host: cwdTarget.host,
            cmd: command,
            cwd: cwdTarget.cwd,
            timeoutMs: effectiveTimeoutMs,
            stdinMode: effectiveStdinMode,
            signal: controller.signal,
            maxOutputChars: MAX_BASH_OUTPUT_CHARS,
            overflowOutputPath: truncatedOutputPaths.outputPath,
          })
        : null;

    if (cwdTarget.kind === "ssh" && execResult) {
      const stdout = execResult.stdout;
      const stderr = execResult.stderr;
      const exitCode = execResult.exitCode;

      const safeStdout = stripAnsiEscapeSequences(redactSecrets(stdout));
      const safeStderr = stripAnsiEscapeSequences(redactSecrets(stderr));

      const streamCapped = execResult.capped.stdout || execResult.capped.stderr;
      const outputTruncated =
        streamCapped || safeStdout.length + safeStderr.length > MAX_BASH_OUTPUT_CHARS;
      const truncatedOutputPath = outputTruncated
        ? await maybeWriteTruncatedOutputFile({
            outputPath: truncatedOutputPaths.outputPath,
            requestId: context?.requestId,
            toolCallId,
            stdout,
            stderr,
            stdoutOverflowPath: execResult.overflowPaths.stdout,
            stderrOverflowPath: execResult.overflowPaths.stderr,
          })
        : undefined;

      const durationMs = execResult.durationMs;

      if (execResult.aborted && timedOut) {
        logger.warn("bash timeout", {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
          timeoutMs: effectiveTimeoutMs,
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        });

        return withLimitedOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "timeout",
              timeoutMs: effectiveTimeoutMs,
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          { truncated: outputTruncated, outputPath: truncatedOutputPath },
        );
      }

      if (execResult.aborted || aborted) {
        logger.warn("bash aborted", {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
          timeoutMs: effectiveTimeoutMs,
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        });

        return withLimitedOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "aborted",
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          { truncated: outputTruncated, outputPath: truncatedOutputPath },
        );
      }

      if (execResult.timedOut || timedOut) {
        logger.warn("bash timeout", {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
          timeoutMs: effectiveTimeoutMs,
          signal: DEFAULT_KILL_SIGNAL,
          exitCode,
          durationMs,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        });

        return withLimitedOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "timeout",
              timeoutMs: effectiveTimeoutMs,
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          { truncated: outputTruncated, outputPath: truncatedOutputPath },
        );
      }

      if (outputTruncated) {
        logger.warn("bash output truncated", {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
          exitCode,
          durationMs,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stdoutTotalChars: stdout.length,
          stderrTotalChars: stderr.length,
          stdoutCapped: execResult.capped.stdout,
          stderrCapped: execResult.capped.stderr,
          outputPath: truncatedOutputPath,
          requestId: context?.requestId,
          sessionId: context?.sessionId,
          requestClient: context?.requestClient,
        });
      }

      const ok = exitCode === 0;
      if (ok) {
        logger.info("bash done", {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
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
          cwd: displayCwd,
          ...remoteLogMeta,
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
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    // Local execution path.
    // Intentionally avoid a login shell here.
    // Login shells source /etc/profile (and friends) which can clobber PATH
    // and diverge from the process environment we want the tool to inherit.
    child = Bun.spawn(buildLocalSpawnArgs(command, effectiveStdinMode), {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      killSignal: DEFAULT_KILL_SIGNAL,
      detached: true,
      env: buildBashChildEnv({
        githubEnv,
        vcsEnv,
        context,
        resolvedCwd,
      }),
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamTextCapped(child.stdout, MAX_BASH_OUTPUT_CHARS, {
        overflowFilePath: truncatedOutputPaths.stdoutOverflowPath,
      }),
      readStreamTextCapped(child.stderr, MAX_BASH_OUTPUT_CHARS, {
        overflowFilePath: truncatedOutputPaths.stderrOverflowPath,
      }),
      child.exited,
    ]);

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    const safeStdout = stripAnsiEscapeSequences(redactSecrets(stdout));
    const safeStderr = stripAnsiEscapeSequences(redactSecrets(stderr));

    const durationMs = Date.now() - startedAt;

    const streamCapped =
      (stdoutResult.status === "fulfilled" && stdoutResult.value.capped) ||
      (stderrResult.status === "fulfilled" && stderrResult.value.capped);
    const outputTruncated =
      streamCapped || safeStdout.length + safeStderr.length > MAX_BASH_OUTPUT_CHARS;
    const truncatedOutputPath = outputTruncated
      ? await maybeWriteTruncatedOutputFile({
          outputPath: truncatedOutputPaths.outputPath,
          requestId: context?.requestId,
          toolCallId,
          stdout,
          stderr,
          stdoutOverflowPath:
            stdoutResult.status === "fulfilled" ? stdoutResult.value.overflowFilePath : undefined,
          stderrOverflowPath:
            stderrResult.status === "fulfilled" ? stderrResult.value.overflowFilePath : undefined,
        })
      : undefined;

    if (aborted && child.killed) {
      logger.warn("bash aborted", {
        command: redactedCommand,
        cwd: displayCwd,
        ...remoteLogMeta,
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

      return withLimitedOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode,
          executionError: {
            type: "aborted",
            signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
          },
        },
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    if (timedOut && child.killed) {
      logger.warn("bash timeout", {
        command: redactedCommand,
        cwd: displayCwd,
        ...remoteLogMeta,
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

      return withLimitedOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode,
          executionError: {
            type: "timeout",
            timeoutMs: effectiveTimeoutMs,
            signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
          },
        },
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    if (stdoutResult.status === "rejected") {
      logger.error(
        "bash stdout read failed",
        {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
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
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    if (stderrResult.status === "rejected") {
      logger.error(
        "bash stderr read failed",
        {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
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
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    if (exitResult.status === "rejected") {
      logger.error(
        "bash exit status read failed",
        {
          command: redactedCommand,
          cwd: displayCwd,
          ...remoteLogMeta,
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
        { truncated: outputTruncated, outputPath: truncatedOutputPath },
      );
    }

    if (outputTruncated) {
      logger.warn("bash output truncated", {
        command: redactedCommand,
        cwd: displayCwd,
        ...remoteLogMeta,
        exitCode,
        durationMs,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        stdoutTotalChars: stdoutResult.status === "fulfilled" ? stdoutResult.value.totalChars : 0,
        stderrTotalChars: stderrResult.status === "fulfilled" ? stderrResult.value.totalChars : 0,
        stdoutCapped: stdoutResult.status === "fulfilled" ? stdoutResult.value.capped : false,
        stderrCapped: stderrResult.status === "fulfilled" ? stderrResult.value.capped : false,
        outputPath: truncatedOutputPath,
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
        cwd: displayCwd,
        ...remoteLogMeta,
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
        cwd: displayCwd,
        ...remoteLogMeta,
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
      { truncated: outputTruncated, outputPath: truncatedOutputPath },
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      "bash spawn failed",
      {
        command: redactedCommand,
        cwd: displayCwd,
        ...remoteLogMeta,
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
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
    abortListener?.();
  }
}
