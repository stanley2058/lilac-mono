import type { AssistantModelMessage, LanguageModelUsage } from "ai";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import { AgentAdapterFailure, type AgentOutput, type AgentToolRequest } from "../../agent-adapter";
import { resultOutcome } from "../../agent-runtime-support";
import { captureAgentOperation, rethrowAgentPanic } from "../../failure-adapters";
import type {
  OpenAIProjectedResponse,
  OpenAIProtocolEvent,
  OpenAIResponse,
  OpenAIResponseCodec,
} from "./protocol";

const jsonObject = z.record(z.string(), z.json());
const envelopeSchema = z.object({ type: z.string() }).catchall(z.json());
const errorSchema = z.object({
  message: z.string(),
  code: z.string().nullable().optional(),
  type: z.string().optional(),
  param: z.string().nullable().optional(),
  status: z.number().optional(),
});
const responseSchema = z.object({
  id: z.string().min(1),
  previous_response_id: z.string().nullable().optional(),
  status: z.string(),
  output: z.array(jsonObject),
  incomplete_details: z.object({ reason: z.string() }).nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      total_tokens: z.number(),
      input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
    })
    .nullable()
    .optional(),
  error: errorSchema.nullable().optional(),
});
const steerSchema = z.object({
  id: z.string().optional(),
  previous_response_id: z.string().min(1),
});
const itemStartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    id: z.string(),
    role: z.literal("assistant"),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
  }),
  z.object({
    type: z.literal("function_call"),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
  }),
  z.object({ type: z.literal("reasoning"), id: z.string() }),
  z.object({ type: z.literal("compaction"), id: z.string() }),
]);
const itemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("compaction"), id: z.string(), encrypted_content: z.string() }),
  z.object({
    type: z.literal("message"),
    id: z.string(),
    role: z.literal("assistant"),
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    content: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("output_text"), text: z.string() }),
        z.object({ type: z.literal("refusal"), refusal: z.string() }),
      ]),
    ),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })),
    encrypted_content: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("function_call"),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
]);

function protocolFailure(message: string): AgentAdapterFailure {
  return new AgentAdapterFailure({ reason: "protocol", replaySafety: "reconcile", message });
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): ResultType<T, AgentAdapterFailure> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    return Result.err(protocolFailure("Malformed OpenAI Responses event or output item"));
  return Result.ok(parsed.data);
}

function decodeJson(
  data: string,
): ResultType<z.infer<ReturnType<typeof z.json>>, AgentAdapterFailure> {
  const captured = resultOutcome(
    captureAgentOperation(() => parseSchema(z.json(), JSON.parse(data))),
  );
  if (!captured.ok) {
    rethrowAgentPanic(captured.error);
    return Result.err(protocolFailure("OpenAI Responses sent invalid JSON"));
  }
  return captured.value;
}

