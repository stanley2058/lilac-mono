import { z } from "zod";

import {
  jsonObjectSchema,
  workflowAgentProfileSchema,
  workflowOriginSessionSchema,
  workflowReasoningSchema,
} from "./workflow-domain";

const workflowResolvedModelRequestBaseShape = {
  alias: z.string().min(1).max(200).optional(),
  spec: z.string().min(1).max(500),
  provider: z.string().min(1).max(200),
  modelId: z.string().min(1).max(300),
  providerOptions: z.record(z.string(), jsonObjectSchema).optional(),
  reasoning: workflowReasoningSchema.optional(),
  responseCommentary: z.boolean().optional(),
  openaiServerCompaction: z.literal(true).optional(),
  anthropicPromptCache: z.boolean().optional(),
  reasoningDisplay: z.enum(["none", "simple", "detailed"]),
} as const;

function validateServerCompactionProvider(
  input: { provider: string; openaiServerCompaction?: true },
  context: z.RefinementCtx,
): void {
  if (input.openaiServerCompaction && input.provider !== "openai" && input.provider !== "codex") {
    context.addIssue({
      code: "custom",
      path: ["openaiServerCompaction"],
      message: "OpenAI server compaction requires an openai or codex provider",
    });
  }
}

const workflowResolvedModelRequestBaseSchema = z
  .strictObject(workflowResolvedModelRequestBaseShape)
  .superRefine(validateServerCompactionProvider);

export const workflowResolvedModelRequestSchema = z
  .strictObject({
    ...workflowResolvedModelRequestBaseShape,
    fallbacks: z.array(workflowResolvedModelRequestBaseSchema).optional(),
  })
  .superRefine(validateServerCompactionProvider);

export const workflowRequestPolicySchema = z.strictObject({
  runId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  dispatchEpoch: z.string().min(16).max(200),
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).nullable(),
  reasoning: workflowReasoningSchema.nullable(),
  /** Provider options the caller requested for `model`, before alias options were merged in. */
  options: jsonObjectSchema.optional(),
  resolvedModelRequest: workflowResolvedModelRequestSchema,
  cwd: z.string().min(1).max(4_096),
  originSession: workflowOriginSessionSchema,
  stableNamedContinuation: z
    .strictObject({
      sessionId: z.string().min(1).max(4_096),
      requestClient: z.enum([
        "discord",
        "github",
        "native",
        "whatsapp",
        "slack",
        "telegram",
        "web",
        "unknown",
      ]),
    })
    .optional(),
});

export type WorkflowRequestPolicy = z.infer<typeof workflowRequestPolicySchema>;

export function workflowRequestPolicyIdentityProjection(policy: WorkflowRequestPolicy) {
  const { fallbacks: _fallbacks, ...resolvedModelRequest } = policy.resolvedModelRequest;
  return {
    ...policy,
    resolvedModelRequest,
  };
}

export type AuthorizedWorkflowRequest = {
  requestId: string;
  sessionId: string;
  platform: string;
  policy: WorkflowRequestPolicy;
};
