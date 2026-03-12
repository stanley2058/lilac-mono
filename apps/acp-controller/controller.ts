import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { PromptResponse } from "@agentclientprotocol/sdk";

import { getBoolFlag, getIntFlag, getStringFlag, parseFlags, readStdinText } from "./cli-flags.ts";
import {
  AcpHarnessClient,
  isAuthRequiredError,
  isCancelledStopReason,
} from "./acp-harness-client.ts";
import { getHarnessDescriptor, listResolvedHarnesses, resolveHarness } from "./harness-registry.ts";
import {
  loadRunRecord,
  loadSessionIndex,
  saveRunRecord,
  setLocalSessionTitle,
  upsertSessionIndexEntries,
} from "./run-store.ts";
import { buildSnapshotRuns, SessionHistoryCollector } from "./session-history.ts";
import {
  createEmptyPermissionCounters,
  formatSessionRef,
  normalizeText,
  parseSessionRef,
  textPreview,
  type PromptRunRecord,
  type SessionIndexEntry,
  type SessionSummary,
} from "./types.ts";

declare const PACKAGE_VERSION: string;

type OutputWriter = (value: unknown) => void;
type OutputMode = "json" | "human";

type ListedSession = {
  harnessId: string;
  sessionId: string;
  sessionRef: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  capabilities: string[];
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printText(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatCommand(command: string | undefined, args: readonly string[]): string | undefined {
  if (!command) return undefined;
  return [command, ...args].join(" ");
}

function toListedSession(value: unknown): ListedSession | null {
  if (!isRecord(value)) return null;
  const harnessId = getString(value.harnessId);
  const sessionId = getString(value.sessionId);
  const sessionRef = getString(value.sessionRef);
  const cwd = getString(value.cwd);
  if (!harnessId || !sessionId || !sessionRef || !cwd) return null;
  return {
    harnessId,
    sessionId,
    sessionRef,
    cwd,
    title: getString(value.title),
    updatedAt: getString(value.updatedAt),
    capabilities: getStringArray(value.capabilities),
  };
}

function formatSessionEntries(sessions: readonly ListedSession[]): string[] {
  if (sessions.length === 0) return ["No sessions found."];

  const lines: string[] = [];
  for (const session of sessions) {
    lines.push(`- ${session.title ?? session.sessionRef}`);
    lines.push(`  session: ${session.sessionRef}`);
    lines.push(`  harness: ${session.harnessId}`);
    lines.push(`  cwd: ${session.cwd}`);
    if (session.updatedAt) lines.push(`  updated: ${session.updatedAt}`);
    if (session.capabilities.length > 0) {
      lines.push(`  capabilities: ${session.capabilities.join(", ")}`);
    }
  }
  return lines;
}

function formatWarnings(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return ["Warnings:", ...warnings.map((warning) => `- ${warning}`)];
}

function formatCandidates(value: unknown): string[] {
  const candidates = getRecordArray(value)
    .map((entry) => toListedSession(entry))
    .filter((entry): entry is ListedSession => entry !== null);
  if (candidates.length === 0) return [];
  return ["Candidates:", ...formatSessionEntries(candidates)];
}

function formatHarnessesOutput(value: Record<string, unknown>): string {
  const harnesses = getRecordArray(value.harnesses);
  if (harnesses.length === 0) return "No harnesses found.";

  const lines = [`Harnesses (${harnesses.length})`];
  for (const harness of harnesses) {
    const id = getString(harness.id) ?? "unknown";
    const title = getString(harness.title) ?? id;
    const launchable = getBoolean(harness.launchable) ?? false;
    lines.push(`- ${title} (${id}) ${launchable ? "[available]" : "[unavailable]"}`);

    const description = getString(harness.description);
    if (description) lines.push(`  ${description}`);

    const command = formatCommand(getString(harness.command), getStringArray(harness.args));
    if (command) lines.push(`  command: ${command}`);

    const installHint = getString(harness.installHint);
    if (installHint && !launchable) lines.push(`  install: ${installHint}`);
  }
  return lines.join("\n");
}

function formatSessionsOutput(value: Record<string, unknown>): string {
  const ok = getBoolean(value.ok);
  const error = getString(value.error);
  const sessions = getRecordArray(value.sessions)
    .map((entry) => toListedSession(entry))
    .filter((entry): entry is ListedSession => entry !== null);
  const warnings = getStringArray(value.warnings);

  const lines: string[] = [];
  if (ok === false && error) lines.push(`Error: ${error}`, "");
  lines.push(`Sessions (${sessions.length})`, ...formatSessionEntries(sessions));

  const candidateLines = formatCandidates(value.candidates);
  if (candidateLines.length > 0) lines.push("", ...candidateLines);

  const warningLines = formatWarnings(warnings);
  if (warningLines.length > 0) lines.push("", ...warningLines);
  return lines.join("\n");
}

function formatSnapshotPlan(value: unknown): string[] {
  const entries = getRecordArray(value);
  if (entries.length === 0) return ["Plan: none"];

  return [
    "Plan:",
    ...entries.map((entry) => {
      const content = getString(entry.content) ?? "(missing content)";
      const status = getString(entry.status) ?? "unknown";
      const priority = getString(entry.priority) ?? "unknown";
      return `- [${status}/${priority}] ${content}`;
    }),
  ];
}

function formatRecentRuns(value: unknown): string[] {
  if (!isRecord(value)) return ["Recent turns: none"];
  const runs = getRecordArray(value.runs);
  if (runs.length === 0) return ["Recent turns: none"];

  const lines = ["Recent turns:"];
  for (const run of runs) {
    const user = isRecord(run.user) ? getString(run.user.text) : undefined;
    const assistant = isRecord(run.assistant) ? getString(run.assistant.text) : undefined;
    lines.push(`- User: ${user ?? ""}`);
    lines.push(`  Assistant: ${assistant ?? "(no assistant reply)"}`);
  }
  return lines;
}

function formatSnapshotOutput(value: Record<string, unknown>): string {
  const ok = getBoolean(value.ok);
  const error = getString(value.error);
  const session = isRecord(value.session) ? value.session : undefined;
  const meta = isRecord(value.meta) ? value.meta : undefined;
  const lines: string[] = [];

  if (ok === false && error) {
    lines.push(`Error: ${error}`);
    const sessionRef = getString(value.sessionRef);
    if (sessionRef) lines.push(`Session: ${sessionRef}`);
    return lines.join("\n");
  }

  const title = session ? getString(session.title) : undefined;
  const sessionRef = getString(value.sessionRef);
  const sessionId = getString(value.sessionId);
  lines.push(title ? `Session snapshot: ${title}` : "Session snapshot");
  if (sessionRef) lines.push(`Session: ${sessionRef}`);
  else if (sessionId) lines.push(`Session ID: ${sessionId}`);

  const harnessId = getString(value.harnessId) ?? (meta ? getString(meta.harnessId) : undefined);
  if (harnessId) lines.push(`Harness: ${harnessId}`);

  const cwd = session ? getString(session.cwd) : undefined;
  if (cwd) lines.push(`Directory: ${cwd}`);

  const updatedAt = session ? getString(session.updatedAt) : undefined;
  if (updatedAt) lines.push(`Updated: ${updatedAt}`);

  const capabilities = meta ? getStringArray(meta.capabilities) : [];
  if (capabilities.length > 0) lines.push(`Capabilities: ${capabilities.join(", ")}`);

  lines.push("", ...formatSnapshotPlan(value.plan), "", ...formatRecentRuns(value.recent));
  return lines.join("\n");
}

function formatRunOutput(value: Record<string, unknown>): string {
  const runId = getString(value.runId) ?? "unknown";
  const status = getString(value.status);
  const error = getString(value.error);
  const resultText = getString(value.resultText);
  const harnessId = getString(value.harnessId);
  const sessionRef = getString(value.sessionRef);
  const workerPid =
    getNumber(value.workerPid) ??
    (isRecord(value.run) ? getNumber(value.run.workerPid) : undefined);
  const signalled = getBoolean(value.signalled);

  const lines: string[] = [];
  if (status) {
    lines.push(`Run ${runId}: ${status}`);
  } else {
    lines.push(`Run ${runId}`);
  }

  if (harnessId) lines.push(`Harness: ${harnessId}`);
  if (sessionRef) lines.push(`Session: ${sessionRef}`);
  if (workerPid !== undefined) lines.push(`Worker PID: ${workerPid}`);
  if (signalled !== undefined) lines.push(`Signal sent: ${signalled ? "yes" : "no"}`);
  if (error) lines.push(`Error: ${error}`);
  if (resultText) lines.push("", resultText);

  const candidateLines = formatCandidates(value.candidates);
  if (candidateLines.length > 0) lines.push("", ...candidateLines);

  return lines.join("\n").trim();
}

function formatHelpOutput(value: Record<string, unknown>): string {
  const helpText = getString(value.help) ?? "";
  const error = getString(value.error);
  const version = getString(value.version);
  const lines: string[] = [];
  if (error) lines.push(`Error: ${error}`, "");
  lines.push(helpText);
  if (version) lines.push("", `Version: ${version}`);
  return lines.join("\n");
}

function formatHumanOutput(value: unknown, commandName: string): string {
  if (!isRecord(value)) {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  if (typeof value.help === "string") return formatHelpOutput(value);
  if (Array.isArray(value.harnesses)) return formatHarnessesOutput(value);
  if (Array.isArray(value.sessions)) return formatSessionsOutput(value);
  if (isRecord(value.session) && isRecord(value.recent)) return formatSnapshotOutput(value);
  if (typeof value.runId === "string") return formatRunOutput(value);

  const version = getString(value.version);
  if (version && Object.keys(value).every((key) => key === "ok" || key === "version")) {
    return `${commandName} ${version}`;
  }

  const error = getString(value.error);
  if (error) {
    const lines = [`Error: ${error}`];
    const candidateLines = formatCandidates(value.candidates);
    if (candidateLines.length > 0) lines.push("", ...candidateLines);
    return lines.join("\n");
  }

  return JSON.stringify(value, null, 2);
}

function createOutputWriter(mode: OutputMode, commandName: string): OutputWriter {
  if (mode === "json") return printJson;
  return (value: unknown) => {
    printText(formatHumanOutput(value, commandName));
  };
}

function stripGlobalFlags(args: readonly string[]): string[] {
  const stripped: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--output") {
      index++;
      continue;
    }
    if (arg.startsWith("--output=")) {
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function compareUpdatedAtDesc(left?: string, right?: string): number {
  const leftValue = left ? Date.parse(left) : 0;
  const rightValue = right ? Date.parse(right) : 0;
  return rightValue - leftValue;
}

function sortSessions(sessions: ListedSession[]): ListedSession[] {
  return sessions.sort((left, right) => {
    const updatedComparison = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
    if (updatedComparison !== 0) return updatedComparison;
    return (left.title ?? left.sessionRef).localeCompare(right.title ?? right.sessionRef);
  });
}

function sessionMatchesSearch(session: ListedSession, search: string | undefined): boolean {
  if (!search) return true;
  const needle = normalizeText(search);
  return [session.title, session.cwd, session.sessionRef, session.sessionId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeText(value).includes(needle));
}

function buildIndexEntry(session: ListedSession, localTitle?: string): SessionIndexEntry {
  return {
    sessionRef: session.sessionRef,
    harnessId: session.harnessId,
    remoteSessionId: session.sessionId,
    cwd: session.cwd,
    title: localTitle ?? session.title,
    updatedAt: session.updatedAt,
    capabilities: session.capabilities,
    lastSeenAt: Date.now(),
    ...(localTitle ? { localTitle } : {}),
  };
}

function mergeSessionWithIndex(
  live: ListedSession,
  indexed: SessionIndexEntry | undefined,
): ListedSession {
  return {
    ...live,
    title: indexed?.localTitle ?? live.title,
    updatedAt: live.updatedAt ?? indexed?.updatedAt,
    capabilities: live.capabilities.length > 0 ? live.capabilities : (indexed?.capabilities ?? []),
  };
}

function listedSessionFromIndex(entry: SessionIndexEntry): ListedSession {
  return {
    harnessId: entry.harnessId,
    sessionId: entry.remoteSessionId,
    sessionRef: entry.sessionRef,
    title: entry.localTitle ?? entry.title,
    cwd: entry.cwd,
    updatedAt: entry.updatedAt,
    capabilities: entry.capabilities,
  };
}

function capabilitiesFromSummary(summary: SessionSummary | undefined): string[] {
  return summary?.capabilities ?? [];
}

function isTerminalStatus(status: PromptRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function refreshRunStatus(run: PromptRunRecord): Promise<PromptRunRecord> {
  if (isTerminalStatus(run.status)) return run;

  if (run.status === "submitted" && !run.cancelRequestedAt && !isProcessAlive(run.workerPid)) {
    const workerPid = await spawnWorker(run.id);
    if (workerPid) {
      const restarted: PromptRunRecord = {
        ...run,
        workerPid,
        updatedAt: Date.now(),
      };
      await saveRunRecord(restarted);
      return restarted;
    }
  }

  if (run.workerPid && isProcessAlive(run.workerPid)) return run;
  const next: PromptRunRecord = {
    ...run,
    status: run.cancelRequestedAt ? "cancelled" : "failed",
    updatedAt: Date.now(),
    error:
      run.error ??
      (run.cancelRequestedAt
        ? "Prompt cancelled before the worker produced a terminal result."
        : "Background worker exited before producing a terminal result."),
  };
  await saveRunRecord(next);
  return next;
}

async function collectSessionsForHarness(params: {
  harnessId: string;
  directory: string;
  version: string;
  search?: string;
}): Promise<{ sessions: ListedSession[]; warning?: string }> {
  const indexed = await loadSessionIndex();
  const descriptor = getHarnessDescriptor(params.harnessId);
  if (!descriptor) {
    throw new Error(`Unknown harness '${params.harnessId}'.`);
  }

  const resolved = await resolveHarness(params.harnessId);
  const cachedSessions = indexed.sessions
    .filter((entry) => entry.harnessId === params.harnessId && entry.cwd === params.directory)
    .map(listedSessionFromIndex);

  if (!resolved) {
    return {
      sessions: sortSessions(
        cachedSessions.filter((entry) => sessionMatchesSearch(entry, params.search)),
      ),
      warning: descriptor.installHint,
    };
  }

  const client = await AcpHarnessClient.connect({
    harness: resolved,
    version: params.version,
    permissionBehavior: "reject",
    counters: createEmptyPermissionCounters(),
  });

  try {
    const listed = await client.listSessions(params.directory).catch((error: unknown) => {
      if (isAuthRequiredError(error)) {
        throw new Error(client.authHint() ?? errorMessage(error));
      }
      throw error;
    });

    const liveSessions = listed.map((session) => {
      const sessionRef = formatSessionRef(params.harnessId, session.sessionId);
      const cached = indexed.sessions.find((entry) => entry.sessionRef === sessionRef);
      return mergeSessionWithIndex(
        {
          harnessId: params.harnessId,
          sessionId: session.sessionId,
          sessionRef,
          title: session.title ?? undefined,
          cwd: session.cwd,
          updatedAt: session.updatedAt ?? undefined,
          capabilities: client.capabilities(),
        },
        cached,
      );
    });

    await upsertSessionIndexEntries(liveSessions.map((session) => buildIndexEntry(session)));

    return {
      sessions: sortSessions(
        liveSessions.filter((entry) => sessionMatchesSearch(entry, params.search)),
      ),
      ...(client.authHint() ? { warning: client.authHint() } : {}),
    };
  } finally {
    await client.close();
  }
}

async function collectSessions(params: {
  harnessId?: string;
  directory: string;
  version: string;
  search?: string;
}): Promise<{ sessions: ListedSession[]; warnings: string[] }> {
  const harnessIds =
    params.harnessId && params.harnessId !== "any"
      ? [params.harnessId]
      : (await listResolvedHarnesses()).map((entry) => entry.descriptor.id);
  const warnings: string[] = [];
  const sessions: ListedSession[] = [];

  for (const harnessId of harnessIds) {
    const collected = await collectSessionsForHarness({
      harnessId,
      directory: params.directory,
      version: params.version,
      search: params.search,
    }).catch((error: unknown) => ({
      sessions: [] as ListedSession[],
      warning: `Harness '${harnessId}': ${errorMessage(error)}`,
    }));
    sessions.push(...collected.sessions);
    if (collected.warning) warnings.push(collected.warning);
  }

  return { sessions: sortSessions(sessions), warnings };
}

async function resolveExistingSessionTarget(params: {
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  harnessId?: string;
  directory: string;
  version: string;
}): Promise<{
  harnessId: string;
  remoteSessionId?: string;
  sessionRef?: string;
  targetKind: "new" | "existing";
  requestedTitle?: string;
  candidates?: ListedSession[];
}> {
  if (params.sessionIdFlag) {
    const parsed = parseSessionRef(params.sessionIdFlag);
    if (parsed) {
      if (params.harnessId && params.harnessId !== "any" && params.harnessId !== parsed.harnessId) {
        throw new Error(
          `--session-id points to harness '${parsed.harnessId}', not '${params.harnessId}'.`,
        );
      }
      return {
        harnessId: parsed.harnessId,
        remoteSessionId: parsed.remoteSessionId,
        sessionRef: params.sessionIdFlag,
        targetKind: "existing",
      };
    }

    if (!params.harnessId || params.harnessId === "any") {
      throw new Error("Raw --session-id values require --harness.");
    }

    return {
      harnessId: params.harnessId,
      remoteSessionId: params.sessionIdFlag,
      sessionRef: formatSessionRef(params.harnessId, params.sessionIdFlag),
      targetKind: "existing",
    };
  }

  if (params.latest) {
    if (!params.harnessId || params.harnessId === "any") {
      throw new Error("--latest requires --harness.");
    }
    const collected = await collectSessions({
      harnessId: params.harnessId,
      directory: params.directory,
      version: params.version,
    });
    const latest = collected.sessions[0];
    if (!latest) {
      throw new Error(`No sessions found for harness '${params.harnessId}'.`);
    }
    return {
      harnessId: latest.harnessId,
      remoteSessionId: latest.sessionId,
      sessionRef: latest.sessionRef,
      targetKind: "existing",
    };
  }

  if (params.title) {
    if (params.harnessId && params.harnessId !== "any") {
      const collected = await collectSessions({
        harnessId: params.harnessId,
        directory: params.directory,
        version: params.version,
        search: params.title,
      });
      const exactMatch = collected.sessions.find((session) => session.title === params.title);
      if (exactMatch) {
        return {
          harnessId: exactMatch.harnessId,
          remoteSessionId: exactMatch.sessionId,
          sessionRef: exactMatch.sessionRef,
          targetKind: "existing",
        };
      }
      return {
        harnessId: params.harnessId,
        targetKind: "new",
        requestedTitle: params.title,
        candidates: collected.sessions,
      };
    }

    const collected = await collectSessions({
      directory: params.directory,
      version: params.version,
      search: params.title,
    });
    const exactMatches = collected.sessions.filter((session) => session.title === params.title);
    if (exactMatches.length === 1) {
      const [match] = exactMatches;
      if (!match) throw new Error("Expected an exact match.");
      return {
        harnessId: match.harnessId,
        remoteSessionId: match.sessionId,
        sessionRef: match.sessionRef,
        targetKind: "existing",
      };
    }

    if (exactMatches.length > 1) {
      return {
        harnessId: "",
        targetKind: "existing",
        candidates: exactMatches,
      };
    }

    return {
      harnessId: "",
      targetKind: "existing",
      candidates: collected.sessions,
    };
  }

  if (params.harnessId && params.harnessId !== "any") {
    return {
      harnessId: params.harnessId,
      targetKind: "new",
    };
  }

  throw new Error("No session selector matched. Use --harness to create a new session.");
}

async function spawnWorker(runId: string): Promise<number | undefined> {
  const entryPoint = process.env.LILAC_ACP_ENTRYPOINT ?? process.argv[1];
  if (!entryPoint) {
    throw new Error("Cannot determine the CLI entrypoint for worker spawning.");
  }

  const child = spawn(process.execPath, [entryPoint, "_worker", "run", "--run-id", runId], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LILAC_ACP_ENTRYPOINT: entryPoint,
    },
  });
  child.unref();
  return child.pid;
}

function help(commandName: string): string {
  return [
    `${commandName} (ACP harness controller)`,
    "",
    "Usage:",
    `  ${commandName} harnesses list`,
    `  ${commandName} sessions list [--directory <path>] [--harness <id|any>] [--search <term>] [--limit <n>]`,
    `  ${commandName} sessions snapshot [--directory <path>] [--harness <id>] [--session-id <ref> | --title <title> | --latest] [--runs <n>] [--max-chars <n>]`,
    `  ${commandName} prompt submit --text <msg> [--directory <path>] [--harness <id>] [--session-id <ref> | --title <title> | --latest] [--agent <mode>] [--model <model-id>] [--wait]`,
    `  ${commandName} prompt status --run-id <id>`,
    `  ${commandName} prompt result --run-id <id>`,
    `  ${commandName} prompt wait --run-id <id> [--timeout-ms <n>] [--poll-ms <n>]`,
    `  ${commandName} prompt cancel --run-id <id>`,
    "",
    "Global options:",
    "  --output <json|human>   Output format (default: json).",
    "",
    "Notes:",
    "  - --latest requires --harness.",
    "  - --title without --harness continues only when exactly one exact match exists.",
    "  - New sessions require --harness so the controller knows where to create them.",
  ].join("\n");
}

async function runHarnessesList(version: string, write: OutputWriter): Promise<number> {
  const harnesses = await listResolvedHarnesses();
  write({
    ok: true,
    harnesses: harnesses.map((entry) => ({
      id: entry.descriptor.id,
      title: entry.descriptor.title,
      description: entry.descriptor.description,
      launchable: entry.launchable,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      installHint: entry.descriptor.installHint,
      version,
    })),
  });
  return 0;
}

async function runSessionsList(params: {
  directory: string;
  harnessId?: string;
  search?: string;
  limit: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const collected = await collectSessions({
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
    search: params.search,
  });
  const sessions =
    params.limit > 0 ? collected.sessions.slice(0, params.limit) : collected.sessions;
  params.write({
    ok: true,
    sessions,
    ...(collected.warnings.length > 0 ? { warnings: collected.warnings } : {}),
  });
  return 0;
}

async function runSessionsSnapshot(params: {
  directory: string;
  harnessId?: string;
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  maxRuns: number;
  maxChars: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const target = await resolveExistingSessionTarget({
    sessionIdFlag: params.sessionIdFlag,
    title: params.title,
    latest: params.latest,
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
  });

  if (!target.remoteSessionId || !target.sessionRef) {
    params.write({
      ok: false,
      error:
        params.title && !params.harnessId
          ? `No unique exact title match found for '${params.title}'.`
          : "sessions snapshot requires an existing session selector.",
      ...(target.candidates ? { candidates: target.candidates } : {}),
    });
    return 1;
  }

  const resolvedHarness = await resolveHarness(target.harnessId);
  if (!resolvedHarness) {
    const descriptor = getHarnessDescriptor(target.harnessId);
    params.write({
      ok: false,
      error: descriptor?.installHint ?? `Harness '${target.harnessId}' is not launchable.`,
    });
    return 1;
  }

  const collector = new SessionHistoryCollector();
  const client = await AcpHarnessClient.connect({
    harness: resolvedHarness,
    version: params.version,
    permissionBehavior: "reject",
    counters: createEmptyPermissionCounters(),
    onUpdate: (notification) => collector.add(notification),
  });

  try {
    await client.loadSession(target.remoteSessionId, params.directory);
    params.write({
      ok: true,
      harnessId: target.harnessId,
      sessionId: target.remoteSessionId,
      sessionRef: target.sessionRef,
      session: {
        id: target.remoteSessionId,
        title: collector.title,
        cwd: params.directory,
        updatedAt: collector.updatedAt,
      },
      ...(collector.plan ? { plan: collector.plan } : {}),
      recent: {
        runs: buildSnapshotRuns(collector.history, params.maxRuns, params.maxChars),
      },
      ...(collector.history.length > 0 ? { history: collector.history } : {}),
      meta: {
        directory: params.directory,
        harnessId: target.harnessId,
        capabilities: client.capabilities(),
      },
    });
    return 0;
  } catch (error) {
    params.write({
      ok: false,
      error: errorMessage(error),
      harnessId: target.harnessId,
      sessionRef: target.sessionRef,
    });
    return 1;
  } finally {
    await client.close();
  }
}

async function runPromptSubmit(params: {
  directory: string;
  harnessId?: string;
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  text: string;
  requestedMode?: string;
  requestedModel?: string;
  wait: boolean;
  timeoutMs: number;
  pollMs: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const target = await resolveExistingSessionTarget({
    sessionIdFlag: params.sessionIdFlag,
    title: params.title,
    latest: params.latest,
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
  });

  if (!target.harnessId) {
    params.write({
      ok: false,
      error: params.title
        ? `Expected exactly one exact title match for '${params.title}'.`
        : "Unable to resolve a harness for prompt submission.",
      ...(target.candidates ? { candidates: target.candidates } : {}),
    });
    return 1;
  }

  const resolvedHarness = await resolveHarness(target.harnessId);
  if (!resolvedHarness) {
    const descriptor = getHarnessDescriptor(target.harnessId);
    params.write({
      ok: false,
      error: descriptor?.installHint ?? `Harness '${target.harnessId}' is not launchable.`,
    });
    return 1;
  }

  const runId = `run_${randomUUID()}`;
  const run: PromptRunRecord = {
    id: runId,
    status: "submitted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    directory: params.directory,
    harnessId: target.harnessId,
    targetKind: target.targetKind,
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    ...(target.sessionRef ? { sessionRef: target.sessionRef } : {}),
    ...(target.requestedTitle ? { requestedTitle: target.requestedTitle } : {}),
    promptText: params.text,
    textPreview: textPreview(params.text, 240),
    ...(params.requestedMode ? { requestedMode: params.requestedMode } : {}),
    ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
    permissions: createEmptyPermissionCounters(),
  };

  await saveRunRecord(run);
  const workerPid = await spawnWorker(runId);
  const withWorker: PromptRunRecord = {
    ...run,
    ...(workerPid ? { workerPid } : {}),
    updatedAt: Date.now(),
  };
  await saveRunRecord(withWorker);

  if (params.wait) {
    return runPromptWait({
      runId,
      timeoutMs: params.timeoutMs,
      pollMs: params.pollMs,
      write: params.write,
    });
  }

  params.write({
    ok: true,
    runId,
    status: withWorker.status,
    harnessId: withWorker.harnessId,
    ...(withWorker.sessionRef ? { sessionRef: withWorker.sessionRef } : {}),
    ...(withWorker.workerPid ? { workerPid: withWorker.workerPid } : {}),
    run: withWorker,
  });
  return 0;
}

async function runPromptInspect(params: { runId: string; write: OutputWriter }): Promise<number> {
  try {
    const run = await refreshRunStatus(await loadRunRecord(params.runId));
    params.write({
      ok: true,
      runId: run.id,
      status: run.status,
      harnessId: run.harnessId,
      ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
      run,
    });
    return 0;
  } catch (error) {
    params.write({ ok: false, error: errorMessage(error), runId: params.runId });
    return 1;
  }
}

async function runPromptResult(params: { runId: string; write: OutputWriter }): Promise<number> {
  try {
    const run = await refreshRunStatus(await loadRunRecord(params.runId));
    if (!isTerminalStatus(run.status)) {
      params.write({
        ok: false,
        error: `Run '${params.runId}' is not finished yet (status=${run.status}).`,
        runId: params.runId,
        status: run.status,
      });
      return 1;
    }
    params.write({
      ok: run.status === "completed",
      runId: run.id,
      status: run.status,
      harnessId: run.harnessId,
      ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
      ...(run.resultText ? { resultText: run.resultText } : {}),
      ...(run.error ? { error: run.error } : {}),
      run,
    });
    return run.status === "completed" ? 0 : 1;
  } catch (error) {
    params.write({ ok: false, error: errorMessage(error), runId: params.runId });
    return 1;
  }
}

async function runPromptWait(params: {
  runId: string;
  timeoutMs: number;
  pollMs: number;
  write: OutputWriter;
}): Promise<number> {
  const startedAt = Date.now();

  while (true) {
    const run = await refreshRunStatus(await loadRunRecord(params.runId));
    if (isTerminalStatus(run.status)) {
      params.write({
        ok: run.status === "completed",
        runId: run.id,
        status: run.status,
        harnessId: run.harnessId,
        ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
        ...(run.resultText ? { resultText: run.resultText } : {}),
        ...(run.error ? { error: run.error } : {}),
        run,
      });
      return run.status === "completed" ? 0 : 1;
    }

    if (Date.now() - startedAt >= params.timeoutMs) {
      params.write({
        ok: false,
        runId: params.runId,
        error: `Timed out after ${params.timeoutMs}ms.`,
      });
      return 1;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(50, params.pollMs)));
  }
}

async function runPromptCancel(params: { runId: string; write: OutputWriter }): Promise<number> {
  try {
    const run = await loadRunRecord(params.runId);
    if (isTerminalStatus(run.status)) {
      params.write({
        ok: false,
        runId: params.runId,
        error: `Run '${params.runId}' already finished with status '${run.status}'.`,
      });
      return 1;
    }
    const next: PromptRunRecord = {
      ...run,
      cancelRequestedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveRunRecord(next);

    if (!run.workerPid || !isProcessAlive(run.workerPid)) {
      params.write({
        ok: true,
        runId: params.runId,
        signalled: false,
      });
      return 0;
    }
    process.kill(run.workerPid, "SIGTERM");
    params.write({
      ok: true,
      runId: params.runId,
      signalled: true,
      workerPid: run.workerPid,
    });
    return 0;
  } catch (error) {
    params.write({ ok: false, error: errorMessage(error), runId: params.runId });
    return 1;
  }
}

async function persistRunFromCollector(
  run: PromptRunRecord,
  collector: SessionHistoryCollector,
): Promise<void> {
  const next: PromptRunRecord = {
    ...run,
    updatedAt: Date.now(),
    ...(run.session
      ? {
          session: {
            ...run.session,
            title: collector.title ?? run.session.title,
            updatedAt: collector.updatedAt ?? run.session.updatedAt,
          },
        }
      : run.sessionRef
        ? {
            session: {
              title: collector.title ?? run.requestedTitle,
              cwd: run.directory,
              updatedAt: collector.updatedAt,
              capabilities: capabilitiesFromSummary(run.session),
            },
          }
        : {}),
    ...(collector.plan ? { plan: collector.plan } : {}),
    ...(collector.history.length > 0 ? { history: collector.history } : {}),
    ...(collector.latestAssistantText() ? { resultText: collector.latestAssistantText() } : {}),
  };
  Object.assign(run, next);
  await saveRunRecord(run);
}

async function runWorkerProcess(runId: string, version: string): Promise<number> {
  const run = await loadRunRecord(runId);
  const resolvedHarness = await resolveHarness(run.harnessId);
  if (!resolvedHarness) {
    const failed: PromptRunRecord = {
      ...run,
      status: "failed",
      updatedAt: Date.now(),
      error:
        getHarnessDescriptor(run.harnessId)?.installHint ??
        `Harness '${run.harnessId}' is not launchable.`,
    };
    await saveRunRecord(failed);
    return 1;
  }

  const collector = new SessionHistoryCollector();
  const client = await AcpHarnessClient.connect({
    harness: resolvedHarness,
    version,
    permissionBehavior: "always",
    counters: run.permissions,
    onUpdate: async (notification) => {
      collector.add(notification);
      await persistRunFromCollector(run, collector);
    },
  }).catch(async (error: unknown) => {
    const failed: PromptRunRecord = {
      ...run,
      status: "failed",
      updatedAt: Date.now(),
      error: errorMessage(error),
    };
    await saveRunRecord(failed);
    throw error;
  });

  let signalCleanup: (() => void) | undefined;
  let remoteSessionId = run.remoteSessionId;
  let cancellationRequested = false;

  try {
    const onTerminate = () => {
      cancellationRequested = true;
      if (remoteSessionId) {
        void client.cancel(remoteSessionId).catch(() => {});
      }
    };
    process.on("SIGTERM", onTerminate);
    process.on("SIGINT", onTerminate);
    signalCleanup = () => {
      process.off("SIGTERM", onTerminate);
      process.off("SIGINT", onTerminate);
    };

    if (run.targetKind === "existing") {
      if (!remoteSessionId) {
        throw new Error(`Run '${run.id}' is missing its remote session ID.`);
      }
      await client.loadSession(remoteSessionId, run.directory);
    } else {
      const created = await client.createSession(run.directory);
      remoteSessionId = created.sessionId;
      run.remoteSessionId = remoteSessionId;
      run.sessionRef = formatSessionRef(run.harnessId, remoteSessionId);
      await upsertSessionIndexEntries([
        {
          sessionRef: run.sessionRef,
          harnessId: run.harnessId,
          remoteSessionId,
          cwd: run.directory,
          title: run.requestedTitle,
          updatedAt: undefined,
          capabilities: client.capabilities(),
          lastSeenAt: Date.now(),
          ...(run.requestedTitle ? { localTitle: run.requestedTitle } : {}),
        },
      ]);
      if (run.requestedTitle) {
        await setLocalSessionTitle(run.sessionRef, run.requestedTitle);
      }
    }

    if (!remoteSessionId || !run.sessionRef) {
      throw new Error(`Run '${run.id}' could not resolve a session target.`);
    }
    const activeSessionId = remoteSessionId;

    run.session = {
      title: run.requestedTitle,
      cwd: run.directory,
      updatedAt: collector.updatedAt,
      capabilities: client.capabilities(),
    };
    run.status = "running";
    run.userMessageId = randomUUID();
    run.updatedAt = Date.now();
    await saveRunRecord(run);

    const refreshedRun = await loadRunRecord(run.id);
    if (cancellationRequested || refreshedRun.cancelRequestedAt) {
      run.status = "cancelled";
      run.updatedAt = Date.now();
      run.error = "Cancelled before prompt submission completed.";
      await saveRunRecord(run);
      return 1;
    }

    if (run.requestedMode) {
      await client.setMode(activeSessionId, run.requestedMode);
    }
    if (run.requestedModel) {
      await client.setModel(activeSessionId, run.requestedModel);
    }

    const promptResponse: PromptResponse = await client.prompt(
      activeSessionId,
      run.promptText,
      run.userMessageId,
    );

    run.stopReason = promptResponse.stopReason;
    run.status =
      cancellationRequested || isCancelledStopReason(promptResponse.stopReason)
        ? "cancelled"
        : "completed";
    run.updatedAt = Date.now();
    await persistRunFromCollector(run, collector);
    await upsertSessionIndexEntries([
      buildIndexEntry(
        {
          harnessId: run.harnessId,
          sessionId: activeSessionId,
          sessionRef: run.sessionRef,
          title: collector.title ?? run.requestedTitle,
          cwd: run.directory,
          updatedAt: collector.updatedAt,
          capabilities: client.capabilities(),
        },
        run.requestedTitle,
      ),
    ]);
    return run.status === "completed" ? 0 : 1;
  } catch (error) {
    const authHint = client.authHint();
    const next: PromptRunRecord = {
      ...run,
      status: run.status === "cancelled" || cancellationRequested ? "cancelled" : "failed",
      updatedAt: Date.now(),
      error:
        run.status === "cancelled" || cancellationRequested
          ? (run.error ?? "Prompt cancelled.")
          : authHint && isAuthRequiredError(error)
            ? authHint
            : errorMessage(error),
    };
    await saveRunRecord(next);
    return 1;
  } finally {
    signalCleanup?.();
    await client.close();
  }
}

export async function main(
  argv: readonly string[],
  options?: { write?: OutputWriter },
): Promise<number> {
  const commandName = "lilac-acp";
  const packageVersion = typeof PACKAGE_VERSION === "string" ? PACKAGE_VERSION : "0.0.0";
  const globalFlags = parseFlags(argv).flags;
  const cleanArgv = stripGlobalFlags(argv);
  const outputFlag = getStringFlag(globalFlags, "output");
  if (outputFlag && outputFlag !== "json" && outputFlag !== "human") {
    printJson({
      ok: false,
      error: `Invalid --output value '${outputFlag}' (expected json|human).`,
    });
    return 1;
  }
  const outputMode: OutputMode = outputFlag === "human" ? "human" : "json";
  const write = options?.write ?? createOutputWriter(outputMode, commandName);

  if (cleanArgv.length === 0 || cleanArgv[0] === "help" || cleanArgv.includes("--help")) {
    write({ ok: true, help: help(commandName), version: packageVersion });
    return 0;
  }

  if (cleanArgv[0] === "--version" || cleanArgv[0] === "-v") {
    write({ ok: true, version: packageVersion });
    return 0;
  }

  if (cleanArgv[0] === "_worker") {
    const { flags, positionals } = parseFlags(cleanArgv.slice(1));
    if ((positionals[0] ?? "") !== "run") {
      write({ ok: false, error: "Unknown worker subcommand." });
      return 1;
    }
    const runId = getStringFlag(flags, "run-id");
    if (!runId) {
      write({ ok: false, error: "Missing --run-id for worker." });
      return 1;
    }
    return runWorkerProcess(runId, packageVersion);
  }

  const command = cleanArgv[0] ?? "";

  if (command === "harnesses") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "list";
    if (subcommand !== "list") {
      write({
        ok: false,
        error: `Unknown harnesses subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }
    return runHarnessesList(packageVersion, write);
  }

  if (command === "sessions") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "list";
    const rest =
      subcommand === "list" || subcommand === "snapshot" ? cleanArgv.slice(2) : cleanArgv.slice(1);
    const { flags } = parseFlags(rest);
    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const harnessId = getStringFlag(flags, "harness");

    if (subcommand === "snapshot") {
      return runSessionsSnapshot({
        directory,
        harnessId,
        sessionIdFlag: getStringFlag(flags, "session-id"),
        title: getStringFlag(flags, "title"),
        latest: getBoolFlag(flags, "latest", false),
        maxRuns: getIntFlag(flags, "runs", 6),
        maxChars: getIntFlag(flags, "max-chars", 1200),
        version: packageVersion,
        write,
      });
    }

    if (subcommand !== "list") {
      write({
        ok: false,
        error: `Unknown sessions subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }

    return runSessionsList({
      directory,
      harnessId,
      search: getStringFlag(flags, "search"),
      limit: getIntFlag(flags, "limit", 20),
      version: packageVersion,
      write,
    });
  }

  if (command === "prompt") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "submit";
    const rest =
      subcommand === "submit" && cleanArgv[1]?.startsWith("--")
        ? cleanArgv.slice(1)
        : cleanArgv.slice(2);
    const { flags } = parseFlags(rest);

    if (!new Set(["submit", "status", "result", "wait", "cancel"]).has(subcommand)) {
      write({
        ok: false,
        error: `Unknown prompt subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }

    if (getStringFlag(flags, "variant")) {
      write({ ok: false, error: "--variant is not supported by lilac-acp." });
      return 1;
    }

    if (subcommand === "status") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt status." });
        return 1;
      }
      return runPromptInspect({ runId, write });
    }

    if (subcommand === "result") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt result." });
        return 1;
      }
      return runPromptResult({ runId, write });
    }

    if (subcommand === "wait") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt wait." });
        return 1;
      }
      return runPromptWait({
        runId,
        timeoutMs: getIntFlag(flags, "timeout-ms", 20 * 60 * 1000),
        pollMs: getIntFlag(flags, "poll-ms", 1000),
        write,
      });
    }

    if (subcommand === "cancel") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt cancel." });
        return 1;
      }
      return runPromptCancel({ runId, write });
    }

    const textFlag = getStringFlag(flags, "text");
    const text = (textFlag ?? (await readStdinText())).trim();
    if (text.length === 0) {
      write({ ok: false, error: "Missing --text and no stdin provided." });
      return 1;
    }

    return runPromptSubmit({
      directory: getStringFlag(flags, "directory") ?? process.cwd(),
      harnessId: getStringFlag(flags, "harness"),
      sessionIdFlag: getStringFlag(flags, "session-id"),
      title: getStringFlag(flags, "title"),
      latest: getBoolFlag(flags, "latest", false),
      text,
      requestedMode: getStringFlag(flags, "agent"),
      requestedModel: getStringFlag(flags, "model"),
      wait: getBoolFlag(flags, "wait", false),
      timeoutMs: getIntFlag(flags, "timeout-ms", 20 * 60 * 1000),
      pollMs: getIntFlag(flags, "poll-ms", 1000),
      version: packageVersion,
      write,
    });
  }

  write({ ok: false, error: `Unknown command '${command}'.`, help: help(commandName) });
  return 1;
}
