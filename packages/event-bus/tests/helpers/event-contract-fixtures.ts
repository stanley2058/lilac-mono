import type {
  DecodedMessage,
  LilacBus,
  LilacDataForType,
  LilacEventType,
  LilacTopicForType,
  LilacTopic,
} from "../../index";

export function envelope<TData>(input: {
  type: string;
  topic: string;
  key?: string;
  data: TData;
  headers?: Record<string, string>;
}): DecodedMessage<TData> {
  return {
    id: "1736973100000-0",
    ts: 1_736_973_100_000,
    ...input,
  };
}

const requestHeaders = {
  request_id: "request-1",
  session_id: "session-1",
  request_client: "discord",
  trace_id: "trace-1",
};

export type EventFamily =
  | "command-request"
  | "workflow-control"
  | "lifecycle"
  | "adapter"
  | "surface"
  | "agent-output"
  | "native-output";

export type CompatibilityFixture = {
  readonly family: EventFamily;
  readonly type: LilacEventType;
  readonly topic: LilacTopic;
  readonly message: DecodedMessage<unknown>;
  readonly overrideMessage: DecodedMessage<unknown>;
  readonly malformedData: unknown;
  publish(bus: LilacBus): Promise<void>;
  publishMalformed(bus: LilacBus): ReturnType<LilacBus["publish"]>;
  publishWithOverrides(bus: LilacBus): Promise<void>;
};

