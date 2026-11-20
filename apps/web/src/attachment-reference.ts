import type { Attachment, ReferencedAttachment, UploadReference } from "./types";

export function referencedAttachment(reference: UploadReference): ReferencedAttachment {
  return {
    key: reference.key,
    resourceId: reference.resourceId,
    reference,
    reservation: Promise.resolve(reference.resourceId),
    progress: 1,
    state: "ready",
  };
}

export function readyUploadReference(attachment: Attachment): UploadReference | undefined {
  if (attachment.reference) return attachment.reference;
  if (attachment.state !== "ready" || !attachment.resourceId || !attachment.staging) return;
  const { key, resourceId, staging, file } = attachment;
  return { key, resourceId, staging, name: file.name, type: file.type, size: file.size };
}

export function canUseStagedUpload(
  staging: UploadReference["staging"],
  threadId: string,
  historyGeneration: number | undefined,
): boolean {
  return (
    !staging ||
    (staging.threadId === threadId &&
      staging.historyGeneration === historyGeneration &&
      Date.now() < staging.expiresAt)
  );
}

export function attachmentStaging(attachment: Attachment): UploadReference["staging"] {
  return attachment.reference ? attachment.reference.staging : attachment.staging;
}

export function draftAttachments(
  keys: readonly string[],
  references: readonly UploadReference[] | undefined,
  uploads: readonly Attachment[],
): Attachment[] {
  return keys.flatMap((key) => {
    const upload = uploads.find((item) => item.key === key);
    if (upload) return [upload];
    const reference = references?.find((item) => item.key === key);
    return reference ? [referencedAttachment(reference)] : [];
  });
}
