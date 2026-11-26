import type { DisplayMessage, TurnSlot } from "@stanley2058/lilac-client-protocol";

/** A turn's prompt, which renders above its response. */
export const isPrompt = (message: DisplayMessage) =>
  message.role === "user" && message.metadata?.inputMode !== "steer";
/** A message another surface delivered into the turn, which also renders above its response. */
export const isIncoming = (message: DisplayMessage) =>
  message.role === "assistant" &&
  !!message.metadata?.inputId &&
  message.metadata.inputMode !== "steer";
/** A first message that renders above the turn's response, and so above its load button. */
export const isTurnLeadIn = (message: DisplayMessage) => isPrompt(message) || isIncoming(message);

/**
 * Where a partly loaded turn's missing messages belong. Core sends a long turn's first message with
 * its newest ones, and cuts only a newest message too large to send whole, so a break in message
 * positions marks missing messages after the first and no break means the newest one lacks its end.
 */
export function unloadedPlace(messages: readonly DisplayMessage[]): "top" | "after-first" | "end" {
  if (messages[0]?.metadata?.position !== 0) return "top";
  return firstGap(messages) < 0 ? "end" : "after-first";
}

/** The index of the first message after a break in positions, or -1 when there is none. */
function firstGap(messages: readonly DisplayMessage[]): number {
  return messages.findIndex((message, index) => message.metadata?.position !== index);
}

/**
 * What a partly loaded turn shows around the gap after its first message: that message when it
 * renders above the load button as the turn's lead-in, then the messages after the gap. Messages a
 * page loaded into the gap wait until it closes, so the button between the two stays at the gap.
 */
export function aroundTurnGap(
  messages: readonly DisplayMessage[],
  isLeadIn: (message: DisplayMessage) => boolean,
): readonly DisplayMessage[] {
  if (unloadedPlace(messages) !== "after-first") return messages;
  const after = messages.slice(firstGap(messages));
  return isLeadIn(messages[0]!) ? [messages[0]!, ...after] : after;
}

/**
 * Loads turn pages until no messages are missing after the turn's first one, so the load button,
 * which sits at that gap, never stays above messages that already loaded. A page that fails or
 * leaves the cursor unchanged stops the loop.
 */
export async function loadTurnGap(
  load: () => Promise<void>,
  read: () => TurnSlot | undefined,
): Promise<void> {
  const current = read();
  let cursor = current?.kind === "ready" ? current.partsCursor : undefined;
  while (cursor) {
    await load();
    const slot = read();
    if (slot?.kind !== "ready" || unloadedPlace(slot.messages) !== "after-first") return;
    if (!slot.partsCursor || slot.partsCursor === cursor) return;
    cursor = slot.partsCursor;
  }
}
