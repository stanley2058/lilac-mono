import { tool } from "ai";
import { z } from "zod/v4";
import { env, resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { fileTypeFromBuffer } from "file-type/core";
import { READ_ERROR_CODES, FileSystem, expandTilde } from "./fs-impl";
import fsp from "node:fs/promises";
import path from "node:path";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  remoteGrep,
  remoteGlob,
  remoteReadFileBytes,
  remoteReadTextFile,
  toRemoteDebugPath,
} from "./remote-fs";

const pathSchema = z
  .string()
  .describe(
    "Path to the file. Relative paths are resolved against the tool root; absolute paths are also supported.",
  );

const readErrorCodeSchema = z.enum(READ_ERROR_CODES);
const searchModeSchema = z.enum(["lean", "verbose"]);

const INSTRUCTION_FILENAMES = ["AGENTS.md"] as const;
const MAX_INSTRUCTION_CHARS = 20_000;

const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const REMOTE_MAX_ATTACHMENT_BYTES = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathWithin(candidatePath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, candidatePath);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextFileBestEffort(
  filePath: string,
): Promise<string | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length <= MAX_INSTRUCTION_CHARS) return trimmed;
    return trimmed.slice(0, MAX_INSTRUCTION_CHARS) + "\n... (truncated)";
  } catch {
    return null;
  }
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseInstructionPathsFromText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Instructions from:")) continue;
    const p = trimmed.slice("Instructions from:".length).trim();
    if (p.length > 0) out.push(p);
  }
  return out;
}

function collectPreviouslyLoadedInstructionPaths(
  messages: readonly unknown[],
): Set<string> {
  const out = new Set<string>();

  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    if (msg["role"] !== "tool") continue;

    const content = msg["content"];
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] !== "tool-result") continue;
      if (part["toolName"] !== "read_file") continue;

      const output = part["output"];
      if (!isRecord(output)) continue;

      if (output["type"] === "json") {
        const value = output["value"];
        if (isRecord(value)) {
          const loaded = value["loadedInstructions"];
          if (Array.isArray(loaded)) {
            for (const p of loaded) {
              if (typeof p === "string" && p.length > 0) out.add(p);
            }
          }

          const instructionsText = value["instructionsText"];
          if (typeof instructionsText === "string") {
            for (const p of parseInstructionPathsFromText(instructionsText)) {
              out.add(p);
            }
          }
        }
        continue;
      }

      if (output["type"] === "content") {
        const value = output["value"];
        if (!Array.isArray(value)) continue;
        for (const p of value) {
          if (!isRecord(p)) continue;
          if (p["type"] !== "text") continue;
          const t = p["text"];
          if (typeof t !== "string") continue;
          for (const loadedPath of parseInstructionPathsFromText(t)) {
            out.add(loadedPath);
          }
        }
      }
    }
  }

  return out;
}

export const readFileInputZod = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to resolve relative paths against (supports ~). Also supports ssh-style '<host>:<path>' to run on a configured SSH host alias. Defaults to the tool root.",
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

const globEntryTypeSchema = z.enum([
  "symlink",
  "file",
  "directory",
  "socket",
  "block_device",
  "character_device",
  "fifo",
  "unknown",
]);

export const globInputZod = z.object({
  patterns: z
    .array(z.string().min(1))
    .min(1)
    .describe("Glob patterns (supports include + negate patterns)"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional base directory to search from (supports ~). Also supports ssh-style '<host>:<path>' to run on a configured SSH host alias. Defaults to the tool root.",
    ),
  maxEntries: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of matched paths to return (default: 100)."),
  mode: searchModeSchema
    .optional()
    .describe("Output mode. Default is 'lean'. Use 'verbose' for metadata."),
});

type GlobInput = z.infer<typeof globInputZod>;

const globOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("lean"),
    truncated: z.boolean(),
    paths: z.array(z.string()),
    error: z.string().optional(),
  }),
  z.object({
    mode: z.literal("verbose"),
    truncated: z.boolean(),
    entries: z.array(
      z.object({
        path: z.string(),
        type: globEntryTypeSchema,
        size: z.number(),
      }),
    ),
    error: z.string().optional(),
  }),
]);

type GlobOutput = z.infer<typeof globOutputZod>;

