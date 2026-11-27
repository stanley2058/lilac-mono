import {
  isLikelyContextOverflowError,
  isRetryableTransientModelError,
} from "@stanley2058/lilac-agent";
import type { AiErrorLogDetails } from "@stanley2058/lilac-utils/ai-error";
import type { ModelMessage, ToolModelMessage, UserModelMessage } from "ai";

const REJECTED_INPUT_STATUS_CODES = new Set([400, 413, 415, 422]);
const MAX_REASON_LENGTH = 300;

type ToolResultContentPart = Extract<
  Extract<ToolModelMessage["content"][number], { type: "tool-result" }>["output"],
  { type: "content" }
>["value"][number];
type UserContentPart = Exclude<UserModelMessage["content"], string>[number];
type AttachmentPart =
  | Exclude<UserContentPart, { type: "text" }>
  | Exclude<ToolResultContentPart, { type: "text" | "custom" }>;

/**
 * Replaces user and tool-result attachments with text notes after a provider rejects the
 * request input, so the run can continue without them. Returns null when the error is not a
 * non-transient input rejection or the transcript has no attachments left to remove.
 */
export function stripRejectedInputMedia<ErrorCause>(input: {
  readonly error: ErrorCause;
  readonly details: AiErrorLogDetails | undefined;
  readonly messages: readonly ModelMessage[];
}): ModelMessage[] | null {
  if (isLikelyContextOverflowError(input.error) || isRetryableTransientModelError(input.error))
    return null;
  const reason = rejectedInputReason(input.details);
  if (reason === null) return null;

  let stripped = false;
  const messages = input.messages.map((message) => {
    const next = stripMessageMedia(message, reason);
    if (next !== message) stripped = true;
    return next;
  });
  return stripped ? messages : null;
}

function rejectedInputReason(error: AiErrorLogDetails | undefined): string | null {
  if (error?.statusCode === undefined || !REJECTED_INPUT_STATUS_CODES.has(error.statusCode))
    return null;
  const message =
    (error.providerMessage ?? error.aiErrorMessage).trim() ||
    `HTTP ${error.statusCode} with no error message.`;
  if (isLikelyContextOverflowError(message)) return null;
  return message.length > MAX_REASON_LENGTH ? `${message.slice(0, MAX_REASON_LENGTH)}…` : message;
}

function stripMessageMedia(message: ModelMessage, reason: string): ModelMessage {
  switch (message.role) {
    case "user":
      return stripUserMedia(message, reason);
    case "tool":
      return stripToolResultMedia(message, reason);
    default:
      return message;
  }
}

function stripUserMedia(message: UserModelMessage, reason: string): UserModelMessage {
  if (typeof message.content === "string") return message;
  if (!message.content.some((part) => part.type !== "text")) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text" ? part : { type: "text", text: omittedAttachmentText(part, reason) },
    ),
  };
}

function stripToolResultMedia(message: ToolModelMessage, reason: string): ToolModelMessage {
  if (!message.content.some(hasToolResultMedia)) return message;
  return {
    ...message,
    content: message.content.map((part) => stripToolResultPartMedia(part, reason)),
  };
}

function stripToolResultPartMedia(
  part: ToolModelMessage["content"][number],
  reason: string,
): ToolModelMessage["content"][number] {
  if (!hasToolResultMedia(part)) return part;
  return {
    ...part,
    output: {
      ...part.output,
      value: part.output.value.map((item) =>
        isToolResultMedia(item)
          ? { type: "text" as const, text: omittedAttachmentText(item, reason) }
          : item,
      ),
    },
  };
}

function hasToolResultMedia(part: ToolModelMessage["content"][number]): part is Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
> & {
  output: { type: "content"; value: ToolResultContentPart[] };
} {
  return (
    part.type === "tool-result" &&
    part.output.type === "content" &&
    part.output.value.some(isToolResultMedia)
  );
}

function isToolResultMedia(
  part: ToolResultContentPart,
): part is AttachmentPart & ToolResultContentPart {
  return part.type !== "text" && part.type !== "custom";
}

function omittedAttachmentText(part: AttachmentPart, reason: string): string {
  return `[Attachment ${attachmentLabel(part)} was removed because the model provider rejected it: ${reason} Read its contents another way, such as extracting the text with a tool.]`;
}

function attachmentLabel(part: AttachmentPart): string {
  const filename = "filename" in part ? part.filename : undefined;
  const mediaType = "mediaType" in part ? part.mediaType : undefined;
  if (filename && mediaType) return `'${filename}' (${mediaType})`;
  if (filename) return `'${filename}'`;
  return mediaType ?? part.type;
}
