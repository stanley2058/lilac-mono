/**
 * Canonical event contracts for the Lilac monorepo.
 *
 * Compile-time only: there is no runtime validation/decoding.
 */

/**
 * Event type string constants (use for autocomplete).
 */
export const lilacEventTypes = {
  CmdRequestMessage: "cmd.request.message",

  EvtAdapterMessageCreated: "evt.adapter.message.created",
  EvtAdapterMessageUpdated: "evt.adapter.message.updated",
  EvtAdapterMessageDeleted: "evt.adapter.message.deleted",
  EvtAdapterReactionAdded: "evt.adapter.reaction.added",
  EvtAdapterReactionRemoved: "evt.adapter.reaction.removed",

  EvtRequestLifecycleChanged: "evt.request.lifecycle.changed",
  EvtRequestReply: "evt.request.reply",

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
export type LilacEventType =
  (typeof lilacEventTypes)[keyof typeof lilacEventTypes];

/** Output stream topic for a single request (agent output deltas/responses). */
export type OutReqTopic = `out.req.${string}`;

/** Build the output stream topic for a requestId. */
export function outReqTopic(requestId: string): OutReqTopic {
  return `out.req.${requestId}`;
}

export type RequestLifecycleState =
  | "queued"
  | "running"
  | "streaming"
  | "done"
  | "failed"
  | "cancelled";

export type WorkflowLifecycleState =
  | "queued"
  | "running"
  | "blocked"
  | "done"
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
  | "whatsapp"
  | "slack"
  | "telegram"
  | "web"
  | "unknown";

export type CmdRequestMessageData = {
  requestId: string;
  platform: AdapterPlatform;
  /** Platform-specific channel/conversation identifier. */
  channelId: string;
  /** Best-effort channel name (if available). */
  channelName?: string;
  /** Platform-specific user identifier. */
  userId: string;
  /** Best-effort user display name (if available). */
  userName?: string;
  text: string;
  /** Raw adapter payload (platform event) if you need it later. */
  raw?: unknown;
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
  requestId: string;
  state: RequestLifecycleState;
  detail?: string;
  ts?: number;
};

export type EvtRequestReplyData = {
  requestId: string;
  /**
   * Output stream topic for deltas/responses.
   *
   * By convention this is `out.req.${requestId}`.
   */
  outputTopic: OutReqTopic;
};

export type CmdWorkflowTaskCreateData = {
  workflowId: string;
  taskId: string;
  /** Request that spawned this workflow/task (if any). */
  requestId?: string;
  kind: string;
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
  /**
   * If this agent creation is tied to a request, populate requestId.
   * This is typically used to route output events.
   */
  requestId?: string;
  context: unknown;
};

export type EvtAgentOutputDeltaReasoningData = {
  requestId: string;
  delta: string;
  seq?: number;
};

export type EvtAgentOutputDeltaTextData = {
  requestId: string;
  delta: string;
  seq?: number;
};

export type EvtAgentOutputResponseTextData = {
  requestId: string;
  text: string;
};

export type EvtAgentOutputResponseBinaryData = {
  requestId: string;
  mimeType: string;
  dataBase64: string;
  filename?: string;
};

export type ToolCallStatus = "start" | "end";

export type EvtAgentOutputToolCallData = {
  /** Correlates tool-call output events for a request. */
  requestId: string;
  /** Start/end boundaries for a tool call. */
  status: ToolCallStatus;
  /** Tool identifier (e.g. `bash`, `readFile`, `writeFile`). */
  toolName: string;
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
  [TType in LilacEventType]: LilacEventSpec[TType]["topic"] extends TTopic
    ? TType
    : never;
}[LilacEventType];

/** Payload type for a given event type. */
export type LilacDataForType<TType extends LilacEventType> =
  LilacEventSpec[TType]["data"];

/** Topic used to route a given event type. */
export type LilacTopicForType<TType extends LilacEventType> =
  LilacEventSpec[TType]["topic"];

/** Correlation/partition key type for a given event type. */
export type LilacKeyForType<TType extends LilacEventType> =
  LilacEventSpec[TType] extends { key: infer K } ? K : never;
