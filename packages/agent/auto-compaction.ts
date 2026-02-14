import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

import type {
  AiSdkPiAgentEvent,
  TransformMessagesFn,
  TransformMessagesContext,
} from "./ai-sdk-pi-agent";
import { AiSdkPiAgent } from "./ai-sdk-pi-agent";
import { ModelCapability, type ModelSpecifier } from "@stanley2058/lilac-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((p) => ({ ...p }))
        : message.content,
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((p) => ({ ...p })),
    };
  }
  return { ...message };
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(cloneMessage);
}

export type AutoCompactionOptions = {
  /** Canonical model identifier in `provider/modelstring` format. */
  model: ModelSpecifier;

  /** Determines the model context window. */
  modelCapability: ModelCapability;

  /** How many trailing messages to always keep (default: 30). */
  keepLastMessages?: number;

  /**
   * The model used to generate summaries.
   *
   * - `current`: use the agent's current `state.model`.
   * - a model instance: use that for summarization.
   */
  summaryModel?: "current" | LanguageModel;

  /** Override summary system prompt. */
  summarySystem?: string;

  /**
   * Optional prompt builder.
   *
   * Receives rendered transcript prefix (older messages) and should return
   * a user message content for the summarizer model.
   */
  buildSummaryPrompt?: (prefix: string) => string;

  /** Optional base transform to run before compaction. */
  baseTransformMessages?: TransformMessagesFn;

  /** Enable/disable (default: true). */
  enabled?: boolean;
};

const DEFAULT_THRESHOLD_FRACTION = 0.8;

const AUTO_CONTINUE_AFTER_COMPACTION_TEXT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

function getAssistantToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-call" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function getToolResultToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "tool") return [];

  const ids: string[] = [];
  for (const part of message.content) {
    const candidate = part as unknown as {
      type?: unknown;
      toolCallId?: unknown;
    };
    if (candidate.type === "tool-result" && typeof candidate.toolCallId === "string") {
      ids.push(candidate.toolCallId);
    }
  }
  return ids;
}

function isValidSuffix(messages: ModelMessage[], startIndex: number): boolean {
  const open = new Set<string>();

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === "assistant") {
      for (const id of getAssistantToolCallIds(message)) open.add(id);
      continue;
    }

    if (message.role === "tool") {
      for (const id of getToolResultToolCallIds(message)) {
        if (!open.has(id)) return false;
        open.delete(id);
      }
    }
  }

  return true;
}

function chooseSuffixStart(messages: ModelMessage[], keepLastMessages: number): number {
  const candidate = Math.max(0, messages.length - keepLastMessages);

  for (let start = candidate; start >= 0; start--) {
    if (isValidSuffix(messages, start)) return start;
  }

  return 0;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderMessageForSummary(message: ModelMessage): string {
  if (message.role === "user") {
    const content =
      typeof message.content === "string" ? message.content : stringifyUnknown(message.content);
    return `USER:\n${content}`;
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return `ASSISTANT:\n${message.content}`;
    }

    const lines: string[] = [];
    for (const part of message.content) {
      if (isRecord(part)) {
        const record = part as unknown as Record<string, unknown>;
        const type = getString(record["type"]);

        if (type === "text" || type === "reasoning") {
          const text = getString(record["text"]);
          if (text) {
            lines.push(text);
            continue;
          }
        }

        if (type === "tool-call") {
          const toolName = getString(record["toolName"]);
          const toolCallId = getString(record["toolCallId"]);
          if (toolName && toolCallId) {
            lines.push(
              `TOOL_CALL ${toolName} id=${toolCallId}: ${stringifyUnknown(record["input"])}`,
            );
            continue;
          }
        }
      }

      lines.push(stringifyUnknown(part));
    }

    return `ASSISTANT:\n${lines.join("\n")}`;
  }

  if (message.role === "tool") {
    const parts = Array.isArray(message.content) ? message.content : [];
    const lines = parts.map((p) => {
      if (isRecord(p)) {
        const record = p as unknown as Record<string, unknown>;
        const type = getString(record["type"]);
        if (type === "tool-result") {
          const toolName = getString(record["toolName"]);
          const toolCallId = getString(record["toolCallId"]);
          if (toolName && toolCallId) {
            return `TOOL_RESULT ${toolName} id=${toolCallId}: ${stringifyUnknown(record["output"])}`;
          }
        }
      }

      return stringifyUnknown(p);
    });

    return `TOOL:\n${lines.join("\n")}`;
  }

  // Fallback for unknown/unsupported roles.
  const unknownMessage = message as unknown as {
    role?: unknown;
    content?: unknown;
  };
  const role = typeof unknownMessage.role === "string" ? unknownMessage.role : "unknown";
  return `${role.toUpperCase()}:\n${stringifyUnknown(unknownMessage.content)}`;
}

function renderMessagesForSummary(messages: ModelMessage[]): string {
  return messages.map(renderMessageForSummary).join("\n\n---\n\n");
}

async function summarizePrefix(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const res = streamText({
    model: options.model,
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
    abortSignal: options.abortSignal,
  });

  // Consume the stream and return the final text.
  return await res.text;
}

