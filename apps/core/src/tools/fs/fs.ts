import { tool } from "ai";
import { z } from "zod/v4";
import {
  EDIT_ERROR_CODES,
  FileSystem,
  READ_ERROR_CODES,
  expandTilde,
  type EffectiveSearchBackend,
  type FileEdit,
  type FsBackend,
  type GrepMode,
  type HashlineEdit,
  type HashlineWarning,
  type ReadFileStart,
} from "@stanley2058/lilac-fs";
import { createLogger, env } from "@stanley2058/lilac-utils";
import {
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  editFileInputSchema as sharedEditFileInputSchema,
  fuzzySearchInputSchema as sharedFuzzySearchInputSchema,
  globInputSchema as sharedGlobInputSchema,
  grepInputSchema as sharedGrepInputSchema,
  readFileInputSchema as sharedReadFileInputSchema,
} from "@stanley2058/lilac-coding-tools/schemas";
import { fileTypeFromBuffer } from "file-type";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
  TOOL_RESULT_URI_PREFIX,
  type ToolResultArtifactStore,
} from "../../artifacts/tool-result-artifact-store";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";
import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  remoteFuzzySearch,
  remoteGrep,
  remoteGlob,
  remoteEditFile,
  remoteReadFileBytes,
  remoteReadTextFile,
  toRemoteDebugPath,
} from "./remote-fs";

const readErrorCodeSchema = z.enum(READ_ERROR_CODES);
const editErrorCodeSchema = z.enum(EDIT_ERROR_CODES);
const warningZod = z.object({
  code: z.literal("LINE_TOO_LONG_FOR_HASHLINE"),
  message: z.string(),
  line: z.number(),
  maxLength: z.number(),
  actualLength: z.number(),
});

const INSTRUCTION_FILENAMES = ["AGENTS.md"] as const;
const MAX_INSTRUCTION_CHARS = 20_000;

const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const FFF_CACHE_DIR = path.join(env.dataDir, ".cache", "fff");

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

export const readFileInputZod = sharedReadFileInputSchema;

type ReadFileInput = {
  path: string;
  cwd?: string;
  start?: ReadFileStart;
  maxLines?: number;
  maxCharacters?: number;
  format?: "raw" | "numbered" | "hashline";
  dangerouslyAllow?: boolean;
};

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

export const globInputZod = sharedGlobInputSchema;

type GlobInput = z.infer<typeof globInputZod>;

const globOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("default"),
    truncated: z.boolean(),
    paths: z.array(z.string()),
    error: z.string().optional(),
    truncationHint: z.string().optional(),
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
    truncationHint: z.string().optional(),
  }),
]);

type GlobOutput = z.infer<typeof globOutputZod>;

export const fuzzySearchInputZod = sharedFuzzySearchInputSchema;

type FuzzySearchInput = z.infer<typeof fuzzySearchInputZod>;

const fuzzySearchOutputZod = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      fileName: z.string(),
      size: z.number(),
      gitStatus: z.string(),
      score: z.number().optional(),
      matchType: z.string().optional(),
    }),
  ),
  totalMatched: z.number(),
  totalFiles: z.number(),
  truncated: z.boolean(),
  error: z.string().optional(),
  truncationHint: z.string().optional(),
});

type FuzzySearchOutput = z.infer<typeof fuzzySearchOutputZod>;

export const grepInputZod = sharedGrepInputSchema;

type GrepInput = {
  pattern: string;
  cwd?: string;
  regex?: boolean;
  maxResults?: number;
  fileExtensions?: string[];
  includeContextLines?: number;
  mode?: GrepMode;
  dangerouslyAllow?: boolean;
};

const grepOutputBase = z.object({
  truncated: z.boolean(),
  warnings: z.array(warningZod).optional(),
  degradedFromHashline: z.boolean().optional(),
  error: z.string().optional(),
  truncationHint: z.string().optional(),
});

