import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createOpencodeClient,
  type AssistantMessage,
  type Message,
  type Part,
  type PermissionRule,
  type Session,
} from "@opencode-ai/sdk/v2";

declare const PACKAGE_VERSION: string;

type PermissionAutoResponse = "once" | "always";

type RunStatus = "submitted" | "running" | "completed" | "failed" | "aborted" | "timeout";

type AssistantSummary = {
  messageID: string;
  created: number;
  text: string;
  error?: unknown;
  modelID?: string;
  providerID?: string;
  agent?: string;
  tokens?: unknown;
  cost?: number;
  finish?: string;
};

type PromptRunRecord = {
  id: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  directory: string;
  baseUrl: string;
  sessionID: string;
  userMessageID?: string;
  textHash: string;
  textNormalized: string;
  textPreview: string;
  agent: string;
  model?: string;
  variant?: string;
  assistant?: AssistantSummary;
  error?: unknown;
};

type PromptEventCounters = {
  permissionsAutoApproved: number;
  permissionsAutoFailed: number;
  questionsAutoRejected: number;
};

type PromptSubmitResult = {
  ok: boolean;
  runID?: string;
  sessionID: string;
  userMessageID?: string;
  status?: RunStatus;
  run?: PromptRunRecord;
  assistant?: AssistantSummary;
  duplicate?: {
    blocked: boolean;
    reason: "exact_recent_duplicate" | "similar_recent_duplicate";
    similarity: number;
    lastPromptMessageID: string;
    lastPromptCreated: number;
    lastPromptTextPreview: string;
  };
  events?: PromptEventCounters;
  meta: {
    directory: string;
    baseUrl: string;
    agent?: string;
    model?: string;
    variant?: string;
    timeoutMs: number;
    ensureServer: boolean;
  };
  error?: unknown;
};

type PromptWaitResult = {
  ok: boolean;
  runID: string;
  sessionID: string;
  userMessageID?: string;
  status: RunStatus;
  assistant?: AssistantSummary;
  events: PromptEventCounters;
  meta: {
    directory: string;
    baseUrl: string;
    timeoutMs: number;
    pollMs: number;
    cancelOnTimeout: boolean;
    autoRejectQuestions: boolean;
    permissionResponse: PermissionAutoResponse;
  };
  error?: unknown;
};

type PromptInspectResult = {
  ok: boolean;
  runID: string;
  sessionID: string;
  status: RunStatus;
  userMessageID?: string;
  assistant?: AssistantSummary;
  run: PromptRunRecord;
  error?: unknown;
};

type SnapshotRun = {
  user: {
    messageID: string;
    created: number;
    text: string;
  };
  assistant: {
    messageID: string;
    created: number;
    text: string;
    error?: unknown;
  } | null;
};

type SnapshotResult = {
  ok: boolean;
  sessionID: string;
  session?: {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    time: {
      created: number;
      updated: number;
      archived?: number;
    };
    summary?: {
      additions: number;
      deletions: number;
      files: number;
    };
  };
  todo?: {
    remaining: {
      total: number;
      pending: number;
      in_progress: number;
      other: number;
    };
    items?: Array<{
      id: string;
      content: string;
      status: string;
      priority: string;
    }>;
  };
  recent?: {
    runs: SnapshotRun[];
  };
  truncation?: {
    maxCharsPerMessage: number;
    maxRuns: number;
    fetchedMessagesLimit: number;
    truncated: boolean;
  };
  meta: {
    directory: string;
    baseUrl: string;
    ensureServer: boolean;
  };
  error?: unknown;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toInt(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (typeof x === "string" && x.trim().length > 0) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function toBool(x: unknown): boolean | null {
  if (typeof x === "boolean") return x;
  if (typeof x === "string") {
    const v = x.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return null;
}

function parseFlags(args: readonly string[]): {
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }

    if (a.startsWith("--no-")) {
      flags[a.slice("--no-".length)] = false;
      continue;
    }

    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }

    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
      continue;
    }
    flags[key] = true;
  }

  return { flags, positionals };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function getBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: boolean,
): boolean {
  const v = flags[key];
  if (v === undefined) return defaultValue;
  if (typeof v === "boolean") return v;
  const parsed = toBool(v);
  return parsed ?? defaultValue;
}

function getIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const v = flags[key];
  if (v === undefined) return defaultValue;
  const parsed = toInt(v);
  return parsed ?? defaultValue;
}

function getNumberFlag(
  flags: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const v = flags[key];
  if (v === undefined) return defaultValue;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizePromptText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function textPreview(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function promptHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function charBigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  if (text.length < 2) {
    if (text.length === 1) out.set(text, 1);
    return out;
  }
  for (let i = 0; i < text.length - 1; i++) {
    const bg = text.slice(i, i + 2);
    out.set(bg, (out.get(bg) ?? 0) + 1);
  }
  return out;
}

function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const aa = charBigrams(a);
  const bb = charBigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of aa.values()) totalA += count;
  for (const count of bb.values()) totalB += count;
  for (const [token, countA] of aa) {
    const countB = bb.get(token) ?? 0;
    overlap += Math.min(countA, countB);
  }
  const denom = totalA + totalB;
  if (denom === 0) return 0;
  return (2 * overlap) / denom;
}

function stateBaseDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "lilac-opencode-controller");
}

function runsDir(): string {
  return path.join(stateBaseDir(), "runs");
}

