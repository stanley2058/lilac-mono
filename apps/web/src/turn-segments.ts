import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";

export type ResourcePart = Extract<DisplayPart, { type: "data-resource" }>;

export type WorkSegment = {
  kind: "work";
  key: string;
  messages: DisplayMessage[];
  workIndex: number;
  durationMs?: number;
};

export type VisibleSegment = {
  kind: "visible";
  key: string;
  role: "user" | "assistant";
  messages: DisplayMessage[];
  /** Hoisted assistant `data-resource` parts attached to the bottom of a final reply message. */
  trailingAttachments: ReadonlyMap<string, readonly ResourcePart[]>;
};

export type TurnSegment = WorkSegment | VisibleSegment;

function isResourcePart(part: DisplayPart): part is ResourcePart {
  return part.type === "data-resource";
}

function isAssistantResourceOnly(message: DisplayMessage): boolean {
  return (
    message.role === "assistant" && message.parts.length > 0 && message.parts.every(isResourcePart)
  );
}

function isInteractiveMessage(message: DisplayMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "data-question" ||
      part.type === "data-workflow" ||
      part.type === "data-actions",
  );
}

function isFinalAssistantReply(message: DisplayMessage): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.phase === "final" &&
    !isInteractiveMessage(message)
  );
}

function isPinnedVisible(message: DisplayMessage): boolean {
  if (message.role === "user") return true;
  if (isInteractiveMessage(message)) return true;
  if (message.role !== "assistant") return false;
  return message.metadata?.phase === "final" || message.parts.some(isResourcePart);
}

function stripBatchActivities(message: DisplayMessage): DisplayMessage | undefined {
  const parts = message.parts.filter(
    (part) =>
      !(
        part.type === "data-activity" &&
        part.data.kind === "tool" &&
        /^batch(?:\s|$)/.test(part.data.label)
      ),
  );
  if (!parts.length) return undefined;
  return parts.length === message.parts.length ? message : { ...message, parts };
}

function mergeAdjacentActivities(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const grouped: DisplayMessage[] = [];
  const activityOnly = (message: DisplayMessage) =>
    message.role === "assistant" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "data-activity");
  for (const message of messages) {
    const previous = grouped.at(-1);
    if (previous && activityOnly(previous) && activityOnly(message)) {
      grouped[grouped.length - 1] = { ...previous, parts: [...previous.parts, ...message.parts] };
      continue;
    }
    grouped.push(message);
  }
  return grouped;
}

export function groupActivityMessages(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const filtered: DisplayMessage[] = [];
  for (const original of messages) {
    const message = stripBatchActivities(original);
    if (message) filtered.push(message);
  }
  return mergeAdjacentActivities(filtered);
}

function mergeResourceMessages(messages: readonly DisplayMessage[]): DisplayMessage {
  const first = messages[0]!;
  if (messages.length === 1) return first;
  return {
    ...first,
    parts: messages.flatMap((message) => message.parts.filter(isResourcePart)),
  };
}

function firstCreatedAt(messages: readonly DisplayMessage[]): number | undefined {
  for (const message of messages) {
    if (message.metadata?.createdAt !== undefined) return message.metadata.createdAt;
  }
  return undefined;
}

function lastCreatedAt(messages: readonly DisplayMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const createdAt = messages[index]?.metadata?.createdAt;
    if (createdAt !== undefined) return createdAt;
  }
  return undefined;
}

type DraftVisibleSegment = {
  kind: "visible";
  role: "user" | "assistant";
  messages: DisplayMessage[];
  trailingAttachments: Map<string, ResourcePart[]>;
};

type DraftSegment = { kind: "work"; messages: DisplayMessage[] } | DraftVisibleSegment;

function appendTrailingAttachments(
  map: Map<string, ResourcePart[]>,
  messageId: string,
  resources: readonly ResourcePart[],
): void {
  if (!resources.length) return;
  const existing = map.get(messageId);
  if (existing) existing.push(...resources);
  else map.set(messageId, [...resources]);
}

function attachResourcesToPreviousFinal(
  segment: DraftVisibleSegment,
  resources: readonly ResourcePart[],
): boolean {
  if (segment.role !== "assistant") return false;
  // Never cross backward over an interactive card or other non-final message.
  const target = segment.messages.at(-1);
  if (!target || !isFinalAssistantReply(target)) return false;
  appendTrailingAttachments(segment.trailingAttachments, target.id, resources);
  return true;
}

/**
 * Partitions a completed turn's messages after the initial prompt into collapsible work segments
 * and always-visible segments (steers, final replies, interactive cards, and hoisted attachments).
 *
 * Assistant `data-resource`-only messages produced mid-work are hoisted out of the enclosing work
 * run (without splitting it) and attached to the bottom of the immediately following final
 * assistant reply in the same steer/interactive segment, or rendered visibly if no final reply
 * follows before the next barrier.
 */
