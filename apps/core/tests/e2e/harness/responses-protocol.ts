/**
 * The OpenAI Responses wire protocol for the scripted model: request normalization (including
 * `previous_response_id` and `item_reference` continuations) and response event encoding shared by
 * the SSE, JSON and WebSocket transports.
 */
import type { ModelMessage, ModelReply, ModelRequest } from "./scripted-model";

type Item = Record<string, unknown>;

function textParts(content: unknown): { text: string; files: string[] } {
  if (typeof content === "string") return { text: content, files: [] };
  if (!Array.isArray(content)) return { text: "", files: [] };
  const texts: string[] = [];
  const files: string[] = [];
  for (const part of content as Item[]) {
    if (typeof part.text === "string") texts.push(part.text);
    else if (part.type === "input_image")
      files.push(String(part.image_url ?? part.file_id ?? "image"));
    else if (part.type === "input_file")
      files.push(String(part.filename ?? part.file_id ?? "file"));
  }
  return { text: texts.join("\n"), files };
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return textParts(output).text || JSON.stringify(output);
}

/** Conversation state the fake server keeps so continuations can be expanded. */
export class ResponsesStore {
  readonly responses = new Map<string, ModelMessage[]>();
  readonly items = new Map<string, Item>();
}

export function normalizeResponses(
  body: Item,
  protocol: "responses-sse" | "responses-ws",
  store: ResponsesStore,
): ModelRequest | { error: string; code: string } {
  const messages: ModelMessage[] = [];
  const instructions: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) {
    instructions.push(body.instructions);
    messages.push({ role: "system", text: body.instructions });
  }
  const previous = body.previous_response_id;
  if (typeof previous === "string") {
    const prior = store.responses.get(previous);
    if (!prior)
      return {
        error: `Previous response with id '${previous}' not found.`,
        code: "previous_response_not_found",
      };
    messages.push(...prior.filter((message) => message.role !== "system"));
  }
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : ((body.input ?? []) as Item[]);
  for (const raw of input) {
    const item = raw.type === "item_reference" ? store.items.get(String(raw.id)) : raw;
    if (!item)
      return { error: `Item with id '${String(raw.id)}' not found.`, code: "item_not_found" };
    const last = messages.at(-1);
    switch (true) {
      case item.type === "function_call": {
        const call = {
          id: String(item.call_id),
          name: String(item.name),
          args: JSON.parse(String(item.arguments || "{}")) as unknown,
        };
        if (last?.role === "assistant") last.toolCalls.push(call);
        else messages.push({ role: "assistant", text: "", toolCalls: [call] });
        break;
      }
      case item.type === "function_call_output":
        messages.push({
          role: "tool",
          callId: String(item.call_id),
          output: outputText(item.output),
        });
        break;
      case item.type === "reasoning":
        break;
      case item.role === "system" || item.role === "developer": {
        const { text } = textParts(item.content);
        instructions.push(text);
        messages.push({ role: "system", text });
        break;
      }
      case item.role === "user":
        messages.push({ role: "user", ...textParts(item.content) });
        break;
      case item.role === "assistant": {
        const { text } = textParts(item.content);
        if (last?.role === "assistant" && last.toolCalls.length === 0) last.text += text;
        else messages.push({ role: "assistant", text, toolCalls: [] });
        break;
      }
    }
  }
  const tools = ((body.tools ?? []) as Item[]).filter((tool) => typeof tool.name === "string");
  return {
    protocol,
    model: String(body.model),
    instructions: instructions.join("\n\n"),
    messages,
    tools: tools.map((tool) => String(tool.name)),
    toolSchemas: Object.fromEntries(tools.map((tool) => [String(tool.name), tool.parameters])),
    stream: body.stream === true || protocol === "responses-ws",
    raw: body,
  };
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Encodes one scripted reply as the Responses event sequence and records it for continuations. */
export function encodeResponse(
  request: ModelRequest,
  reply: ModelReply,
  store: ResponsesStore,
): { response: Item; events: Item[] } {
  const responseId = id("resp");
  const items: Item[] = [];
  if (reply.text)
    items.push({
      type: "message",
      id: id("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    });
  for (const call of reply.toolCalls ?? [])
    items.push({
      type: "function_call",
      id: id("fc"),
      call_id: call.id ?? id("call"),
      name: call.name,
      arguments: JSON.stringify(call.args),
      status: "completed",
    });
  const base = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: request.model,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    error: null,
    incomplete_details: null,
  };
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  };
  const completed = { ...base, status: "completed", output: items, usage };
  let sequence = 0;
  const events: Item[] = [];
  const push = (event: Item) => events.push({ ...event, sequence_number: sequence++ });
  push({
    type: "response.created",
    response: { ...base, status: "in_progress", output: [], usage: null },
  });
  push({
    type: "response.in_progress",
    response: { ...base, status: "in_progress", output: [], usage: null },
  });
  for (const [outputIndex, item] of items.entries()) {
    if (item.type === "message") {
      const text = String((item.content as Item[])[0]!.text);
      push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", content: [] },
      });
      push({
        type: "response.content_part.added",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      for (const delta of text.match(/[\s\S]{1,24}/gu) ?? [])
        push({
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta,
          logprobs: [],
        });
      push({
        type: "response.output_text.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
        logprobs: [],
      });
      push({
        type: "response.content_part.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      });
    } else {
      push({
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      push({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      push({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        name: item.name,
        arguments: item.arguments,
      });
    }
    push({ type: "response.output_item.done", output_index: outputIndex, item });
    store.items.set(String(item.id), item);
  }
  push({ type: "response.completed", response: completed });
  const conversation: ModelMessage[] = [
    ...request.messages,
    {
      role: "assistant",
      text: reply.text ?? "",
      toolCalls: items
        .filter((item) => item.type === "function_call")
        .map((item) => ({
          id: String(item.call_id),
          name: String(item.name),
          args: JSON.parse(String(item.arguments)) as unknown,
        })),
    },
  ];
  store.responses.set(responseId, conversation);
  return { response: completed, events };
}

export function responsesError(
  message: string,
  code = "invalid_request_error",
  status = 400,
): Item {
  return {
    type: "error",
    sequence_number: 0,
    status,
    error: {
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code,
      message,
      param: null,
    },
  };
}