export async function attachAutoCompaction(
  agent: AiSdkPiAgent,
  options: AutoCompactionOptions,
): Promise<() => void> {
  if (options.enabled === false) return () => {};

  const thresholdFraction = DEFAULT_THRESHOLD_FRACTION;
  const keepLastMessages = options.keepLastMessages ?? 30;

  const modelInfo = await options.modelCapability.resolve(options.model);
  const contextLimit = modelInfo.limit.context;

  let shouldCompact = false;
  let inCompaction = false;
  let queuedAutoContinue = false;

  const unsubscribe = agent.subscribe((event: AiSdkPiAgentEvent<ToolSet>) => {
    if (event.type !== "turn_end") return;

    const inputTokens = event.usage.inputTokens;
    if (typeof inputTokens !== "number" || inputTokens <= 0) return;

    const fraction = inputTokens / contextLimit;
    if (fraction < thresholdFraction) return;

    const wasCompactionPending = shouldCompact;
    shouldCompact = true;

    // If tools are in-flight, the next turn naturally continues and compaction
    // can happen at that boundary without adding synthetic user input.
    if (event.finishReason === "tool-calls") return;

    // Ensure compaction + continuation happen without extra user intervention.
    // Queue only once per pending compaction cycle.
    if (wasCompactionPending || queuedAutoContinue) return;
    agent.followUp(AUTO_CONTINUE_AFTER_COMPACTION_TEXT);
    queuedAutoContinue = true;
  });

  const summarySystem =
    options.summarySystem ??
    "You are preparing a handoff summary for another coding agent. Output only the requested summary in markdown.";

  const buildSummaryPrompt =
    options.buildSummaryPrompt ??
    ((prefix: string) =>
      [
        "Provide a detailed prompt for continuing our conversation.",
        "Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.",
        "The summary that you construct will be used so that another agent can read it and continue the work.",
        "",
        "When constructing the summary, try to stick to this template:",
        "---",
        "## Goal",
        "",
        "[What goal(s) is the user trying to accomplish?]",
        "",
        "## Instructions",
        "",
        "- [What important instructions did the user give you that are relevant]",
        "- [If there is a plan or spec, include information about it so next agent can continue using it]",
        "",
        "## Discoveries",
        "",
        "[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]",
        "",
        "## Accomplished",
        "",
        "[What work has been completed, what work is still in progress, and what work is left?]",
        "",
        "## Relevant files / directories",
        "",
        "[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]",
        "---",
        "",
        "TRANSCRIPT:",
        prefix,
      ].join("\n"));

  const summaryModel = options.summaryModel ?? "current";

  const transformMessages: TransformMessagesFn = async (
    messages,
    context: TransformMessagesContext,
  ) => {
    const maybeTransformed = options.baseTransformMessages
      ? await options.baseTransformMessages(messages, context)
      : [...messages];

    if (!shouldCompact || inCompaction) return maybeTransformed;

    const lastMessage =
      maybeTransformed.length > 0 ? maybeTransformed[maybeTransformed.length - 1] : undefined;

    // Be conservative: only compact when the context ends with user/tool.
    if (lastMessage?.role === "assistant") return maybeTransformed;

    const suffixStart = chooseSuffixStart([...maybeTransformed], keepLastMessages);
    if (suffixStart <= 0) return maybeTransformed;

    const prefixMessages = maybeTransformed.slice(0, suffixStart);
    const suffixMessages = maybeTransformed.slice(suffixStart);

    // Avoid compaction if there's nothing meaningful to summarize.
    if (prefixMessages.length < 2) return maybeTransformed;

    inCompaction = true;
    try {
      // The synthetic follow-up (if any) is only to keep the loop moving until
      // compaction runs. Once we start compaction, allow future cycles to queue.
      queuedAutoContinue = false;

      const prefixText = renderMessagesForSummary(prefixMessages);
      const prompt = buildSummaryPrompt(prefixText);

      const modelToUse = summaryModel === "current" ? agent.state.model : summaryModel;

      const summaryText = await summarizePrefix({
        model: modelToUse,
        system: summarySystem,
        prompt,
        abortSignal: context.abortSignal,
      });

      const summaryMessage: ModelMessage = {
        role: "user",
        content: `<summary>\n${summaryText.trim()}\n</summary>`,
      };

      const compacted = [summaryMessage, ...suffixMessages];

      // Persist the compacted context and notify downstream.
      agent.replaceMessages(compacted, { reason: "compaction" });

      shouldCompact = false;

      // Outbound-only: apply base transforms (e.g. tool pruning, caching markers)
      // without mutating the canonical transcript we just persisted.
      const outbound = cloneMessages(compacted);
      return options.baseTransformMessages
        ? await options.baseTransformMessages(outbound, context)
        : outbound;
    } finally {
      inCompaction = false;
    }
  };

  agent.setTransformMessages(transformMessages);

  return () => {
    unsubscribe();
    agent.setTransformMessages(options.baseTransformMessages);
  };
}