function assertValidRunID(runID: string): string {
  const trimmed = runID.trim();
  if (!/^run_[a-f0-9-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid run ID '${runID}'. Expected format like run_123e4567-e89b-12d3-a456-426614174000.`,
    );
  }
  return trimmed;
}

function runFilePath(runID: string): string {
  const safeID = assertValidRunID(runID);
  return path.join(runsDir(), `${safeID}.json`);
}

async function saveRunRecord(run: PromptRunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  await fs.writeFile(runFilePath(run.id), `${JSON.stringify(run)}\n`, "utf8");
}

async function loadRunRecord(runID: string): Promise<PromptRunRecord> {
  const content = await fs.readFile(runFilePath(runID), "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error(`Run record '${runID}' is malformed.`);
  }
  const status = parsed.status;
  if (
    status !== "submitted" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "aborted" &&
    status !== "timeout"
  ) {
    throw new Error(`Run record '${runID}' has invalid status.`);
  }

  const createdAt = toInt(parsed.createdAt);
  const updatedAt = toInt(parsed.updatedAt);
  if (createdAt === null || updatedAt === null) {
    throw new Error(`Run record '${runID}' has invalid timestamps.`);
  }

  const id = typeof parsed.id === "string" ? parsed.id : "";
  const directory = typeof parsed.directory === "string" ? parsed.directory : "";
  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl : "";
  const sessionID = typeof parsed.sessionID === "string" ? parsed.sessionID : "";
  const textHash = typeof parsed.textHash === "string" ? parsed.textHash : "";
  const textNormalized = typeof parsed.textNormalized === "string" ? parsed.textNormalized : "";
  const textPreviewValue = typeof parsed.textPreview === "string" ? parsed.textPreview : "";
  const agent = typeof parsed.agent === "string" ? parsed.agent : "";

  if (!id || !directory || !baseUrl || !sessionID || !textHash || !agent) {
    throw new Error(`Run record '${runID}' is missing required fields.`);
  }

  const assistant = isRecord(parsed.assistant)
    ? {
        messageID: typeof parsed.assistant.messageID === "string" ? parsed.assistant.messageID : "",
        created: toInt(parsed.assistant.created) ?? 0,
        text: typeof parsed.assistant.text === "string" ? parsed.assistant.text : "",
        ...("error" in parsed.assistant ? { error: parsed.assistant.error } : {}),
        ...(typeof parsed.assistant.modelID === "string"
          ? { modelID: parsed.assistant.modelID }
          : {}),
        ...(typeof parsed.assistant.providerID === "string"
          ? { providerID: parsed.assistant.providerID }
          : {}),
        ...(typeof parsed.assistant.agent === "string" ? { agent: parsed.assistant.agent } : {}),
        ...("tokens" in parsed.assistant ? { tokens: parsed.assistant.tokens } : {}),
        ...(typeof parsed.assistant.cost === "number" ? { cost: parsed.assistant.cost } : {}),
        ...(typeof parsed.assistant.finish === "string" ? { finish: parsed.assistant.finish } : {}),
      }
    : undefined;

  return {
    id,
    status,
    createdAt,
    updatedAt,
    directory,
    baseUrl,
    sessionID,
    ...(typeof parsed.userMessageID === "string" ? { userMessageID: parsed.userMessageID } : {}),
    textHash,
    textNormalized,
    textPreview: textPreviewValue,
    agent,
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    ...(typeof parsed.variant === "string" ? { variant: parsed.variant } : {}),
    ...(assistant ? { assistant } : {}),
    ...("error" in parsed ? { error: parsed.error } : {}),
  };
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printJson(obj: unknown) {
  process.stdout.write(JSON.stringify(obj));
  process.stdout.write("\n");
}

function parseModelSpec(spec: string): { providerID: string; modelID: string } {
  const idx = spec.indexOf("/");
  if (idx === -1) {
    throw new Error(
      `Invalid --model '${spec}'. Expected 'provider/model' (e.g. 'anthropic/claude-sonnet-4-20250514').`,
    );
  }
  const providerID = spec.slice(0, idx).trim();
  const modelID = spec.slice(idx + 1).trim();
  if (!providerID || !modelID) {
    throw new Error(
      `Invalid --model '${spec}'. Expected 'provider/model' (non-empty provider and model).`,
    );
  }
  return { providerID, modelID };
}

function denyQuestionsRuleset(): PermissionRule[] {
  return [{ permission: "question", pattern: "*", action: "deny" }];
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensureServer(params: {
  baseUrl: string;
  directory: string;
  ensure: boolean;
  opencodeBin: string;
  serverStartTimeoutMs: number;
}): Promise<{
  client: ReturnType<typeof createOpencodeClient>;
  started: boolean;
}> {
  const client = createOpencodeClient({
    baseUrl: params.baseUrl,
    directory: params.directory,
  });

  const healthOk = await (async () => {
    try {
      const res = await client.global.health();
      return Boolean(res.data?.healthy) && !res.error;
    } catch {
      return false;
    }
  })();

  if (healthOk) return { client, started: false };
  if (!params.ensure) {
    throw new Error(
      `OpenCode server is not reachable at ${params.baseUrl} (and --no-ensure-server was set).`,
    );
  }

  const u = new URL(params.baseUrl);
  const hostname = u.hostname || "127.0.0.1";
  const port = u.port ? Number(u.port) : 4096;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid base URL port in ${params.baseUrl}`);
  }

  const child = spawn(
    params.opencodeBin,
    ["serve", "--hostname", hostname, "--port", String(port)],
    {
      stdio: "ignore",
      detached: true,
      env: process.env,
    },
  );

  let spawnError: string | null = null;
  child.once("error", (err: unknown) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < params.serverStartTimeoutMs) {
    if (spawnError !== null) {
      throw new Error(`Failed to spawn '${params.opencodeBin} serve': ${spawnError}`);
    }
    try {
      const res = await client.global.health();
      if (res.data?.healthy && !res.error) return { client, started: true };
    } catch {
      // Keep polling.
    }
    await sleep(200);
  }

  throw new Error(
    `Started '${params.opencodeBin} serve' but server did not become healthy at ${params.baseUrl} within ${params.serverStartTimeoutMs}ms.`,
  );
}

