import path from "node:path";

import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  jsonObjectSchema,
  workflowAgentProfileSchema,
  workflowReasoningSchema,
} from "./workflow-domain";

export const workflowRequestedAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
  /** Provider options for the selected model's provider, such as `{ speed: "fast" }`. */
  options: jsonObjectSchema.optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  label: z.string().min(1).max(500).optional(),
});

const requestedAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: workflowRequestedAgentOptionsSchema,
});

export const resolvedWorkflowAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
  options: jsonObjectSchema.optional(),
  cwd: z.string().min(1).max(4_096),
  label: z.string().min(1).max(500).optional(),
});

export const resolvedWorkflowAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: resolvedWorkflowAgentOptionsSchema,
});

export type ResolvedWorkflowAgentInput = z.infer<typeof resolvedWorkflowAgentInputSchema>;

export const REMOVED_AGENT_OPTIONS = [
  "editing",
  "tools",
  "executables",
  "level2Callables",
  "surfaceOriginOperations",
  "delegation",
  "isolation",
] as const;

export const workflowPipelineOptionsSchema = z.strictObject({
  concurrency: z.number().int().positive().max(64).optional(),
});

export const workflowWaitForReplyOptionsSchema = z.strictObject({
  prompt: z.string().min(1).max(2_000).optional(),
  platform: z.literal("discord").optional(),
  channelId: z.string().min(1).max(200).optional(),
  messageId: z.string().min(1).max(200).optional(),
  fromUserId: z.string().min(1).max(200).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60 * 1_000)
    .optional(),
});

export class WorkflowAgentOperationInputInvalid extends TaggedError(
  "WorkflowAgentOperationInputInvalid",
)<{
  readonly message: string;
}> {}

export function resolveWorkflowAgentOperationInputResult(input: {
  value: unknown;
  canonicalWorkspaceRoot: string;
}): ResultType<ResolvedWorkflowAgentInput, WorkflowAgentOperationInputInvalid> {
  const rawInput = z.record(z.string(), z.unknown()).safeParse(input.value);
  const rawOptions = rawInput.success
    ? z.record(z.string(), z.unknown()).safeParse(rawInput.data["options"])
    : null;
  if (rawOptions?.success) {
    const removed = REMOVED_AGENT_OPTIONS.find((field) => field in rawOptions.data);
    if (removed) {
      return Result.err(
        new WorkflowAgentOperationInputInvalid({
          message: `Workflow agent option '${removed}' was removed; migrate to profile-native agent() options`,
        }),
      );
    }
  }
  const parsed = requestedAgentInputSchema.safeParse(input.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return Result.err(
      new WorkflowAgentOperationInputInvalid({
        message: `${location}${issue?.message ?? "Workflow agent operation input is invalid"}`,
      }),
    );
  }
  const requestedCwd = parsed.data.options.cwd ?? input.canonicalWorkspaceRoot;
  const cwd = path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd)
    : path.resolve(input.canonicalWorkspaceRoot, requestedCwd);
  const resolved = resolvedWorkflowAgentInputSchema.safeParse({
    prompt: parsed.data.prompt,
    options: {
      profile: parsed.data.options.profile,
      ...(parsed.data.options.model ? { model: parsed.data.options.model } : {}),
      ...(parsed.data.options.reasoning ? { reasoning: parsed.data.options.reasoning } : {}),
      ...(parsed.data.options.options ? { options: parsed.data.options.options } : {}),
      cwd,
      ...(parsed.data.options.label ? { label: parsed.data.options.label } : {}),
    },
  });
  if (!resolved.success) {
    return Result.err(
      new WorkflowAgentOperationInputInvalid({
        message: resolved.error.issues[0]?.message ?? "Workflow agent operation input is invalid",
      }),
    );
  }
  return Result.ok(resolved.data);
}