export function partitionTurnMessages(
  messages: readonly DisplayMessage[],
  options: { startedAt?: number; settledAt?: number } = {},
): TurnSegment[] {
  const drafts: DraftSegment[] = [];
  let pendingWork: DisplayMessage[] = [];
  let pendingResources: DisplayMessage[] = [];

  const flushWork = () => {
    if (!pendingWork.length) return;
    const grouped = mergeAdjacentActivities(pendingWork);
    pendingWork = [];
    if (grouped.length) drafts.push({ kind: "work", messages: grouped });
  };

  const flushOrphanResources = (allowAttachPrevious: boolean) => {
    if (!pendingResources.length) return;
    const parts = pendingResources.flatMap((message) => message.parts.filter(isResourcePart));
    const previous = drafts.at(-1);
    if (
      allowAttachPrevious &&
      previous?.kind === "visible" &&
      attachResourcesToPreviousFinal(previous, parts)
    ) {
      pendingResources = [];
      return;
    }
    drafts.push({
      kind: "visible",
      role: "assistant",
      messages: [mergeResourceMessages(pendingResources)],
      trailingAttachments: new Map(),
    });
    pendingResources = [];
  };

  const appendUserMessage = (message: DisplayMessage) => {
    const hadPendingWork = pendingWork.length > 0;
    flushWork();
    flushOrphanResources(!hadPendingWork);
    const previous = drafts.at(-1);
    if (previous?.kind === "visible" && previous.role === "user") {
      previous.messages.push(message);
      return;
    }
    drafts.push({
      kind: "visible",
      role: "user",
      messages: [message],
      trailingAttachments: new Map(),
    });
  };

  const appendVisibleAssistantMessage = (message: DisplayMessage) => {
    const hadPendingWork = pendingWork.length > 0;
    flushWork();
    if (!isFinalAssistantReply(message)) {
      flushOrphanResources(!hadPendingWork);
    }
    const previous = drafts.at(-1);
    const hoisted = isFinalAssistantReply(message)
      ? pendingResources.flatMap((item) => item.parts.filter(isResourcePart))
      : [];
    if (hoisted.length) pendingResources = [];

    if (previous?.kind === "visible" && previous.role === "assistant") {
      previous.messages.push(message);
      appendTrailingAttachments(previous.trailingAttachments, message.id, hoisted);
      return;
    }
    const trailingAttachments = new Map<string, ResourcePart[]>();
    appendTrailingAttachments(trailingAttachments, message.id, hoisted);
    drafts.push({
      kind: "visible",
      role: "assistant",
      messages: [message],
      trailingAttachments,
    });
  };

  for (const original of messages) {
    const message = stripBatchActivities(original);
    if (!message) continue;

    if (isAssistantResourceOnly(message)) {
      pendingResources.push(message);
      continue;
    }

    if (message.role === "user") {
      appendUserMessage(message);
      continue;
    }

    if (!isPinnedVisible(message)) {
      pendingWork.push(message);
      continue;
    }

    appendVisibleAssistantMessage(message);
  }

  const hadPendingWork = pendingWork.length > 0;
  flushWork();
  flushOrphanResources(!hadPendingWork);

  const workCount = drafts.reduce((count, segment) => count + (segment.kind === "work" ? 1 : 0), 0);
  const { startedAt, settledAt } = options;
  let workIndex = 0;

  return drafts.map((draft, index): TurnSegment => {
    const key = `${draft.kind}:${draft.messages[0]!.id}`;
    if (draft.kind === "visible") {
      return {
        kind: "visible",
        key,
        role: draft.role,
        messages: draft.messages,
        trailingAttachments: draft.trailingAttachments,
      };
    }
    const currentWorkIndex = workIndex++;
    let durationMs: number | undefined;
    if (workCount === 1) {
      durationMs =
        startedAt !== undefined && settledAt !== undefined
          ? Math.max(0, settledAt - startedAt)
          : undefined;
    } else {
      const previous = drafts[index - 1];
      const next = drafts[index + 1];
      const segStart = previous
        ? (lastCreatedAt(previous.messages) ?? firstCreatedAt(draft.messages))
        : (startedAt ?? firstCreatedAt(draft.messages));
      const isLastWork = currentWorkIndex === workCount - 1;
      const segEnd = isLastWork
        ? (settledAt ?? lastCreatedAt(draft.messages))
        : ((next ? firstCreatedAt(next.messages) : undefined) ?? lastCreatedAt(draft.messages));
      if (segStart !== undefined && segEnd !== undefined && segEnd >= segStart) {
        durationMs = segEnd - segStart;
      }
    }
    return {
      kind: "work",
      key,
      messages: draft.messages,
      workIndex: currentWorkIndex,
      durationMs,
    };
  });
}

export function workSegmentKeyForMessage(
  segments: readonly TurnSegment[],
  messageId: string,
): string | undefined {
  for (const segment of segments) {
    if (segment.kind !== "work") continue;
    if (segment.messages.some((message) => message.id === messageId)) return segment.key;
  }
  return undefined;
}
