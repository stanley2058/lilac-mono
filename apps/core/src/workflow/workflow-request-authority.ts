import { z } from "zod";

import {
  jsonObjectSchema,
  workflowAgentProfileSchema,
  workflowOriginSessionSchema,
  workflowReasoningSchema,
} from "./workflow-domain";

export const workflowResolvedModelRequestSchema = z.strictObject({
  alias: z.string().min(1).max(200).optional(),
  spec: z.string().min(1).max(500),
  provider: z.string().min(1).max(200),
  modelId: z.string().min(1).max(300),
  providerOptions: z.record(z.string(), jsonObjectSchema).optional(),
  reasoning: workflowReasoningSchema.optional(),
  responseCommentary: z.boolean().optional(),
  anthropicPromptCache: z.boolean().optional(),
  reasoningDisplay: z.enum(["none", "simple", "detailed"]),
});

export const workflowRequestPolicySchema = z.strictObject({
  runId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  dispatchEpoch: z.string().min(16).max(200),
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).nullable(),
  reasoning: workflowReasoningSchema.nullable(),
  resolvedModelRequest: workflowResolvedModelRequestSchema,
  cwd: z.string().min(1).max(4_096),
  originSession: workflowOriginSessionSchema,
});

export type WorkflowRequestPolicy = z.infer<typeof workflowRequestPolicySchema>;

export type AuthorizedWorkflowRequest = {
  requestId: string;
  sessionId: string;
  platform: string;
  policy: WorkflowRequestPolicy;
};
