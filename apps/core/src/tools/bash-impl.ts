import {
  createLogger,
  env,
  resolveVcsEnv,
  type CoreConfig,
  type NativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { analyzeBashCommand } from "./bash-safety";
import { formatBlockedMessage, redactSecrets } from "./bash-safety/format";
import { expandTilde } from "@stanley2058/lilac-fs";

import { getGithubEnvForBash } from "../github/github-auth";

import {
  formatRemoteDisplayPath,
  parseSshCwdTarget,
  toBashSafetyCwdForRemote,
} from "../ssh/ssh-cwd";
import { sshExecBash } from "../ssh/ssh-exec";
import {
  createBashOutputSanitizerTransform,
  readSanitizedStreamTextCapped,
} from "./bash-output-sanitizer";
import { loadToolEnv } from "./tool-env";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";

const DEFAULT_BASH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_KILL_SIGNAL = "SIGTERM";
const DEFAULT_BASH_STDIN_MODE: BashStdinMode = "error";
const BASH_TRUNCATED_OUTPUT_DIR = "/tmp";

const DEFAULT_MAX_BASH_OUTPUT_BYTES = 40 * 1024;

const logger = createLogger({
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
   * Tool-level error (timeout, spawn failure, or stream read failure).
   *
   * This is distinct from a command failure, which is represented by a non-zero exitCode.
   */
  executionError?: BashExecutionError;
  truncation?: {
    artifactUri?: string;
    message: string;
    originalStdoutBytes: number;
    originalStderrBytes: number;
    previewBytes: number;
    completeOutputRetained: boolean;
  };
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function stripAnsiEscapeSequences(input: string): string {
  let output = "";
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) output += input.slice(plainStart, end);
  };

  const skipCsi = (start: number): number => {
    let i = start;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      i += 1;
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return i;
  };

  const skipOsc = (start: number): number => {
    let i = start;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code === 0x07) return i + 1;
      if (code === 0x9c) return i + 1;
      if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
      i += 1;
    }
    return i;
  };

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      flushPlain(i);
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = skipCsi(i + 2) - 1;
      } else if (next === 0x5d) {
        i = skipOsc(i + 2) - 1;
      } else {
        i = Math.min(i + 1, input.length - 1);
      }
      plainStart = i + 1;
      continue;
    }

    if (code === 0x9b) {
      flushPlain(i);
      i = skipCsi(i + 1) - 1;
      plainStart = i + 1;
      continue;
    }

    if (code === 0x9d) {
      flushPlain(i);
      i = skipOsc(i + 1) - 1;
      plainStart = i + 1;
    }
  }

  flushPlain(input.length);
  return [...output]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f;
    })
    .join("");
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
  const fileName = `${requestToken}-${toolToken}-${randomUUID()}.log`;
  const outputPath = path.join(BASH_TRUNCATED_OUTPUT_DIR, fileName);
  return {
    outputPath,
    stdoutOverflowPath: `${outputPath}.stdout.part`,
    stderrOverflowPath: `${outputPath}.stderr.part`,
  };
}

