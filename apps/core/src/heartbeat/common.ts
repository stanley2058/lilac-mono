import type { ModelMessage } from "ai";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { resolveHeartbeatPromptPaths } from "@stanley2058/lilac-utils";

export const HEARTBEAT_SESSION_ID = "__heartbeat__";
export const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";
const HEARTBEAT_SESSION_ALIAS = "heartbeat";

export type HeartbeatWakeReason = "interval" | "retry";

export type HeartbeatQuietState = {
  inside: boolean;
  label: "inside" | "outside";
  timezone?: string;
  localTime?: string;
};

export function isHeartbeatSessionId(sessionId: string): boolean {
  return sessionId === HEARTBEAT_SESSION_ID;
}

export function isHeartbeatAckText(finalText: string): boolean {
  return finalText.trim() === HEARTBEAT_OK_TOKEN;
}

export function resolveHeartbeatModelOverride(cfg: {
  surface?: {
    router?: {
      sessionModes?: Record<string, { model?: string } | undefined>;
    };
  };
}): string | undefined {
  const sessionModes = cfg.surface?.router?.sessionModes;
  const direct = sessionModes?.[HEARTBEAT_SESSION_ID]?.model?.trim();
  if (direct) return direct;

  const alias = sessionModes?.[HEARTBEAT_SESSION_ALIAS]?.model?.trim();
  if (alias) return alias;

  return undefined;
}

export function getHeartbeatQuietState(params: {
  nowMs: number;
  quietHours?: CoreConfig["surface"]["heartbeat"]["softQuietHours"];
}): HeartbeatQuietState {
  const quietHours = params.quietHours;
  if (!quietHours) {
    return {
      inside: false,
      label: "outside",
    };
  }

  const local = resolveLocalHourMinute(params.nowMs, quietHours.timezone);
  const start = parseHourMinute(quietHours.start);
  const end = parseHourMinute(quietHours.end);
  const current = local.hour * 60 + local.minute;

  const inside =
    start === end
      ? true
      : start < end
        ? current >= start && current < end
        : current >= start || current < end;

  return {
    inside,
    label: inside ? "inside" : "outside",
    timezone: quietHours.timezone,
    localTime: `${local.hour.toString().padStart(2, "0")}:${local.minute.toString().padStart(2, "0")}`,
  };
}

export function buildOrdinaryHeartbeatOverlay(params: {
  requestId: string;
  sessionId: string;
}): string {
  return [
    "## Heartbeat Context",
    `If you write a handoff note for heartbeat in this run, use sourceSessionId='${params.sessionId}' and sourceRequestId='${params.requestId}'.`,
  ].join("\n");
}

export function buildHeartbeatSessionOverlay(params: {
  nowMs: number;
  heartbeat: CoreConfig["surface"]["heartbeat"];
}): string {
  const quietState = getHeartbeatQuietState({
    nowMs: params.nowMs,
    quietHours: params.heartbeat.softQuietHours,
  });

  const lines = [
    "## Heartbeat Quiet Hours",
    `Current local quiet-hours state: ${quietState.label}${quietState.localTime ? ` (${quietState.localTime})` : ""}${quietState.timezone ? ` tz=${quietState.timezone}` : ""}.`,
  ];

  if (quietState.inside) {
    lines.push("If inside quiet hours, do not proactively message for low-priority findings.");
    lines.push(
      "You may still update heartbeat files, process inbox notes, and surface urgent items.",
    );
  } else {
    lines.push("Outside quiet hours, you may proactively surface findings when warranted.");
  }

  return lines.join("\n");
}

export function buildHeartbeatRequestMessages(params: {
  reason: HeartbeatWakeReason;
  nowMs: number;
  lastActivityAt?: number;
  heartbeat: CoreConfig["surface"]["heartbeat"];
  dataDir?: string;
}): ModelMessage[] {
  const paths = resolveHeartbeatPromptPaths({ dataDir: params.dataDir });
  const quietState = getHeartbeatQuietState({
    nowMs: params.nowMs,
    quietHours: params.heartbeat.softQuietHours,
  });

  const lines = [
    "Run the autonomous heartbeat lane now.",
    `Wake reason: ${params.reason}`,
    `Current time: ${new Date(params.nowMs).toISOString()}`,
    formatLastActivityLine({ nowMs: params.nowMs, lastActivityAt: params.lastActivityAt }),
    formatDefaultOutputSessionLine(params.heartbeat.defaultOutputSession),
    "",
    "Workspace:",
    `- Canonical state file: ${paths.heartbeatFilePath}`,
    `- Inbox: ${paths.inboxDir}`,
    `- Archive: ${paths.archiveDir}`,
    "",
    "Follow the ownership, inbox handling, and durable-state structure in HEARTBEAT.md.",
    "",
    "Tasks:",
    `- Read ${paths.heartbeatFilePath}`,
    `- Ingest notes from ${paths.inboxDir}`,
    `- Update ${paths.heartbeatFilePath}`,
    `- Archive processed inbox files into ${paths.archiveDir}`,
    "- Perform due checks and follow-up actions.",
    "- Normal assistant output is discarded.",
    "- Use tools if you want to tell a human something.",
    `- Current local quiet-hours state: ${quietState.label}${quietState.localTime ? ` (${quietState.localTime})` : ""}${quietState.timezone ? ` tz=${quietState.timezone}` : ""}.`,
  ];

  if (quietState.inside) {
    lines.push("- If inside quiet hours, do not proactively surface low-priority findings.");
    lines.push("- You may still notify if something is urgent, critical, or time-sensitive.");
  }

  lines.push(`- When you are done, reply exactly ${HEARTBEAT_OK_TOKEN}.`);

  return [{ role: "user", content: lines.join("\n") }];
}

function formatLastActivityLine(params: { nowMs: number; lastActivityAt?: number }): string {
  if (!params.lastActivityAt || params.lastActivityAt <= 0) {
    return "Last observed activity: none recorded.";
  }

  const ageMs = Math.max(0, params.nowMs - params.lastActivityAt);
  return `Last observed activity: ${new Date(params.lastActivityAt).toISOString()} (${formatElapsedMs(ageMs)} ago).`;
}

function formatDefaultOutputSessionLine(defaultOutputSession: string | undefined): string {
  if (!defaultOutputSession) {
    return "Default proactive output session: none configured; do not guess a destination.";
  }

  const slashIndex = defaultOutputSession.indexOf("/");
  if (slashIndex <= 0 || slashIndex === defaultOutputSession.length - 1) {
    return `Default proactive output session: ${defaultOutputSession}. Use this for proactive surface messages unless a more specific destination is explicit.`;
  }

  const client = defaultOutputSession.slice(0, slashIndex);
  const session = defaultOutputSession.slice(slashIndex + 1);
  return `Default proactive output target: client=${client}, session=${session}. Use this for proactive surface messages unless a more specific destination is explicit.`;
}

function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function parseHourMinute(value: string): number {
  const [hourRaw, minuteRaw] = value.split(":");
  return Number(hourRaw) * 60 + Number(minuteRaw);
}

function resolveLocalHourMinute(
  nowMs: number,
  timezone: string | undefined,
): { hour: number; minute: number } {
  const formatter = createQuietHoursFormatter(timezone);

  const parts = formatter.formatToParts(new Date(nowMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function createQuietHoursFormatter(timezone: string | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
}
