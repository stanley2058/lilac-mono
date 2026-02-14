import type { SurfaceMessage } from "../types";

export const DISCORD_SESSION_DIVIDER_MARKER = "[LILAC_SESSION_DIVIDER]";

export function buildDiscordSessionDividerText(params?: {
  label?: string | null;
  createdByUserId?: string | null;
  createdByUserName?: string | null;
  now?: Date;
}): string {
  const label = typeof params?.label === "string" ? params.label.replace(/\s+/gu, " ").trim() : "";
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

  return `${DISCORD_SESSION_DIVIDER_MARKER}${whoPart}${labelPart}`;
}

export function isDiscordSessionDividerText(text: string): boolean {
  const trimmed = text.trim();

  if (trimmed === DISCORD_SESSION_DIVIDER_MARKER) return true;

  if (trimmed.startsWith(`${DISCORD_SESSION_DIVIDER_MARKER} (by `)) {
    const prefixLen = `${DISCORD_SESSION_DIVIDER_MARKER} (by `.length;
    const closeParen = trimmed.indexOf(")", prefixLen);
    if (closeParen <= prefixLen) return false;
    const rest = trimmed.slice(closeParen + 1);
    if (rest.length === 0) return true;
    if (rest.startsWith(": ") && rest.length > 2) return true;
    return false;
  }

  if (
    trimmed.startsWith(`${DISCORD_SESSION_DIVIDER_MARKER}: `) &&
    trimmed.length > `${DISCORD_SESSION_DIVIDER_MARKER}: `.length
  ) {
    return true;
  }

  // Backward compatibility with the old multi-line divider format.
  if (!text.startsWith("--- Session Divider")) return false;

  const escapeRegExp = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const markerRe = new RegExp(`(^|\\n)${escapeRegExp(DISCORD_SESSION_DIVIDER_MARKER)}(\\n|$)`, "u");
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

export function isDiscordSessionDividerSurfaceMessageAnyAuthor(msg: SurfaceMessage): boolean {
  if (msg.session.platform !== "discord") return false;
  return isDiscordSessionDividerText(msg.text);
}
