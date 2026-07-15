import { z } from "zod";

import { workflowAgentProfileSchema, workflowSafetyModeSchema } from "./workflow-domain";

export const workflowRequestPolicySchema = z.strictObject({
  runId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  dispatchEpoch: z.string().min(16).max(200),
  profile: workflowAgentProfileSchema,
  safetyMode: workflowSafetyModeSchema,
  editing: z.boolean(),
  isolation: z.enum(["shared", "worktree"]),
  externalTools: z.boolean(),
  surfaceSends: z.boolean(),
  subagents: z.boolean(),
  canonicalWorkspaceRoot: z.string().min(1).max(4_096),
  canonicalCwd: z.string().min(1).max(4_096),
  canonicalProjectId: z.string().min(1).max(200),
  originSessionId: z.string().min(1).max(200).nullable(),
  originClient: z.enum(["discord", "github"]).nullable(),
  revisionId: z.string().min(1).max(200),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inputSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  capabilitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  argsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type WorkflowRequestPolicy = z.infer<typeof workflowRequestPolicySchema>;

export type AuthorizedWorkflowRequest = {
  requestId: string;
  sessionId: string;
  platform: string;
  policy: WorkflowRequestPolicy;
  expiresAt: number;
};
