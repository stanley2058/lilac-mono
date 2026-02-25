import { tool } from "ai";
import { z } from "zod/v4";
import { createLogger, env } from "@stanley2058/lilac-utils";
import { fileTypeFromBuffer } from "file-type/core";
import {
  EDIT_ERROR_CODES,
  READ_ERROR_CODES,
  FileSystem,
  expandTilde,
  type FileEdit,
} from "./fs-impl";
import fsp from "node:fs/promises";
import path from "node:path";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  remoteGrep,
  remoteGlob,
  remoteEditFile,
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
const editErrorCodeSchema = z.enum(EDIT_ERROR_CODES);
const searchModeSchema = z.enum(["default", "detailed"]);

const INSTRUCTION_FILENAMES = ["AGENTS.md"] as const;
const MAX_INSTRUCTION_CHARS = 20_000;

const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const REMOTE_MAX_ATTACHMENT_BYTES = 10_000_000;

function resolveRemoteDenyPaths(dangerouslyAllow?: boolean): readonly string[] {
  return dangerouslyAllow === true ? [] : REMOTE_DENY_PATHS;
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

async function readTextFileBestEffort(filePath: string): Promise<string | null> {
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

function collectPreviouslyLoadedInstructionPaths(messages: readonly unknown[]): Set<string> {
  const out = new Set<string>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const msgRecord = msg as Record<string, unknown>;
    if (msgRecord["role"] !== "tool") continue;

    const content = msgRecord["content"];
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const partRecord = part as Record<string, unknown>;
      if (partRecord["type"] !== "tool-result") continue;
      if (partRecord["toolName"] !== "read_file") continue;

      const output = partRecord["output"];
      if (!output || typeof output !== "object" || Array.isArray(output)) continue;
      const outputRecord = output as Record<string, unknown>;

      if (outputRecord["type"] === "json") {
        const value = outputRecord["value"];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const valueRecord = value as Record<string, unknown>;
          const loaded = valueRecord["loadedInstructions"];
          if (Array.isArray(loaded)) {
            for (const p of loaded) {
              if (typeof p === "string" && p.length > 0) out.add(p);
            }
          }

          const instructionsText = valueRecord["instructionsText"];
          if (typeof instructionsText === "string") {
            for (const p of parseInstructionPathsFromText(instructionsText)) {
              out.add(p);
            }
          }
        }
        continue;
      }

      if (outputRecord["type"] === "content") {
        const value = outputRecord["value"];
        if (!Array.isArray(value)) continue;
        for (const p of value) {
          if (!p || typeof p !== "object" || Array.isArray(p)) continue;
          const pRecord = p as Record<string, unknown>;
          if (pRecord["type"] !== "text") continue;
          const t = pRecord["text"];
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
  maxLines: z.number().optional().describe("Maximum number of lines to return. Defaults to 2000."),
  maxCharacters: z
    .number()
    .optional()
    .describe("Maximum number of characters to return. Defaults to 10000."),
  format: z
    .enum(["raw", "numbered"])
    .optional()
    .describe("Output format. Default is raw (no line numbers). 'numbered' is for display only."),
  dangerouslyAllow: z
    .boolean()
    .optional()
    .describe("Bypass filesystem denylist guardrails for this call."),
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
    .describe(
      "Output mode. Recommended: 'default'. Use 'detailed' only when you need file type/size metadata.",
    ),
  dangerouslyAllow: z
    .boolean()
    .optional()
    .describe("Bypass filesystem denylist guardrails for this call."),
});

type GlobInput = z.infer<typeof globInputZod>;

const globOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("default"),
    truncated: z.boolean(),
    paths: z.array(z.string()),
    error: z.string().optional(),
  }),
  z.object({
    mode: z.literal("detailed"),
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
  pattern: z.string().min(1).describe("Search pattern. Literal by default unless regex=true."),
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
    .describe('Optional file extension filters (e.g. ["ts", "tsx"]).'),
  includeContextLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Include N context lines around each match."),
  mode: searchModeSchema
    .optional()
    .describe(
      "Output mode. Recommended: 'default'. Use 'detailed' only when you need column/submatches metadata.",
    ),
  dangerouslyAllow: z
    .boolean()
    .optional()
    .describe("Bypass filesystem denylist guardrails for this call."),
});

type GrepInput = z.infer<typeof grepInputZod>;

const grepOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("default"),
    truncated: z.boolean(),
    results: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        text: z.string(),
      }),
    ),
    error: z.string().optional(),
  }),
  z.object({
    mode: z.literal("detailed"),
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

const expectedMatchesSchema = z.union([z.literal("any"), z.number().int().positive()]);

export const editFileInputZod = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory (supports ~). Also supports ssh-style '<host>:<path>' to run on a configured SSH host alias.",
    ),
  oldText: z
    .string()
    .min(1)
    .describe("Exact text to find and replace. Must uniquely match by default."),
  newText: z.string().describe("Replacement text."),
  matching: z.enum(["exact", "regex"]).optional().describe("Matching mode. Default: exact."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace all matches when true. Default: false (single replacement)."),
  expectedMatches: expectedMatchesSchema
    .optional()
    .describe("Expected number of matches. Default: 1 when replaceAll=false, otherwise 'any'."),
  expectedHash: z
    .string()
    .optional()
    .describe("Optional optimistic concurrency hash from read_file."),
  dangerouslyAllow: z
    .boolean()
    .optional()
    .describe("Bypass filesystem denylist guardrails for this call."),
});

type EditFileInput = z.infer<typeof editFileInputZod>;

const editFileOutputZod = z.union([
  z.object({
    success: z.literal(true),
    resolvedPath: z.string(),
    oldHash: z.string(),
    newHash: z.string(),
    changesMade: z.boolean(),
    replacementsMade: z.number(),
  }),
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    currentHash: z.string().optional(),
    error: z.object({
      code: editErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);

type EditFileOutput = z.infer<typeof editFileOutputZod>;

function countGlobItems(output: GlobOutput): number {
  if (output.mode === "default") return output.paths.length;
  return output.entries.length;
}

function countGrepItems(output: GrepOutput): number {
  return output.results.length;
}

const instructionFieldsZod = z.object({
  loadedInstructions: z
    .array(z.string())
    .optional()
    .describe("Instruction file paths loaded for this read_file call"),
  instructionsText: z
    .string()
    .optional()
    .describe("Instruction text auto-loaded from AGENTS.md files. Intended for model context."),
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

function resolveExpectedMatches(input: EditFileInput): "any" | number {
  if (input.expectedMatches !== undefined) return input.expectedMatches;
  return input.replaceAll ? "any" : 1;
}

function normalizeEditOutput(output: {
  success: boolean;
  resolvedPath: string;
  oldHash?: string;
  newHash?: string;
  changesMade?: boolean;
  replacementsMade?: number;
  currentHash?: string;
  error?: { code: (typeof EDIT_ERROR_CODES)[number]; message: string };
}): EditFileOutput {
  if (output.success) {
    return {
      success: true,
      resolvedPath: output.resolvedPath,
      oldHash: output.oldHash ?? "",
      newHash: output.newHash ?? "",
      changesMade: Boolean(output.changesMade),
      replacementsMade: output.replacementsMade ?? 0,
    };
  }

  return {
    success: false,
    resolvedPath: output.resolvedPath,
    currentHash: output.currentHash,
    error: output.error ?? {
      code: "UNKNOWN",
      message: "Unknown edit error",
    },
  };
}

export function fsTool(cwd: string, opts?: { includeEditFile?: boolean }) {
  const logger = createLogger({
    module: "tool:fs",
  });
  const includeEditFile = opts?.includeEditFile ?? false;

  const toolRootAbs = path.resolve(expandTilde(cwd));

  const fileSystem = new FileSystem(cwd, {
    denyPaths: [path.join(env.dataDir, "secret"), "~/.ssh", "~/.aws", "~/.gnupg"],
  });

  const attachmentExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

  const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

  const remoteFileAccessByResolvedPath = new Map<string, string>();
  const remoteResolvedPathByLookup = new Map<string, string>();

  function remoteResolvedPathKey(host: string, resolvedPath: string): string {
    return `${host}|${resolvedPath}`;
  }

  function remoteLookupKey(host: string, remoteCwd: string, inputPath: string): string {
    return `${host}|${remoteCwd}|${inputPath}`;
  }

  function recordRemoteFileAccess(params: {
    host: string;
    remoteCwd: string;
    inputPath: string;
    resolvedPath: string;
    fileHash: string;
  }) {
    remoteFileAccessByResolvedPath.set(
      remoteResolvedPathKey(params.host, params.resolvedPath),
      params.fileHash,
    );
    remoteResolvedPathByLookup.set(
      remoteLookupKey(params.host, params.remoteCwd, params.inputPath),
      params.resolvedPath,
    );
  }

  function lookupRemoteReadHash(params: {
    host: string;
    remoteCwd: string;
    inputPath: string;
  }): { resolvedPath: string; hash: string } | null {
    const resolvedPath = remoteResolvedPathByLookup.get(
      remoteLookupKey(params.host, params.remoteCwd, params.inputPath),
    );
    if (!resolvedPath) return null;

    const hash = remoteFileAccessByResolvedPath.get(
      remoteResolvedPathKey(params.host, resolvedPath),
    );
    if (!hash) return null;

    return { resolvedPath, hash };
  }

  function isAttachmentOutput(
    output: ReadFileOutput,
  ): output is Extract<ReadFileOutput, { success: true; kind: "attachment" }> {
    if (!output || typeof output !== "object") return false;
    const o = output as unknown as Record<string, unknown>;
    return (
      o["success"] === true && o["kind"] === "attachment" && typeof o["resolvedPath"] === "string"
    );
  }

  function isReadTextOutput(
    output: ReadFileOutput,
  ): output is Extract<ReadFileOutput, { success: true; format: "raw" | "numbered" }> {
    if (!output || typeof output !== "object") return false;
    const o = output as Record<string, unknown>;
    return (
      o["success"] === true &&
      (o["format"] === "raw" || o["format"] === "numbered") &&
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

    const opCwdAbs = params.opCwd ? path.resolve(expandTilde(params.opCwd)) : toolRootAbs;

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
      text: ["<system-reminder>", snippets.join("\n\n"), "</system-reminder>"].join("\n"),
    };
  }

  const baseTools = {
    read_file: tool<ReadFileInput, ReadFileOutput>({
      description:
        "Reads a file from the filesystem. Default format is raw (no line numbers) to preserve indentation. Images and PDFs are returned as attachments when supported by the upstream provider. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: readFileInputZod,
      outputSchema: readFileOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }, options) => {
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.readFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          startLine: input.startLine,
          maxLines: input.maxLines,
          maxCharacters: input.maxCharacters,
          format: input.format ?? "raw",
          dangerouslyAllow: dangerouslyAllow === true,
        });

        const ext = path.extname(input.path).toLowerCase();
        const wantsAttachment = attachmentExts.has(ext);

        const res = wantsAttachment
          ? await (async () => {
              if (cwdTarget.kind === "ssh") {
                const bytesRes = await remoteReadFileBytes({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  filePath: input.path,
                  denyPaths: remoteDenyPaths,
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
                const remoteResolvedPath = toRemoteDebugPath(cwdTarget.host, bytesRes.resolvedPath);
                recordRemoteFileAccess({
                  host: cwdTarget.host,
                  remoteCwd: cwdTarget.cwd,
                  inputPath: input.path,
                  resolvedPath: bytesRes.resolvedPath,
                  fileHash: bytesRes.fileHash,
                });
                const filename = path.basename(bytesRes.resolvedPath);

                const detected = await fileTypeFromBuffer(bytes);
                const mimeType = detected?.mime || inferMimeTypeFromFilename(filename);

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
                { path: input.path, dangerouslyAllow },
                opCwd,
              );
              if (!bytesRes.success) {
                return bytesRes;
              }

              const resolvedPath = bytesRes.resolvedPath;
              const filename = path.basename(resolvedPath);

              const detected = await fileTypeFromBuffer(bytesRes.bytes);
              const mimeType = detected?.mime || inferMimeTypeFromFilename(filename);

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
            ? await (async () => {
                const remoteRes = await remoteReadTextFile({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input,
                  denyPaths: remoteDenyPaths,
                });
                if (remoteRes.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: input.path,
                    resolvedPath: remoteRes.resolvedPath,
                    fileHash: remoteRes.fileHash,
                  });
                }
                return remoteRes;
              })()
            : await fileSystem.readFile({ ...input, dangerouslyAllow }, opCwd);

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

        const loadedInstructionCount =
          withInstructions.success &&
          "loadedInstructions" in withInstructions &&
          Array.isArray(withInstructions.loadedInstructions)
            ? withInstructions.loadedInstructions.length
            : 0;

        const textReadSummary = isReadTextOutput(withInstructions)
          ? {
              outputFormat: withInstructions.format,
              startLine: withInstructions.startLine,
              endLine: withInstructions.endLine,
              totalLines: withInstructions.totalLines,
              hasMoreLines: withInstructions.hasMoreLines,
              truncatedByChars: withInstructions.truncatedByChars,
              returnedLines: Math.max(0, withInstructions.endLine - withInstructions.startLine + 1),
              returnedChars:
                withInstructions.format === "raw"
                  ? withInstructions.content.length
                  : withInstructions.numberedContent.length,
            }
          : undefined;

        const attachmentSummary = isAttachmentOutput(withInstructions)
          ? {
              kind: "attachment" as const,
              mimeType: withInstructions.mimeType,
              filename: withInstructions.filename,
              bytes: withInstructions.bytes,
            }
          : undefined;

        logger.info("fs.readFile done", {
          path: withInstructions.resolvedPath,
          ok: withInstructions.success,
          target: cwdTarget.kind,
          loadedInstructions: loadedInstructionCount,
          ...textReadSummary,
          ...attachmentSummary,
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
        "Match filesystem paths using glob patterns. Recommended mode='default' for paths only; use mode='detailed' only when you need type/size. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: globInputZod,
      outputSchema: globOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }) => {
        const mode = input.mode ?? "default";
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.glob", {
          patterns: input.patterns,
          cwd: opCwd,
          target: cwdTarget.kind,
          maxEntries: input.maxEntries,
          mode,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        if (cwdTarget.kind === "ssh") {
          const res = await remoteGlob({
            host: cwdTarget.host,
            cwd: cwdTarget.cwd,
            patterns: input.patterns,
            maxEntries: input.maxEntries,
            mode,
            denyPaths: remoteDenyPaths,
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
          dangerouslyAllow,
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
        "Search file contents with ripgrep. Recommended mode='default'; use mode='detailed' only when you need column/submatches metadata. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: grepInputZod,
      outputSchema: grepOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }) => {
        const mode = input.mode ?? "default";
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.grep", {
          pattern: input.pattern,
          cwd: opCwd,
          target: cwdTarget.kind,
          regex: input.regex,
          fileExtensions: input.fileExtensions,
          includeContextLines: input.includeContextLines,
          maxResults: input.maxResults,
          mode,
          dangerouslyAllow: dangerouslyAllow === true,
        });

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
            denyPaths: remoteDenyPaths,
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
          dangerouslyAllow,
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

  if (!includeEditFile) {
    return baseTools;
  }

  return {
    ...baseTools,
    edit_file: tool<EditFileInput, EditFileOutput>({
      description:
        "Edit a file by find-and-replace. By default, oldText must be unique in the file. Set replaceAll=true to update all matches. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: editFileInputZod,
      outputSchema: editFileOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }) => {
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.editFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          replaceAll: input.replaceAll,
          matching: input.matching,
          expectedMatches: resolveExpectedMatches(input),
          expectedHashProvided:
            typeof input.expectedHash === "string" && input.expectedHash.length > 0,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        const occurrence: "all" | "first" = input.replaceAll ? "all" : "first";
        const editPayload: {
          path: string;
          edits: FileEdit[];
          expectedHash?: string;
        } = {
          path: input.path,
          edits: [
            {
              type: "replace_snippet" as const,
              target: input.oldText,
              matching: input.matching,
              newText: input.newText,
              occurrence,
              expectedMatches: resolveExpectedMatches(input),
            },
          ],
          expectedHash: input.expectedHash,
        };

        const res =
          cwdTarget.kind === "ssh"
            ? await (async () => {
                let expectedHash = input.expectedHash;
                let resolvedPathHint: string | undefined;

                if (!expectedHash) {
                  const prior = lookupRemoteReadHash({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: input.path,
                  });
                  if (!prior) {
                    return {
                      success: false as const,
                      resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                      error: {
                        code: "NOT_READ" as const,
                        message: `File must be read before editing: ${toRemoteDebugPath(cwdTarget.host, input.path)}`,
                      },
                    };
                  }
                  expectedHash = prior.hash;
                  resolvedPathHint = prior.resolvedPath;
                }

                const remoteRes = await remoteEditFile({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    path: editPayload.path,
                    edits: editPayload.edits,
                    expectedHash,
                  },
                  denyPaths: remoteDenyPaths,
                });

                if (remoteRes.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: input.path,
                    resolvedPath: remoteRes.resolvedPath,
                    fileHash: remoteRes.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, input.path),
                    resolvedPathHint,
                  );
                }

                return normalizeEditOutput({
                  ...remoteRes,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteRes.resolvedPath),
                });
              })()
            : normalizeEditOutput(
                await fileSystem.editFile({ ...editPayload, dangerouslyAllow }, opCwd),
              );

        logger.info("fs.editFile done", {
          path: res.resolvedPath,
          ok: res.success,
          error: res.success ? undefined : res.error,
          replacementsMade: res.success ? res.replacementsMade : undefined,
        });

        return res;
      },
    }),
  };
}
