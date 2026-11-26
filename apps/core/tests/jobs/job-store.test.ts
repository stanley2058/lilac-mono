import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JobOwner, JobRecord } from "../../src/jobs/job-domain";
import { SqliteJobStore, type ReserveJobResult } from "../../src/jobs/job-store";

// The table as the first job store release created it.
const LEGACY_SCHEMA = `
  CREATE TABLE background_jobs (
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
  CREATE INDEX background_jobs_session_idx ON background_jobs(session_id, created_at);
  CREATE INDEX background_jobs_request_idx ON background_jobs(request_id, mode, status);
  CREATE INDEX background_jobs_delivery_idx ON background_jobs(delivery, session_id);
  INSERT INTO background_jobs (
    job_id, launch_key, session_id, request_id, tool_call_id, platform, run_profile, mode, label,
    command, cwd, status, exit_code, delivery, deadline_at, created_at, ended_at
  ) VALUES (
    'job_legacy', 'request:call', 'native:thread', 'request', 'call', 'native', 'primary',
    'service', 'dev server', 'bun dev', '/srv', 'exited', 0, 'pending', 10, 1, 5
  );
`;

function ok<T>(result: {
  match: (handlers: { ok: (value: T) => T; err: (error: unknown) => T }) => T;
}): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

describe("SqliteJobStore", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lilac-job-store-"));
    dbPath = path.join(dir, "jobs.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reserve(store: SqliteJobStore, owner: JobOwner): JobRecord {
    const reserved = ok<ReserveJobResult>(
      store.reserve({
        jobId: `job_${owner.platform}`,
        launchKey: `${owner.requestId}:call`,
        owner,
        toolCallId: "call",
        mode: "await",
        label: "build",
        command: "bun test",
        cwd: "/srv",
        deadlineAt: Date.now() + 1_000,
      }),
    );
    if (reserved.kind !== "created") throw new Error(`unexpected ${reserved.kind}`);
    return reserved.job;
  }

  it("widens a legacy platform check and keeps existing jobs and indexes", () => {
    const legacy = new Database(dbPath, { create: true, strict: true });
    legacy.run(LEGACY_SCHEMA);
    legacy.close();

    const store = new SqliteJobStore({ dbPath });
    try {
      expect(ok<JobRecord | null>(store.get("job_legacy"))).toMatchObject({
        platform: "native",
        label: "dev server",
        delivery: "pending",
      });
      const github = reserve(store, {
        requestId: "github-request",
        requestDeliveryId: "delivery",
        sessionId: "github:o/r#1",
        platform: "github",
        userId: null,
        originMessageId: null,
        runProfile: "primary",
      });
      expect(github.platform).toBe("github");
    } finally {
      store.close();
    }

    const inspect = new Database(dbPath, { readonly: true });
    try {
      const indexes = inspect
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='background_jobs' AND name LIKE 'background_jobs_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual([
        "background_jobs_delivery_idx",
        "background_jobs_request_idx",
        "background_jobs_session_idx",
      ]);
      const tables = inspect
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain("background_jobs_legacy");
    } finally {
      inspect.close();
    }
  });

  it("accepts heartbeat runs, whose request client is unknown", () => {
    const store = new SqliteJobStore({ dbPath });
    try {
      const job = reserve(store, {
        requestId: "heartbeat-request",
        requestDeliveryId: "delivery",
        sessionId: "__heartbeat__",
        platform: "unknown",
        userId: null,
        originMessageId: null,
        runProfile: "primary",
      });
      expect(job.platform).toBe("unknown");
    } finally {
      store.close();
    }
  });
});