function buildGrepOutputZod(hashlineEnabled: boolean) {
  return z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("default"),
      })
      .extend(grepOutputBase.shape)
      .extend({
        results: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            text: z.string(),
          }),
        ),
      }),
    z
      .object({
        mode: z.literal("detailed"),
      })
      .extend(grepOutputBase.shape)
      .extend({
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
      }),
    ...(hashlineEnabled
      ? [
          z
            .object({
              mode: z.literal("hashline"),
            })
            .extend(grepOutputBase.shape)
            .extend({
              results: z.array(
                z.object({
                  file: z.string(),
                  resolvedPath: z.string(),
                  fileHash: z.string(),
                  line: z.number(),
                  text: z.string(),
                }),
              ),
            }),
        ]
      : []),
  ]);
}

type GrepOutput =
  | {
      mode: "default";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: { file: string; line: number; text: string }[];
      error?: string;
      truncationHint?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: {
        file: string;
        line: number;
        column: number;
        text: string;
        submatches?: { match: string; start: number; end: number }[];
      }[];
      error?: string;
      truncationHint?: string;
    }
  | {
      mode: "hashline";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: {
        file: string;
        resolvedPath: string;
        fileHash: string;
        line: number;
        text: string;
      }[];
      error?: string;
      truncationHint?: string;
    };

export const editFileInputZod = sharedEditFileInputSchema;

type LegacyEditFileInput = {
  path: string;
  cwd?: string;
  oldText: string;
  newText: string;
  matching?: "exact" | "regex";
  replaceAll?: boolean;
  expectedMatches?: "any" | number;
  expectedHash?: string;
  dangerouslyAllow?: boolean;
};

type HashlineEditFileInput = {
  path: string;
  cwd?: string;
  edits: HashlineEdit[];
  expectedHash?: string;
  dangerouslyAllow?: boolean;
};

type EditFileInput = LegacyEditFileInput | HashlineEditFileInput;

function isLegacyEditFileInput(input: EditFileInput): input is LegacyEditFileInput {
  return "oldText" in input;
}

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

type SearchBackendMetadata = { effectiveBackend?: EffectiveSearchBackend };

function stripGlobMetadata(output: GlobOutput & SearchBackendMetadata): GlobOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripFuzzySearchMetadata(
  output: FuzzySearchOutput & SearchBackendMetadata,
): FuzzySearchOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripGrepMetadata(output: GrepOutput & SearchBackendMetadata): GrepOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

const SEARCH_TRUNCATION_HINT =
  "Search output reached the serialized-size limit. Narrow the query or inspect source files with read_file.";

function buildInlineMediaLimitMessage(params: {
  filename: string;
  mimeType: string;
  maxBytes: number;
  detail?: string;
}): string {
  const guidance = params.mimeType.startsWith("image/")
    ? "Resize or compress the image, then read the smaller file."
    : "Reduce or compress the file, then read the smaller file.";
  return `Cannot inline '${params.filename}' (${params.mimeType}): it exceeds the ${params.maxBytes}-byte media limit${params.detail ? ` (${params.detail})` : ""}. ${guidance}`;
}

function truncateUnicodeString(
  value: string,
  maxCharacters: number,
  preservePrefixWhenTiny = false,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;

  const marker = "...[truncated]";
  if (maxCharacters <= marker.length) {
    return preservePrefixWhenTiny
      ? characters.slice(0, maxCharacters).join("")
      : marker.slice(0, maxCharacters);
  }
  return `${characters.slice(0, maxCharacters - marker.length).join("")}${marker}`;
}

function truncateSearchEntryStrings(value: unknown, maxStringCharacters: number): unknown {
  if (typeof value === "string") {
    return truncateUnicodeString(value, maxStringCharacters);
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateSearchEntryStrings(item, maxStringCharacters));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        truncateSearchEntryStrings(item, maxStringCharacters),
      ]),
    );
  }
  return value;
}

