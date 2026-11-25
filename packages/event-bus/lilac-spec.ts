import { nativeOutputEventSchema } from "./native-output";
/**
 * Canonical event contracts for the Lilac monorepo.
 *
 * Payload types are derived from the colocated runtime schemas used at the
 * event-bus trust boundary.
 */

import { blobHandleV1Schema } from "@stanley2058/lilac-blob-storage";
import { z } from "zod";

import { busMessagesV2Schema } from "./blob-messages";
import { corePrimaryLineageV2Schema } from "./core-primary-lineage";
import {
  createLilacEventTypes,
  dataKey,
  defineLilacEvents,
  fixedTopic,
  headerKey,
  requestOutputTopic,
  type LilacEventSpecFromCatalog,
  type LilacEventTypeFromCatalog,
} from "./define-lilac-events";

/** Output stream topic for a single request (agent output deltas/responses). */
export type OutReqTopic = `out.req.${string}`;

/** Runtime contract for an output stream topic with a non-empty request suffix. */
export const outReqTopicSchema = z.templateLiteral(["out.req.", z.string().min(1)]);

/** Build the output stream topic for a requestId. */
export function outReqTopic(requestId: string): OutReqTopic {
  return `out.req.${requestId}`;
}

const nonemptyStringSchema = z.string().min(1);
const finiteNumberSchema = z.number();

export const requestLifecycleStateSchema = z.enum([
  "queued",
  "running",
  "resolved",
  "failed",
  "cancelled",
]);
export type RequestLifecycleState = z.output<typeof requestLifecycleStateSchema>;

export const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "native",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
export type AdapterPlatform = z.output<typeof adapterPlatformSchema>;

/** Reference to a surface message (platform+channel+message). */
export const surfaceMsgRefSchema = z.strictObject({
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
export type SurfaceMsgRef = z.output<typeof surfaceMsgRefSchema>;

export const requestQueueModeSchema = z.enum(["prompt", "steer", "followUp", "interrupt"]);
export type RequestQueueMode = z.output<typeof requestQueueModeSchema>;

export const requestRunPolicySchema = z.enum(["normal", "idle_only_session", "idle_only_global"]);
export type RequestRunPolicy = z.output<typeof requestRunPolicySchema>;

export const requestOriginSchema = z.strictObject({
  kind: z.literal("heartbeat"),
  reason: z.enum(["interval", "retry"]),
});
export type RequestOrigin = z.output<typeof requestOriginSchema>;

const cmdRequestMessageDataShapeSchema = z.strictObject({
  requestDeliveryId: z.uuid(),
  queue: requestQueueModeSchema,
  messages: busMessagesV2Schema,
  corePrimaryLineage: corePrimaryLineageV2Schema.optional(),
  runPolicy: requestRunPolicySchema.optional(),
  origin: requestOriginSchema.optional(),
  modelOverride: z.string().optional(),
  raw: z.unknown().optional(),
});

function findManagedInlineData(value: unknown): PropertyKey[] | null {
  const seen = new WeakSet<object>();
  const pending: Array<{ readonly value: unknown; readonly path: PropertyKey[] }> = [
    { value, path: [] },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    if (
      entry.value instanceof Uint8Array ||
      entry.value instanceof ArrayBuffer ||
      (ArrayBuffer.isView(entry.value) && !(entry.value instanceof DataView))
    ) {
      return entry.path;
    }
    if (typeof entry.value === "string" && /^data:[^,]*,/iu.test(entry.value)) {
      return entry.path;
    }
    if (entry.value instanceof URL && entry.value.protocol === "data:") return entry.path;
    if (entry.value === null || typeof entry.value !== "object") continue;
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    if (entry.value instanceof Map) {
      for (const [key, mapValue] of entry.value) {
        pending.push({ value: key, path: [...entry.path, "<map-key>"] });
        pending.push({ value: mapValue, path: [...entry.path, "<map-value>"] });
      }
      continue;
    }
    if (entry.value instanceof Set) {
      for (const setValue of entry.value) {
        pending.push({ value: setValue, path: [...entry.path, "<set-value>"] });
      }
      continue;
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry.value))) {
      if (key === "dataBase64") return [...entry.path, key];
      if ("value" in descriptor) {
        pending.push({ value: descriptor.value, path: [...entry.path, key] });
      }
    }
  }
  return null;
}