export const grepInputZod = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Search pattern. Literal by default unless regex=true."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional base directory to search from (supports ~). Also supports ssh-style '<host>:<path>' to run on a configured SSH host alias. Defaults to the tool root.",
    ),
  regex: z
    .boolean()
    .optional()
    .describe("Treat pattern as regex when true. Default is false (literal)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of matches to return (default: 100)."),
  fileExtensions: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional file extension filters (e.g. [\"ts\", \"tsx\"])."),
  includeContextLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Include N context lines around each match."),
  mode: searchModeSchema
    .optional()
    .describe(
      "Output mode. Default is 'lean' (text lines). Use 'verbose' for match metadata.",
    ),
});

type GrepInput = z.infer<typeof grepInputZod>;

const grepOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("lean"),
    truncated: z.boolean(),
    text: z.string(),
    error: z.string().optional(),
  }),
  z.object({
    mode: z.literal("verbose"),
    truncated: z.boolean(),
    results: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        column: z.number(),
        text: z.string(),
        submatches: z
          .array(
            z.object({
              match: z.string(),
              start: z.number(),
              end: z.number(),
            }),
          )
          .optional(),
      }),
    ),
    error: z.string().optional(),
  }),
]);

type GrepOutput = z.infer<typeof grepOutputZod>;

function countGlobItems(output: GlobOutput): number {
  if (output.mode === "lean") return output.paths.length;
  return output.entries.length;
}

function countGrepItems(output: GrepOutput): number {
  if (output.mode === "verbose") return output.results.length;
  if (!output.text.trim()) return 0;
  return output.text.split("\n").filter((line) => line.length > 0).length;
}

const instructionFieldsZod = z.object({
  loadedInstructions: z
    .array(z.string())
    .optional()
    .describe("Instruction file paths loaded for this read_file call"),
  instructionsText: z
    .string()
    .optional()
    .describe(
      "Instruction text auto-loaded from AGENTS.md files. Intended for model context.",
    ),
});

const readFileSuccessBaseZod = z
  .object({
    success: z.literal(true),
    resolvedPath: z.string(),
    fileHash: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    totalLines: z.number(),
    hasMoreLines: z.boolean(),
    truncatedByChars: z.boolean(),
  })
  .extend(instructionFieldsZod.shape);

