import { Database } from "bun:sqlite";
import JSON from "superjson";
import type { ModelMessage } from "ai";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
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

  close(): void;
};

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  return stringifyUnknown(value).length;
}

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

    // Persist the full transcript as-is.
    // Do not prune/compact tool outputs at persistence time; do that (if needed)
    // only in the model-facing view right before sending.
    const finalJson = JSON.stringify(input.messages);

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

    if (!row) return null;

    let messages: ModelMessage[];
    try {
      messages = JSON.parse(row.messages_json);
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
