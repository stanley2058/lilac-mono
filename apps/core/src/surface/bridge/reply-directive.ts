export const NO_REPLY_TOKEN = "NO_REPLY";

export type ReplyDelivery = "reply" | "skip";

export function resolveReplyDeliveryFromFinalText(finalText: string): ReplyDelivery {
  const trimmed = finalText.trim();
  return trimmed === NO_REPLY_TOKEN ? "skip" : "reply";
}

export function isPossibleNoReplyPrefix(text: string): boolean {
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return true;
  }

  if (NO_REPLY_TOKEN.startsWith(trimmedStart)) {
    return true;
  }

  if (!trimmedStart.startsWith(NO_REPLY_TOKEN)) {
    return false;
  }

  const suffix = trimmedStart.slice(NO_REPLY_TOKEN.length);
  return /^\s*$/.test(suffix);
}
