import { tool } from "ai";
import { z } from "zod";
import { executeBash } from "./bash-impl";

export const bashInputSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory (supports ~). Also supports ssh-style '<host>:<path>' to run on a configured SSH host alias.",
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

const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("blocked"),
    reason: z.string(),
    segment: z.string().optional(),
  }),
  z.object({
    type: z.literal("aborted"),
    signal: z.string().optional(),
  }),
  z.object({
    type: z.literal("timeout"),
    timeoutMs: z.number(),
    signal: z.string(),
  }),
  z.object({
    type: z.literal("exception"),
    phase: z.enum(["spawn", "stdout", "stderr", "unknown"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("truncated"),
    message: z.string(),
    outputPath: z.string().optional(),
  }),
]);

const bashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  executionError: bashExecutionErrorSchema.optional(),
  truncation: z
    .object({
      outputPath: z.string(),
    })
    .optional(),
});

export function bashTool() {
  return {
    bash: tool({
      description:
        "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: (input, { experimental_context: context, abortSignal, toolCallId }) =>
        executeBash(input, {
          context,
          abortSignal,
          toolCallId,
        } as {
          context?: {
            requestId: string;
            sessionId: string;
            requestClient: string;
          };
          abortSignal?: AbortSignal;
          toolCallId?: string;
        }),
    }),
  };
}

export function bashToolWithCwd(defaultCwd: string) {
  return {
    bash: tool({
      description:
        "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: (input, { experimental_context: context, abortSignal, toolCallId }) =>
        executeBash({ ...input, cwd: input.cwd ?? defaultCwd }, {
          context,
          abortSignal,
          toolCallId,
        } as {
          context?: {
            requestId: string;
            sessionId: string;
            requestClient: string;
          };
          abortSignal?: AbortSignal;
          toolCallId?: string;
        }),
    }),
  };
}
