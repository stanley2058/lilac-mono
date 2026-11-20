export type DmRewindReason = "busy" | "not-latest" | "outside" | "unsettled" | "expired";

const reasons: Record<DmRewindReason, string> = {
  busy: "Wait for active and queued messages to finish.",
  "not-latest": "Only the latest turn can be rewound.",
  outside: "Messages from outside this exchange prevent rewind.",
  unsettled: "Wait for this turn to finish.",
  expired: "The rewind window has expired.",
};
export function dmRewindReasonText(reason: DmRewindReason): string {
  return reasons[reason];
}

import type { ReadyTurnSlot } from "./replay";

export function dmRewindDisabledReason(options: {
  turn: ReadyTurnSlot;
  latestTurnId?: string;
  ownerId: string;
  busy: boolean;
  windowMs: number;
  now: number;
}): DmRewindReason | undefined {
  const { turn, latestTurnId, ownerId, busy, windowMs, now } = options;
  if (busy) return "busy";
  if (turn.turnId !== latestTurnId) return "not-latest";
  const prompt = turn.messages.find(
    (message) => message.role === "user" && message.metadata?.inputMode !== "steer",
  );
  if (!prompt?.metadata?.inputId || prompt.metadata.authorId !== ownerId) return "outside";
  if (
    turn.messages.some(
      (message) =>
        message.metadata?.externalRunId !== undefined ||
        (message.metadata?.inputId !== undefined && message.metadata.authorId !== ownerId),
    )
  )
    return "outside";
  if (
    turn.settledAt === undefined ||
    (turn.state !== "complete" && turn.state !== "failed" && turn.state !== "canceled")
  )
    return "unsettled";
  if (now >= turn.settledAt + windowMs) return "expired";
  return undefined;
}
