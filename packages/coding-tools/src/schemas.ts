import { z } from "zod";

export const LEVEL1_TOOL_NAMES = [
  "bash",
  "read_file",
  "glob",
  "grep",
  "fuzzy_search",
  "edit_file",
  "apply_patch",
  "subagent_delegate",
  "batch",
] as const;

export type Level1ToolName = (typeof LEVEL1_TOOL_NAMES)[number];

export const bashInputSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured.",
    ),
  timeoutMs: z.number().optional().describe("Timeout in ms (default: 1h)"),
  stdinMode: z
    .enum(["error", "eof"])
    .optional()
    .describe(
      "stdin handling mode: 'error' (default, recommended) makes inherited stdin reads fail immediately (EBADF); use 'eof' only as a fallback if the command fails specifically due to this strict stdin mode.",
    ),
  dangerouslyAllow: z.boolean().optional().describe("Bypass safety guardrails for this call"),
});

export type BashInput = z.infer<typeof bashInputSchema>;

const pathSchema = z
  .string()
  .describe(
    "Path to the file. Relative paths are resolved against the tool root; absolute paths are also supported.",
  );

const readStartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offset"), offset: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("line"),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative().optional(),
  }),
]);

export function createReadFileInputSchema(options?: {
  hashlineEnabled?: boolean;
  directAttachmentSupported?: boolean;
}) {
  const hashlineEnabled = options?.hashlineEnabled === true;
  return z.object({
    path: pathSchema.describe(
      options?.directAttachmentSupported
        ? "Path to a file. Supported images and PDFs are attached to your context for native visual or document analysis. Relative paths are resolved against the tool root; absolute paths are also supported."
        : "Path to the file. Relative paths are resolved against the tool root; absolute paths are also supported.",
    ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Optional working directory to resolve relative paths against (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured. Defaults to the tool root.",
      ),
    start: readStartSchema
      .optional()
      .describe(
        "Text files only. Start or continuation position. Use {type:'offset',offset:N} for an absolute Unicode character position, or {type:'line',line:N,column?:N} for a line position. Lines are 1-based; offsets and columns are 0-based.",
      ),
    maxLines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Text files only. Maximum number of lines to return. Defaults to 2000."),
    maxCharacters: z
      .number()
      .int()
      .positive()
      .max(40 * 1024)
      .optional()
      .describe(
        "Text files only. Maximum number of characters to return (max: 40960). Defaults to 10000.",
      ),
    format: (hashlineEnabled
      ? z.enum(["raw", "numbered", "hashline"])
      : z.enum(["raw", "numbered"])
    )
      .optional()
      .describe(
        hashlineEnabled
          ? "Text files only. Output format. Default is raw. Use 'hashline' before edit_file when you need stable edit anchors."
          : "Text files only. Output format. Default is raw (no line numbers). 'numbered' is for display only.",
      ),
    dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
  });
}

export const readFileInputSchema = createReadFileInputSchema();

export const globInputSchema = z.object({
  patterns: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe("Glob patterns (supports include + negate patterns)"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional base directory to search from (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured. Defaults to the tool root.",
    ),
  maxEntries: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum number of matched paths to return (default: 100)."),
  mode: z
    .enum(["default", "detailed"])
    .optional()
    .describe(
      "Output mode. Recommended: 'default'. Use 'detailed' only when you need file type/size metadata.",
    ),
  dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
});

export const fuzzySearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Approximate filename/path query. Use this for fuzzy path discovery, not file content search.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional base directory to search from (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured.",
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Maximum number of ranked files to return (default: 50)."),
  dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
});

export function createGrepInputSchema(hashlineEnabled = false) {
  return z.object({
    pattern: z.string().min(1).describe("Search pattern. Literal by default unless regex=true."),
    cwd: z
      .string()
      .optional()
      .describe(
        "Optional base directory to search from (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured. Defaults to the tool root.",
      ),
    regex: z
      .boolean()
      .optional()
      .describe("Treat pattern as regex when true. Default is false (literal)."),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .optional()
      .describe("Maximum number of matches to return (default: 100)."),
    fileExtensions: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe('Optional file extension filters (e.g. ["ts", "tsx"]).'),
    includeContextLines: z
      .number()
      .int()
      .nonnegative()
      .max(100)
      .optional()
      .describe("Include N context lines around each match."),
    mode: (hashlineEnabled
      ? z.enum(["default", "detailed", "hashline"])
      : z.enum(["default", "detailed"])
    )
      .optional()
      .describe(
        hashlineEnabled
          ? "Output mode. Recommended: 'default'. Use 'hashline' when you want grep output that can be turned into edit anchors. Use 'detailed' only when you need column/submatches metadata."
          : "Output mode. Recommended: 'default'. Use 'detailed' only when you need column/submatches metadata.",
      ),
    dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
  });
}

export const grepInputSchema = createGrepInputSchema();

const expectedMatchesSchema = z.union([z.literal("any"), z.number().int().positive()]);

const hashlineEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    pos: z
      .string()
      .min(1)
      .describe("Starting hashline anchor from read_file/grep hashline output."),
    end: z
      .string()
      .min(1)
      .optional()
      .describe("Optional ending hashline anchor for multi-line replace."),
    lines: z
      .union([z.string(), z.array(z.string()), z.null()])
      .optional()
      .describe("Replacement lines. Prefer an array of lines; null or [] deletes the range."),
  }),
  z.object({
    op: z.literal("append"),
    pos: z.string().min(1).describe("Hashline anchor after which to insert."),
    lines: z
      .union([z.string(), z.array(z.string()), z.null()])
      .optional()
      .describe("Lines to insert after the anchor."),
  }),
  z.object({
    op: z.literal("prepend"),
    pos: z.string().min(1).describe("Hashline anchor before which to insert."),
    lines: z
      .union([z.string(), z.array(z.string()), z.null()])
      .optional()
      .describe("Lines to insert before the anchor."),
  }),
]);

