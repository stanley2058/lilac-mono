import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type DisplayMessage,
  type TurnSlot,
} from "@stanley2058/lilac-client-protocol";

export function sameMessageAuthor(
  left: DisplayMessage | undefined,
  right: DisplayMessage | undefined,
): boolean {
  if (!left || !right || left.role !== right.role) return false;
  if (left.role !== "assistant" && left.role !== "user") return false;
  const leftId = left.metadata?.authorId ?? (left.role === "assistant" ? "lilac" : undefined);
  const rightId = right.metadata?.authorId ?? (right.role === "assistant" ? "lilac" : undefined);
  return (
    leftId !== undefined &&
    leftId === rightId &&
    left.metadata?.authorDisplayName === right.metadata?.authorDisplayName
  );
}

export function lastTurnMessageTime(slot: TurnSlot | undefined): number | undefined {
  if (slot?.kind !== "ready") return undefined;
  return slot.messages.at(-1)?.metadata?.createdAt ?? slot.settledAt ?? slot.startedAt;
}

export function joinMessageTurns(
  left: TurnSlot | undefined,
  right: TurnSlot | undefined,
  contextStart?: number | null,
  gapMs = DEFAULT_DM_TIMESTAMP_GAP_MS,
): boolean {
  if (left?.kind !== "ready" || right?.kind !== "ready") return false;
  if (
    left.state !== "complete" ||
    left.partsCursor ||
    right.partsCursor ||
    right.position === contextStart
  )
    return false;
  if (
    [left, right].some((slot) =>
      slot.messages.some((message) => message.parts.some((part) => part.type === "data-workflow")),
    )
  )
    return false;
  const last = left.messages.at(-1);
  const first = right.messages[0];
  if (!sameMessageAuthor(last, first)) return false;
  const before = lastTurnMessageTime(left);
  const after = first?.metadata?.createdAt ?? right.startedAt;
  if (before === undefined || after === undefined) return false;
  // Older queued posts carry acceptance time even though their turn follows delivery order.
  const posted =
    right.state === "complete" && first?.id === right.turnId && !first.metadata?.inputId;
  const gap = posted && first?.role === "assistant" ? Math.abs(after - before) : after - before;
  return (
    gap >= 0 && gap < gapMs && new Date(before).toDateString() === new Date(after).toDateString()
  );
}

/**
 * The turn to mark read once it settles. A background job's silent wake has no messages to read, so
 * the turn before it stays the reader's latest.
 */
export function latestReadableTurnId(
  slotIds: readonly string[],
  slotById: (id: string) => TurnSlot | undefined,
): string | undefined {
  for (const id of slotIds.toReversed()) {
    const slot = slotById(id);
    if (slot?.kind === "ready" && slot.messages.length === 0) continue;
    if (slot?.kind !== "ready" || slot.state === "pending" || slot.state === "running")
      return undefined;
    return slot.turnId;
  }
  return undefined;
}

/** Core posts each workflow progress card as its own one-message slot, outside any agent turn. */
export function isWorkflowPost(slot: TurnSlot | undefined): boolean {
  if (slot?.kind !== "ready" || slot.messages.length !== 1) return false;
  const [message] = slot.messages;
  return message?.id === slot.turnId && message.parts.some((part) => part.type === "data-workflow");
}

/** When a turn's reply began; a running turn without a reply still accepts every new post. */
function replyStartedAt(turn: Extract<TurnSlot, { kind: "ready" }>): number {
  // Incoming messages from other agents carry an input id and start the turn; they are not the reply.
  const reply = turn.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.metadata?.phase === "final" &&
      !message.metadata.inputId,
  );
  if (reply?.metadata?.createdAt !== undefined) return reply.metadata.createdAt;
  if (turn.state === "pending" || turn.state === "running") return Number.POSITIVE_INFINITY;
  return turn.settledAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * Workflow cards the agent posted during a turn, before its reply began. Posts take the next turn
 * position, so they follow the turn in the store even though they happened inside it.
 */
export function workflowPostsDuring(
  turn: TurnSlot | undefined,
  following: readonly (TurnSlot | undefined)[],
): string[] {
  if (turn?.kind !== "ready" || isWorkflowPost(turn)) return [];
  const start = Math.min(
    turn.startedAt ?? Number.POSITIVE_INFINITY,
    turn.messages[0]?.metadata?.createdAt ?? Number.POSITIVE_INFINITY,
  );
  if (start === Number.POSITIVE_INFINITY) return [];
  const replyAt = replyStartedAt(turn);
  const posts: string[] = [];
  for (const slot of following) {
    if (!isWorkflowPost(slot) || slot?.kind !== "ready") break;
    const postedAt = slot.messages[0]?.metadata?.createdAt;
    if (postedAt === undefined || postedAt < start || postedAt >= replyAt) break;
    posts.push(slot.slotId);
  }
  return posts;
}