/** Command payload. Content-dependent lineage validation runs after every handle resolves. */
export const cmdRequestMessageDataSchema = cmdRequestMessageDataShapeSchema.superRefine(
  (data, context) => {
    const path = findManagedInlineData(data);
    if (path !== null) {
      context.addIssue({
        code: "custom",
        path,
        message: "Managed inline binary content and data URLs are not allowed",
      });
    }
  },
);
export type CmdRequestMessageData = z.output<typeof cmdRequestMessageDataSchema>;

/** Parse request data and validate any supplied lineage against `messages`. */
export function parseCmdRequestMessageData(value: unknown): CmdRequestMessageData {
  return cmdRequestMessageDataSchema.parse(value);
}

/** Command: switch an active output relay to a new reply anchor. */
export const cmdSurfaceOutputReanchorDataSchema = z.strictObject({
  /** When true, keep the relay's current reply mode (reply vs top-level). */
  inheritReplyTo: z.boolean(),
  /** Optional reanchor mode for UI placeholders. */
  mode: z.enum(["steer", "interrupt"]).optional(),
  /** Override reply target when inheritReplyTo=false; omit for top-level. */
  replyTo: surfaceMsgRefSchema.optional(),
});
export type CmdSurfaceOutputReanchorData = z.output<typeof cmdSurfaceOutputReanchorDataSchema>;

const adapterMessageDataShape = {
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  userId: nonemptyStringSchema,
  userName: z.string().optional(),
  text: z.string(),
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
};
export const evtAdapterMessageCreatedDataSchema = z.strictObject(adapterMessageDataShape);
export type EvtAdapterMessageCreatedData = z.output<typeof evtAdapterMessageCreatedDataSchema>;
export const evtAdapterMessageUpdatedDataSchema = z.strictObject(adapterMessageDataShape);
export type EvtAdapterMessageUpdatedData = z.output<typeof evtAdapterMessageUpdatedDataSchema>;

export const evtAdapterMessageDeletedDataSchema = z.strictObject({
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
});
export type EvtAdapterMessageDeletedData = z.output<typeof evtAdapterMessageDeletedDataSchema>;

const adapterReactionDataShape = {
  platform: adapterPlatformSchema,
  channelId: nonemptyStringSchema,
  channelName: z.string().optional(),
  messageId: nonemptyStringSchema,
  userId: nonemptyStringSchema.optional(),
  userName: z.string().optional(),
  reaction: z.string(),
  ts: finiteNumberSchema,
  raw: z.unknown().optional(),
};
export const evtAdapterReactionAddedDataSchema = z.strictObject(adapterReactionDataShape);
export type EvtAdapterReactionAddedData = z.output<typeof evtAdapterReactionAddedDataSchema>;
export const evtAdapterReactionRemovedDataSchema = z.strictObject(adapterReactionDataShape);
export type EvtAdapterReactionRemovedData = z.output<typeof evtAdapterReactionRemovedDataSchema>;

export const evtAdapterActionInvokedDataSchema = z.strictObject({
  actionId: nonemptyStringSchema,
  platform: adapterPlatformSchema,
  userId: nonemptyStringSchema,
  messageRef: surfaceMsgRefSchema,
  sourceMessageId: nonemptyStringSchema.optional(),
  ts: finiteNumberSchema,
});
export type EvtAdapterActionInvokedData = z.output<typeof evtAdapterActionInvokedDataSchema>;

export const evtWorkflowWaitResolverBarrierDataSchema = z.strictObject({
  barrierId: nonemptyStringSchema,
  ts: finiteNumberSchema,
});
export type EvtWorkflowWaitResolverBarrierData = z.output<
  typeof evtWorkflowWaitResolverBarrierDataSchema
>;

export const evtRequestLifecycleChangedDataSchema = z.strictObject({
  state: requestLifecycleStateSchema,
  detail: z.string().optional(),
  ts: finiteNumberSchema.optional(),
});
export type EvtRequestLifecycleChangedData = z.output<typeof evtRequestLifecycleChangedDataSchema>;

export const evtRequestReplyDataSchema = z.strictObject({});
export type EvtRequestReplyData = z.output<typeof evtRequestReplyDataSchema>;

