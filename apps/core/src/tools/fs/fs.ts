import { tool } from "ai";
import { z } from "zod/v4";
import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import {
  EDIT_ERROR_CODES,
  READ_ERROR_CODES,
  WRITE_ERROR_CODES,
  FileSystem,
} from "./fs-impl";

const pathSchema = z
  .string()
  .describe(
    "Path to the file. Relative paths are resolved against the tool root; absolute paths are also supported.",
  );

const readErrorCodeSchema = z.enum(READ_ERROR_CODES);
const writeErrorCodeSchema = z.enum(WRITE_ERROR_CODES);
const editErrorCodeSchema = z.enum(EDIT_ERROR_CODES);

const writeFileInputZod = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to resolve relative paths against (supports ~). Defaults to the tool root.",
    ),
  content: z.string().describe("The content to write to the file"),
  overwrite: z
    .boolean()
    .optional()
    .describe("Whether to overwrite an existing file. Defaults to false."),
  expectedHash: z
    .string()
    .optional()
    .describe(
      "If provided, the write will be rejected unless the current file hash matches (optimistic concurrency). Use readFile.fileHash.",
    ),
  createParents: z
    .boolean()
    .optional()
    .describe("Whether to create parent directories. Defaults to true."),
});

type WriteFileInput = z.infer<typeof writeFileInputZod>;

const writeFileOutputZod = z.union([
  z.object({
    success: z.literal(true),
    resolvedPath: z.string(),
    created: z.boolean(),
    overwritten: z.boolean(),
    fileHash: z.string(),
  }),
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    currentHash: z.string().optional(),
    error: z.object({
      code: writeErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);

type WriteFileOutput = z.infer<typeof writeFileOutputZod>;

const readFileInputZod = z.object({
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

const readFileOutputZod = z.union([
  readFileSuccessBaseZod.extend({
    format: z.literal("raw"),
    content: z.string(),
  }),
  readFileSuccessBaseZod.extend({
    format: z.literal("numbered"),
    numberedContent: z.string(),
  }),
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

const editFileInputZod = z.object({
  path: pathSchema,
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to resolve relative paths against (supports ~). Defaults to the tool root.",
    ),
  expectedHash: z
    .string()
    .optional()
    .describe(
      "If provided, the edit will be rejected unless the current file hash matches (optimistic concurrency). Use readFile.fileHash.",
    ),
  edits: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("replace_range"),
        range: z
          .object({
            startLine: z.number(),
            endLine: z.number(),
          })
          .describe("Range to replace, 1-based, inclusive"),
        newText: z.string(),
        expectedOldText: z
          .string()
          .optional()
          .describe(
            "Optional safety check: exact text currently in the range. If provided and mismatched, the edit fails.",
          ),
      }),
      z.object({
        type: z.literal("insert_at"),
        line: z
          .number()
          .describe(
            "1-based line number. New text will be inserted before this line.",
          ),
        newText: z.string(),
      }),
      z.object({
        type: z.literal("delete_range"),
        range: z
          .object({
            startLine: z.number(),
            endLine: z.number(),
          })
          .describe("Range to delete, 1-based, inclusive"),
        expectedOldText: z
          .string()
          .optional()
          .describe(
            "Optional safety check: exact text currently in the range. If provided and mismatched, the edit fails.",
          ),
      }),
      z.object({
        type: z.literal("replace_snippet"),
        target: z
          .string()
          .describe(
            "Exact text to replace if matching='exact'; regex body if matching='regex'.",
          ),
        newText: z.string(),
        matching: z
          .enum(["exact", "regex"])
          .optional()
          .describe("Matching strategy. Defaults to 'exact'."),
        occurrence: z
          .union([z.literal("first"), z.literal("all"), z.number()])
          .optional()
          .describe(
            "Which occurrences to replace: 'first', 'all', or a number (replace up to N). Defaults to 'first'.",
          ),
        expectedMatches: z
          .union([z.literal("any"), z.number()])
          .optional()
          .describe(
            "How many matches must exist for the edit to proceed. Defaults to 1 (fails if 0 or >1 matches). Use 'any' to allow multiple.",
          ),
      }),
    ]),
  ),
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
    errors: z
      .array(
        z.object({
          code: editErrorCodeSchema,
          message: z.string(),
          editIndex: z.number(),
          edit: z.unknown(),
        }),
      )
      .optional(),
  }),
]);

type EditFileOutput = z.infer<typeof editFileOutputZod>;

export function fsTool(cwd: string) {
  const logger = new Logger({
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    module: "tool:fs",
  });

  const fs = new FileSystem(cwd);

  return {
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: [
        "Writes a file to the filesystem (auto creates directories).",
        "By default it will NOT overwrite existing files; set overwrite=true to overwrite.",
      ].join("\n"),
      inputSchema: writeFileInputZod,
      outputSchema: writeFileOutputZod,
      execute: async ({ cwd: opCwd, ...input }) => {
        logger.info("fs.writeFile", {
          path: input.path,
          cwd: opCwd,
          overwrite: input.overwrite ?? false,
        });

        const res = await fs.writeFile(input, opCwd);

        logger.info("fs.writeFile done", {
          path: res.resolvedPath,
          ok: res.success,
          created: res.success ? res.created : undefined,
          overwritten: res.success ? res.overwritten : undefined,
          error: res.success ? undefined : res.error,
        });

        return res;
      },
    }),

    readFile: tool<ReadFileInput, ReadFileOutput>({
      description:
        "Reads a file from the filesystem. Default format is raw (no line numbers) to preserve indentation.",
      inputSchema: readFileInputZod,
      outputSchema: readFileOutputZod,
      execute: async ({ cwd: opCwd, ...input }) => {
        logger.info("fs.readFile", {
          path: input.path,
          cwd: opCwd,
        });

        const res = await fs.readFile(input, opCwd);

        logger.info("fs.readFile done", {
          path: res.resolvedPath,
          ok: res.success,
          error: res.success ? undefined : res.error,
        });

        return res;
      },
    }),

    editFile: tool<EditFileInput, EditFileOutput>({
      description: [
        "Edits a file.",
        "- Edits are atomic: if any edit fails, nothing is written.",
        "- You must read the file first (readFile) or provide expectedHash.",
        "- All line numbers are 1-based.",
      ].join("\n"),
      inputSchema: editFileInputZod,
      outputSchema: editFileOutputZod,
      execute: async ({ cwd: opCwd, ...input }) => {
        logger.info("fs.editFile", {
          path: input.path,
          cwd: opCwd,
          operations: input.edits.map((e) => e.type),
        });

        const res = await fs.editFile(input, opCwd);

        logger.info("fs.editFile done", {
          path: res.resolvedPath,
          ok: res.success,
          changesMade: res.success ? res.changesMade : undefined,
          replacementsMade: res.success ? res.replacementsMade : undefined,
          error: res.success ? undefined : res.error,
        });

        return res;
      },
    }),
  };
}