function usageFromWire(
  usage: z.infer<typeof responseSchema>["usage"],
): LanguageModelUsage | undefined {
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

function projectWireResponse(value: z.infer<typeof responseSchema>): OpenAIResponse {
  return {
    id: value.id,
    previousResponseId: value.previous_response_id ?? undefined,
    status: value.status,
    output: value.output,
    incompleteReason: value.incomplete_details?.reason,
    usage: usageFromWire(value.usage),
  };
}

function outputKind(type: string): AgentOutput["kind"] {
  if (type.includes("function_call_arguments")) return "tool-input";
  if (type.includes("reasoning")) return "reasoning";
  return "text";
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

function decodeOutput(
  envelope: z.infer<typeof envelopeSchema>,
): ResultType<OpenAIProtocolEvent, AgentAdapterFailure> {
  const kind = outputKind(envelope.type);
  const phase: AgentOutput["phase"] = envelope.type.endsWith(".delta") ? "delta" : "end";
  return parseSchema(
    z.object({
      item_id: z.string(),
      delta: z.string().optional(),
      content_index: z.number().optional(),
      summary_index: z.number().optional(),
    }),
    envelope,
  ).andThen((value) => {
    if (phase === "delta" && value.delta === undefined)
      return Result.err(protocolFailure("OpenAI output delta omitted its text"));
    return Result.ok({
      type: "output",
      output: {
        kind,
        phase,
        id:
          kind === "tool-input"
            ? value.item_id
            : `${value.item_id}:${value.content_index ?? value.summary_index ?? 0}`,
        delta: value.delta,
      },
    } satisfies OpenAIProtocolEvent);
  });
}

function decodeOpenAIWireValue(
  value: z.infer<ReturnType<typeof z.json>>,
): ResultType<OpenAIProtocolEvent, AgentAdapterFailure> {
  return Result.gen(function* () {
    const envelope = yield* parseSchema(envelopeSchema, value);
    switch (envelope.type) {
      case "response.created":
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = yield* parseSchema(responseSchema, envelope.response);
        if (envelope.type === "response.failed")
          return Result.ok({
            type: "error",
            message: response.error?.message ?? "OpenAI response failed",
            details: response.error
              ? { ...response.error, statusCode: response.error.status }
              : undefined,
            response: projectWireResponse(response),
          } satisfies OpenAIProtocolEvent);
        return Result.ok({
          type: envelope.type === "response.created" ? "created" : "finished",
          response: projectWireResponse(response),
        } satisfies OpenAIProtocolEvent);
      }
      case "response.steer.accepted":
      case "response.steer.pending":
      case "response.steer.failed": {
        const steer = yield* parseSchema(steerSchema, envelope.steer);
        if (envelope.type === "response.steer.pending") {
          const requiredInput = yield* parseSchema(
            z.array(jsonObject).min(1),
            envelope.required_input,
          );
          for (const required of requiredInput)
            yield* parseSchema(z.object({ type: z.string() }), required);
          return Result.ok({
            type: "steer-pending",
            previousResponseId: steer.previous_response_id,
            steerId: steer.id,
            requiredInput,
          } satisfies OpenAIProtocolEvent);
        }
        if (envelope.type === "response.steer.failed") {
          const error = yield* parseSchema(z.object({ message: z.string() }), envelope.error);
          return Result.ok({
            type: "steer-failed",
            previousResponseId: steer.previous_response_id,
            steerId: steer.id,
            message: error.message,
          } satisfies OpenAIProtocolEvent);
        }
        if (!steer.id) return Result.err(protocolFailure("Accepted steering omitted its ID"));
        return Result.ok({
          type: "steer-accepted",
          previousResponseId: steer.previous_response_id,
          steerId: steer.id,
        } satisfies OpenAIProtocolEvent);
      }
      case "response.output_item.done": {
        const item = yield* parseSchema(jsonObject, envelope.item);
        yield* parseSchema(itemSchema, item);
        return Result.ok({ type: "item-complete", item } satisfies OpenAIProtocolEvent);
      }
      case "response.output_item.added": {
        const item = yield* parseSchema(jsonObject, envelope.item);
        yield* parseSchema(itemStartSchema, item);
        return Result.ok({ type: "item-start", item } satisfies OpenAIProtocolEvent);
      }
      case "response.content_part.done":
      case "response.reasoning_summary_part.done": {
        const block = yield* parseSchema(
          z.object({
            item_id: z.string(),
            content_index: z.number().int().nonnegative().optional(),
            summary_index: z.number().int().nonnegative().optional(),
            part: jsonObject,
          }),
          envelope,
        );
        if (envelope.type === "response.reasoning_summary_part.done") {
          const part = yield* parseSchema(
            z.object({ type: z.literal("summary_text"), text: z.string() }),
            block.part,
          );
          return Result.ok({
            type: "block-complete",
            index: block.summary_index ?? 0,
            item: { type: "reasoning", id: block.item_id, summary: [part] },
          } satisfies OpenAIProtocolEvent);
        }
        const part = yield* parseSchema(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("output_text"), text: z.string() }),
            z.object({ type: z.literal("refusal"), refusal: z.string() }),
          ]),
          block.part,
        );
        return Result.ok({
          type: "block-complete",
          index: block.content_index ?? 0,
          item: { type: "message", role: "assistant", id: block.item_id, content: [part] },
        } satisfies OpenAIProtocolEvent);
      }
      case "response.content_part.added":
      case "response.reasoning_summary_part.added": {
        const part = yield* parseSchema(
          z.object({
            item_id: z.string(),
            content_index: z.number().optional(),
            summary_index: z.number().optional(),
            part: z.object({ type: z.string() }),
          }),
          envelope,
        );
        if (
          part.part.type !== "output_text" &&
          part.part.type !== "refusal" &&
          part.part.type !== "summary_text"
        )
          return Result.ok({ type: "ignored" } satisfies OpenAIProtocolEvent);
        return Result.ok({
          type: "output",
          output: {
            kind: part.part.type === "summary_text" ? "reasoning" : "text",
            phase: "start",
            id: `${part.item_id}:${part.content_index ?? part.summary_index ?? 0}`,
          },
        } satisfies OpenAIProtocolEvent);
      }
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
        return Result.ok(yield* decodeOutput(envelope));
      case "error": {
        const error = yield* parseSchema(errorSchema, envelope.error ?? envelope);
        return Result.ok({
          type: "error",
          message: error.message,
          details: {
            code: error.code,
            type: error.type,
            param: error.param,
            statusCode: error.status,
          },
        } satisfies OpenAIProtocolEvent);
      }
      default:
        return Result.ok({ type: "ignored" } satisfies OpenAIProtocolEvent);
    }
  });
}

function projectResponse(
  response: OpenAIResponse,
): ResultType<OpenAIProjectedResponse, AgentAdapterFailure> {
  return Result.gen(function* () {
    const content: Exclude<AssistantModelMessage["content"], string> = [];
    const calls: AgentToolRequest[] = [];
    for (const raw of response.output) {
      const item = yield* parseSchema(itemSchema, raw);
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
          const input = yield* decodeJson(item.arguments);
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
      }
    }
    const assistant: AssistantModelMessage = { role: "assistant", content };
    const finishReason = responseFinishReason(response, calls.length > 0);
    return Result.ok({ messages: [assistant], assistant, calls, finishReason });
  });
}

export const openAIResponseCodec: OpenAIResponseCodec = {
  decode(data) {
    return decodeJson(data).andThen(decodeOpenAIWireValue);
  },
  project: projectResponse,
};
