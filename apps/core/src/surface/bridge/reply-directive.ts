import { isPossibleMagicTokenPrefix, matchesMagicToken } from "../../shared/magic-token";

export const NO_REPLY_TOKEN = "NO_REPLY";

export type ReplyDelivery = "reply" | "skip";

export function resolveReplyDeliveryFromFinalText(finalText: string): ReplyDelivery {
  return matchesMagicToken(finalText, NO_REPLY_TOKEN) ? "skip" : "reply";
}

export function isPossibleNoReplyPrefix(text: string): boolean {
  return isPossibleMagicTokenPrefix(text, NO_REPLY_TOKEN);
}
