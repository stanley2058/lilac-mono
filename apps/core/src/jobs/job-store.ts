import { Database } from "bun:sqlite";
import { classifyBunSqliteError, runBunSqliteTransaction } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";
import {
  JOB_LIMITS,
  jobDeliverySchema,
  jobModeSchema,
  jobPlatformSchema,
  jobStatusSchema,
  jobStopReasonSchema,
  type JobDelivery,
  type JobMode,
  type JobOwner,
  type JobRecord,
  type JobStatus,
  type JobStopReason,
} from "./job-domain";

export type JobRow = {
  job_id: string;
  launch_key: string;
  session_id: string;
  request_id: string;
  request_delivery_id: string | null;
  tool_call_id: string;
  platform: string;
  owner_user_id: string | null;
  origin_message_id: string | null;
  run_profile: string;
  mode: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | null;
  process_start_ticks: string | null;
  status: string;
  exit_code: number | null;
  stop_reason: string | null;
  delivery: string;
  wake_id: string | null;
  output_bytes: number;
  output_truncated: number;
  deadline_at: number;
  created_at: number;
  ended_at: number | null;
};

export class JobStoreFailed extends TaggedError("JobStoreFailed")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
}> {}

export class JobStoreCorrupt extends TaggedError("JobStoreCorrupt")<{
  readonly jobId: string;
  readonly message: string;
}> {}

export type JobStoreError = JobStoreFailed | JobStoreCorrupt;

function storeFailure(operation: string, cause: Error): JobStoreFailed | undefined {
  const classified = classifyBunSqliteError(cause);
  if (!classified) return undefined;
  return new JobStoreFailed({
    operation,
    code: classified.code,
    message: `Job store SQLite ${operation} failed`,
  });
}

function captureStoreOperation<T>(
  operation: string,
  effect: () => Awaited<T>,
): ResultType<T, JobStoreFailed> {
  const captured = Result.try({ try: effect, catch: captureRuntimeError });
  const outcome = captured.match<
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "error"; readonly captured: ReturnType<typeof captureRuntimeError> }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", captured: error }),
  });
  if (outcome.kind === "ok") return Result.ok(outcome.value);
  const cause = preserveToolPanic(
    projectCapturedRuntimeError(outcome.captured, "Opaque job store failure"),
  );
  const failure = storeFailure(operation, cause);
  if (failure) return Result.err(failure);
  return adaptToolResultToHost(Result.err(cause));
}

export function decodeJobRow(row: JobRow): ResultType<JobRecord, JobStoreCorrupt> {
  const platform = jobPlatformSchema.safeParse(row.platform);
  const mode = jobModeSchema.safeParse(row.mode);
  const status = jobStatusSchema.safeParse(row.status);
  const delivery = jobDeliverySchema.safeParse(row.delivery);
  const stopReason =
    row.stop_reason === null ? null : jobStopReasonSchema.safeParse(row.stop_reason);
  if (
    !platform.success ||
    !mode.success ||
    !status.success ||
    !delivery.success ||
    stopReason?.success === false
  ) {
    return Result.err(
      new JobStoreCorrupt({ jobId: row.job_id, message: "Stored job record is invalid" }),
    );
  }
  return Result.ok({
    jobId: row.job_id,
    launchKey: row.launch_key,
    sessionId: row.session_id,
    requestId: row.request_id,
    requestDeliveryId: row.request_delivery_id,
    toolCallId: row.tool_call_id,
    platform: platform.data,
    userId: row.owner_user_id,
    originMessageId: row.origin_message_id,
    runProfile: row.run_profile,
    mode: mode.data,
    label: row.label,
    command: row.command,
    cwd: row.cwd,
    pid: row.pid,
    processStartTicks: row.process_start_ticks,
    status: status.data,
    exitCode: row.exit_code,
    stopReason: stopReason?.data ?? null,
    delivery: delivery.data,
    wakeId: row.wake_id,
    outputBytes: row.output_bytes,
    outputTruncated: row.output_truncated !== 0,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  });
}

export type ReserveJobInput = {
  readonly jobId: string;
  readonly launchKey: string;
  readonly owner: JobOwner;
  readonly toolCallId: string;
  readonly mode: JobMode;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly deadlineAt: number;
};

export type ReserveJobResult =
  | { readonly kind: "created" | "existing"; readonly job: JobRecord }
  | { readonly kind: "session-capacity" | "global-capacity"; readonly limit: number };

