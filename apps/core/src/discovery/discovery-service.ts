import { captureError } from "../shared/error-capture.js";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  CORE_PROMPT_FILES,
  ensurePromptWorkspace,
  getDiscordUserAliasValue,
  isPanic,
  opaqueErrorCause,
  resolveHeartbeatPromptPaths,
  resolvePromptDir,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import type { DiscordSearchStore } from "../surface/store/discord-search-store";
import type { TranscriptStore } from "../transcript/transcript-store";
import { bestEffortAliasForDiscordChannelId } from "../surface/discord/discord-tool-targets";
import { rethrowPanic } from "../mcp/error-format";

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
  platform?: AdapterPlatform;
  sessionId?: string;
  authorId?: string;
  orderBy?: DiscoveryOrderBy;
  direction?: DiscoveryDirection;
  groupBy?: DiscoveryGroupBy;
  surrounding?: number;
  offsetTime?: string | number;
  lookbackTime?: string | number;
  limit?: number;
  verbose?: boolean;
};

export type DiscoveryConversationEntry = {
  kind: "message";
  matched: boolean;
  text: string;
  time?: string;
  ts?: number;
  score?: number;
  bm25?: number;
  recencyBoost?: number;
  messageId?: string;
  requestId?: string;
  author?: string;
  origin?: DiscoveryOrigin;
};

