import { z } from "zod/v4";
import { fileTypeFromBuffer } from "file-type/core";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ModelMessage } from "ai";
import type { RequestContext, ServerTool } from "../types";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  requireToolServerHeaders,
  type RequiredToolServerHeaders,
} from "../../shared/tool-server-context";
import {
  decodeDataUrl,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  looksLikeDataUrl,
  looksLikeHttpUrl,
  resolveToolPath,
  sanitizeExtension,
} from "../../shared/attachment-utils";
import { expandTilde } from "../../tools/fs/fs-impl";

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

type RequestHeaders = RequiredToolServerHeaders;

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

function toHeaders(ctx: RequestContext | undefined): RequestHeaders {
  return requireToolServerHeaders(ctx, "attachment");
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

  throw new Error("Unsupported data content");
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

const attachmentAddFilesInputSchema = z
  .object({
    paths: nonEmptyStringListInputSchema
      .describe(
        "Local file paths to attach (resolved relative to request cwd)",
      ),
    filenames: optionalNonEmptyStringListInputSchema.describe(
      "Optional filenames for each attachment",
    ),
    mimeTypes: optionalNonEmptyStringListInputSchema.describe(
      "Optional mime types for each attachment",
    ),
  })
  .describe("Add one or more attachments from local files.");

const attachmentDownloadInputSchema = z.object({
  downloadDir: z
    .string()
    .optional()
    .describe("Directory to save downloaded files (default: ~/Downloads)"),
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
    }
  }

  return out;
}

export class Attachment implements ServerTool {
  id = "attachment";

  constructor(private readonly params: { bus: LilacBus }) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "attachment.add_files",
        name: "Attachment Add Files",
        description:
          "Reads local files and attaches them to the current reply.",
        shortInput: ["--paths=<string | string[]>"],
        input: [
          "--paths=<string | string[]> | Local file paths",
          "--filenames=<string | string[]> | Optional filenames (same length as paths)",
          "--mimeTypes=<string | string[]> | Optional mime types (same length as paths)",
        ],
      },
      {
        callableId: "attachment.download",
        name: "Attachment Download",
        description:
          "Download inbound user message attachments into the sandbox (from the current request prompt).",
        shortInput: [],
        input: ["--downloadDir=<string>"],
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId === "attachment.add_files") {
      return await this.callAddFiles(input, opts?.context);
    }

    if (callableId === "attachment.download") {
      const messages = opts?.messages as readonly ModelMessage[] | undefined;
      if (!messages) {
        throw new Error(
          "attachment.download requires request messages, but none were available for this request. (Tool server caches cmd.request messages; ensure the tool server is connected to the bus and started before the request.)",
        );
      }
      return await this.callDownload(input, messages);
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }

  private async callAddFiles(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = attachmentAddFilesInputSchema.parse(rawInput);
    const headers = toHeaders(ctx);

    const cwd = ctx?.cwd ?? process.cwd();

    let totalBytes = 0;

    const out: Array<{ filename: string; mimeType: string; bytes: number }> =
      [];

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

      await this.params.bus.publish(
        lilacEventTypes.EvtAgentOutputResponseBinary,
        { mimeType, dataBase64, filename },
        { headers },
      );

      out.push({ filename, mimeType, bytes: bytes.byteLength });
    }

    return { ok: true as const, attachments: out };
  }

  private async callDownload(
    rawInput: Record<string, unknown>,
    messages: readonly ModelMessage[],
  ) {
    const input = attachmentDownloadInputSchema.parse(rawInput);

    const downloadDir = resolve(
      expandTilde(input.downloadDir ?? "~/Downloads"),
    );

    const attachments = collectUserAttachments(messages);
    if (attachments.length === 0) {
      return { ok: true as const, downloadDir, files: [] };
    }

    await fs.mkdir(downloadDir, { recursive: true });

    const files: Array<{
      path: string;
      sha10: string;
      bytes: number;
      sourceUrl: string;
      mimeType?: string;
    }> = [];

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
      const extFromFilename = att.filenameHint ? extname(att.filenameHint) : "";
      const extFromMime = mimeType ? inferExtensionFromMimeType(mimeType) : "";

      const ext = sanitizeExtension(
        extFromFileType || extFromFilename || extFromMime,
      );
      const target = join(downloadDir, `${sha10}${ext}`);

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

    return { ok: true as const, downloadDir, files };
  }
}