function boundSearchOutput<T extends { truncated: boolean }>(
  output: T,
  entriesKey: "paths" | "entries" | "results",
  maxBytes: number,
): T {
  if (maxBytes < 2) throw new RangeError("Search maxBytes must be at least 2.");
  const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(output) <= maxBytes) return output;

  const next = structuredClone(output);
  const record = next as unknown as Record<string, unknown>;
  next.truncated = true;
  record["truncationHint"] = SEARCH_TRUNCATION_HINT;
  const entries = record[entriesKey];
  const minimum = structuredClone(next);
  const minimumRecord = minimum as unknown as Record<string, unknown>;
  minimumRecord[entriesKey] = [];
  delete minimumRecord["warnings"];
  delete minimumRecord["degradedFromHashline"];
  if (typeof minimumRecord["error"] === "string") {
    minimumRecord["error"] = truncateUnicodeString(minimumRecord["error"], 160, true);
  }
  const effectiveMaxBytes = Math.max(maxBytes, serializedBytes(minimum));

  if (Array.isArray(entries)) {
    while (entries.length > 1 && serializedBytes(next) > effectiveMaxBytes) entries.pop();

    let maxStringCharacters = Math.max(1, Math.floor(effectiveMaxBytes / 4));
    while (entries.length === 1 && serializedBytes(next) > effectiveMaxBytes) {
      entries[0] = truncateSearchEntryStrings(entries[0], maxStringCharacters);
      if (maxStringCharacters === 1) {
        entries.pop();
        break;
      }
      maxStringCharacters = Math.max(1, Math.floor(maxStringCharacters / 2));
    }
  }

  if (serializedBytes(next) <= effectiveMaxBytes) return next;

  // Error results should continue to communicate failure, even when their details are bounded.
  const originalError = typeof record["error"] === "string" ? record["error"] : undefined;
  delete record["warnings"];
  delete record["degradedFromHashline"];

  if (originalError !== undefined && serializedBytes(next) > effectiveMaxBytes) {
    const errorCharacters = Array.from(originalError).length;
    let low = 1;
    let high = errorCharacters;
    let best = "Error";

    record["error"] = best;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = truncateUnicodeString(originalError, middle, true);
      record["error"] = candidate;
      if (serializedBytes(next) <= effectiveMaxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    record["error"] = best;
  }

  if (serializedBytes(next) > effectiveMaxBytes && Array.isArray(entries)) entries.splice(0);
  if (serializedBytes(next) > effectiveMaxBytes && originalError !== undefined) {
    record["error"] = "Error";
  }

  if (serializedBytes(next) > effectiveMaxBytes) return minimum;

  return next;
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
  warnings: z.array(warningZod).optional(),
  degradedFromHashline: z.boolean().optional(),
});

const readFileOffsetStartZod = z.object({
  type: z.literal("offset"),
  offset: z.number().int().nonnegative(),
});
const readFileLineStartZod = z.object({
  type: z.literal("line"),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative().optional(),
});
const readFileStartZod = z.discriminatedUnion("type", [
  readFileOffsetStartZod,
  readFileLineStartZod,
]);

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
    nextStart: readFileStartZod.optional(),
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

const readFileArtifactSuccessZod = z.object({
  success: z.literal(true),
  kind: z.literal("artifact"),
  resolvedPath: z.string(),
  content: z.string(),
  startOffset: z.number(),
  endOffset: z.number(),
  totalCharacters: z.number(),
  nextStart: readFileStartZod.optional(),
  hasMore: z.boolean(),
});

function buildReadFileOutputZod(hashlineEnabled: boolean) {
  return z.union([
    readFileSuccessBaseZod.extend({
      format: z.literal("raw"),
      content: z.string(),
    }),
    readFileSuccessBaseZod.extend({
      format: z.literal("numbered"),
      numberedContent: z.string(),
    }),
    ...(hashlineEnabled
      ? [
          readFileSuccessBaseZod.extend({
            format: z.literal("hashline"),
            hashlineContent: z.string(),
          }),
        ]
      : []),
    readFileAttachmentSuccessZod,
    readFileArtifactSuccessZod,
    z.object({
      success: z.literal(false),
      resolvedPath: z.string(),
      error: z.object({
        code: readErrorCodeSchema,
        message: z.string(),
      }),
    }),
  ]);
}

