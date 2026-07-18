import path from "node:path";

import { z } from "zod";

import { workflowAgentProfileSchema, workflowReasoningSchema } from "./workflow-domain";

export const workflowRequestedAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
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

export async function resolveWorkflowAgentOperationInput(input: {
  value: unknown;
  canonicalWorkspaceRoot: string;
}): Promise<ResolvedWorkflowAgentInput> {
  const rawInput = z.record(z.string(), z.unknown()).safeParse(input.value);
  const rawOptions = rawInput.success
    ? z.record(z.string(), z.unknown()).safeParse(rawInput.data["options"])
    : null;
  if (rawOptions?.success) {
    const removed = REMOVED_AGENT_OPTIONS.find((field) => field in rawOptions.data);
    if (removed) {
      throw new Error(
        `Workflow agent option '${removed}' was removed; migrate to profile-native agent() options`,
      );
    }
  }
  const parsed = requestedAgentInputSchema.parse(input.value);
  const requestedCwd = parsed.options.cwd ?? input.canonicalWorkspaceRoot;
  const cwd = path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd)
    : path.resolve(input.canonicalWorkspaceRoot, requestedCwd);
  return resolvedWorkflowAgentInputSchema.parse({
    prompt: parsed.prompt,
    options: {
      profile: parsed.options.profile,
      ...(parsed.options.model ? { model: parsed.options.model } : {}),
      ...(parsed.options.reasoning ? { reasoning: parsed.options.reasoning } : {}),
      cwd,
      ...(parsed.options.label ? { label: parsed.options.label } : {}),
    },
  });
}
