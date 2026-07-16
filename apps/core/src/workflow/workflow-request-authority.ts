import { z } from "zod";

import {
  jsonObjectSchema,
  workflowAgentProfileSchema,
  workflowReasoningSchema,
  workflowSafetyModeSchema,
} from "./workflow-domain";
import { workflowPathIdentitySchema } from "./workflow-descriptor-path";

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
  resolvedModel: z.string().min(1).max(500),
  resolvedReasoning: workflowReasoningSchema.nullable(),
  resolvedModelRequest: workflowResolvedModelRequestSchema,
  safetyMode: workflowSafetyModeSchema,
  isolation: z.enum(["shared", "worktree"]),
  canonicalWorkspaceRoot: z.string().min(1).max(4_096),
  canonicalAuthorityRoot: z.string().min(1).max(4_096),
  canonicalAuthorityRootIdentity: workflowPathIdentitySchema,
  canonicalRequestedCwd: z.string().min(1).max(4_096),
  canonicalRequestedCwdIdentity: workflowPathIdentitySchema,
  canonicalCwd: z.string().min(1).max(4_096),
  canonicalCwdIdentity: workflowPathIdentitySchema,
  canonicalScratchRoot: z.string().min(1).max(4_096),
  canonicalProjectId: z.string().min(1).max(200),
  originSessionId: z.string().min(1).max(200).nullable(),
  originClient: z.enum(["discord", "github"]).nullable(),
  originUserId: z.string().min(1).max(200).nullable(),
  revisionId: z.string().min(1).max(200),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  argsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operationInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type WorkflowRequestPolicy = z.infer<typeof workflowRequestPolicySchema>;

export type AuthorizedWorkflowRequest = {
  requestId: string;
  sessionId: string;
  platform: string;
  policy: WorkflowRequestPolicy;
  expiresAt: number;
};
