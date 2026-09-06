import type { AssistantModelMessage, LanguageModelUsage } from "ai";
import { Result, type Result as ResultType } from "better-result";
import type {
  Response,
  ResponseOutputItem,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import { normalizeToolCallInputValue } from "@stanley2058/lilac-utils/tool-call-input-normalization";
import { AgentAdapterFailure, type AgentOutput, type AgentToolRequest } from "../../agent-adapter";
import type {
  OpenAIProjectedResponse,
  OpenAIProtocolEvent,
  OpenAIResponse,
  OpenAIResponseCodec,
} from "./protocol";

function protocolFailure(message: string): AgentAdapterFailure {
  return new AgentAdapterFailure({ reason: "protocol", replaySafety: "reconcile", message });
}

function usageFromWire(usage: Response["usage"]): LanguageModelUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    inputTokenDetails: {
      cacheReadTokens: cached,
      cacheWriteTokens: undefined,
      noCacheTokens: cached === undefined ? undefined : usage.input_tokens - cached,
    },
    outputTokenDetails: {
      reasoningTokens: reasoning,
      textTokens: reasoning === undefined ? undefined : usage.output_tokens - reasoning,
    },
  };
}

function projectWireResponse(value: Response): OpenAIResponse {
  return {
    id: value.id,
    previousResponseId: value.previous_response_id ?? undefined,
    status: value.status ?? "in_progress",
    output: value.output,
    incompleteReason: value.incomplete_details?.reason,
    usage: usageFromWire(value.usage),
  };
}

function responseFinishReason(
  response: OpenAIResponse,
  hasCalls: boolean,
): OpenAIProjectedResponse["finishReason"] {
  if (hasCalls) return "tool-calls";
  if (response.incompleteReason === "max_output_tokens") return "length";
  if (response.incompleteReason === "content_filter") return "content-filter";
  if (response.status === "failed") return "error";
  return "stop";
}

function supportedItem(item: ResponseOutputItem): boolean {
  return (
    item.type === "message" ||
    item.type === "reasoning" ||
    item.type === "function_call" ||
    item.type === "compaction"
  );
}

function outputKind(type: ResponsesServerEvent["type"]): AgentOutput["kind"] {
  if (type.includes("function_call_arguments")) return "tool-input";
  if (type.includes("reasoning")) return "reasoning";
  return "text";
}

function outputIndex(event: ResponsesServerEvent): number {
  if ("content_index" in event) return event.content_index;
  if ("summary_index" in event) return event.summary_index;
  return 0;
}

