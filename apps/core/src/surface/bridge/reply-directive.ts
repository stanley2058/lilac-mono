export const NO_REPLY_TOKEN = "NO_REPLY";

export type ReplyDelivery = "reply" | "skip";

export function resolveReplyDeliveryFromFinalText(
  finalText: string,
): ReplyDelivery {
  const trimmed = finalText.trim();
  return trimmed === NO_REPLY_TOKEN ? "skip" : "reply";
}