async function selectSession(params: {
  client: ReturnType<typeof createOpencodeClient>;
  directory: string;
  sessionID?: string;
  title?: string;
  cont: boolean;
  denyQuestionsOnCreate: boolean;
}): Promise<{ session: Session; created: boolean }> {
  const { client } = params;

  if (params.sessionID) {
    const res = await client.session.get({ sessionID: params.sessionID });
    if (res.error || !res.data) {
      throw new Error(`Failed to load session '${params.sessionID}': ${JSON.stringify(res.error)}`);
    }
    return { session: res.data, created: false };
  }

  if (params.title) {
    const list = await client.session.list({
      directory: params.directory,
      // Allow selecting arbitrary sessions by title (not roots-only).
      search: params.title,
      limit: 50,
    });

    if (list.error) {
      throw new Error(`Failed to list sessions for title lookup: ${JSON.stringify(list.error)}`);
    }

    const sessions = Array.isArray(list.data) ? list.data : [];
    const found = sessions.find((s) => s.title === params.title);
    if (found) return { session: found, created: false };

    const createRes = await client.session.create({
      title: params.title,
      ...(params.denyQuestionsOnCreate ? { permission: denyQuestionsRuleset() } : {}),
    });
    if (createRes.error || !createRes.data) {
      throw new Error(
        `Failed to create session '${params.title}': ${JSON.stringify(createRes.error)}`,
      );
    }
    return { session: createRes.data, created: true };
  }

  if (params.cont) {
    const list = await client.session.list({
      directory: params.directory,
      roots: true,
      limit: 1,
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for --continue: ${JSON.stringify(list.error)}`);
    }
    const s = Array.isArray(list.data) ? list.data[0] : undefined;
    if (s) return { session: s, created: false };
  }

  const createRes = await client.session.create(
    params.denyQuestionsOnCreate ? { permission: denyQuestionsRuleset() } : {},
  );
  if (createRes.error || !createRes.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(createRes.error)}`);
  }
  return { session: createRes.data, created: true };
}

async function resolveExistingSession(params: {
  client: ReturnType<typeof createOpencodeClient>;
  directory: string;
  sessionID?: string;
  title?: string;
  cont: boolean;
}): Promise<Session> {
  const { client } = params;

  if (params.sessionID) {
    const res = await client.session.get({ sessionID: params.sessionID });
    if (res.error || !res.data) {
      throw new Error(`Failed to load session '${params.sessionID}': ${JSON.stringify(res.error)}`);
    }
    return res.data;
  }

  if (params.title) {
    const list = await client.session.list({
      directory: params.directory,
      search: params.title,
      limit: 50,
    });

    if (list.error) {
      throw new Error(`Failed to list sessions for title lookup: ${JSON.stringify(list.error)}`);
    }

    const sessions = Array.isArray(list.data) ? list.data : [];
    const found = sessions.find((s) => s.title === params.title);
    if (found) return found;
    throw new Error(`No session found with exact title '${params.title}'.`);
  }

  if (params.cont) {
    const list = await client.session.list({
      directory: params.directory,
      roots: true,
      limit: 1,
    });
    if (list.error) {
      throw new Error(`Failed to list sessions for --continue: ${JSON.stringify(list.error)}`);
    }
    const s = Array.isArray(list.data) ? list.data[0] : undefined;
    if (s) return s;
    throw new Error(`No sessions found in directory '${params.directory}'.`);
  }

  throw new Error("Missing session selector (session-id/title/--continue).");
}

function buildRecentRuns(params: {
  messages: Array<{ info: Message; parts: Part[] }>;
  maxRuns: number;
  maxCharsPerMessage: number;
}): { runs: SnapshotRun[]; truncated: boolean } {
  const maxRuns = Math.max(0, Math.trunc(params.maxRuns));
  const maxChars = Math.max(0, Math.trunc(params.maxCharsPerMessage));
  let truncated = false;

  const assistantByParent = new Map<string, { info: AssistantMessage; parts: Part[] }>();

  for (const m of params.messages) {
    if (m.info.role !== "assistant") continue;
    const parentID = m.info.parentID;
    if (!parentID) continue;

    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    const prev = assistantByParent.get(parentID);
    const prevCreated = typeof prev?.info.time?.created === "number" ? prev.info.time.created : -1;
    if (!prev || created >= prevCreated) {
      assistantByParent.set(parentID, { info: m.info, parts: m.parts });
    }
  }

  const runs: SnapshotRun[] = [];
  for (const m of params.messages) {
    if (m.info.role !== "user") continue;

    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    const userText = pickUserText(m.parts);
    const tUser = truncateText(userText, maxChars);
    truncated = truncated || tUser.truncated;

    const a = assistantByParent.get(m.info.id);
    const assistant = a
      ? (() => {
          const aCreated = typeof a.info.time?.created === "number" ? a.info.time.created : 0;
          const aText = pickAssistantText(a.parts);
          const tAsst = truncateText(aText, maxChars);
          truncated = truncated || tAsst.truncated;
          return {
            messageID: a.info.id,
            created: aCreated,
            text: tAsst.text,
            error: a.info.error,
          };
        })()
      : null;

    runs.push({
      user: {
        messageID: m.info.id,
        created,
        text: tUser.text,
      },
      assistant,
    });
  }

  return {
    runs: maxRuns === 0 ? [] : runs.slice(-maxRuns),
    truncated,
  };
}

async function runSnapshot(params: {
  baseUrl: string;
  directory: string;
  ensureServer: boolean;
  opencodeBin: string;
  sessionID?: string;
  title?: string;
  cont: boolean;
  maxRuns: number;
  maxCharsPerMessage: number;
  messagesLimit: number;
  includeTodos: boolean;
}): Promise<SnapshotResult> {
  const out: SnapshotResult = {
    ok: false,
    sessionID: "",
    meta: {
      directory: params.directory,
      baseUrl: params.baseUrl,
      ensureServer: params.ensureServer,
    },
  };

  try {
    const ensured = await ensureServer({
      baseUrl: params.baseUrl,
      directory: params.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 10_000,
    });

    const client = ensured.client;
    const session = await resolveExistingSession({
      client,
      directory: params.directory,
      sessionID: params.sessionID,
      title: params.title,
      cont: params.cont,
    });

    out.sessionID = session.id;
    out.session = {
      id: session.id,
      title: session.title,
      directory: session.directory,
      parentID: session.parentID,
      time: {
        created: session.time.created,
        updated: session.time.updated,
        archived: session.time.archived,
      },
      ...(session.summary
        ? {
            summary: {
              additions: session.summary.additions,
              deletions: session.summary.deletions,
              files: session.summary.files,
            },
          }
        : {}),
    };

    const todosRes = await client.session.todo({ sessionID: session.id });
    if (todosRes.error) {
      throw new Error(`Failed to fetch session todos: ${JSON.stringify(todosRes.error)}`);
    }
    const todosAll = Array.isArray(todosRes.data) ? todosRes.data : [];
    const remaining = todosAll.filter(isTodoRemaining);
    const pending = remaining.filter((t) => t.status === "pending").length;
    const inProgress = remaining.filter((t) => t.status === "in_progress").length;
    const other = remaining.length - pending - inProgress;
    out.todo = {
      remaining: {
        total: remaining.length,
        pending,
        in_progress: inProgress,
        other,
      },
      ...(params.includeTodos
        ? {
            items: remaining.map((t) => ({
              id: t.id,
              content: t.content,
              status: t.status,
              priority: t.priority,
            })),
          }
        : {}),
    };

    const limit = Math.max(1, Math.trunc(params.messagesLimit));
    const msgs = await client.session.messages({
      sessionID: session.id,
      limit,
    });
    if (msgs.error || !msgs.data) {
      throw new Error(`Failed to fetch session messages: ${JSON.stringify(msgs.error)}`);
    }

    const recent = buildRecentRuns({
      messages: msgs.data,
      maxRuns: params.maxRuns,
      maxCharsPerMessage: params.maxCharsPerMessage,
    });
    out.recent = { runs: recent.runs };
    out.truncation = {
      maxCharsPerMessage: params.maxCharsPerMessage,
      maxRuns: params.maxRuns,
      fetchedMessagesLimit: limit,
      truncated: recent.truncated,
    };

    out.ok = true;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = isRecord(e) && "message" in e ? e.message : String(e);
    return out;
  }
}

function pickAssistantText(parts: readonly Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p.ignored ? "" : p.text))
    .filter((s) => s.length > 0)
    .join("");
}

function pickUserText(parts: readonly Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p.ignored || p.synthetic ? "" : p.text))
    .filter((s) => s.length > 0)
    .join("");
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function isTodoRemaining(t: { status?: string }): boolean {
  const s = typeof t.status === "string" ? t.status : "";
  return s !== "completed" && s !== "cancelled";
}