type InstructionFields = {
  loadedInstructions?: string[];
  instructionsText?: string;
  warnings?: HashlineWarning[];
  degradedFromHashline?: boolean;
};

type ReadFileOutput =
  | {
      success: true;
      kind: "artifact";
      resolvedPath: string;
      content: string;
      startOffset: number;
      endOffset: number;
      totalCharacters: number;
      nextStart?: ReadFileStart;
      hasMore: boolean;
    }
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "raw";
      content: string;
    } & InstructionFields)
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "numbered";
      numberedContent: string;
    } & InstructionFields)
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "hashline";
      hashlineContent: string;
    } & InstructionFields)
  | ({
      success: true;
      kind: "attachment";
      resolvedPath: string;
      fileHash: string;
      filename: string;
      mimeType: string;
      bytes: number;
    } & InstructionFields)
  | {
      success: false;
      resolvedPath: string;
      error: { code: (typeof READ_ERROR_CODES)[number]; message: string };
    };

function resolveExpectedMatches(input: LegacyEditFileInput): "any" | number {
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

export function fsTool(
  cwd: string,
  opts?: {
    includeEditFile?: boolean;
    experimentalHashlineEdit?: boolean;
    fsBackend?: FsBackend;
    readFileDirectAttachmentSupported?: boolean;
    maxOutputBytes?: number;
    maxInlineMediaBytesPerPart?: number;
    artifactOnly?: boolean;
    toolResultArtifacts?: ToolResultArtifactStore;
    requestContext?: {
      requestId: string;
      sessionId: string;
    };
    loadInstructions?: boolean;
    denyPaths?: readonly string[];
    enforceDenylist?: boolean;
  },
) {
  const logger = createLogger({
    module: "tool:fs",
  });
  const includeEditFile = opts?.includeEditFile ?? false;
  const hashlineEnabled = opts?.experimentalHashlineEdit === true;
  const fsBackend = opts?.fsBackend ?? "node-rg";
  const readFileDirectAttachmentSupported = opts?.readFileDirectAttachmentSupported === true;
  const maxOutputBytes = opts?.maxOutputBytes ?? 40 * 1024;
  const maxInlineMediaBytesPerPart = opts?.maxInlineMediaBytesPerPart ?? 10 * 1024 * 1024;
  const readFileSchema = createReadFileInputSchema({
    hashlineEnabled,
    directAttachmentSupported: readFileDirectAttachmentSupported,
  });
  const readFileOutputSchema = buildReadFileOutputZod(hashlineEnabled);
  const grepInputSchema = createGrepInputSchema(hashlineEnabled);
  const grepOutputSchema = buildGrepOutputZod(hashlineEnabled);
  const editFileSchema = createEditFileInputSchema(hashlineEnabled);

  const toolRootAbs = path.resolve(expandTilde(cwd));

  const fileSystem = new FileSystem(cwd, {
    denyPaths: [
      path.join(env.dataDir, "secret"),
      path.join(env.dataDir, "tool-results"),
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      ...(opts?.denyPaths ?? []),
    ],
    fsBackend,
    fffCacheDir: FFF_CACHE_DIR,
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

  function buildReadFileDescription(): string {
    const parts = [
      readFileDirectAttachmentSupported
        ? "Reads files from the filesystem. For supported images and PDFs, calling read_file attaches the original file to your context for native visual or document analysis. Call read_file first for an image or PDF path, either directly or as an independent batch child; use shell media processing only if read_file reports that the input is unsupported or oversized."
        : hashlineEnabled
          ? "Reads a file from the filesystem. Default format is raw to preserve indentation. Use format='hashline' before edit_file when you need stable edit anchors. Very long lines may downgrade the response back to raw with a warning that tells you to use bash instead."
          : "Reads a file from the filesystem. Default format is raw (no line numbers) to preserve indentation.",
    ];

    if (readFileDirectAttachmentSupported && hashlineEnabled) {
      parts.push(
        "For text files, default format is raw to preserve indentation. Use format='hashline' before edit_file when you need stable edit anchors. Very long lines may downgrade the response back to raw with a warning that tells you to use bash instead.",
      );
    } else if (readFileDirectAttachmentSupported) {
      parts.push(
        "For text files, default format is raw (no line numbers) to preserve indentation.",
      );
    }

    parts.push(
      "Use maxCharacters with either absolute offset or line/column start positions to page through text resources. Absolute offsets count Unicode characters including newlines. Reuse nextStart unchanged to continue.",
    );
    parts.push("Denylisted paths require dangerouslyAllow=true.");
    return parts.join(" ");
  }

  const remoteFileAccessByResolvedPath = new Map<string, string>();
  const remoteResolvedPathByLookup = new Map<string, string>();

  function remoteResolvedPathKey(host: string, resolvedPath: string): string {
    return `${host}|${resolvedPath}`;
  }

  function remoteLookupKey(host: string, remoteCwd: string, inputPath: string): string {
    return `${host}|${remoteCwd}|${inputPath}`;
  }

  function normalizeRemoteLookupInputPath(inputPath: string): string {
    return inputPath.replace(/^\.\//, "");
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
      remoteLookupKey(
        params.host,
        params.remoteCwd,
        normalizeRemoteLookupInputPath(params.inputPath),
      ),
      params.resolvedPath,
    );
  }

  function lookupRemoteReadHash(params: {
    host: string;
    remoteCwd: string;
    inputPath: string;
  }): { resolvedPath: string; hash: string } | null {
    const resolvedPath = remoteResolvedPathByLookup.get(
      remoteLookupKey(
        params.host,
        params.remoteCwd,
        normalizeRemoteLookupInputPath(params.inputPath),
      ),
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
  ): output is Extract<ReadFileOutput, { success: true; format: "raw" | "numbered" | "hashline" }> {
    if (!output || typeof output !== "object") return false;
    const o = output as Record<string, unknown>;
    return (
      o["success"] === true &&
      (o["format"] === "raw" || o["format"] === "numbered" || o["format"] === "hashline") &&
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
    read_file: tool({
      description: buildReadFileDescription(),
      inputSchema: readFileSchema,
      outputSchema: readFileOutputSchema,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: ReadFileInput, options) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        if (input.path.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const sessionId = opts?.requestContext?.sessionId;
          const artifact =
            opts?.toolResultArtifacts && sessionId
              ? await opts.toolResultArtifacts.readWindow(input.path, sessionId, {
                  start: input.start ?? { type: "offset", offset: 0 },
                  maxCharacters: Math.max(1, input.maxCharacters ?? 10_000),
                  maxLines: Math.max(1, input.maxLines ?? 2_000),
                })
              : { ok: false as const };
          if (!artifact.ok) {
            return {
              success: false as const,
              resolvedPath: input.path,
              error: {
                code: "UNKNOWN" as const,
                message: TOOL_RESULT_UNAVAILABLE_MESSAGE,
              },
            };
          }

          return {
            success: true as const,
            kind: "artifact" as const,
            resolvedPath: input.path,
            content: artifact.content,
            startOffset: artifact.startOffset,
            endOffset: artifact.endOffset,
            totalCharacters: artifact.totalCharacters,
            ...(artifact.nextStart ? { nextStart: artifact.nextStart } : {}),
            hasMore: artifact.hasMore,
          };
        }

        if (opts?.artifactOnly) {
          return {
            success: false as const,
            resolvedPath: input.path,
            error: {
              code: "PERMISSION" as const,
              message: "Restricted sessions can use read_file only with tool-result:// artifacts.",
            },
          };
        }

        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.readFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          start: input.start,
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
                  maxBytes: maxInlineMediaBytesPerPart,
                });

                if (!bytesRes.ok) {
                  const filename = path.basename(input.path);
                  const mimeType = inferMimeTypeFromFilename(filename);
                  const message = /too large|media limit|maximum \d+ bytes/i.test(bytesRes.error)
                    ? buildInlineMediaLimitMessage({
                        filename,
                        mimeType,
                        maxBytes: maxInlineMediaBytesPerPart,
                        detail: bytesRes.error,
                      })
                    : bytesRes.error;
                  return {
                    success: false as const,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                    error: {
                      code: "UNKNOWN" as const,
                      message,
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
                {
                  path: input.path,
                  dangerouslyAllow,
                  maxBytes: maxInlineMediaBytesPerPart,
                },
                opCwd,
              );
              if (!bytesRes.success) {
                if (/too large|media limit|maximum \d+ bytes/i.test(bytesRes.error.message)) {
                  const filename = path.basename(bytesRes.resolvedPath);
                  const mimeType = inferMimeTypeFromFilename(filename);
                  return {
                    ...bytesRes,
                    error: {
                      ...bytesRes.error,
                      message: buildInlineMediaLimitMessage({
                        filename,
                        mimeType,
                        maxBytes: maxInlineMediaBytesPerPart,
                        detail: bytesRes.error.message,
                      }),
                    },
                  };
                }
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
                  input: {
                    ...input,
                    start: input.start,
                  },
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
            : await fileSystem.readFile(
                {
                  ...input,
                  start: input.start,
                  dangerouslyAllow,
                },
                opCwd,
              );

        const resQualified = (() => {
          if (cwdTarget.kind !== "ssh") return res;
          if (isAttachmentOutput(res)) return res;
          return {
            ...res,
            resolvedPath: toRemoteDebugPath(cwdTarget.host, res.resolvedPath),
          } as ReadFileOutput;
        })();

        const withInstructions = await (async () => {
          if (!resQualified.success) return resQualified;
          if (isAttachmentOutput(resQualified)) return resQualified;
          if (cwdTarget.kind === "ssh") {
            // Skip instruction auto-loading for remote reads for now.
            return resQualified;
          }
          if (opts?.loadInstructions === false) return resQualified;
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
                  : withInstructions.format === "numbered"
                    ? withInstructions.numberedContent.length
                    : withInstructions.hashlineContent.length,
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
            maxBytes: maxInlineMediaBytesPerPart,
          });
          if (!bytesRes.success) {
            const message = /too large|media limit|maximum \d+ bytes/i.test(bytesRes.error.message)
              ? buildInlineMediaLimitMessage({
                  filename,
                  mimeType,
                  maxBytes: maxInlineMediaBytesPerPart,
                  detail: bytesRes.error.message,
                })
              : bytesRes.error.message;
            return {
              type: "error-text",
              value: `Failed to read attachment bytes: ${message}`,
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
              {
                type: "file",
                mediaType: mimeType,
                filename,
                data: { type: "data", data: base64 },
              },
            ],
          };
        }

        return {
          type: "content",
          value: [
            { type: "text", text: intro },
            ...instructionParts,
            {
              type: "file",
              mediaType: mimeType,
              filename,
              data: { type: "data", data: base64 },
            },
          ],
        };
      },
    }),

    glob: tool({
      description:
        "Match filesystem paths using glob patterns. Recommended mode='default' for paths only; use mode='detailed' only when you need type/size. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: globInputZod,
      outputSchema: globOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: GlobInput) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
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
            fsBackend,
          });

          logger.info("fs.glob done", {
            entryCount: countGlobItems(res),
            truncated: res.truncated,
            error: res.error,
            mode: res.mode,
            effectiveBackend: res.effectiveBackend,
          });

          const output = stripGlobMetadata(res);
          return boundSearchOutput(
            output,
            output.mode === "default" ? "paths" : "entries",
            maxOutputBytes,
          );
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
          effectiveBackend: res.effectiveBackend,
        });

        const output = stripGlobMetadata(res);
        return boundSearchOutput(
          output,
          output.mode === "default" ? "paths" : "entries",
          maxOutputBytes,
        );
      },
    }),

    ...(fsBackend === "fff"
      ? {
          fuzzy_search: tool({
            description:
              "Fuzzy-ranked file/path search powered by FFF. Use this when you know an approximate filename, symbol-adjacent path, or path fragment and want likely files. Use grep instead when searching file contents or exact text inside files. Supports SSH cwd targets when the remote fff runner can be installed. Denylisted paths require dangerouslyAllow=true.",
            inputSchema: fuzzySearchInputZod,
            outputSchema: fuzzySearchOutputZod,
            execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: FuzzySearchInput) => {
              if (opts?.enforceDenylist) dangerouslyAllow = false;
              const cwdTarget = parseSshCwdTarget(opCwd);

              logger.info("fs.fuzzySearch", {
                query: input.query,
                cwd: opCwd,
                target: cwdTarget.kind,
                maxResults: input.maxResults,
                dangerouslyAllow: dangerouslyAllow === true,
              });

              if (cwdTarget.kind === "ssh") {
                const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);
                const res = await remoteFuzzySearch({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    query: input.query,
                    maxResults: input.maxResults,
                  },
                  denyPaths: remoteDenyPaths,
                });

                logger.info("fs.fuzzySearch done", {
                  resultCount: res.results.length,
                  totalMatched: res.totalMatched,
                  truncated: res.truncated,
                  error: res.error,
                  effectiveBackend: res.effectiveBackend,
                });

                return boundSearchOutput(stripFuzzySearchMetadata(res), "results", maxOutputBytes);
              }

              const res = await fileSystem.fuzzySearchFiles({
                query: input.query,
                maxResults: input.maxResults,
                baseDir: opCwd,
                dangerouslyAllow,
              });

              logger.info("fs.fuzzySearch done", {
                resultCount: res.results.length,
                totalMatched: res.totalMatched,
                truncated: res.truncated,
                error: res.error,
                effectiveBackend: res.effectiveBackend,
              });

              return boundSearchOutput(stripFuzzySearchMetadata(res), "results", maxOutputBytes);
            },
          }),
        }
      : {}),

    grep: tool({
      description: hashlineEnabled
        ? "Search file contents. Recommended mode='default'; use mode='hashline' when you want grep output that can be turned into edit anchors. Use mode='detailed' only when you need column/submatches metadata. Very long lines may downgrade hashline output back to default with a warning that tells you to use bash instead. Denylisted paths require dangerouslyAllow=true."
        : "Search file contents. Recommended mode='default'; use mode='detailed' only when you need column/submatches metadata. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: grepInputSchema,
      outputSchema: grepOutputSchema,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: GrepInput) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
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
            fsBackend,
          });

          if (res.mode === "hashline") {
            for (const match of res.results) {
              recordRemoteFileAccess({
                host: cwdTarget.host,
                remoteCwd: cwdTarget.cwd,
                inputPath: match.file,
                resolvedPath: match.resolvedPath,
                fileHash: match.fileHash,
              });
            }
          }

          logger.info("fs.grep done", {
            resultCount: countGrepItems(res),
            truncated: res.truncated,
            error: res.error,
            mode: res.mode,
            effectiveBackend: res.effectiveBackend,
          });

          return boundSearchOutput(stripGrepMetadata(res), "results", maxOutputBytes);
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
          effectiveBackend: res.effectiveBackend,
        });

        return boundSearchOutput(stripGrepMetadata(res), "results", maxOutputBytes);
      },
    }),
  };

  if (!includeEditFile) {
    return baseTools;
  }

  return {
    ...baseTools,
    edit_file: tool({
      description: hashlineEnabled
        ? "Edit an existing file using hashline anchors from read_file(format='hashline') or grep(mode='hashline'). Batch all edits for the file into one call, then re-read before any further edits. edit_file also checks the file hash from your prior read so unrelated external modifications are rejected. Very long lines may prevent hashline anchoring and require bash instead. Denylisted paths require dangerouslyAllow=true."
        : "Edit a file by find-and-replace. By default, oldText must be unique in the file. Set replaceAll=true to update all matches. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: editFileSchema,
      outputSchema: editFileOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: EditFileInput) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);
        const isLegacy = isLegacyEditFileInput(input);

        logger.info("fs.editFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          mode: hashlineEnabled ? "hashline" : "legacy",
          replaceAll: isLegacy ? input.replaceAll : undefined,
          matching: isLegacy ? input.matching : undefined,
          expectedMatches: isLegacy ? resolveExpectedMatches(input) : undefined,
          expectedHashProvided:
            typeof input.expectedHash === "string" && input.expectedHash.length > 0,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        const res = hashlineEnabled
          ? await (async () => {
              const hashlineInput = input as HashlineEditFileInput;
              if (cwdTarget.kind === "ssh") {
                let expectedHash = hashlineInput.expectedHash;
                let resolvedPathHint: string | undefined;

                if (!expectedHash) {
                  const prior = lookupRemoteReadHash({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: hashlineInput.path,
                  });
                  if (!prior) {
                    return {
                      success: false as const,
                      resolvedPath: toRemoteDebugPath(cwdTarget.host, hashlineInput.path),
                      error: {
                        code: "NOT_READ" as const,
                        message: `File must be read before editing: ${toRemoteDebugPath(cwdTarget.host, hashlineInput.path)}`,
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
                    path: hashlineInput.path,
                    edits: hashlineInput.edits,
                    mode: "hashline",
                    expectedHash,
                  },
                  denyPaths: remoteDenyPaths,
                });
                if (remoteRes.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: hashlineInput.path,
                    resolvedPath: remoteRes.resolvedPath,
                    fileHash: remoteRes.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, hashlineInput.path),
                    resolvedPathHint,
                  );
                }
                return normalizeEditOutput({
                  ...remoteRes,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteRes.resolvedPath),
                });
              }

              return normalizeEditOutput(
                await fileSystem.hashlineEditFile(
                  {
                    path: hashlineInput.path,
                    edits: hashlineInput.edits,
                    expectedHash: hashlineInput.expectedHash,
                    dangerouslyAllow,
                  },
                  opCwd,
                ),
              );
            })()
          : await (async () => {
              const legacyInput = input as LegacyEditFileInput;
              const occurrence: "all" | "first" = legacyInput.replaceAll ? "all" : "first";
              const editPayload: {
                path: string;
                edits: FileEdit[];
                expectedHash?: string;
              } = {
                path: legacyInput.path,
                edits: [
                  {
                    type: "replace_snippet",
                    target: legacyInput.oldText,
                    matching: legacyInput.matching,
                    newText: legacyInput.newText,
                    occurrence,
                    expectedMatches: resolveExpectedMatches(legacyInput),
                  },
                ],
                expectedHash: legacyInput.expectedHash,
              };

              if (cwdTarget.kind === "ssh") {
                let expectedHash = legacyInput.expectedHash;
                let resolvedPathHint: string | undefined;

                if (!expectedHash) {
                  const prior = lookupRemoteReadHash({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: legacyInput.path,
                  });
                  if (!prior) {
                    return {
                      success: false as const,
                      resolvedPath: toRemoteDebugPath(cwdTarget.host, legacyInput.path),
                      error: {
                        code: "NOT_READ" as const,
                        message: `File must be read before editing: ${toRemoteDebugPath(cwdTarget.host, legacyInput.path)}`,
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
                    mode: "legacy",
                  },
                  denyPaths: remoteDenyPaths,
                });

                if (remoteRes.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: legacyInput.path,
                    resolvedPath: remoteRes.resolvedPath,
                    fileHash: remoteRes.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, legacyInput.path),
                    resolvedPathHint,
                  );
                }

                return normalizeEditOutput({
                  ...remoteRes,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteRes.resolvedPath),
                });
              }

              return normalizeEditOutput(
                await fileSystem.editFile({ ...editPayload, dangerouslyAllow }, opCwd),
              );
            })();

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
