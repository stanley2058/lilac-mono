import { Buffer } from "node:buffer";

import type { UserContent } from "ai";
import { fileTypeFromBuffer } from "file-type/core";

import { inferMimeTypeFromFilename } from "../../../shared/attachment-utils";

import type { DiscordAttachmentMeta } from "./types";

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type DiscordAttachmentState = {
  downloadedTotalBytes: number;
  // URL -> downloaded bytes + inferred mime type
  cache: Map<string, { bytes: Uint8Array; mimeType?: string }>;
};

export function createDiscordAttachmentState(): DiscordAttachmentState {
  return {
    downloadedTotalBytes: 0,
    cache: new Map(),
  };
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

function formatDiscordAttachmentHeader(params: {
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
  return `[discord_attachment ${fields.join(" ")}]`;
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

export async function appendDiscordAttachmentsToUserContent(
  parts: Exclude<UserContent, string>,
  attachments: readonly DiscordAttachmentMeta[],
  state: DiscordAttachmentState,
): Promise<void> {
  for (const att of attachments) {
    let url: URL;
    try {
      url = new URL(att.url);
    } catch {
      continue;
    }

    const mimeType = normalizeMimeType(att.mimeType);

    // If Discord provides mime type, follow policy without sniffing.
    // - image/* => image part
    // - application/pdf => file part
    // - text-extractable => download + convert to text part
    // - everything else => do not send as a file part; include URL in text
    if (mimeType) {
      if (isImageMimeType(mimeType)) {
        parts.push({ type: "image", image: url, mediaType: mimeType });
        continue;
      }

      if (isPdfMimeType(mimeType)) {
        parts.push({
          type: "file",
          data: url,
          filename: att.filename,
          mediaType: mimeType,
        });
        continue;
      }

      if (!isTextExtractableMimeType(mimeType)) {
        const header = formatDiscordAttachmentHeader({
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
        const header = formatDiscordAttachmentHeader({
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

      try {
        const cached = state.cache.get(url.toString());
        const downloaded = cached ? null : await downloadDiscordAttachment(url);

        const bytes = cached?.bytes ?? downloaded!.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const header = formatDiscordAttachmentHeader({
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

        if (!cached) {
          const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
          if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
            const header = formatDiscordAttachmentHeader({
              url,
              filename: att.filename,
              mimeType,
              size: att.size,
            });
            parts.push({
              type: "text",
              text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
            });
            continue;
          }

          state.downloadedTotalBytes = nextTotal;
          state.cache.set(url.toString(), { bytes, mimeType });
        }

        const decoded = decodeUtf8BestEffort(bytes);
        const header = formatDiscordAttachmentHeader({
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
          continue;
        }

        const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
        parts.push({
          type: "text",
          text: `${header}\n${decoded.text}${suffix}`,
        });
        continue;
      } catch {
        const header = formatDiscordAttachmentHeader({
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
    }

    const inferred = bestEffortInferMimeType({ filename: att.filename, url });

    if (inferred && isImageMimeType(inferred)) {
      parts.push({ type: "image", image: url, mediaType: inferred });
      continue;
    }

    if (inferred && isPdfMimeType(inferred)) {
      parts.push({
        type: "file",
        data: url,
        filename: att.filename,
        mediaType: "application/pdf",
      });
      continue;
    }

    if (inferred && isTextExtractableMimeType(inferred)) {
      if (att.size !== undefined && att.size > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        const header = formatDiscordAttachmentHeader({
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

      try {
        const cached = state.cache.get(url.toString());
        const downloaded = cached ? null : await downloadDiscordAttachment(url);

        const bytes = cached?.bytes ?? downloaded!.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const header = formatDiscordAttachmentHeader({
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

        if (!cached) {
          const nextTotal = state.downloadedTotalBytes + bytes.byteLength;
          if (nextTotal > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
            const header = formatDiscordAttachmentHeader({
              url,
              filename: att.filename,
              mimeType: inferred,
              size: att.size,
            });
            parts.push({
              type: "text",
              text: `${header}\n(text attachment skipped; total download bytes too large; fetch via URL)`,
            });
            continue;
          }

          state.downloadedTotalBytes = nextTotal;
          state.cache.set(url.toString(), { bytes, mimeType: inferred });
        }

        const decoded = decodeUtf8BestEffort(bytes);
        const header = formatDiscordAttachmentHeader({
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
          continue;
        }

        const suffix = decoded.truncatedBytes ? "\n\n(truncated)" : "";
        parts.push({
          type: "text",
          text: `${header}\n${decoded.text}${suffix}`,
        });
        continue;
      } catch {
        const header = formatDiscordAttachmentHeader({
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
    }

    // If we can infer a non-text, non-pdf, non-image type from filename, treat as binary and
    // leave a URL for the agent to fetch (don't send file part upstream).
    if (inferred && inferred !== "application/octet-stream") {
      const header = formatDiscordAttachmentHeader({
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
          parts.push({ type: "image", image: url, mediaType: fallback });
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

        const header = formatDiscordAttachmentHeader({
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

      try {
        const downloaded = await downloadDiscordAttachment(url);
        bytes = downloaded.bytes;

        if (bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
          const fallback =
            bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
          if (isImageMimeType(fallback)) {
            parts.push({ type: "image", image: url, mediaType: fallback });
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

          const header = formatDiscordAttachmentHeader({
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

        // Track only bytes we actually downloaded in this call.
        state.downloadedTotalBytes += bytes.byteLength;
        if (state.downloadedTotalBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
          const fallback =
            bestEffortInferMimeType({ filename: att.filename, url }) ?? "application/octet-stream";
          if (isImageMimeType(fallback)) {
            parts.push({ type: "image", image: url, mediaType: fallback });
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

          const header = formatDiscordAttachmentHeader({
            url,
            filename: att.filename,
            mimeType: fallback,
            size: att.size,
          });
          parts.push({
            type: "text",
            text: `${header}\n(attachment download skipped; total bytes too large; fetch via URL)`,
          });
          continue;
        }

        const buf = Buffer.from(bytes);
        const detected = await fileTypeFromBuffer(buf);

        resolvedMimeType =
          detected?.mime ||
          downloaded.contentType ||
          inferred ||
          bestEffortInferMimeType({ filename: att.filename, url }) ||
          "application/octet-stream";

        state.cache.set(url.toString(), { bytes, mimeType: resolvedMimeType });
      } catch {
        // Best-effort: fall back to URL-based attachment.
        const header = formatDiscordAttachmentHeader({
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
    }

    const mt = resolvedMimeType ?? "application/octet-stream";
    if (!bytes) {
      const header = formatDiscordAttachmentHeader({
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
      parts.push({ type: "image", image: bytes, mediaType: mt });
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
      const header = formatDiscordAttachmentHeader({
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
    const header = formatDiscordAttachmentHeader({
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
