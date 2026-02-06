import { Buffer } from "node:buffer";

const PREFIX = "lilac_cancel:v1:";

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
  const encoded = toBase64Url(input.requestId);
  const id = `${PREFIX}${input.sessionId}:${encoded}`;
  // Discord custom_id max length is 100 characters.
  if (id.length > 100) return null;
  return id;
}

export function parseCancelCustomId(customId: string): {
  sessionId: string;
  requestId: string;
} | null {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(PREFIX)) return null;
  const rest = customId.slice(PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const sessionId = rest.slice(0, idx);
  const encoded = rest.slice(idx + 1);
  const requestId = fromBase64Url(encoded);
  if (!requestId) return null;
  return { sessionId, requestId };
}
