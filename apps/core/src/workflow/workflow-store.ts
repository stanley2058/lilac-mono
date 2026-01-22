import { Database } from "bun:sqlite";
import { env } from "@stanley2058/lilac-utils";
import path from "node:path";

import type { WorkflowRecord, WorkflowTaskRecord } from "./types";

export type WorkflowStore = {
  ensureSchema(): void;

  getWorkflow(workflowId: string): WorkflowRecord | null;
  upsertWorkflow(w: WorkflowRecord): void;

  getTask(workflowId: string, taskId: string): WorkflowTaskRecord | null;
  upsertTask(t: WorkflowTaskRecord): void;
  listTasks(workflowId: string): WorkflowTaskRecord[];

  /**
   * Atomically increments resumeSeq and returns the updated workflow.
   * Returns null if workflow does not exist.
   */
  bumpResumeSeq(workflowId: string): WorkflowRecord | null;
};

export function resolveWorkflowDbPath(): string {
  return path.resolve(env.sqliteUrl);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class SqliteWorkflowStore implements WorkflowStore {
  private readonly db: Database;

  /** Unsafe direct sqlite access hooks for internal services. */
  unsafeListActiveDiscordWaitForReplyTasksByChannelId(channelId: string): WorkflowTaskRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM workflow_tasks WHERE kind = ? AND discord_channel_id = ? AND state IN ('queued','running','blocked')",
      )
      .all("discord.wait_for_reply", channelId) as Array<{
      workflow_id: string;
      task_id: string;
      kind: string;
      description: string;
      state: string;
      input_json: string | null;
      result_json: string | null;
      created_at: number;
      updated_at: number;
      resolved_at: number | null;
      resolved_by: string | null;
      discord_channel_id: string | null;
      discord_message_id: string | null;
      discord_from_user_id: string | null;
      timeout_at: number | null;
    }>;

    return rows.map((row) => ({
      workflowId: row.workflow_id,
      taskId: row.task_id,
      kind: row.kind,
      description: row.description,
      state: row.state as WorkflowTaskRecord["state"],
      input: parseJson(row.input_json) ?? undefined,
      result: parseJson(row.result_json) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      discordChannelId: row.discord_channel_id ?? undefined,
      discordMessageId: row.discord_message_id ?? undefined,
      discordFromUserId: row.discord_from_user_id ?? undefined,
      timeoutAt: row.timeout_at ?? undefined,
    }));
  }

  /**
   * Unsafe direct sqlite access hook used by the surface router.
   * Includes resolved tasks to avoid races between workflow resolution and router routing.
   */
  unsafeListDiscordWaitForReplyTasksByChannelIdAndMessageId(
    channelId: string,
    messageId: string,
  ): WorkflowTaskRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM workflow_tasks WHERE kind = ? AND discord_channel_id = ? AND discord_message_id = ? AND state IN ('queued','running','blocked','resolved')",
      )
      .all("discord.wait_for_reply", channelId, messageId) as Array<{
      workflow_id: string;
      task_id: string;
      kind: string;
      description: string;
      state: string;
      input_json: string | null;
      result_json: string | null;
      created_at: number;
      updated_at: number;
      resolved_at: number | null;
      resolved_by: string | null;
      discord_channel_id: string | null;
      discord_message_id: string | null;
      discord_from_user_id: string | null;
      timeout_at: number | null;
    }>;

    return rows.map((row) => ({
      workflowId: row.workflow_id,
      taskId: row.task_id,
      kind: row.kind,
      description: row.description,
      state: row.state as WorkflowTaskRecord["state"],
      input: parseJson(row.input_json) ?? undefined,
      result: parseJson(row.result_json) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      discordChannelId: row.discord_channel_id ?? undefined,
      discordMessageId: row.discord_message_id ?? undefined,
      discordFromUserId: row.discord_from_user_id ?? undefined,
      timeoutAt: row.timeout_at ?? undefined,
    }));
  }

  unsafeListActiveTimeoutTasks(nowMs: number): WorkflowTaskRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM workflow_tasks WHERE timeout_at IS NOT NULL AND timeout_at <= ? AND state IN ('queued','running','blocked')",
      )
      .all(nowMs) as Array<{
      workflow_id: string;
      task_id: string;
      kind: string;
      description: string;
      state: string;
      input_json: string | null;
      result_json: string | null;
      created_at: number;
      updated_at: number;
      resolved_at: number | null;
      resolved_by: string | null;
      discord_channel_id: string | null;
      discord_message_id: string | null;
      discord_from_user_id: string | null;
      timeout_at: number | null;
    }>;

    return rows.map((row) => ({
      workflowId: row.workflow_id,
      taskId: row.task_id,
      kind: row.kind,
      description: row.description,
      state: row.state as WorkflowTaskRecord["state"],
      input: parseJson(row.input_json) ?? undefined,
      result: parseJson(row.result_json) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      discordChannelId: row.discord_channel_id ?? undefined,
      discordMessageId: row.discord_message_id ?? undefined,
      discordFromUserId: row.discord_from_user_id ?? undefined,
      timeoutAt: row.timeout_at ?? undefined,
    }));
  }

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? resolveWorkflowDbPath());
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resume_published_at INTEGER,
        definition_json TEXT NOT NULL,
        resume_seq INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_tasks (
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        description TEXT NOT NULL,
        state TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT,

        discord_channel_id TEXT,
        discord_message_id TEXT,
        discord_from_user_id TEXT,
        timeout_at INTEGER,

        PRIMARY KEY (workflow_id, task_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_workflow_tasks_wid_state
      ON workflow_tasks(workflow_id, state);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_workflow_tasks_discord_wait
      ON workflow_tasks(kind, discord_channel_id, state);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_workflow_tasks_timeout
      ON workflow_tasks(timeout_at, state);
    `);
  }

  getWorkflow(workflowId: string): WorkflowRecord | null {
    const row = this.db
      .query(
        "SELECT workflow_id, state, created_at, updated_at, resolved_at, resume_published_at, definition_json, resume_seq FROM workflows WHERE workflow_id = ?",
      )
      .get(workflowId) as
      | {
          workflow_id: string;
          state: string;
          created_at: number;
          updated_at: number;
          resolved_at: number | null;
          resume_published_at: number | null;
          definition_json: string;
          resume_seq: number;
        }
      | null;

    if (!row) return null;

    const def = parseJson<WorkflowRecord["definition"]>(row.definition_json);
    if (!def) return null;

    return {
      workflowId: row.workflow_id,
      state: row.state as WorkflowRecord["state"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resumePublishedAt: row.resume_published_at ?? undefined,
      definition: def,
      resumeSeq: row.resume_seq,
    };
  }

  upsertWorkflow(w: WorkflowRecord): void {
    this.db.run(
      `
      INSERT INTO workflows (
        workflow_id, state, created_at, updated_at, resolved_at, resume_published_at, definition_json, resume_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET
        state=excluded.state,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at,
        resolved_at=excluded.resolved_at,
        resume_published_at=excluded.resume_published_at,
        definition_json=excluded.definition_json,
        resume_seq=excluded.resume_seq;
      `,
      [
        w.workflowId,
        w.state,
        w.createdAt,
        w.updatedAt,
        w.resolvedAt ?? null,
        w.resumePublishedAt ?? null,
        JSON.stringify(w.definition),
        w.resumeSeq,
      ],
    );
  }

  getTask(workflowId: string, taskId: string): WorkflowTaskRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM workflow_tasks WHERE workflow_id = ? AND task_id = ?",
      )
      .get(workflowId, taskId) as
      | {
          workflow_id: string;
          task_id: string;
          kind: string;
          description: string;
          state: string;
          input_json: string | null;
          result_json: string | null;
          created_at: number;
          updated_at: number;
          resolved_at: number | null;
          resolved_by: string | null;
          discord_channel_id: string | null;
          discord_message_id: string | null;
          discord_from_user_id: string | null;
          timeout_at: number | null;
        }
      | null;

    if (!row) return null;

    return {
      workflowId: row.workflow_id,
      taskId: row.task_id,
      kind: row.kind,
      description: row.description,
      state: row.state as WorkflowTaskRecord["state"],
      input: parseJson(row.input_json) ?? undefined,
      result: parseJson(row.result_json) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      discordChannelId: row.discord_channel_id ?? undefined,
      discordMessageId: row.discord_message_id ?? undefined,
      discordFromUserId: row.discord_from_user_id ?? undefined,
      timeoutAt: row.timeout_at ?? undefined,
    };
  }

  upsertTask(t: WorkflowTaskRecord): void {
    this.db.run(
      `
      INSERT INTO workflow_tasks (
        workflow_id, task_id, kind, description, state,
        input_json, result_json,
        created_at, updated_at, resolved_at, resolved_by,
        discord_channel_id, discord_message_id, discord_from_user_id, timeout_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, task_id) DO UPDATE SET
        kind=excluded.kind,
        description=excluded.description,
        state=excluded.state,
        input_json=excluded.input_json,
        result_json=excluded.result_json,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at,
        resolved_at=excluded.resolved_at,
        resolved_by=excluded.resolved_by,
        discord_channel_id=excluded.discord_channel_id,
        discord_message_id=excluded.discord_message_id,
        discord_from_user_id=excluded.discord_from_user_id,
        timeout_at=excluded.timeout_at;
      `,
      [
        t.workflowId,
        t.taskId,
        t.kind,
        t.description,
        t.state,
        t.input ? JSON.stringify(t.input) : null,
        t.result ? JSON.stringify(t.result) : null,
        t.createdAt,
        t.updatedAt,
        t.resolvedAt ?? null,
        t.resolvedBy ?? null,
        t.discordChannelId ?? null,
        t.discordMessageId ?? null,
        t.discordFromUserId ?? null,
        t.timeoutAt ?? null,
      ],
    );
  }

  listTasks(workflowId: string): WorkflowTaskRecord[] {
    const rows = this.db
      .query(
        "SELECT * FROM workflow_tasks WHERE workflow_id = ? ORDER BY created_at ASC",
      )
      .all(workflowId) as Array<{
      workflow_id: string;
      task_id: string;
      kind: string;
      description: string;
      state: string;
      input_json: string | null;
      result_json: string | null;
      created_at: number;
      updated_at: number;
      resolved_at: number | null;
      resolved_by: string | null;
      discord_channel_id: string | null;
      discord_message_id: string | null;
      discord_from_user_id: string | null;
      timeout_at: number | null;
    }>;

    return rows.map((row) => ({
      workflowId: row.workflow_id,
      taskId: row.task_id,
      kind: row.kind,
      description: row.description,
      state: row.state as WorkflowTaskRecord["state"],
      input: parseJson(row.input_json) ?? undefined,
      result: parseJson(row.result_json) ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      discordChannelId: row.discord_channel_id ?? undefined,
      discordMessageId: row.discord_message_id ?? undefined,
      discordFromUserId: row.discord_from_user_id ?? undefined,
      timeoutAt: row.timeout_at ?? undefined,
    }));
  }

  bumpResumeSeq(workflowId: string): WorkflowRecord | null {
    // Wrap in transaction for atomicity.
    this.db.run("BEGIN");
    try {
      const cur = this.getWorkflow(workflowId);
      if (!cur) {
        this.db.run("ROLLBACK");
        return null;
      }

      const updated: WorkflowRecord = {
        ...cur,
        resumeSeq: cur.resumeSeq + 1,
        updatedAt: Date.now(),
      };
      this.upsertWorkflow(updated);
      this.db.run("COMMIT");
      return updated;
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }
}
