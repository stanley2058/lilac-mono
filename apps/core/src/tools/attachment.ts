import { tool, type ModelMessage } from "ai";
import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { fileTypeFromBuffer } from "file-type/core";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, extname, join, resolve, isAbsolute } from "node:path";
import { z } from "zod/v4";

import { expandTilde } from "./fs/fs-impl";

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

type RequestContext = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
};

function isRequestContext(x: unknown): x is RequestContext {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.requestId === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.requestClient === "string"
  );
}

function resolveToolPath(toolRoot: string, inputPath: string): string {
  const expanded = expandTilde(inputPath);
  const root = resolve(expandTilde(toolRoot));
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(root, expanded);
}

function inferMimeTypeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}

function inferExtensionFromMimeType(mimeType: string): string {
  const mt = mimeType.toLowerCase().split(";")[0]?.trim();
  switch (mt) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    case "text/csv":
      return ".csv";
    default:
      return "";
  }
}

function looksLikeHttpUrl(s: string): boolean {
  return s.startsWith("https://") || s.startsWith("http://");
}

function looksLikeDataUrl(s: string): boolean {
  return s.startsWith("data:");
}

function decodeDataUrl(s: string): { bytes: Buffer; mimeType?: string } {
  // data:[<mediatype>][;base64],<data>
  const comma = s.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid data URL");
  }

  const meta = s.slice(5, comma);
  const data = s.slice(comma + 1);

  const metaParts = meta.split(";");
  const mimeType = metaParts[0] ? metaParts[0] : undefined;
  const isBase64 = metaParts.includes("base64");

  const bytes = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(data, "utf8");
  return { bytes, mimeType };
}

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

function sanitizeExtension(ext: string): string {
  if (!ext) return "";
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  if (!/^\.[a-z0-9]+$/u.test(normalized)) return "";
  if (normalized.length > 10) return "";
  return normalized;
}

const attachmentAddInputSchema = z
  .object({
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    filename: z.string().optional(),
    filenames: z.array(z.string()).optional(),
    mimeType: z.string().optional(),
    mimeTypes: z.array(z.string()).optional(),
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
    "attachment.add": tool({
      description: [
        "Reads one or more local files and sends them as attachments.",
        "Use paths[] to send multiple attachments in-order.",
      ].join("\n"),
      inputSchema: attachmentAddInputSchema,
      outputSchema: attachmentAddOutputSchema,
      execute: async (input, { experimental_context }) => {
        const ctx = experimental_context;
        if (!isRequestContext(ctx)) {
          throw new Error(
            "attachment.add requires experimental_context { requestId, sessionId, requestClient }",
          );
        }

        const paths =
          input.paths && input.paths.length > 0
            ? input.paths
            : input.path
              ? [input.path]
              : [];

        if (paths.length === 0) {
          throw new Error("attachment.add requires 'paths' or 'path'");
        }

        let totalBytes = 0;

        const out: Array<{
          filename: string;
          mimeType: string;
          bytes: number;
        }> = [];

        for (let i = 0; i < paths.length; i++) {
          const p = paths[i]!;
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
            (input.filenames && input.filenames[i]) ||
            (paths.length === 1 ? input.filename : undefined) ||
            basename(resolvedPath);

          const typeFromBytes = await fileTypeFromBuffer(bytes);

          const mimeType =
            (input.mimeTypes && input.mimeTypes[i]) ||
            (paths.length === 1 ? input.mimeType : undefined) ||
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
