/**
 * Canonical event contracts for the Lilac monorepo.
 *
 * Compile-time only: there is no runtime validation/decoding.
 */

import type { ModelMessage } from "ai";

/**
 * Event type string constants (use for autocomplete).
 */
export const lilacEventTypes = {
  CmdRequestMessage: "cmd.request.message",

  CmdSurfaceOutputReanchor: "cmd.surface.output.reanchor",

  EvtAdapterMessageCreated: "evt.adapter.message.created",
  EvtAdapterMessageUpdated: "evt.adapter.message.updated",
  EvtAdapterMessageDeleted: "evt.adapter.message.deleted",
  EvtAdapterReactionAdded: "evt.adapter.reaction.added",
  EvtAdapterReactionRemoved: "evt.adapter.reaction.removed",
  EvtAdapterActionInvoked: "evt.adapter.action.invoked",

  EvtRequestLifecycleChanged: "evt.request.lifecycle.changed",
  EvtRequestReply: "evt.request.reply",

  EvtSurfaceOutputMessageCreated: "evt.surface.output.message.created",

  EvtWorkflowRunChanged: "evt.workflow.run.changed",
  EvtWorkflowOperationChanged: "evt.workflow.operation.changed",
  EvtWorkflowApprovalChanged: "evt.workflow.approval.changed",
  EvtWorkflowProgressRequested: "evt.workflow.progress.requested",
  EvtWorkflowUsageChanged: "evt.workflow.usage.changed",
  EvtWorkflowResultReady: "evt.workflow.result.ready",

  CmdAgentCreate: "cmd.agent.create",

  EvtAgentOutputDeltaReasoning: "evt.agent.output.delta.reasoning",
  EvtAgentOutputDeltaText: "evt.agent.output.delta.text",
  EvtAgentOutputResponseText: "evt.agent.output.response.text",
  EvtAgentOutputResponseBinary: "evt.agent.output.response.binary",
  EvtAgentOutputToolCall: "evt.agent.output.toolcall",
  EvtAgentOutputActivity: "evt.agent.output.activity",
} as const;

/** Union of all supported Lilac event types. */
export type LilacEventType = (typeof lilacEventTypes)[keyof typeof lilacEventTypes];

/** Output stream topic for a single request (agent output deltas/responses). */
export type OutReqTopic = `out.req.${string}`;

/** Build the output stream topic for a requestId. */
export function outReqTopic(requestId: string): OutReqTopic {
  return `out.req.${requestId}`;
}

export type RequestLifecycleState = "queued" | "running" | "resolved" | "failed" | "cancelled";

export type AdapterPlatform =
  | "discord"
  | "github"
  | "whatsapp"
  | "slack"
  | "telegram"
  | "web"
  | "unknown";

/** Reference to a surface message (platform+channel+message). */
export type SurfaceMsgRef = {
  platform: AdapterPlatform;
  channelId: string;
  messageId: string;
};

export type RequestQueueMode = "prompt" | "steer" | "followUp" | "interrupt";

export type RequestRunPolicy = "normal" | "idle_only_session" | "idle_only_global";

export type RequestOrigin = {
  kind: "heartbeat";
  reason: "interval" | "retry";
};

export type CmdRequestMessageData = {
  queue: RequestQueueMode;
  messages: ModelMessage[];
  runPolicy?: RequestRunPolicy;
  origin?: RequestOrigin;
  /** Optional direct model ref (provider/model or alias from models.def). */
  modelOverride?: string;
  /** Raw adapter payload (platform event) if you need it later. */
  raw?: unknown;
};

/** Command: switch an active output relay to a new reply anchor. */
export type CmdSurfaceOutputReanchorData = {
  /** When true, keep the relay's current reply mode (reply vs top-level). */
  inheritReplyTo: boolean;
  /** Optional reanchor mode for UI placeholders. */
  mode?: "steer" | "interrupt";
  /** Override reply target when inheritReplyTo=false; omit for top-level. */
  replyTo?: SurfaceMsgRef;
};

export type EvtAdapterMessageCreatedData = {
  platform: AdapterPlatform;
  channelId: string;
  channelName?: string;
  messageId: string;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  raw?: unknown;
};

