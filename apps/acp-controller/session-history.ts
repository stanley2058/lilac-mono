import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";

import type { HistoryMessage, SessionPlanEntry } from "./types.ts";

type SnapshotRun = {
  user: {
    text: string;
  };
  assistant: {
    text: string;
  } | null;
};

function contentToText(update: Extract<SessionUpdate, { content: unknown }>): string {
  if (update.content.type === "text") return update.content.text;
  if (update.content.type === "resource_link") {
    return update.content.uri;
  }
  return `[${update.content.type}]`;
}

function appendMessage(messages: HistoryMessage[], role: HistoryMessage["role"], text: string) {
  if (text.length === 0) return;
  const last = messages.at(-1);
  if (last && last.role === role) {
    last.text += text;
    return;
  }
  messages.push({ role, text });
}

export class SessionHistoryCollector {
  readonly history: HistoryMessage[] = [];
  plan: SessionPlanEntry[] | undefined;
  title: string | undefined;
  updatedAt: string | undefined;
  availableModes: Array<{ id: string; name: string }> | undefined;
  currentModeId: string | undefined;
  availableModels: Array<{ id: string; name: string }> | undefined;
  currentModelId: string | undefined;

  add(notification: SessionNotification): void {
    const { update } = notification;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        appendMessage(this.history, "user", contentToText(update));
        return;
      case "agent_message_chunk":
        appendMessage(this.history, "assistant", contentToText(update));
        return;
      case "plan":
        this.plan = update.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        }));
        return;
      case "session_info_update":
        if (typeof update.title === "string") this.title = update.title;
        if (typeof update.updatedAt === "string") this.updatedAt = update.updatedAt;
        return;
      case "current_mode_update":
        this.currentModeId = update.currentModeId;
        return;
      case "usage_update":
      case "available_commands_update":
      case "agent_thought_chunk":
      case "tool_call":
      case "tool_call_update":
      case "config_option_update":
        return;
      default:
        return;
    }
  }

  latestAssistantText(): string | undefined {
    for (let index = this.history.length - 1; index >= 0; index--) {
      const message = this.history[index];
      if (message?.role === "assistant") return message.text;
    }
    return undefined;
  }
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

export function buildSnapshotRuns(
  history: readonly HistoryMessage[],
  maxRuns: number,
  maxChars: number,
): SnapshotRun[] {
  const runs: SnapshotRun[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (!message || message.role !== "user") continue;
    const nextAssistant = history[index + 1]?.role === "assistant" ? history[index + 1] : undefined;
    runs.push({
      user: { text: truncate(message.text, maxChars) },
      assistant: nextAssistant ? { text: truncate(nextAssistant.text, maxChars) } : null,
    });
  }

  return maxRuns <= 0 ? [] : runs.slice(-maxRuns);
}