/** Event: a surface output message was created for a request. */
export const evtSurfaceOutputMessageCreatedDataSchema = z.strictObject({
  msgRef: surfaceMsgRefSchema,
});
export type EvtSurfaceOutputMessageCreatedData = z.output<
  typeof evtSurfaceOutputMessageCreatedDataSchema
>;

export const workflowRunEventStateSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowRunEventState = z.output<typeof workflowRunEventStateSchema>;

export const workflowOperationEventStateSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type WorkflowOperationEventState = z.output<typeof workflowOperationEventStateSchema>;

export const evtWorkflowRunChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  state: workflowRunEventStateSchema,
  previousState: workflowRunEventStateSchema.optional(),
  detail: z.string().optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowRunChangedData = z.output<typeof evtWorkflowRunChangedDataSchema>;

export const evtWorkflowOperationChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  operationId: nonemptyStringSchema,
  kind: z.enum(["agent", "parallel", "pipeline", "phase", "wait"]),
  state: workflowOperationEventStateSchema,
  previousState: workflowOperationEventStateSchema.optional(),
  phase: z.string().optional(),
  label: z.string().optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowOperationChangedData = z.output<
  typeof evtWorkflowOperationChangedDataSchema
>;

export const evtWorkflowProgressRequestedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  reason: z.enum(["created", "state_changed", "operation_changed", "usage_changed", "reconcile"]),
  ts: finiteNumberSchema,
});
export type EvtWorkflowProgressRequestedData = z.output<
  typeof evtWorkflowProgressRequestedDataSchema
>;

export const evtWorkflowUsageChangedDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  operationId: nonemptyStringSchema.optional(),
  usage: z.strictObject({
    inputTokens: finiteNumberSchema,
    outputTokens: finiteNumberSchema,
    totalTokens: finiteNumberSchema,
    agentCount: finiteNumberSchema,
    activeAgents: finiteNumberSchema,
  }),
  ts: finiteNumberSchema,
});
export type EvtWorkflowUsageChangedData = z.output<typeof evtWorkflowUsageChangedDataSchema>;

export const evtWorkflowResultReadyDataSchema = z.strictObject({
  runId: nonemptyStringSchema,
  revisionId: nonemptyStringSchema,
  state: z.enum(["succeeded", "failed", "rejected", "cancelled"]),
  summary: z.string().optional(),
  resultArtifactId: nonemptyStringSchema.optional(),
  ts: finiteNumberSchema,
});
export type EvtWorkflowResultReadyData = z.output<typeof evtWorkflowResultReadyDataSchema>;

export const cmdAgentCreateDataSchema = z
  .strictObject({
    agentId: nonemptyStringSchema,
    context: z.unknown(),
  })
  .superRefine((data, context) => {
    if (!Object.hasOwn(data, "context")) {
      context.addIssue({ code: "custom", path: ["context"], message: "Required" });
    }
  });
export type CmdAgentCreateData = z.output<typeof cmdAgentCreateDataSchema>;

export const evtAgentOutputDeltaReasoningDataSchema = z.strictObject({
  delta: z.string(),
  seq: finiteNumberSchema.optional(),
});
export type EvtAgentOutputDeltaReasoningData = z.output<
  typeof evtAgentOutputDeltaReasoningDataSchema
>;

const agentOutputPhaseSchema = z.enum(["commentary", "final_answer"]);
export const evtAgentOutputDeltaTextDataSchema = z.strictObject({
  delta: z.string(),
  /** Native OpenAI Responses message phase when available. */
  phase: agentOutputPhaseSchema.optional(),
  /** Synthetic leading separator inserted between assistant text parts. */
  phaseBoundaryPrefixChars: finiteNumberSchema.optional(),
  seq: finiteNumberSchema.optional(),
});
export type EvtAgentOutputDeltaTextData = z.output<typeof evtAgentOutputDeltaTextDataSchema>;

export const evtAgentOutputTextResetDataSchema = z.strictObject({
  /** Withdraw the current Discord preview after a completed skip, keeping the request open. */
  discardPreview: z.literal(true).optional(),
  /** Full retained response text after rolling back transient streamed output. */
  text: z.string(),
  /** Phase of the last retained OpenAI text item, when known. */
  phase: agentOutputPhaseSchema.optional(),
});
export type EvtAgentOutputTextResetData = z.output<typeof evtAgentOutputTextResetDataSchema>;