function createBashArtifactSource(params: {
  requestId?: string;
  toolCallId?: string;
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Readable {
  async function* content() {
    yield (
      "<bash_tool_full_output>\n" +
        `requestId: ${params.requestId ?? "unknown"}\n` +
        `toolCallId: ${params.toolCallId ?? "unknown"}\n\n`
    );
    yield "--- stdout ---\n";
    if (params.stdoutOverflowPath) yield* createReadStream(params.stdoutOverflowPath);
    else yield params.stdout;
    yield "\n\n--- stderr ---\n";
    if (params.stderrOverflowPath) yield* createReadStream(params.stderrOverflowPath);
    else yield params.stderr;
    yield "\n</bash_tool_full_output>\n";
  }

  return Readable.from(content());
}

function takeUtf8Edge(value: string, maxBytes: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  let bytes = 0;
  let output = "";
  const start = fromEnd ? characters.length - 1 : 0;
  const stop = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== stop; index += step) {
    const character = characters[index]!;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output = fromEnd ? character + output : output + character;
    bytes += characterBytes;
  }
  return output;
}

function previewStream(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const totalCharacters = Array.from(value).length;
  const marker = `\n...[${totalCharacters} characters omitted]...\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return takeUtf8Edge(value, maxBytes, false);
  const contentBudget = maxBytes - markerBytes;
  const head = takeUtf8Edge(value, Math.ceil(contentBudget / 2), false);
  const tail = takeUtf8Edge(value, Math.floor(contentBudget / 2), true);
  const omitted = Math.max(0, totalCharacters - Array.from(head).length - Array.from(tail).length);
  return `${head}\n...[${omitted} characters omitted]...\n${tail}`;
}

async function overflowStreamBytes(captured: string, overflowPath?: string): Promise<number> {
  if (!overflowPath) return Buffer.byteLength(captured, "utf8");
  try {
    return (await fs.stat(overflowPath)).size;
  } catch {
    return Buffer.byteLength(captured, "utf8");
  }
}

async function buildOverflowStreamPreview(params: {
  captured: string;
  overflowPath?: string;
  maxBytes: number;
  literalSecrets: readonly string[];
}): Promise<string> {
  if (!params.overflowPath) return previewStream(params.captured, params.maxBytes);
  const marker = "\n...[output omitted]...\n";
  const contentBudget = Math.max(0, params.maxBytes - Buffer.byteLength(marker, "utf8"));
  const head = takeUtf8Edge(params.captured, Math.ceil(contentBudget / 2), false);
  let tail = "";
  try {
    const handle = await fs.open(params.overflowPath, "r");
    try {
      const stat = await handle.stat();
      const readBytes = Math.min(stat.size, Math.max(4096, contentBudget * 4));
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
      const sanitized = redactSecrets(
        stripAnsiEscapeSequences(buffer.toString("utf8")),
        params.literalSecrets,
      );
      tail = takeUtf8Edge(sanitized, Math.floor(contentBudget / 2), true);
    } finally {
      await handle.close();
    }
  } catch {
    return previewStream(params.captured, params.maxBytes);
  }
  return `${head}${marker}${tail}`;
}

function allocateStreamPreviewBytes(params: {
  stdoutBytes: number;
  stderrBytes: number;
  maxBytes: number;
}): { stdout: number; stderr: number } {
  const both = params.stdoutBytes > 0 && params.stderrBytes > 0;
  let stdout = both
    ? Math.min(params.stdoutBytes, Math.ceil(params.maxBytes / 2))
    : params.stdoutBytes > 0
      ? params.maxBytes
      : 0;
  let stderr = both
    ? Math.min(params.stderrBytes, Math.floor(params.maxBytes / 2))
    : params.stderrBytes > 0
      ? params.maxBytes
      : 0;
  let remaining = Math.max(0, params.maxBytes - stdout - stderr);
  const stdoutExtra = Math.min(Math.max(0, params.stdoutBytes - stdout), remaining);
  stdout += stdoutExtra;
  remaining -= stdoutExtra;
  stderr += Math.min(Math.max(0, params.stderrBytes - stderr), remaining);
  return { stdout, stderr };
}

function limitBashOutput(
  input: { stdout: string; stderr: string },
  maxOutputBytes: number,
  options?: { truncated?: boolean },
): {
  stdout: string;
  stderr: string;
  truncated: boolean;
} {
  const stdoutBytes = Buffer.byteLength(input.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(input.stderr, "utf8");
  const totalBytes = stdoutBytes + stderrBytes;
  const truncated = Boolean(options?.truncated) || totalBytes > maxOutputBytes;
  if (!truncated) {
    return { ...input, truncated: false };
  }

  if (totalBytes <= maxOutputBytes) {
    return {
      stdout: input.stdout,
      stderr: input.stderr,
      truncated: true,
    };
  }

  const available = Math.max(0, maxOutputBytes);
  const bothStreams = input.stdout.length > 0 && input.stderr.length > 0;
  let stdoutBudget = bothStreams
    ? Math.min(stdoutBytes, Math.ceil(available / 2))
    : input.stdout.length > 0
      ? available
      : 0;
  let stderrBudget = bothStreams
    ? Math.min(stderrBytes, Math.floor(available / 2))
    : input.stderr.length > 0
      ? available
      : 0;
  let remaining = Math.max(0, available - stdoutBudget - stderrBudget);
  const stdoutNeed = Math.max(0, stdoutBytes - stdoutBudget);
  const stdoutExtra = Math.min(stdoutNeed, remaining);
  stdoutBudget += stdoutExtra;
  remaining -= stdoutExtra;
  stderrBudget += Math.min(Math.max(0, stderrBytes - stderrBudget), remaining);
  let stdoutPart = previewStream(input.stdout, stdoutBudget);
  let stderrPart = previewStream(input.stderr, stderrBudget);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const usedBytes = Buffer.byteLength(stdoutPart, "utf8") + Buffer.byteLength(stderrPart, "utf8");
    if (usedBytes <= available) break;
    const excess = usedBytes - available;
    if (stdoutBudget > 0 && stderrBudget > 0) {
      stdoutBudget = Math.max(0, stdoutBudget - Math.ceil(excess / 2));
      stderrBudget = Math.max(0, stderrBudget - Math.floor(excess / 2));
    } else if (stdoutBudget > 0) {
      stdoutBudget = Math.max(0, stdoutBudget - excess);
    } else {
      stderrBudget = Math.max(0, stderrBudget - excess);
    }
    stdoutPart = previewStream(input.stdout, stdoutBudget);
    stderrPart = previewStream(input.stderr, stderrBudget);
  }

  return {
    stdout: stdoutPart,
    stderr: stderrPart,
    truncated: true,
  };
}

export function withLimitedBashOutput(
  output: BashToolOutput,
  options: {
    maxOutputBytes: number;
    truncated?: boolean;
    artifactUri?: string;
    originalStdoutBytes?: number;
    originalStderrBytes?: number;
  },
): BashToolOutput {
  const limited = limitBashOutput(
    { stdout: output.stdout, stderr: output.stderr },
    options.maxOutputBytes,
    { truncated: options.truncated },
  );
  if (!limited.truncated) return output;

  const originalStdoutBytes =
    options.originalStdoutBytes ?? Buffer.byteLength(output.stdout, "utf8");
  const originalStderrBytes =
    options.originalStderrBytes ?? Buffer.byteLength(output.stderr, "utf8");
  const message = options.artifactUri
    ? `Bash output was truncated. Complete output: ${options.artifactUri}. Use read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.`
    : "Bash output was truncated and the complete output could not be retained. Re-run the command with narrower output if needed.";

  logger.info("tool.result.truncated", {
    toolName: "bash",
    outputKind: "stdout-stderr",
    originalBytes: originalStdoutBytes + originalStderrBytes,
    previewBytes:
      Buffer.byteLength(limited.stdout, "utf8") + Buffer.byteLength(limited.stderr, "utf8"),
    artifactStored: options.artifactUri !== undefined,
  });

  return {
    ...output,
    stdout: limited.stdout,
    stderr: limited.stderr,
    truncation: {
      ...(options.artifactUri ? { artifactUri: options.artifactUri } : {}),
      message,
      originalStdoutBytes,
      originalStderrBytes,
      previewBytes:
        Buffer.byteLength(limited.stdout, "utf8") + Buffer.byteLength(limited.stderr, "utf8"),
      completeOutputRetained: options.artifactUri !== undefined,
    },
  };
}

async function persistTruncatedOutput(params: {
  artifacts?: ToolResultArtifactStore;
  outputConfig: CoreConfig["tools"]["output"];
  context?: { requestId: string; sessionId: string; requestClient: string };
  toolCallId?: string;
  literalSecrets: readonly string[];
  stdout: string;
  stderr: string;
  stdoutOverflowPath?: string;
  stderrOverflowPath?: string;
}): Promise<{ uri?: string }> {
  try {
    if (!params.artifacts || !params.context || !params.toolCallId) return {};
    const source = createBashArtifactSource({
      requestId: params.context.requestId,
      toolCallId: params.toolCallId,
      stdout: params.stdout,
      stderr: params.stderr,
      stdoutOverflowPath: params.stdoutOverflowPath,
      stderrOverflowPath: params.stderrOverflowPath,
    }).pipe(createBashOutputSanitizerTransform(params.literalSecrets));
    const artifact = await params.artifacts.createFromStream({
      sessionId: params.context.sessionId,
      requestId: params.context.requestId,
      toolCallId: params.toolCallId,
      toolName: "bash",
      source,
      ttlMs: params.outputConfig.artifactTtlMs,
      maxBytesPerSession: params.outputConfig.artifactMaxBytesPerSession,
    });
    return { uri: artifact.uri };
  } catch (error) {
    logger.warn("tool.artifact.write_failed", {
      toolName: "bash",
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  } finally {
    await Promise.all([
      params.stdoutOverflowPath
        ? fs.rm(params.stdoutOverflowPath, { force: true }).catch(() => undefined)
        : undefined,
      params.stderrOverflowPath
        ? fs.rm(params.stderrOverflowPath, { force: true }).catch(() => undefined)
        : undefined,
    ]);
  }
}

function buildBashChildEnv(params: {
  toolEnv: Record<string, string>;
  githubEnv: Record<string, string>;
  vcsEnv: Record<string, string>;
  context?: {
    requestId: string;
    sessionId: string;
    requestClient: string;
  };
  resolvedCwd: string;
  toolCallId?: string;
  controlCapability?: string;
  subagentProfile?: NativeSubagentProfile;
}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.toolEnv,
    ...params.githubEnv,
    ...params.vcsEnv,
    LILAC_REQUEST_ID: params.context?.requestId,
    LILAC_SESSION_ID: params.context?.sessionId,
    LILAC_REQUEST_CLIENT: params.context?.requestClient,
    LILAC_CWD: params.resolvedCwd,
    LILAC_TOOL_CALL_ID: params.toolCallId,
    LILAC_CONTROL_CAPABILITY: params.controlCapability,
    LILAC_SUBAGENT_PROFILE: params.subagentProfile,
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
    artifacts,
    outputConfig = {
      maxPreviewBytes: DEFAULT_MAX_BASH_OUTPUT_BYTES,
      artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    },
    onActivity,
    controlCapability,
    subagentProfile,
  }: {
    context?: {
      requestId: string;
      sessionId: string;
      requestClient: string;
    };
    abortSignal?: AbortSignal;
    toolCallId?: string;
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
    onActivity?: () => void;
    controlCapability?: string;
    subagentProfile?: NativeSubagentProfile;
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
            maxOutputChars: outputConfig.maxPreviewBytes,
            overflowOutputPath: truncatedOutputPaths.outputPath,
            onActivity,
          })
        : null;

    if (cwdTarget.kind === "ssh" && execResult) {
      const stdout = execResult.stdout;
      const stderr = execResult.stderr;
      const exitCode = execResult.exitCode;

      let safeStdout = redactSecrets(stripAnsiEscapeSequences(stdout));
      let safeStderr = redactSecrets(stripAnsiEscapeSequences(stderr));

      const streamCapped = execResult.capped.stdout || execResult.capped.stderr;
      const outputTruncated =
        streamCapped ||
        Buffer.byteLength(safeStdout, "utf8") + Buffer.byteLength(safeStderr, "utf8") >
          outputConfig.maxPreviewBytes;
      const spillIncomplete =
        (execResult.capped.stdout && !execResult.overflowPaths.stdout) ||
        (execResult.capped.stderr && !execResult.overflowPaths.stderr);
      let originalStdoutBytes = Buffer.byteLength(safeStdout, "utf8");
      let originalStderrBytes = Buffer.byteLength(safeStderr, "utf8");
      if (outputTruncated) {
        [originalStdoutBytes, originalStderrBytes] = await Promise.all([
          overflowStreamBytes(safeStdout, execResult.overflowPaths.stdout),
          overflowStreamBytes(safeStderr, execResult.overflowPaths.stderr),
        ]);
        const budgets = allocateStreamPreviewBytes({
          stdoutBytes: originalStdoutBytes,
          stderrBytes: originalStderrBytes,
          maxBytes: outputConfig.maxPreviewBytes,
        });
        [safeStdout, safeStderr] = await Promise.all([
          buildOverflowStreamPreview({
            captured: safeStdout,
            overflowPath: execResult.overflowPaths.stdout,
            maxBytes: budgets.stdout,
            literalSecrets: [],
          }),
          buildOverflowStreamPreview({
            captured: safeStderr,
            overflowPath: execResult.overflowPaths.stderr,
            maxBytes: budgets.stderr,
            literalSecrets: [],
          }),
        ]);
      }
      const persistedOutput =
        outputTruncated && !spillIncomplete
          ? await persistTruncatedOutput({
              artifacts,
              outputConfig,
              context,
              toolCallId,
              literalSecrets: [],
              stdout,
              stderr,
              stdoutOverflowPath: execResult.overflowPaths.stdout,
              stderrOverflowPath: execResult.overflowPaths.stderr,
            })
          : {};
      const artifactUri = persistedOutput.uri;
      const bashLimitOptions = {
        truncated: outputTruncated,
        artifactUri,
        maxOutputBytes: outputConfig.maxPreviewBytes,
        originalStdoutBytes,
        originalStderrBytes,
      };

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

        return withLimitedBashOutput(
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
          bashLimitOptions,
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

        return withLimitedBashOutput(
          {
            stdout: safeStdout,
            stderr: safeStderr,
            exitCode,
            executionError: {
              type: "aborted",
              signal: DEFAULT_KILL_SIGNAL,
            },
          },
          bashLimitOptions,
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

        return withLimitedBashOutput(
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
          bashLimitOptions,
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
          artifactUri,
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

      return withLimitedBashOutput(
        { stdout: safeStdout, stderr: safeStderr, exitCode },
        bashLimitOptions,
      );
    }

    // Local execution path.
    // Intentionally avoid a login shell here.
    // Login shells source /etc/profile (and friends) which can clobber PATH
    // and diverge from the process environment we want the tool to inherit.
    const toolEnv = await loadToolEnv(env.dataDir);
    const outputSecrets = [
      ...Object.values(toolEnv),
      ...Object.entries(githubEnv)
        .filter(([name]) => name.includes("TOKEN"))
        .map(([, value]) => value),
    ].map(stripAnsiEscapeSequences);
    child = Bun.spawn(buildLocalSpawnArgs(command, effectiveStdinMode), {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: controller.signal,
      killSignal: DEFAULT_KILL_SIGNAL,
      detached: true,
      env: buildBashChildEnv({
        toolEnv,
        githubEnv,
        vcsEnv,
        context,
        resolvedCwd,
        toolCallId,
        controlCapability,
        subagentProfile,
      }),
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readSanitizedStreamTextCapped(child.stdout, outputConfig.maxPreviewBytes, {
        overflowFilePath: truncatedOutputPaths.stdoutOverflowPath,
        literalSecrets: outputSecrets,
        onActivity,
      }),
      readSanitizedStreamTextCapped(child.stderr, outputConfig.maxPreviewBytes, {
        overflowFilePath: truncatedOutputPaths.stderrOverflowPath,
        literalSecrets: outputSecrets,
        onActivity,
      }),
      child.exited,
    ]);

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    let safeStdout = redactSecrets(stdout);
    let safeStderr = redactSecrets(stderr);

    const durationMs = Date.now() - startedAt;

    const streamCapped =
      (stdoutResult.status === "fulfilled" && stdoutResult.value.capped) ||
      (stderrResult.status === "fulfilled" && stderrResult.value.capped);
    const outputTruncated =
      streamCapped ||
      Buffer.byteLength(safeStdout, "utf8") + Buffer.byteLength(safeStderr, "utf8") >
        outputConfig.maxPreviewBytes;
    const spillIncomplete =
      (stdoutResult.status === "fulfilled" &&
        stdoutResult.value.capped &&
        !stdoutResult.value.overflowFilePath) ||
      (stderrResult.status === "fulfilled" &&
        stderrResult.value.capped &&
        !stderrResult.value.overflowFilePath);
    const artifactStdout = safeStdout;
    const artifactStderr = safeStderr;
    const stdoutOverflowPath =
      stdoutResult.status === "fulfilled" ? stdoutResult.value.overflowFilePath : undefined;
    const stderrOverflowPath =
      stderrResult.status === "fulfilled" ? stderrResult.value.overflowFilePath : undefined;
    let originalStdoutBytes = Buffer.byteLength(safeStdout, "utf8");
    let originalStderrBytes = Buffer.byteLength(safeStderr, "utf8");
    if (outputTruncated) {
      originalStdoutBytes =
        stdoutResult.status === "fulfilled"
          ? stdoutResult.value.totalBytes
          : Buffer.byteLength(safeStdout, "utf8");
      originalStderrBytes =
        stderrResult.status === "fulfilled"
          ? stderrResult.value.totalBytes
          : Buffer.byteLength(safeStderr, "utf8");
      const budgets = allocateStreamPreviewBytes({
        stdoutBytes: originalStdoutBytes,
        stderrBytes: originalStderrBytes,
        maxBytes: outputConfig.maxPreviewBytes,
      });
      [safeStdout, safeStderr] = await Promise.all([
        buildOverflowStreamPreview({
          captured: safeStdout,
          overflowPath: stdoutOverflowPath,
          maxBytes: budgets.stdout,
          literalSecrets: outputSecrets,
        }),
        buildOverflowStreamPreview({
          captured: safeStderr,
          overflowPath: stderrOverflowPath,
          maxBytes: budgets.stderr,
          literalSecrets: outputSecrets,
        }),
      ]);
    }
    const persistedOutput =
      outputTruncated && !spillIncomplete
        ? await persistTruncatedOutput({
            artifacts,
            outputConfig,
            context,
            toolCallId,
            literalSecrets: outputSecrets,
            stdout: artifactStdout,
            stderr: artifactStderr,
            stdoutOverflowPath,
            stderrOverflowPath,
          })
        : {};
    const artifactUri = persistedOutput.uri;
    const bashLimitOptions = {
      truncated: outputTruncated,
      artifactUri,
      maxOutputBytes: outputConfig.maxPreviewBytes,
      originalStdoutBytes,
      originalStderrBytes,
    };

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

      return withLimitedBashOutput(
        {
          stdout: safeStdout,
          stderr: safeStderr,
          exitCode,
          executionError: {
            type: "aborted",
            signal: child.signalCode ?? DEFAULT_KILL_SIGNAL,
          },
        },
        bashLimitOptions,
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

      return withLimitedBashOutput(
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
        bashLimitOptions,
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

      return withLimitedBashOutput(
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
        bashLimitOptions,
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

      return withLimitedBashOutput(
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
        bashLimitOptions,
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

      return withLimitedBashOutput(
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
        bashLimitOptions,
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
        artifactUri,
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

    return withLimitedBashOutput(
      { stdout: safeStdout, stderr: safeStderr, exitCode },
      bashLimitOptions,
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
    await fs.unlink(truncatedOutputPaths.stdoutOverflowPath).catch(() => undefined);
    await fs.unlink(truncatedOutputPaths.stderrOverflowPath).catch(() => undefined);
    clearTimeout(timeout);
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
    abortListener?.();
  }
}
