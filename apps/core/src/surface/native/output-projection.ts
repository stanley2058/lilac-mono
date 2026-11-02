import { createHash } from "node:crypto";
import type {
  DisplayMessage,
  DisplayPart,
  LiveUpdate,
  ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { NativeOutputEvent, NativeOutputPayload } from "@stanley2058/lilac-event-bus";

import type { NativeOutputProjectionState, NativePartProvenance } from "./output-projection-codec";

interface ProjectedTurn {
  readonly slot: ReadyTurnSlot;
  readonly changes: LiveUpdate["changes"];
}

type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;
type ActivityPayload = Omit<
  Extract<NativeOutputPayload, { type: "activity" }>,
  "type" | "position" | "activityId" | "stepId"
>;
type PositionedPayload = Extract<NativeOutputPayload, { position: number }>;
const TEXT_PART_LIMIT = 8_192;
const DETAIL_LIMIT = 8_192;
const OUTPUT_LIMIT = 4_096;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function attemptPrefix(requestId: string, attemptId: string): string {
  return `np_${digest(JSON.stringify([requestId, attemptId]))}_`;
}

function stepIdentity(payload: PositionedPayload): string {
  if (payload.type === "compaction") return "compaction";
  return payload.stepId;
}

function messageIdentity(event: NativeOutputEvent, payload: PositionedPayload): string {
  return `${attemptPrefix(event.requestId, event.attemptId)}${digest(stepIdentity(payload))}_${String(payload.position).padStart(16, "0")}_${digest(payload.type)}`;
}

function existingActivityMessage(
  slot: ReadyTurnSlot,
  payload: PositionedPayload,
): string | undefined {
  if (payload.type !== "activity") return undefined;
  const activityId = digest(payload.activityId);
  return slot.messages.find((message) =>
    message.parts.some(
      (part) =>
        part.type === "data-activity" && part.id === activityId && part.data.kind === payload.kind,
    ),
  )?.id;
}

function messagePosition(message: DisplayMessage): number | undefined {
  const match = /^np_[a-f0-9]{24}_[a-f0-9]{24}_(\d{16})_[a-f0-9]{24}$/.exec(message.id);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function createMessage(event: NativeOutputEvent, payload: PositionedPayload): DisplayMessage {
  const metadata: NonNullable<DisplayMessage["metadata"]> = {
    createdAt: Math.floor(event.occurredAt),
    authorId: "lilac",
  };
  if (payload.type === "text" && payload.phase !== "final_answer") metadata.phase = "commentary";
  if (payload.type === "text" && payload.phase === "final_answer") metadata.phase = "final";
  return { id: messageIdentity(event, payload), role: "assistant", metadata, parts: [] };
}

function insertMessage(
  projection: ProjectedTurn,
  event: NativeOutputEvent,
  payload: PositionedPayload,
): ProjectedTurn {
  const message = createMessage(event, payload);
  const before = projection.slot.messages.findIndex((item) => {
    const position = messagePosition(item);
    return position !== undefined && position > payload.position;
  });
  const beforeMessageId = projection.slot.messages[before]?.id;
  const index = before === -1 ? projection.slot.messages.length : before;
  return {
    slot: { ...projection.slot, messages: projection.slot.messages.toSpliced(index, 0, message) },
    changes: [
      ...projection.changes,
      {
        kind: "append-message",
        turnId: projection.slot.turnId,
        position: projection.slot.position,
        message,
        ...(beforeMessageId ? { beforeMessageId } : {}),
      },
    ],
  };
}

function updatePart(
  projection: ProjectedTurn,
  messageId: string,
  partIndex: number,
  part: DisplayPart,
): ProjectedTurn {
  const index = projection.slot.messages.findIndex((message) => message.id === messageId);
  const message = projection.slot.messages[index];
  if (!message) return projection;
  const parts = [...message.parts];
  parts[partIndex] = part;
  return {
    slot: {
      ...projection.slot,
      messages: projection.slot.messages.with(index, { ...message, parts }),
    },
    changes: [
      ...projection.changes,
      {
        kind: "set-part",
        turnId: projection.slot.turnId,
        position: projection.slot.position,
        messageId,
        partIndex,
        part,
      },
    ],
  };
}

function textSliceEnd(text: string, available: number): number {
  const end = Math.min(text.length, available);
  if (end === text.length || end === 0) return end;
  const character = text.charCodeAt(end - 1);
  return character >= 0xd800 && character <= 0xdbff ? end - 1 : end;
}

function projectText(projection: ProjectedTurn, messageId: string, text: string): ProjectedTurn {
  let projected = projection;
  let remaining = text;
  while (remaining.length > 0) {
    const message = projected.slot.messages.find((item) => item.id === messageId);
    if (!message) return projected;
    const freshEnd = textSliceEnd(remaining, TEXT_PART_LIMIT);
    projected = updatePart(projected, messageId, message.parts.length, {
      type: "text",
      text: remaining.slice(0, freshEnd),
    });
    remaining = remaining.slice(freshEnd);
  }
  return projected;
}

function projectActivity(
  projection: ProjectedTurn,
  messageId: string,
  payload: Extract<NativeOutputPayload, { type: "activity" }>,
): ProjectedTurn {
  const previous = projection.slot.messages.find((message) => message.id === messageId)?.parts[0];
  const previousLabel = previous?.type === "data-activity" ? previous.data.label : undefined;
  return updatePart(projection, messageId, 0, {
    type: "data-activity",
    id: digest(payload.activityId),
    data: activityPartData(payload, previousLabel),
  });
}

export function activityPartData(
  payload: ActivityPayload,
  previousLabel?: string,
): ActivityPart["data"] {
  return {
    kind: payload.kind,
    label: (
      payload.label ??
      previousLabel ??
      (payload.kind === "thinking" ? "Thinking" : "Tool call")
    ).slice(0, 256),
    state: payload.state === "start" ? "running" : payload.state,
    ...activityDetail(payload),
    ...(payload.output === undefined ? {} : { output: payload.output.slice(0, OUTPUT_LIMIT) }),
    ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode }),
    ...(payload.file === undefined || payload.file.path.length > 4096
      ? {}
      : { file: payload.file }),
    ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
  };
}

