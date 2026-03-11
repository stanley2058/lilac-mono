import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  promptRunRecordSchema,
  sessionIndexSchema,
  type PromptRunRecord,
  type SessionIndex,
  type SessionIndexEntry,
} from "./types.ts";

function stateBaseDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const base =
    xdgStateHome && xdgStateHome.trim().length > 0
      ? xdgStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "lilac-acp-controller");
}

function runsDir(): string {
  return path.join(stateBaseDir(), "runs");
}

function sessionsDir(): string {
  return path.join(stateBaseDir(), "sessions");
}

function sessionIndexPath(): string {
  return path.join(sessionsDir(), "index.json");
}

function sessionIndexLockPath(): string {
  return path.join(sessionsDir(), "index.lock");
}

function runFilePath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function assertValidRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!/^run_[a-f0-9-]+$/.test(trimmed)) {
    throw new Error(`Invalid run ID '${runId}'.`);
  }
  return trimmed;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSessionIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  const lockPath = sessionIndexLockPath();
  const deadline = Date.now() + 5_000;

  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the session index lock.");
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

export async function saveRunRecord(run: PromptRunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  await atomicWriteFile(runFilePath(run.id), `${JSON.stringify(run)}\n`);
}

export async function loadRunRecord(runId: string): Promise<PromptRunRecord> {
  const safeRunId = assertValidRunId(runId);
  const content = await fs.readFile(runFilePath(safeRunId), "utf8");
  const parsed = promptRunRecordSchema.safeParse(JSON.parse(content) as unknown);
  if (!parsed.success) {
    throw new Error(`Run record '${safeRunId}' is malformed.`);
  }
  return parsed.data;
}

export async function saveSessionIndex(entries: readonly SessionIndexEntry[]): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  const payload: SessionIndex = { version: 1, sessions: [...entries] };
  await atomicWriteFile(sessionIndexPath(), `${JSON.stringify(payload)}\n`);
}

export async function loadSessionIndex(): Promise<SessionIndex> {
  try {
    const content = await fs.readFile(sessionIndexPath(), "utf8");
    const parsed = sessionIndexSchema.safeParse(JSON.parse(content) as unknown);
    if (!parsed.success) {
      return { version: 1, sessions: [] };
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: [] };
    }
    throw error;
  }
}

export async function upsertSessionIndexEntries(
  entries: readonly SessionIndexEntry[],
): Promise<SessionIndex> {
  return withSessionIndexLock(async () => {
    const current = await loadSessionIndex();
    const merged = new Map(current.sessions.map((entry) => [entry.sessionRef, entry]));
    for (const entry of entries) {
      const previous = merged.get(entry.sessionRef);
      merged.set(entry.sessionRef, {
        ...previous,
        ...entry,
        localTitle: entry.localTitle ?? previous?.localTitle,
      });
    }
    const next: SessionIndex = { version: 1, sessions: [...merged.values()] };
    await saveSessionIndex(next.sessions);
    return next;
  });
}

export async function setLocalSessionTitle(
  sessionRef: string,
  localTitle: string,
): Promise<SessionIndex> {
  return withSessionIndexLock(async () => {
    const current = await loadSessionIndex();
    const nextSessions = current.sessions.map((entry) =>
      entry.sessionRef === sessionRef ? { ...entry, localTitle, title: localTitle } : entry,
    );
    const next: SessionIndex = { version: 1, sessions: nextSessions };
    await saveSessionIndex(next.sessions);
    return next;
  });
}