export const evtAgentOutputResponseTextDataSchema = z.strictObject({
  /** The full response text accumulated across all deltas. */
  finalText: z.string(),
  /** Delivery directive for surfaces. Defaults to "reply" when omitted. */
  delivery: z.enum(["reply", "skip"]).optional(),
  /** Optional one-line token/model stats for surface rendering. */
  statsForNerdsLine: z.string().optional(),
  /** Structured aggregate usage for durable workflow consumers. */
  usage: z
    .strictObject({
      inputTokens: finiteNumberSchema,
      outputTokens: finiteNumberSchema,
      totalTokens: finiteNumberSchema,
    })
    .optional(),
});
export type EvtAgentOutputResponseTextData = z.output<typeof evtAgentOutputResponseTextDataSchema>;

export const evtAgentOutputResponseBinaryDataSchema = z.strictObject({
  blob: blobHandleV1Schema,
  mimeType: nonemptyStringSchema,
  filename: z.string().optional(),
});
export type EvtAgentOutputResponseBinaryData = z.output<
  typeof evtAgentOutputResponseBinaryDataSchema
>;

export const toolCallStatusSchema = z.enum(["start", "update", "end"]);
export type ToolCallStatus = z.output<typeof toolCallStatusSchema>;

export const evtAgentOutputToolCallDataSchema = z.strictObject({
  /** Correlates tool events within a request. */
  toolCallId: nonemptyStringSchema,
  /** Start/update/end boundaries for a tool call. */
  status: toolCallStatusSchema,
  /** Preformatted label for UI (e.g. `[bash] ls -al`). */
  display: z.string(),
  /** Present when `status === "end"`. */
  ok: z.boolean().optional(),
  /** Present when `status === "end" && ok === false`. */
  error: z.string().optional(),
});
export type EvtAgentOutputToolCallData = z.output<typeof evtAgentOutputToolCallDataSchema>;

export const evtAgentOutputActivityDataSchema = z.strictObject({
  source: z.enum(["model", "tool", "subagent"]),
});
export type EvtAgentOutputActivityData = z.output<typeof evtAgentOutputActivityDataSchema>;

