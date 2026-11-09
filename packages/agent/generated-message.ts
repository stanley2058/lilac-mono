import type { ModelMessage, UserContent, UserModelMessage } from "ai";
import { isRecord } from "@stanley2058/lilac-utils/runtime-utils";

export type GeneratedMessageKind =
  | "subagent_completion"
  | "conversation_recall"
  | "custom_command_result"
  | "job_event";

export function escapeGeneratedMessageTags(text: string): string {
  return text.replace(/<\/?LILAC_GENERATED:v\d+>/gu, (tag) => `&lt;${tag.slice(1)}`);
}

export function buildGeneratedMessage(input: {
  kind: GeneratedMessageKind;
  id: string;
  content: string | UserContent;
  threadIds?: readonly string[];
}): UserModelMessage {
  const parts: UserContent =
    typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content;
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<LILAC_GENERATED:v1>\n${JSON.stringify({ kind: input.kind, id: input.id })}`,
      },
      ...parts.map((part) =>
        part.type === "text" ? { ...part, text: escapeGeneratedMessageTags(part.text) } : part,
      ),
      { type: "text", text: "</LILAC_GENERATED:v1>" },
    ],
    providerOptions: {
      lilac: {
        generated: {
          version: 1,
          kind: input.kind,
          id: input.id,
          ...(input.threadIds ? { threadIds: [...input.threadIds] } : {}),
        },
      },
    },
  };
}

export function generatedMessageMetadata(message: Pick<ModelMessage, "role" | "providerOptions">) {
  const marker = message.providerOptions?.lilac?.generated;
  if (message.role !== "user" || !isRecord(marker)) return null;
  if (marker.version !== 1 || typeof marker.id !== "string") return null;
  if (
    marker.kind !== "subagent_completion" &&
    marker.kind !== "conversation_recall" &&
    marker.kind !== "custom_command_result" &&
    marker.kind !== "job_event"
  )
    return null;
  return marker;
}

export function isGeneratedMessage(
  message: Pick<ModelMessage, "role" | "providerOptions">,
): boolean {
  return generatedMessageMetadata(message) !== null;
}
