import {
  isLikelyContextOverflowError,
  isRetryableTransientModelError,
} from "@stanley2058/lilac-agent";
import type { AiErrorLogDetails } from "@stanley2058/lilac-utils/ai-error";
import type { FilePart, ModelMessage, ToolModelMessage, UserModelMessage } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  providerTargetSupportsMediaType,
  type StoredResourceProviderTarget,
} from "../transcript/stored-message-materialization";

const REJECTED_INPUT_STATUS_CODES = new Set([400, 413, 415, 422]);
const MAX_REASON_LENGTH = 300;
const readCallInputSchema = z.object({ path: z.string() });

type ToolResultContentPart = Extract<
  Extract<ToolModelMessage["content"][number], { type: "tool-result" }>["output"],
  { type: "content" }
>["value"][number];
type UserContentPart = Exclude<UserModelMessage["content"], string>[number];
type MediaPart =
  | Exclude<UserContentPart, { type: "text" }>
  | Exclude<ToolResultContentPart, { type: "text" | "custom" }>;
type MediaNote = (part: MediaPart, readPath: string | undefined) => string | null;

/**
 * Filters media out of model-facing views for one run. Canonical history keeps every part, so the
 * persisted transcript and later models still see the original media.
 */
export type ModelMediaFilter = {
  /**
   * After a non-transient input rejection, marks media for omission from later views: first the
   * media sent after the last assistant message, or, when that is all omitted already, every media
   * part in the transcript. Returns false when the error is not an input rejection or no media is
   * left to omit, so a repeated rejection fails instead of retrying again.
   */
  recordRejection<ErrorCause>(input: {
    readonly error: ErrorCause;
    readonly details: AiErrorLogDetails | undefined;
    readonly messages: readonly ModelMessage[];
  }): boolean;
  /** Replaces media the target cannot read, or a provider rejected in this run, with notes. */
  apply(messages: readonly ModelMessage[], target: StoredResourceProviderTarget): ModelMessage[];
};

export function createModelMediaFilter(): ModelMediaFilter {
  const rejections = new Map<string, string>();
  const recordNew = (parts: readonly MediaPart[], reason: string): boolean => {
    let recorded = false;
    for (const part of parts) {
      const fingerprint = mediaFingerprint(part);
      if (rejections.has(fingerprint)) continue;
      rejections.set(fingerprint, reason);
      recorded = true;
    }
    return recorded;
  };
  return {
    recordRejection(input) {
      if (isLikelyContextOverflowError(input.error) || isRetryableTransientModelError(input.error))
        return false;
      const reason = rejectedInputReason(input.details);
      if (reason === null) return false;
      // A replayed earlier attachment can be the one rejected, such as on the run after a retry.
      return (
        recordNew(latestTurnMedia(input.messages), reason) ||
        recordNew(input.messages.flatMap(messageMedia), reason)
      );
    },
    apply(messages, target) {
      // The Claude Code bridge converts file parts itself.
      const gateCapability = target.family === "ai-sdk";
      if (!gateCapability && rejections.size === 0) return [...messages];
      return replaceMedia(messages, (part, readPath) => {
        if (gateCapability && !providerTargetSupportsMediaType(target, capabilityMediaType(part)))
          return unsupportedMediaText(part, readPath);
        if (rejections.size === 0) return null;
        const reason = rejections.get(mediaFingerprint(part));
        return reason === undefined ? null : rejectedMediaText(part, readPath, reason);
      });
    },
  };
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

/** The provider accepted everything up to the last assistant message, so later media is suspect first. */
function latestTurnMedia(messages: readonly ModelMessage[]): MediaPart[] {
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  return messages.slice(lastAssistant + 1).flatMap(messageMedia);
}

function messageMedia(message: ModelMessage): MediaPart[] {
  switch (message.role) {
    case "user":
      return typeof message.content === "string" ? [] : message.content.filter(isUserMedia);
    case "tool":
      return message.content.flatMap((part) =>
        part.type === "tool-result" && part.output.type === "content"
          ? part.output.value.filter(isToolResultMedia)
          : [],
      );
    default:
      return [];
  }
}

function isUserMedia(part: UserContentPart): part is MediaPart & UserContentPart {
  return part.type !== "text";
}

function isToolResultMedia(part: ToolResultContentPart): part is MediaPart & ToolResultContentPart {
  return part.type !== "text" && part.type !== "custom";
}

function replaceMedia(messages: readonly ModelMessage[], noteFor: MediaNote): ModelMessage[] {
  const readPaths = readCallPaths(messages);
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return replaceUserMedia(message, noteFor);
      case "tool":
        return replaceToolResultMedia(message, readPaths, noteFor);
      default:
        return message;
    }
  });
}

