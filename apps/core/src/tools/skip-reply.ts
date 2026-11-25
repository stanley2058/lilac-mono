import { isGeneratedMessage } from "@stanley2058/lilac-agent";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type { TranscriptStore } from "../transcript/transcript-store";
import { parseRequestId } from "../surface/bridge/request-ids";
import { parseSurfaceMetadataLine } from "../surface/bridge/surface-metadata";

export const SKIP_REPLY_SUCCESS = "Reply skipped.";
const skipReplyInput = z.strictObject({
  reason: z.string().trim().min(1).max(500).describe("Briefly state why this turn needs no reply."),
});

export const skipReplyTool = tool({
  description:
    "End this turn without sending a reply. This withdraws the current reply preview. Use it as the only tool in this step. The reason is retained for later turns.",
  inputSchema: skipReplyInput,
  execute: async (_, { messages, toolCallId }) => {
    const assistant = messages.findLast((message) => message.role === "assistant");
    const parts = assistant && typeof assistant.content !== "string" ? assistant.content : [];
    const current = parts.some(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
    );
    const mixed =
      current && parts.some((part) => part.type === "tool-call" && part.toolCallId !== toolCallId);
    return !mixed ? SKIP_REPLY_SUCCESS : "Call skip_reply separately from other tools.";
  },
  toModelOutput: ({ output }) =>
    output === SKIP_REPLY_SUCCESS
      ? { type: "text", value: output }
      : { type: "error-text", value: output },
});

function decodeSkipReplyReason(call: { input: unknown }) {
  const parsed = skipReplyInput.safeParse(call.input);
  return parsed.success ? parsed.data.reason : undefined;
}

type ToolMessage = Extract<ModelMessage | StoredMessageV1, { role: "tool" }>;
type ToolOutput = Extract<ToolMessage["content"][number], { type: "tool-result" }>["output"];

export function acceptedSkipReplyOutput(output: ToolOutput): boolean {
  if (output.type === "text") return output.value === SKIP_REPLY_SUCCESS;
  return (
    output.type === "content" &&
    output.value.length === 1 &&
    output.value[0]?.type === "text" &&
    output.value[0].text === SKIP_REPLY_SUCCESS
  );
}

export function completedSkipReply(
  messages: readonly (ModelMessage | StoredMessageV1)[],
  end = messages.length,
) {
  const assistant = messages[end - 2];
  const result = messages[end - 1];
  if (
    assistant?.role !== "assistant" ||
    typeof assistant.content === "string" ||
    result?.role !== "tool" ||
    result.content.length !== 1
  )
    return;
  const actions = assistant.content.filter(
    (part) => part.type !== "reasoning" && part.type !== "text",
  );
  const call = actions[0];
  if (actions.length !== 1 || call?.type !== "tool-call" || call.toolName !== "skip_reply") return;
  const response = result.content[0];
  if (
    response?.type !== "tool-result" ||
    response.toolName !== call.toolName ||
    response.toolCallId !== call.toolCallId
  )
    return;
  if (!acceptedSkipReplyOutput(response.output)) return;
  const reason = decodeSkipReplyReason(call);
  if (reason) return { reason, toolCallId: call.toolCallId };
}

export function skipReplyKey(decision: { toolCallId: string; reason: string }): string {
  return JSON.stringify([decision.toolCallId, decision.reason]);
}

export function collectSkipReplyKeys(messages: readonly StoredMessageV1[]): string[] {
  const keys: string[] = [];
  for (let end = 2; end <= messages.length; end++) {
    const decision = completedSkipReply(messages, end);
    if (decision) keys.push(skipReplyKey(decision));
  }
  return keys;
}

export function latestDiscordInput(messages: readonly ModelMessage[]) {
  for (const message of messages.toReversed()) {
    if (message.role !== "user" || isGeneratedMessage(message)) continue;
    const texts =
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    for (const text of texts.toReversed()) {
      // Discord escapes these tags in user text. A restart notice can quote arbitrary partial output.
      if (parseSurfaceMetadataLine(text)?.meta.platform !== "discord") continue;
      for (const line of text.split("\n").toReversed()) {
        const meta = parseSurfaceMetadataLine(line)?.meta;
        if (meta?.platform === "discord" && typeof meta.message_id === "string")
          return meta.message_id;
      }
    }
  }
}

export function saveDiscordSkip(input: {
  messages: readonly ModelMessage[];
  requestId: string;
  channelId: string;
  admittedMessageIds: ReadonlySet<string>;
  store?: TranscriptStore;
  decision: { toolCallId: string; reason: string };
}) {
  const origin = parseRequestId(input.requestId);
  if (origin?.kind !== "discord_message" || origin.channelId !== input.channelId || origin.wakeId)
    return;
  const messageId = latestDiscordInput(input.messages);
  if (!messageId || (messageId !== origin.messageId && !input.admittedMessageIds.has(messageId)))
    return;
  return input.store?.saveDiscordSkippedReply?.(input.channelId, messageId, {
    requestId: input.requestId,
    ...input.decision,
  });
}

export function discordSkippedReply(
  store: TranscriptStore | undefined,
  channelId: string,
  messageId: string,
) {
  const decision = store
    ?.getDiscordSkippedReply?.(channelId, messageId)
    .match({ ok: (value) => value, err: () => null });
  if (!decision) return;
  const { reason, toolCallId } = decision;
  const messages = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "skip_reply", input: { reason } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "skip_reply",
          output: { type: "text", value: SKIP_REPLY_SUCCESS },
        },
      ],
    },
  ] satisfies StoredMessageV1[];
  return { ...decision, messages };
}