function findAssistantMessageForUserMessage(params: {
  userMessageID: string;
  messages: Array<{ info: Message; parts: Part[] }>;
}): { info: AssistantMessage; parts: Part[] } | null {
  let best: { info: AssistantMessage; parts: Part[] } | null = null;
  let bestCreated = -1;

  for (const m of params.messages) {
    if (m.info.role !== "assistant") continue;
    const parentID = m.info.parentID;
    if (parentID !== params.userMessageID) continue;

    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    if (!best || created >= bestCreated) {
      best = { info: m.info, parts: m.parts };
      bestCreated = created;
    }
  }

  return best;
}

function findAssistantMessagesForUserMessage(params: {
  userMessageID: string;
  messages: Array<{ info: Message; parts: Part[] }>;
}): Array<{ info: AssistantMessage; parts: Part[] }> {
  const out: Array<{ info: AssistantMessage; parts: Part[] }> = [];
  for (const m of params.messages) {
    if (m.info.role !== "assistant") continue;
    if (m.info.parentID !== params.userMessageID) continue;
    out.push({ info: m.info, parts: m.parts });
  }
  out.sort((a, b) => {
    const ac = typeof a.info.time?.created === "number" ? a.info.time.created : 0;
    const bc = typeof b.info.time?.created === "number" ? b.info.time.created : 0;
    return ac - bc;
  });
  return out;
}

function isTerminalAssistantMessage(info: AssistantMessage): boolean {
  if (info.error !== undefined) return true;
  return info.finish !== undefined && info.finish !== "tool-calls" && info.finish !== "unknown";
}

function toAssistantSummary(input: { info: AssistantMessage; parts: Part[] }): AssistantSummary {
  return {
    messageID: input.info.id,
    created: typeof input.info.time?.created === "number" ? input.info.time.created : 0,
    text: pickAssistantText(input.parts),
    ...(input.info.error !== undefined ? { error: input.info.error } : {}),
    ...(typeof input.info.modelID === "string" ? { modelID: input.info.modelID } : {}),
    ...(typeof input.info.providerID === "string" ? { providerID: input.info.providerID } : {}),
    ...(typeof input.info.agent === "string" ? { agent: input.info.agent } : {}),
    ...(input.info.tokens ? { tokens: input.info.tokens } : {}),
    ...(typeof input.info.cost === "number" ? { cost: input.info.cost } : {}),
    ...(typeof input.info.finish === "string" ? { finish: input.info.finish } : {}),
  };
}

async function fetchSessionMessages(params: {
  client: ReturnType<typeof createOpencodeClient>;
  sessionID: string;
  limit: number;
}): Promise<Array<{ info: Message; parts: Part[] }>> {
  const res = await params.client.session.messages({
    sessionID: params.sessionID,
    limit: Math.max(1, Math.trunc(params.limit)),
  });
  if (res.error || !res.data) {
    throw new Error(`Failed to fetch session messages: ${JSON.stringify(res.error)}`);
  }
  return res.data;
}

function findLatestUserPrompt(params: {
  messages: Array<{ info: Message; parts: Part[] }>;
}): { messageID: string; created: number; text: string; normalized: string } | null {
  let best: { messageID: string; created: number; text: string; normalized: string } | null = null;

  for (const m of params.messages) {
    if (m.info.role !== "user") continue;
    const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
    const text = pickUserText(m.parts);
    const normalized = normalizePromptText(text);
    if (normalized.length === 0) continue;
    if (!best || created >= best.created) {
      best = {
        messageID: m.info.id,
        created,
        text,
        normalized,
      };
    }
  }

  return best;
}

function detectDuplicatePrompt(params: {
  messages: Array<{ info: Message; parts: Part[] }>;
  promptNormalized: string;
  now: number;
  exactWindowMs: number;
  similarWindowMs: number;
  similarityThreshold: number;
}): PromptSubmitResult["duplicate"] | undefined {
  const latest = findLatestUserPrompt({ messages: params.messages });
  if (!latest) return undefined;

  const ageMs = Math.max(0, params.now - latest.created);
  const similarity = textSimilarity(params.promptNormalized, latest.normalized);
  const common = {
    similarity,
    lastPromptMessageID: latest.messageID,
    lastPromptCreated: latest.created,
    lastPromptTextPreview: textPreview(latest.text, 240),
  };

  if (params.promptNormalized === latest.normalized && ageMs <= params.exactWindowMs) {
    return {
      blocked: true,
      reason: "exact_recent_duplicate",
      ...common,
    };
  }

  if (similarity >= params.similarityThreshold && ageMs <= params.similarWindowMs) {
    return {
      blocked: true,
      reason: "similar_recent_duplicate",
      ...common,
    };
  }

  return undefined;
}

function collectKnownUserMessageIDs(
  messages: Array<{ info: Message; parts: Part[] }>,
): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.info.role !== "user") continue;
    ids.add(m.info.id);
  }
  return ids;
}

async function resolveSubmittedUserMessage(params: {
  client: ReturnType<typeof createOpencodeClient>;
  sessionID: string;
  knownUserIDs: Set<string>;
  promptNormalized: string;
  submittedAt: number;
  resolveTimeoutMs: number;
  pollMs: number;
  messagesLimit: number;
}): Promise<{ userMessageID: string; created: number } | null> {
  const deadline = Date.now() + Math.max(0, params.resolveTimeoutMs);

  while (Date.now() <= deadline) {
    const messages = await fetchSessionMessages({
      client: params.client,
      sessionID: params.sessionID,
      limit: params.messagesLimit,
    });

    let best: { userMessageID: string; created: number; score: number; exact: boolean } | null =
      null;

    for (const m of messages) {
      if (m.info.role !== "user") continue;
      if (params.knownUserIDs.has(m.info.id)) continue;
      const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
      if (created < params.submittedAt - 2 * 60_000) continue;
      const normalized = normalizePromptText(pickUserText(m.parts));
      if (normalized.length === 0) continue;
      const exact = normalized === params.promptNormalized;
      const score = exact ? 1 : textSimilarity(normalized, params.promptNormalized);
      if (score < 0.98) continue;

      if (
        !best ||
        (exact && !best.exact) ||
        (exact === best.exact && score > best.score) ||
        (exact === best.exact && score === best.score && created > best.created)
      ) {
        best = {
          userMessageID: m.info.id,
          created,
          score,
          exact,
        };
      }
    }

    if (best) {
      return {
        userMessageID: best.userMessageID,
        created: best.created,
      };
    }

    await sleep(Math.max(50, params.pollMs));
  }

  return null;
}