function readCallPaths(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "read") continue;
      const input = readCallInputSchema.safeParse(part.input);
      if (input.success) paths.set(part.toolCallId, input.data.path);
    }
  }
  return paths;
}

function replaceUserMedia(message: UserModelMessage, noteFor: MediaNote): UserModelMessage {
  if (typeof message.content === "string" || !message.content.some(isUserMedia)) return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (!isUserMedia(part)) return part;
      const note = noteFor(part, undefined);
      return note === null ? part : { type: "text", text: note };
    }),
  };
}

function replaceToolResultMedia(
  message: ToolModelMessage,
  readPaths: ReadonlyMap<string, string>,
  noteFor: MediaNote,
): ToolModelMessage {
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      if (!part.output.value.some(isToolResultMedia)) return part;
      const readPath = readPaths.get(part.toolCallId);
      return {
        ...part,
        output: {
          ...part.output,
          value: part.output.value.map((item) => {
            if (!isToolResultMedia(item)) return item;
            const note = noteFor(item, readPath);
            return note === null ? item : { type: "text" as const, text: note };
          }),
        },
      };
    }),
  };
}

function partMediaType(part: MediaPart): string | undefined {
  return "mediaType" in part ? part.mediaType : undefined;
}

/** Image parts may omit their MIME type, and generated content uses the bare `image` type. */
function capabilityMediaType(part: MediaPart): string | undefined {
  const mediaType = partMediaType(part);
  if (mediaType?.startsWith("image/")) return mediaType;
  const isImage = part.type === "image" || part.type.startsWith("image-") || mediaType === "image";
  return isImage ? "image/*" : mediaType;
}

function omittedMarker(part: MediaPart, code: string): string {
  const filename = "filename" in part ? part.filename : undefined;
  const mediaType = partMediaType(part);
  const fields = [
    filename === undefined ? null : `filename="${markerValue(filename)}"`,
    mediaType === undefined ? null : `mime="${markerValue(mediaType)}"`,
    `code="${code}"`,
  ].filter((field): field is string => field !== null);
  return `[attachment_omitted ${fields.join(" ")}]`;
}

function recoveryHint(readPath: string | undefined): string {
  return readPath === undefined
    ? "To use the file, convert it or extract its contents with a tool, using resource.materialize with the uri from the attachment marker above when there is one."
    : `To use the file, convert it or extract its contents with a tool from ${readPath}.`;
}

function unsupportedMediaText(part: MediaPart, readPath: string | undefined): string {
  return `${omittedMarker(part, "unsupported_provider")} The current model cannot read this file type, so it is left out. ${recoveryHint(readPath)}`;
}

function rejectedMediaText(part: MediaPart, readPath: string | undefined, reason: string): string {
  return `${omittedMarker(part, "provider_rejected")} The model provider rejected the request that included this file, so it is left out. Provider error: ${reason} ${recoveryHint(readPath)}`;
}

function markerValue(value: string): string {
  return value.replace(/[\n\r"\\]/gu, "_");
}

/** Identifies a media part by content, because request preparation clones messages each step. */
function mediaFingerprint(part: MediaPart): string {
  const filename = "filename" in part ? part.filename : undefined;
  const source = mediaSource(part);
  const hash = createHash("sha256").update(
    JSON.stringify([part.type, partMediaType(part), filename]),
  );
  if (typeof source === "string") return hash.update(`text:${source}`).digest("hex");
  return hash.update("bytes:").update(new Uint8Array(source)).digest("hex");
}

type FingerprintSource = string | Uint8Array | ArrayBuffer;

function mediaSource(part: MediaPart): FingerprintSource {
  switch (part.type) {
    case "image":
      return dataSource(part.image);
    case "file":
      return isInlineFileData(part.data) ? dataSource(part.data.data) : dataSource(part.data);
    case "file-data":
    case "image-data":
      return part.data;
    case "file-url":
    case "image-url":
      return part.url;
    case "file-id":
    case "image-file-id":
      return JSON.stringify(part.fileId);
    case "file-reference":
    case "image-file-reference":
      return JSON.stringify(part.providerReference);
  }
}

function isInlineFileData(
  data: FilePart["data"],
): data is Extract<FilePart["data"], { type: "data" }> {
  return (
    typeof data === "object" &&
    !(data instanceof Uint8Array) &&
    !(data instanceof ArrayBuffer) &&
    !(data instanceof URL) &&
    data.type === "data"
  );
}

function dataSource(
  data: FilePart["data"] | Extract<MediaPart, { type: "image" }>["image"],
): FingerprintSource {
  if (typeof data === "string" || data instanceof Uint8Array || data instanceof ArrayBuffer)
    return data;
  // URLs serialize to their href; provider references and URL or text file data are plain objects.
  return JSON.stringify(data);
}