export type EvtAdapterMessageUpdatedData = {
  platform: AdapterPlatform;
  channelId: string;
  channelName?: string;
  messageId: string;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  raw?: unknown;
};

export type EvtAdapterMessageDeletedData = {
  platform: AdapterPlatform;
  channelId: string;
  channelName?: string;
  messageId: string;
  ts: number;
  raw?: unknown;
};

export type EvtAdapterReactionAddedData = {
  platform: AdapterPlatform;
  channelId: string;
  channelName?: string;
  messageId: string;
  userId?: string;
  userName?: string;
  reaction: string;
  ts: number;
  raw?: unknown;
};

export type EvtAdapterReactionRemovedData = {
  platform: AdapterPlatform;
  channelId: string;
  channelName?: string;
  messageId: string;
  userId?: string;
  userName?: string;
  reaction: string;
  ts: number;
  raw?: unknown;
};

export type EvtAdapterActionInvokedData = {
  actionId: string;
  platform: AdapterPlatform;
  userId: string;
  messageRef: SurfaceMsgRef;
  sourceMessageId?: string;
  ts: number;
};

export type EvtRequestLifecycleChangedData = {
  state: RequestLifecycleState;
  detail?: string;
  ts?: number;
};

export type EvtRequestReplyData = {};

/** Event: a surface output message was created for a request. */
export type EvtSurfaceOutputMessageCreatedData = {
  msgRef: SurfaceMsgRef;
};

export type WorkflowRunEventState =
  | "awaiting_review"
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled";

export type WorkflowOperationEventState =
  | "queued"
  | "dispatched"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type WorkflowApprovalEventState =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export type EvtWorkflowRunChangedData = {
  runId: string;
  revisionId: string;
  state: WorkflowRunEventState;
  previousState?: WorkflowRunEventState;
  detail?: string;
  ts: number;
};

export type EvtWorkflowOperationChangedData = {
  runId: string;
  revisionId: string;
  operationId: string;
  kind: "agent" | "parallel" | "pipeline" | "phase" | "wait";
  state: WorkflowOperationEventState;
  previousState?: WorkflowOperationEventState;
  phase?: string;
  label?: string;
  ts: number;
};

export type EvtWorkflowApprovalChangedData = {
  approvalId: string;
  revisionId: string;
  runId?: string;
  state: WorkflowApprovalEventState;
  previousState?: WorkflowApprovalEventState;
  ts: number;
};

export type EvtWorkflowProgressRequestedData = {
  runId: string;
  revisionId: string;
  reason: "created" | "state_changed" | "operation_changed" | "usage_changed" | "reconcile";
  ts: number;
};

export type EvtWorkflowUsageChangedData = {
  runId: string;
  revisionId: string;
  operationId?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    agentCount: number;
    activeAgents: number;
  };
  ts: number;
};

export type EvtWorkflowResultReadyData = {
  runId: string;
  revisionId: string;
  state: "succeeded" | "failed" | "rejected" | "cancelled";
  summary?: string;
  resultArtifactId?: string;
  ts: number;
};

export type CmdAgentCreateData = {
  agentId: string;
  context: unknown;
};

export type EvtAgentOutputDeltaReasoningData = {
  delta: string;
  seq?: number;
};

export type EvtAgentOutputDeltaTextData = {
  delta: string;
  seq?: number;
};

export type EvtAgentOutputResponseTextData = {
  /** The full response text accumulated across all deltas. */
  finalText: string;
  /** Delivery directive for surfaces. Defaults to "reply" when omitted. */
  delivery?: "reply" | "skip";
  /** Optional one-line token/model stats for surface rendering. */
  statsForNerdsLine?: string;
  /** Structured aggregate usage for durable workflow consumers. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export type EvtAgentOutputResponseBinaryData = {
  mimeType: string;
  dataBase64: string;
  filename?: string;
};

export type ToolCallStatus = "start" | "update" | "end";

export type EvtAgentOutputToolCallData = {
  /** Correlates tool events within a request. */
  toolCallId: string;
  /** Start/update/end boundaries for a tool call. */
  status: ToolCallStatus;
  /** Preformatted label for UI (e.g. `[bash] ls -al`). */
  display: string;
  /** Present when `status === "end"`. */
  ok?: boolean;
  /** Present when `status === "end" && ok === false`. */
  error?: string;
};

