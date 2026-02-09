import type { SurfaceMessage } from "../types";

export const DISCORD_SESSION_DIVIDER_MARKER = "[LILAC_SESSION_DIVIDER]";

export function buildDiscordSessionDividerText(params?: {
  label?: string | null;
  createdByUserId?: string | null;
  createdByUserName?: string | null;
  now?: Date;
}): string {
  const now = params?.now ?? new Date();
  const ts = now.toISOString();

  const label = typeof params?.label === "string" ? params.label.trim() : "";
  const labelPart = label ? `: ${label}` : "";

  const who = (() => {
    const id =
      typeof params?.createdByUserId === "string" && params.createdByUserId
        ? params.createdByUserId
        : null;
    const name =
      typeof params?.createdByUserName === "string" && params.createdByUserName
        ? params.createdByUserName
        : null;
    // Keep divider messages lightweight and avoid exposing extra identifiers.
    if (id && name) return `by ${name}`;
    if (name) return `by ${name}`;
    if (id) return `by ${id}`;
    return null;
  })();

  const whoPart = who ? ` (${who})` : "";

  // Keep the marker on its own line so detection is stable even if the user copies the message.
  return [`--- Session Divider${labelPart} ---${whoPart}`, DISCORD_SESSION_DIVIDER_MARKER, ts].join(
    "\n",
  );
}

export function isDiscordSessionDividerText(text: string): boolean {
  // Structure-based detection to avoid accidental cutoffs if the bot ever prints the marker.
  // Requirements:
  // - header line starts with our divider prefix
  // - marker appears on its own line
  if (!text.startsWith("--- Session Divider")) return false;

  const escapeRegExp = (input: string) =>
    input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const markerRe = new RegExp(
    `(^|\\n)${escapeRegExp(DISCORD_SESSION_DIVIDER_MARKER)}(\\n|$)`,
    "u",
  );
  return markerRe.test(text);
}

export function isDiscordSessionDividerSurfaceMessage(
  msg: SurfaceMessage,
  botUserId: string,
): boolean {
  if (msg.session.platform !== "discord") return false;
  if (msg.userId !== botUserId) return false;
  return isDiscordSessionDividerText(msg.text);
}
