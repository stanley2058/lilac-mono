import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  captureRuntimeError,
  projectCapturedRuntimeError,
  projectRuntimeError,
} from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";

const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const HARD_KILL_DELAY_MS = 2000;
const OUTPUT_DRAIN_AFTER_TERMINATION_MS = 2000;
const logger = createLogger({ module: "ssh-command" });
let sshControlDirectory: Promise<string> | undefined;

export class SshProcessSignalError extends TaggedError("SshProcessSignalError")<{
  readonly target: "group" | "process";
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshProcessCleanupError extends TaggedError("SshProcessCleanupError")<{
  readonly failures: readonly SshProcessSignalError[];
  readonly message: string;
}> {}

export class SshCommandError extends TaggedError("SshCommandError")<{
  readonly operation: "spawn" | "read_output" | "wait_exit";
  readonly cause: unknown;
  readonly message: string;
}> {}

export type SshCommandOutcome = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
};

export function captureSshOperation<T, E extends Error>(params: {
  readonly run: () => Awaited<T>;
  readonly fallback: string;
  readonly mapError: (cause: Error) => E;
}): ResultType<T, E> {
  const captured = Result.try({
    try: params.run,
    catch: (cause) => new Error(params.fallback, { cause }),
  }).mapError((captured) => projectRuntimeError(captured.cause, params.fallback));
  return captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => Result.err(params.mapError(preserveToolPanic(error))),
  })();
}

export async function captureSshPromise<T, E extends Error>(params: {
  readonly run: () => Promise<T>;
  readonly fallback: string;
  readonly mapError: (cause: Error) => E;
}): Promise<ResultType<T, E>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) => projectCapturedRuntimeError(error, params.fallback));
  return captured.match<() => ResultType<T, E>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => Result.err(params.mapError(preserveToolPanic(error))),
  })();
}

