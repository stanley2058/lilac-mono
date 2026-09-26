import type { ModelMessage } from "ai";
import { referencedConversations } from "@stanley2058/lilac-client-protocol";

export function expandConversationReferencesForModel(
  messages: readonly ModelMessage[],
  publicUrl: string,
): ModelMessage[] {
  const origin = new URL(publicUrl).origin;
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const references = referencedConversations(text, origin);
    if (!references.length) return message;
    const context = references.map((target) =>
      JSON.stringify({
        client: target.surface,
        sessionId: target.sessionId,
        ...(target.messageId ? { messageId: target.messageId } : {}),
        ...(target.range ? { range: target.range } : {}),
        ...(target.surface === "native"
          ? { conversationThreadId: `native:${target.sessionId}` }
          : {}),
      }),
    );
    const suffix = `\n\nConversation references (coordinates only; use surface.help for retrieval):\n${context.join("\n")}`;
    if (typeof message.content === "string")
      return { ...message, content: message.content + suffix };
    return { ...message, content: [...message.content, { type: "text", text: suffix }] };
  });
}
