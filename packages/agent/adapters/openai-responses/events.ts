import { Result, type Result as ResultType } from "better-result";
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import { AgentAdapterFailure } from "../../agent-adapter";
import { readResponsesTerminalError } from "./errors";

type ResponseDraft = {
  response?: Response;
  items: Map<string, ResponseOutputItem>;
  indices: Map<string, number>;
  completed: Set<string>;
};

// Codex can omit array entries in completed items after streaming their contents.
function mergeParts<T extends object>(base: readonly T[], incoming: readonly T[]): T[] {
  const parts = base.map((part) => ({ ...part }));
  for (let index = 0; index < incoming.length; index++) {
    const part = incoming[index];
    if (part) parts[index] = { ...parts[index], ...part };
  }
  return parts;
}

function mergeContent(
  base: ResponseOutputMessage["content"],
  incoming: ResponseOutputMessage["content"],
): ResponseOutputMessage["content"] {
  const parts = mergeParts(base, incoming);
  for (const [index, part] of parts.entries()) {
    const previous = base[index];
    if (previous?.type !== "output_text" || part.type !== "output_text") continue;
    parts[index] = {
      ...part,
      annotations: mergeParts(previous.annotations ?? [], part.annotations ?? []),
    };
  }
  return parts;
}

function mergeItem(
  base: ResponseOutputItem | undefined,
  item: ResponseOutputItem,
): ResponseOutputItem {
  if (item.type === "message")
    return {
      ...(base?.type === "message" ? base : undefined),
      ...item,
      content: mergeContent(
        base?.type === "message" ? (base.content ?? []) : [],
        item.content ?? [],
      ),
    };
  if (item.type === "reasoning")
    return {
      ...(base?.type === "reasoning" ? base : undefined),
      ...item,
      summary: mergeParts(
        base?.type === "reasoning" ? (base.summary ?? []) : [],
        item.summary ?? [],
      ),
    };
  if (item.type === "function_call")
    return { ...(base?.type === "function_call" ? base : undefined), ...item };
  if (item.type === "compaction")
    return { ...(base?.type === "compaction" ? base : undefined), ...item };
  return item;
}

function itemKey(item: ResponseOutputItem, index: number): string {
  return item.id ?? `output:${index}`;
}

function rememberItem(
  draft: ResponseDraft,
  item: ResponseOutputItem,
  index?: number,
): ResponseOutputItem {
  const outputIndex = index ?? draft.items.size;
  const key = itemKey(item, outputIndex);
  const merged = mergeItem(draft.items.get(key), item);
  draft.items.set(key, merged);
  if (!draft.indices.has(key)) draft.indices.set(key, outputIndex);
  return merged;
}

function messageDraft(draft: ResponseDraft, id: string): ResponseOutputMessage {
  const existing = draft.items.get(id);
  if (existing?.type === "message") return existing;
  return { type: "message", id, role: "assistant", status: "in_progress", content: [] };
}

function reasoningDraft(draft: ResponseDraft, id: string): ResponseReasoningItem {
  const existing = draft.items.get(id);
  if (existing?.type === "reasoning") return existing;
  return { type: "reasoning", id, summary: [] };
}

function functionDraft(draft: ResponseDraft, id: string): ResponseFunctionToolCall {
  const existing = draft.items.get(id);
  if (existing?.type === "function_call") return existing;
  return { type: "function_call", id, call_id: "", name: "", arguments: "" };
}

function updateDraft(draft: ResponseDraft, event: ResponsesServerEvent): void {
  switch (event.type) {
    case "response.content_part.added":
    case "response.content_part.done": {
      if (event.part.type === "reasoning_text") return;
      const item = messageDraft(draft, event.item_id);
      const content = [...item.content];
      content[event.content_index] = event.part;
      rememberItem(draft, { ...item, content }, event.output_index);
      return;
    }
    case "response.output_text.delta":
    case "response.output_text.done": {
      const item = messageDraft(draft, event.item_id);
      const content = [...item.content];
      const existing = content[event.content_index];
      const part =
        existing?.type === "output_text"
          ? existing
          : { type: "output_text" as const, text: "", annotations: [] };
      content[event.content_index] = {
        ...part,
        text:
          event.type === "response.output_text.delta" ? `${part.text}${event.delta}` : event.text,
      };
      rememberItem(draft, { ...item, content }, event.output_index);
      return;
    }
    case "response.refusal.delta":
    case "response.refusal.done": {
      const item = messageDraft(draft, event.item_id);
      const content = [...item.content];
      const existing = content[event.content_index];
      const refusal = existing?.type === "refusal" ? existing.refusal : "";
      content[event.content_index] = {
        type: "refusal",
        refusal:
          event.type === "response.refusal.delta" ? `${refusal}${event.delta}` : event.refusal,
      };
      rememberItem(draft, { ...item, content }, event.output_index);
      return;
    }
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done": {
      const item = reasoningDraft(draft, event.item_id);
      const summary = [...item.summary];
      summary[event.summary_index] = event.part;
      rememberItem(draft, { ...item, summary }, event.output_index);
      return;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_text.done": {
      const item = reasoningDraft(draft, event.item_id);
      const summary = [...item.summary];
      const part = summary[event.summary_index] ?? { type: "summary_text", text: "" };
      summary[event.summary_index] = {
        ...part,
        text:
          event.type === "response.reasoning_summary_text.delta"
            ? `${part.text}${event.delta}`
            : event.text,
      };
      rememberItem(draft, { ...item, summary }, event.output_index);
      return;
    }
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done": {
      const item = functionDraft(draft, event.item_id);
      rememberItem(
        draft,
        {
          ...item,
          arguments:
            event.type === "response.function_call_arguments.delta"
              ? `${item.arguments ?? ""}${event.delta}`
              : event.arguments,
        },
        event.output_index,
      );
      return;
    }
    default:
      return;
  }
}