function sessionStatusTypeForSession(params: {
  statusMap: unknown;
  sessionID: string;
}): "busy" | "idle" | "retry" | "unknown" {
  if (!isRecord(params.statusMap)) return "unknown";
  const raw = params.statusMap[params.sessionID];
  if (!isRecord(raw) || typeof raw.type !== "string") return "unknown";
  if (raw.type === "busy" || raw.type === "idle" || raw.type === "retry") {
    return raw.type;
  }
  return "unknown";
}

async function inspectRunState(params: {
  client: ReturnType<typeof createOpencodeClient>;
  run: PromptRunRecord;
  messagesLimit: number;
}): Promise<PromptRunRecord> {
  const [messages, statusRes] = await Promise.all([
    fetchSessionMessages({
      client: params.client,
      sessionID: params.run.sessionID,
      limit: params.messagesLimit,
    }),
    params.client.session.status({ directory: params.run.directory }),
  ]);

  const sessionStatusType = sessionStatusTypeForSession({
    statusMap: statusRes.data,
    sessionID: params.run.sessionID,
  });

  const next: PromptRunRecord = {
    ...params.run,
    updatedAt: Date.now(),
  };

  let userMessageID = next.userMessageID;
  if (!userMessageID) {
    let best: { id: string; created: number; score: number } | null = null;
    for (const m of messages) {
      if (m.info.role !== "user") continue;
      const created = typeof m.info.time?.created === "number" ? m.info.time.created : 0;
      if (created < next.createdAt - 2 * 60_000) continue;
      const normalized = normalizePromptText(pickUserText(m.parts));
      if (!normalized) continue;
      const score =
        normalized === next.textNormalized ? 1 : textSimilarity(normalized, next.textNormalized);
      if (score < 0.98) continue;
      if (!best || score > best.score || (score === best.score && created > best.created)) {
        best = { id: m.info.id, created, score };
      }
    }
    if (best) {
      userMessageID = best.id;
      next.userMessageID = best.id;
    }
  }

  const assistants = userMessageID
    ? findAssistantMessagesForUserMessage({
        userMessageID,
        messages,
      })
    : [];

  const terminal = assistants.find((a) => isTerminalAssistantMessage(a.info));
  const latest = assistants.at(-1);
  const selected = terminal ?? latest;
  if (selected) {
    next.assistant = toAssistantSummary(selected);
  }

  if (next.status === "aborted") {
    return next;
  }

  if (terminal) {
    next.status = terminal.info.error !== undefined ? "failed" : "completed";
    next.error = terminal.info.error;
    return next;
  }

  if (sessionStatusType === "busy" || sessionStatusType === "retry") {
    next.status = "running";
    return next;
  }

  if (latest) {
    next.status = "running";
    return next;
  }

  next.status = userMessageID ? "running" : "submitted";
  return next;
}

type AutoResponderHandle = {
  counters: PromptEventCounters;
  stop: () => void;
  getSessionError: () => unknown | undefined;
};

function startAutoResponder(params: {
  client: ReturnType<typeof createOpencodeClient>;
  directory: string;
  sessionID: string;
  permissionResponse: PermissionAutoResponse;
  autoRejectQuestions: boolean;
}): AutoResponderHandle {
  const counters: PromptEventCounters = {
    permissionsAutoApproved: 0,
    permissionsAutoFailed: 0,
    questionsAutoRejected: 0,
  };
  const controller = new AbortController();
  let sessionError: unknown | undefined;
  const repliedPermissions = new Set<string>();
  const rejectedQuestions = new Set<string>();

  (async () => {
    const events = await params.client.event.subscribe(
      { directory: params.directory },
      { signal: controller.signal },
    );
    for await (const event of events.stream) {
      if (event.type === "permission.asked") {
        const perm = event.properties;
        if (perm?.sessionID !== params.sessionID) continue;
        const requestID = typeof perm?.id === "string" ? perm.id : null;
        if (!requestID) continue;
        if (repliedPermissions.has(requestID)) continue;
        repliedPermissions.add(requestID);

        try {
          await params.client.permission.reply({
            requestID,
            reply: params.permissionResponse,
          });
          counters.permissionsAutoApproved++;
        } catch {
          counters.permissionsAutoFailed++;
        }
        continue;
      }

      if (event.type === "question.asked") {
        if (!params.autoRejectQuestions) continue;
        const q = event.properties;
        if (q?.sessionID !== params.sessionID) continue;
        const requestID = typeof q?.id === "string" ? q.id : null;
        if (!requestID) continue;
        if (rejectedQuestions.has(requestID)) continue;
        rejectedQuestions.add(requestID);
        try {
          await params.client.question.reject({ requestID });
          counters.questionsAutoRejected++;
        } catch {
          // Ignore.
        }
        continue;
      }

      if (event.type === "session.error") {
        const p = event.properties;
        if (p?.sessionID !== params.sessionID) continue;
        sessionError = p?.error ?? p;
      }
    }
  })().catch((e) => {
    if (!controller.signal.aborted) {
      sessionError = isRecord(e) && "message" in e ? e.message : String(e);
    }
  });

  return {
    counters,
    stop: () => {
      try {
        controller.abort();
      } catch {
        // Ignore.
      }
    },
    getSessionError: () => sessionError,
  };
}