export type EvtAgentOutputActivityData = {
  source: "model" | "tool" | "subagent";
};

/**
 * Type-level map: event type -> topic + payload.
 */
export type LilacEventSpec = {
  [lilacEventTypes.CmdRequestMessage]: {
    topic: "cmd.request";
    key: string;
    data: CmdRequestMessageData;
  };

  [lilacEventTypes.CmdSurfaceOutputReanchor]: {
    topic: "cmd.surface";
    key: string;
    data: CmdSurfaceOutputReanchorData;
  };

  [lilacEventTypes.EvtAdapterMessageCreated]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageCreatedData;
  };

  [lilacEventTypes.EvtAdapterMessageUpdated]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageUpdatedData;
  };

  [lilacEventTypes.EvtAdapterMessageDeleted]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterMessageDeletedData;
  };

  [lilacEventTypes.EvtAdapterReactionAdded]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterReactionAddedData;
  };

  [lilacEventTypes.EvtAdapterReactionRemoved]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterReactionRemovedData;
  };

  [lilacEventTypes.EvtAdapterActionInvoked]: {
    topic: "evt.adapter";
    key: string;
    data: EvtAdapterActionInvokedData;
  };

  [lilacEventTypes.EvtRequestLifecycleChanged]: {
    topic: "evt.request";
    key: string;
    data: EvtRequestLifecycleChangedData;
  };

  [lilacEventTypes.EvtRequestReply]: {
    topic: "evt.request";
    key: string;
    data: EvtRequestReplyData;
  };

  [lilacEventTypes.EvtSurfaceOutputMessageCreated]: {
    topic: "evt.surface";
    key: string;
    data: EvtSurfaceOutputMessageCreatedData;
  };

  [lilacEventTypes.EvtWorkflowRunChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowRunChangedData;
  };

  [lilacEventTypes.EvtWorkflowOperationChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowOperationChangedData;
  };

  [lilacEventTypes.EvtWorkflowApprovalChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowApprovalChangedData;
  };

  [lilacEventTypes.EvtWorkflowProgressRequested]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowProgressRequestedData;
  };

  [lilacEventTypes.EvtWorkflowUsageChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowUsageChangedData;
  };

  [lilacEventTypes.EvtWorkflowResultReady]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowResultReadyData;
  };

  [lilacEventTypes.CmdAgentCreate]: {
    topic: "cmd.agent";
    key: string;
    data: CmdAgentCreateData;
  };

  [lilacEventTypes.EvtAgentOutputDeltaReasoning]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputDeltaReasoningData;
  };

  [lilacEventTypes.EvtAgentOutputDeltaText]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputDeltaTextData;
  };

  [lilacEventTypes.EvtAgentOutputResponseText]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputResponseTextData;
  };

  [lilacEventTypes.EvtAgentOutputResponseBinary]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputResponseBinaryData;
  };

  [lilacEventTypes.EvtAgentOutputToolCall]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputToolCallData;
  };
  [lilacEventTypes.EvtAgentOutputActivity]: {
    topic: OutReqTopic;
    key: string;
    data: EvtAgentOutputActivityData;
  };
};

/** Union of all topics used by the Lilac bus. */
export type LilacTopic = LilacEventSpec[LilacEventType]["topic"];

/** Event types that may appear on a given topic. */
export type LilacEventTypesForTopic<TTopic extends LilacTopic> = {
  [TType in LilacEventType]: LilacEventSpec[TType]["topic"] extends TTopic ? TType : never;
}[LilacEventType];

/** Payload type for a given event type. */
export type LilacDataForType<TType extends LilacEventType> = LilacEventSpec[TType]["data"];

/** Topic used to route a given event type. */
export type LilacTopicForType<TType extends LilacEventType> = LilacEventSpec[TType]["topic"];

/** Correlation/partition key type for a given event type. */
export type LilacKeyForType<TType extends LilacEventType> = LilacEventSpec[TType] extends {
  key: infer K;
}
  ? K
  : never;
