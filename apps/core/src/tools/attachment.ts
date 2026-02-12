import { tool, type ModelMessage } from "ai";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { fileTypeFromBuffer } from "file-type/core";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { expandTilde } from "./fs/fs-impl";
import {
  decodeDataUrl,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  looksLikeDataUrl,
  looksLikeHttpUrl,
  resolveToolPath,
  sanitizeExtension,
} from "../shared/attachment-utils";
import { requireRequestContext } from "../shared/req-context";

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

const nonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));

  if (typeof data === "string") {
    if (looksLikeDataUrl(data)) {
      return decodeDataUrl(data).bytes;
    }

    // AI SDK DataContent string is defined as base64.
    return Buffer.from(data, "base64");
  }

  // URL is handled separately.
  throw new Error("Unsupported data content");
}

const attachmentAddFilesInputSchema = z
  .object({
    paths: nonEmptyStringListInputSchema
      .describe("Local file paths to attach (resolved relative to tool cwd)"),
    filenames: optionalNonEmptyStringListInputSchema.describe(
      "Optional filenames for each attachment",
    ),
    mimeTypes: optionalNonEmptyStringListInputSchema.describe(
      "Optional mime types for each attachment",
    ),
  })
  .describe("Add one or more attachments from local files.");

const attachmentAddOutputSchema = z.object({
  ok: z.literal(true),
  attachments: z.array(
    z.object({
      filename: z.string(),
      mimeType: z.string(),
      bytes: z.number(),
    }),
  ),
});

type DetectedAttachment =
  | {
      kind: "image";
      source: string;
      mediaTypeHint?: string;
      filenameHint?: string;
      data: unknown;
    }
  | {
      kind: "file";
      source: string;
      mediaTypeHint: string;
      filenameHint?: string;
      data: unknown;
    };

const attachmentDownloadInputSchema = z.object({
  downloadDir: z
    .string()
    .optional()
    .describe("Directory to save downloaded files (default: ~/Downloads)"),
});

const attachmentDownloadOutputSchema = z.object({
  ok: z.literal(true),
  downloadDir: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      sha10: z.string(),
      bytes: z.number(),
      sourceUrl: z.string(),
      mimeType: z.string().optional(),
    }),
  ),
});

type AttachmentDownloadOutput = z.infer<typeof attachmentDownloadOutputSchema>;

function collectUserAttachments(
  messages: readonly ModelMessage[],
): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];

  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!Array.isArray(m.content)) continue;

    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part;

      const type = p.type;
      if (type === "image") {
        out.push({
          kind: "image",
          source: "user-message",
          mediaTypeHint: p.mediaType,
          data: p.image,
        });
        continue;
      }

      if (type === "file") {
        const mediaType = p.mediaType;
        if (typeof mediaType !== "string" || mediaType.length === 0) {
          // FilePart.mediaType is required; if missing, keep a conservative default.
          out.push({
            kind: "file",
            source: "user-message",
            mediaTypeHint: "application/octet-stream",
            filenameHint: p.filename,
            data: p.data,
          });
          continue;
        }

        out.push({
          kind: "file",
          source: "user-message",
          mediaTypeHint: mediaType,
          filenameHint: p.filename,
          data: p.data,
        });
        continue;
      }

      // Ignore text/unknown parts.
    }
  }

  return out;
}

