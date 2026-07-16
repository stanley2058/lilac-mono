import type { CoreConfig, ResolvedNativeSubagentProfile } from "@stanley2058/lilac-utils";
import { tool } from "ai";
import { z } from "zod";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import type { WorkflowRequestPolicy } from "../workflow/workflow-request-authority";
import { executeBash } from "./bash-impl";
import {
  executeRestrictedBash,
  executeTrustedWorkflowBash,
  type TrustedWorkflowBashRuntime,
} from "./restricted-bash";

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
    workflowPolicy?: WorkflowRequestPolicy;
    workflowControlToken?: string;
    controlCapability?: string;
    trustedWorkflowRuntime?: TrustedWorkflowBashRuntime;
    nativeProfile?: ResolvedNativeSubagentProfile;
    scratchRoot?: string;
  },
) {
  const workflow = opts?.workflowPolicy !== undefined;
  return {
    bash: tool({
      description: workflow || opts?.nativeProfile
        ? "Execute installed local commands in a secret-free sandbox rooted at the operation cwd. Network follows the native subagent profile. The complete process tree is cancellable, time-bounded, cgrouped, and output-bounded."
        : "Execute command in bash. Safety guardrails may block destructive commands unless dangerouslyAllow=true. When output is truncated, use read_file with truncation.artifactUri to inspect the complete transient result.",
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
        const workflowRequestedCwd = opts?.workflowPolicy?.canonicalCwd;
        const workflowAuthorityRoot = opts?.workflowPolicy?.canonicalAuthorityRoot;
        const suppliedCwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : undefined;
        const payload = { ...input, cwd: suppliedCwd ?? workflowRequestedCwd ?? defaultCwd };
        if (
          typedContext?.safetyMode === "restricted" ||
          opts?.workflowPolicy?.safetyMode === "restricted"
        ) {
          return executeRestrictedBash(payload, {
            workspaceRoot: workflowAuthorityRoot ?? defaultCwd,
            context: {
              ...typedContext,
              workflowControlToken: opts?.workflowControlToken,
              controlCapability: opts?.controlCapability,
              workspaceWritable:
                opts?.nativeProfile?.workspaceWrites ?? opts?.workflowPolicy?.profile !== "explore",
              subagentProfile: opts?.nativeProfile?.name,
            },
            abortSignal,
            toolCallId,
            artifacts: opts?.artifacts,
            outputConfig: opts?.outputConfig,
          });
        }
        if (opts?.workflowPolicy || opts?.nativeProfile) {
          return executeTrustedWorkflowBash(payload, {
            workspaceRoot:
              opts.workflowPolicy?.isolation === "worktree"
                ? opts.workflowPolicy.canonicalCwd
                : (opts.workflowPolicy?.canonicalAuthorityRoot ?? defaultCwd),
            workspaceWritable:
              opts.nativeProfile?.workspaceWrites ?? opts.workflowPolicy?.profile !== "explore",
            networkEnabled: opts.nativeProfile?.network ?? false,
            workspaceIdentity:
              opts.workflowPolicy?.isolation === "worktree"
                ? opts.workflowPolicy.canonicalCwdIdentity
                : opts.workflowPolicy?.canonicalAuthorityRootIdentity,
            cwdIdentity: suppliedCwd ? undefined : opts.workflowPolicy?.canonicalCwdIdentity,
            scratchRoot: opts.workflowPolicy?.canonicalScratchRoot ?? opts.scratchRoot,
            context: {
              ...typedContext,
              workflowControlToken: opts?.workflowControlToken,
              subagentProfile: opts?.nativeProfile?.name,
            },
            abortSignal,
            toolCallId,
            artifacts: opts.artifacts,
            outputConfig: opts.outputConfig,
            onActivity: opts.onActivity,
            runtime: opts.trustedWorkflowRuntime,
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
        });
      },
    }),
  };
}