function decodeEvent(
  event: ResponsesServerEvent,
): ResultType<OpenAIProtocolEvent, AgentAdapterFailure> {
  switch (event.type) {
    case "response.created":
    case "response.completed":
    case "response.incomplete":
      return Result.ok({
        type: event.type === "response.created" ? "created" : "finished",
        response: projectWireResponse(event.response),
      });
    case "response.failed":
      return Result.ok({
        type: "error",
        message: event.response.error?.message ?? "OpenAI response failed",
        details: event.response.error ?? undefined,
        response: projectWireResponse(event.response),
      });
    case "response.steer.accepted":
      return Result.ok({
        type: "steer-accepted",
        previousResponseId: event.steer.previous_response_id,
        steerId: event.steer.id,
      });
    case "response.steer.pending":
      return Result.ok({
        type: "steer-pending",
        previousResponseId: event.steer.previous_response_id,
        steerId: event.steer.id,
        requiredInput: event.required_input,
      });
    case "response.steer.failed":
      return Result.ok({
        type: "steer-failed",
        previousResponseId: event.steer.previous_response_id,
        steerId: event.steer.id,
        message: event.error.message,
      });
    case "response.output_item.added":
    case "response.output_item.done":
      if (!supportedItem(event.item))
        return Result.err(protocolFailure(`Unsupported OpenAI output item: ${event.item.type}`));
      return Result.ok({
        type: event.type === "response.output_item.added" ? "item-start" : "item-complete",
        item: event.item,
      });
    case "response.content_part.done":
      if (event.part.type === "reasoning_text")
        return Result.err(protocolFailure("Unsupported OpenAI content part: reasoning_text"));
      return Result.ok({
        type: "block-complete",
        index: event.content_index,
        item: {
          type: "message",
          role: "assistant",
          status: "in_progress",
          id: event.item_id,
          content: [event.part],
        },
      });
    case "response.reasoning_summary_part.done":
      return Result.ok({
        type: "block-complete",
        index: event.summary_index,
        item: { type: "reasoning", id: event.item_id, summary: [event.part] },
      });
    case "response.content_part.added":
    case "response.reasoning_summary_part.added":
      if (event.part.type === "reasoning_text") return Result.ok({ type: "ignored" });
      return Result.ok({
        type: "output",
        output: {
          kind: event.part.type === "summary_text" ? "reasoning" : "text",
          phase: "start",
          id: `${event.item_id}:${"content_index" in event ? event.content_index : event.summary_index}`,
        },
      });
    case "response.refusal.delta":
    case "response.refusal.done":
    case "response.output_text.delta":
    case "response.output_text.done":
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_text.done":
    case "response.reasoning_text.delta":
    case "response.reasoning_text.done":
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done": {
      const kind = outputKind(event.type);
      const index = outputIndex(event);
      return Result.ok({
        type: "output",
        output: {
          kind,
          phase: event.type.endsWith(".delta") ? "delta" : "end",
          id: kind === "tool-input" ? event.item_id : `${event.item_id}:${index}`,
          delta: "delta" in event ? event.delta : undefined,
        },
      });
    }
    case "error": {
      const error = "error" in event ? event.error : event;
      return Result.ok({
        type: "error",
        message: error.message,
        details: {
          code: error.code,
          type: error.type,
          param: error.param,
          statusCode: "status" in event ? event.status : undefined,
        },
      });
    }
    default:
      return Result.ok({ type: "ignored" });
  }
}

function projectResponse(
  response: OpenAIResponse,
): ResultType<OpenAIProjectedResponse, AgentAdapterFailure> {
  const content: Exclude<AssistantModelMessage["content"], string> = [];
  const calls: AgentToolRequest[] = [];
  for (const item of response.output) {
    switch (item.type) {
      case "compaction":
        content.push({
          type: "custom",
          kind: "openai.compaction",
          providerOptions: {
            openai: {
              type: "compaction",
              itemId: item.id,
              encryptedContent: item.encrypted_content,
            },
          },
        });
        break;
      case "message":
        for (const part of item.content)
          content.push({
            type: "text",
            text: part.type === "output_text" ? part.text : part.refusal,
            providerOptions: {
              openai: { itemId: item.id, ...(item.phase ? { phase: item.phase } : {}) },
            },
          });
        break;
      case "reasoning":
        for (const part of item.summary.length ? item.summary : [{ text: "" }])
          content.push({
            type: "reasoning",
            text: part.text,
            providerOptions: {
              openai: {
                itemId: item.id,
                reasoningEncryptedContent: item.encrypted_content ?? null,
              },
            },
          });
        break;
      case "function_call": {
        const input = normalizeToolCallInputValue(item.arguments);
        calls.push({ callId: item.call_id, name: item.name, inputJson: item.arguments });
        content.push({
          type: "tool-call",
          toolCallId: item.call_id,
          toolName: item.name,
          input,
          providerOptions: { openai: { itemId: item.id } },
        });
        break;
      }
      default:
        return Result.err(protocolFailure(`Unsupported OpenAI output item: ${item.type}`));
    }
  }
  const assistant: AssistantModelMessage = { role: "assistant", content };
  const finishReason = responseFinishReason(response, calls.length > 0);
  return Result.ok({ messages: [assistant], assistant, calls, finishReason });
}

export const openAIResponseCodec: OpenAIResponseCodec = {
  decode: decodeEvent,
  project: projectResponse,
};
