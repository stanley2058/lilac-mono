import type { CoreConfig, ResolvedNativeSubagentProfile } from "@stanley2058/lilac-utils";
import { bashInputSchema } from "@stanley2058/lilac-coding-tools/schemas";
import { tool } from "ai";
import { z } from "zod";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { executeBash } from "./bash-impl";
import { executeRestrictedBash } from "./restricted-bash";

export { bashInputSchema };

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
]);

const bashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  executionError: bashExecutionErrorSchema.optional(),
  truncation: z
    .object({
      artifactUri: z.string().optional(),
      message: z.string(),
      originalStdoutBytes: z.number(),
      originalStderrBytes: z.number(),
      previewBytes: z.number(),
      completeOutputRetained: z.boolean(),
    })
    .optional(),
});

export function bashTool() {
  return {
    bash: tool({
      description:
        "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true. When output is truncated, use read_file with truncation.artifactUri to inspect the complete transient result.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: (input, { context, abortSignal, toolCallId }) =>
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

export function bashToolWithCwd(
  defaultCwd: string,
  opts?: {
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
    onActivity?: () => void;
    controlCapability?: string;
    nativeProfile?: ResolvedNativeSubagentProfile;
  },
) {
  return {
    bash: tool({
      description:
        "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true. When output is truncated, use read_file with truncation.artifactUri to inspect the complete transient result.",
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: (input, { context, abortSignal, toolCallId }) => {
        const typedContext = context as
          | {
              requestId?: string;
              sessionId?: string;
              requestClient?: string;
              safetyMode?: "trusted" | "restricted";
            }
          | undefined;
        const suppliedCwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : undefined;
        const payload = { ...input, cwd: suppliedCwd ?? defaultCwd };
        if (typedContext?.safetyMode === "restricted") {
          return executeRestrictedBash(payload, {
            workspaceRoot: defaultCwd,
            context: {
              ...typedContext,
              controlCapability: opts?.controlCapability,
              workspaceWritable: opts?.nativeProfile?.workspaceWrites ?? true,
              subagentProfile: opts?.nativeProfile?.name,
            },
            abortSignal,
            toolCallId,
            artifacts: opts?.artifacts,
            outputConfig: opts?.outputConfig,
          });
        }
        return executeBash(payload, {
          context,
          abortSignal,
          toolCallId,
          artifacts: opts?.artifacts,
          outputConfig: opts?.outputConfig,
          onActivity: opts?.onActivity,
          controlCapability: opts?.controlCapability,
          subagentProfile: opts?.nativeProfile?.name,
        } as {
          context?: {
            requestId: string;
            sessionId: string;
            requestClient: string;
          };
          abortSignal?: AbortSignal;
          toolCallId?: string;
          artifacts?: ToolResultArtifactStore;
          outputConfig?: CoreConfig["tools"]["output"];
          onActivity?: () => void;
          controlCapability?: string;
          subagentProfile?: ResolvedNativeSubagentProfile["name"];
        });
      },
    }),
  };
}
