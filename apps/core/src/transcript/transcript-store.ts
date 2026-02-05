import { Database } from "bun:sqlite";
import JSON from "superjson";
import type { AssistantContent, FilePart, ModelMessage, TextPart } from "ai";
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

function pruneToolOutputs(messages: readonly ModelMessage[]): ModelMessage[] {
  // OpenCode-style: keep recent tool outputs, clear older outputs but keep tool-result structure.
  const PRUNE_PROTECT_CHARS = 40_000;
  const PRUNE_MINIMUM_CHARS = 20_000;
  const PRUNE_PROTECTED_TOOLS = new Set(["skill"]);
  const PLACEHOLDER = "[Old tool result content cleared]";

  let total = 0;
  let pruned = 0;

  const toPrune: Array<{ msgIndex: number; partIndex: number }> = [];

  // Walk backwards over the original messages, collecting prune candidates.
  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = messages[msgIndex]!;
    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let partIndex = msg.content.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.content[partIndex];
      if (!part || typeof part !== "object") continue;
      if (part.type !== "tool-result") continue;

      const p = part;

      const toolName = p.toolName;
      if (toolName && PRUNE_PROTECTED_TOOLS.has(toolName)) continue;

      const estimate = estimateChars(p.output);
      total += estimate;

      if (total > PRUNE_PROTECT_CHARS) {
        pruned += estimate;
        toPrune.push({ msgIndex, partIndex });
      }
    }
  }

  // Only apply if it helps materially.
  if (pruned < PRUNE_MINIMUM_CHARS) {
    return messages.map((m) => m as ModelMessage);
  }

  // Apply pruning using a shallow structural copy.
  const out: ModelMessage[] = messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) =>
          p && typeof p === "object" ? { ...p } : p,
        ),
      } as ModelMessage;
    }
    return { ...m } as ModelMessage;
  });

  for (const item of toPrune) {
    const msg = out[item.msgIndex];
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const part = msg.content[item.partIndex];
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool-result") continue;
    part.output = { type: "text", value: PLACEHOLDER };
  }

  return out;
}

function scrubLargeBinary(messages: readonly ModelMessage[]): ModelMessage[] {
  const MAX_BINARY_BYTES_PER_PART = 256 * 1024;
  const MAX_BINARY_BYTES_TOTAL = 2 * 1024 * 1024;
  const OMITTED = "[binary omitted]";

  let totalBytes = 0;

  const estimateBase64Bytes = (b64: string): number => {
    // Approximate decoded bytes; sufficient for bounding storage.
    const len = b64.length;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((len * 3) / 4) - padding;
    return Math.max(0, bytes);
  };

  const scrubFilePart = (part: FilePart): FilePart | TextPart => {
    if (part.data instanceof Uint8Array) {
      const bytes = part.data;
      const tooBig = bytes.byteLength > MAX_BINARY_BYTES_PER_PART;
      const tooMuch = totalBytes + bytes.byteLength > MAX_BINARY_BYTES_TOTAL;
      if (tooBig || tooMuch) return { type: "text", text: OMITTED };
      totalBytes += bytes.byteLength;
      return part;
    }
    return part;
  };

  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i]! };

    if (Array.isArray(msg.content)) {
      // Shallow-clone parts so we can safely rewrite them.
      const cloned = (msg.content as unknown[]).map((p) =>
        p && typeof p === "object" ? { ...(p as Record<string, unknown>) } : p,
      );
      msg.content = cloned as unknown as typeof msg.content;
    }

    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (msg.role === "assistant") {
      const content: AssistantContent = [];
      for (const part of msg.content) {
        if (part.type !== "file") {
          content.push(part);
          continue;
        }

        switch (part.type) {
          case "file": {
            content.push(scrubFilePart(part));
            break;
          }
        }
      }
      msg.content = content;
    }

    if (msg.role === "tool" && Array.isArray(msg.content)) {
      const content = (msg.content as unknown[]).map((part) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        if (p["type"] !== "tool-result") return part;

        const output = p["output"];
        if (!output || typeof output !== "object") return part;

        const o = output as Record<string, unknown>;
        if (o["type"] !== "content") return part;
        if (!Array.isArray(o["value"])) return part;

        const value = o["value"] as unknown[];
        const nextValue: unknown[] = [];

        for (const item of value) {
          if (!item || typeof item !== "object") {
            nextValue.push(item);
            continue;
          }

          const it = item as Record<string, unknown>;
          const t = it["type"];
          if (t !== "image-data" && t !== "file-data") {
            nextValue.push(item);
            continue;
          }

          const data = it["data"];
          if (typeof data !== "string") {
            nextValue.push(item);
            continue;
          }

          const bytes = estimateBase64Bytes(data);
          const tooBig = bytes > MAX_BINARY_BYTES_PER_PART;
          const tooMuch = totalBytes + bytes > MAX_BINARY_BYTES_TOTAL;
          if (tooBig || tooMuch) {
            const mediaType =
              typeof it["mediaType"] === "string" ? it["mediaType"] : "";
            const filename =
              typeof it["filename"] === "string" ? it["filename"] : "";
            const detail =
              filename || mediaType
                ? ` (${[filename, mediaType].filter(Boolean).join(", ")})`
                : "";
            nextValue.push({ type: "text", text: `${OMITTED}${detail}` });
            continue;
          }

          totalBytes += bytes;
          nextValue.push(item);
        }

        p["output"] = { ...o, value: nextValue };
        return p;
      });

      msg.content = content as unknown as typeof msg.content;
    }

    out.push(msg);
  }

  return out;
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

    // Remove oversized binary payloads (e.g. base64 tool attachments) before pruning tool outputs.
    // This keeps recent tool metadata while avoiding pathological storage growth.
    const scrubbed = scrubLargeBinary(input.messages);
    const pruned = pruneToolOutputs(scrubbed);

    const messagesJson = JSON.stringify(pruned);

    // Basic bound: avoid storing pathological payloads.
    const MAX_MESSAGES_JSON_CHARS = 10_000_000;
    const finalJson =
      messagesJson.length > MAX_MESSAGES_JSON_CHARS
        ? JSON.stringify(
            pruneToolOutputs(scrubLargeBinary(input.messages.slice(-1000))),
          )
        : messagesJson;

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
    this.db.run("DELETE FROM request_transcripts WHERE updated_ts < ?", [
      cutoff,
    ]);

    // Clamp max rows by deleting oldest.
    const countRow = this.db
      .query("SELECT COUNT(1) as c FROM request_transcripts")
      .get() as { c: number };
    const count = typeof countRow?.c === "number" ? countRow.c : 0;
    if (count <= MAX_REQUESTS) return;

    const toDelete = count - MAX_REQUESTS;
    const victims = this.db
      .query(
        "SELECT request_id FROM request_transcripts ORDER BY updated_ts ASC LIMIT ?",
      )
      .all(toDelete) as Array<{ request_id: string }>;
    if (victims.length === 0) return;

    for (const v of victims) {
      this.db.run("DELETE FROM request_transcripts WHERE request_id = ?", [
        v.request_id,
      ]);
      this.db.run(
        "DELETE FROM surface_message_to_request WHERE request_id = ?",
        [v.request_id],
      );
    }
  }
}
