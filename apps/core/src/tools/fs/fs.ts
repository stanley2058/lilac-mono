import { DEFAULT_FS_DENY_PATHS } from "./deny-paths";
import { RemoteMediaTooLarge } from "./remote-media-download";
import { tool } from "ai";
import { z } from "zod/v4";
import {
  createStreamingTextWindow,
  EDIT_ERROR_CODES,
  FileSystem,
  READ_ERROR_CODES,
  expandTilde,
  grepText,
  type EffectiveFuzzySearchBackend,
  type EffectiveSearchBackend,
  type FileEdit,
  type FsBackend,
  type GrepMode,
  type HashlineEdit,
  type HashlineWarning,
  type ReadFileStart,
} from "@stanley2058/lilac-fs";
import { createLogger, env } from "@stanley2058/lilac-utils";
import { boundGrepOutput } from "@stanley2058/lilac-coding-tools/search-output";
import {
  createReadFileInstructionClaims,
  loadReadFileInstructions,
  READ_FILE_INSTRUCTION_HINT,
} from "@stanley2058/lilac-coding-tools/instructions";
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
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  adaptToolResultArtifactReadToUnavailablePolicy,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
  type ToolResultArtifactStore,
} from "../../artifacts/tool-result-artifact-store";
import type { ToolResultOutput } from "../../artifacts/tool-result-output-normalizer";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";
import {
  RESOURCE_MAX_BYTES,
  RESOURCE_MODEL_INLINE_MAX_BYTES,
  type ResourceDescriptor,
} from "../../resource/contracts";
import type { ResourceAccessError } from "../../resource/errors";
import { isResourceTextMediaType } from "../../resource/resource-mime";
import type { ResourceAccess, VerifiedResourceRead } from "../../resource/service";
import { bindTransientResourceAccess, isCoreToolResultResourceUri } from "../../resource/transient";
import { adaptToolResultToHost } from "../tool-result-adapters";
import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  remoteFuzzySearch,
  remoteGrep,
  remoteGlob,
  remoteEditFile,
  remoteReadFileBytes,
  remoteReadTextFile,
  toRemoteDebugPath,
  type RemoteFuzzySearchOutput,
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

const FFF_CACHE_DIR = path.join(env.dataDir, ".cache", "fff");
const RESOURCE_URI_PREFIX = "resource://";
const REDACTED_RESOURCE_LOG_PATH = "resource://[redacted]";

export type ReadRemoteMedia = (input: {
  readonly url: URL;
  readonly abortSignal?: AbortSignal;
  readonly maxBytes: number;
}) => Promise<
  ResultType<
    {
      readonly data: Uint8Array;
    },
    Error
  >
>;

function parseRemoteMediaUrl(value: string): URL | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

function remoteMediaFilename(url: URL, extension?: string): string {
  const filename = path.posix.basename(url.pathname);
  if (filename) return filename;
  return extension ? `remote-media.${extension}` : "remote-media";
}

