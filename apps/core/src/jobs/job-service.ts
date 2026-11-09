import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { createBashOutputSanitizer } from "../tools/bash-output-sanitizer";
import { preserveToolPanic } from "../tools/tool-result-adapters";
import {
  JOB_LIMITS,
  isJobActive,
  jobLogFileName,
  type JobEvent,
  type JobMode,
  type JobOwner,
  type JobPlatform,
  type JobRecord,
  type JobStatus,
  type JobStopReason,
} from "./job-domain";
import type { JobStoreError, SqliteJobStore } from "./job-store";

const logger = createLogger({ module: "background-jobs" });

export class JobCapacityExceeded extends TaggedError("JobCapacityExceeded")<{
  readonly scope: "session" | "global";
  readonly limit: number;
  readonly message: string;
}> {}

export class JobSpawnFailed extends TaggedError("JobSpawnFailed")<{
  readonly message: string;
}> {}

export class JobNotFound extends TaggedError("JobNotFound")<{
  readonly message: string;
}> {}

export class JobOutputReadFailed extends TaggedError("JobOutputReadFailed")<{
  readonly message: string;
}> {}

export type JobServiceError =
  | JobStoreError
  | JobCapacityExceeded
  | JobSpawnFailed
  | JobNotFound
  | JobOutputReadFailed;

export type JobLaunch = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly literalSecrets: readonly string[];
  readonly redactedCommand: string;
};

export type StartJobInput = {
  readonly owner: JobOwner;
  readonly toolCallId: string;
  readonly mode: JobMode;
  readonly label: string;
  readonly timeoutMs?: number;
  readonly launch: JobLaunch;
};

export type JobOutputRead = {
  readonly output: string;
  readonly totalBytes: number;
  readonly returnedFromByte: number;
  readonly captureTruncated: boolean;
};

export type JobWakeDelivery = "accepted" | "unavailable" | "abandon";

/** Starts one turn in the owning session. Job events reach the model from the job store. */
export type JobWakePort = {
  readonly deliver: (input: {
    readonly wakeId: string;
    readonly sessionId: string;
    readonly jobs: readonly JobRecord[];
  }) => Promise<ResultType<JobWakeDelivery, Error>>;
};

type RequestedStop = {
  readonly status: Extract<JobStatus, "stopped" | "timed_out">;
  readonly stopReason: JobStopReason;
  readonly delivery: "pending" | "suppressed";
};

type RunningJob = {
  readonly jobId: string;
  readonly pid: number;
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly done: Promise<void>;
  requestedStop: RequestedStop | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  hardKillTimer: ReturnType<typeof setTimeout> | null;
};

export function resolveJobTimeoutMs(mode: JobMode, requested: number | undefined): number {
  if (requested === undefined) {
    return mode === "await" ? JOB_LIMITS.awaitDefaultTimeoutMs : JOB_LIMITS.serviceDefaultTimeoutMs;
  }
  return Math.min(Math.max(requested, 1), JOB_LIMITS.maxTimeoutMs);
}

function readProcessStartTicks(pid: number): string | null {
  // Field 22 of /proc/<pid>/stat. The command field can contain spaces, so count from its end.
  return Result.try({
    try: () => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ?? null;
    },
    catch: () => null,
  }).match({ ok: (value) => value, err: () => null });
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  // A process that already exited makes this fail, and that is the wanted end state.
  Result.try({ try: () => process.kill(-pid, signal), catch: () => null });
}

function logStoreFailure(operation: string, error: JobStoreError): void {
  logger.error("job store operation failed", {
    operation,
    ...formatTaggedErrorForLog(error),
  });
}

export class JobService {
  readonly #store: SqliteJobStore;
  readonly #logDir: string;
  readonly #now: () => number;
  readonly #running = new Map<string, RunningJob>();
  readonly #listeners = new Set<() => void>();
  readonly #wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #wakeRetries = new Map<string, number>();
  readonly #wakeRetryDelaysMs: readonly number[];
  #wakePort: JobWakePort | null = null;
  #isSessionBusy: (sessionId: string) => boolean = () => false;
  #closing = false;

