import { tool } from "ai";
import { z } from "zod";
import { executeBash } from "./bash-impl";

const bashInputSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

const bashExecutionErrorSchema = z.discriminatedUnion("type", [
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
      description: "Execute command in bash",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: executeBash,
    }),
  };
}