function terminalEvents(
  draft: ResponseDraft,
  event: Extract<
    ResponsesServerEvent,
    { type: "response.completed" | "response.incomplete" | "response.failed" }
  >,
): ResultType<ResponsesServerEvent[], AgentAdapterFailure> {
  const base = { ...draft.response, ...event.response };
  const error = readResponsesTerminalError(event);
  if (error && !base.id)
    return Result.ok([
      {
        type: "error",
        error: {
          message: error.message,
          code: error.details.code,
          type: error.details.type,
          param: error.details.param,
        },
        status: error.details.statusCode,
        sequence_number: event.sequence_number,
      },
    ]);
  if (!base?.id)
    return Result.err(
      new AgentAdapterFailure({
        reason: "protocol",
        replaySafety: "reconcile",
        message: "Responses terminal event has no response identity",
      }),
    );
  for (const [index, item] of (event.response?.output ?? []).entries())
    rememberItem(draft, item, index);
  const entries = [...draft.items.entries()].sort(
    ([left], [right]) => (draft.indices.get(left) ?? 0) - (draft.indices.get(right) ?? 0),
  );
  const output = entries.map(([, item]) => item);
  let terminalStatus: Response["status"] = "completed";
  if (event.type === "response.incomplete") terminalStatus = "incomplete";
  if (event.type === "response.failed") terminalStatus = "failed";
  const response: Response = {
    ...draft.response,
    ...base,
    status: event.response?.status ?? terminalStatus,
    output,
  };
  if (readResponsesTerminalError({ ...event, response }))
    return Result.ok([{ ...event, type: "response.failed", response }]);
  const events: ResponsesServerEvent[] = [];
  for (const [key, item] of entries) {
    if (draft.completed.has(key)) continue;
    events.push({
      type: "response.output_item.done",
      item,
      output_index: draft.indices.get(key) ?? 0,
      sequence_number: event.sequence_number,
    });
  }
  events.push({ ...event, response });
  return Result.ok(events);
}

export function createResponsesEventNormalizer(): (
  event: ResponsesServerEvent,
) => ResultType<ResponsesServerEvent[], AgentAdapterFailure> {
  const responses = new Map<string, ResponseDraft>();
  let active: ResponseDraft = { items: new Map(), indices: new Map(), completed: new Set() };

  function owner(id: string | undefined): ResponseDraft {
    if (!id) return active;
    for (const draft of responses.values()) {
      if (draft.items.has(id)) return draft;
    }
    return active;
  }

  return (event) => {
    switch (event.type) {
      case "response.created": {
        active = {
          response: event.response,
          items: new Map(),
          indices: new Map(),
          completed: new Set(),
        };
        if (event.response?.id) responses.set(event.response.id, active);
        for (const [index, item] of (event.response?.output ?? []).entries())
          rememberItem(active, item, index);
        return Result.ok([event]);
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const draft = owner(event.item.id);
        const item = rememberItem(draft, event.item, event.output_index);
        if (event.type === "response.output_item.done")
          draft.completed.add(itemKey(item, event.output_index ?? draft.items.size - 1));
        return Result.ok([{ ...event, item }]);
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const draft = responses.get(event.response?.id) ?? active;
        const normalized = terminalEvents(draft, event);
        if (draft.response?.id) responses.delete(draft.response.id);
        if (draft === active)
          active = { items: new Map(), indices: new Map(), completed: new Set() };
        return normalized;
      }
      case "error":
        responses.clear();
        active = { items: new Map(), indices: new Map(), completed: new Set() };
        return Result.ok([event]);
      default:
        updateDraft(owner("item_id" in event ? event.item_id : undefined), event);
        return Result.ok([event]);
    }
  };
}
