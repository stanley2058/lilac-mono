import { captureError } from "../../../shared/error-capture";
import { Result, TaggedError } from "better-result";
import { Buffer } from "node:buffer";

import type { UserContent } from "ai";
import type { Result as ResultType } from "better-result";
import { fileTypeFromBuffer, fileTypeStream } from "file-type";
import type {
  BlobDeleteError,
  BlobHandleV1,
  BlobRefV1,
  BlobStore,
  BlobUpload,
} from "@stanley2058/lilac-blob-storage";
import type {
  BusFilePartV2,
  BusResourcePartV1,
  StoredFilePartV1,
  StoredResourcePartV1,
} from "@stanley2058/lilac-event-bus";
import {
  DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
  type RetentionLimit,
} from "@stanley2058/lilac-utils";

import { inferMimeTypeFromFilename } from "../../../shared/attachment-utils";
import type {
  CoreOwnedBlobIntegrityError,
  CoreOwnedBlobReference,
} from "../../../transcript/transcript-store";

import type {
  DiscordAttachmentCacheAccess,
  DiscordAttachmentCacheEntry,
  DiscordAttachmentCacheKey,
  DiscordAttachmentMeta,
} from "../../discord/discord-attachment";

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type DiscordAttachmentState = {
  downloadedTotalBytes: number;
  inlineFileData: boolean;
  // URL -> downloaded bytes + inferred mime type
  cache: Map<string, { bytes: Uint8Array; mimeType?: string }>;
  ownBlob?: (input: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
  }) => ResultType<CoreOwnedBlobReference, CoreOwnedBlobIntegrityError>;
  ownStoredBlob?: (input: {
    blob: BlobRefV1;
    mediaType: string;
    filename: string;
  }) => ResultType<CoreOwnedBlobReference, CoreOwnedBlobIntegrityError>;
  ownershipError: CoreOwnedBlobIntegrityError | null;
  ownedBlobs: Map<string, CoreOwnedBlobReference>;
  currentBlobs: Map<string, CoreOwnedBlobReference>;
  blobStore?: BlobStore;
  attachmentCache?: DiscordAttachmentCacheAccess;
  attachmentCacheTtl: RetentionLimit;
  now: () => number;
  requestHandles: BlobHandleV1[];
};

export function createDiscordAttachmentState(input?: {
  ownBlob?: DiscordAttachmentState["ownBlob"];
  ownStoredBlob?: DiscordAttachmentState["ownStoredBlob"];
  inlineFileData?: boolean;
  blobStore?: BlobStore;
  attachmentCache?: DiscordAttachmentCacheAccess;
  attachmentCacheTtl?: RetentionLimit;
  now?: () => number;
}): DiscordAttachmentState {
  return {
    downloadedTotalBytes: 0,
    inlineFileData: input?.inlineFileData === true,
    cache: new Map(),
    ownBlob: input?.ownBlob,
    ownStoredBlob: input?.ownStoredBlob,
    ownershipError: null,
    ownedBlobs: new Map(),
    currentBlobs: new Map(),
    blobStore: input?.blobStore,
    attachmentCache: input?.attachmentCache,
    attachmentCacheTtl: input?.attachmentCacheTtl ?? {
      kind: "bounded",
      value: DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
    },
    now: input?.now ?? Date.now,
    requestHandles: [],
  };
}

export function getDiscordRequestBlobHandles(
  state: DiscordAttachmentState,
): readonly BlobHandleV1[] {
  return state.requestHandles;
}

export function rememberDiscordRequestBlobHandles(
  state: DiscordAttachmentState,
  handles: readonly BlobHandleV1[],
): void {
  state.requestHandles.push(...handles);
}

export class DiscordRequestBlobCleanupFailed extends TaggedError(
  "DiscordRequestBlobCleanupFailed",
)<{
  readonly failures: readonly BlobDeleteError[];
  readonly objectIds: readonly string[];
  readonly message: string;
}> {}

export async function deleteDiscordRequestBlobHandles(
  blobStore: Pick<BlobStore, "delete">,
  handles: readonly BlobHandleV1[],
): Promise<ResultType<void, DiscordRequestBlobCleanupFailed>> {
  const distinctHandles = new Map(handles.map((handle) => [handle.objectId, handle]));
  const deletions = await Promise.all(
    [...distinctHandles.values()].map(async (handle) => {
      return blobStore.delete(handle);
    }),
  );
  const failures = deletions.flatMap((deleted) =>
    deleted.match<BlobDeleteError[]>({ ok: () => [], err: (error) => [error] }),
  );
  return failures.length === 0
    ? Result.ok(undefined)
    : Result.err(
        new DiscordRequestBlobCleanupFailed({
          failures,
          objectIds: [...distinctHandles.keys()],
          message: "Discord request input handle cleanup failed",
        }),
      );
}

export class DiscordAttachmentPreparationFailed extends TaggedError(
  "DiscordAttachmentPreparationFailed",
)<{
  readonly attachment: string;
  readonly message: string;
}> {}

export type DiscordBusUserContentPart =
  | Exclude<UserContent, string>[number]
  | BusFilePartV2
  | BusResourcePartV1;

export type DiscordStoredUserContentPart =
  | Exclude<UserContent, string>[number]
  | StoredFilePartV1
  | StoredResourcePartV1;

export function getDiscordOwnedBlobReferences(
  state: DiscordAttachmentState,
): CoreOwnedBlobReference[] {
  return [...state.ownedBlobs.values()];
}

export function takeDiscordCurrentBlobReferences(
  state: DiscordAttachmentState,
): CoreOwnedBlobReference[] {
  const references = [...state.currentBlobs.values()];
  state.currentBlobs.clear();
  return references;
}

export function getDiscordAttachmentOwnershipError(
  state: DiscordAttachmentState,
): CoreOwnedBlobIntegrityError | null {
  return state.ownershipError;
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const m = mimeType.split(";")[0]?.trim().toLowerCase();
  return m || undefined;
}

function isTextExtractableMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if (mimeType.endsWith("+json")) return true;

  return (
    mimeType === "application/json" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript"
  );
}

export function canInlineConversationAttachment(mimeType: string, size: number): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (size > DEFAULT_INBOUND_MAX_FILE_BYTES) return false;
  if (!normalized) return true;
  return (
    isTextExtractableMimeType(normalized) ||
    isPdfMimeType(normalized) ||
    isImageMimeType(normalized)
  );
}

function isPdfMimeType(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function escapeMetadataValue(value: string): string {
  // Keep one-line marker robust; avoid breaking quoting.
  return value.replace(/[\n\r"\\]/g, "_");
}

function formatAttachmentHeader(params: {
  url: URL;
  filename?: string;
  mimeType?: string;
  size?: number;
}): string {
  const fields: string[] = [];
  if (params.filename) fields.push(`filename="${escapeMetadataValue(params.filename)}"`);
  if (params.mimeType) fields.push(`mime="${escapeMetadataValue(params.mimeType)}"`);
  if (typeof params.size === "number") fields.push(`size=${params.size}`);
  fields.push(`url="${escapeMetadataValue(params.url.toString())}"`);
  return `[attachment ${fields.join(" ")}]`;
}

function decodeUtf8BestEffort(bytes: Uint8Array): {
  text?: string;
  reason?: "too_large" | "looks_binary";
  truncatedBytes: boolean;
} {
  const MAX_TEXT_BYTES = 512 * 1024;
  const MAX_TEXT_CHARS = 50_000;

  const view = bytes.byteLength > MAX_TEXT_BYTES ? bytes.slice(0, MAX_TEXT_BYTES) : bytes;
  const truncatedBytes = view.byteLength !== bytes.byteLength;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(view);

  // Basic binary guardrails even when mime says text.
  if (text.includes("\u0000")) {
    return { reason: "looks_binary", truncatedBytes, text: undefined };
  }

  const replacementCount = (text.match(/\uFFFD/gu) ?? []).length;
  if (replacementCount > 0) {
    const ratio = replacementCount / Math.max(1, text.length);
    if (ratio > 0.02) {
      return { reason: "looks_binary", truncatedBytes, text: undefined };
    }
  }

  const clamped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const truncated = truncatedBytes || clamped.length !== text.length;
  return { text: clamped, truncatedBytes: truncated, reason: undefined };
}

function bestEffortInferMimeType(params: { filename?: string; url?: URL }): string | undefined {
  if (params.filename) {
    const inferred = inferMimeTypeFromFilename(params.filename);
    if (inferred !== "application/octet-stream") return inferred;
  }

  if (params.url) {
    const path = params.url.pathname.split("/").pop();
    if (path) {
      const inferred = inferMimeTypeFromFilename(path);
      if (inferred !== "application/octet-stream") return inferred;
    }
  }

  return undefined;
}

async function downloadDiscordAttachment(url: URL): Promise<{
  bytes: Uint8Array;
  contentType?: string;
}> {
  if (!DISCORD_CDN_HOSTS.has(url.hostname)) {
    throw new Error(
      `Blocked attachment host '${url.hostname}'. Allowed: ${[...DISCORD_CDN_HOSTS].join(", ")}`,
    );
  }

  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download attachment (${res.status}): ${url.toString()}`);
  }

  const ab = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: normalizeMimeType(res.headers.get("content-type") ?? undefined),
  };
}

function ownAttachmentBytes(input: {
  state: DiscordAttachmentState;
  bytes: Uint8Array;
  mediaType: string;
  filename?: string;
  url: URL;
}): void {
  if (!input.state.ownBlob) return;
  const reference = input.state.ownBlob({
    bytes: input.bytes,
    mediaType: input.mediaType,
    filename: input.filename ?? input.url.pathname.split("/").pop() ?? "attachment",
  });
  reference.match({
    err: (error) => () => {
      input.state.ownershipError ??= error;
    },
    ok: (value) => () => {
      input.state.ownedBlobs.set(value.ownerId, value);
      input.state.currentBlobs.set(value.ownerId, value);
    },
  })();
}

function ownStoredAttachmentBlob(input: {
  state: DiscordAttachmentState;
  blob: BlobRefV1;
  mediaType: string;
  filename?: string;
  url: URL;
}): void {
  if (!input.state.ownStoredBlob) return;
  const owned = input.state.ownStoredBlob({
    blob: input.blob,
    mediaType: input.mediaType,
    filename: input.filename ?? input.url.pathname.split("/").pop() ?? "attachment",
  });
  owned.match({
    err: (error) => () => {
      input.state.ownershipError ??= error;
      if (input.state.blobStore) void input.state.blobStore.delete(input.blob);
    },
    ok: (value) => () => {
      input.state.ownedBlobs.set(value.ownerId, value);
      input.state.currentBlobs.set(value.ownerId, value);
    },
  })();
}

async function resolveOwnedFileData(input: {
  state: DiscordAttachmentState;
  url: URL;
  mediaType: string;
  filename?: string;
}): Promise<URL | Uint8Array> {
  if (!input.state.ownBlob && !input.state.inlineFileData) return input.url;
  const cacheKey = input.url.toString();
  const cached = input.state.cache.get(cacheKey);
  const downloaded = cached ? null : await downloadDiscordAttachment(input.url);
  const bytes = cached?.bytes ?? downloaded!.bytes;
  if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
    throw new Error(`Attachment '${input.filename ?? cacheKey}' exceeds the ownership limit`);
  }
  if (!cached) {
    const nextTotal = input.state.downloadedTotalBytes + bytes.byteLength;
    if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
      throw new Error("Discord attachments exceed the total ownership limit");
    }
    input.state.downloadedTotalBytes = nextTotal;
    input.state.cache.set(cacheKey, { bytes, mimeType: input.mediaType });
  }
  ownAttachmentBytes({ ...input, bytes });
  return bytes;
}

export async function appendDiscordAttachmentsToUserContent(
  parts: Exclude<UserContent, string>,
  attachments: readonly DiscordAttachmentMeta[],
  state: DiscordAttachmentState,
): Promise<void> {
  for (const att of attachments) {
    let url!: URL;
    {
      const attempt = Result.try({
        try: () => {
          url = new URL(att.url);

          return { status: "fallthrough" } as const;
        },
        catch: captureError,
      });
      if (attempt.isErr()) {
        continue;
      }
    }

    const mimeType = normalizeMimeType(att.mimeType);

    // If Discord provides mime type, follow policy without sniffing.
    // - image/* => file part
    // - application/pdf => file part
    // - text-extractable => download + convert to text part
    // - everything else => do not send as a file part; include URL in text
    if (mimeType) {
      if (isImageMimeType(mimeType)) {
        parts.push({
          type: "file",
          data: await resolveOwnedFileData({
            state,
            url,
            mediaType: mimeType,
            filename: att.filename,
          }),
          filename: att.filename,
          mediaType: mimeType,
        });
        continue;
      }

      if (isPdfMimeType(mimeType)) {
        parts.push({
          type: "file",
          data: await resolveOwnedFileData({
            state,
            url,
            mediaType: mimeType,
            filename: att.filename,
          }),
          filename: att.filename,
          mediaType: mimeType,
        });
        continue;
      }

      if (!isTextExtractableMimeType(mimeType)) {
        const header = formatAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(binary attachment; fetch via URL if needed)`,
        });
        continue;
      }

      // Text-extractable: download and inline content.
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const header = formatAttachmentHeader({
          url,
          filename: att.filename,
          mimeType,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment too large to inline; fetch via URL)`,
        });
        continue;
      }

      {
        const attempt = await Result.tryPromise({
          try: async () => {
            const cached = state.cache.get(url.toString());
            const downloaded = cached ? null : await downloadDiscordAttachment(url);

            const bytes = cached?.bytes ?? downloaded!.bytes;

            if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
              const header = formatAttachmentHeader({
                url,
                filename: att.filename,
                mimeType,
                size: att.size,
              });
              parts.push({
                type: "text",
                text: `${header}\n(text attachment too large to inline; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }

            if (!cached) {
              const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
              if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
                const header = formatAttachmentHeader({
                  url,
                  filename: att.filename,
                  mimeType,
                  size: att.size,
                });
                parts.push({
                  type: "text",
                  text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
                });
                return { status: "continue" } as const;
              }

              state.downloadedTotalBytes = nextTotal;
              state.cache.set(url.toString(), { bytes, mimeType });
            }
            ownAttachmentBytes({
              state,
              bytes,
              mediaType: mimeType,
              filename: att.filename,
              url,
            });

            const decoded = decodeUtf8BestEffort(bytes);
            const header = formatAttachmentHeader({
              url,
              filename: att.filename,
              mimeType,
              size: att.size,
            });

            if (!decoded.text) {
              parts.push({
                type: "text",
                text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }

            const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
            parts.push({
              type: "text",
              text: `${header}\n${decoded.text}${suffix}`,
            });
            return { status: "continue" } as const;
          },
          catch: captureError,
        });
        if (attempt.isErr()) {
          const error = attempt.error.cause;
          if (state.ownBlob) throw error;
          const header = formatAttachmentHeader({
            url,
            filename: att.filename,
            mimeType,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(text attachment download failed; fetch via URL)`,
          });
          continue;
        }
        continue;
      }
    }

    const inferred = bestEffortInferMimeType({ filename: att.filename, url });

    if (inferred && isImageMimeType(inferred)) {
      parts.push({
        type: "file",
        data: await resolveOwnedFileData({
          state,
          url,
          mediaType: inferred,
          filename: att.filename,
        }),
        filename: att.filename,
        mediaType: inferred,
      });
      continue;
    }

    if (inferred && isPdfMimeType(inferred)) {
      parts.push({
        type: "file",
        data: await resolveOwnedFileData({
          state,
          url,
          mediaType: "application/pdf",
          filename: att.filename,
        }),
        filename: att.filename,
        mediaType: "application/pdf",
      });
      continue;
    }

    if (inferred && isTextExtractableMimeType(inferred)) {
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const header = formatAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: inferred,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(text attachment too large to inline; fetch via URL)`,
        });
        continue;
      }

      {
        const attempt = await Result.tryPromise({
          try: async () => {
            const cached = state.cache.get(url.toString());
            const downloaded = cached ? null : await downloadDiscordAttachment(url);

            const bytes = cached?.bytes ?? downloaded!.bytes;

            if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
              const header = formatAttachmentHeader({
                url,
                filename: att.filename,
                mimeType: inferred,
                size: att.size,
              });
              parts.push({
                type: "text",
                text: `${header}\n(text attachment too large to inline; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }

            if (!cached) {
              const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
              if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
                const header = formatAttachmentHeader({
                  url,
                  filename: att.filename,
                  mimeType: inferred,
                  size: att.size,
                });
                parts.push({
                  type: "text",
                  text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
                });
                return { status: "continue" } as const;
              }

              state.downloadedTotalBytes = nextTotal;
              state.cache.set(url.toString(), { bytes, mimeType: inferred });
            }
            ownAttachmentBytes({
              state,
              bytes,
              mediaType: inferred,
              filename: att.filename,
              url,
            });

            const decoded = decodeUtf8BestEffort(bytes);
            const header = formatAttachmentHeader({
              url,
              filename: att.filename,
              mimeType: inferred,
              size: att.size,
            });

            if (!decoded.text) {
              parts.push({
                type: "text",
                text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }

            const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
            parts.push({
              type: "text",
              text: `${header}\n${decoded.text}${suffix}`,
            });
            return { status: "continue" } as const;
          },
          catch: captureError,
        });
        if (attempt.isErr()) {
          const error = attempt.error.cause;
          if (state.ownBlob) throw error;
          const header = formatAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: inferred,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(text attachment download failed; fetch via URL)`,
          });
          continue;
        }
        continue;
      }
    }

    // If we can infer a non-text, non-pdf, non-image type from filename, treat as binary and
    // leave a URL for the agent to fetch (don't send file part upstream).
    if (inferred && inferred !== "application/octet-stream") {
      const header = formatAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: inferred,
        size: att.size,
      });
      parts.push({
        type: "text",
        text: `${header}\n(binary attachment; fetch via URL if needed)`,
      });
      continue;
    }

    // Unknown: download once, infer, and (only) inline if it's text-extractable.
    const cached = state.cache.get(url.toString());

    let bytes: Uint8Array | undefined;
    let resolvedMimeType: string | undefined;

    if (cached) {
      bytes = cached.bytes;
      resolvedMimeType = cached.mimeType;
    } else {
      // Size pre-check if available.
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const fallback =
          bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
        if (isImageMimeType(fallback)) {
          parts.push({
            type: "file",
            data: url,
            filename: att.filename,
            mediaType: fallback,
          });
          continue;
        }
        if (isPdfMimeType(fallback)) {
          parts.push({
            type: "file",
            data: url,
            filename: att.filename,
            mediaType: "application/pdf",
          });
          continue;
        }

        const header = formatAttachmentHeader({
          url,
          filename: att.filename,
          mimeType: fallback,
          size: att.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(attachment too large to download; fetch via URL)`,
        });
        continue;
      }

      {
        const attempt = await Result.tryPromise({
          try: async () => {
            const downloaded = await downloadDiscordAttachment(url);
            bytes = downloaded.bytes;

            if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
              const fallback =
                bestEffortInferMimeType({ filename: att.filename, url }) ??
                "application/octet-stream";
              if (isImageMimeType(fallback)) {
                parts.push({
                  type: "file",
                  data: url,
                  filename: att.filename,
                  mediaType: fallback,
                });
                return { status: "continue" } as const;
              }
              if (isPdfMimeType(fallback)) {
                parts.push({
                  type: "file",
                  data: url,
                  filename: att.filename,
                  mediaType: "application/pdf",
                });
                return { status: "continue" } as const;
              }

              const header = formatAttachmentHeader({
                url,
                filename: att.filename,
                mimeType: fallback,
                size: att.size,
              });
              parts.push({
                type: "text",
                text: `${header}\n(attachment too large to download; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }

            // Track only bytes we actually downloaded in this call.
            const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
            if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
              const fallback =
                bestEffortInferMimeType({ filename: att.filename, url }) ??
                "application/octet-stream";
              if (isImageMimeType(fallback)) {
                parts.push({
                  type: "file",
                  data: url,
                  filename: att.filename,
                  mediaType: fallback,
                });
                return { status: "continue" } as const;
              }
              if (isPdfMimeType(fallback)) {
                parts.push({
                  type: "file",
                  data: url,
                  filename: att.filename,
                  mediaType: "application/pdf",
                });
                return { status: "continue" } as const;
              }

              const header = formatAttachmentHeader({
                url,
                filename: att.filename,
                mimeType: fallback,
                size: att.size,
              });
              parts.push({
                type: "text",
                text: `${header}\n(attachment download skipped; total bytes too large; fetch via URL)`,
              });
              return { status: "continue" } as const;
            }
            state.downloadedTotalBytes = nextTotal;

            const buf = Buffer.from(bytes);
            const detected = await fileTypeFromBuffer(buf);

            resolvedMimeType =
              detected?.mime ||
              downloaded.contentType ||
              inferred ||
              bestEffortInferMimeType({ filename: att.filename, url }) ||
              "application/octet-stream";

            ownAttachmentBytes({
              state,
              bytes,
              mediaType: resolvedMimeType,
              filename: att.filename,
              url,
            });

            state.cache.set(url.toString(), {
              bytes,
              mimeType: resolvedMimeType,
            });

            return { status: "fallthrough" } as const;
          },
          catch: captureError,
        });
        if (attempt.isErr()) {
          const error = attempt.error.cause;
          if (state.ownBlob) throw error;
          // Best-effort: fall back to URL-based attachment.
          const header = formatAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: inferred,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(attachment download failed; fetch via URL)`,
          });
          continue;
        }
        continue;
      }
    }

    const mt = resolvedMimeType ?? "application/octet-stream";
    if (!bytes) {
      const header = formatAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: mt,
        size: att.size,
      });
      parts.push({
        type: "text",
        text: `${header}\n(attachment unavailable; fetch via URL)`,
      });
      continue;
    }

    if (isImageMimeType(mt)) {
      parts.push({
        type: "file",
        data: bytes,
        filename: att.filename,
        mediaType: mt,
      });
      continue;
    }

    if (isPdfMimeType(mt)) {
      parts.push({
        type: "file",
        data: bytes,
        filename: att.filename,
        mediaType: "application/pdf",
      });
      continue;
    }

    if (isTextExtractableMimeType(mt)) {
      const decoded = decodeUtf8BestEffort(bytes);
      const header = formatAttachmentHeader({
        url,
        filename: att.filename,
        mimeType: mt,
        size: att.size,
      });

      if (!decoded.text) {
        parts.push({
          type: "text",
          text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
        });
        continue;
      }

      const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
      parts.push({
        type: "text",
        text: `${header}\n${decoded.text}${suffix}`,
      });
      continue;
    }

    // Non-text binary: do not send as file part.
    const header = formatAttachmentHeader({
      url,
      filename: att.filename,
      mimeType: mt,
      size: att.size,
    });
    parts.push({
      type: "text",
      text: `${header}\n(binary attachment; fetch via URL if needed)`,
    });
  }
}

function attachmentPreparationError(
  attachment: DiscordAttachmentMeta,
  message: string,
): DiscordAttachmentPreparationFailed {
  return new DiscordAttachmentPreparationFailed({
    attachment: attachment.filename ?? attachment.id ?? attachment.url,
    message,
  });
}

function accountDownloadedBytes(input: {
  state: DiscordAttachmentState;
  attachment: DiscordAttachmentMeta;
  fileBytes: number;
  chunkBytes: number;
}): ResultType<void, DiscordAttachmentPreparationFailed> {
  if (input.fileBytes + input.chunkBytes > DEFAULT_INBOUND_MAX_FILE_BYTES) {
    return Result.err(
      attachmentPreparationError(input.attachment, "Discord attachment exceeds the per-file limit"),
    );
  }
  if (input.state.downloadedTotalBytes + input.chunkBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
    return Result.err(
      attachmentPreparationError(
        input.attachment,
        "Discord attachments exceed the total download limit",
      ),
    );
  }
  input.state.downloadedTotalBytes += input.chunkBytes;
  return Result.ok(undefined);
}

function limitDiscordAttachmentStream(input: {
  state: DiscordAttachmentState;
  attachment: DiscordAttachmentMeta;
  source: ReadableStream<Uint8Array>;
}): ReadableStream<Uint8Array> {
  let fileBytes = 0;
  return input.source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const accounted = accountDownloadedBytes({
          state: input.state,
          attachment: input.attachment,
          fileBytes,
          chunkBytes: chunk.byteLength,
        });
        accounted.match({
          ok: () => {
            fileBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          err: (error) => controller.error(error),
        });
      },
    }),
  );
}

function attachmentCacheKey(input: {
  channelId: string;
  messageId: string;
  ordinal: number;
  attachment: DiscordAttachmentMeta;
}): DiscordAttachmentCacheKey {
  return {
    channelId: input.channelId,
    messageId: input.messageId,
    ordinal: input.ordinal,
    ...(input.attachment.id ? { attachmentId: input.attachment.id } : {}),
  };
}

function readAttachmentCacheEntry(
  state: DiscordAttachmentState,
  key: DiscordAttachmentCacheKey,
  attachment: DiscordAttachmentMeta,
): DiscordAttachmentCacheEntry | null {
  if (!state.attachmentCache) return attachment.cache ?? null;
  const cached = Result.try({
    try: () => state.attachmentCache!.get(key),
    catch: captureError,
  });
  if (cached.isErr()) return attachment.cache ?? null;
  return cached.value ?? attachment.cache ?? null;
}

function clearAttachmentCacheEntry(
  state: DiscordAttachmentState,
  key: DiscordAttachmentCacheKey,
  fallback: BlobRefV1,
): void {
  const cleared = state.attachmentCache
    ? Result.try({
        try: () => state.attachmentCache!.clear({ ...key, expected: fallback }),
        catch: captureError,
      }).match({ ok: (value) => value, err: () => null })
    : null;
  if (state.blobStore) void state.blobStore.delete(cleared ?? fallback);
}

async function readVerifiedCacheBytes(input: {
  state: DiscordAttachmentState;
  key: DiscordAttachmentCacheKey;
  attachment: DiscordAttachmentMeta;
}): Promise<Uint8Array | null> {
  const cached = readAttachmentCacheEntry(input.state, input.key, input.attachment);
  if (!cached || !input.state.blobStore) return null;
  const now = input.state.now();
  const physicallyExpired = cached.blob.expiresAt !== undefined && cached.blob.expiresAt <= now;
  const olderThanConfiguredTtl =
    input.state.attachmentCacheTtl.kind === "bounded" &&
    cached.cachedAt + input.state.attachmentCacheTtl.value <= now;
  if (physicallyExpired || olderThanConfiguredTtl) {
    clearAttachmentCacheEntry(input.state, input.key, cached.blob);
    return null;
  }

  const opened = await input.state.blobStore.open(cached.blob);
  const read = opened.match({ ok: (value) => value, err: () => null });
  if (!read) {
    clearAttachmentCacheEntry(input.state, input.key, cached.blob);
    return null;
  }
  const consumed = await Result.tryPromise({
    try: async () => new Uint8Array(await new Response(read.stream).arrayBuffer()),
    catch: captureError,
  });
  const completion = await read.completion;
  const verified = completion.match({ ok: () => true, err: () => false });
  const bytes = consumed.match({ ok: (value) => value, err: () => null });
  if (!bytes || !verified) {
    clearAttachmentCacheEntry(input.state, input.key, cached.blob);
    return null;
  }
  return bytes;
}

function rememberCompletedCacheUpload(input: {
  state: DiscordAttachmentState;
  key: DiscordAttachmentCacheKey;
  upload: BlobUpload;
  cachedAt: number;
}): void {
  void input.upload.completion.then((completed) => {
    completed.match({
      err: () => undefined,
      ok: (blob) => {
        if (!input.state.attachmentCache) return;
        Result.try({
          try: () =>
            input.state.attachmentCache!.put({
              ...input.key,
              blob,
              cachedAt: input.cachedAt,
            }),
          catch: captureError,
        });
      },
    });
  });
}

async function startCacheUpload(input: {
  state: DiscordAttachmentState;
  key: DiscordAttachmentCacheKey;
  source: Uint8Array | ReadableStream<Uint8Array>;
  expectedByteLength?: number;
  expectedSha256?: string;
}): Promise<void> {
  if (!input.state.blobStore || !input.state.attachmentCache) return;
  const cachedAt = input.state.now();
  const retention =
    input.state.attachmentCacheTtl.kind === "unlimited"
      ? ({ kind: "durable" } as const)
      : ({
          kind: "expires",
          expiresAt: cachedAt + input.state.attachmentCacheTtl.value,
        } as const);
  const started = await input.state.blobStore.startUpload({
    source: input.source,
    retention,
    ...(input.expectedByteLength !== undefined
      ? { expectedByteLength: input.expectedByteLength }
      : {}),
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
  });
  started.match({
    err: () => {
      if (input.source instanceof ReadableStream) void input.source.cancel();
    },
    ok: (upload) => rememberCompletedCacheUpload({ ...input, upload, cachedAt }),
  });
}

async function startDurableRequestUpload(input: {
  state: DiscordAttachmentState;
  metadata: DiscordAttachmentMeta;
  source: Uint8Array | ReadableStream<Uint8Array>;
  expectedByteLength?: number;
  expectedSha256?: string;
}): Promise<ResultType<BlobHandleV1, DiscordAttachmentPreparationFailed>> {
  if (!input.state.blobStore) {
    return Result.err(
      attachmentPreparationError(
        input.metadata,
        "Blob storage is unavailable while preparing Discord media",
      ),
    );
  }
  const started = await input.state.blobStore.startUpload({
    source: input.source,
    retention: { kind: "durable" },
    ...(input.expectedByteLength !== undefined
      ? { expectedByteLength: input.expectedByteLength }
      : {}),
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
  });
  return started.match<ResultType<BlobHandleV1, DiscordAttachmentPreparationFailed>>({
    err: (error) => {
      if (input.source instanceof ReadableStream) void input.source.cancel();
      return Result.err(
        attachmentPreparationError(
          input.metadata,
          `Failed to reserve durable attachment upload: ${error.message}`,
        ),
      );
    },
    ok: (upload) => {
      input.state.requestHandles.push(upload.handle);
      return Result.ok(upload.handle);
    },
  });
}

async function uploadDurableStoredBlob(input: {
  state: DiscordAttachmentState;
  metadata: DiscordAttachmentMeta;
  source: Uint8Array | ReadableStream<Uint8Array>;
  expectedByteLength?: number;
  expectedSha256?: string;
}): Promise<ResultType<BlobRefV1, DiscordAttachmentPreparationFailed>> {
  if (!input.state.blobStore) {
    return Result.err(
      attachmentPreparationError(
        input.metadata,
        "Blob storage is unavailable while preparing Discord media",
      ),
    );
  }
  const started = await input.state.blobStore.startUpload({
    source: input.source,
    retention: { kind: "durable" },
    ...(input.expectedByteLength !== undefined
      ? { expectedByteLength: input.expectedByteLength }
      : {}),
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
  });
  const upload = started.match({ ok: (value) => value, err: () => null });
  if (!upload) {
    if (input.source instanceof ReadableStream) void input.source.cancel();
    const startError = started.match({
      ok: () =>
        attachmentPreparationError(
          input.metadata,
          "Durable attachment upload reservation returned no upload",
        ),
      err: (error) =>
        attachmentPreparationError(
          input.metadata,
          `Failed to reserve durable attachment upload: ${error.message}`,
        ),
    });
    return Result.err(startError);
  }
  const completed = await upload.completion;
  return completed.mapError((error) =>
    attachmentPreparationError(
      input.metadata,
      `Failed to store durable attachment: ${error.message}`,
    ),
  );
}

async function loadAttachmentBytes(input: {
  state: DiscordAttachmentState;
  key: DiscordAttachmentCacheKey;
  attachment: DiscordAttachmentMeta;
  url: URL;
}): Promise<
  ResultType<{ bytes: Uint8Array; contentType?: string }, DiscordAttachmentPreparationFailed>
> {
  const cached = await readVerifiedCacheBytes(input);
  if (cached) {
    const detected = await fileTypeFromBuffer(Buffer.from(cached));
    const accounted = accountDownloadedBytes({
      state: input.state,
      attachment: input.attachment,
      fileBytes: 0,
      chunkBytes: cached.byteLength,
    });
    return accounted.map(() => ({
      bytes: cached,
      contentType: normalizeMimeType(detected?.mime ?? input.attachment.mimeType),
    }));
  }

  if (
    input.attachment.size !== undefined &&
    input.attachment.size > DEFAULT_INBOUND_MAX_FILE_BYTES
  ) {
    return Result.err(
      attachmentPreparationError(input.attachment, "Discord attachment exceeds the per-file limit"),
    );
  }
  if (
    input.attachment.size !== undefined &&
    input.state.downloadedTotalBytes + input.attachment.size > DEFAULT_INBOUND_MAX_TOTAL_BYTES
  ) {
    return Result.err(
      attachmentPreparationError(
        input.attachment,
        "Discord attachments exceed the total download limit",
      ),
    );
  }

  const downloaded = await Result.tryPromise({
    try: async () => {
      if (!DISCORD_CDN_HOSTS.has(input.url.hostname)) {
        throw new Error(`Blocked attachment host '${input.url.hostname}'`);
      }
      const response = await fetch(input.url.toString(), {
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`Failed to download attachment (${response.status})`);
      if (!response.body) throw new Error("Discord attachment response has no body");
      const source = limitDiscordAttachmentStream({
        state: input.state,
        attachment: input.attachment,
        source: response.body,
      });
      return {
        bytes: new Uint8Array(await new Response(source).arrayBuffer()),
        contentType: normalizeMimeType(response.headers.get("content-type") ?? undefined),
      };
    },
    catch: captureError,
  });
  if (downloaded.isErr()) {
    return Result.err(attachmentPreparationError(input.attachment, downloaded.error.cause.message));
  }
  const bytes = downloaded.value.bytes;
  await startCacheUpload({
    state: input.state,
    key: input.key,
    source: bytes,
    expectedByteLength: bytes.byteLength,
  });
  return Result.ok(downloaded.value);
}

async function appendKnownBlobAttachment(input: {
  parts: DiscordBusUserContentPart[];
  state: DiscordAttachmentState;
  key: DiscordAttachmentCacheKey;
  attachment: DiscordAttachmentMeta;
  url: URL;
  mediaType: string;
}): Promise<ResultType<void, DiscordAttachmentPreparationFailed>> {
  const cached = await readVerifiedCacheBytes(input);
  if (cached) {
    const detected = await fileTypeFromBuffer(Buffer.from(cached));
    const cachedMediaType = normalizeMimeType(detected?.mime ?? input.mediaType);
    if (
      !cachedMediaType ||
      (!isImageMimeType(cachedMediaType) && !isPdfMimeType(cachedMediaType))
    ) {
      return Result.err(
        attachmentPreparationError(
          input.attachment,
          `Cached attachment type '${cachedMediaType ?? "unknown"}' is not supported as direct media`,
        ),
      );
    }
    const accounted = accountDownloadedBytes({
      state: input.state,
      attachment: input.attachment,
      fileBytes: 0,
      chunkBytes: cached.byteLength,
    });
    const accountingError = accounted.match({
      ok: () => null,
      err: (error) => error,
    });
    if (accountingError) return Result.err(accountingError);
    const cachedEntry = readAttachmentCacheEntry(input.state, input.key, input.attachment);
    const started = await startDurableRequestUpload({
      state: input.state,
      metadata: input.attachment,
      source: cached,
      expectedByteLength: cached.byteLength,
      ...(cachedEntry ? { expectedSha256: cachedEntry.blob.sha256 } : {}),
    });
    return started.map((handle) => {
      input.parts.push({
        type: "blob",
        blob: handle,
        mediaType: cachedMediaType,
        ...(input.attachment.filename ? { filename: input.attachment.filename } : {}),
      });
    });
  }

  if (
    input.attachment.size !== undefined &&
    input.attachment.size > DEFAULT_INBOUND_MAX_FILE_BYTES
  ) {
    return Result.err(
      attachmentPreparationError(input.attachment, "Discord attachment exceeds the per-file limit"),
    );
  }

  const responseAttempt = await Result.tryPromise({
    try: async () => {
      if (!DISCORD_CDN_HOSTS.has(input.url.hostname)) {
        throw new Error(`Blocked attachment host '${input.url.hostname}'`);
      }
      const response = await fetch(input.url.toString(), {
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`Failed to download attachment (${response.status})`);
      if (!response.body) throw new Error("Discord attachment response has no body");
      return {
        body: response.body,
        responseMimeType: normalizeMimeType(response.headers.get("content-type") ?? undefined),
      };
    },
    catch: captureError,
  });
  if (responseAttempt.isErr()) {
    return Result.err(
      attachmentPreparationError(input.attachment, responseAttempt.error.cause.message),
    );
  }

  const expectedByteLength = input.attachment.size;
  if (
    expectedByteLength !== undefined &&
    input.state.downloadedTotalBytes + expectedByteLength > DEFAULT_INBOUND_MAX_TOTAL_BYTES
  ) {
    void responseAttempt.value.body.cancel();
    return Result.err(
      attachmentPreparationError(
        input.attachment,
        "Discord attachments exceed the total download limit",
      ),
    );
  }
  const [inspectionSource, downloadedStream] = responseAttempt.value.body.tee();
  const detectedType = await Result.tryPromise({
    try: async () => {
      const inspected = await fileTypeStream(inspectionSource);
      void inspected.cancel();
      return inspected.fileType;
    },
    catch: captureError,
  });
  const detectionError = detectedType.match({
    ok: () => null,
    err: (error) => error,
  });
  if (detectionError) {
    void downloadedStream.cancel();
    return Result.err(
      attachmentPreparationError(
        input.attachment,
        `Failed to inspect downloaded attachment type: ${detectionError.cause.message}`,
      ),
    );
  }
  const downloadedMediaType = normalizeMimeType(
    detectedType.match({ ok: (detected) => detected?.mime, err: () => undefined }) ??
      responseAttempt.value.responseMimeType ??
      input.mediaType,
  );
  if (
    !downloadedMediaType ||
    (!isImageMimeType(downloadedMediaType) && !isPdfMimeType(downloadedMediaType))
  ) {
    void downloadedStream.cancel();
    return Result.err(
      attachmentPreparationError(
        input.attachment,
        `Downloaded attachment type '${downloadedMediaType ?? "unknown"}' is not supported as direct media`,
      ),
    );
  }
  const limitedSource = limitDiscordAttachmentStream({
    state: input.state,
    attachment: input.attachment,
    source: downloadedStream,
  });
  const [requestSource, cacheSource] = input.state.attachmentCache
    ? limitedSource.tee()
    : [limitedSource, null];
  const requestUpload = await startDurableRequestUpload({
    state: input.state,
    metadata: input.attachment,
    source: requestSource,
  });
  const handle = requestUpload.match({ ok: (value) => value, err: () => null });
  if (!handle) {
    if (cacheSource) void cacheSource.cancel();
    return requestUpload.map(() => undefined);
  }
  if (cacheSource) {
    await startCacheUpload({
      state: input.state,
      key: input.key,
      source: cacheSource,
    });
  }
  input.parts.push({
    type: "blob",
    blob: handle,
    mediaType: downloadedMediaType,
    ...(input.attachment.filename ? { filename: input.attachment.filename } : {}),
  });
  return Result.ok(undefined);
}

/**
 * Compose Discord attachments for the Redis request contract.
 *
 * Binary parts contain durable upload handles. This function waits only for storage reservations, not
 * for upload completion. Text extraction still waits for the bounded attachment download because the
 * extracted text itself is part of the request envelope.
 */
export async function appendDiscordAttachmentsToBusContent(
  parts: DiscordBusUserContentPart[],
  attachments: readonly DiscordAttachmentMeta[],
  state: DiscordAttachmentState,
  context: { readonly channelId: string; readonly messageId: string },
): Promise<ResultType<void, DiscordAttachmentPreparationFailed>> {
  for (const [ordinal, attachment] of attachments.entries()) {
    const parsedUrl = Result.try({
      try: () => new URL(attachment.url),
      catch: captureError,
    });
    if (parsedUrl.isErr()) continue;
    const url = parsedUrl.value;
    const key = attachmentCacheKey({ ...context, ordinal, attachment });
    const declaredMimeType = normalizeMimeType(attachment.mimeType);
    const inferredMimeType = bestEffortInferMimeType({
      filename: attachment.filename,
      url,
    });
    const initialMimeType = declaredMimeType ?? inferredMimeType;

    if (initialMimeType && (isImageMimeType(initialMimeType) || isPdfMimeType(initialMimeType))) {
      const appended = await appendKnownBlobAttachment({
        parts,
        state,
        key,
        attachment,
        url,
        mediaType: initialMimeType,
      });
      const error = appended.match({ ok: () => null, err: (value) => value });
      if (error) return Result.err(error);
      continue;
    }

    if (declaredMimeType && !isTextExtractableMimeType(declaredMimeType)) {
      const header = formatAttachmentHeader({
        url,
        filename: attachment.filename,
        mimeType: declaredMimeType,
        size: attachment.size,
      });
      parts.push({
        type: "text",
        text: `${header}\n(binary attachment; fetch via URL if needed)`,
      });
      continue;
    }

    const loaded = await loadAttachmentBytes({ state, key, attachment, url });
    const loadError = loaded.match({ ok: () => null, err: (value) => value });
    if (loadError) return Result.err(loadError);
    const value = loaded.match({ ok: (bytes) => bytes, err: () => null });
    if (!value) continue;
    const detected = await fileTypeFromBuffer(Buffer.from(value.bytes));
    const mediaType =
      detected?.mime ??
      value.contentType ??
      declaredMimeType ??
      inferredMimeType ??
      "application/octet-stream";

    if (isImageMimeType(mediaType) || isPdfMimeType(mediaType)) {
      const started = await startDurableRequestUpload({
        state,
        metadata: attachment,
        source: value.bytes,
        expectedByteLength: value.bytes.byteLength,
      });
      const handle = started.match({ ok: (blob) => blob, err: () => null });
      if (!handle) return started.map(() => undefined);
      parts.push({
        type: "blob",
        blob: handle,
        mediaType,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
      continue;
    }

    const header = formatAttachmentHeader({
      url,
      filename: attachment.filename,
      mimeType: mediaType,
      size: attachment.size,
    });
    if (!isTextExtractableMimeType(mediaType)) {
      parts.push({
        type: "text",
        text: `${header}\n(binary attachment; fetch via URL if needed)`,
      });
      continue;
    }
    const decoded = decodeUtf8BestEffort(value.bytes);
    if (!decoded.text) {
      parts.push({
        type: "text",
        text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `${header}\n${decoded.text}${decoded.truncatedBytes ? "\n\n(truncated)" : ""}`,
    });
  }
  return Result.ok(undefined);
}

/**
 * Compose reference-bearing attachment parts for a durable surface projection.
 *
 * Each blob is independently owned from the request upload. Unlike the bus helper, this function waits
 * for each upload to finish so the caller can commit only resolved references through
 * `putCoreOwnedBlob({ blob, mediaType, filename })`.
 */
export async function appendDiscordAttachmentsToStoredContent(
  parts: DiscordStoredUserContentPart[],
  attachments: readonly DiscordAttachmentMeta[],
  state: DiscordAttachmentState,
  context: { readonly channelId: string; readonly messageId: string },
): Promise<ResultType<void, DiscordAttachmentPreparationFailed>> {
  for (const [ordinal, attachment] of attachments.entries()) {
    const parsedUrl = Result.try({
      try: () => new URL(attachment.url),
      catch: captureError,
    });
    if (parsedUrl.isErr()) continue;
    const url = parsedUrl.value;
    const key = attachmentCacheKey({ ...context, ordinal, attachment });
    const declaredMimeType = normalizeMimeType(attachment.mimeType);
    const inferredMimeType = bestEffortInferMimeType({
      filename: attachment.filename,
      url,
    });

    if (declaredMimeType && !isTextExtractableMimeType(declaredMimeType)) {
      if (!isImageMimeType(declaredMimeType) && !isPdfMimeType(declaredMimeType)) {
        const header = formatAttachmentHeader({
          url,
          filename: attachment.filename,
          mimeType: declaredMimeType,
          size: attachment.size,
        });
        parts.push({
          type: "text",
          text: `${header}\n(binary attachment; fetch via URL if needed)`,
        });
        continue;
      }
    }

    const loaded = await loadAttachmentBytes({ state, key, attachment, url });
    const loadError = loaded.match({ ok: () => null, err: (value) => value });
    if (loadError) return Result.err(loadError);
    const value = loaded.match({ ok: (bytes) => bytes, err: () => null });
    if (!value) continue;
    const detected = await fileTypeFromBuffer(Buffer.from(value.bytes));
    const mediaType =
      detected?.mime ??
      value.contentType ??
      declaredMimeType ??
      inferredMimeType ??
      "application/octet-stream";

    if (isImageMimeType(mediaType) || isPdfMimeType(mediaType)) {
      const stored = await uploadDurableStoredBlob({
        state,
        metadata: attachment,
        source: value.bytes,
        expectedByteLength: value.bytes.byteLength,
      });
      const blob = stored.match({ ok: (ref) => ref, err: () => null });
      if (!blob) return stored.map(() => undefined);
      ownStoredAttachmentBlob({
        state,
        blob,
        mediaType,
        filename: attachment.filename,
        url,
      });
      parts.push({
        type: "blob",
        blob,
        mediaType,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
      continue;
    }

    const header = formatAttachmentHeader({
      url,
      filename: attachment.filename,
      mimeType: mediaType,
      size: attachment.size,
    });
    if (!isTextExtractableMimeType(mediaType)) {
      parts.push({
        type: "text",
        text: `${header}\n(binary attachment; fetch via URL if needed)`,
      });
      continue;
    }
    const decoded = decodeUtf8BestEffort(value.bytes);
    if (!decoded.text) {
      parts.push({
        type: "text",
        text: `${header}\n(text extraction failed: ${decoded.reason ?? "unknown"}; fetch via URL)`,
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `${header}\n${decoded.text}${decoded.truncatedBytes ? "\n\n(truncated)" : ""}`,
    });
  }
  return Result.ok(undefined);
}