function compatibilityFixture<TType extends LilacEventType>(input: {
  readonly family: EventFamily;
  readonly type: TType;
  readonly topic: LilacTopicForType<TType>;
  readonly key: string;
  readonly data: LilacDataForType<TType>;
  readonly headers?: Record<string, string>;
  readonly overrideTopic?: LilacTopicForType<TType>;
}): CompatibilityFixture {
  const message = envelope({
    type: input.type,
    topic: input.topic,
    key: input.key,
    data: input.data,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  const overrideTopic = input.overrideTopic ?? input.topic;
  const overrideKey = `override.${input.key}`;
  const overrideMessage = envelope({
    type: input.type,
    topic: overrideTopic,
    key: overrideKey,
    data: input.data,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
  });
  return {
    family: input.family,
    type: input.type,
    topic: input.topic,
    message,
    overrideMessage,
    malformedData: { ...input.data, unexpectedWireField: true },
    publishMalformed: (bus) =>
      bus.publish(
        input.type,
        { ...input.data, unexpectedWireField: true },
        input.headers === undefined ? undefined : { headers: input.headers },
      ),
    publish: async (bus) => {
      const result = await bus.publish(
        input.type,
        input.data,
        input.headers === undefined ? undefined : { headers: input.headers },
      );
      if (result.isErr()) throw result.error;
    },
    publishWithOverrides: async (bus) => {
      const result = await bus.publish(input.type, input.data, {
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        topic: overrideTopic,
        key: overrideKey,
      });
      if (result.isErr()) throw result.error;
    },
  };
}

const opaqueWireUrl = new URL("https://example.com/request?source=fixture");
const opaqueWireDate = new Date("2026-08-03T12:34:56.789Z");
export const opaqueRequestRaw = { url: opaqueWireUrl, receivedAt: opaqueWireDate };
const opaqueAgentContext = { callbackUrl: opaqueWireUrl, createdAt: opaqueWireDate };

export const compatibilityFixtures = [
  compatibilityFixture({
    family: "command-request",
    type: "cmd.request.message",
    topic: "cmd.request",
    key: "request-1",
    headers: requestHeaders,
    data: {
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages: [{ role: "user", content: "hello" }],
      corePrimaryLineage: undefined,
      modelOverride: "openai/gpt-5",
      raw: opaqueRequestRaw,
    },
  }),
  compatibilityFixture({
    family: "command-request",
    type: "cmd.surface.output.reanchor",
    topic: "cmd.surface",
    key: "request-1",
    headers: requestHeaders,
    data: {
      inheritReplyTo: false,
      mode: "steer",
      replyTo: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.message.created",
    topic: "evt.adapter",
    key: "message-1",
    data: {
      platform: "discord",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-1",
      userId: "user-1",
      userName: "Ada",
      text: "hello",
      ts: 10,
      raw: { gateway: "fixture" },
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.message.updated",
    topic: "evt.adapter",
    key: "message-2",
    data: {
      platform: "slack",
      channelId: "channel-2",
      messageId: "message-2",
      userId: "user-2",
      text: "edited",
      ts: 11,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.message.deleted",
    topic: "evt.adapter",
    key: "message-3",
    data: {
      platform: "telegram",
      channelId: "channel-3",
      messageId: "message-3",
      ts: 12,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.reaction.added",
    topic: "evt.adapter",
    key: "message-4",
    data: {
      platform: "github",
      channelId: "repo#1",
      messageId: "message-4",
      userId: "octocat",
      reaction: "+1",
      ts: 13,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.reaction.removed",
    topic: "evt.adapter",
    key: "message-5",
    data: {
      platform: "whatsapp",
      channelId: "channel-5",
      messageId: "message-5",
      reaction: "heart",
      ts: 14,
    },
  }),
  compatibilityFixture({
    family: "adapter",
    type: "evt.adapter.action.invoked",
    topic: "evt.adapter",
    key: "action-1",
    data: {
      actionId: "action-1",
      platform: "web",
      userId: "user-3",
      messageRef: { platform: "web", channelId: "channel-6", messageId: "message-6" },
      sourceMessageId: "source-1",
      ts: 15,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.adapter.workflow-wait-resolver.barrier",
    topic: "evt.adapter",
    key: "barrier-1",
    data: { barrierId: "barrier-1", ts: 16 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: "evt.request.lifecycle.changed",
    topic: "evt.request",
    key: "request-1",
    headers: requestHeaders,
    data: { state: "running", detail: "started", ts: 17 },
  }),
  compatibilityFixture({
    family: "lifecycle",
    type: "evt.request.reply",
    topic: "evt.request",
    key: "request-1",
    headers: { request_id: "request-1" },
    data: {},
  }),
  compatibilityFixture({
    family: "native-output",
    type: "evt.native.output",
    topic: "evt.native.output",
    key: "thread-1",
    data: {
      threadId: "thread-1",
      turnId: "turn-1",
      generation: 0,
      requestId: "request-1",
      attemptId: "attempt-1",
      sequence: 1,
      ordinal: 1,
      eventId: "event-1",
      occurredAt: 1,
      payload: { type: "terminal", state: "complete" },
    },
  }),
  compatibilityFixture({
    family: "surface",
    type: "evt.surface.output.message.created",
    topic: "evt.surface",
    key: "request-1",
    headers: requestHeaders,
    data: {
      msgRef: { platform: "discord", channelId: "channel-1", messageId: "output-1" },
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.run.changed",
    topic: "evt.workflow",
    key: "run-1",
    headers: { workflow_outbox_id: "outbox-1" },
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      state: "running",
      previousState: "queued",
      detail: "claimed",
      ts: 18,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.operation.changed",
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      kind: "agent",
      state: "dispatched",
      phase: "implementation",
      label: "Implement",
      ts: 19,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.progress.requested",
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      reason: "operation_changed",
      ts: 20,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.usage.changed",
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      operationId: "operation-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        agentCount: 1,
        activeAgents: 1,
      },
      ts: 21,
    },
  }),
  compatibilityFixture({
    family: "workflow-control",
    type: "evt.workflow.result.ready",
    topic: "evt.workflow",
    key: "run-1",
    data: {
      runId: "run-1",
      revisionId: "revision-1",
      state: "succeeded",
      summary: "complete",
      resultArtifactId: "artifact-1",
      ts: 22,
    },
  }),
  compatibilityFixture({
    family: "command-request",
    type: "cmd.agent.create",
    topic: "cmd.agent",
    key: "agent-1",
    data: { agentId: "agent-1", context: opaqueAgentContext },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.delta.reasoning",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "thinking", seq: 1 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.delta.text",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { delta: "answer", phase: "final_answer", phaseBoundaryPrefixChars: 1, seq: 2 },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.text.reset",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { text: "retained", phase: "commentary" },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.response.text",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: {
      finalText: "answer",
      delivery: "reply",
      statsForNerdsLine: "15 tokens",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.response.binary",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: {
      blob: { version: 1, objectId: `b1_${"ab".repeat(16)}` },
      mimeType: "text/plain",
      filename: "hello.txt",
    },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.toolcall",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { toolCallId: "tool-call-1", status: "end", display: "[bash] pwd", ok: true },
  }),
  compatibilityFixture({
    family: "agent-output",
    type: "evt.agent.output.activity",
    topic: "out.req.request-1",
    overrideTopic: "out.req.override-request-1",
    key: "request-1",
    headers: requestHeaders,
    data: { source: "subagent" },
  }),
] satisfies readonly CompatibilityFixture[];
