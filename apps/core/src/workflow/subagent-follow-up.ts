import {
  modelSelectionProvider,
  modelSelectionSpec,
  providerOptionsNamespace,
  type CoreConfig,
  type JSONObject,
  type ModelReasoningEffort,
} from "@stanley2058/lilac-utils";

import { getBuiltinSurfaceProtocol } from "../surface/builtin-surface-protocols";
import {
  buildSubagentDelegationRegistration,
  type TrustedSubagentDelegationRegistration,
} from "../tools/subagent";
import type { WorkflowRevision, WorkflowRun } from "./workflow-domain";
import type { WorkflowRequestPolicy } from "./workflow-request-authority";

/** Model settings a sender may change for a subagent's next run. */
export type SubagentRunSettings = {
  readonly model?: string;
  readonly reasoning?: ModelReasoningEffort;
  readonly options?: JSONObject;
};

/**
 * The model settings of a subagent's next run. Omitted settings carry over from its last run:
 * the model always, reasoning while the model stays the same, and provider options while the
 * provider's option namespace stays the same. Sent options replace the earlier ones; `{}` clears
 * them.
 */
export function followUpRunSettings(input: {
  readonly policy: WorkflowRequestPolicy | null;
  readonly targetReasoning: ModelReasoningEffort | null;
  readonly requested?: SubagentRunSettings;
  /** Resolves the provider the next run's model maps to now, which may differ after a restart. */
  readonly config: CoreConfig;
}): {
  modelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  providerOptionsOverride?: JSONObject;
} {
  const { policy, requested, config } = input;
  const previousModel = policy?.model ?? undefined;
  const previous = policy?.resolvedModelRequest;
  // `read` shows the resolved spec. Naming it, or the alias, keeps the previous selection while it
  // still resolves there, because v2 configs accept only aliases for subagents.
  const namesPrevious = requested?.model === previous?.spec || requested?.model === previous?.alias;
  const keepsPrevious =
    requested?.model === undefined ||
    requested.model === previousModel ||
    (namesPrevious && modelSelectionSpec(config, previousModel) === previous?.spec);
  const model = keepsPrevious ? previousModel : requested?.model;
  // Config may remap an alias or the main model, so compare what the selection resolves to now.
  const sameModel = previous ? modelSelectionSpec(config, model) === previous.spec : keepsPrevious;
  const reasoning =
    requested?.reasoning ??
    (sameModel ? (policy?.reasoning ?? input.targetReasoning ?? undefined) : undefined);
  let options = requested?.options;
  if (options === undefined && policy?.options && previous) {
    const provider = modelSelectionProvider(config, model);
    const sameNamespace =
      provider !== undefined &&
      providerOptionsNamespace(provider) === providerOptionsNamespace(previous.provider);
    if (sameNamespace) options = policy.options;
  }
  return {
    ...(model ? { modelOverride: model } : {}),
    ...(reasoning ? { reasoningOverride: reasoning } : {}),
    ...(options && Object.keys(options).length > 0 ? { providerOptionsOverride: options } : {}),
  };
}

/**
 * Builds a deferred follow-up for a subagent from its own durable records, keeping its profile
 * and model settings, and reporting to the request and tool call that sent the message. The
 * runner uses it to deliver an automatic steer that missed the child's run.
 */
export function subagentFollowUpRegistration(input: {
  readonly run: WorkflowRun;
  readonly revision: WorkflowRevision;
  readonly policy: WorkflowRequestPolicy | null;
  readonly task: string;
  readonly idleTimeoutMs: number;
  readonly config: CoreConfig;
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
    ...followUpRunSettings({
      policy: input.policy,
      targetReasoning: target.reasoning,
      config: input.config,
    }),
  });
  // The follow-up must continue the same child conversation the steer was meant for.
  if (registration.childSessionId !== target.childSessionId) return null;
  return {
    ...registration,
    projectRoot: input.revision.canonicalWorkspaceRoot,
    fallbackSurface,
  };
}
