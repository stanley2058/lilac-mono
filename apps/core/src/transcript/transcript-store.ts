import { Database } from "bun:sqlite";
import JSON from "superjson";
import type { ModelMessage } from "ai";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { normalizeReplayMessages } from "@stanley2058/lilac-utils";
import type { MsgRef } from "../surface/types";

export type TranscriptSnapshot = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  createdTs: number;
  updatedTs: number;
  messages: ModelMessage[];
  finalText?: string;
  modelLabel?: string;
};

export type RecentAgentWriteSnapshot = {
  requestId: string;
  sessionId: string;
  client: AdapterPlatform;
  messageId: string;
  updatedTs: number;
  finalText?: string;
};

export type TranscriptDiscoveryRecord = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  updatedTs: number;
  finalText?: string;
  surfaceRefs: MsgRef[];
};

export type TranscriptStore = {
  saveRequestTranscript(input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    messages: readonly ModelMessage[];
    finalText?: string;
    modelLabel?: string;
  }): void;

  linkSurfaceMessagesToRequest(input: {
    requestId: string;
    created: readonly MsgRef[];
    last: MsgRef;
  }): void;

  getTranscriptBySurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): TranscriptSnapshot | null;

  getLatestTranscriptBySession?(input: { sessionId: string }): TranscriptSnapshot | null;

  listSurfaceMessagesForRequest?(input: { requestId: string }): MsgRef[];

  listRecentAgentWrites?(input?: {
    limit?: number;
    offset?: number;
    client?: AdapterPlatform;
  }): RecentAgentWriteSnapshot[];

  listDiscoveryRecords?(): TranscriptDiscoveryRecord[];

  close(): void;
};

