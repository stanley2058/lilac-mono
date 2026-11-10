import type { DisplayPart, ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import type { PendingInput } from "./pending-input";
import type { Attachment, ComposerSubmission } from "./types";

export function pendingTurnSlot(
  entry: PendingInput,
  attachments: readonly Attachment[],
  position: number,
  authorId: string,
): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `sending:${entry.commandId}`,
    turnId: `sending:${entry.commandId}`,
    position,
    state: "pending",
    startedAt: entry.createdAt,
    messages: [
      {
        id: entry.commandId,
        role: "user",
        metadata: { authorId, createdAt: entry.createdAt },
        parts: pendingMessageParts(entry.submission, attachments),
      },
    ],
  };
}

export function pendingMessageParts(
  submission: ComposerSubmission,
  attachments: readonly Attachment[],
): DisplayPart[] {
  let text = submission.attachmentText ?? submission.text;
  for (const attachment of attachments) {
    text = text.replaceAll(
      `attachment:${attachment.key}`,
      `/api/resources/${encodeURIComponent(attachment.resourceId ?? attachment.key)}`,
    );
  }
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...attachments.map(
      (attachment): DisplayPart => ({
        type: "data-resource",
        id: attachment.key,
        data: {
          resourceId: attachment.resourceId ?? attachment.key,
          name: attachment.file.name,
          mediaType: attachment.file.type || "application/octet-stream",
          size: attachment.file.size,
          state: attachment.preview || attachment.state === "ready" ? "ready" : "pending",
          progress: attachment.progress,
        },
      }),
    ),
  ];
}
