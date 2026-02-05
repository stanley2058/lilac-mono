import { tool } from "ai";
import { z } from "zod/v4";
import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { fileTypeFromBuffer } from "file-type/core";
import { READ_ERROR_CODES, FileSystem } from "./fs-impl";
import path from "node:path";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";

const pathSchema = z
  .string()
  .describe(
    "Path to the file. Relative paths are resolved against the tool root; absolute paths are also supported.",
  );

const readErrorCodeSchema = z.enum(READ_ERROR_CODES);

export const readFileInputZod = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to resolve relative paths against (supports ~). Defaults to the tool root.",
    ),
  startLine: z
    .number()
    .optional()
    .describe("1-based line number to start reading from. Defaults to 1."),
  maxLines: z
    .number()
    .optional()
    .describe("Maximum number of lines to return. Defaults to 2000."),
  maxCharacters: z
    .number()
    .optional()
    .describe("Maximum number of characters to return. Defaults to 10000."),
  format: z
    .enum(["raw", "numbered"])
    .optional()
    .describe(
      "Output format. Default is raw (no line numbers). 'numbered' is for display only.",
    ),
});

type ReadFileInput = z.infer<typeof readFileInputZod>;

const readFileSuccessBaseZod = z.object({
  success: z.literal(true),
  resolvedPath: z.string(),
  fileHash: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  totalLines: z.number(),
  hasMoreLines: z.boolean(),
  truncatedByChars: z.boolean(),
});

const readFileAttachmentSuccessZod = z.object({
  success: z.literal(true),
  kind: z.literal("attachment"),
  resolvedPath: z.string(),
  fileHash: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
});

const readFileOutputZod = z.union([
  readFileSuccessBaseZod.extend({
    format: z.literal("raw"),
    content: z.string(),
  }),
  readFileSuccessBaseZod.extend({
    format: z.literal("numbered"),
    numberedContent: z.string(),
  }),
  readFileAttachmentSuccessZod,
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    error: z.object({
      code: readErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);

type ReadFileOutput = z.infer<typeof readFileOutputZod>;

export function fsTool(cwd: string) {
  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "tool:fs",
  });

  const fs = new FileSystem(cwd, {
    denyPaths: [
      path.join(env.dataDir, "secret"),
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
    ],
  });

  const attachmentExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".pdf",
  ]);

  const imageMimeTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);

  const binaryCacheByToolCallId = new Map<
    string,
    {
      resolvedPath: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      fileHash: string;
    }
  >();

  function isAttachmentOutput(
    output: ReadFileOutput,
  ): output is Extract<ReadFileOutput, { success: true; kind: "attachment" }> {
    if (!output || typeof output !== "object") return false;
    const o = output as unknown as Record<string, unknown>;
    return (
      o["success"] === true &&
      o["kind"] === "attachment" &&
      typeof o["resolvedPath"] === "string"
    );
  }

  return {
    read_file: tool<ReadFileInput, ReadFileOutput>({
      description:
        "Reads a file from the filesystem. Default format is raw (no line numbers) to preserve indentation. Images and PDFs are returned as attachments when supported by the upstream provider.",
      inputSchema: readFileInputZod,
      outputSchema: readFileOutputZod,
      execute: async ({ cwd: opCwd, ...input }, options) => {
        logger.info("fs.readFile", {
          path: input.path,
          cwd: opCwd,
        });

        const ext = path.extname(input.path).toLowerCase();
        const wantsAttachment = attachmentExts.has(ext);

        const res = wantsAttachment
          ? await (async () => {
              const bytesRes = await fs.readFileBytes({ path: input.path }, opCwd);
              if (!bytesRes.success) {
                return bytesRes;
              }

              const resolvedPath = bytesRes.resolvedPath;
              const filename = path.basename(resolvedPath);

              const detected = await fileTypeFromBuffer(bytesRes.bytes);
              const mimeType =
                detected?.mime || inferMimeTypeFromFilename(filename);

              binaryCacheByToolCallId.set(options.toolCallId, {
                resolvedPath,
                filename,
                mimeType,
                bytes: bytesRes.bytes,
                fileHash: bytesRes.fileHash,
              });

              return {
                success: true as const,
                kind: "attachment" as const,
                resolvedPath,
                fileHash: bytesRes.fileHash,
                filename,
                mimeType,
                bytes: bytesRes.bytesLength,
              };
            })()
          : await fs.readFile(input, opCwd);

        logger.info("fs.readFile done", {
          path: res.resolvedPath,
          ok: res.success,
          error: res.success ? undefined : res.error,
        });

        return res;
      },
      toModelOutput: async ({ toolCallId, output }) => {
        if (!isAttachmentOutput(output)) {
          // Preserve existing behavior for text reads and errors.
          return { type: "json", value: output };
        }

        const cached = binaryCacheByToolCallId.get(toolCallId);
        binaryCacheByToolCallId.delete(toolCallId);

        const bytes = cached?.bytes;
        const filename = cached?.filename ?? output.filename;
        const mimeType = cached?.mimeType ?? output.mimeType;

        let base64: string;
        if (bytes) {
          base64 = Buffer.from(bytes).toString("base64");
        } else {
          const bytesRes = await fs.readFileBytes({ path: output.resolvedPath });
          if (!bytesRes.success) {
            return {
              type: "error-text",
              value: `Failed to read attachment bytes: ${bytesRes.error.message}`,
            };
          }
          base64 = Buffer.from(bytesRes.bytes).toString("base64");
        }

        const intro = `Attached file from read_file: ${filename} (${mimeType}, ${output.bytes} bytes).`;

        if (imageMimeTypes.has(mimeType)) {
          return {
            type: "content",
            value: [
              { type: "text", text: intro },
              { type: "image-data", mediaType: mimeType, data: base64 },
            ],
          };
        }

        return {
          type: "content",
          value: [
            { type: "text", text: intro },
            {
              type: "file-data",
              mediaType: mimeType,
              filename,
              data: base64,
            },
          ],
        };
      },
    }),
  };
}