/** The single authoring source for Lilac event contracts and routing metadata. */
export const LILAC_EVENTS = defineLilacEvents({
  CmdRequestMessage: {
    type: "cmd.request.message",
    family: "command-request",
    topic: fixedTopic("cmd.request"),
    key: headerKey("request_id"),
    data: cmdRequestMessageDataSchema,
  },
  CmdSurfaceOutputReanchor: {
    type: "cmd.surface.output.reanchor",
    family: "command-request",
    topic: fixedTopic("cmd.surface"),
    key: headerKey("request_id"),
    data: cmdSurfaceOutputReanchorDataSchema,
  },
  EvtAdapterMessageCreated: {
    type: "evt.adapter.message.created",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("messageId"),
    data: evtAdapterMessageCreatedDataSchema,
  },
  EvtAdapterMessageUpdated: {
    type: "evt.adapter.message.updated",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("messageId"),
    data: evtAdapterMessageUpdatedDataSchema,
  },
  EvtAdapterMessageDeleted: {
    type: "evt.adapter.message.deleted",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("messageId"),
    data: evtAdapterMessageDeletedDataSchema,
  },
  EvtAdapterReactionAdded: {
    type: "evt.adapter.reaction.added",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("messageId"),
    data: evtAdapterReactionAddedDataSchema,
  },
  EvtAdapterReactionRemoved: {
    type: "evt.adapter.reaction.removed",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("messageId"),
    data: evtAdapterReactionRemovedDataSchema,
  },
  EvtAdapterActionInvoked: {
    type: "evt.adapter.action.invoked",
    family: "adapter",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("actionId"),
    data: evtAdapterActionInvokedDataSchema,
  },
  EvtWorkflowWaitResolverBarrier: {
    type: "evt.adapter.workflow-wait-resolver.barrier",
    family: "workflow-control",
    topic: fixedTopic("evt.adapter"),
    key: dataKey("barrierId"),
    data: evtWorkflowWaitResolverBarrierDataSchema,
  },
  EvtRequestLifecycleChanged: {
    type: "evt.request.lifecycle.changed",
    family: "lifecycle",
    topic: fixedTopic("evt.request"),
    key: headerKey("request_id"),
    data: evtRequestLifecycleChangedDataSchema,
  },
  EvtRequestReply: {
    type: "evt.request.reply",
    family: "lifecycle",
    topic: fixedTopic("evt.request"),
    key: headerKey("request_id"),
    data: evtRequestReplyDataSchema,
  },
  EvtNativeOutput: {
    type: "evt.native.output",
    family: "native-output",
    topic: fixedTopic("evt.native.output"),
    key: dataKey("threadId"),
    data: nativeOutputEventSchema,
  },
  EvtSurfaceOutputMessageCreated: {
    type: "evt.surface.output.message.created",
    family: "surface",
    topic: fixedTopic("evt.surface"),
    key: headerKey("request_id"),
    data: evtSurfaceOutputMessageCreatedDataSchema,
  },
  EvtWorkflowRunChanged: {
    type: "evt.workflow.run.changed",
    family: "workflow-control",
    topic: fixedTopic("evt.workflow"),
    key: dataKey("runId"),
    data: evtWorkflowRunChangedDataSchema,
  },
  EvtWorkflowOperationChanged: {
    type: "evt.workflow.operation.changed",
    family: "workflow-control",
    topic: fixedTopic("evt.workflow"),
    key: dataKey("runId"),
    data: evtWorkflowOperationChangedDataSchema,
  },
  EvtWorkflowProgressRequested: {
    type: "evt.workflow.progress.requested",
    family: "workflow-control",
    topic: fixedTopic("evt.workflow"),
    key: dataKey("runId"),
    data: evtWorkflowProgressRequestedDataSchema,
  },
  EvtWorkflowUsageChanged: {
    type: "evt.workflow.usage.changed",
    family: "workflow-control",
    topic: fixedTopic("evt.workflow"),
    key: dataKey("runId"),
    data: evtWorkflowUsageChangedDataSchema,
  },
  EvtWorkflowResultReady: {
    type: "evt.workflow.result.ready",
    family: "workflow-control",
    topic: fixedTopic("evt.workflow"),
    key: dataKey("runId"),
    data: evtWorkflowResultReadyDataSchema,
  },
  CmdAgentCreate: {
    type: "cmd.agent.create",
    family: "command-request",
    topic: fixedTopic("cmd.agent"),
    key: dataKey("agentId"),
    data: cmdAgentCreateDataSchema,
  },
  EvtAgentOutputDeltaReasoning: {
    type: "evt.agent.output.delta.reasoning",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputDeltaReasoningDataSchema,
  },
  EvtAgentOutputDeltaText: {
    type: "evt.agent.output.delta.text",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputDeltaTextDataSchema,
  },
  EvtAgentOutputTextReset: {
    type: "evt.agent.output.text.reset",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputTextResetDataSchema,
  },
  EvtAgentOutputResponseText: {
    type: "evt.agent.output.response.text",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputResponseTextDataSchema,
  },
  EvtAgentOutputResponseBinary: {
    type: "evt.agent.output.response.binary",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputResponseBinaryDataSchema,
  },
  EvtAgentOutputToolCall: {
    type: "evt.agent.output.toolcall",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputToolCallDataSchema,
  },
  EvtAgentOutputActivity: {
    type: "evt.agent.output.activity",
    family: "agent-output",
    topic: requestOutputTopic({ schema: outReqTopicSchema, resolve: outReqTopic }),
    key: headerKey("request_id"),
    data: evtAgentOutputActivityDataSchema,
  },
});

/** Event type string constants retained for autocomplete and compatibility. */
export const lilacEventTypes = createLilacEventTypes(LILAC_EVENTS);

/** Union of all supported Lilac event types. */
export type LilacEventType = LilacEventTypeFromCatalog<typeof LILAC_EVENTS>;

/** Type-level map from event type to its topic, key, and payload contract. */
export type LilacEventSpec = LilacEventSpecFromCatalog<typeof LILAC_EVENTS>;

/** Union of all topics used by the Lilac bus. */
export type LilacTopic = LilacEventSpec[LilacEventType]["topic"];

/** Event types that may appear on a given topic. */
export type LilacEventTypesForTopic<TTopic extends LilacTopic> = {
  [TType in LilacEventType]: TTopic extends LilacEventSpec[TType]["topic"] ? TType : never;
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