/** OpenSSH options shared by every connection Core opens, followed by the remote command words. */
export async function buildSshArgs(host: string, remoteArgs: readonly string[]): Promise<string[]> {
  sshControlDirectory ??= fs.mkdtemp(path.join(os.tmpdir(), "lilac-ssh-"));
  const controlDirectory = await sshControlDirectory;
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=60",
    "-o",
    `ControlPath=${controlDirectory}/%C`,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`,
    "-o",
    "LogLevel=ERROR",
    host,
    ...remoteArgs,
  ];
}

export function buildSshChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

function signalSshProcess(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  target: "group" | "process",
): ResultType<void, SshProcessSignalError> {
  const signalPid = target === "group" ? -pid : pid;
  return captureSshOperation({
    run: () => {
      process.kill(signalPid, signal);
    },
    fallback: `Opaque SSH ${target} signal failure`,
    mapError: (cause) =>
      new SshProcessSignalError({
        target,
        pid,
        signal,
        cause,
        message: `Failed to signal SSH ${target}`,
      }),
  });
}

export function killProcessGroupBestEffort(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): ResultType<void, SshProcessCleanupError> {
  const failures: SshProcessSignalError[] = [];
  const group = signalSshProcess(pid, signal, "group");
  group.match({ ok: () => undefined, err: (error) => failures.push(error) });
  const processResult = signalSshProcess(pid, signal, "process");
  processResult.match({ ok: () => undefined, err: (error) => failures.push(error) });
  if (failures.length === 0) return Result.ok();
  return Result.err(
    new SshProcessCleanupError({
      failures,
      message: `Failed to fully signal SSH process group with ${signal}`,
    }),
  );
}

export function observeBestEffortProcessCleanup(
  cleanup: ResultType<void, SshProcessCleanupError>,
): void {
  cleanup.match({
    ok: () => undefined,
    err: (error) =>
      logger.debug("SSH process-group cleanup incomplete", formatTaggedErrorForLog(error)),
  });
}

function spawnSshCommand(
  args: readonly string[],
  stdin: Blob,
): ResultType<ReturnType<typeof Bun.spawn>, SshCommandError> {
  return captureSshOperation({
    run: () =>
      Bun.spawn(["ssh", ...args], {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: buildSshChildEnv(),
      }),
    fallback: "Opaque SSH spawn failure",
    mapError: (cause) =>
      new SshCommandError({ operation: "spawn", cause, message: "Failed to start ssh" }),
  });
}

function cancelOutputReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void captureSshPromise({
    run: () => reader.cancel(),
    fallback: "Opaque SSH output cancellation failure",
    mapError: (cause) =>
      new SshCommandError({
        operation: "read_output",
        cause,
        message: "Failed to cancel ssh output",
      }),
  }).then((cancelled) =>
    cancelled.match({
      ok: () => undefined,
      err: (error) =>
        logger.debug("SSH output cancellation failed", formatTaggedErrorForLog(error)),
    }),
  );
}

async function readOutputText(
  stream: ReadableStream<Uint8Array>,
  stop: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // A cancelled reader resolves its pending read as done, so the text read so far is returned.
  const onStop = () => cancelOutputReader(reader);
  if (stop.aborted) onStop();
  stop.addEventListener("abort", onStop, { once: true });
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  stop.removeEventListener("abort", onStop);
  return text + decoder.decode();
}

function readCommandOutput(
  stream: ReadableStream<Uint8Array> | number | undefined,
  stop: AbortSignal,
): Promise<ResultType<string, SshCommandError>> {
  return captureSshPromise({
    run: async () => (stream instanceof ReadableStream ? await readOutputText(stream, stop) : ""),
    fallback: "Opaque SSH output read failure",
    mapError: (cause) =>
      new SshCommandError({
        operation: "read_output",
        cause,
        message: "Failed to read ssh output",
      }),
  });
}

function waitForCommandExit(exit: Promise<number>): Promise<ResultType<number, SshCommandError>> {
  return captureSshPromise({
    run: () => exit,
    fallback: "Opaque SSH exit wait failure",
    mapError: (cause) =>
      new SshCommandError({ operation: "wait_exit", cause, message: "Failed to wait for ssh" }),
  });
}

/**
 * Runs one short remote command and collects its whole output. Used for runner deployment, where
 * outputs are a few lines and no streaming, caps or activity reporting are needed.
 */
export async function runSshCommand(params: {
  readonly host: string;
  readonly remoteArgs: readonly string[];
  readonly stdin: Blob;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ResultType<SshCommandOutcome, SshCommandError>> {
  const args = await buildSshArgs(params.host, params.remoteArgs);
  const spawned = spawnSshCommand(args, params.stdin);
  if (spawned.isErr()) return Result.err(spawned.error);
  const child = spawned.value;

  let termination: "timeout" | "aborted" | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const outputStop = new AbortController();
  // A ControlMaster can hold a terminated client's output open, so stop reading it after a grace.
  const scheduleOutputStop = () => {
    if (!termination || !exited || drain) return;
    drain = setTimeout(() => outputStop.abort(), OUTPUT_DRAIN_AFTER_TERMINATION_MS);
    drain.unref?.();
  };
  const terminate = (reason: "timeout" | "aborted") => {
    if (termination) return;
    termination = reason;
    scheduleOutputStop();
    observeBestEffortProcessCleanup(killProcessGroupBestEffort(child.pid, "SIGTERM"));
    hardKill = setTimeout(
      () => observeBestEffortProcessCleanup(killProcessGroupBestEffort(child.pid, "SIGKILL")),
      HARD_KILL_DELAY_MS,
    );
    hardKill.unref?.();
  };
  const timer = setTimeout(() => terminate("timeout"), params.timeoutMs);
  timer.unref?.();
  const onAbort = () => terminate("aborted");
  if (params.signal?.aborted) onAbort();
  params.signal?.addEventListener("abort", onAbort, { once: true });

  const [stdout, stderr, exit] = await Promise.all([
    readCommandOutput(child.stdout, outputStop.signal),
    readCommandOutput(child.stderr, outputStop.signal),
    waitForCommandExit(child.exited).then((result) => {
      exited = true;
      scheduleOutputStop();
      return result;
    }),
  ]);
  clearTimeout(timer);
  if (drain) clearTimeout(drain);
  if (hardKill && !termination) clearTimeout(hardKill);
  params.signal?.removeEventListener("abort", onAbort);

  return Result.all([stdout, stderr, exit]).map(([stdoutText, stderrText, exitCode]) => ({
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    timedOut: termination === "timeout",
    aborted: termination === "aborted",
  }));
}