function remoteMediaLogPath(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

function resolveRemoteDenyPaths(dangerouslyAllow?: boolean): readonly string[] {
  return dangerouslyAllow === true ? [] : DEFAULT_FS_DENY_PATHS;
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
  path?: string;
  regex?: boolean;
  maxResults?: number;
  fileExtensions?: string[];
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

function grepFailure(mode: GrepMode, error: string): GrepOutput {
  switch (mode) {
    case "default":
      return { mode, truncated: false, results: [], error };
    case "detailed":
      return { mode, truncated: false, results: [], error };
    case "hashline":
      return { mode, truncated: false, results: [], error };
  }
}

type SearchBackendMetadata = { effectiveBackend?: EffectiveSearchBackend };
type FuzzySearchBackendMetadata = { effectiveBackend?: EffectiveFuzzySearchBackend };

function stripGlobMetadata(output: GlobOutput & SearchBackendMetadata): GlobOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripFuzzySearchMetadata(
  output: FuzzySearchOutput & FuzzySearchBackendMetadata,
): FuzzySearchOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripGrepMetadata(output: GrepOutput & SearchBackendMetadata): GrepOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

const SEARCH_TRUNCATION_HINT =
  "Search output reached the serialized-size limit. Narrow the query or inspect source files with read.";

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

type BoundedSearchOutput = GlobOutput | FuzzySearchOutput | GrepOutput;
type BoundedSearchEntry =
  | string
  | Extract<GlobOutput, { mode: "detailed" }>["entries"][number]
  | FuzzySearchOutput["results"][number]
  | GrepOutput["results"][number];

function truncateSearchEntryStrings(
  value: BoundedSearchEntry,
  maxStringCharacters: number,
): BoundedSearchEntry {
  if (typeof value === "string") return truncateUnicodeString(value, maxStringCharacters);

  const entries = Object.entries(value).map(([key, item]) => {
    if (typeof item === "string") return [key, truncateUnicodeString(item, maxStringCharacters)];
    if (Array.isArray(item)) {
      return [
        key,
        item.map((submatch) => ({
          ...submatch,
          match: truncateUnicodeString(submatch.match, maxStringCharacters),
        })),
      ];
    }
    return [key, item];
  });
  return Object.fromEntries(entries) as BoundedSearchEntry;
}

function searchEntries(
  output: BoundedSearchOutput,
  entriesKey: "paths" | "entries" | "results",
): BoundedSearchEntry[] {
  if (entriesKey === "paths" && "paths" in output) return output.paths;
  if (entriesKey === "entries" && "entries" in output) return output.entries;
  if (entriesKey === "results" && "results" in output) return output.results;
  return [];
}

function removeSearchDiagnostics(output: BoundedSearchOutput): void {
  if ("warnings" in output) delete output.warnings;
  if ("degradedFromHashline" in output) delete output.degradedFromHashline;
}

function hasSearchFailure(output: BoundedSearchOutput): boolean {
  return typeof output.error === "string";
}

function boundSearchOutput<T extends BoundedSearchOutput>(
  output: T,
  entriesKey: "paths" | "entries" | "results",
  maxBytes: number,
): T {
  const effectiveConfiguredMaxBytes = Math.max(2, maxBytes);
  const serializedBytes = (value: BoundedSearchOutput) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(output) <= effectiveConfiguredMaxBytes) return output;

  const next = structuredClone(output);
  next.truncated = true;
  next.truncationHint = SEARCH_TRUNCATION_HINT;
  const entries = searchEntries(next, entriesKey);
  const minimum = structuredClone(next);
  searchEntries(minimum, entriesKey).splice(0);
  removeSearchDiagnostics(minimum);
  if (typeof minimum.error === "string") {
    minimum.error = truncateUnicodeString(minimum.error, 160, true);
  }
  const effectiveMaxBytes = Math.max(effectiveConfiguredMaxBytes, serializedBytes(minimum));

  while (entries.length > 1 && serializedBytes(next) > effectiveMaxBytes) entries.pop();

  let maxStringCharacters = Math.max(1, Math.floor(effectiveMaxBytes / 4));
  while (entries.length === 1 && serializedBytes(next) > effectiveMaxBytes) {
    entries[0] = truncateSearchEntryStrings(entries[0]!, maxStringCharacters);
    if (maxStringCharacters === 1) {
      entries.pop();
      break;
    }
    maxStringCharacters = Math.max(1, Math.floor(maxStringCharacters / 2));
  }

  if (serializedBytes(next) <= effectiveMaxBytes) return next;

  // Error results should continue to communicate failure, even when their details are bounded.
  const originalError = next.error;
  removeSearchDiagnostics(next);

  if (originalError !== undefined && serializedBytes(next) > effectiveMaxBytes) {
    const errorCharacters = Array.from(originalError).length;
    let low = 1;
    let high = errorCharacters;
    let best = "Error";

    next.error = best;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = truncateUnicodeString(originalError, middle, true);
      next.error = candidate;
      if (serializedBytes(next) <= effectiveMaxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    next.error = best;
  }

  if (serializedBytes(next) > effectiveMaxBytes) entries.splice(0);
  if (serializedBytes(next) > effectiveMaxBytes && originalError !== undefined) {
    next.error = "Error";
  }

  if (serializedBytes(next) > effectiveMaxBytes) return minimum;

  return next;
}

const instructionFieldsZod = z.object({
  loadedInstructions: z
    .array(z.string())
    .optional()
    .describe("Instruction file paths loaded for this read call"),
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

type ReadFileAttachmentOutput = Extract<ReadFileOutput, { success: true; kind: "attachment" }>;
type ReadFileFailureOutput = Extract<ReadFileOutput, { success: false }>;

type CapturedResourceFsOperation<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "defect"; readonly error: Error };

async function captureResourceFsOperation<T>(
  operation: () => Promise<T>,
): Promise<CapturedResourceFsOperation<T>> {
  const captured = await Result.tryPromise({
    try: operation,
    catch: (cause) =>
      Panic.is(cause)
        ? { kind: "panic" as const, panic: cause }
        : {
            kind: "defect" as const,
            error:
              cause instanceof Error ? cause : new Error("Resource filesystem operation failed"),
          },
  });
  return captured.match<CapturedResourceFsOperation<T>>({
    ok: (value) => ({ kind: "completed", value }),
    err: (failure) => failure,
  });
}

function resourceResultOutcome<T>(
  result: ResultType<T, ResourceAccessError>,
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResourceAccessError } {
  return result.match<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: ResourceAccessError }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function readResourceFailure(
  uri: string,
  code: (typeof READ_ERROR_CODES)[number],
  message: string,
): ReadFileOutput {
  return {
    success: false,
    resolvedPath: uri,
    error: { code, message },
  };
}

type ResourceDescriptorMediaHint = "text" | "image" | "pdf" | "other";

function mediaTypeHint(mediaType: string | undefined): ResourceDescriptorMediaHint {
  if (!mediaType) return "other";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  return isResourceTextMediaType(mediaType) ? "text" : "other";
}

function descriptorMediaHint(descriptor: ResourceDescriptor): ResourceDescriptorMediaHint {
  if (descriptor.detectedMediaType) return mediaTypeHint(descriptor.detectedMediaType);

  const filenameMediaType = descriptor.filename
    ? inferMimeTypeFromFilename(descriptor.filename)
    : undefined;
  return mediaTypeHint(filenameMediaType);
}

function resourceGuidanceMediaType(
  descriptor: ResourceDescriptor,
  hint: ResourceDescriptorMediaHint,
): string {
  if (descriptor.detectedMediaType) return descriptor.detectedMediaType;
  if (descriptor.declaredMediaType) return descriptor.declaredMediaType;
  if (hint === "pdf") return "application/pdf";
  if (hint === "image") return "image/*";
  return "application/octet-stream";
}

function resourceExpectedClassification(
  hint: ResourceDescriptorMediaHint,
): "text" | "image" | "pdf" | "any" {
  return hint === "other" ? "any" : hint;
}

function directMediaDescription(image: boolean, pdf: boolean): string {
  if (image && pdf) return "supported images and PDFs";
  if (image) return "supported images";
  return "PDFs";
}

function resourceFilename(descriptor: ResourceDescriptor): string {
  return descriptor.filename ?? "resource";
}

function resourceMediaLimitMessage(params: {
  readonly descriptor: ResourceDescriptor;
  readonly mediaType: string;
  readonly maxBytes: number;
}): string {
  return `Cannot inline '${resourceFilename(params.descriptor)}' (${params.mediaType}): it exceeds the ${params.maxBytes}-byte media limit. Use resource.materialize to write the resource into the working directory, transform it to a supported size or format, and then read the transformed file.`;
}

function unsupportedResourceMessage(
  descriptor: ResourceDescriptor,
  detectedMediaType?: string,
): string {
  const media = detectedMediaType ? ` (${detectedMediaType})` : "";
  return `Cannot read '${resourceFilename(descriptor)}'${media} directly because it is not supported text, image, or PDF content. Use resource.materialize to write the resource into the working directory.`;
}

async function consumeVerifiedResource<T>(params: {
  readonly read: VerifiedResourceRead;
  readonly signal?: AbortSignal;
  readonly consume: (chunk: Uint8Array) => void | Promise<void>;
  readonly finish: () => T | Promise<T>;
}): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error }
> {
  const consumed = await captureResourceFsOperation(async () => {
    for await (const chunk of params.read.stream) {
      if (params.signal?.aborted) {
        return adaptToolResultToHost(Result.err(new Error("Resource read was cancelled")));
      }
      await params.consume(chunk);
    }
    return await params.finish();
  });
  const completion = await captureResourceFsOperation(() => params.read.completion);

  if (consumed.kind === "panic") return adaptToolResultToHost(Result.err(consumed.panic));
  if (completion.kind === "panic") return adaptToolResultToHost(Result.err(completion.panic));
  if (completion.kind === "defect") return adaptToolResultToHost(Result.err(completion.error));

  const terminal = resourceResultOutcome(completion.value);
  if (!terminal.ok) return { ok: false, error: terminal.error };
  if (consumed.kind === "defect") return { ok: false, error: consumed.error };
  return { ok: true, value: consumed.value };
}

async function cancelVerifiedResource(read: VerifiedResourceRead): Promise<void> {
  const cancelled = await captureResourceFsOperation(() => read.stream.cancel());
  const completion = await captureResourceFsOperation(() => read.completion);
  if (cancelled.kind === "panic") return adaptToolResultToHost(Result.err(cancelled.panic));
  if (completion.kind === "panic") return adaptToolResultToHost(Result.err(completion.panic));
  if (cancelled.kind === "defect") return adaptToolResultToHost(Result.err(cancelled.error));
  if (completion.kind === "defect") return adaptToolResultToHost(Result.err(completion.error));
}

function createResourceTextWindow(params: {
  readonly uri: string;
  readonly fileHash: string;
  readonly start?: ReadFileStart;
  readonly maxLines?: number;
  readonly maxCharacters?: number;
  readonly maxOutputBytes: number;
  readonly format?: "raw" | "numbered";
}) {
  return createStreamingTextWindow({ ...params, resolvedPath: params.uri });
}

async function writeResourceChunk(
  handle: Awaited<ReturnType<typeof fs.open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (written.bytesWritten <= 0) {
      return adaptToolResultToHost(
        Result.err(new Error("Temporary resource write made no progress")),
      );
    }
    offset += written.bytesWritten;
  }
}

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
    readFileDirectImageSupported?: boolean;
    readFileDirectPdfSupported?: boolean;
    readRemoteMedia?: ReadRemoteMedia;
    maxOutputBytes?: number;
    maxInlineMediaBytesPerPart?: number;
    artifactOnly?: boolean;
    toolResultArtifacts?: ToolResultArtifactStore;
    resourceAccess?: ResourceAccess;
    resourceGrepTempRoot?: string;
    requestContext?: {
      requestId: string;
      sessionId: string;
    };
    loadInstructions?: boolean;
    denyPaths?: readonly string[];
  },
) {
  const logger = createLogger({
    module: "tool:fs",
  });
  const includeEditFile = opts?.includeEditFile ?? false;
  const hashlineEnabled = opts?.experimentalHashlineEdit === true;
  const fsBackend = opts?.fsBackend ?? "node-rg";
  const readFileDirectImageSupported = opts?.readFileDirectImageSupported === true;
  const readFileDirectPdfSupported = opts?.readFileDirectPdfSupported === true;
  const readFileDirectMediaSupported = readFileDirectImageSupported || readFileDirectPdfSupported;
  const mediaDescription = directMediaDescription(
    readFileDirectImageSupported,
    readFileDirectPdfSupported,
  );
  const maxOutputBytes = opts?.maxOutputBytes ?? 40 * 1024;
  const maxInlineMediaBytesPerPart = opts?.maxInlineMediaBytesPerPart ?? 10 * 1024 * 1024;
  const toolResultArtifactStore = opts?.toolResultArtifacts;
  const transientResourceAccess =
    toolResultArtifactStore && opts?.requestContext?.sessionId
      ? bindTransientResourceAccess(toolResultArtifactStore, opts.requestContext.sessionId)
      : undefined;
  const readFileSchema = createReadFileInputSchema({
    hashlineEnabled,
  }).extend({
    path: z
      .string()
      .describe(
        opts?.readRemoteMedia && readFileDirectMediaSupported
          ? "Filesystem path, resource:// URI, or HTTP(S) URL for a supported image or PDF."
          : "Filesystem path or resource:// URI.",
      ),
  });
  const readFileOutputSchema = buildReadFileOutputZod(hashlineEnabled);
  const grepInputSchema = createGrepInputSchema(hashlineEnabled).extend({
    path: z
      .string()
      .optional()
      .describe(
        "Optional filesystem path or resource:// URI to search. Defaults to the tool root.",
      ),
  });
  const grepOutputSchema = buildGrepOutputZod(hashlineEnabled);
  const editFileSchema = createEditFileInputSchema(hashlineEnabled);

  const toolRootAbs = path.resolve(expandTilde(cwd));

  const denyPaths = [
    path.join(env.dataDir, "secret"),
    path.join(env.dataDir, "tool-results"),
    ...DEFAULT_FS_DENY_PATHS,
    ...(opts?.denyPaths ?? []),
  ];
  const fileSystem = new FileSystem(cwd, {
    denyPaths,
    fsBackend,
    fffCacheDir: FFF_CACHE_DIR,
    fuzzySearchFallback: "fzf",
  });

  const attachmentExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

  const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const attachmentMimeTypes = new Set([...imageMimeTypes, "application/pdf"]);

  function directMediaTypeSupported(mediaType: string): boolean {
    if (imageMimeTypes.has(mediaType)) return readFileDirectImageSupported;
    return mediaType === "application/pdf" && readFileDirectPdfSupported;
  }

  function directMediaExtensionSupported(extension: string): boolean {
    if (extension === ".pdf") return readFileDirectPdfSupported;
    return attachmentExts.has(extension) && readFileDirectImageSupported;
  }

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
  const binaryCacheAbortCleanup = new Map<string, () => void>();
  function clearBinaryCache(toolCallId: string): void {
    binaryCacheByToolCallId.delete(toolCallId);
    binaryCacheAbortCleanup.get(toolCallId)?.();
    binaryCacheAbortCleanup.delete(toolCallId);
  }
  const instructionClaims = createReadFileInstructionClaims();

  async function finalizeAttachmentRead(params: {
    readonly source: "file" | "url";
    readonly resolvedPath: string;
    readonly filename: string;
    readonly bytes: Buffer;
    readonly fileHash: string;
    readonly reportedBytes?: number;
    readonly toolCallId: string;
  }): Promise<ReadFileAttachmentOutput | ReadFileFailureOutput> {
    const detected = await fileTypeFromBuffer(params.bytes);
    if (!detected || !attachmentMimeTypes.has(detected.mime)) {
      return {
        success: false,
        resolvedPath: params.resolvedPath,
        error: {
          code: "UNKNOWN",
          message: `Cannot attach '${params.filename}': its content is not a supported image or PDF.${params.source === "url" ? " Use fetch for web pages and text URLs." : ""}`,
        },
      };
    }

    const mimeType = detected.mime;
    if (!directMediaTypeSupported(mimeType)) {
      return {
        success: false,
        resolvedPath: params.resolvedPath,
        error: {
          code: "UNKNOWN",
          message: `Cannot attach '${params.filename}' (${mimeType}) because this model does not accept this file type as direct input.`,
        },
      };
    }

    binaryCacheByToolCallId.set(params.toolCallId, {
      resolvedPath: params.resolvedPath,
      filename: params.filename,
      mimeType,
      bytes: params.bytes,
      fileHash: params.fileHash,
    });
    return {
      success: true,
      kind: "attachment",
      resolvedPath: params.resolvedPath,
      fileHash: params.fileHash,
      filename: params.filename,
      mimeType,
      bytes: params.reportedBytes ?? params.bytes.byteLength,
    };
  }

  async function executeResourceRead(
    input: Omit<ReadFileInput, "cwd" | "dangerouslyAllow">,
    options: { readonly toolCallId: string; readonly abortSignal?: AbortSignal },
  ): Promise<ReadFileOutput> {
    const uri = input.path;
    if (input.format === "hashline") {
      return {
        success: false,
        resolvedPath: uri,
        error: {
          code: "UNKNOWN",
          message:
            "read format='hashline' is unavailable for resource:// resources; use format='raw' or format='numbered'.",
        },
      };
    }
    if (!opts?.resourceAccess) {
      return {
        success: false,
        resolvedPath: uri,
        error: { code: "UNKNOWN", message: "Resource access is unavailable" },
      };
    }

    const described = resourceResultOutcome(opts.resourceAccess.describe(uri));
    if (!described.ok) {
      return readResourceFailure(
        uri,
        described.error._tag === "ResourceNotFound" ? "NOT_FOUND" : "UNKNOWN",
        described.error.message,
      );
    }
    const descriptor = described.value;
    const mediaHint = descriptorMediaHint(descriptor);
    const inlineMaxBytes = Math.min(RESOURCE_MODEL_INLINE_MAX_BYTES, maxInlineMediaBytesPerPart);
    const boundedToInline = mediaHint !== "text";
    const operationMaxBytes = boundedToInline ? inlineMaxBytes : RESOURCE_MAX_BYTES;
    const opened = resourceResultOutcome(
      await opts.resourceAccess.open(uri, {
        maxBytes: operationMaxBytes,
        expected: resourceExpectedClassification(mediaHint),
        signal: options.abortSignal,
      }),
    );
    if (!opened.ok) {
      if (opened.error._tag === "ResourceTooLarge" && boundedToInline) {
        const mediaType = resourceGuidanceMediaType(descriptor, mediaHint);
        return {
          success: false,
          resolvedPath: uri,
          error: {
            code: "UNKNOWN",
            message: resourceMediaLimitMessage({ descriptor, mediaType, maxBytes: inlineMaxBytes }),
          },
        };
      }
      return readResourceFailure(
        uri,
        opened.error._tag === "ResourceNotFound" ? "NOT_FOUND" : "UNKNOWN",
        opened.error.message,
      );
    }

    const read = opened.value;
    if (read.classification.kind === "text") {
      if (maxOutputBytes < 4) {
        await cancelVerifiedResource(read);
        return {
          success: false,
          resolvedPath: uri,
          error: {
            code: "UNKNOWN",
            message: "read maxOutputBytes must be at least 4 to fit one Unicode character",
          },
        };
      }
      const window = createResourceTextWindow({
        uri,
        fileHash: read.blob.sha256,
        start: input.start,
        maxLines: input.maxLines,
        maxCharacters: input.maxCharacters,
        maxOutputBytes,
        format: input.format,
      });
      const consumed = await consumeVerifiedResource({
        read,
        signal: options.abortSignal,
        consume: window.consume,
        finish: window.finish,
      });
      return consumed.ok
        ? consumed.value
        : readResourceFailure(uri, "UNKNOWN", consumed.error.message);
    }

    if (read.classification.kind === "binary") {
      await cancelVerifiedResource(read);
      return {
        success: false,
        resolvedPath: uri,
        error: {
          code: "UNKNOWN",
          message: unsupportedResourceMessage(descriptor, read.classification.mediaType),
        },
      };
    }

    const mediaType = read.classification.mediaType;
    const directMediaSupported =
      read.classification.kind === "image"
        ? readFileDirectImageSupported
        : readFileDirectPdfSupported;
    if (!directMediaSupported) {
      await cancelVerifiedResource(read);
      return {
        success: false,
        resolvedPath: uri,
        error: {
          code: "UNKNOWN",
          message: `Cannot attach '${resourceFilename(descriptor)}' (${mediaType}) because this model does not accept this file type as direct input. Use resource.materialize to write the resource into the working directory.`,
        },
      };
    }
    if (read.blob.byteLength > inlineMaxBytes) {
      await cancelVerifiedResource(read);
      return {
        success: false,
        resolvedPath: uri,
        error: {
          code: "UNKNOWN",
          message: resourceMediaLimitMessage({ descriptor, mediaType, maxBytes: inlineMaxBytes }),
        },
      };
    }

    const chunks: Buffer[] = [];
    const consumed = await consumeVerifiedResource({
      read,
      signal: options.abortSignal,
      consume: (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      finish: () => Buffer.concat(chunks, read.blob.byteLength),
    });
    if (!consumed.ok) return readResourceFailure(uri, "UNKNOWN", consumed.error.message);

    const filename = resourceFilename(descriptor);
    binaryCacheByToolCallId.set(options.toolCallId, {
      resolvedPath: uri,
      filename,
      mimeType: mediaType,
      bytes: consumed.value,
      fileHash: read.blob.sha256,
    });
    return {
      success: true,
      kind: "attachment",
      resolvedPath: uri,
      fileHash: read.blob.sha256,
      filename,
      mimeType: mediaType,
      bytes: read.blob.byteLength,
    };
  }

  async function executeRemoteMediaRead(
    url: URL,
    options: { readonly toolCallId: string; readonly abortSignal?: AbortSignal },
  ): Promise<ReadFileOutput> {
    const resolvedPath = remoteMediaLogPath(url);
    const filenameHint = remoteMediaFilename(url);
    const download = opts?.readRemoteMedia;
    if (!download) {
      return {
        success: false,
        resolvedPath,
        error: {
          code: "PERMISSION",
          message: "Reading remote media is unavailable because this run cannot use web.fetch.",
        },
      };
    }
    if (!readFileDirectMediaSupported) {
      return {
        success: false,
        resolvedPath,
        error: {
          code: "UNKNOWN",
          message: "This model does not accept images or PDFs as direct input.",
        },
      };
    }

    const downloaded = (
      await download({
        url,
        abortSignal: options.abortSignal,
        maxBytes: maxInlineMediaBytesPerPart,
      })
    ).match<
      | { readonly ok: true; readonly data: Uint8Array }
      | { readonly ok: false; readonly error: Error }
    >({
      ok: (value) => ({ ok: true, ...value }),
      err: (error) => ({ ok: false, error }),
    });
    if (!downloaded.ok) {
      return remoteMediaDownloadFailure(resolvedPath, filenameHint, downloaded.error);
    }

    const bytes = Buffer.from(downloaded.data);
    return await finalizeAttachmentRead({
      source: "url",
      resolvedPath,
      filename: filenameHint,
      bytes,
      fileHash: createHash("sha256").update(bytes).digest("hex"),
      toolCallId: options.toolCallId,
    });
  }

  function remoteMediaDownloadFailure(
    resolvedPath: string,
    filename: string,
    error: Error,
  ): ReadFileFailureOutput {
    const message = RemoteMediaTooLarge.is(error)
      ? buildInlineMediaLimitMessage({
          filename,
          mimeType: inferMimeTypeFromFilename(filename),
          maxBytes: maxInlineMediaBytesPerPart,
          detail: error.message,
        })
      : error.message;
    return {
      success: false,
      resolvedPath,
      error: { code: "UNKNOWN", message },
    };
  }

  async function executeLoggedRemoteMediaRead(
    url: URL,
    input: Omit<ReadFileInput, "cwd" | "dangerouslyAllow">,
    options: { readonly toolCallId: string; readonly abortSignal?: AbortSignal },
  ): Promise<ReadFileOutput> {
    logger.info("fs.readFile", {
      path: remoteMediaLogPath(url),
      target: "url",
      format: input.format ?? "raw",
    });
    return await executeRemoteMediaRead(url, options);
  }

  async function executeResourceGrep(
    input: GrepInput & { readonly path: string },
    options: { readonly abortSignal?: AbortSignal },
  ): Promise<GrepOutput> {
    const mode = input.mode ?? "default";
    const uri = input.path;
    if (mode === "hashline") {
      return boundGrepOutput(
        grepFailure(
          mode,
          "grep mode='hashline' is unavailable for resource:// resources; use mode='default' or mode='detailed'.",
        ),
        maxOutputBytes,
      );
    }
    if (!opts?.resourceAccess) {
      return boundGrepOutput(grepFailure(mode, "Resource access is unavailable"), maxOutputBytes);
    }

    const opened = resourceResultOutcome(
      await opts.resourceAccess.open(uri, {
        maxBytes: RESOURCE_MAX_BYTES,
        expected: "text",
        signal: options.abortSignal,
      }),
    );
    if (!opened.ok) {
      return boundGrepOutput(grepFailure(mode, opened.error.message), maxOutputBytes);
    }
    const read = opened.value;
    if (read.classification.kind !== "text") {
      await cancelVerifiedResource(read);
      return boundGrepOutput(
        grepFailure(
          mode,
          unsupportedResourceMessage(read.descriptor, read.classification.mediaType),
        ),
        maxOutputBytes,
      );
    }

    const temporaryDirectory = await captureResourceFsOperation(() =>
      fs.mkdtemp(path.join(opts.resourceGrepTempRoot ?? tmpdir(), "lilac-resource-grep-")),
    );
    if (temporaryDirectory.kind === "panic") {
      return adaptToolResultToHost(Result.err(temporaryDirectory.panic));
    }
    if (temporaryDirectory.kind === "defect") {
      await cancelVerifiedResource(read);
      return boundGrepOutput(
        grepFailure(mode, "Unable to create a private temporary resource search file"),
        maxOutputBytes,
      );
    }

    const tempDir = temporaryDirectory.value;
    const tempFile = path.join(tempDir, "resource.txt");
    let resourceOutput: GrepOutput;
    let retainedPanic: Panic | undefined;
    const openedFile = await captureResourceFsOperation(() => fs.open(tempFile, "wx", 0o600));
    if (openedFile.kind === "panic") {
      retainedPanic = openedFile.panic;
      await cancelVerifiedResource(read);
      resourceOutput = grepFailure(mode, "Unable to create a temporary resource search file");
    } else if (openedFile.kind === "defect") {
      await cancelVerifiedResource(read);
      resourceOutput = grepFailure(mode, "Unable to create a temporary resource search file");
    } else {
      const handle = openedFile.value;
      const copiedAttempt = await captureResourceFsOperation(() =>
        consumeVerifiedResource({
          read,
          signal: options.abortSignal,
          consume: (chunk) => writeResourceChunk(handle, chunk),
          finish: () => undefined,
        }),
      );
      const closed = await captureResourceFsOperation(() => handle.close());
      if (copiedAttempt.kind === "panic") retainedPanic = copiedAttempt.panic;
      if (closed.kind === "panic" && !retainedPanic) retainedPanic = closed.panic;

      if (copiedAttempt.kind === "defect") {
        resourceOutput = grepFailure(mode, copiedAttempt.error.message);
      } else if (copiedAttempt.kind === "panic") {
        resourceOutput = grepFailure(mode, "Resource search staging failed");
      } else if (!copiedAttempt.value.ok) {
        resourceOutput = grepFailure(mode, copiedAttempt.value.error.message);
      } else if (closed.kind === "defect") {
        resourceOutput = grepFailure(mode, "Unable to close the temporary resource search file");
      } else if (options.abortSignal?.aborted) {
        resourceOutput = grepFailure(mode, "Resource search was cancelled");
      } else {
        const searched = await fileSystem.grep({
          pattern: input.pattern,
          regex: input.regex,
          maxResults: input.maxResults,
          fileExtensions: [],
          baseDir: tempFile,
          reportedFilePath: uri,
          mode,
        });
        resourceOutput = stripGrepMetadata(searched);
      }
    }

    const cleaned = await captureResourceFsOperation(() =>
      fs.rm(tempDir, { recursive: true, force: true }),
    );
    if (retainedPanic) return adaptToolResultToHost(Result.err(retainedPanic));
    if (cleaned.kind === "panic") return adaptToolResultToHost(Result.err(cleaned.panic));
    if (cleaned.kind === "defect") {
      return boundGrepOutput(
        grepFailure(mode, "Unable to remove the temporary resource search file"),
        maxOutputBytes,
      );
    }
    return boundGrepOutput(resourceOutput, maxOutputBytes);
  }

  function buildReadFileDescription(): string {
    const parts = ["Reads text from a filesystem path or resource:// URI."];
    if (readFileDirectMediaSupported) {
      parts.push(
        opts?.readRemoteMedia
          ? `Analyze ${mediaDescription} already attached to context directly. Use read to attach ${mediaDescription} from a filesystem path, resource:// URI, or direct HTTP(S) URL. Use fetch for web pages and text URLs. If read reports unsupported or oversized media, use shell tools to create a supported file, then read that file.`
          : `Analyze ${mediaDescription} already attached to context directly. Use read to attach ${mediaDescription} available only through a filesystem path or resource:// URI. If read reports unsupported or oversized media, use shell tools to create a supported file, then read that file.`,
      );
    }
    parts.push("Continue a paged text read by passing a returned nextStart back unchanged.");
    parts.push(READ_FILE_INSTRUCTION_HINT);
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

  const baseTools = {
    read: tool({
      description: buildReadFileDescription(),
      inputSchema: readFileSchema,
      outputSchema: readFileOutputSchema,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: ReadFileInput, options) => {
        clearBinaryCache(options.toolCallId);
        const onAbort = () => clearBinaryCache(options.toolCallId);
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        binaryCacheAbortCleanup.set(options.toolCallId, () =>
          options.abortSignal?.removeEventListener("abort", onAbort),
        );
        return await (async () => {
          if (
            input.path.startsWith(RESOURCE_URI_PREFIX) &&
            !isCoreToolResultResourceUri(input.path)
          ) {
            logger.info("fs.readFile", {
              path: REDACTED_RESOURCE_LOG_PATH,
              cwd: opCwd,
              target: "resource",
              start: input.start,
              maxLines: input.maxLines,
              maxCharacters: input.maxCharacters,
              format: input.format ?? "raw",
              dangerouslyAllow: dangerouslyAllow === true,
            });
            return await executeResourceRead(input, options);
          }
          if (isCoreToolResultResourceUri(input.path)) {
            const artifact =
              transientResourceAccess && toolResultArtifactStore
                ? await adaptToolResultArtifactReadToUnavailablePolicy(
                    toolResultArtifactStore,
                    await transientResourceAccess.readWindow(input.path, {
                      start: input.start ?? { type: "offset", offset: 0 },
                      maxCharacters: Math.max(1, input.maxCharacters ?? 10_000),
                      maxLines: Math.max(1, input.maxLines ?? 2_000),
                      maxOutputBytes,
                    }),
                  )
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

          const remoteMediaUrl = parseRemoteMediaUrl(input.path);
          if (remoteMediaUrl) {
            return await executeLoggedRemoteMediaRead(remoteMediaUrl, input, options);
          }

          if (opts?.artifactOnly) {
            return {
              success: false as const,
              resolvedPath: input.path,
              error: {
                code: "PERMISSION" as const,
                message: "Restricted sessions can use read only with resource:// references.",
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
          const wantsAttachment = directMediaExtensionSupported(ext);
          const rejectsAttachment =
            readFileDirectMediaSupported && attachmentExts.has(ext) && !wantsAttachment;

          const res: ReadFileOutput = await (async (): Promise<ReadFileOutput> => {
            if (rejectsAttachment) {
              const filename = path.basename(input.path);
              const mimeType = inferMimeTypeFromFilename(filename);
              return {
                success: false,
                resolvedPath: input.path,
                error: {
                  code: "UNKNOWN",
                  message: `Cannot attach '${filename}' (${mimeType}) because this model does not accept this file type as direct input.`,
                },
              };
            }
            if (wantsAttachment) {
              if (cwdTarget.kind === "ssh") {
                const bytesRes = await remoteReadFileBytes({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  filePath: input.path,
                  denyPaths: remoteDenyPaths,
                  maxBytes: maxInlineMediaBytesPerPart,
                  signal: options.abortSignal,
                });
                const bytesError = bytesRes.match({ ok: () => null, err: (error) => error });
                if (bytesError) {
                  return {
                    success: false,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                    error: { code: "UNKNOWN", message: bytesError.message },
                  };
                }
                const bytesOutput = selectResultValue(bytesRes);
                if (!bytesOutput.ok) {
                  const filename = path.basename(input.path);
                  const mimeType = inferMimeTypeFromFilename(filename);
                  const message =
                    bytesOutput.errorCode === "MEDIA_TOO_LARGE"
                      ? buildInlineMediaLimitMessage({
                          filename,
                          mimeType,
                          maxBytes: maxInlineMediaBytesPerPart,
                          detail: bytesOutput.error,
                        })
                      : bytesOutput.error;
                  return {
                    success: false as const,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                    error: {
                      code: "UNKNOWN" as const,
                      message,
                    },
                  };
                }

                const bytes = Buffer.from(bytesOutput.base64, "base64");
                const remoteResolvedPath = toRemoteDebugPath(
                  cwdTarget.host,
                  bytesOutput.resolvedPath,
                );
                recordRemoteFileAccess({
                  host: cwdTarget.host,
                  remoteCwd: cwdTarget.cwd,
                  inputPath: input.path,
                  resolvedPath: bytesOutput.resolvedPath,
                  fileHash: bytesOutput.fileHash,
                });
                const filename = path.basename(bytesOutput.resolvedPath);
                return await finalizeAttachmentRead({
                  source: "file",
                  resolvedPath: remoteResolvedPath,
                  filename,
                  bytes,
                  fileHash: bytesOutput.fileHash,
                  reportedBytes: bytesOutput.bytesLength,
                  toolCallId: options.toolCallId,
                });
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
                if (bytesRes.error.code === "MEDIA_TOO_LARGE") {
                  const filename = path.basename(bytesRes.resolvedPath);
                  const mimeType = inferMimeTypeFromFilename(filename);
                  return {
                    ...bytesRes,
                    error: {
                      ...bytesRes.error,
                      code: "UNKNOWN" as const,
                      message: buildInlineMediaLimitMessage({
                        filename,
                        mimeType,
                        maxBytes: maxInlineMediaBytesPerPart,
                        detail: bytesRes.error.message,
                      }),
                    },
                  };
                }
                return { ...bytesRes, error: { ...bytesRes.error, code: bytesRes.error.code } };
              }

              const resolvedPath = bytesRes.resolvedPath;
              const filename = path.basename(resolvedPath);
              const attachment = await finalizeAttachmentRead({
                source: "file",
                resolvedPath,
                filename,
                bytes: bytesRes.bytes,
                fileHash: bytesRes.fileHash,
                reportedBytes: bytesRes.bytesLength,
                toolCallId: options.toolCallId,
              });
              if (!attachment.success) return attachment;

              const instructions = await loadReadFileInstructions({
                resolvedPath,
                requestedPath: input.path,
                cwd: opCwd ?? toolRootAbs,
                messages: options.messages,
                denyPaths,
                claimedInstructionPaths: instructionClaims.forMessages(options.messages),
              });

              return {
                ...attachment,
                ...(instructions
                  ? {
                      loadedInstructions: instructions.loaded,
                      instructionsText: instructions.text,
                    }
                  : {}),
              };
            }
            if (cwdTarget.kind === "ssh") {
              const remoteRes = await remoteReadTextFile({
                host: cwdTarget.host,
                cwd: cwdTarget.cwd,
                input: {
                  ...input,
                  start: input.start,
                  maxBytes: maxOutputBytes,
                },
                denyPaths: remoteDenyPaths,
                signal: options.abortSignal,
              });
              const remoteError = remoteRes.match({ ok: () => null, err: (error) => error });
              if (remoteError) {
                return {
                  success: false,
                  resolvedPath: input.path,
                  error: { code: "UNKNOWN", message: remoteError.message },
                };
              }
              const remoteOutput = selectResultValue(remoteRes);
              if (remoteOutput.success) {
                recordRemoteFileAccess({
                  host: cwdTarget.host,
                  remoteCwd: cwdTarget.cwd,
                  inputPath: input.path,
                  resolvedPath: remoteOutput.resolvedPath,
                  fileHash: remoteOutput.fileHash,
                });
              }
              return remoteOutput;
            }
            return await fileSystem.readFile(
              {
                ...input,
                start: input.start,
                maxBytes: maxOutputBytes,
                dangerouslyAllow,
              },
              opCwd,
            );
          })();

          const resQualified = (() => {
            if (cwdTarget.kind !== "ssh") return res;
            if (res.success && "kind" in res) {
              switch (res.kind) {
                case "artifact":
                case "attachment":
                  return res;
              }
            }
            return {
              ...res,
              resolvedPath: toRemoteDebugPath(cwdTarget.host, res.resolvedPath),
            };
          })();

          const withInstructions = await (async () => {
            if (!resQualified.success) return resQualified;
            if ("kind" in resQualified) {
              switch (resQualified.kind) {
                case "artifact":
                case "attachment":
                  return resQualified;
              }
            }
            if (cwdTarget.kind === "ssh") {
              // Skip instruction auto-loading for remote reads for now.
              return resQualified;
            }
            if (opts?.loadInstructions === false) return resQualified;
            const instructions = await loadReadFileInstructions({
              resolvedPath: resQualified.resolvedPath,
              requestedPath: input.path,
              cwd: opCwd ?? toolRootAbs,
              messages: options.messages,
              denyPaths,
              claimedInstructionPaths: instructionClaims.forMessages(options.messages),
            });
            if (!instructions) return resQualified;
            return {
              ...resQualified,
              loadedInstructions: instructions.loaded,
              instructionsText: instructions.text,
            };
          })();

          if (
            options.abortSignal?.aborted ||
            !(
              withInstructions.success &&
              "kind" in withInstructions &&
              withInstructions.kind === "attachment"
            )
          )
            clearBinaryCache(options.toolCallId);
          return withInstructions;
        })().finally(() => {
          if (options.abortSignal?.aborted || !binaryCacheByToolCallId.has(options.toolCallId))
            clearBinaryCache(options.toolCallId);
        });
      },
      toModelOutput: async ({ toolCallId, output }) => {
        if (!output.success) return { type: "error-json", value: output };
        if (!("kind" in output)) {
          return { type: "json", value: output };
        }
        switch (output.kind) {
          case "artifact":
            return { type: "json", value: output };
          case "attachment":
            break;
        }

        const cached = binaryCacheByToolCallId.get(toolCallId);
        clearBinaryCache(toolCallId);

        const bytes = cached?.bytes;
        const filename = cached?.filename ?? output.filename;
        const mimeType = cached?.mimeType ?? output.mimeType;

        if (
          (output.resolvedPath.startsWith(RESOURCE_URI_PREFIX) ||
            parseRemoteMediaUrl(output.resolvedPath)) &&
          bytes === undefined
        ) {
          return {
            type: "error-text",
            value: `Failed to retain verified attachment bytes for '${filename}'.`,
          };
        }

        let base64: string;
        if (bytes) {
          base64 = Buffer.from(bytes).toString("base64");
        } else {
          const bytesRes = await fileSystem.readFileBytes({
            path: output.resolvedPath,
            maxBytes: maxInlineMediaBytesPerPart,
          });
          if (!bytesRes.success) {
            const message =
              bytesRes.error.code === "MEDIA_TOO_LARGE"
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

        const intro = `Attached file from read: ${filename} (${mimeType}, ${output.bytes} bytes).`;

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
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: GlobInput, options) => {
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
          const remoteResult = await remoteGlob({
            host: cwdTarget.host,
            cwd: cwdTarget.cwd,
            patterns: input.patterns,
            maxEntries: input.maxEntries,
            mode,
            denyPaths: remoteDenyPaths,
            fsBackend,
            signal: options.abortSignal,
          });
          const res = remoteResult.match({
            ok: (value) => value,
            err: (error) =>
              mode === "default"
                ? { mode, truncated: false, paths: [], error: error.message }
                : { mode, truncated: false, entries: [], error: error.message },
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
          failureMessage: res.error,
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
      toModelOutput: ({ output }): ToolResultOutput =>
        hasSearchFailure(output)
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),

    ...(fsBackend === "fff"
      ? {
          fuzzy_search: tool({
            description:
              "Fuzzy-ranked file/path search powered by FFF with an on-demand fzf fallback. Use this when you know an approximate filename, symbol-adjacent path, or path fragment and want likely files. Use grep instead when searching file contents or exact text inside files. Supports SSH cwd targets when the remote filesystem runner can be installed. Denylisted paths require dangerouslyAllow=true.",
            inputSchema: fuzzySearchInputZod,
            outputSchema: fuzzySearchOutputZod,
            execute: async (
              { cwd: opCwd, dangerouslyAllow, ...input }: FuzzySearchInput,
              options,
            ) => {
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
                const remoteResult = await remoteFuzzySearch({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    query: input.query,
                    maxResults: input.maxResults,
                  },
                  denyPaths: remoteDenyPaths,
                  signal: options.abortSignal,
                });
                const res = remoteResult.match<RemoteFuzzySearchOutput>({
                  ok: (value) => value,
                  err: (error) => ({
                    results: [],
                    totalMatched: 0,
                    totalFiles: 0,
                    truncated: false,
                    error: `remote fuzzy_search unavailable: ${error.message}`,
                  }),
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
                failureMessage: res.error,
                effectiveBackend: res.effectiveBackend,
              });

              return boundSearchOutput(stripFuzzySearchMetadata(res), "results", maxOutputBytes);
            },
            toModelOutput: ({ output }): ToolResultOutput =>
              hasSearchFailure(output)
                ? { type: "error-json", value: output }
                : { type: "json", value: output },
          }),
        }
      : {}),

    grep: tool({
      description: hashlineEnabled
        ? "Search a local file or directory, SSH path, or resource:// URI. Recommended mode='default'; use mode='hashline' only for editable filesystem paths, or mode='detailed' for column/submatches metadata. Output always stays inline and may be truncated with narrowing guidance. Denylisted filesystem paths require dangerouslyAllow=true."
        : "Search a local file or directory, SSH path, or resource:// URI. Recommended mode='default'; use mode='detailed' only for column/submatches metadata. Output always stays inline and may be truncated with narrowing guidance. Denylisted filesystem paths require dangerouslyAllow=true.",
      inputSchema: grepInputSchema,
      outputSchema: grepOutputSchema,
      execute: async ({ dangerouslyAllow, ...input }: GrepInput, options): Promise<GrepOutput> => {
        const mode = input.mode ?? "default";
        const targetPath = input.path;
        if (
          targetPath?.startsWith(RESOURCE_URI_PREFIX) &&
          !isCoreToolResultResourceUri(targetPath)
        ) {
          logger.info("fs.grep", {
            pattern: input.pattern,
            path: REDACTED_RESOURCE_LOG_PATH,
            target: "resource",
            regex: input.regex,
            fileExtensions: input.fileExtensions,
            maxResults: input.maxResults,
            mode,
            dangerouslyAllow: dangerouslyAllow === true,
          });
          const result = await executeResourceGrep({ ...input, path: targetPath }, options);
          logger.info("fs.grep done", {
            resultCount: countGrepItems(result),
            truncated: result.truncated,
            failureMessage: result.error,
            mode: result.mode,
            effectiveBackend: "resource",
          });
          return result;
        }
        if (targetPath && isCoreToolResultResourceUri(targetPath)) {
          const artifact =
            transientResourceAccess && toolResultArtifactStore
              ? await adaptToolResultArtifactReadToUnavailablePolicy(
                  toolResultArtifactStore,
                  await transientResourceAccess.read(targetPath),
                )
              : { ok: false as const };
          if (!artifact.ok) {
            return boundGrepOutput(
              grepFailure(mode, TOOL_RESULT_UNAVAILABLE_MESSAGE),
              maxOutputBytes,
            );
          }
          if (mode === "hashline") {
            return boundGrepOutput(
              grepFailure(
                mode,
                "grep mode='hashline' is unavailable for transient resources; use mode='default' or mode='detailed'.",
              ),
              maxOutputBytes,
            );
          }

          const searched = await grepText({
            content: artifact.content,
            reportedPath: targetPath,
            pattern: input.pattern,
            regex: input.regex,
            maxMatches: input.maxResults ?? 100,
          });
          const searchError = searched.match({ ok: () => null, err: (error) => error });
          if (searchError) {
            return boundGrepOutput(grepFailure(mode, searchError.message), maxOutputBytes);
          }
          const searchValue = selectResultValue(searched);
          if (mode === "default") {
            return boundGrepOutput(
              {
                mode,
                truncated: searchValue.truncated,
                results: searchValue.matches.map(({ file, line, text }) => ({
                  file,
                  line,
                  text,
                })),
              },
              maxOutputBytes,
            );
          }
          return boundGrepOutput(
            {
              mode,
              truncated: searchValue.truncated,
              results: searchValue.matches,
            },
            maxOutputBytes,
          );
        }

        const pathTarget = parseSshCwdTarget(targetPath);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.grep", {
          pattern: input.pattern,
          path: targetPath,
          target: pathTarget.kind,
          regex: input.regex,
          fileExtensions: input.fileExtensions,
          maxResults: input.maxResults,
          mode,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        if (pathTarget.kind === "ssh") {
          const remoteResult = await remoteGrep({
            host: pathTarget.host,
            cwd: pathTarget.cwd,
            input: {
              pattern: input.pattern,
              regex: input.regex,
              maxResults: input.maxResults,
              fileExtensions: input.fileExtensions,
              mode,
            },
            denyPaths: remoteDenyPaths,
            fsBackend,
            signal: options.abortSignal,
          });
          const res = remoteResult.match({
            ok: (value) => value,
            err: (error) => {
              switch (mode) {
                case "default":
                  return { mode, truncated: false, results: [], error: error.message };
                case "detailed":
                  return { mode, truncated: false, results: [], error: error.message };
                case "hashline":
                  return { mode, truncated: false, results: [], error: error.message };
              }
            },
          });

          if (res.mode === "hashline") {
            for (const match of res.results) {
              recordRemoteFileAccess({
                host: pathTarget.host,
                remoteCwd: pathTarget.cwd,
                inputPath: match.file,
                resolvedPath: match.resolvedPath,
                fileHash: match.fileHash,
              });
            }
          }

          return boundGrepOutput(stripGrepMetadata(res), maxOutputBytes);
        }

        const res = await fileSystem.grep({
          pattern: input.pattern,
          regex: input.regex,
          maxResults: input.maxResults,
          fileExtensions: input.fileExtensions,
          baseDir: targetPath,
          mode,
          dangerouslyAllow,
        });

        logger.info("fs.grep done", {
          resultCount: countGrepItems(res),
          truncated: res.truncated,
          failureMessage: res.error,
          mode: res.mode,
          effectiveBackend: res.effectiveBackend,
        });

        return boundGrepOutput(stripGrepMetadata(res), maxOutputBytes);
      },
      toModelOutput: ({ output }): ToolResultOutput =>
        hasSearchFailure(output)
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),
  };

  if (!includeEditFile) {
    return baseTools;
  }

  return {
    ...baseTools,
    edit: tool({
      description: hashlineEnabled
        ? "Edit an existing file using hashline anchors from read(format='hashline') or grep(mode='hashline'). Batch all edits for the file into one call, then re-read before any further edits. edit also checks the file hash from your prior read so unrelated external modifications are rejected. Very long lines may prevent hashline anchoring and require bash instead. Denylisted paths require dangerouslyAllow=true."
        : "Edit a file by find-and-replace. By default, oldText must be unique in the file. Set replaceAll=true to update all matches. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: editFileSchema,
      outputSchema: editFileOutputZod,
      execute: async (
        { cwd: opCwd, dangerouslyAllow, ...input }: EditFileInput,
        options: { abortSignal?: AbortSignal },
      ) => {
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
                  signal: options.abortSignal,
                });
                const remoteError = remoteRes.match({ ok: () => null, err: (error) => error });
                if (remoteError) {
                  if (resolvedPathHint) {
                    remoteResolvedPathByLookup.set(
                      remoteLookupKey(cwdTarget.host, cwdTarget.cwd, hashlineInput.path),
                      resolvedPathHint,
                    );
                  }
                  return normalizeEditOutput({
                    success: false,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, hashlineInput.path),
                    error: { code: "UNKNOWN", message: remoteError.message },
                  });
                }
                const remoteOutput = selectResultValue(remoteRes);
                if (remoteOutput.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: hashlineInput.path,
                    resolvedPath: remoteOutput.resolvedPath,
                    fileHash: remoteOutput.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, hashlineInput.path),
                    resolvedPathHint,
                  );
                }
                return normalizeEditOutput({
                  ...remoteOutput,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteOutput.resolvedPath),
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
                  signal: options.abortSignal,
                });
                const remoteError = remoteRes.match({ ok: () => null, err: (error) => error });
                if (remoteError) {
                  if (resolvedPathHint) {
                    remoteResolvedPathByLookup.set(
                      remoteLookupKey(cwdTarget.host, cwdTarget.cwd, legacyInput.path),
                      resolvedPathHint,
                    );
                  }
                  return normalizeEditOutput({
                    success: false,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, legacyInput.path),
                    error: { code: "UNKNOWN", message: remoteError.message },
                  });
                }
                const remoteOutput = selectResultValue(remoteRes);

                if (remoteOutput.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: legacyInput.path,
                    resolvedPath: remoteOutput.resolvedPath,
                    fileHash: remoteOutput.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, legacyInput.path),
                    resolvedPathHint,
                  );
                }

                return normalizeEditOutput({
                  ...remoteOutput,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteOutput.resolvedPath),
                });
              }

              return normalizeEditOutput(
                await fileSystem.editFile({ ...editPayload, dangerouslyAllow }, opCwd),
              );
            })();

        return res;
      },
    }),
  };
}