const readFileAttachmentSuccessZod = z
  .object({
    success: z.literal(true),
    kind: z.literal("attachment"),
    resolvedPath: z.string(),
    fileHash: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    bytes: z.number(),
  })
  .extend(instructionFieldsZod.shape);

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

  const toolRootAbs = path.resolve(expandTilde(cwd));

  const fileSystem = new FileSystem(cwd, {
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

  async function loadInstructionsForPath(params: {
    resolvedPath: string;
    opCwd?: string;
    messages: readonly unknown[];
  }): Promise<{ loaded: string[]; text?: string } | null> {
    const targetAbs = path.resolve(params.resolvedPath);

    const targetBase = path.basename(targetAbs);
    if ((INSTRUCTION_FILENAMES as readonly string[]).includes(targetBase)) {
      return null;
    }

    const opCwdAbs = params.opCwd
      ? path.resolve(expandTilde(params.opCwd))
      : toolRootAbs;

    const boundaryCwd = isPathWithin(targetAbs, opCwdAbs) ? opCwdAbs : null;
    const gitRoot = boundaryCwd ? null : await findGitRoot(opCwdAbs);
    const boundaryAbs = boundaryCwd ?? gitRoot;

    if (!boundaryAbs) return null;
    if (!isPathWithin(targetAbs, boundaryAbs)) return null;

    const already = collectPreviouslyLoadedInstructionPaths(params.messages);
    const loaded: string[] = [];
    const snippets: string[] = [];

    let current = path.dirname(targetAbs);
    while (true) {
      for (const name of INSTRUCTION_FILENAMES) {
        const candidate = path.join(current, name);
        if (candidate === targetAbs) continue;
        if (already.has(candidate)) continue;
        if (!(await pathExists(candidate))) continue;

        const content = await readTextFileBestEffort(candidate);
        if (!content) continue;

        loaded.push(candidate);
        already.add(candidate);
        snippets.push(`Instructions from: ${candidate}\n${content}`);
      }

      if (current === boundaryAbs) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;

      if (!isPathWithin(current, boundaryAbs)) break;
    }

    if (loaded.length === 0) return null;

    return {
      loaded,
      text: [
        "<system-reminder>",
        snippets.join("\n\n"),
        "</system-reminder>",
      ].join("\n"),
    };
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

        const cwdTarget = parseSshCwdTarget(opCwd);

        const ext = path.extname(input.path).toLowerCase();
        const wantsAttachment = attachmentExts.has(ext);

        const res = wantsAttachment
          ? await (async () => {
              if (cwdTarget.kind === "ssh") {
                const bytesRes = await remoteReadFileBytes({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  filePath: input.path,
                  denyPaths: REMOTE_DENY_PATHS,
                  maxBytes: REMOTE_MAX_ATTACHMENT_BYTES,
                });

                if (!bytesRes.ok) {
                  return {
                    success: false as const,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                    error: {
                      code: "UNKNOWN" as const,
                      message: bytesRes.error,
                    },
                  };
                }

                const bytes = Buffer.from(bytesRes.base64, "base64");
                const remoteResolvedPath = toRemoteDebugPath(
                  cwdTarget.host,
                  bytesRes.resolvedPath,
                );
                const filename = path.basename(bytesRes.resolvedPath);

                const detected = await fileTypeFromBuffer(bytes);
                const mimeType =
                  detected?.mime || inferMimeTypeFromFilename(filename);

                binaryCacheByToolCallId.set(options.toolCallId, {
                  resolvedPath: remoteResolvedPath,
                  filename,
                  mimeType,
                  bytes,
                  fileHash: bytesRes.fileHash,
                });

                return {
                  success: true as const,
                  kind: "attachment" as const,
                  resolvedPath: remoteResolvedPath,
                  fileHash: bytesRes.fileHash,
                  filename,
                  mimeType,
                  bytes: bytesRes.bytesLength,
                };
              }

              const bytesRes = await fileSystem.readFileBytes(
                { path: input.path },
                opCwd,
              );
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

              const instructions = await loadInstructionsForPath({
                resolvedPath,
                opCwd,
                messages: options.messages,
              });

              return {
                success: true as const,
                kind: "attachment" as const,
                resolvedPath,
                fileHash: bytesRes.fileHash,
                filename,
                mimeType,
                bytes: bytesRes.bytesLength,
                ...(instructions
                  ? {
                      loadedInstructions: instructions.loaded,
                      instructionsText: instructions.text,
                    }
                  : {}),
              };
            })()
          : cwdTarget.kind === "ssh"
            ? await remoteReadTextFile({
                host: cwdTarget.host,
                cwd: cwdTarget.cwd,
                input,
                denyPaths: REMOTE_DENY_PATHS,
              })
            : await fileSystem.readFile(input, opCwd);

        const resQualified = (() => {
          if (cwdTarget.kind !== "ssh") return res;
          if (isAttachmentOutput(res)) return res;
          const resolvedPath = (res as any)?.resolvedPath;
          if (typeof resolvedPath !== "string") return res;
          return {
            ...res,
            resolvedPath: toRemoteDebugPath(cwdTarget.host, resolvedPath),
          } as ReadFileOutput;
        })();

        const withInstructions = await (async () => {
          if (!resQualified.success) return resQualified;
          if (isAttachmentOutput(resQualified)) return resQualified;
          if (cwdTarget.kind === "ssh") {
            // Skip instruction auto-loading for remote reads for now.
            return resQualified;
          }
          const instructions = await loadInstructionsForPath({
            resolvedPath: resQualified.resolvedPath,
            opCwd,
            messages: options.messages,
          });
          if (!instructions) return resQualified;
          return {
            ...resQualified,
            loadedInstructions: instructions.loaded,
            instructionsText: instructions.text,
          };
        })();

        logger.info("fs.readFile done", {
          path: withInstructions.resolvedPath,
          ok: withInstructions.success,
          loadedInstructions:
            withInstructions.success &&
            "loadedInstructions" in withInstructions &&
            Array.isArray((withInstructions as any).loadedInstructions)
              ? (withInstructions as any).loadedInstructions.length
              : 0,
          error: withInstructions.success ? undefined : withInstructions.error,
        });

        return withInstructions;
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
          const bytesRes = await fileSystem.readFileBytes({
            path: output.resolvedPath,
          });
          if (!bytesRes.success) {
            return {
              type: "error-text",
              value: `Failed to read attachment bytes: ${bytesRes.error.message}`,
            };
          }
          base64 = Buffer.from(bytesRes.bytes).toString("base64");
        }

        const intro = `Attached file from read_file: ${filename} (${mimeType}, ${output.bytes} bytes).`;

        const instructionsText = output.instructionsText;
        const instructionParts =
          typeof instructionsText === "string" && instructionsText.trim().length > 0
            ? [{ type: "text" as const, text: instructionsText }]
            : [];

        if (imageMimeTypes.has(mimeType)) {
          return {
            type: "content",
            value: [
              { type: "text", text: intro },
              ...instructionParts,
              { type: "image-data", mediaType: mimeType, data: base64 },
            ],
          };
        }

        return {
          type: "content",
          value: [
            { type: "text", text: intro },
            ...instructionParts,
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

    glob: tool<GlobInput, GlobOutput>({
      description:
        "Match filesystem paths using glob patterns. Defaults to lean path-only output; use mode='verbose' for path/type/size entries.",
      inputSchema: globInputZod,
      outputSchema: globOutputZod,
      execute: async ({ cwd: opCwd, ...input }) => {
        const mode = input.mode ?? "lean";
        logger.info("fs.glob", {
          patterns: input.patterns,
          cwd: opCwd,
          maxEntries: input.maxEntries,
          mode,
        });

        const cwdTarget = parseSshCwdTarget(opCwd);
        if (cwdTarget.kind === "ssh") {
          const res = await remoteGlob({
            host: cwdTarget.host,
            cwd: cwdTarget.cwd,
            patterns: input.patterns,
            maxEntries: input.maxEntries,
            mode,
            denyPaths: REMOTE_DENY_PATHS,
          });

          logger.info("fs.glob done", {
            entryCount: countGlobItems(res),
            truncated: res.truncated,
            error: res.error,
            mode: res.mode,
          });

          return res;
        }

        const res = await fileSystem.glob({
          patterns: input.patterns,
          maxEntries: input.maxEntries,
          baseDir: opCwd,
          mode,
        });

        logger.info("fs.glob done", {
          entryCount: countGlobItems(res),
          truncated: res.truncated,
          error: res.error,
          mode: res.mode,
        });

        return res;
      },
    }),

    grep: tool<GrepInput, GrepOutput>({
      description:
        "Search file contents with ripgrep. Defaults to lean text output; use mode='verbose' for match metadata.",
      inputSchema: grepInputZod,
      outputSchema: grepOutputZod,
      execute: async ({ cwd: opCwd, ...input }) => {
        const mode = input.mode ?? "lean";
        logger.info("fs.grep", {
          pattern: input.pattern,
          cwd: opCwd,
          regex: input.regex,
          maxResults: input.maxResults,
          mode,
        });

        const cwdTarget = parseSshCwdTarget(opCwd);
        if (cwdTarget.kind === "ssh") {
          const res = await remoteGrep({
            host: cwdTarget.host,
            cwd: cwdTarget.cwd,
            input: {
              pattern: input.pattern,
              regex: input.regex,
              maxResults: input.maxResults,
              fileExtensions: input.fileExtensions,
              includeContextLines: input.includeContextLines,
              mode,
            },
            denyPaths: REMOTE_DENY_PATHS,
          });

          logger.info("fs.grep done", {
            resultCount: countGrepItems(res),
            truncated: res.truncated,
            error: res.error,
            mode: res.mode,
          });

          return res;
        }

        const res = await fileSystem.grep({
          pattern: input.pattern,
          regex: input.regex,
          maxResults: input.maxResults,
          fileExtensions: input.fileExtensions,
          includeContextLines: input.includeContextLines,
          baseDir: opCwd,
          mode,
        });

        logger.info("fs.grep done", {
          resultCount: countGrepItems(res),
          truncated: res.truncated,
          error: res.error,
          mode: res.mode,
        });

        return res;
      },
    }),
  };
}
