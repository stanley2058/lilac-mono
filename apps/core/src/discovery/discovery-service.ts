import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import {
  CORE_PROMPT_FILES,
  ensurePromptWorkspace,
  resolveHeartbeatPromptPaths,
  resolvePromptDir,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import type { DiscordSearchStore } from "../surface/store/discord-search-store";
import type { TranscriptStore } from "../transcript/transcript-store";
import { bestEffortAliasForDiscordChannelId } from "../tool-server/tools/resolve-discord-session-id";

export const DISCOVERY_LIMIT_MAX = 100;
export const DISCOVERY_SURROUNDING_MAX = 20;

export type DiscoverySource = "conversation" | "prompt" | "heartbeat";
export type DiscoveryOrderBy = "relevance" | "time";
export type DiscoveryDirection = "asc" | "desc";
export type DiscoveryGroupBy = "origin" | "source" | "none";

export type DiscoveryOrigin =
  | {
      kind: "session";
      platform: AdapterPlatform;
      sessionId: string;
      label?: string;
    }
  | {
      kind: "file";
      filePath: string;
      label?: string;
    };

export type DiscoverySearchInput = {
  query: string;
  sources?: readonly DiscoverySource[];
  orderBy?: DiscoveryOrderBy;
  direction?: DiscoveryDirection;
  groupBy?: DiscoveryGroupBy;
  surrounding?: number;
  offsetTime?: string | number;
  lookbackTime?: string | number;
  limit?: number;
};

export type DiscoveryConversationEntry = {
  kind: "message";
  matched: boolean;
  text: string;
  ts: number;
  score: number;
  bm25: number;
  recencyBoost: number;
  messageId?: string;
  requestId?: string;
  author?: {
    userId: string;
    userName?: string;
  };
  origin?: DiscoveryOrigin;
};

export type DiscoveryFileRangeEntry = {
  kind: "file-range";
  startLine: number;
  endLine: number;
  text: string;
  ts: number;
  score: number;
  bm25: number;
  recencyBoost: number;
  matchRanges: Array<{
    startLine: number;
    endLine: number;
  }>;
  origin?: DiscoveryOrigin;
};

export type DiscoveryResultEntry = DiscoveryConversationEntry | DiscoveryFileRangeEntry;

export type DiscoveryResultGroup = {
  key: string;
  source: DiscoverySource;
  score: number;
  ts?: number;
  origin?: DiscoveryOrigin;
  entries: DiscoveryResultEntry[];
};

export type DiscoverySearchResult = {
  meta: {
    query: string;
    sources: DiscoverySource[];
    orderBy: DiscoveryOrderBy;
    direction: DiscoveryDirection;
    groupBy: DiscoveryGroupBy;
    surrounding: number;
    limit: number;
    window?: {
      startTs: number;
      endTs: number;
    };
  };
  groups: DiscoveryResultGroup[];
};

type IndexedDocument = {
  docKey: string;
  source: DiscoverySource;
  kind: "surface_message" | "transcript_request" | "file_block";
  platform?: AdapterPlatform;
  sessionId?: string;
  messageId?: string;
  requestId?: string;
  filePath?: string;
  title?: string;
  authorId?: string;
  authorName?: string;
  text: string;
  ts: number;
  updatedTs: number;
  startLine?: number;
  endLine?: number;
  deleted?: boolean;
};

type IndexedDocumentRow = {
  rowid: number;
  doc_key: string;
  source: DiscoverySource;
  kind: IndexedDocument["kind"];
  platform: AdapterPlatform | null;
  session_id: string | null;
  message_id: string | null;
  request_id: string | null;
  file_path: string | null;
  title: string | null;
  author_id: string | null;
  author_name: string | null;
  text: string;
  ts: number;
  updated_ts: number;
  start_line: number | null;
  end_line: number | null;
  bm25_score?: number;
};

type SearchCandidate = {
  row: IndexedDocumentRow;
  bm25: number;
  lexicalScore: number;
  recencyBoost: number;
  score: number;
};

type FileBlock = {
  docKey: string;
  filePath: string;
  title: string;
  text: string;
  startLine: number;
  endLine: number;
  ts: number;
};

type TimeWindow = {
  startTs: number;
  endTs: number;
};

const RELATIVE_DURATION_RE = /^(?:\d+(?:ms|s|m|h|d|w))+$/u;
const RELATIVE_DURATION_PART_RE = /(\d+)(ms|s|m|h|d|w)/gu;
const DIGITS_RE = /^\d+$/u;

function normalizeFtsQuery(input: string): string | null {
  const tokens = input
    .trim()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);

  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value ?? fallback)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value ?? fallback)));
}

function clampNonNegativeInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value ?? fallback)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value ?? fallback)));
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/gu, "\n").split("\n");
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const idx = raw.indexOf("\n---");
  if (idx === -1) return raw;
  return raw.slice(idx + "\n---".length).replace(/^\s+/u, "");
}

function parseRelativeDurationMs(rawInput: string, fieldName: string): number {
  const raw = rawInput.trim();
  if (!RELATIVE_DURATION_RE.test(raw)) {
    throw new Error(
      `${fieldName} must be a positive relative duration like '30m', '24h', or '7d'.`,
    );
  }

  let total = 0;
  let matched = 0;
  for (const match of raw.matchAll(RELATIVE_DURATION_PART_RE)) {
    matched += match[0].length;
    const amount = Number(match[1]);
    const unit = match[2];
    const factor =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : unit === "d"
                ? 86_400_000
                : 604_800_000;
    total += amount * factor;
  }

  if (matched !== raw.length || total <= 0) {
    throw new Error(
      `${fieldName} must be a positive relative duration like '30m', '24h', or '7d'.`,
    );
  }

  return total;
}

function parseEpochMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("numeric time values must be positive");
  }
  if (value === 0) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function resolveOffsetTimeMs(input: string | number | undefined, nowMs: number): number {
  if (input === undefined) return nowMs;
  if (typeof input === "number") {
    const parsed = parseEpochMs(input);
    return parsed === 0 ? nowMs : parsed;
  }

  const raw = input.trim();
  if (raw === "0") return nowMs;
  if (DIGITS_RE.test(raw)) {
    return resolveOffsetTimeMs(Number(raw), nowMs);
  }
  if (RELATIVE_DURATION_RE.test(raw)) {
    return nowMs - parseRelativeDurationMs(raw, "offsetTime");
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      "offsetTime must be an ISO-8601 timestamp, a unix epoch, 0, or a positive relative duration.",
    );
  }
  return parsed;
}

function resolveLookbackDurationMs(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new Error("lookbackTime must be a positive duration.");
    }
    return Math.floor(input);
  }

  const raw = input.trim();
  if (DIGITS_RE.test(raw)) {
    return resolveLookbackDurationMs(Number(raw));
  }

  return parseRelativeDurationMs(raw, "lookbackTime");
}

function resolveTimeWindow(input: DiscoverySearchInput, nowMs: number): TimeWindow | undefined {
  const lookbackMs = resolveLookbackDurationMs(input.lookbackTime);
  if (lookbackMs === undefined) {
    if (input.offsetTime !== undefined) {
      throw new Error("offsetTime requires lookbackTime.");
    }
    return undefined;
  }

  const endTs = resolveOffsetTimeMs(input.offsetTime, nowMs);
  const startTs = endTs - lookbackMs;
  return { startTs, endTs };
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".yaml" || ext === ".yml";
}

async function listTextFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTextFilesRecursive(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isTextFile(fullPath)) continue;
    out.push(fullPath);
  }
  out.sort();
  return out;
}

function extractFileBlocks(params: {
  source: DiscoverySource;
  filePath: string;
  title: string;
  text: string;
  ts: number;
}): FileBlock[] {
  const lines = splitLines(params.text);
  const blocks: FileBlock[] = [];

  let idx = 0;
  while (idx < lines.length) {
    while (idx < lines.length && lines[idx]!.trim().length === 0) idx += 1;
    if (idx >= lines.length) break;
    const start = idx;
    while (idx < lines.length && lines[idx]!.trim().length > 0) idx += 1;
    const end = idx;
    const text = lines.slice(start, end).join("\n").trim();
    if (!text) continue;
    const startLine = start + 1;
    const endLine = end;
    blocks.push({
      docKey: `${params.source}:file:${params.filePath}:${startLine}:${endLine}`,
      filePath: params.filePath,
      title: params.title,
      text,
      startLine,
      endLine,
      ts: params.ts,
    });
  }

  return blocks;
}