function activityDetail(payload: ActivityPayload): {
  detail?: string;
} {
  if (payload.detail) return { detail: payload.detail.slice(0, DETAIL_LIMIT) };
  if (payload.kind === "tool" && payload.label)
    return { detail: payload.label.slice(0, DETAIL_LIMIT) };
  return {};
}

function projectCompaction(
  projection: ProjectedTurn,
  messageId: string,
  payload: Extract<NativeOutputPayload, { type: "compaction" }>,
): ProjectedTurn {
  const previous = projection.slot.messages.find((message) => message.id === messageId)?.parts[0];
  const priorData = previous?.type === "data-compaction" ? previous.data : {};
  return updatePart(projection, messageId, 0, {
    type: "data-compaction",
    id: digest(payload.compactionId),
    data: {
      ...priorData,
      state: payload.state === "start" ? "running" : payload.state,
      ...(payload.beforeCount === undefined ? {} : { beforeCount: payload.beforeCount }),
      ...(payload.afterCount === undefined ? {} : { afterCount: payload.afterCount }),
    },
  });
}

function resetAttempt(
  slot: ReadyTurnSlot,
  event: NativeOutputEvent,
  payload: Extract<NativeOutputPayload, { type: "reset" }>,
): ProjectedTurn {
  const prefix = attemptPrefix(event.requestId, payload.previousAttemptId);
  const selectedPrefix =
    payload.stepId === undefined ? prefix : `${prefix}${digest(payload.stepId)}_`;
  const removed = slot.messages.filter((message) => message.id.startsWith(selectedPrefix));
  return {
    slot: {
      ...slot,
      messages: slot.messages.filter((message) => !message.id.startsWith(selectedPrefix)),
    },
    changes: removed.map((message) => ({
      kind: "remove-message",
      turnId: slot.turnId,
      position: slot.position,
      messageId: message.id,
    })),
  };
}

function settleTurn(
  slot: ReadyTurnSlot,
  event: NativeOutputEvent,
  state: "complete" | "failed" | "canceled",
): ProjectedTurn {
  const settledAt = Math.floor(event.occurredAt);
  return {
    slot: { ...slot, state, settledAt },
    changes: [
      { kind: "turn-state", turnId: slot.turnId, position: slot.position, state, settledAt },
    ],
  };
}

