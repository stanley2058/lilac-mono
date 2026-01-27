import { tool } from "ai";
import { z } from "zod/v4";
import { Logger, type LogLevel } from "@stanley2058/simple-module-logger";
import { READ_ERROR_CODES, FileSystem } from "./fs-impl";

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

export function fsTool(cwd: string) {
  const logger = new Logger({
    logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    module: "tool:fs",
  });

  const fs = new FileSystem(cwd);

  return {
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
  };
}