export type DiscoveryFileRangeEntry = {
  kind: "file-range";
  startLine: number;
  endLine: number;
  text: string;
  time?: string;
  ts?: number;
  score?: number;
  bm25?: number;
  recencyBoost?: number;
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
  score?: number;
  time?: string;
  ts?: number;
  origin?: DiscoveryOrigin;
  entries: DiscoveryResultEntry[][];
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
    verbose: boolean;
    platform?: AdapterPlatform;
    sessionId?: string;
    authorId?: string;
    window?: {
      startTime: string;
      endTime: string;
      startTs?: number;
      endTs?: number;
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

export class DiscoverySearchInputError extends TaggedError("DiscoverySearchInputError")<{
  readonly field: "query" | "offsetTime" | "lookbackTime";
  readonly message: string;
}> {}

export class DiscoverySearchOperationError extends TaggedError("DiscoverySearchOperationError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DiscoveryCloseError extends TaggedError("DiscoveryCloseError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DiscoverySearchError = DiscoverySearchInputError | DiscoverySearchOperationError;

type DiscoveryTimeInputError = DiscoverySearchInputError;

function adaptDiscoverySearchInputResultToHost<T>(
  result: ResultType<T, DiscoverySearchInputError>,
): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

function adaptDiscoverySearchResultToHost<T>(result: ResultType<T, DiscoverySearchError>): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

function adaptDiscoveryCloseResultToHost(result: ResultType<void, DiscoveryCloseError>): void {
  result.match({
    ok: () => () => undefined,
    err: (error) => () => {
      throw error;
    },
  })();
}

const RELATIVE_DURATION_RE = /^(?:\d+(?:ms|s|m|h|d|w))+$/u;
const RELATIVE_DURATION_PART_RE = /(\d+)(ms|s|m|h|d|w)/gu;
const DIGITS_RE = /^\d+$/u;
const DISCOVERY_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DISCOVERY_TIME_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DISCOVERY_RECENCY_BASE = {
  conversation: 0.35,
  prompt: 0.04,
  heartbeat: 0.1,
} satisfies Record<DiscoverySource, number>;

const DISCOVERY_RECENCY_DECAY_MS = {
  conversation: 7 * 86_400_000,
  prompt: 30 * 86_400_000,
  heartbeat: 30 * 86_400_000,
} satisfies Record<DiscoverySource, number>;

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

function formatDiscoveryTime(ts: number | undefined): string | undefined {
  if (ts === undefined || !Number.isFinite(ts) || ts < 0) return undefined;
  const date = new Date(ts);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    ? DISCOVERY_TIME_FORMATTER.format(date)
    : DISCOVERY_TIME_WITH_YEAR_FORMATTER.format(date);
}

function buildDiscordUserAliasById(cfg: CoreConfig | null): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg?.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const resolved = getDiscordUserAliasValue(rec);
    if (!resolved) continue;
    if (!out.has(resolved.discordId)) {
      out.set(resolved.discordId, alias);
    }
  }

  return out;
}

function formatDiscoveryAuthor(params: {
  platform: AdapterPlatform | null;
  userId: string | null;
  userName: string | null;
  discordUserAliasById: ReadonlyMap<string, string>;
}): string | undefined {
  if (!params.userId) return undefined;
  const alias =
    params.platform === "discord" ? params.discordUserAliasById.get(params.userId) : undefined;
  const userName = params.userName?.trim();
  if (alias && userName) return `${alias} (${userName}; ${params.userId})`;
  if (alias) return `${alias} (${params.userId})`;
  if (userName) return `${userName} (${params.userId})`;
  return params.userId;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const idx = raw.indexOf("\n---");
  if (idx === -1) return raw;
  return raw.slice(idx + "\n---".length).replace(/^\s+/u, "");
}

function parseRelativeDurationMs(
  rawInput: string,
  fieldName: "offsetTime" | "lookbackTime",
): ResultType<number, DiscoveryTimeInputError> {
  const raw = rawInput.trim();
  if (!RELATIVE_DURATION_RE.test(raw)) {
    return Result.err(
      new DiscoverySearchInputError({
        field: fieldName,
        message: `${fieldName} must be a positive relative duration like '30m', '24h', or '7d'.`,
      }),
    );
  }

  let total = 0;
  let matched = 0;
  for (const match of raw.matchAll(RELATIVE_DURATION_PART_RE)) {
    matched += match[0].length;
    const amount = Number(match[1]);
    const unit = match[2];
    let factor: number;
    if (unit === "ms") factor = 1;
    else if (unit === "s") factor = 1000;
    else if (unit === "m") factor = 60_000;
    else if (unit === "h") factor = 3_600_000;
    else if (unit === "d") factor = 86_400_000;
    else factor = 604_800_000;
    total += amount * factor;
  }

  if (matched !== raw.length || total <= 0) {
    return Result.err(
      new DiscoverySearchInputError({
        field: fieldName,
        message: `${fieldName} must be a positive relative duration like '30m', '24h', or '7d'.`,
      }),
    );
  }

  return Result.ok(total);
}

function parseEpochMs(value: number): ResultType<number, DiscoveryTimeInputError> {
  if (!Number.isFinite(value) || value < 0) {
    return Result.err(
      new DiscoverySearchInputError({
        field: "offsetTime",
        message: "numeric time values must be positive",
      }),
    );
  }
  if (value === 0) return Result.ok(0);
  return Result.ok(value < 1_000_000_000_000 ? value * 1000 : value);
}

function resolveOffsetTimeMs(
  input: string | number | undefined,
  nowMs: number,
): ResultType<number, DiscoveryTimeInputError> {
  if (input === undefined) return Result.ok(nowMs);
  if (typeof input === "number") {
    return parseEpochMs(input).map((value) => (value === 0 ? nowMs : value));
  }

  const raw = input.trim();
  if (raw === "0") return Result.ok(nowMs);
  if (DIGITS_RE.test(raw)) {
    return resolveOffsetTimeMs(Number(raw), nowMs);
  }
  if (RELATIVE_DURATION_RE.test(raw)) {
    return parseRelativeDurationMs(raw, "offsetTime").map((duration) => nowMs - duration);
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Result.err(
      new DiscoverySearchInputError({
        field: "offsetTime",
        message:
          "offsetTime must be an ISO-8601 timestamp, a unix epoch, 0, or a positive relative duration.",
      }),
    );
  }
  return Result.ok(parsed);
}

function resolveLookbackDurationMs(
  input: string | number | undefined,
): ResultType<number | undefined, DiscoveryTimeInputError> {
  if (input === undefined) return Result.ok(undefined);
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      return Result.err(
        new DiscoverySearchInputError({
          field: "lookbackTime",
          message: "lookbackTime must be a positive duration.",
        }),
      );
    }
    return Result.ok(Math.floor(input));
  }

  const raw = input.trim();
  if (DIGITS_RE.test(raw)) {
    return resolveLookbackDurationMs(Number(raw));
  }

  return parseRelativeDurationMs(raw, "lookbackTime");
}

