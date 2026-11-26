import type { CoreConfig, ResolvedSubagentPermissionProfile } from "@stanley2058/lilac-utils";
import { bashInputSchema } from "@stanley2058/lilac-coding-tools/schemas";
import { tool } from "ai";
import { z } from "zod";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import {
  bashBackgroundInputSchema,
  describeBashBackground,
  startBackgroundBash,
  type BashBackgroundFields,
  type BashBackgroundOptions,
} from "./bash-background";
import { executeBash, type BashToolInput } from "./bash-impl";
import { jobSummarySchema } from "./job";
import { executeRestrictedBash } from "./restricted-bash";

export { bashInputSchema };

const bashExecutionErrorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("blocked"),
    code: z.enum([
      "dangerous_git_operation",
      "delete_current_cwd",
      "delete_outside_cwd",
      "delete_root_or_home",
      "device_format",
      "device_write",
      "dynamic_recursive_delete",
      "find_delete",
      "interpreter_one_liner",
      "paranoid_recursive_delete",
      "protected_git_metadata",
      "protected_path",
      "restricted_cwd",
      "shred",
    ]),
    reason: z.string(),
    hint: z.string().optional(),
    segment: z.string().optional(),
  }),
  z.object({
    type: z.literal("aborted"),
    code: z.literal("execution_cancelled"),
    signal: z.string().optional(),
  }),
  z.object({
    type: z.literal("timeout"),
    code: z.enum(["no_output_timeout", "wall_clock_timeout"]),
    timeoutMs: z.number(),
    timeoutKind: z.enum(["no_output", "wall_clock"]),
    signal: z.string(),
  }),
  z.object({
    type: z.literal("exception"),
    code: z.enum([
      "cleanup_failed",
      "execution_failed",
      "exit_status_read_failed",
      "spawn_cwd_missing",
      "spawn_failed",
      "stderr_read_failed",
      "stdout_read_failed",
    ]),
    phase: z.enum(["spawn", "stdout", "stderr", "unknown"]),
    message: z.string(),
    errno: z.enum(["EACCES", "ENOENT", "ENOTDIR", "EPERM"]).optional(),
    cwd: z.string().optional(),
  }),
]);

export const bashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  executionError: bashExecutionErrorSchema.optional(),
  job: jobSummarySchema.optional(),
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
        "Execute command in bash. Commands are terminated after 3 minutes without stdout or stderr; timeoutMs optionally adds an independent wall-clock deadline. Safety guardrails may block destructive commands unless dangerouslyAllow=true. When output is truncated, use read with truncation.artifactUri to inspect the complete transient result.",
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
            requestDeliveryId?: string;
            sessionId: string;
            requestClient: string;
            currentTurnUserId?: string;
          };
          abortSignal?: AbortSignal;
          toolCallId?: string;
        }),
    }),
  };
}

const BASH_DESCRIPTION =
  "Execute command in bash. Commands are terminated after 3 minutes without stdout or stderr; timeoutMs optionally adds an independent wall-clock deadline. Safety guardrails may block destructive commands unless dangerouslyAllow=true. When output is truncated, use read with truncation.artifactUri to inspect the complete transient result.";

type BashRequestContext = {
  requestId?: string;
  requestDeliveryId?: string;
  sessionId?: string;
  requestClient?: string;
  safetyMode?: "trusted" | "restricted";
  currentTurnUserId?: string;
};

export function bashToolWithCwd(
  defaultCwd: string,
  opts?: {
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
    onActivity?: () => void;
    controlCapability?: string;
    nativeProfile?: ResolvedSubagentPermissionProfile;
    background?: BashBackgroundOptions;
  },
) {
  const execute = (
    input: BashToolInput & BashBackgroundFields,
    {
      context,
      abortSignal,
      toolCallId,
    }: { context?: BashRequestContext; abortSignal?: AbortSignal; toolCallId: string },
  ) => {
    const { background, label, ...bashInput } = input;
    const suppliedCwd =
      "cwd" in bashInput && typeof bashInput.cwd === "string" ? bashInput.cwd : undefined;
    const payload = { ...bashInput, cwd: suppliedCwd ?? defaultCwd };
    const restricted =
      context?.safetyMode === "restricted" || opts?.nativeProfile?.execution === "restricted";
    const restrictedContext = {
      ...context,
      controlCapability: opts?.controlCapability,
      workspaceWritable: opts?.nativeProfile?.workspaceWrites ?? true,
      subagentProfile: opts?.nativeProfile?.name,
    };
    if (background && opts?.background) {
      return startBackgroundBash({
        args: { ...payload, background, ...(label === undefined ? {} : { label }) },
        options: opts.background,
        context,
        toolCallId,
        ...(opts.controlCapability ? { controlCapability: opts.controlCapability } : {}),
        ...(restricted
          ? { restricted: { workspaceRoot: defaultCwd, context: restrictedContext } }
          : {}),
      });
    }
    if (restricted) {
      return executeRestrictedBash(payload, {
        workspaceRoot: defaultCwd,
        context: restrictedContext,
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
        requestDeliveryId?: string;
        sessionId: string;
        requestClient: string;
        currentTurnUserId?: string;
      };
      abortSignal?: AbortSignal;
      toolCallId?: string;
      artifacts?: ToolResultArtifactStore;
      outputConfig?: CoreConfig["tools"]["output"];
      onActivity?: () => void;
      controlCapability?: string;
      subagentProfile?: string;
    });
  };

  if (opts?.background) {
    return {
      bash: tool({
        description: BASH_DESCRIPTION + describeBashBackground(opts.background),
        inputSchema: bashBackgroundInputSchema(opts.background.modes),
        outputSchema: bashOutputSchema,
        execute: (input, { context, abortSignal, toolCallId }) =>
          execute(input, {
            context: context as BashRequestContext | undefined,
            abortSignal,
            toolCallId,
          }),
      }),
    };
  }
  return {
    bash: tool({
      description: BASH_DESCRIPTION,
      inputSchema: bashInputSchema,
      outputSchema: bashOutputSchema,
      execute: (input, { context, abortSignal, toolCallId }) =>
        execute(input, {
          context: context as BashRequestContext | undefined,
          abortSignal,
          toolCallId,
        }),
    }),
  };
}
