import type { ModelMessage } from "ai";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingJsonSeparator(text: string): string {
  return text.replace(/[,:]\s*$/u, "");
}

function repairTruncatedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;

  const closers: string[] = [];
  let output = "";
  let inString = false;
  let escaping = false;

  for (const char of trimmed) {
    if (inString) {
      output += char;

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "{") {
      closers.push("}");
      output += char;
      continue;
    }

    if (char === "[") {
      closers.push("]");
      output += char;
      continue;
    }

    if (char === "}" || char === "]") {
      const matchingIndex = closers.lastIndexOf(char);
      if (matchingIndex < 0) {
        return null;
      }

      while (closers.length - 1 > matchingIndex) {
        output = stripTrailingJsonSeparator(output);
        output += closers.pop()!;
      }

      output = stripTrailingJsonSeparator(output);
      closers.pop();
      output += char;
      continue;
    }

    output += char;
  }

  if (escaping) {
    return null;
  }

  if (inString) {
    output += '"';
  }

  while (closers.length > 0) {
    output = stripTrailingJsonSeparator(output);
    output += closers.pop()!;
  }

  return output;
}

function parsePlainObjectJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = globalThis.JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeToolCallInputValue(input: unknown): unknown {
  if (typeof input !== "string") return input;

  const parsed = parsePlainObjectJson(input);
  if (parsed) return parsed;

  const repaired = repairTruncatedJson(input);
  if (!repaired || repaired === input) return input;

  return parsePlainObjectJson(repaired) ?? input;
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

export function dedupeToolResultMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const seenToolCallIds = new Set<string>();
  const out: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "tool") {
      out.push(message);
      continue;
    }

    let changed = false;
    const content = message.content.filter((part) => {
      if (part.type !== "tool-result") {
        return true;
      }

      if (seenToolCallIds.has(part.toolCallId)) {
        changed = true;
        return false;
      }

      seenToolCallIds.add(part.toolCallId);
      return true;
    });

    if (content.length === 0) {
      continue;
    }

    if (!changed) {
      out.push(message);
      continue;
    }

    out.push({
      ...message,
      content,
    });
  }

  return out;
}

export function normalizeReplayMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return dedupeToolResultMessages(normalizeAssistantToolCallInputs(messages));
}
