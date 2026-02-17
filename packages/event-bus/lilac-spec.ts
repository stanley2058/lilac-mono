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

  EvtRequestLifecycleChanged: "evt.request.lifecycle.changed",
  EvtRequestReply: "evt.request.reply",

  EvtSurfaceOutputMessageCreated: "evt.surface.output.message.created",

  CmdWorkflowTaskCreate: "cmd.workflow.task.create",
  EvtWorkflowTaskResolved: "evt.workflow.task.resolved",
  EvtWorkflowTaskLifecycleChanged: "evt.workflow.task.lifecycle.changed",

  CmdWorkflowCreate: "cmd.workflow.create",
  EvtWorkflowResolved: "evt.workflow.resolved",
  CmdWorkflowCancel: "cmd.workflow.cancel",
  EvtWorkflowLifecycleChanged: "evt.workflow.lifecycle.changed",

  CmdAgentCreate: "cmd.agent.create",

  EvtAgentOutputDeltaReasoning: "evt.agent.output.delta.reasoning",
  EvtAgentOutputDeltaText: "evt.agent.output.delta.text",
  EvtAgentOutputResponseText: "evt.agent.output.response.text",
  EvtAgentOutputResponseBinary: "evt.agent.output.response.binary",
  EvtAgentOutputToolCall: "evt.agent.output.toolcall",
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

export type WorkflowLifecycleState =
  | "queued"
  | "running"
  | "blocked"
  | "resolved"
  | "failed"
  | "cancelled";

export type TaskLifecycleState =
  | "queued"
  | "running"
  | "blocked"
  | "resolved"
  | "failed"
  | "cancelled";

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

export type CmdRequestMessageData = {
  queue: RequestQueueMode;
  messages: ModelMessage[];
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

export type CmdWorkflowTaskCreateData = {
  workflowId: string;
  taskId: string;
  kind: string;
  /** Human-readable description included in resume context. */
  description: string;
  input?: unknown;
};

export type EvtWorkflowTaskResolvedData = {
  workflowId: string;
  taskId: string;
  result: unknown;
};

export type EvtWorkflowTaskLifecycleChangedData = {
  workflowId: string;
  taskId: string;
  state: TaskLifecycleState;
  detail?: string;
  ts?: number;
};

export type CmdWorkflowCreateData = {
  workflowId: string;
  /** Workflow trigger definition (tasks/conditions). */
  definition?: unknown;
};

export type EvtWorkflowResolvedData = {
  workflowId: string;
  result: unknown;
};

export type CmdWorkflowCancelData = {
  workflowId: string;
  reason?: string;
};

export type EvtWorkflowLifecycleChangedData = {
  workflowId: string;
  state: WorkflowLifecycleState;
  detail?: string;
  ts?: number;
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
};

export type EvtAgentOutputResponseBinaryData = {
  mimeType: string;
  dataBase64: string;
  filename?: string;
};

export type ToolCallStatus = "start" | "end";

export type EvtAgentOutputToolCallData = {
  /** Correlates start/end tool events within a request. */
  toolCallId: string;
  /** Start/end boundaries for a tool call. */
  status: ToolCallStatus;
  /** Preformatted label for UI (e.g. `[bash] ls -al`). */
  display: string;
  /** Present when `status === "end"`. */
  ok?: boolean;
  /** Present when `status === "end" && ok === false`. */
  error?: string;
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

  [lilacEventTypes.CmdWorkflowTaskCreate]: {
    topic: "cmd.workflow";
    key: string;
    data: CmdWorkflowTaskCreateData;
  };

  [lilacEventTypes.EvtWorkflowTaskResolved]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowTaskResolvedData;
  };

  [lilacEventTypes.EvtWorkflowTaskLifecycleChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowTaskLifecycleChangedData;
  };

  [lilacEventTypes.CmdWorkflowCreate]: {
    topic: "cmd.workflow";
    key: string;
    data: CmdWorkflowCreateData;
  };

  [lilacEventTypes.EvtWorkflowResolved]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowResolvedData;
  };

  [lilacEventTypes.CmdWorkflowCancel]: {
    topic: "cmd.workflow";
    key: string;
    data: CmdWorkflowCancelData;
  };

  [lilacEventTypes.EvtWorkflowLifecycleChanged]: {
    topic: "evt.workflow";
    key: string;
    data: EvtWorkflowLifecycleChangedData;
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