export function resolveTimeWindow(
  input: DiscoverySearchInput,
  nowMs: number,
): ResultType<TimeWindow | undefined, DiscoveryTimeInputError> {
  return resolveLookbackDurationMs(input.lookbackTime).andThen((lookbackMs) => {
    if (lookbackMs === undefined) {
      if (input.offsetTime !== undefined) {
        return Result.err(
          new DiscoverySearchInputError({
            field: "offsetTime",
            message: "offsetTime requires lookbackTime.",
          }),
        );
      }
      return Result.ok(undefined);
    }

    return resolveOffsetTimeMs(input.offsetTime, nowMs).map((endTs) => ({
      startTs: endTs - lookbackMs,
      endTs,
    }));
  });
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
  const recencyBase = DISCOVERY_RECENCY_BASE[params.row.source];
  const decayWindowMs = DISCOVERY_RECENCY_DECAY_MS[params.row.source];
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

export function compareGroups(
  left: DiscoveryResultGroup,
  right: DiscoveryResultGroup,
  orderBy: DiscoveryOrderBy,
  direction: DiscoveryDirection,
): number {
  const leftScore = left.score ?? 0;
  const rightScore = right.score ?? 0;
  const dir = direction === "asc" ? 1 : -1;
  if (orderBy === "time") {
    const leftTs = left.ts ?? 0;
    const rightTs = right.ts ?? 0;
    if (leftTs !== rightTs) return (leftTs - rightTs) * dir;
    if (leftScore !== rightScore) return (leftScore - rightScore) * dir;
  } else {
    if (leftScore !== rightScore) return (leftScore - rightScore) * dir;
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
): Array<{
  startLine: number;
  endLine: number;
  matchRanges: Array<{ startLine: number; endLine: number }>;
}> {
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

  return merged;
}

function mergeIndexWindows(
  windows: ReadonlyArray<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];

  for (const window of sorted) {
    const prev = merged.at(-1);
    if (!prev || window.start > prev.end + 1) {
      merged.push({ ...window });
      continue;
    }

    prev.end = Math.max(prev.end, window.end);
  }

  return merged;
}

function buildConversationEntry(params: {
  row: IndexedDocumentRow;
  matched: boolean;
  candidate?: SearchCandidate;
  origin?: DiscoveryOrigin;
  discordUserAliasById: ReadonlyMap<string, string>;
}): DiscoveryConversationEntry {
  return {
    kind: "message",
    matched: params.matched,
    text: params.row.text,
    time: formatDiscoveryTime(params.row.ts),
    ts: params.row.ts,
    score: params.candidate?.score ?? 0,
    bm25: params.candidate?.bm25 ?? 0,
    recencyBoost: params.candidate?.recencyBoost ?? 0,
    messageId: params.row.message_id ?? undefined,
    requestId: params.row.request_id ?? undefined,
    author: formatDiscoveryAuthor({
      platform: params.row.platform,
      userId: params.row.author_id,
      userName: params.row.author_name,
      discordUserAliasById: params.discordUserAliasById,
    }),
    origin: params.origin,
  };
}

function buildFileRangeEntry(params: {
  row: Pick<IndexedDocumentRow, "ts">;
  startLine: number;
  endLine: number;
  text: string;
  matchRanges: Array<{ startLine: number; endLine: number }>;
  candidate?: SearchCandidate;
  origin?: DiscoveryOrigin;
}): DiscoveryFileRangeEntry {
  return {
    kind: "file-range",
    startLine: params.startLine,
    endLine: params.endLine,
    text: params.text,
    time: formatDiscoveryTime(params.row.ts),
    ts: params.row.ts,
    score: params.candidate?.score ?? 0,
    bm25: params.candidate?.bm25 ?? 0,
    recencyBoost: params.candidate?.recencyBoost ?? 0,
    matchRanges: params.matchRanges,
    origin: params.origin,
  };
}

function stripVerboseEntry(entry: DiscoveryResultEntry, verbose: boolean): DiscoveryResultEntry {
  if (verbose) return entry;
  const { ts: _ts, score: _score, bm25: _bm25, recencyBoost: _recencyBoost, ...rest } = entry;
  return rest;
}

export function stripVerboseGroup(
  group: DiscoveryResultGroup,
  verbose: boolean,
): DiscoveryResultGroup {
  if (verbose) return group;
  const { ts: _ts, score: _score, ...rest } = group;
  return {
    ...rest,
    entries: rest.entries.map((window) => window.map((entry) => stripVerboseEntry(entry, verbose))),
  };
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
      CREATE INDEX IF NOT EXISTS idx_discovery_documents_platform_session_author_ts
      ON discovery_documents(platform, session_id, author_id, ts DESC);
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

    const existingFtsUpdateTrigger = this.db
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get("discovery_documents_au");
    const hasContentSensitiveFtsUpdateTrigger =
      existingFtsUpdateTrigger?.sql?.includes("AFTER UPDATE OF title, text") === true &&
      existingFtsUpdateTrigger.sql?.includes(
        "WHEN old.title IS NOT new.title OR old.text IS NOT new.text",
      ) === true;
    if (!hasContentSensitiveFtsUpdateTrigger) {
      this.db.run("DROP TRIGGER IF EXISTS discovery_documents_au");
    }

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS discovery_documents_au
      AFTER UPDATE OF title, text ON discovery_documents
      WHEN old.title IS NOT new.title OR old.text IS NOT new.text
      BEGIN
        INSERT INTO discovery_documents_fts(discovery_documents_fts, rowid, title, text)
        VALUES ('delete', old.rowid, coalesce(old.title, ''), old.text);
        INSERT INTO discovery_documents_fts(rowid, title, text)
        VALUES (new.rowid, coalesce(new.title, ''), new.text);
      END;
    `);
  }

  private upsertDocumentsInTransaction(documents: readonly IndexedDocument[]): void {
    const upsert = this.db.prepare(
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
          WHERE
            discovery_documents.source IS NOT excluded.source OR
            discovery_documents.kind IS NOT excluded.kind OR
            discovery_documents.platform IS NOT excluded.platform OR
            discovery_documents.session_id IS NOT excluded.session_id OR
            discovery_documents.message_id IS NOT excluded.message_id OR
            discovery_documents.request_id IS NOT excluded.request_id OR
            discovery_documents.file_path IS NOT excluded.file_path OR
            discovery_documents.title IS NOT excluded.title OR
            discovery_documents.author_id IS NOT excluded.author_id OR
            discovery_documents.author_name IS NOT excluded.author_name OR
            discovery_documents.text IS NOT excluded.text OR
            discovery_documents.ts IS NOT excluded.ts OR
            discovery_documents.updated_ts IS NOT excluded.updated_ts OR
            discovery_documents.start_line IS NOT excluded.start_line OR
            discovery_documents.end_line IS NOT excluded.end_line OR
            discovery_documents.deleted IS NOT excluded.deleted
          `,
    );
    for (const doc of documents) {
      upsert.run(
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
      );
    }
  }

  upsertDocuments(documents: readonly IndexedDocument[]): void {
    const tx = this.db.transaction((docs: readonly IndexedDocument[]) => {
      this.upsertDocumentsInTransaction(docs);
    });

    tx(documents);
  }

  replaceDocumentsWhere(params: {
    source: DiscoverySource;
    kind?: IndexedDocument["kind"];
    documents: readonly IndexedDocument[];
  }): void {
    const clauses: string[] = [];
    const values: string[] = [];
    clauses.push("source = ?");
    values.push(params.source);
    if (params.kind) {
      clauses.push("kind = ?");
      values.push(params.kind);
    }
    const where = ` WHERE ${clauses.join(" AND ")}`;

    const tx = this.db.transaction((docs: readonly IndexedDocument[]) => {
      const existingRows = this.db
        .query(`SELECT doc_key FROM discovery_documents${where}`)
        .all(...values) as Array<{ doc_key: string }>;
      const documentKeys = new Set(docs.map((doc) => doc.docKey));

      this.upsertDocumentsInTransaction(docs);
      for (const row of existingRows) {
        if (!documentKeys.has(row.doc_key)) {
          this.db.run("DELETE FROM discovery_documents WHERE doc_key = ?", [row.doc_key]);
        }
      }
    });

    tx(params.documents);
  }

  searchDocuments(params: {
    ftsQuery: string;
    sources: readonly DiscoverySource[];
    limit: number;
    platform?: AdapterPlatform;
    sessionId?: string;
    authorId?: string;
    window?: TimeWindow;
  }): IndexedDocumentRow[] {
    const sourcePlaceholders = params.sources.map(() => "?").join(", ");
    const values: Array<string | number> = [params.ftsQuery, ...params.sources];

    const filterClauses: string[] = [];
    if (params.platform) {
      filterClauses.push("AND d.platform = ?");
      values.push(params.platform);
    }
    if (params.sessionId) {
      filterClauses.push("AND d.session_id = ?");
      values.push(params.sessionId);
    }
    if (params.authorId) {
      filterClauses.push("AND d.author_id = ?");
      values.push(params.authorId);
    }

    const filterClause =
      filterClauses.length === 0 ? "" : `\n          ${filterClauses.join("\n          ")}`;
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
          ${filterClause}
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
  private readonly fileDocuments = new Map<
    string,
    { mtimeMs: number; size: number; documents: IndexedDocument[] }
  >();
  private lastTranscriptVersion: string | undefined;
  private readonly transcriptDocuments = new Map<
    string,
    { updatedTs: number; text: string; document: IndexedDocument }
  >();
  private sourceSyncPromise: Promise<void> | undefined;

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

  closeResult(): ResultType<void, DiscoveryCloseError> {
    const closed = Result.try({
      try: () => this.store.close(),
      catch: (cause) => captureError(cause, "Discovery search failed"),
    });
    const outcome = closed.match<
      { readonly kind: "success" } | { readonly kind: "failure"; readonly cause: unknown }
    >({
      ok: () => ({ kind: "success" }),
      err: ({ cause }) => ({ kind: "failure", cause }),
    });
    if (outcome.kind === "success") return Result.ok();
    rethrowPanic(outcome.cause);
    return Result.err(
      new DiscoveryCloseError({
        cause: opaqueErrorCause(outcome.cause, "Opaque discovery close failure"),
        message: "Failed to close discovery storage",
      }),
    );
  }

  close(): void {
    adaptDiscoveryCloseResultToHost(this.closeResult());
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
    const version = this.params.transcriptStore?.getDiscoveryVersion?.();
    if (version !== undefined && version === this.lastTranscriptVersion) return;
    const records = this.params.transcriptStore?.listDiscoveryRecords?.() ?? [];
    const documents: IndexedDocument[] = [];

    for (const record of records) {
      const text = record.finalText?.trim();
      if (!text) continue;
      if (record.requestClient === "native" || hasIndexedSurfaceCoverage(record)) continue;
      const cached = this.transcriptDocuments.get(record.requestId);
      if (cached && cached.updatedTs === record.updatedTs && cached.text === text) {
        documents.push(cached.document);
        continue;
      }
      const document: IndexedDocument = {
        docKey: `conversation:transcript:${record.requestClient}:${record.sessionId}:${record.requestId}`,
        source: "conversation",
        kind: "transcript_request",
        platform: record.requestClient,
        sessionId: record.sessionId,
        requestId: record.requestId,
        text,
        ts: record.updatedTs,
        updatedTs: record.updatedTs,
      };
      this.transcriptDocuments.set(record.requestId, {
        updatedTs: record.updatedTs,
        text,
        document,
      });
      documents.push(document);
    }

    const liveRequests = new Set(documents.map((document) => document.requestId));
    for (const requestId of this.transcriptDocuments.keys()) {
      if (!liveRequests.has(requestId)) this.transcriptDocuments.delete(requestId);
    }
    this.store.replaceDocumentsWhere({
      source: "conversation",
      kind: "transcript_request",
      documents,
    });
    this.lastTranscriptVersion = version;
  }

  private async buildPromptDocuments(): Promise<IndexedDocument[]> {
    const promptDir = resolvePromptDir({ dataDir: this.params.dataDir });
    const documents: IndexedDocument[] = [];

    for (const fileName of CORE_PROMPT_FILES) {
      const filePath = path.join(promptDir, fileName);
      const stat = await Bun.file(filePath).stat();
      const cached = this.fileDocuments.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        documents.push(...cached.documents);
        continue;
      }
      const raw = await Bun.file(filePath).text();
      const text = stripFrontmatter(raw).trim();
      const blocks = extractFileBlocks({
        source: "prompt",
        filePath,
        title: path.relative(promptDir, filePath) || path.basename(filePath),
        text,
        ts: Math.floor(stat.mtimeMs),
      });
      const fileDocuments: IndexedDocument[] = [];
      for (const block of blocks) {
        fileDocuments.push({
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
      this.fileDocuments.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        documents: fileDocuments,
      });
      documents.push(...fileDocuments);
    }

    return documents;
  }

  private async buildHeartbeatDocuments(): Promise<IndexedDocument[]> {
    const paths = resolveHeartbeatPromptPaths({ dataDir: this.params.dataDir });
    const filePaths = [
      paths.heartbeatFilePath,
      ...(await listTextFilesRecursive(paths.heartbeatDir)),
    ];
    const uniqueFilePaths = [...new Set(filePaths)].sort();
    const documents: IndexedDocument[] = [];

    for (const filePath of uniqueFilePaths) {
      const stat = await Bun.file(filePath).stat();
      const cached = this.fileDocuments.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        documents.push(...cached.documents);
        continue;
      }
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
      const fileDocuments: IndexedDocument[] = [];
      for (const block of blocks) {
        fileDocuments.push({
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
      this.fileDocuments.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        documents: fileDocuments,
      });
      documents.push(...fileDocuments);
    }

    return documents;
  }

  private async syncFileSources(): Promise<void> {
    await ensurePromptWorkspace({ dataDir: this.params.dataDir });
    const [promptDocuments, heartbeatDocuments] = await Promise.all([
      this.buildPromptDocuments(),
      this.buildHeartbeatDocuments(),
    ]);

    const livePaths = new Set(
      [...promptDocuments, ...heartbeatDocuments].map((doc) => doc.filePath),
    );
    for (const filePath of this.fileDocuments.keys()) {
      if (!livePaths.has(filePath)) this.fileDocuments.delete(filePath);
    }
    this.store.replaceDocumentsWhere({ source: "prompt", documents: promptDocuments });
    this.store.replaceDocumentsWhere({ source: "heartbeat", documents: heartbeatDocuments });
  }

  private async syncAllSources(): Promise<void> {
    if (this.sourceSyncPromise) {
      await this.sourceSyncPromise;
      return;
    }

    const syncPromise = (async () => {
      await this.syncConversationFromDiscord();
      await this.syncConversationFromTranscripts();
      await this.syncFileSources();
    })();
    this.sourceSyncPromise = syncPromise;
    await syncPromise.finally(() => {
      if (this.sourceSyncPromise === syncPromise) this.sourceSyncPromise = undefined;
    });
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
    const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

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
        const matchByKey = new Map(matches.map((match) => [match.row.doc_key, match] as const));
        const mergedWindows = mergeIndexWindows(
          matches.flatMap((match) => {
            const centerIndex = rowIndexByKey.get(match.row.doc_key);
            if (centerIndex === undefined) return [];
            return {
              start: Math.max(0, centerIndex - params.surrounding),
              end: Math.min(sessionRows.length - 1, centerIndex + params.surrounding),
            };
          }),
        );

        const entries = mergedWindows.map((window) =>
          sessionRows.slice(window.start, window.end + 1).map((row) =>
            buildConversationEntry({
              row,
              matched: matchByKey.has(row.doc_key),
              candidate: matchByKey.get(row.doc_key),
              origin,
              discordUserAliasById,
            }),
          ),
        );

        groups.push({
          key,
          source: "conversation",
          score: Math.max(...matches.map((match) => match.score)),
          ts: Math.max(...matches.map((match) => match.row.ts)),
          time: formatDiscoveryTime(Math.max(...matches.map((match) => match.row.ts))),
          origin,
          entries,
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

        const mergedWindows = mergeLineWindows(windows);
        const entries = mergedWindows.map((window) => [
          buildFileRangeEntry({
            row: top.row,
            startLine: window.startLine,
            endLine: window.endLine,
            text: lines.slice(window.startLine - 1, window.endLine).join("\n"),
            matchRanges: window.matchRanges,
            candidate: matches[0],
            origin,
          }),
        ]);

        groups.push({
          key,
          source: top.row.source,
          score: Math.max(...matches.map((match) => match.score)),
          ts: Math.max(...matches.map((match) => match.row.ts)),
          time: formatDiscoveryTime(Math.max(...matches.map((match) => match.row.ts))),
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
    const discordUserAliasById = buildDiscordUserAliasById(params.cfg);
    for (const candidate of params.candidates) {
      const arr = bySource.get(candidate.row.source);
      if (arr) arr.push(candidate);
      else bySource.set(candidate.row.source, [candidate]);
    }

    const groups: DiscoveryResultGroup[] = [];
    for (const [source, candidates] of bySource) {
      const entries: DiscoveryResultEntry[][] = candidates.map((candidate) => {
        const origin = buildOriginFromRow(candidate.row, params.cfg);
        if (candidate.row.source === "conversation") {
          return [
            buildConversationEntry({
              row: candidate.row,
              matched: true,
              candidate,
              origin,
              discordUserAliasById,
            }),
          ];
        }

        return [
          buildFileRangeEntry({
            row: candidate.row,
            startLine: candidate.row.start_line ?? 1,
            endLine: candidate.row.end_line ?? 1,
            text: candidate.row.text,
            matchRanges: [
              {
                startLine: candidate.row.start_line ?? 1,
                endLine: candidate.row.end_line ?? 1,
              },
            ],
            candidate,
            origin,
          }),
        ];
      });

      groups.push({
        key: `source:${source}`,
        source,
        score: Math.max(...candidates.map((candidate) => candidate.score)),
        ts: Math.max(...candidates.map((candidate) => candidate.row.ts)),
        time: formatDiscoveryTime(Math.max(...candidates.map((candidate) => candidate.row.ts))),
        entries,
      });
    }
    return groups;
  }

  async searchResult(
    input: DiscoverySearchInput,
  ): Promise<ResultType<DiscoverySearchResult, DiscoverySearchError>> {
    const pending = this.searchOperation(input);
    const searched = await Result.tryPromise({
      try: () => pending,
      catch: (cause) => captureError(cause, "Discovery search failed"),
    });
    const outcome = searched.match<
      | { readonly kind: "success"; readonly value: DiscoverySearchResult }
      | { readonly kind: "failure"; readonly cause: Error }
    >({
      ok: (value) => ({ kind: "success", value }),
      err: ({ cause }) => ({ kind: "failure", cause }),
    });
    if (outcome.kind === "success") return Result.ok(outcome.value);
    if (isPanic(outcome.cause)) {
      await pending;
      return Result.err(
        new DiscoverySearchOperationError({
          cause: opaqueErrorCause(outcome.cause, "Opaque discovery search failure"),
          message: "Discovery search failed",
        }),
      );
    }
    if (DiscoverySearchInputError.is(outcome.cause)) return Result.err(outcome.cause);
    return Result.err(
      new DiscoverySearchOperationError({
        cause: opaqueErrorCause(outcome.cause, "Opaque discovery search failure"),
        message: "Discovery search failed",
      }),
    );
  }

  async search(input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    return adaptDiscoverySearchResultToHost(await this.searchResult(input));
  }

  private async searchOperation(input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    await this.syncAllSources();

    const normalizedQuery = normalizeFtsQuery(input.query);
    const ftsQuery = adaptDiscoverySearchInputResultToHost(
      normalizedQuery
        ? Result.ok(normalizedQuery)
        : Result.err(
            new DiscoverySearchInputError({
              field: "query",
              message: "query must not be empty",
            }),
          ),
    );

    const sources = [
      ...new Set(input.sources ?? (["conversation", "prompt", "heartbeat"] as const)),
    ];
    const orderBy = input.orderBy ?? "relevance";
    const direction = input.direction ?? "desc";
    const groupBy = input.groupBy ?? "origin";
    const surrounding = clampNonNegativeInt(input.surrounding, 1, DISCOVERY_SURROUNDING_MAX);
    const limit = clampPositiveInt(input.limit, 10, DISCOVERY_LIMIT_MAX);
    const verbose = input.verbose ?? false;
    const nowMs = Date.now();
    const window = adaptDiscoverySearchInputResultToHost(resolveTimeWindow(input, nowMs));
    const candidateLimit = Math.min(500, Math.max(limit * 8, 50));
    const cfg = await this.getConfig();

    const rows = this.store.searchDocuments({
      ftsQuery,
      sources,
      limit: candidateLimit,
      platform: input.platform,
      sessionId: input.sessionId,
      authorId: input.authorId,
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

    let groups: DiscoveryResultGroup[];
    switch (groupBy) {
      case "origin":
        groups = await this.buildOriginGroups({ candidates, surrounding, cfg });
        break;
      case "source":
        groups = this.buildSourceGroups({ candidates, cfg });
        break;
      case "none":
        groups = candidates.slice(0, limit).map((candidate) => ({
          key: `hit:${candidate.row.doc_key}`,
          source: candidate.row.source,
          score: candidate.score,
          ts: candidate.row.ts,
          time: formatDiscoveryTime(candidate.row.ts),
          origin: buildOriginFromRow(candidate.row, cfg),
          entries:
            candidate.row.source === "conversation"
              ? [
                  [
                    buildConversationEntry({
                      row: candidate.row,
                      matched: true,
                      candidate,
                      origin: buildOriginFromRow(candidate.row, cfg),
                      discordUserAliasById: buildDiscordUserAliasById(cfg),
                    }),
                  ],
                ]
              : [
                  [
                    buildFileRangeEntry({
                      row: candidate.row,
                      startLine: candidate.row.start_line ?? 1,
                      endLine: candidate.row.end_line ?? 1,
                      text: candidate.row.text,
                      matchRanges: [
                        {
                          startLine: candidate.row.start_line ?? 1,
                          endLine: candidate.row.end_line ?? 1,
                        },
                      ],
                      candidate,
                      origin: buildOriginFromRow(candidate.row, cfg),
                    }),
                  ],
                ],
        }));
        break;
    }

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
        verbose,
        platform: input.platform,
        sessionId: input.sessionId,
        authorId: input.authorId,
        window:
          window === undefined
            ? undefined
            : {
                startTime: formatDiscoveryTime(window.startTs) ?? String(window.startTs),
                endTime: formatDiscoveryTime(window.endTs) ?? String(window.endTs),
                ...(verbose ? { startTs: window.startTs, endTs: window.endTs } : {}),
              },
      },
      groups: limitedGroups.map((group) => stripVerboseGroup(group, verbose)),
    };
  }
}
