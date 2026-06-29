import { Buffer } from "node:buffer";

import {
  formatDiscordMessageRequestId,
  formatDiscordSlashRequestId,
  parseRequestId,
} from "../bridge/request-ids";

const PREFIX_V1 = "lilac_cancel:v1:";
const PREFIX_V2 = "lilac_cancel:v2:";
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(b64url: string): string | null {
  if (!b64url || typeof b64url !== "string") return null;
  try {
    return Buffer.from(b64url, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function buildCancelCustomId(input: {
  sessionId: string;
  requestId: string;
}): string | null {
  if (!input.sessionId || !input.requestId) return null;

  const parsed = parseRequestId(input.requestId);
  if (parsed?.kind === "discord_message" && parsed.channelId === input.sessionId) {
    const id = `${PREFIX_V2}${input.sessionId}:m:${parsed.messageId}`;
    if (id.length <= DISCORD_CUSTOM_ID_MAX_LENGTH) return id;
  }
  if (parsed?.kind === "discord_slash" && parsed.channelId === input.sessionId) {
    const id = `${PREFIX_V2}${input.sessionId}:s:${parsed.interactionId}`;
    if (id.length <= DISCORD_CUSTOM_ID_MAX_LENGTH) return id;
  }

  const encoded = toBase64Url(input.requestId);
  const id = `${PREFIX_V1}${input.sessionId}:${encoded}`;
  // Discord custom_id max length is 100 characters.
  if (id.length > DISCORD_CUSTOM_ID_MAX_LENGTH) return null;
  return id;
}

export const formatCancelCustomId = buildCancelCustomId;

export function parseCancelCustomId(customId: string): {
  sessionId: string;
  requestId: string;
} | null {
  if (typeof customId !== "string") return null;
  if (customId.startsWith(PREFIX_V2)) {
    const rest = customId.slice(PREFIX_V2.length);
    const firstIdx = rest.indexOf(":");
    if (firstIdx <= 0) return null;

    const sessionId = rest.slice(0, firstIdx);
    const encoded = rest.slice(firstIdx + 1);
    const secondIdx = encoded.indexOf(":");
    if (secondIdx <= 0) return null;

    const kind = encoded.slice(0, secondIdx);
    const id = encoded.slice(secondIdx + 1);
    if (!id) return null;

    if (kind === "m") {
      return {
        sessionId,
        requestId: formatDiscordMessageRequestId({ channelId: sessionId, messageId: id }),
      };
    }
    if (kind === "s") {
      return {
        sessionId,
        requestId: formatDiscordSlashRequestId({ channelId: sessionId, interactionId: id }),
      };
    }
    return null;
  }

  if (!customId.startsWith(PREFIX_V1)) return null;
  const rest = customId.slice(PREFIX_V1.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const sessionId = rest.slice(0, idx);
  const encoded = rest.slice(idx + 1);
  const requestId = fromBase64Url(encoded);
  if (!requestId) return null;
  return { sessionId, requestId };
}