const hashlineEditFileInputSchema = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured.",
    ),
  edits: z.array(hashlineEditSchema).min(1).describe("Batch all edits for the file into one call."),
  expectedHash: z
    .string()
    .optional()
    .describe(
      "Optional optimistic concurrency hash from read_file. If omitted, edit_file requires a prior read in the same tool session.",
    ),
  dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
});

const legacyEditFileInputSchema = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory (supports ~). Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured.",
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
  dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
});

export function createEditFileInputSchema(
  hashlineEnabled: true,
): typeof hashlineEditFileInputSchema;
export function createEditFileInputSchema(
  hashlineEnabled?: false,
): typeof legacyEditFileInputSchema;
export function createEditFileInputSchema(
  hashlineEnabled: boolean,
): typeof hashlineEditFileInputSchema | typeof legacyEditFileInputSchema;
export function createEditFileInputSchema(hashlineEnabled = false) {
  return hashlineEnabled ? hashlineEditFileInputSchema : legacyEditFileInputSchema;
}

export const editFileInputSchema = legacyEditFileInputSchema;

export const applyPatchInputSchema = z.object({
  patchText: z
    .string()
    .describe("Patch text in the '*** Begin Patch' format (Add/Update/Delete File sections)"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional base directory for relative patch paths. Also supports ssh-style '<host>:<path>' when the runtime adapter has SSH configured.",
    ),
  dangerouslyAllow: z.boolean().optional().describe("Bypass filesystem denylist guardrails."),
});

export const subagentProfileSchema = z.enum(["explore", "general", "self"]);
export const subagentModeSchema = z.enum(["deferred", "sync"]);
export const subagentSessionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "sessionName must be a short slug");

export const subagentDelegateBaseInputSchema = z.object({
  profile: subagentProfileSchema
    .default("explore")
    .describe("Subagent profile to run (explore, general, self)."),
  task: z.string().min(1).describe("Objective for the subagent."),
  mode: subagentModeSchema
    .default("deferred")
    .describe(
      "Delegation mode. Use deferred by default for parallelizable work; use sync only when the child result is immediately required before any meaningful next step.",
    ),
  sessionName: subagentSessionNameSchema
    .optional()
    .describe(
      "Optional stable short slug for continuing a subagent session within this parent session/channel. When omitted, a reusable short name is generated and returned.",
    ),
});

export const subagentTerminalStatusSchema = z.enum(["resolved", "failed", "cancelled", "timeout"]);

export const subagentDelegateOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    ok: z.literal(true),
    mode: z.literal("deferred"),
    status: z.literal("accepted"),
    workflowRunId: z.string().min(1),
    profile: subagentProfileSchema,
    sessionName: subagentSessionNameSchema,
  }),
  z.object({
    ok: z.boolean(),
    mode: z.literal("sync"),
    status: subagentTerminalStatusSchema,
    workflowRunId: z.string().min(1),
    profile: subagentProfileSchema,
    sessionName: subagentSessionNameSchema,
    finalText: z.string(),
    detail: z.string().optional(),
  }),
]);

export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type GlobInput = z.infer<typeof globInputSchema>;
export type GrepInput = z.infer<typeof grepInputSchema>;
export type FuzzySearchInput = z.infer<typeof fuzzySearchInputSchema>;
export type EditFileInput = z.infer<typeof editFileInputSchema>;
export type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;
export type SubagentDelegateOutput = z.output<typeof subagentDelegateOutputSchema>;
export type SubagentProfile = z.infer<typeof subagentProfileSchema>;
export type SubagentMode = z.infer<typeof subagentModeSchema>;