export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_transcripts_session
      ON request_transcripts(session_id, updated_ts);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS surface_message_to_request (
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        PRIMARY KEY (platform, channel_id, message_id)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_surface_message_to_request_request
      ON surface_message_to_request(request_id);
    `);
  }

  saveRequestTranscript(input: {
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    messages: readonly ModelMessage[];
    finalText?: string;
    modelLabel?: string;
  }): void {
    const now = Date.now();
    const normalizedMessages = normalizeReplayMessages(input.messages);

    // Persist the full transcript, but repair provider-shaped stringified assistant
    // tool inputs into canonical object form so resumed sessions remain executable.
    // Do not prune/compact tool outputs at persistence time; do that (if needed)
    // only in the model-facing view right before sending.
    const finalJson = JSON.stringify(normalizedMessages);

    this.db.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        session_id=excluded.session_id,
        request_client=excluded.request_client,
        updated_ts=excluded.updated_ts,
        model_label=excluded.model_label,
        final_text=excluded.final_text,
        messages_json=excluded.messages_json;
      `,
      [
        input.requestId,
        input.sessionId,
        input.requestClient,
        now,
        now,
        input.modelLabel ?? null,
        input.finalText ?? null,
        finalJson,
      ],
    );

    this.pruneRetention();
  }

  linkSurfaceMessagesToRequest(input: {
    requestId: string;
    created: readonly MsgRef[];
    last: MsgRef;
  }): void {
    const now = Date.now();
    const all = [...input.created];
    // Ensure last is included even if callers forgot.
    if (
      !all.some(
        (m) =>
          m.platform === input.last.platform &&
          m.channelId === input.last.channelId &&
          m.messageId === input.last.messageId,
      )
    ) {
      all.push(input.last);
    }

    for (const ref of all) {
      this.db.run(
        `
        INSERT INTO surface_message_to_request (
          platform, channel_id, message_id, request_id, created_ts
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(platform, channel_id, message_id) DO UPDATE SET
          request_id=excluded.request_id,
          created_ts=excluded.created_ts;
        `,
        [ref.platform, ref.channelId, ref.messageId, input.requestId, now],
      );
    }
  }

  getTranscriptBySurfaceMessage(input: {
    platform: AdapterPlatform;
    channelId: string;
    messageId: string;
  }): TranscriptSnapshot | null {
    const mapRow = this.db
      .query(
        "SELECT request_id FROM surface_message_to_request WHERE platform = ? AND channel_id = ? AND message_id = ?",
      )
      .get(input.platform, input.channelId, input.messageId) as {
      request_id: string;
    } | null;

    if (!mapRow) return null;

    const row = this.db
      .query(
        `
        SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
        FROM request_transcripts
        WHERE request_id = ?
        `,
      )
      .get(mapRow.request_id) as {
      request_id: string;
      session_id: string;
      request_client: string;
      created_ts: number;
      updated_ts: number;
      model_label: string | null;
      final_text: string | null;
      messages_json: string;
    } | null;

    return this.rowToSnapshot(row);
  }

  getLatestTranscriptBySession(input: { sessionId: string }): TranscriptSnapshot | null {
    const row = this.db
      .query(
        `
        SELECT request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
        FROM request_transcripts
        WHERE session_id = ?
        ORDER BY updated_ts DESC, created_ts DESC, rowid DESC
        LIMIT 1
        `,
      )
      .get(input.sessionId) as {
      request_id: string;
      session_id: string;
      request_client: string;
      created_ts: number;
      updated_ts: number;
      model_label: string | null;
      final_text: string | null;
      messages_json: string;
    } | null;

    return this.rowToSnapshot(row);
  }

  listSurfaceMessagesForRequest(input: { requestId: string }): MsgRef[] {
    const rows = this.db
      .query(
        `
        SELECT platform, channel_id, message_id
        FROM surface_message_to_request
        WHERE request_id = ?
        ORDER BY created_ts ASC, rowid ASC
        `,
      )
      .all(input.requestId) as Array<{
      platform: string;
      channel_id: string;
      message_id: string;
    }>;

    const refs: MsgRef[] = [];
    for (const row of rows) {
      if (row.platform !== "discord" && row.platform !== "github") continue;
      refs.push({
        platform: row.platform,
        channelId: row.channel_id,
        messageId: row.message_id,
      });
    }

    return refs;
  }

  listRecentAgentWrites(input?: {
    limit?: number;
    offset?: number;
    client?: AdapterPlatform;
  }): RecentAgentWriteSnapshot[] {
    const limit = Math.min(200, Math.max(1, Math.floor(input?.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input?.offset ?? 0));
    const client = input?.client ?? null;

    const rows = this.db
      .query(
        `
        SELECT
          rt.request_id,
          sm.platform,
          sm.channel_id,
          sm.message_id,
          rt.updated_ts,
          rt.final_text
        FROM request_transcripts rt
        JOIN surface_message_to_request sm
          ON sm.request_id = rt.request_id
        WHERE sm.rowid = (
          SELECT sm2.rowid
          FROM surface_message_to_request sm2
          WHERE sm2.request_id = sm.request_id
            AND sm2.platform = sm.platform
            AND sm2.channel_id = sm.channel_id
          ORDER BY sm2.created_ts DESC, sm2.rowid DESC
          LIMIT 1
        )
          AND (?1 IS NULL OR sm.platform = ?1)
        ORDER BY rt.updated_ts DESC, rt.created_ts DESC, sm.created_ts DESC, sm.rowid DESC
        LIMIT ?2 OFFSET ?3
        `,
      )
      .all(client, limit, offset) as Array<{
      request_id: string;
      platform: string;
      channel_id: string;
      message_id: string;
      updated_ts: number;
      final_text: string | null;
    }>;

    const out: RecentAgentWriteSnapshot[] = [];
    for (const row of rows) {
      if (row.platform !== "discord" && row.platform !== "github") continue;
      out.push({
        requestId: row.request_id,
        sessionId: row.channel_id,
        client: row.platform,
        messageId: row.message_id,
        updatedTs: row.updated_ts,
        finalText: row.final_text ?? undefined,
      });
    }

    return out;
  }

  listDiscoveryRecords(): TranscriptDiscoveryRecord[] {
    const rows = this.db
      .query(
        `
        SELECT
          rt.request_id,
          rt.session_id,
          rt.request_client,
          rt.updated_ts,
          rt.final_text,
          sm.platform AS surface_platform,
          sm.channel_id AS surface_channel_id,
          sm.message_id AS surface_message_id,
          sm.created_ts AS surface_created_ts
        FROM request_transcripts rt
        LEFT JOIN surface_message_to_request sm
          ON sm.request_id = rt.request_id
        ORDER BY rt.updated_ts DESC, rt.created_ts DESC, sm.created_ts ASC, sm.rowid ASC
        `,
      )
      .all() as Array<{
      request_id: string;
      session_id: string;
      request_client: string;
      updated_ts: number;
      final_text: string | null;
      surface_platform: string | null;
      surface_channel_id: string | null;
      surface_message_id: string | null;
    }>;

    const byRequestId = new Map<string, TranscriptDiscoveryRecord>();
    for (const row of rows) {
      let record = byRequestId.get(row.request_id);
      if (!record) {
        record = {
          requestId: row.request_id,
          sessionId: row.session_id,
          requestClient: row.request_client as AdapterPlatform,
          updatedTs: row.updated_ts,
          finalText: row.final_text ?? undefined,
          surfaceRefs: [],
        };
        byRequestId.set(row.request_id, record);
      }

      if (
        row.surface_platform !== null &&
        row.surface_channel_id !== null &&
        row.surface_message_id !== null &&
        (row.surface_platform === "discord" || row.surface_platform === "github")
      ) {
        record.surfaceRefs.push({
          platform: row.surface_platform,
          channelId: row.surface_channel_id,
          messageId: row.surface_message_id,
        });
      }
    }

    return [...byRequestId.values()];
  }

  private rowToSnapshot(
    row: {
      request_id: string;
      session_id: string;
      request_client: string;
      created_ts: number;
      updated_ts: number;
      model_label: string | null;
      final_text: string | null;
      messages_json: string;
    } | null,
  ): TranscriptSnapshot | null {
    if (!row) return null;

    let messages: ModelMessage[];
    try {
      messages = normalizeReplayMessages(JSON.parse(row.messages_json));
    } catch {
      return null;
    }

    return {
      requestId: row.request_id,
      sessionId: row.session_id,
      requestClient: row.request_client as AdapterPlatform,
      createdTs: row.created_ts,
      updatedTs: row.updated_ts,
      messages,
      modelLabel: row.model_label ?? undefined,
      finalText: row.final_text ?? undefined,
    };
  }

  private pruneRetention() {
    const TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_REQUESTS = 10_000;

    const cutoff = Date.now() - TTL_MS;
    this.db.run("DELETE FROM request_transcripts WHERE updated_ts < ?", [cutoff]);

    // Clamp max rows by deleting oldest.
    const countRow = this.db.query("SELECT COUNT(1) as c FROM request_transcripts").get() as {
      c: number;
    };
    const count = typeof countRow?.c === "number" ? countRow.c : 0;
    if (count <= MAX_REQUESTS) return;

    const toDelete = count - MAX_REQUESTS;
    const victims = this.db
      .query("SELECT request_id FROM request_transcripts ORDER BY updated_ts ASC LIMIT ?")
      .all(toDelete) as Array<{ request_id: string }>;
    if (victims.length === 0) return;

    for (const v of victims) {
      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [v.request_id]);
      this.db.run("DELETE FROM surface_message_to_request WHERE request_id = ?", [v.request_id]);
    }
  }
}