  constructor(input: {
    readonly store: SqliteJobStore;
    readonly logDir: string;
    readonly now?: () => number;
    readonly wakeRetryDelaysMs?: readonly number[];
  }) {
    this.#wakeRetryDelaysMs = input.wakeRetryDelaysMs ?? JOB_LIMITS.wakeRetryDelaysMs;
    this.#store = input.store;
    this.#logDir = input.logDir;
    this.#now = input.now ?? Date.now;
    mkdirSync(this.#logDir, { recursive: true, mode: 0o700 });
  }

  supports(platform: string): platform is JobPlatform {
    return platform === "discord" || platform === "native";
  }

  /**
   * Runs before the agent runner resumes recovered work. Every job the previous process owned is
   * gone from this process's control, so it is killed when still identifiable and reported lost.
   * A launch that crashed before recording its PID cannot be identified and may leave an orphan.
   */
  reconcileAfterRestart(): void {
    const active = this.#store
      .listActive()
      .match({ ok: (jobs) => jobs, err: (error) => (logStoreFailure("reconcile", error), []) });
    for (const job of active) {
      if (job.pid !== null && job.processStartTicks !== null) {
        if (readProcessStartTicks(job.pid) === job.processStartTicks) {
          signalProcessGroup(job.pid, "SIGKILL");
        }
      }
      this.#store
        .finish(job.jobId, {
          status: "lost",
          exitCode: null,
          stopReason: "core_restart",
          delivery: "pending",
          outputBytes: job.outputBytes,
          outputTruncated: job.outputTruncated,
        })
        .match({
          ok: () => undefined,
          err: (error) => logStoreFailure("reconcile-finish", error),
        });
    }
    this.#deleteExpired();
  }

  /** Runs once the runner and surfaces can accept a wake. */
  startWakes(input: {
    readonly port: JobWakePort;
    readonly isSessionBusy: (sessionId: string) => boolean;
  }): void {
    this.#wakePort = input.port;
    this.#isSessionBusy = input.isSessionBusy;
    const sessions = this.#store.listSessionsWithPending().match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("wake-recovery", error), []),
    });
    for (const sessionId of sessions) this.#scheduleWake(sessionId);
  }

  async start(input: StartJobInput): Promise<ResultType<JobRecord, JobServiceError>> {
    const jobId = `job_${crypto.randomUUID().replaceAll("-", "")}`;
    const timeoutMs = resolveJobTimeoutMs(input.mode, input.timeoutMs);
    const reservation = this.#store.reserve({
      jobId,
      // A replayed tool call after recovery returns its job instead of starting a second process.
      launchKey: `${input.owner.requestId}:${input.toolCallId}`,
      owner: input.owner,
      toolCallId: input.toolCallId,
      mode: input.mode,
      label: input.label,
      command: input.launch.redactedCommand,
      cwd: input.launch.cwd,
      deadlineAt: this.#now() + timeoutMs,
    });
    return Result.gen(
      async function* (this: JobService) {
        const reserved = yield* reservation;
        switch (reserved.kind) {
          case "existing":
            return Result.ok(reserved.job);
          case "session-capacity":
          case "global-capacity": {
            const scope = reserved.kind === "session-capacity" ? "session" : "global";
            return Result.err(
              new JobCapacityExceeded({
                scope,
                limit: reserved.limit,
                message: `The ${scope} limit of ${reserved.limit} running jobs is reached. Stop a job or wait for one to finish.`,
              }),
            );
          }
          case "created":
            break;
          default: {
            const exhaustive: never = reserved;
            return exhaustive;
          }
        }
        return Result.ok(yield* await this.#spawn(reserved.job, input, timeoutMs));
      }.bind(this),
    );
  }

  list(sessionId: string): ResultType<JobRecord[], JobServiceError> {
    return this.#store.listForSession(sessionId, 50);
  }

  async read(
    sessionId: string,
    jobId: string,
    options: { readonly tailBytes?: number; readonly fromByte?: number },
  ): Promise<ResultType<{ job: JobRecord; output: JobOutputRead }, JobServiceError>> {
    return Result.gen(
      async function* (this: JobService) {
        const job = yield* this.#ownedJob(sessionId, jobId);
        const output = yield* Result.await(this.#readOutput(job, options));
        return Result.ok({ job, output });
      }.bind(this),
    );
  }

  async stop(sessionId: string, jobId: string): Promise<ResultType<JobRecord, JobServiceError>> {
    return Result.gen(
      async function* (this: JobService) {
        const job = yield* this.#ownedJob(sessionId, jobId);
        if (!isJobActive(job.status)) return Result.ok(job);
        await this.#stopRunning(job.jobId, {
          status: "stopped",
          stopReason: "job_stop",
          delivery: "suppressed",
        });
        return this.#ownedJob(sessionId, jobId);
      }.bind(this),
    );
  }

  /** The request cannot finish while this holds, so the runner parks it. */
  hasActiveAwait(requestId: string): boolean {
    return this.#store.hasActiveAwait(requestId).match({
      ok: (value) => value,
      err: (error) => (logStoreFailure("has-active-await", error), false),
    });
  }

  hasPendingEvents(sessionId: string): boolean {
    return this.#store.hasPending(sessionId).match({
      ok: (value) => value,
      err: (error) => (logStoreFailure("has-pending", error), false),
    });
  }

  async pendingEvents(sessionId: string): Promise<JobEvent[]> {
    const pending = this.#store.listPending(sessionId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("list-pending", error), []),
    });
    const events: JobEvent[] = [];
    for (const job of pending) {
      const output = (
        await this.#readOutput(job, { tailBytes: JOB_LIMITS.eventTailBytes })
      ).match<JobOutputRead | null>({ ok: (value) => value, err: () => null });
      events.push({
        job,
        outputTail: output?.output ?? "",
        outputTailTruncated: output
          ? output.returnedFromByte > 0 || output.captureTruncated
          : false,
      });
    }
    return events;
  }

  acknowledgeEvents(jobIds: readonly string[]): void {
    if (jobIds.length === 0) return;
    this.#store.acknowledge(jobIds).match({
      ok: () => undefined,
      err: (error) => logStoreFailure("acknowledge", error),
    });
  }

  /** Called when a session receives input that a person wrote, which ends a run of wakes. */
  noteUserInput(sessionId: string): void {
    this.#store.resetWakeBudget(sessionId).match({
      ok: () => undefined,
      err: (error) => logStoreFailure("reset-wake-budget", error),
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async stopAwaitJobs(requestId: string, stopReason: JobStopReason): Promise<void> {
    const jobs = this.#store.listActiveForRequest(requestId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("list-request", error), []),
    });
    await Promise.all(
      jobs
        .filter((job) => job.mode === "await")
        .map((job) =>
          this.#stopRunning(job.jobId, { status: "stopped", stopReason, delivery: "suppressed" }),
        ),
    );
  }

  /** A run's jobs that must not outlive it stop here, and any remaining events may need a wake. */
  async onRunSettled(input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly isPrimary: boolean;
  }): Promise<void> {
    const jobs = this.#store.listActiveForRequest(input.requestId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("list-request", error), []),
    });
    await Promise.all(
      jobs
        .filter((job) => !input.isPrimary || job.mode === "await")
        .map((job) =>
          this.#stopRunning(job.jobId, {
            status: "stopped",
            stopReason: input.isPrimary ? "request_ended" : "subagent_ended",
            delivery: "suppressed",
          }),
        ),
    );
    if (!input.isPrimary) {
      this.#store.suppressPendingForSession(input.sessionId).match({
        ok: () => undefined,
        err: (error) => logStoreFailure("suppress-subagent", error),
      });
      return;
    }
    this.#scheduleWake(input.sessionId);
  }

  /** Stops every job in a session and discards its undelivered events, without telling the agent. */
  async stopSession(sessionId: string, stopReason: JobStopReason): Promise<void> {
    await this.#stopSessionJobs(sessionId, stopReason, () => true);
    this.#store.suppressPendingForSession(sessionId).match({
      ok: () => undefined,
      err: (error) => logStoreFailure("suppress-session", error),
    });
  }

  /** Stops the jobs a rewind discarded. Jobs from turns before the target keep running. */
  async stopSessionJobsSince(
    sessionId: string,
    createdAtOrAfter: number,
    stopReason: JobStopReason,
  ): Promise<void> {
    await this.#stopSessionJobs(sessionId, stopReason, (job) => job.createdAt >= createdAtOrAfter);
    const pending = this.#store.listPending(sessionId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("list-pending", error), []),
    });
    this.#store
      .suppress(pending.filter((job) => job.createdAt >= createdAtOrAfter).map((job) => job.jobId))
      .match({
        ok: () => undefined,
        err: (error) => logStoreFailure("suppress-rewind", error),
      });
  }

  /**
   * Leaves stored jobs active so the next start reports them lost. Their processes end here, so a
   * clean restart and a crash give the agent the same event.
   */
  async close(): Promise<void> {
    this.#closing = true;
    for (const timer of this.#wakeTimers.values()) clearTimeout(timer);
    this.#wakeTimers.clear();
    const running = [...this.#running.values()];
    for (const job of running) {
      signalProcessGroup(job.pid, "SIGTERM");
      this.#scheduleHardKill(job);
    }
    await Promise.all(running.map((job) => job.done));
  }

  #ownedJob(sessionId: string, jobId: string): ResultType<JobRecord, JobServiceError> {
    return this.#store.get(jobId).andThen((job) => {
      if (job && job.sessionId === sessionId) return Result.ok(job);
      return Result.err(new JobNotFound({ message: `No job ${jobId} in this session` }));
    });
  }

  async #stopSessionJobs(
    sessionId: string,
    stopReason: JobStopReason,
    selected: (job: JobRecord) => boolean,
  ): Promise<void> {
    const jobs = this.#store.listActiveForSession(sessionId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("list-session", error), []),
    });
    await Promise.all(
      jobs
        .filter(selected)
        .map((job) =>
          this.#stopRunning(job.jobId, { status: "stopped", stopReason, delivery: "suppressed" }),
        ),
    );
  }

  async #stopRunning(jobId: string, stop: RequestedStop): Promise<void> {
    const running = this.#running.get(jobId);
    if (!running) return;
    running.requestedStop ??= stop;
    signalProcessGroup(running.pid, "SIGTERM");
    this.#scheduleHardKill(running);
    await running.done;
  }

  #scheduleHardKill(job: RunningJob): void {
    if (job.hardKillTimer) return;
    job.hardKillTimer = setTimeout(
      () => signalProcessGroup(job.pid, "SIGKILL"),
      JOB_LIMITS.hardKillDelayMs,
    );
    job.hardKillTimer.unref?.();
  }

  async #spawn(
    job: JobRecord,
    input: StartJobInput,
    timeoutMs: number,
  ): Promise<ResultType<JobRecord, JobServiceError>> {
    const logPath = path.join(this.#logDir, jobLogFileName(job.jobId));
    const opened = await Result.tryPromise({
      try: () => open(logPath, "a", 0o600),
      catch: captureRuntimeError,
    });
    if (opened.isErr()) return this.#failSpawn(job, "Could not create the job output file");
    const logHandle = opened.value;

    const spawned = Result.try({
      try: () =>
        Bun.spawn([...input.launch.args], {
          cwd: input.launch.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          detached: true,
          env: input.launch.env,
        }),
      catch: captureRuntimeError,
    });
    if (spawned.isErr()) {
      const message = preserveToolPanic(
        projectCapturedRuntimeError(spawned.error, "Background command could not start"),
      ).message;
      await Result.tryPromise({ try: () => logHandle.close(), catch: captureRuntimeError });
      return this.#failSpawn(job, message);
    }
    const child = spawned.value;

    const startTicks = readProcessStartTicks(child.pid);
    const marked = this.#store.markRunning(job.jobId, {
      pid: child.pid,
      processStartTicks: startTicks,
    });
    const markedError = marked.match({ ok: () => null, err: (error) => error });
    if (markedError) {
      signalProcessGroup(child.pid, "SIGKILL");
      await Result.tryPromise({ try: () => logHandle.close(), catch: captureRuntimeError });
      return Result.err(markedError);
    }

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const running: RunningJob = {
      jobId: job.jobId,
      pid: child.pid,
      child,
      done,
      requestedStop: null,
      deadlineTimer: null,
      hardKillTimer: null,
    };
    this.#running.set(job.jobId, running);
    running.deadlineTimer = setTimeout(() => {
      running.requestedStop ??= {
        status: "timed_out",
        stopReason: "time_limit",
        delivery: "pending",
      };
      signalProcessGroup(running.pid, "SIGTERM");
      this.#scheduleHardKill(running);
    }, timeoutMs);
    running.deadlineTimer.unref?.();

    void this.#superviseJob({
      job,
      running,
      logHandle,
      literalSecrets: input.launch.literalSecrets,
    }).finally(resolveDone);

    return this.#store
      .get(job.jobId)
      .andThen((current) =>
        current
          ? Result.ok(current)
          : Result.err(new JobNotFound({ message: `Job ${job.jobId} is missing after launch` })),
      );
  }

  #failSpawn(job: JobRecord, message: string): ResultType<JobRecord, JobServiceError> {
    return this.#store
      .finish(job.jobId, {
        status: "failed",
        exitCode: null,
        stopReason: "spawn_failed",
        delivery: "suppressed",
        outputBytes: 0,
        outputTruncated: false,
      })
      .andThen(() => Result.err(new JobSpawnFailed({ message })));
  }

  async #superviseJob(input: {
    readonly job: JobRecord;
    readonly running: RunningJob;
    readonly logHandle: FileHandle;
    readonly literalSecrets: readonly string[];
  }): Promise<void> {
    const { job, running, logHandle, literalSecrets } = input;
    const capture = { bytes: 0, truncated: false };
    const streams = Promise.all(
      [running.child.stdout, running.child.stderr].map((stream) =>
        this.#captureStream({ stream, literalSecrets, logHandle, capture }),
      ),
    );
    const exitCode = await running.child.exited;
    if (running.deadlineTimer) clearTimeout(running.deadlineTimer);

    // Children left behind by the command hold its pipes open and would keep running unowned.
    signalProcessGroup(running.pid, "SIGTERM");
    this.#scheduleHardKill(running);
    await Promise.race([streams, Bun.sleep(JOB_LIMITS.streamDrainMs)]);
    if (running.hardKillTimer) clearTimeout(running.hardKillTimer);
    signalProcessGroup(running.pid, "SIGKILL");
    await Result.tryPromise({ try: () => logHandle.close(), catch: captureRuntimeError });
    this.#running.delete(job.jobId);
    if (this.#closing) return;

    const stop = running.requestedStop;
    const finished = this.#store.finish(job.jobId, {
      status: stop?.status ?? "exited",
      exitCode: stop ? null : exitCode,
      stopReason: stop?.stopReason ?? null,
      delivery: stop?.delivery ?? "pending",
      outputBytes: capture.bytes,
      outputTruncated: capture.truncated,
    });
    finished.match({
      ok: () => undefined,
      err: (error) => logStoreFailure("finish", error),
    });
    this.#notify();
    if ((stop?.delivery ?? "pending") === "pending") this.#scheduleWake(job.sessionId);
  }

  async #captureStream(input: {
    readonly stream: ReadableStream<Uint8Array>;
    readonly literalSecrets: readonly string[];
    readonly logHandle: FileHandle;
    readonly capture: { bytes: number; truncated: boolean };
  }): Promise<void> {
    const { stream, literalSecrets, logHandle, capture } = input;
    const sanitizer = createBashOutputSanitizer(literalSecrets);
    const append = async (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const remaining = JOB_LIMITS.maxOutputBytes - capture.bytes;
      // Output past the cap is still drained, because a full pipe would stall the job.
      if (remaining <= 0) {
        capture.truncated ||= bytes.byteLength > 0;
        return;
      }
      const kept = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
      capture.truncated ||= kept.byteLength < bytes.byteLength;
      capture.bytes += kept.byteLength;
      await logHandle.appendFile(kept);
    };
    const copied = await Result.tryPromise({
      try: async () => {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await append(sanitizer.write(value));
        }
        await append(sanitizer.end());
      },
      catch: captureRuntimeError,
    });
    if (copied.isErr()) logger.warn("job output capture ended early");
  }

  async #readOutput(
    job: JobRecord,
    options: { readonly tailBytes?: number; readonly fromByte?: number },
  ): Promise<ResultType<JobOutputRead, JobOutputReadFailed>> {
    const logPath = path.join(this.#logDir, jobLogFileName(job.jobId));
    const read = await Result.tryPromise({
      try: async () => {
        if (!existsSync(logPath)) return { output: "", totalBytes: 0, returnedFromByte: 0 };
        const handle = await open(logPath, "r");
        const { size } = await handle.stat();
        const limit = Math.min(
          options.tailBytes ?? JOB_LIMITS.defaultReadBytes,
          JOB_LIMITS.maxReadBytes,
        );
        const start =
          options.fromByte === undefined
            ? Math.max(0, size - limit)
            : Math.min(options.fromByte, size);
        const length = Math.min(limit, size - start);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        await handle.close();
        return { output: buffer.toString("utf8"), totalBytes: size, returnedFromByte: start };
      },
      catch: captureRuntimeError,
    });
    return read
      .map((value) => ({ ...value, captureTruncated: job.outputTruncated }))
      .mapError(() => new JobOutputReadFailed({ message: "Job output could not be read" }));
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #scheduleWake(sessionId: string, delayMs: number = JOB_LIMITS.wakeDebounceMs): void {
    if (this.#closing || !this.#wakePort || this.#wakeTimers.has(sessionId)) return;
    // Jobs that finish together share one wake.
    const timer = setTimeout(() => {
      this.#wakeTimers.delete(sessionId);
      void this.#flushWake(sessionId);
    }, delayMs);
    timer.unref?.();
    this.#wakeTimers.set(sessionId, timer);
  }

  async #flushWake(sessionId: string): Promise<void> {
    const port = this.#wakePort;
    // A busy session drains events at its next turn boundary. Its settlement reschedules this.
    if (!port || this.#closing || this.#isSessionBusy(sessionId)) return;
    const pending = this.#store.listPending(sessionId).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("wake-list", error), []),
    });
    const wakeable = pending.filter((job) => job.runProfile === "primary");
    if (wakeable.length === 0) return;

    const unclaimed = wakeable.filter((job) => job.wakeId === null);
    const previousWakeId = wakeable.find((job) => job.wakeId !== null)?.wakeId ?? null;
    // After a restart an already claimed wake is retried under its own ID, which spends no budget.
    const wakeId = unclaimed.length === 0 && previousWakeId ? previousWakeId : crypto.randomUUID();
    if (unclaimed.length > 0) {
      const claimed = this.#store
        .claimWake({ sessionId, jobIds: unclaimed.map((job) => job.jobId), wakeId })
        .match({
          ok: (value) => value,
          err: (error) => (logStoreFailure("claim-wake", error), false),
        });
      // A spent budget leaves the events pending for the next message a person sends.
      if (!claimed) {
        logger.info("job wake held back by the consecutive wake limit", { sessionId });
        return;
      }
    }

    const delivered = await port.deliver({ wakeId, sessionId, jobs: wakeable });
    const outcome = delivered.match<JobWakeDelivery>({
      ok: (value) => value,
      err: (error) => {
        logger.warn("job wake delivery failed", { sessionId, error: error.message });
        return "unavailable";
      },
    });
    if (outcome === "unavailable") {
      this.#scheduleWakeRetry(sessionId);
      return;
    }
    this.#wakeRetries.delete(sessionId);
    if (outcome !== "abandon") return;
    this.#store.suppress(wakeable.map((job) => job.jobId)).match({
      ok: () => undefined,
      err: (error) => logStoreFailure("wake-abandon", error),
    });
  }

  /**
   * A retry finds its jobs already claimed, so it reuses the wake ID and spends no budget. Once the
   * delays run out, the event waits for the session's next run or the next restart.
   */
  #scheduleWakeRetry(sessionId: string): void {
    const attempt = this.#wakeRetries.get(sessionId) ?? 0;
    const delayMs = this.#wakeRetryDelaysMs[attempt];
    if (delayMs === undefined) {
      this.#wakeRetries.delete(sessionId);
      logger.warn("job wake retries exhausted", { sessionId });
      return;
    }
    this.#wakeRetries.set(sessionId, attempt + 1);
    this.#scheduleWake(sessionId, delayMs);
  }

  #deleteExpired(): void {
    const deleted = this.#store.deleteEndedBefore(this.#now() - JOB_LIMITS.retentionMs).match({
      ok: (values) => values,
      err: (error) => (logStoreFailure("delete-expired", error), []),
    });
    for (const jobId of deleted) {
      void Result.tryPromise({
        try: () => rm(path.join(this.#logDir, jobLogFileName(jobId)), { force: true }),
        catch: captureRuntimeError,
      });
    }
  }
}