function buildOriginFromRow(
  row: IndexedDocumentRow,
  cfg: CoreConfig | null,
): DiscoveryOrigin | undefined {
  if (row.source === "conversation") {
    if (!row.platform || !row.session_id) return undefined;
    const label =
      row.platform === "discord" && cfg
        ? bestEffortAliasForDiscordChannelId({ channelId: row.session_id, cfg })
        : undefined;
    return {
      kind: "session",
      platform: row.platform,
      sessionId: row.session_id,
      label,
    };
  }

  if (!row.file_path) return undefined;
  return {
    kind: "file",
    filePath: row.file_path,
    label: row.title ?? path.basename(row.file_path),
  };
}

function buildCandidateScore(params: {
  row: IndexedDocumentRow;
  rank: number;
  nowMs: number;
}): Pick<SearchCandidate, "bm25" | "lexicalScore" | "recencyBoost" | "score"> {
  const bm25 = params.row.bm25_score ?? 0;
  const lexicalScore = 1 / (20 + params.rank);
  const ageMs = Math.max(0, params.nowMs - params.row.ts);
  const recencyBase =
    params.row.source === "conversation" ? 0.35 : params.row.source === "heartbeat" ? 0.1 : 0.04;
  const decayWindowMs = params.row.source === "conversation" ? 7 * 86_400_000 : 30 * 86_400_000;
  const recencyBoost = recencyBase * Math.exp(-ageMs / decayWindowMs);
  return {
    bm25,
    lexicalScore,
    recencyBoost,
    score: lexicalScore + recencyBoost,
  };
}

function compareCandidates(
  left: SearchCandidate,
  right: SearchCandidate,
  orderBy: DiscoveryOrderBy,
  direction: DiscoveryDirection,
): number {
  const dir = direction === "asc" ? 1 : -1;
  if (orderBy === "time") {
    if (left.row.ts !== right.row.ts) return (left.row.ts - right.row.ts) * dir;
    if (left.score !== right.score) return (left.score - right.score) * dir;
  } else {
    if (left.score !== right.score) return (left.score - right.score) * dir;
    if (left.row.ts !== right.row.ts) return (left.row.ts - right.row.ts) * -dir;
  }
  return left.row.doc_key.localeCompare(right.row.doc_key);
}

function compareGroups(
  left: DiscoveryResultGroup,
  right: DiscoveryResultGroup,
  orderBy: DiscoveryOrderBy,
  direction: DiscoveryDirection,
): number {
  const dir = direction === "asc" ? 1 : -1;
  if (orderBy === "time") {
    const leftTs = left.ts ?? 0;
    const rightTs = right.ts ?? 0;
    if (leftTs !== rightTs) return (leftTs - rightTs) * dir;
    if (left.score !== right.score) return (left.score - right.score) * dir;
  } else {
    if (left.score !== right.score) return (left.score - right.score) * dir;
    const leftTs = left.ts ?? 0;
    const rightTs = right.ts ?? 0;
    if (leftTs !== rightTs) return (leftTs - rightTs) * -dir;
  }
  return left.key.localeCompare(right.key);
}

function hasIndexedSurfaceCoverage(record: {
  surfaceRefs: readonly { platform: AdapterPlatform }[];
}): boolean {
  return record.surfaceRefs.some((ref) => ref.platform === "discord");
}

function mergeLineWindows(
  windows: Array<{
    startLine: number;
    endLine: number;
    matchStartLine: number;
    matchEndLine: number;
  }>,
  lines: string[],
): DiscoveryFileRangeEntry[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: Array<{
    startLine: number;
    endLine: number;
    matchRanges: Array<{ startLine: number; endLine: number }>;
  }> = [];

  for (const window of sorted) {
    const prev = merged.at(-1);
    if (!prev || window.startLine > prev.endLine + 1) {
      merged.push({
        startLine: window.startLine,
        endLine: window.endLine,
        matchRanges: [{ startLine: window.matchStartLine, endLine: window.matchEndLine }],
      });
      continue;
    }

    prev.endLine = Math.max(prev.endLine, window.endLine);
    prev.matchRanges.push({ startLine: window.matchStartLine, endLine: window.matchEndLine });
  }

  return merged.map((window) => ({
    kind: "file-range",
    startLine: window.startLine,
    endLine: window.endLine,
    text: lines.slice(window.startLine - 1, window.endLine).join("\n"),
    ts: 0,
    score: 0,
    bm25: 0,
    recencyBoost: 0,
    matchRanges: window.matchRanges,
  }));
}

class SqliteDiscoveryStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS discovery_documents (
        doc_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        platform TEXT,
        session_id TEXT,
        message_id TEXT,
        request_id TEXT,
        file_path TEXT,
        title TEXT,
        author_id TEXT,
        author_name TEXT,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discovery_documents_source_ts
      ON discovery_documents(source, ts DESC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discovery_documents_session_ts
      ON discovery_documents(platform, session_id, ts ASC, doc_key ASC);
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_discovery_documents_file_range
      ON discovery_documents(file_path, start_line ASC, end_line ASC, doc_key ASC);
    `);

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS discovery_documents_fts
      USING fts5(
        title,
        text,
        content='discovery_documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discovery_documents_ai
      AFTER INSERT ON discovery_documents
      BEGIN
        INSERT INTO discovery_documents_fts(rowid, title, text)
        VALUES (new.rowid, coalesce(new.title, ''), new.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discovery_documents_ad
      AFTER DELETE ON discovery_documents
      BEGIN
        INSERT INTO discovery_documents_fts(discovery_documents_fts, rowid, title, text)
        VALUES ('delete', old.rowid, coalesce(old.title, ''), old.text);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discovery_documents_au
      AFTER UPDATE ON discovery_documents
      BEGIN
        INSERT INTO discovery_documents_fts(discovery_documents_fts, rowid, title, text)
        VALUES ('delete', old.rowid, coalesce(old.title, ''), old.text);
        INSERT INTO discovery_documents_fts(rowid, title, text)
        VALUES (new.rowid, coalesce(new.title, ''), new.text);
      END;
    `);
  }

  upsertDocuments(documents: readonly IndexedDocument[]): void {
    const tx = this.db.transaction((docs: readonly IndexedDocument[]) => {
      for (const doc of docs) {
        this.db.run(
          `
          INSERT INTO discovery_documents (
            doc_key,
            source,
            kind,
            platform,
            session_id,
            message_id,
            request_id,
            file_path,
            title,
            author_id,
            author_name,
            text,
            ts,
            updated_ts,
            start_line,
            end_line,
            deleted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(doc_key) DO UPDATE SET
            source=excluded.source,
            kind=excluded.kind,
            platform=excluded.platform,
            session_id=excluded.session_id,
            message_id=excluded.message_id,
            request_id=excluded.request_id,
            file_path=excluded.file_path,
            title=excluded.title,
            author_id=excluded.author_id,
            author_name=excluded.author_name,
            text=excluded.text,
            ts=excluded.ts,
            updated_ts=excluded.updated_ts,
            start_line=excluded.start_line,
            end_line=excluded.end_line,
            deleted=excluded.deleted
          `,
          [
            doc.docKey,
            doc.source,
            doc.kind,
            doc.platform ?? null,
            doc.sessionId ?? null,
            doc.messageId ?? null,
            doc.requestId ?? null,
            doc.filePath ?? null,
            doc.title ?? null,
            doc.authorId ?? null,
            doc.authorName ?? null,
            doc.text,
            doc.ts,
            doc.updatedTs,
            doc.startLine ?? null,
            doc.endLine ?? null,
            doc.deleted ? 1 : 0,
          ],
        );
      }
    });

    tx(documents);
  }

  replaceDocumentsWhere(params: {
    source?: DiscoverySource;
    kind?: IndexedDocument["kind"];
    documents: readonly IndexedDocument[];
  }): void {
    const clauses: string[] = [];
    const values: string[] = [];
    if (params.source) {
      clauses.push("source = ?");
      values.push(params.source);
    }
    if (params.kind) {
      clauses.push("kind = ?");
      values.push(params.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    const tx = this.db.transaction((docs: readonly IndexedDocument[]) => {
      this.db.run(`DELETE FROM discovery_documents${where}`, values);
      this.upsertDocuments(docs);
    });

    tx(params.documents);
  }

  searchDocuments(params: {
    ftsQuery: string;
    sources: readonly DiscoverySource[];
    limit: number;
    window?: TimeWindow;
  }): IndexedDocumentRow[] {
    const sourcePlaceholders = params.sources.map(() => "?").join(", ");
    const values: Array<string | number> = [params.ftsQuery, ...params.sources];
    const timeClause = params.window === undefined ? "" : " AND d.ts >= ? AND d.ts <= ?";
    if (params.window) {
      values.push(params.window.startTs, params.window.endTs);
    }
    values.push(params.limit);

    return this.db
      .query(
        `
        SELECT
          d.rowid,
          d.doc_key,
          d.source,
          d.kind,
          d.platform,
          d.session_id,
          d.message_id,
          d.request_id,
          d.file_path,
          d.title,
          d.author_id,
          d.author_name,
          d.text,
          d.ts,
          d.updated_ts,
          d.start_line,
          d.end_line,
          bm25(discovery_documents_fts) AS bm25_score
        FROM discovery_documents_fts
        JOIN discovery_documents d ON d.rowid = discovery_documents_fts.rowid
        WHERE discovery_documents_fts MATCH ?
          AND d.deleted = 0
          AND d.source IN (${sourcePlaceholders})
          ${timeClause}
        ORDER BY bm25_score ASC, d.ts DESC, d.doc_key ASC
        LIMIT ?
        `,
      )
      .all(...values) as IndexedDocumentRow[];
  }

  listConversationBySession(params: {
    platform: AdapterPlatform;
    sessionId: string;
  }): IndexedDocumentRow[] {
    return this.db
      .query(
        `
        SELECT
          rowid,
          doc_key,
          source,
          kind,
          platform,
          session_id,
          message_id,
          request_id,
          file_path,
          title,
          author_id,
          author_name,
          text,
          ts,
          updated_ts,
          start_line,
          end_line
        FROM discovery_documents
        WHERE source = 'conversation'
          AND deleted = 0
          AND platform = ?
          AND session_id = ?
        ORDER BY ts ASC, doc_key ASC
        `,
      )
      .all(params.platform, params.sessionId) as IndexedDocumentRow[];
  }
}

export class DiscoveryService {
  private readonly store: SqliteDiscoveryStore;
  private lastDiscordUpdatedTs: number | undefined;

  constructor(
    private readonly params: {
      dbPath: string;
      dataDir: string;
      discordSearchStore?: DiscordSearchStore;
      transcriptStore?: TranscriptStore;
      getConfig?: () => Promise<CoreConfig>;
    },
  ) {
    this.store = new SqliteDiscoveryStore(params.dbPath);
  }

  close(): void {
    this.store.close();
  }

  private async getConfig(): Promise<CoreConfig | null> {
    return (await this.params.getConfig?.()) ?? null;
  }

  private async syncConversationFromDiscord(): Promise<void> {
    if (!this.params.discordSearchStore) return;
    const rows = this.params.discordSearchStore.listMessagesForDiscovery(this.lastDiscordUpdatedTs);
    if (rows.length === 0) return;

    const documents: IndexedDocument[] = rows.map((row) => ({
      docKey: `conversation:surface:${row.ref.platform}:${row.ref.channelId}:${row.ref.messageId}`,
      source: "conversation",
      kind: "surface_message",
      platform: row.ref.platform,
      sessionId: row.ref.channelId,
      messageId: row.ref.messageId,
      text: row.text,
      ts: row.ts,
      updatedTs: row.updatedTs,
      authorId: row.userId,
      authorName: row.userName,
      deleted: row.deleted,
    }));

    this.store.upsertDocuments(documents);
    this.lastDiscordUpdatedTs = rows.reduce(
      (max, row) => Math.max(max, row.updatedTs),
      this.lastDiscordUpdatedTs ?? 0,
    );
  }

  private async syncConversationFromTranscripts(): Promise<void> {
    const records = this.params.transcriptStore?.listDiscoveryRecords?.() ?? [];
    const documents: IndexedDocument[] = [];

    for (const record of records) {
      const text = record.finalText?.trim();
      if (!text) continue;
      if (hasIndexedSurfaceCoverage(record)) continue;
      documents.push({
        docKey: `conversation:transcript:${record.requestClient}:${record.sessionId}:${record.requestId}`,
        source: "conversation",
        kind: "transcript_request",
        platform: record.requestClient,
        sessionId: record.sessionId,
        requestId: record.requestId,
        text,
        ts: record.updatedTs,
        updatedTs: record.updatedTs,
      });
    }

    this.store.replaceDocumentsWhere({
      source: "conversation",
      kind: "transcript_request",
      documents,
    });
  }

  private async buildPromptDocuments(): Promise<IndexedDocument[]> {
    await ensurePromptWorkspace({ dataDir: this.params.dataDir });
    const promptDir = resolvePromptDir({ dataDir: this.params.dataDir });
    const documents: IndexedDocument[] = [];

    for (const fileName of CORE_PROMPT_FILES) {
      const filePath = path.join(promptDir, fileName);
      const stat = await Bun.file(filePath).stat();
      const raw = await Bun.file(filePath).text();
      const text = stripFrontmatter(raw).trim();
      const blocks = extractFileBlocks({
        source: "prompt",
        filePath,
        title: path.relative(promptDir, filePath) || path.basename(filePath),
        text,
        ts: Math.floor(stat.mtimeMs),
      });
      for (const block of blocks) {
        documents.push({
          docKey: block.docKey,
          source: "prompt",
          kind: "file_block",
          filePath: block.filePath,
          title: block.title,
          text: block.text,
          ts: block.ts,
          updatedTs: block.ts,
          startLine: block.startLine,
          endLine: block.endLine,
        });
      }
    }

    return documents;
  }

  private async buildHeartbeatDocuments(): Promise<IndexedDocument[]> {
    await ensurePromptWorkspace({ dataDir: this.params.dataDir });
    const paths = resolveHeartbeatPromptPaths({ dataDir: this.params.dataDir });
    const filePaths = [
      paths.heartbeatFilePath,
      ...(await listTextFilesRecursive(paths.heartbeatDir)),
    ];
    const uniqueFilePaths = [...new Set(filePaths)].sort();
    const documents: IndexedDocument[] = [];

    for (const filePath of uniqueFilePaths) {
      const stat = await Bun.file(filePath).stat();
      const raw = await Bun.file(filePath).text();
      const text = filePath === paths.heartbeatFilePath ? stripFrontmatter(raw).trim() : raw.trim();
      if (!text) continue;
      const blocks = extractFileBlocks({
        source: "heartbeat",
        filePath,
        title: path.relative(paths.promptDir, filePath) || path.basename(filePath),
        text,
        ts: Math.floor(stat.mtimeMs),
      });
      for (const block of blocks) {
        documents.push({
          docKey: block.docKey,
          source: "heartbeat",
          kind: "file_block",
          filePath: block.filePath,
          title: block.title,
          text: block.text,
          ts: block.ts,
          updatedTs: block.ts,
          startLine: block.startLine,
          endLine: block.endLine,
        });
      }
    }

    return documents;
  }

  private async syncFileSources(): Promise<void> {
    const [promptDocuments, heartbeatDocuments] = await Promise.all([
      this.buildPromptDocuments(),
      this.buildHeartbeatDocuments(),
    ]);

    this.store.replaceDocumentsWhere({ source: "prompt", documents: promptDocuments });
    this.store.replaceDocumentsWhere({ source: "heartbeat", documents: heartbeatDocuments });
  }

  private async syncAllSources(): Promise<void> {
    await this.syncConversationFromDiscord();
    await this.syncConversationFromTranscripts();
    await this.syncFileSources();
  }

  private async buildOriginGroups(params: {
    candidates: readonly SearchCandidate[];
    surrounding: number;
    cfg: CoreConfig | null;
  }): Promise<DiscoveryResultGroup[]> {
    const byOrigin = new Map<string, SearchCandidate[]>();
    for (const candidate of params.candidates) {
      const key =
        candidate.row.source === "conversation"
          ? `origin:session:${candidate.row.platform ?? "unknown"}:${candidate.row.session_id ?? "unknown"}`
          : `origin:file:${candidate.row.file_path ?? candidate.row.doc_key}`;
      const arr = byOrigin.get(key);
      if (arr) arr.push(candidate);
      else byOrigin.set(key, [candidate]);
    }

    const groups: DiscoveryResultGroup[] = [];
    const sessionCache = new Map<string, IndexedDocumentRow[]>();
    const fileLinesCache = new Map<string, string[]>();

    for (const [key, matches] of byOrigin) {
      const top = matches[0]!;
      const origin = buildOriginFromRow(top.row, params.cfg);
      if (top.row.source === "conversation" && top.row.platform && top.row.session_id) {
        const sessionKey = `${top.row.platform}:${top.row.session_id}`;
        let sessionRows = sessionCache.get(sessionKey);
        if (!sessionRows) {
          sessionRows = this.store.listConversationBySession({
            platform: top.row.platform,
            sessionId: top.row.session_id,
          });
          sessionCache.set(sessionKey, sessionRows);
        }

        const rowIndexByKey = new Map(
          sessionRows.map((row, index) => [row.doc_key, index] as const),
        );
        const included = new Map<string, DiscoveryConversationEntry>();

        for (const match of matches) {
          const centerIndex = rowIndexByKey.get(match.row.doc_key);
          if (centerIndex === undefined) continue;
          const start = Math.max(0, centerIndex - params.surrounding);
          const end = Math.min(sessionRows.length - 1, centerIndex + params.surrounding);
          for (let idx = start; idx <= end; idx += 1) {
            const row = sessionRows[idx]!;
            const existing = included.get(row.doc_key);
            const isMatched = row.doc_key === match.row.doc_key;
            if (existing) {
              existing.matched = existing.matched || isMatched;
              continue;
            }
            const candidateForRow = matches.find((item) => item.row.doc_key === row.doc_key);
            included.set(row.doc_key, {
              kind: "message",
              matched: isMatched,
              text: row.text,
              ts: row.ts,
              score: candidateForRow?.score ?? 0,
              bm25: candidateForRow?.bm25 ?? 0,
              recencyBoost: candidateForRow?.recencyBoost ?? 0,
              messageId: row.message_id ?? undefined,
              requestId: row.request_id ?? undefined,
              author:
                row.author_id === null
                  ? undefined
                  : {
                      userId: row.author_id,
                      userName: row.author_name ?? undefined,
                    },
            });
          }
        }

        groups.push({
          key,
          source: "conversation",
          score: Math.max(...matches.map((match) => match.score)),
          ts: Math.max(...matches.map((match) => match.row.ts)),
          origin,
          entries: [...included.values()].sort((a, b) => a.ts - b.ts),
        });
        continue;
      }

      if (top.row.file_path) {
        let lines = fileLinesCache.get(top.row.file_path);
        if (!lines) {
          const raw = await Bun.file(top.row.file_path).text();
          lines = splitLines(
            top.row.source === "prompt" || top.row.file_path.endsWith("HEARTBEAT.md")
              ? stripFrontmatter(raw)
              : raw,
          );
          fileLinesCache.set(top.row.file_path, lines);
        }

        const windows = matches.flatMap((match) => {
          const startLine = Math.max(1, (match.row.start_line ?? 1) - params.surrounding);
          const endLine = Math.min(
            lines.length,
            (match.row.end_line ?? lines.length) + params.surrounding,
          );
          return {
            startLine,
            endLine,
            matchStartLine: match.row.start_line ?? startLine,
            matchEndLine: match.row.end_line ?? endLine,
          };
        });

        const entries = mergeLineWindows(windows, lines).map((entry) => ({
          ...entry,
          ts: top.row.ts,
          score: Math.max(...matches.map((match) => match.score)),
          bm25: matches[0]?.bm25 ?? 0,
          recencyBoost: matches[0]?.recencyBoost ?? 0,
        }));

        groups.push({
          key,
          source: top.row.source,
          score: Math.max(...matches.map((match) => match.score)),
          ts: Math.max(...matches.map((match) => match.row.ts)),
          origin,
          entries,
        });
      }
    }

    return groups;
  }

  private buildSourceGroups(params: {
    candidates: readonly SearchCandidate[];
    cfg: CoreConfig | null;
  }): DiscoveryResultGroup[] {
    const bySource = new Map<DiscoverySource, SearchCandidate[]>();
    for (const candidate of params.candidates) {
      const arr = bySource.get(candidate.row.source);
      if (arr) arr.push(candidate);
      else bySource.set(candidate.row.source, [candidate]);
    }

    const groups: DiscoveryResultGroup[] = [];
    for (const [source, candidates] of bySource) {
      const entries: DiscoveryResultEntry[] = candidates.map((candidate) => {
        const origin = buildOriginFromRow(candidate.row, params.cfg);
        if (candidate.row.source === "conversation") {
          return {
            kind: "message",
            matched: true,
            text: candidate.row.text,
            ts: candidate.row.ts,
            score: candidate.score,
            bm25: candidate.bm25,
            recencyBoost: candidate.recencyBoost,
            messageId: candidate.row.message_id ?? undefined,
            requestId: candidate.row.request_id ?? undefined,
            author:
              candidate.row.author_id === null
                ? undefined
                : {
                    userId: candidate.row.author_id,
                    userName: candidate.row.author_name ?? undefined,
                  },
            origin,
          } satisfies DiscoveryConversationEntry;
        }

        return {
          kind: "file-range",
          startLine: candidate.row.start_line ?? 1,
          endLine: candidate.row.end_line ?? 1,
          text: candidate.row.text,
          ts: candidate.row.ts,
          score: candidate.score,
          bm25: candidate.bm25,
          recencyBoost: candidate.recencyBoost,
          matchRanges: [
            {
              startLine: candidate.row.start_line ?? 1,
              endLine: candidate.row.end_line ?? 1,
            },
          ],
          origin,
        } satisfies DiscoveryFileRangeEntry;
      });

      groups.push({
        key: `source:${source}`,
        source,
        score: Math.max(...candidates.map((candidate) => candidate.score)),
        ts: Math.max(...candidates.map((candidate) => candidate.row.ts)),
        entries,
      });
    }
    return groups;
  }

  async search(input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    await this.syncAllSources();

    const ftsQuery = normalizeFtsQuery(input.query);
    if (!ftsQuery) {
      throw new Error("query must not be empty");
    }

    const sources = [
      ...new Set(input.sources ?? (["conversation", "prompt", "heartbeat"] as const)),
    ];
    const orderBy = input.orderBy ?? "relevance";
    const direction = input.direction ?? "desc";
    const groupBy = input.groupBy ?? "origin";
    const surrounding = clampNonNegativeInt(input.surrounding, 2, DISCOVERY_SURROUNDING_MAX);
    const limit = clampPositiveInt(input.limit, 10, DISCOVERY_LIMIT_MAX);
    const nowMs = Date.now();
    const window = resolveTimeWindow(input, nowMs);
    const candidateLimit = Math.min(500, Math.max(limit * 8, 50));
    const cfg = await this.getConfig();

    const rows = this.store.searchDocuments({
      ftsQuery,
      sources,
      limit: candidateLimit,
      window,
    });

    const candidates = rows
      .map((row, index) => {
        const scoreParts = buildCandidateScore({ row, rank: index + 1, nowMs });
        return {
          row,
          ...scoreParts,
        } satisfies SearchCandidate;
      })
      .sort((left, right) => compareCandidates(left, right, orderBy, direction));

    const groups =
      groupBy === "origin"
        ? await this.buildOriginGroups({ candidates, surrounding, cfg })
        : groupBy === "source"
          ? this.buildSourceGroups({ candidates, cfg })
          : candidates.slice(0, limit).map((candidate) => ({
              key: `hit:${candidate.row.doc_key}`,
              source: candidate.row.source,
              score: candidate.score,
              ts: candidate.row.ts,
              origin: buildOriginFromRow(candidate.row, cfg),
              entries:
                candidate.row.source === "conversation"
                  ? [
                      {
                        kind: "message",
                        matched: true,
                        text: candidate.row.text,
                        ts: candidate.row.ts,
                        score: candidate.score,
                        bm25: candidate.bm25,
                        recencyBoost: candidate.recencyBoost,
                        messageId: candidate.row.message_id ?? undefined,
                        requestId: candidate.row.request_id ?? undefined,
                        author:
                          candidate.row.author_id === null
                            ? undefined
                            : {
                                userId: candidate.row.author_id,
                                userName: candidate.row.author_name ?? undefined,
                              },
                      } satisfies DiscoveryConversationEntry,
                    ]
                  : [
                      {
                        kind: "file-range",
                        startLine: candidate.row.start_line ?? 1,
                        endLine: candidate.row.end_line ?? 1,
                        text: candidate.row.text,
                        ts: candidate.row.ts,
                        score: candidate.score,
                        bm25: candidate.bm25,
                        recencyBoost: candidate.recencyBoost,
                        matchRanges: [
                          {
                            startLine: candidate.row.start_line ?? 1,
                            endLine: candidate.row.end_line ?? 1,
                          },
                        ],
                      } satisfies DiscoveryFileRangeEntry,
                    ],
            }));

    const limitedGroups =
      groupBy === "none"
        ? groups
        : [...groups]
            .sort((left, right) => compareGroups(left, right, orderBy, direction))
            .slice(0, limit);

    return {
      meta: {
        query: input.query,
        sources,
        orderBy,
        direction,
        groupBy,
        surrounding,
        limit,
        window,
      },
      groups: limitedGroups,
    };
  }
}
