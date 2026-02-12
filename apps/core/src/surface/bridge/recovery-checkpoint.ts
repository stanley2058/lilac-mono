import type { ModelMessage } from "ai";

type ToolCallRef = {
  toolCallId: string;
  toolName: string;
};

function getAssistantToolCalls(message: ModelMessage): ToolCallRef[] {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const calls: ToolCallRef[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
    };
    if (
      candidate.type === "tool-call" &&
      typeof candidate.toolCallId === "string" &&
      typeof candidate.toolName === "string"
    ) {
      calls.push({
        toolCallId: candidate.toolCallId,
        toolName: candidate.toolName,
      });
    }
  }

  return calls;
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool") return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (
      candidate.type === "tool-result" &&
      typeof candidate.toolCallId === "string"
    ) {
      ids.push(candidate.toolCallId);
    }
  }

  return ids;
}

export function buildSafeRecoveryCheckpoint(
  messages: readonly ModelMessage[],
  interruptedToolErrorText = "server restarted",
): ModelMessage[] {
  let committedIndex = -1;
  let openToolCalls: Map<string, string> | null = null;
  let openSegmentLastIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (openToolCalls) {
      if (message.role !== "tool") {
        break;
      }

      openSegmentLastIndex = i;

      for (const toolCallId of getToolResultToolCallIds(message)) {
        openToolCalls.delete(toolCallId);
      }

      if (openToolCalls.size === 0) {
        openToolCalls = null;
        committedIndex = openSegmentLastIndex;
      }
      continue;
    }

    if (message.role === "tool") {
      break;
    }

    const toolCalls = getAssistantToolCalls(message);
    if (toolCalls.length > 0) {
      openToolCalls = new Map(toolCalls.map((call) => [call.toolCallId, call.toolName]));
      openSegmentLastIndex = i;
      continue;
    }

    committedIndex = i;
  }

  if (!openToolCalls || openToolCalls.size === 0) {
    return messages.slice(0, Math.max(0, committedIndex + 1));
  }

  const base = messages.slice(0, Math.max(0, openSegmentLastIndex + 1));
  const syntheticToolMessages: ModelMessage[] = [];

  for (const [toolCallId, toolName] of openToolCalls.entries()) {
    syntheticToolMessages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          output: {
            type: "error-text",
            value: interruptedToolErrorText,
          },
        },
      ],
    });
  }

  return [...base, ...syntheticToolMessages];
}