async function waitForRunRecord(params: {
  run: PromptRunRecord;
  ensureServer: boolean;
  opencodeBin: string;
  timeoutMs: number;
  pollMs: number;
  cancelOnTimeout: boolean;
  permissionResponse: PermissionAutoResponse;
  autoRejectQuestions: boolean;
  messagesLimit: number;
  autoResponder?: AutoResponderHandle;
}): Promise<PromptWaitResult> {
  let run = params.run;
  const outBase = {
    runID: run.id,
    sessionID: run.sessionID,
    meta: {
      directory: run.directory,
      baseUrl: run.baseUrl,
      timeoutMs: params.timeoutMs,
      pollMs: params.pollMs,
      cancelOnTimeout: params.cancelOnTimeout,
      autoRejectQuestions: params.autoRejectQuestions,
      permissionResponse: params.permissionResponse,
    },
  };

  try {
    const ensured = await ensureServer({
      baseUrl: run.baseUrl,
      directory: run.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 10_000,
    });

    const auto =
      params.autoResponder ??
      startAutoResponder({
        client: ensured.client,
        directory: run.directory,
        sessionID: run.sessionID,
        permissionResponse: params.permissionResponse,
        autoRejectQuestions: params.autoRejectQuestions,
      });
    const ownsAutoResponder = params.autoResponder === undefined;

    const start = Date.now();
    try {
      while (true) {
        run = await inspectRunState({
          client: ensured.client,
          run,
          messagesLimit: params.messagesLimit,
        });

        const sessionError = auto.getSessionError();
        if (sessionError !== undefined && run.status !== "completed") {
          run.status = "failed";
          run.error = sessionError;
        }

        await saveRunRecord(run);

        if (
          run.status === "completed" ||
          run.status === "failed" ||
          run.status === "aborted" ||
          run.status === "timeout"
        ) {
          return {
            ok: run.status === "completed",
            ...outBase,
            ...(run.userMessageID ? { userMessageID: run.userMessageID } : {}),
            status: run.status,
            ...(run.assistant ? { assistant: run.assistant } : {}),
            events: auto.counters,
            ...(run.error !== undefined ? { error: run.error } : {}),
          };
        }

        const elapsed = Date.now() - start;
        if (elapsed >= params.timeoutMs) {
          if (params.cancelOnTimeout) {
            await ensured.client.session.abort({ sessionID: run.sessionID }).catch(() => {});
            run.status = "aborted";
            run.error = `Timed out after ${params.timeoutMs}ms and sent session.abort.`;
          } else {
            run.status = "timeout";
            run.error = `Timed out after ${params.timeoutMs}ms.`;
          }
          run.updatedAt = Date.now();
          await saveRunRecord(run);
          return {
            ok: false,
            ...outBase,
            ...(run.userMessageID ? { userMessageID: run.userMessageID } : {}),
            status: run.status,
            ...(run.assistant ? { assistant: run.assistant } : {}),
            events: auto.counters,
            ...(run.error !== undefined ? { error: run.error } : {}),
          };
        }

        await sleep(Math.max(100, params.pollMs));
      }
    } finally {
      if (ownsAutoResponder) auto.stop();
    }
  } catch (e) {
    return {
      ok: false,
      ...outBase,
      ...(run.userMessageID ? { userMessageID: run.userMessageID } : {}),
      status: run.status,
      ...(run.assistant ? { assistant: run.assistant } : {}),
      events: {
        permissionsAutoApproved: 0,
        permissionsAutoFailed: 0,
        questionsAutoRejected: 0,
      },
      error: isRecord(e) && "message" in e ? e.message : String(e),
    };
  }
}

