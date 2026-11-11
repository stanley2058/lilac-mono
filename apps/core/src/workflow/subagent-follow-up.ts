import type { ModelReasoningEffort } from "@stanley2058/lilac-utils";

import { getBuiltinSurfaceProtocol } from "../surface/builtin-surface-protocols";
import {
  buildSubagentDelegationRegistration,
  type TrustedSubagentDelegationRegistration,
} from "../tools/subagent";
import type { WorkflowRevision, WorkflowRun } from "./workflow-domain";
import type { WorkflowRequestPolicy } from "./workflow-request-authority";

/**
 * Builds a deferred follow-up for a subagent from its own durable records, keeping its profile,
 * model, and reasoning, and reporting to the request and tool call that sent the message. The
 * runner uses it to deliver an automatic steer that missed the child's run.
 */
export function subagentFollowUpRegistration(input: {
  readonly run: WorkflowRun;
  readonly revision: WorkflowRevision;
  readonly policy: WorkflowRequestPolicy | null;
  readonly task: string;
  readonly idleTimeoutMs: number;
  /** The request and tool call that sent the message, in the same parent session. */
  readonly sender: { readonly parentRequestId: string; readonly parentToolCallId: string };
}): TrustedSubagentDelegationRegistration | null {
  const target = input.run.completionTarget;
  if (target.kind !== "live_parent") return null;
  const origin = input.run.origin;
  const protocol =
    origin.userId && origin.client ? getBuiltinSurfaceProtocol(origin.client) : undefined;
  // A heartbeat-launched child has no surface principal, which the dispatcher records as null.
  const fallbackSurface =
    protocol && origin.userId && origin.sessionId
      ? { platform: protocol.platform, sessionId: origin.sessionId, userId: origin.userId }
      : null;
  const reasoning: ModelReasoningEffort | undefined =
    input.policy?.reasoning ?? target.reasoning ?? undefined;
  const registration = buildSubagentDelegationRegistration({
    ctx: {
      requestId: input.sender.parentRequestId,
      sessionId: target.parentSessionId,
      requestClient: target.parentRequestClient,
    },
    toolCallId: input.sender.parentToolCallId,
    mode: "deferred",
    profile: target.profile,
    sessionName: target.sessionName,
    task: input.task,
    ...(target.title ? { title: target.title } : {}),
    idleTimeoutMs: input.idleTimeoutMs,
    depth: target.depth,
    ...(input.policy?.model ? { modelOverride: input.policy.model } : {}),
    ...(reasoning ? { reasoningOverride: reasoning } : {}),
  });
  // The follow-up must continue the same child conversation the steer was meant for.
  if (registration.childSessionId !== target.childSessionId) return null;
  return {
    ...registration,
    projectRoot: input.revision.canonicalWorkspaceRoot,
    fallbackSurface,
  };
}
