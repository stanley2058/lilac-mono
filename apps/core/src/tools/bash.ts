import { tool } from "ai";
import { z } from "zod";
import { executeBash } from "./bash-impl";

const bashInputSchema = z.object({
  command: z.string().describe("Bash command to execute"),
  cwd: z.string().optional().describe("Working directory (supports ~)"),
  timeoutMs: z.number().optional().describe("Timeout in ms (default: 1h)"),
  dangerouslyAllow: z
    .boolean()
    .optional()
    .describe("Bypass safety guardrails for this call"),
});

const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("blocked"),
    reason: z.string(),
    segment: z.string().optional(),
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
]);

const bashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  executionError: bashExecutionErrorSchema.optional(),
});

export function bashTool() {
  return {
    bash: tool({
      description:
        "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: executeBash,
    }),
  };
}