export type FinishJobInput = {
  readonly status: Exclude<JobStatus, "starting" | "running">;
  readonly exitCode: number | null;
  readonly stopReason: JobStopReason | null;
  readonly delivery: JobDelivery;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
};

const ACTIVE_STATES = "('starting','running')";

export class SqliteJobStore {
  readonly #database: Database;
  readonly #now: () => number;

  constructor(input: { readonly dbPath: string; readonly now?: () => number }) {
    this.#database = new Database(input.dbPath, { create: true, strict: true });
    this.#now = input.now ?? Date.now;
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        launch_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_delivery_id TEXT,
        tool_call_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('discord', 'native')),
        owner_user_id TEXT,
        origin_message_id TEXT,
        run_profile TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('await', 'service')),
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        process_start_ticks TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'exited', 'stopped', 'timed_out', 'lost', 'failed')),
        exit_code INTEGER,
        stop_reason TEXT,
        delivery TEXT NOT NULL CHECK (delivery IN ('none', 'pending', 'acknowledged', 'suppressed')),
        wake_id TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS background_jobs_session_idx
        ON background_jobs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS background_jobs_request_idx
        ON background_jobs(request_id, mode, status);
      CREATE INDEX IF NOT EXISTS background_jobs_delivery_idx
        ON background_jobs(delivery, session_id);
      CREATE TABLE IF NOT EXISTS background_job_wake_budgets (
        session_id TEXT PRIMARY KEY NOT NULL,
        consecutive_wakes INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.#database.close();
  }

  reserve(input: ReserveJobInput): ResultType<ReserveJobResult, JobStoreError> {
    return runBunSqliteTransaction(
      this.#database,
      () =>
        Result.gen(
          function* (this: SqliteJobStore) {
            const existing = yield* this.getByLaunchKey(input.launchKey);
            if (existing) return Result.ok<ReserveJobResult>({ kind: "existing", job: existing });
            const sessionRunning = yield* this.countActive("session_id = ?", [
              input.owner.sessionId,
            ]);
            if (sessionRunning >= JOB_LIMITS.maxRunningPerSession) {
              return Result.ok<ReserveJobResult>({
                kind: "session-capacity",
                limit: JOB_LIMITS.maxRunningPerSession,
              });
            }
            const globalRunning = yield* this.countActive("1 = 1", []);
            if (globalRunning >= JOB_LIMITS.maxRunningGlobal) {
              return Result.ok<ReserveJobResult>({
                kind: "global-capacity",
                limit: JOB_LIMITS.maxRunningGlobal,
              });
            }
            yield* captureStoreOperation("reserve", () => {
              this.#database
                .query(
                  `INSERT INTO background_jobs (
                     job_id, launch_key, session_id, request_id, request_delivery_id, tool_call_id,
                     platform, owner_user_id, origin_message_id, run_profile, mode, label, command,
                     cwd, status, delivery, deadline_at, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 'none', ?, ?)`,
                )
                .run(
                  input.jobId,
                  input.launchKey,
                  input.owner.sessionId,
                  input.owner.requestId,
                  input.owner.requestDeliveryId,
                  input.toolCallId,
                  input.owner.platform,
                  input.owner.userId,
                  input.owner.originMessageId,
                  input.owner.runProfile,
                  input.mode,
                  input.label,
                  input.command,
                  input.cwd,
                  input.deadlineAt,
                  this.#now(),
                );
            });
            const created = yield* this.requireJob(input.jobId);
            return Result.ok<ReserveJobResult>({ kind: "created", job: created });
          }.bind(this),
        ),
      (cause) => storeFailure("reserve", cause),
    );
  }

  markRunning(
    jobId: string,
    input: { readonly pid: number; readonly processStartTicks: string | null },
  ): ResultType<void, JobStoreError> {
    return captureStoreOperation("mark-running", () => {
      this.#database
        .query(
          "UPDATE background_jobs SET status = 'running', pid = ?, process_start_ticks = ? WHERE job_id = ? AND status = 'starting'",
        )
        .run(input.pid, input.processStartTicks, jobId);
    });
  }

  finish(jobId: string, input: FinishJobInput): ResultType<JobRecord | null, JobStoreError> {
    return runBunSqliteTransaction(
      this.#database,
      () =>
        Result.gen(
          function* (this: SqliteJobStore) {
            const changes = yield* captureStoreOperation(
              "finish",
              () =>
                this.#database
                  .query(
                    `UPDATE background_jobs
                     SET status = ?, exit_code = ?, stop_reason = ?, delivery = ?, output_bytes = ?,
                         output_truncated = ?, ended_at = ?
                     WHERE job_id = ? AND status IN ${ACTIVE_STATES}`,
                  )
                  .run(
                    input.status,
                    input.exitCode,
                    input.stopReason,
                    input.delivery,
                    input.outputBytes,
                    input.outputTruncated ? 1 : 0,
                    this.#now(),
                    jobId,
                  ).changes,
            );
            if (changes === 0) return Result.ok(null);
            return Result.ok(yield* this.requireJob(jobId));
          }.bind(this),
        ),
      (cause) => storeFailure("finish", cause),
    );
  }

  get(jobId: string): ResultType<JobRecord | null, JobStoreError> {
    return captureStoreOperation("get", () =>
      this.#database
        .query<JobRow, [string]>("SELECT * FROM background_jobs WHERE job_id = ?")
        .get(jobId),
    ).andThen((row) => (row ? decodeJobRow(row) : Result.ok(null)));
  }

  listForSession(sessionId: string, limit: number): ResultType<JobRecord[], JobStoreError> {
    return this.list(
      "listForSession",
      "SELECT * FROM background_jobs WHERE session_id = ? ORDER BY created_at DESC, job_id LIMIT ?",
      [sessionId, limit],
    );
  }

  listActive(): ResultType<JobRecord[], JobStoreError> {
    return this.list(
      "listActive",
      `SELECT * FROM background_jobs WHERE status IN ${ACTIVE_STATES} ORDER BY created_at, job_id`,
      [],
    );
  }

  listActiveForSession(sessionId: string): ResultType<JobRecord[], JobStoreError> {
    return this.list(
      "listActiveForSession",
      `SELECT * FROM background_jobs WHERE session_id = ? AND status IN ${ACTIVE_STATES} ORDER BY created_at, job_id`,
      [sessionId],
    );
  }

  listActiveForRequest(requestId: string): ResultType<JobRecord[], JobStoreError> {
    return this.list(
      "listActiveForRequest",
      `SELECT * FROM background_jobs WHERE request_id = ? AND status IN ${ACTIVE_STATES} ORDER BY created_at, job_id`,
      [requestId],
    );
  }

  listPending(sessionId: string): ResultType<JobRecord[], JobStoreError> {
    return this.list(
      "listPending",
      "SELECT * FROM background_jobs WHERE session_id = ? AND delivery = 'pending' ORDER BY ended_at, job_id",
      [sessionId],
    );
  }

  listSessionsWithPending(): ResultType<string[], JobStoreError> {
    return captureStoreOperation("listSessionsWithPending", () =>
      this.#database
        .query<{ session_id: string }, []>(
          "SELECT DISTINCT session_id FROM background_jobs WHERE delivery = 'pending'",
        )
        .all()
        .map((row) => row.session_id),
    );
  }

  hasActiveAwait(requestId: string): ResultType<boolean, JobStoreError> {
    return captureStoreOperation(
      "hasActiveAwait",
      () =>
        this.#database
          .query<{ found: number }, [string]>(
            `SELECT 1 AS found FROM background_jobs WHERE request_id = ? AND mode = 'await' AND status IN ${ACTIVE_STATES} LIMIT 1`,
          )
          .get(requestId) !== null,
    );
  }

  hasPending(sessionId: string): ResultType<boolean, JobStoreError> {
    return captureStoreOperation(
      "hasPending",
      () =>
        this.#database
          .query<{ found: number }, [string]>(
            "SELECT 1 AS found FROM background_jobs WHERE session_id = ? AND delivery = 'pending' LIMIT 1",
          )
          .get(sessionId) !== null,
    );
  }

  acknowledge(jobIds: readonly string[]): ResultType<void, JobStoreError> {
    return captureStoreOperation("acknowledge", () => {
      const statement = this.#database.query(
        "UPDATE background_jobs SET delivery = 'acknowledged' WHERE job_id = ? AND delivery = 'pending'",
      );
      for (const jobId of jobIds) statement.run(jobId);
    });
  }

  suppress(jobIds: readonly string[]): ResultType<void, JobStoreError> {
    return captureStoreOperation("suppress", () => {
      const statement = this.#database.query(
        "UPDATE background_jobs SET delivery = 'suppressed' WHERE job_id = ? AND delivery = 'pending'",
      );
      for (const jobId of jobIds) statement.run(jobId);
    });
  }

  suppressPendingForSession(sessionId: string): ResultType<void, JobStoreError> {
    return captureStoreOperation("suppressPendingForSession", () => {
      this.#database
        .query(
          "UPDATE background_jobs SET delivery = 'suppressed' WHERE session_id = ? AND delivery = 'pending'",
        )
        .run(sessionId);
    });
  }

  /** Spends one consecutive wake and binds the jobs to it, unless the session's budget is spent. */
  claimWake(input: {
    readonly sessionId: string;
    readonly jobIds: readonly string[];
    readonly wakeId: string;
  }): ResultType<boolean, JobStoreError> {
    return runBunSqliteTransaction(
      this.#database,
      () =>
        Result.gen(
          function* (this: SqliteJobStore) {
            const budget = yield* captureStoreOperation("claimWake.read", () =>
              this.#database
                .query<{ consecutive_wakes: number }, [string]>(
                  "SELECT consecutive_wakes FROM background_job_wake_budgets WHERE session_id = ?",
                )
                .get(input.sessionId),
            );
            const spent = budget?.consecutive_wakes ?? 0;
            if (spent >= JOB_LIMITS.maxConsecutiveWakes) return Result.ok(false);
            yield* captureStoreOperation("claimWake.write", () => {
              this.#database
                .query(
                  `INSERT INTO background_job_wake_budgets (session_id, consecutive_wakes)
                   VALUES (?, 1)
                   ON CONFLICT(session_id) DO UPDATE SET consecutive_wakes = consecutive_wakes + 1`,
                )
                .run(input.sessionId);
              const statement = this.#database.query(
                "UPDATE background_jobs SET wake_id = ? WHERE job_id = ? AND wake_id IS NULL",
              );
              for (const jobId of input.jobIds) statement.run(input.wakeId, jobId);
            });
            return Result.ok(true);
          }.bind(this),
        ),
      (cause) => storeFailure("claimWake", cause),
    );
  }

  resetWakeBudget(sessionId: string): ResultType<void, JobStoreError> {
    return captureStoreOperation("resetWakeBudget", () => {
      this.#database
        .query("DELETE FROM background_job_wake_budgets WHERE session_id = ?")
        .run(sessionId);
    });
  }

  deleteEndedBefore(cutoff: number): ResultType<string[], JobStoreError> {
    return captureStoreOperation("deleteEndedBefore", () =>
      this.#database
        .query<{ job_id: string }, [number]>(
          `DELETE FROM background_jobs
           WHERE ended_at IS NOT NULL AND ended_at < ? AND delivery != 'pending'
           RETURNING job_id`,
        )
        .all(cutoff)
        .map((row) => row.job_id),
    );
  }

  private getByLaunchKey(launchKey: string): ResultType<JobRecord | null, JobStoreError> {
    return captureStoreOperation("get-by-launch-key", () =>
      this.#database
        .query<JobRow, [string]>("SELECT * FROM background_jobs WHERE launch_key = ?")
        .get(launchKey),
    ).andThen((row) => (row ? decodeJobRow(row) : Result.ok(null)));
  }

  private requireJob(jobId: string): ResultType<JobRecord, JobStoreError> {
    return this.get(jobId).andThen((job) =>
      job
        ? Result.ok(job)
        : Result.err(new JobStoreCorrupt({ jobId, message: "Stored job record disappeared" })),
    );
  }

  private countActive(
    condition: string,
    params: readonly string[],
  ): ResultType<number, JobStoreFailed> {
    return captureStoreOperation("count-active", () => {
      const row = this.#database
        .query<{ count: number }, string[]>(
          `SELECT COUNT(*) AS count FROM background_jobs WHERE ${condition} AND status IN ${ACTIVE_STATES}`,
        )
        .get(...params);
      return row?.count ?? 0;
    });
  }

  private list(
    operation: string,
    sql: string,
    params: readonly (string | number)[],
  ): ResultType<JobRecord[], JobStoreError> {
    return captureStoreOperation(operation, () =>
      this.#database.query<JobRow, (string | number)[]>(sql).all(...params),
    ).andThen((rows) => Result.all(rows.map(decodeJobRow)));
  }
}