async function downloadToBuffer(input: unknown): Promise<{
  bytes: Buffer;
  sourceUrl?: string;
  contentType?: string;
}> {
  if (input instanceof URL) {
    if (!DISCORD_CDN_HOSTS.has(input.hostname)) {
      throw new Error(
        `Blocked attachment host '${input.hostname}'. Allowed: ${[...DISCORD_CDN_HOSTS].join(", ")}`,
      );
    }

    const res = await fetch(input.toString(), { redirect: "follow" });
    if (!res.ok) {
      throw new Error(
        `Failed to download attachment (${res.status}): ${input}`,
      );
    }
    const ab = await res.arrayBuffer();
    return {
      bytes: Buffer.from(ab),
      sourceUrl: input.toString(),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  if (typeof input === "string" && looksLikeHttpUrl(input)) {
    return await downloadToBuffer(new URL(input));
  }

  if (typeof input === "string" && looksLikeDataUrl(input)) {
    const decoded = decodeDataUrl(input);
    return { bytes: decoded.bytes, contentType: decoded.mimeType };
  }

  return { bytes: asBuffer(input) };
}

export function attachmentTools(params: { bus: LilacBus; cwd: string }) {
  const { bus, cwd } = params;

  return {
    "attachment.add_files": tool({
      description: "Reads local files and attaches them to the current reply.",
      inputSchema: attachmentAddFilesInputSchema,
      outputSchema: attachmentAddOutputSchema,
      execute: async (input, { experimental_context }) => {
        const ctx = requireRequestContext(
          experimental_context,
          "attachment.add_files",
        );

        let totalBytes = 0;

        const out: Array<{
          filename: string;
          mimeType: string;
          bytes: number;
        }> = [];

        for (let i = 0; i < input.paths.length; i++) {
          const p = input.paths[i]!;
          const resolvedPath = resolveToolPath(cwd, p);

          const st = await fs.stat(resolvedPath);
          if (!st.isFile()) {
            throw new Error(`Not a file: ${resolvedPath}`);
          }

          if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
            throw new Error(
              `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${resolvedPath}`,
            );
          }

          totalBytes += st.size;
          if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
            throw new Error(
              `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
            );
          }

          const bytes = await fs.readFile(resolvedPath);

          const filename =
            (input.filenames && input.filenames[i]) || basename(resolvedPath);

          const typeFromBytes = await fileTypeFromBuffer(bytes);

          const mimeType =
            (input.mimeTypes && input.mimeTypes[i]) ||
            typeFromBytes?.mime ||
            inferMimeTypeFromFilename(filename);

          const dataBase64 = Buffer.from(bytes).toString("base64");

          await bus.publish(
            lilacEventTypes.EvtAgentOutputResponseBinary,
            { mimeType, dataBase64, filename },
            {
              headers: {
                request_id: ctx.requestId,
                session_id: ctx.sessionId,
                request_client: ctx.requestClient,
              },
            },
          );

          out.push({ filename, mimeType, bytes: bytes.byteLength });
        }

        return { ok: true, attachments: out };
      },
    }),

    "attachment.download": tool({
      description: [
        "Download all inbound user message attachments into the sandbox.",
        "Scans ToolExecutionOptions.messages for user messages with array content parts.",
      ].join("\n"),
      inputSchema: attachmentDownloadInputSchema,
      outputSchema: attachmentDownloadOutputSchema,
      execute: async (input, options) => {
        const downloadDir = resolve(
          expandTilde(input.downloadDir ?? "~/Downloads"),
        );

        const attachments = collectUserAttachments(options.messages);
        if (attachments.length === 0) {
          return { ok: true, downloadDir, files: [] };
        }

        await fs.mkdir(downloadDir, { recursive: true });

        const files: AttachmentDownloadOutput["files"] = [];
        const seenSha10 = new Set<string>();

        let totalBytes = 0;

        for (const att of attachments) {
          const downloaded = await downloadToBuffer(att.data);

          if (downloaded.bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
            throw new Error(
              `Attachment too large (${downloaded.bytes.byteLength} bytes). Max is ${DEFAULT_INBOUND_MAX_FILE_BYTES} bytes.`,
            );
          }

          totalBytes += downloaded.bytes.byteLength;
          if (totalBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
            throw new Error(
              `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_INBOUND_MAX_TOTAL_BYTES} bytes.`,
            );
          }

          const detected = await fileTypeFromBuffer(downloaded.bytes);

          const mimeType =
            detected?.mime ||
            downloaded.contentType?.split(";")[0]?.trim() ||
            att.mediaTypeHint ||
            (att.filenameHint
              ? inferMimeTypeFromFilename(att.filenameHint)
              : undefined);

          const sha256 = createHash("sha256")
            .update(downloaded.bytes)
            .digest("hex");
          const sha10 = sha256.slice(0, 10);

          if (seenSha10.has(sha10)) {
            continue;
          }
          seenSha10.add(sha10);

          const extFromFileType = detected?.ext ? `.${detected.ext}` : "";
          const extFromFilename = att.filenameHint
            ? extname(att.filenameHint)
            : "";
          const extFromMime = mimeType
            ? inferExtensionFromMimeType(mimeType)
            : "";

          const ext = sanitizeExtension(
            extFromFileType || extFromFilename || extFromMime,
          );
          const target = join(downloadDir, `${sha10}${ext}`);

          // Only write missing.
          const exists = await fs
            .access(target)
            .then(() => true)
            .catch(() => false);

          if (!exists) {
            await fs.writeFile(target, downloaded.bytes);
          }

          files.push({
            path: target,
            sha10,
            bytes: downloaded.bytes.byteLength,
            sourceUrl: downloaded.sourceUrl ?? "inline",
            mimeType,
          });
        }

        return { ok: true, downloadDir, files };
      },
    }),
  };
}
