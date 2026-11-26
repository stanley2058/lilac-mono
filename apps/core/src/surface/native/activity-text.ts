import type {
  DisplayMessage,
  DisplayPart,
  LiveUpdate,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";

/**
 * Thinking text up to this length stays in the part, since it titles the collapsed row. Tool output
 * and longer thinking text reach clients only when the row opens. Tool details stay, since row
 * titles are built from them.
 */
export const THINKING_PREVIEW_CHARS = 256;

/** The part as clients receive it. Applying it twice gives the same part. */
export function wireActivityPart(part: DisplayPart): DisplayPart {
  if (part.type !== "data-activity") return part;
  const { detail, output, ...data } = part.data;
  const cutDetail =
    part.data.kind === "thinking" && detail !== undefined && detail.length > THINKING_PREVIEW_CHARS;
  const cutOutput = output !== undefined && output.trim() !== "";
  // Whitespace-only output shows nothing, so it leaves without a marker.
  const blankOutput = output !== undefined && !cutOutput;
  if (!cutDetail && !cutOutput && !blankOutput) return part;
  const omitted = {
    ...data.omitted,
    ...(cutDetail ? { detail: detail.length } : {}),
    ...(cutOutput ? { output: output.length } : {}),
  };
  return {
    ...part,
    data: {
      ...data,
      ...(detail === undefined
        ? {}
        : { detail: cutDetail ? detail.slice(0, THINKING_PREVIEW_CHARS) : detail }),
      ...(cutDetail || cutOutput ? { omitted } : {}),
    },
  };
}

export function wireMessage(message: DisplayMessage): DisplayMessage {
  return { ...message, parts: message.parts.map(wireActivityPart) };
}

export function wireTurn(slot: ReadyTurnSlot): ReadyTurnSlot {
  return { ...slot, messages: slot.messages.map(wireMessage) };
}

export function wireChange(change: LiveUpdate["changes"][number]): LiveUpdate["changes"][number] {
  switch (change.kind) {
    case "insert":
      return { ...change, slot: wireTurn(change.slot) };
    case "append-message":
      return { ...change, message: wireMessage(change.message) };
    case "set-part":
      return { ...change, part: wireActivityPart(change.part) };
    default:
      return change;
  }
}
