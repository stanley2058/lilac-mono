import type { ModelMessage } from "ai";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeToolCallInputValue(input: unknown): unknown {
  if (typeof input !== "string") return input;

  try {
    const parsed = JSON.parse(input) as unknown;
    return isPlainObject(parsed) ? parsed : input;
  } catch {
    return input;
  }
}

export function normalizeAssistantToolCallInputMessage(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "tool-call") return part;

    const normalizedInput = normalizeToolCallInputValue(part.input);
    if (normalizedInput === part.input) return part;

    changed = true;
    return {
      ...part,
      input: normalizedInput,
    };
  });

  return changed
    ? {
        ...message,
        content,
      }
    : message;
}

export function normalizeAssistantToolCallInputs(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return messages.map(normalizeAssistantToolCallInputMessage);
}