function projectEvent(slot: ReadyTurnSlot, event: NativeOutputEvent): ProjectedTurn {
  if (slot.turnId !== event.turnId) return { slot, changes: [] };
  const payload = event.payload;
  if (payload.type === "model") return { slot, changes: [] };
  if (payload.type === "reset") return resetAttempt(slot, event, payload);
  if (payload.type === "terminal") return settleTurn(slot, event, payload.state);
  const startedAt = slot.startedAt ?? Math.floor(event.occurredAt);
  let projection: ProjectedTurn =
    slot.startedAt === undefined
      ? {
          slot: { ...slot, startedAt },
          changes: [
            {
              kind: "turn-state",
              turnId: slot.turnId,
              position: slot.position,
              state: slot.state ?? "running",
              startedAt,
            },
          ],
        }
      : { slot, changes: [] };
  const messageId = existingActivityMessage(slot, payload) ?? messageIdentity(event, payload);
  if (!slot.messages.some((message) => message.id === messageId))
    projection = insertMessage(projection, event, payload);
  switch (payload.type) {
    case "resource":
      return updatePart(projection, messageId, 0, {
        type: "data-resource",
        id: payload.resourceId,
        data: {
          resourceId: payload.resourceId,
          name: payload.filename,
          mediaType: payload.mediaType,
          size: payload.size,
          state: "ready",
        },
      });
    case "text":
      return projectText(projection, messageId, payload.text);
    case "activity":
      return projectActivity(projection, messageId, payload);
    case "compaction":
      return projectCompaction(projection, messageId, payload);
  }
}

export interface NativeOutputProjection extends ProjectedTurn {
  readonly projection: NativeOutputProjectionState;
}

function recordPart(
  parts: NativePartProvenance[],
  partIndex: number,
  part: DisplayPart,
  ordinal: number,
  incomplete: boolean,
): NativePartProvenance[] {
  const previous = parts.find((entry) => entry.partIndex === partIndex);
  if (part.type === "text")
    return [
      ...parts.filter((entry) => entry.partIndex !== partIndex),
      {
        kind: "text",
        partIndex,
        createdOrdinal: ordinal,
        ...(incomplete ? { incomplete: true } : {}),
      },
    ];
  const versions = previous?.kind === "data" ? previous.versions : [];
  return [
    ...parts.filter((entry) => entry.partIndex !== partIndex),
    { kind: "data", partIndex, versions: [...versions, { ordinal, part }] },
  ];
}

function recordProjection(
  prior: NativeOutputProjectionState,
  changes: LiveUpdate["changes"],
  event: NativeOutputEvent,
): NativeOutputProjectionState {
  const ordinal = event.ordinal;
  const incomplete = event.payload.type === "text" && event.payload.incomplete;
  let messages = prior.messages;
  for (const change of changes) {
    if (change.kind === "append-message") {
      messages = [
        ...messages,
        {
          messageId: change.message.id,
          createdOrdinal: ordinal,
          parts: [],
          initialPhase: change.message.metadata?.phase,
          unspecifiedPhase: event.payload.type === "text" && event.payload.phase === "unspecified",
        },
      ];
      continue;
    }
    if (change.kind === "remove-message") {
      messages = messages.filter((message) => message.messageId !== change.messageId);
      continue;
    }
    if (change.kind !== "set-part") continue;
    messages = messages.map((message) =>
      message.messageId === change.messageId
        ? {
            ...message,
            parts: recordPart(message.parts, change.partIndex, change.part, ordinal, incomplete),
          }
        : message,
    );
  }
  return { version: 1, messages };
}

function retainedPart(
  part: NativePartProvenance,
  ordinal: number,
): NativePartProvenance | undefined {
  if (part.kind === "text") return part.createdOrdinal <= ordinal ? part : undefined;
  const versions = part.versions.filter((version) => version.ordinal <= ordinal);
  if (versions.length === 0) return undefined;
  return { ...part, versions };
}