async function runPromptSubmit(params: {
  baseUrl: string;
  directory: string;
  ensureServer: boolean;
  opencodeBin: string;
  wait: boolean;
  timeoutMs: number;
  pollMs: number;
  cancelOnTimeout: boolean;
  permissionResponse: PermissionAutoResponse;
  autoRejectQuestions: boolean;
  denyQuestionsOnCreate: boolean;
  force: boolean;
  dedupeExactWindowMs: number;
  dedupeSimilarWindowMs: number;
  dedupeSimilarity: number;
  messagesLimit: number;
  sessionID?: string;
  title?: string;
  cont: boolean;
  agent?: string;
  model?: string;
  variant?: string;
  text: string;
}): Promise<PromptSubmitResult | PromptWaitResult> {
  const out: PromptSubmitResult = {
    ok: false,
    sessionID: "",
    meta: {
      directory: params.directory,
      baseUrl: params.baseUrl,
      agent: params.agent,
      model: params.model,
      variant: params.variant,
      timeoutMs: params.timeoutMs,
      ensureServer: params.ensureServer,
    },
  };
  let prestartedAuto: AutoResponderHandle | undefined;

  try {
    const ensured = await ensureServer({
      baseUrl: params.baseUrl,
      directory: params.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 10_000,
    });

    const client = ensured.client;

    const { session } = await selectSession({
      client,
      directory: params.directory,
      sessionID: params.sessionID,
      title: params.title,
      cont: params.cont,
      denyQuestionsOnCreate: params.denyQuestionsOnCreate,
    });

    out.sessionID = session.id;

    const baselineMessages = await fetchSessionMessages({
      client,
      sessionID: session.id,
      limit: params.messagesLimit,
    });

    const normalizedPrompt = normalizePromptText(params.text);
    const duplicate = detectDuplicatePrompt({
      messages: baselineMessages,
      promptNormalized: normalizedPrompt,
      now: Date.now(),
      exactWindowMs: params.dedupeExactWindowMs,
      similarWindowMs: params.dedupeSimilarWindowMs,
      similarityThreshold: params.dedupeSimilarity,
    });

    if (duplicate) {
      out.duplicate = {
        ...duplicate,
        blocked: !params.force,
      };
      if (!params.force) {
        out.ok = false;
        out.error =
          duplicate.reason === "exact_recent_duplicate"
            ? "Blocked duplicate prompt. Re-run with --force to submit anyway."
            : "Blocked similar prompt. Re-run with --force to submit anyway.";
        return out;
      }
    }

    const model = params.model ? parseModelSpec(params.model) : undefined;
    const submittedAt = Date.now();

    if (params.wait) {
      prestartedAuto = startAutoResponder({
        client,
        directory: params.directory,
        sessionID: session.id,
        permissionResponse: params.permissionResponse,
        autoRejectQuestions: params.autoRejectQuestions,
      });
    }

    const accepted = await client.session.promptAsync({
      sessionID: session.id,
      agent: params.agent ?? "build",
      ...(model ? { model } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
      parts: [{ type: "text", text: params.text }],
    });
    if (accepted.error) {
      throw new Error(`OpenCode prompt_async rejected: ${JSON.stringify(accepted.error)}`);
    }

    const runID = `run_${randomUUID()}`;
    const run: PromptRunRecord = {
      id: runID,
      status: "submitted",
      createdAt: submittedAt,
      updatedAt: submittedAt,
      directory: params.directory,
      baseUrl: params.baseUrl,
      sessionID: session.id,
      textHash: promptHash(normalizedPrompt),
      textNormalized: normalizedPrompt,
      textPreview: textPreview(params.text, 240),
      agent: params.agent ?? "build",
      ...(params.model ? { model: params.model } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
    };

    const knownUserIDs = collectKnownUserMessageIDs(baselineMessages);
    const resolvedUser = await resolveSubmittedUserMessage({
      client,
      sessionID: session.id,
      knownUserIDs,
      promptNormalized: normalizedPrompt,
      submittedAt,
      resolveTimeoutMs: 8_000,
      pollMs: 250,
      messagesLimit: params.messagesLimit,
    });
    if (resolvedUser) {
      run.userMessageID = resolvedUser.userMessageID;
      run.status = "running";
      run.updatedAt = Date.now();
    }
    await saveRunRecord(run);

    out.ok = true;
    out.runID = run.id;
    out.status = run.status;
    out.run = run;
    out.userMessageID = run.userMessageID;

    if (params.wait) {
      const waited = await waitForRunRecord({
        run,
        ensureServer: params.ensureServer,
        opencodeBin: params.opencodeBin,
        timeoutMs: params.timeoutMs,
        pollMs: params.pollMs,
        cancelOnTimeout: params.cancelOnTimeout,
        permissionResponse: params.permissionResponse,
        autoRejectQuestions: params.autoRejectQuestions,
        messagesLimit: params.messagesLimit,
        autoResponder: prestartedAuto,
      });
      if (prestartedAuto) prestartedAuto.stop();
      prestartedAuto = undefined;
      return waited;
    }

    return out;
  } catch (e) {
    if (prestartedAuto) prestartedAuto.stop();
    out.ok = false;
    out.error = isRecord(e) && "message" in e ? e.message : String(e);
    return out;
  }
}

async function runPromptWait(params: {
  runID: string;
  ensureServer: boolean;
  opencodeBin: string;
  timeoutMs: number;
  pollMs: number;
  cancelOnTimeout: boolean;
  permissionResponse: PermissionAutoResponse;
  autoRejectQuestions: boolean;
  messagesLimit: number;
}): Promise<PromptWaitResult> {
  const run = await loadRunRecord(params.runID);
  return waitForRunRecord({
    run,
    ensureServer: params.ensureServer,
    opencodeBin: params.opencodeBin,
    timeoutMs: params.timeoutMs,
    pollMs: params.pollMs,
    cancelOnTimeout: params.cancelOnTimeout,
    permissionResponse: params.permissionResponse,
    autoRejectQuestions: params.autoRejectQuestions,
    messagesLimit: params.messagesLimit,
  });
}

async function runPromptInspect(params: {
  runID: string;
  ensureServer: boolean;
  opencodeBin: string;
  messagesLimit: number;
}): Promise<PromptInspectResult> {
  try {
    const run = await loadRunRecord(params.runID);
    const ensured = await ensureServer({
      baseUrl: run.baseUrl,
      directory: run.directory,
      ensure: params.ensureServer,
      opencodeBin: params.opencodeBin,
      serverStartTimeoutMs: 10_000,
    });
    const inspected = await inspectRunState({
      client: ensured.client,
      run,
      messagesLimit: params.messagesLimit,
    });
    await saveRunRecord(inspected);
    return {
      ok: true,
      runID: inspected.id,
      sessionID: inspected.sessionID,
      status: inspected.status,
      ...(inspected.userMessageID ? { userMessageID: inspected.userMessageID } : {}),
      ...(inspected.assistant ? { assistant: inspected.assistant } : {}),
      run: inspected,
    };
  } catch (e) {
    return {
      ok: false,
      runID: params.runID,
      sessionID: "",
      status: "failed",
      run: {
        id: params.runID,
        status: "failed",
        createdAt: 0,
        updatedAt: 0,
        directory: "",
        baseUrl: "",
        sessionID: "",
        textHash: "",
        textNormalized: "",
        textPreview: "",
        agent: "",
      },
      error: isRecord(e) && "message" in e ? e.message : String(e),
    };
  }
}

async function runPromptResult(params: {
  runID: string;
  ensureServer: boolean;
  opencodeBin: string;
  messagesLimit: number;
}): Promise<PromptInspectResult> {
  const inspected = await runPromptInspect(params);
  if (!inspected.ok) return inspected;
  if (inspected.status === "completed" || inspected.status === "failed") {
    return inspected;
  }
  if (inspected.status === "aborted" || inspected.status === "timeout") {
    return {
      ...inspected,
      ok: false,
      error:
        inspected.run.error ?? `Run '${params.runID}' ended with status '${inspected.status}'.`,
    };
  }
  return {
    ...inspected,
    ok: false,
    error: `Run '${params.runID}' is not finished yet (status=${inspected.status}).`,
  };
}

function help(): string {
  return [
    "lilac-opencode (OpenCode controller)",
    "",
    "Usage:",
    "  lilac-opencode sessions list [--directory <path>] [--roots] [--limit <n>] [--search <term>] [--base-url <url>] [--no-ensure-server]",
    "  lilac-opencode sessions snapshot [--directory <path>] [--session-id <id> | --title <title> | --latest] [--runs <n>] [--max-chars <n>] [--messages-limit <n>] [--include-todos] [--base-url <url>] [--no-ensure-server]",
    "  lilac-opencode prompt submit --text <msg> [--directory <path>] [--session-id <id> | --title <title> | --latest] [--agent <name>] [--model <provider/model>] [--variant <v>] [--wait] [--force]",
    "  lilac-opencode prompt wait --run-id <id> [--timeout-ms <n>] [--poll-ms <n>] [--cancel-on-timeout]",
    "  lilac-opencode prompt status --run-id <id>",
    "  lilac-opencode prompt result --run-id <id>",
    "  lilac-opencode prompt ...flags          (alias of prompt submit)",
    "",
    "Global flags:",
    "  --base-url=<url>            Default: http://127.0.0.1:4096",
    "  --directory=<path>          Default: cwd",
    "  --ensure-server/--no-ensure-server  Default: true",
    "  --opencode-bin=<path>       Default: opencode",
    "  --timeout-ms=<n>            Default: 600000 (10 min)",
    "",
    "Prompt submit flags:",
    "  --session-id=<id>           Use exact OpenCode session ID",
    "  --title=<title>             Find or create session by exact title",
    "  --latest/--continue         Use newest root session in directory (default)",
    "  --wait                      Submit then wait for completion",
    "  --force                     Allow duplicate/similar prompt submit",
    "  --dedupe-exact-window-ms=<n>    Default: 1800000 (30 min)",
    "  --dedupe-similar-window-ms=<n>  Default: 600000 (10 min)",
    "  --dedupe-similarity=<n>         Default: 0.92",
    "  --permission-response=<once|always>  Default: always",
    "  --auto-reject-questions/--no-auto-reject-questions  Default: true",
    "  --deny-questions-on-create/--no-deny-questions-on-create Default: true",
    "",
    "Prompt wait/status/result flags:",
    "  --run-id=<id>               Run ID returned by prompt submit",
    "  --poll-ms=<n>               Default: 1000",
    "  --cancel-on-timeout         On wait timeout, send session.abort",
    "",
    "Snapshot flags:",
    "  --runs=<n>                  Default: 6",
    "  --max-chars=<n>             Default: 1200 (per user/assistant text)",
    "  --messages-limit=<n>        Default: 120",
    "  --include-todos             Include remaining todo items (default: counts only)",
    "",
    "Notes:",
    "  - Output is always JSON.",
    "  - sessions snapshot is read-only and requires explicit session selector.",
    "  - If --text is omitted and stdin is piped, stdin is used as the message.",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help")) {
    printJson({ ok: true, help: help(), version: PACKAGE_VERSION });
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    printJson({ ok: true, version: PACKAGE_VERSION });
    return;
  }

  const cmd = argv[0] ?? "";

  if (cmd === "sessions") {
    const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "list";
    const rest = sub === "list" || sub === "snapshot" ? argv.slice(2) : argv.slice(1);
    const { flags } = parseFlags(rest);

    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const baseUrl = getStringFlag(flags, "base-url") ?? "http://127.0.0.1:4096";
    const ensure = getBoolFlag(flags, "ensure-server", true);
    const opencodeBin = getStringFlag(flags, "opencode-bin") ?? "opencode";

    try {
      if (sub === "snapshot") {
        const sessionID = getStringFlag(flags, "session-id");
        const title = getStringFlag(flags, "title");
        const cont = getBoolFlag(flags, "latest", getBoolFlag(flags, "continue", false));

        if (!sessionID && !title && !cont) {
          printJson({
            ok: false,
            error:
              "sessions snapshot requires an explicit selector: --session-id, --title, or --latest.",
          });
          process.exitCode = 1;
          return;
        }

        const maxRuns = getIntFlag(flags, "runs", 6);
        const maxCharsPerMessage = getIntFlag(flags, "max-chars", 1200);
        const messagesLimit = getIntFlag(flags, "messages-limit", 120);
        const includeTodos = getBoolFlag(flags, "include-todos", false);

        const res = await runSnapshot({
          baseUrl,
          directory,
          ensureServer: ensure,
          opencodeBin,
          sessionID,
          title,
          cont,
          maxRuns,
          maxCharsPerMessage,
          messagesLimit,
          includeTodos,
        });

        printJson(res);
        if (!res.ok) process.exitCode = 1;
        return;
      }

      const { client } = await ensureServer({
        baseUrl,
        directory,
        ensure,
        opencodeBin,
        serverStartTimeoutMs: 10_000,
      });
      const roots = getBoolFlag(flags, "roots", false);
      const limit = toInt(getStringFlag(flags, "limit")) ?? undefined;
      const search = getStringFlag(flags, "search");

      const res = await client.session.list({
        directory,
        ...(roots ? { roots: true } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(search ? { search } : {}),
      });

      if (res.error) {
        printJson({ ok: false, error: res.error });
        process.exitCode = 1;
        return;
      }

      printJson({ ok: true, sessions: res.data ?? [] });
      return;
    } catch (e) {
      printJson({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      process.exitCode = 1;
      return;
    }
  }

  if (cmd === "prompt") {
    const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "submit";
    const rest = sub === "submit" && argv[1]?.startsWith("--") ? argv.slice(1) : argv.slice(2);
    const { flags } = parseFlags(rest);

    const knownSubcommands = new Set(["submit", "wait", "status", "result"]);
    if (!knownSubcommands.has(sub)) {
      printJson({ ok: false, error: `Unknown prompt subcommand '${sub}'.`, help: help() });
      process.exitCode = 1;
      return;
    }

    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const baseUrl = getStringFlag(flags, "base-url") ?? "http://127.0.0.1:4096";
    const ensure = getBoolFlag(flags, "ensure-server", true);
    const opencodeBin = getStringFlag(flags, "opencode-bin") ?? "opencode";
    const permRespRaw = getStringFlag(flags, "permission-response") ?? "always";
    const permissionResponse: PermissionAutoResponse = permRespRaw === "once" ? "once" : "always";

    const autoRejectQuestions = getBoolFlag(flags, "auto-reject-questions", true);
    const denyQuestionsOnCreate = getBoolFlag(flags, "deny-questions-on-create", true);

    const timeoutMs = getIntFlag(flags, "timeout-ms", 20 * 60 * 1000);
    const pollMs = getIntFlag(flags, "poll-ms", 1_000);
    const cancelOnTimeout = getBoolFlag(flags, "cancel-on-timeout", false);
    const messagesLimit = getIntFlag(flags, "messages-limit", 160);

    if (sub === "wait") {
      const runID = getStringFlag(flags, "run-id");
      if (!runID) {
        printJson({ ok: false, error: "Missing --run-id for prompt wait." });
        process.exitCode = 1;
        return;
      }

      const res = await runPromptWait({
        runID,
        ensureServer: ensure,
        opencodeBin,
        timeoutMs,
        pollMs,
        cancelOnTimeout,
        permissionResponse,
        autoRejectQuestions,
        messagesLimit,
      });
      printJson(res);
      if (!res.ok) process.exitCode = 1;
      return;
    }

    if (sub === "status") {
      const runID = getStringFlag(flags, "run-id");
      if (!runID) {
        printJson({ ok: false, error: "Missing --run-id for prompt status." });
        process.exitCode = 1;
        return;
      }
      const res = await runPromptInspect({
        runID,
        ensureServer: ensure,
        opencodeBin,
        messagesLimit,
      });
      printJson(res);
      if (!res.ok) process.exitCode = 1;
      return;
    }

    if (sub === "result") {
      const runID = getStringFlag(flags, "run-id");
      if (!runID) {
        printJson({ ok: false, error: "Missing --run-id for prompt result." });
        process.exitCode = 1;
        return;
      }
      const res = await runPromptResult({
        runID,
        ensureServer: ensure,
        opencodeBin,
        messagesLimit,
      });
      printJson(res);
      if (!res.ok) process.exitCode = 1;
      return;
    }

    const sessionID = getStringFlag(flags, "session-id");
    const title = getStringFlag(flags, "title");
    const cont = getBoolFlag(
      flags,
      "latest",
      getBoolFlag(flags, "continue", sessionID === undefined && title === undefined),
    );

    const agent = getStringFlag(flags, "agent") ?? "build";
    const model = getStringFlag(flags, "model");
    const variant = getStringFlag(flags, "variant");
    const wait = getBoolFlag(flags, "wait", false);
    const force = getBoolFlag(flags, "force", false);
    const dedupeExactWindowMs = getIntFlag(flags, "dedupe-exact-window-ms", 30 * 60 * 1000);
    const dedupeSimilarWindowMs = getIntFlag(flags, "dedupe-similar-window-ms", 10 * 60 * 1000);
    const dedupeSimilarity = Math.max(
      0,
      Math.min(1, getNumberFlag(flags, "dedupe-similarity", 0.92)),
    );

    const textFlag = getStringFlag(flags, "text");
    const stdinText = await readStdinText();
    const text = (textFlag ?? stdinText).trim();
    if (text.length === 0) {
      printJson({ ok: false, error: "Missing --text and no stdin provided." });
      process.exitCode = 1;
      return;
    }

    const res = await runPromptSubmit({
      baseUrl,
      directory,
      ensureServer: ensure,
      opencodeBin,
      wait,
      timeoutMs,
      pollMs,
      cancelOnTimeout,
      permissionResponse,
      autoRejectQuestions,
      denyQuestionsOnCreate,
      force,
      dedupeExactWindowMs,
      dedupeSimilarWindowMs,
      dedupeSimilarity,
      messagesLimit,
      sessionID,
      title,
      cont,
      agent,
      model,
      variant,
      text,
    });

    printJson(res);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printJson({ ok: false, error: `Unknown command '${cmd}'.`, help: help() });
  process.exitCode = 1;
}

await main();