function rollbackToFrontier(
  slot: ReadyTurnSlot,
  prior: NativeOutputProjectionState,
  ordinal: number,
): NativeOutputProjection {
  let output: ProjectedTurn = { slot, changes: [] };
  const messages: NativeOutputProjectionState["messages"] = [];
  for (const provenance of prior.messages) {
    const index = output.slot.messages.findIndex((message) => message.id === provenance.messageId);
    const message = output.slot.messages[index];
    if (!message) continue;
    if (provenance.createdOrdinal > ordinal) {
      output = {
        slot: { ...output.slot, messages: output.slot.messages.toSpliced(index, 1) },
        changes: [
          ...output.changes,
          {
            kind: "remove-message",
            turnId: slot.turnId,
            position: slot.position,
            messageId: message.id,
          },
        ],
      };
      continue;
    }
    const parts = provenance.parts.flatMap((part) => {
      const kept = retainedPart(part, ordinal);
      return kept ? [kept] : [];
    });
    const length = parts.reduce((max, part) => Math.max(max, part.partIndex + 1), 0);
    if (message.parts.length > length) {
      output = {
        slot: {
          ...output.slot,
          messages: output.slot.messages.with(index, {
            ...message,
            parts: message.parts.slice(0, length),
          }),
        },
        changes: [
          ...output.changes,
          {
            kind: "truncate-parts",
            turnId: slot.turnId,
            position: slot.position,
            messageId: message.id,
            length,
          },
        ],
      };
    }
    for (const part of parts) {
      if (part.kind !== "data") continue;
      const last = part.versions.at(-1);
      if (!last) continue;
      const previous = provenance.parts.find((entry) => entry.partIndex === part.partIndex);
      if (previous?.kind === "data" && previous.versions.length === part.versions.length) continue;
      output = updatePart(output, message.id, part.partIndex, last.part);
    }
    output = updateMetadata(output, message.id, {
      ...(provenance.initialPhase ? { phase: provenance.initialPhase } : {}),
      incomplete: parts.some((part) => part.kind === "text" && part.incomplete === true),
    });
    messages.push({ ...provenance, parts });
  }
  const { settledAt: _settledAt, ...runningSlot } = output.slot;
  return {
    slot: { ...runningSlot, state: "running" },
    changes: [
      ...output.changes,
      { kind: "turn-state", turnId: slot.turnId, position: slot.position, state: "running" },
    ],
    projection: { version: 1, messages },
  };
}

function updateMetadata(
  projection: ProjectedTurn,
  messageId: string,
  metadata: { phase?: "commentary" | "final"; incomplete?: boolean },
): ProjectedTurn {
  const index = projection.slot.messages.findIndex((message) => message.id === messageId);
  const message = projection.slot.messages[index];
  if (!message) return projection;
  const phaseChanged = metadata.phase !== undefined && metadata.phase !== message.metadata?.phase;
  const incompleteChanged =
    metadata.incomplete !== undefined &&
    metadata.incomplete !== (message.metadata?.incomplete ?? false);
  if (!phaseChanged && !incompleteChanged) return projection;
  const patch = {
    ...(phaseChanged ? { phase: metadata.phase } : {}),
    ...(incompleteChanged ? { incomplete: metadata.incomplete } : {}),
  };
  return {
    slot: {
      ...projection.slot,
      messages: projection.slot.messages.with(index, {
        ...message,
        metadata: { ...message.metadata, ...patch },
      }),
    },
    changes: [
      ...projection.changes,
      {
        kind: "message-meta",
        turnId: projection.slot.turnId,
        position: projection.slot.position,
        messageId,
        metadata: patch,
      },
    ],
  };
}

function normalizeFinalPhase(
  projection: ProjectedTurn,
  prior: NativeOutputProjectionState,
): ProjectedTurn {
  if (
    projection.slot.messages.some(
      (message) => message.role === "assistant" && message.metadata?.phase === "final",
    )
  )
    return projection;
  const unspecified = new Set(
    prior.messages
      .filter((message) => message.unspecifiedPhase)
      .map((message) => message.messageId),
  );
  const last = projection.slot.messages.findLast(
    (message) => unspecified.has(message.id) && message.parts.some((part) => part.type === "text"),
  );
  return last ? updateMetadata(projection, last.id, { phase: "final" }) : projection;
}

export function projectNativeOutput(
  slot: ReadyTurnSlot,
  event: NativeOutputEvent,
  prior: NativeOutputProjectionState = { version: 1, messages: [] },
): NativeOutputProjection {
  if (slot.turnId !== event.turnId) return { slot, changes: [], projection: prior };
  if (event.payload.type === "reset" && event.payload.retainThroughOrdinal !== undefined)
    return rollbackToFrontier(slot, prior, event.payload.retainThroughOrdinal);
  if (event.payload.type === "text" && event.payload.text.length === 0)
    return { slot, changes: [], projection: prior };
  let output = projectEvent(slot, event);
  if (event.payload.type === "text" && event.payload.incomplete)
    output = updateMetadata(output, messageIdentity(event, event.payload), { incomplete: true });
  if (event.payload.type === "terminal" && event.payload.state === "complete")
    output = normalizeFinalPhase(output, prior);
  return { ...output, projection: recordProjection(prior, output.changes, event) };
}
