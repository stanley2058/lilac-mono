import { z } from "zod";
import { type Result as ResultType } from "better-result";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import {
  createCodexResponsesEventNormalizer,
  normalizeCodexResponsesRequestRecordResult,
} from "@stanley2058/lilac-utils/model-provider";
import { AgentAdapterFailure } from "../../agent-adapter";
import type { OpenAIResponseRequest } from "../openai-responses/protocol";

export function normalizeCodexWebSocketRequest(
  request: OpenAIResponseRequest,
): ResultType<OpenAIResponseRequest, AgentAdapterFailure> {
  return normalizeCodexResponsesRequestRecordResult({ ...request, stream: true })
    .mapError(
      (error) =>
        new AgentAdapterFailure({
          reason: "protocol",
          replaySafety: "safe",
          message: error.message,
        }),
    )
    .map((normalized) => {
      // Streaming is implicit in response.create. The HTTP-only flag must not
      // reach the WebSocket endpoint, even though Codex requires it for HTTP.
      delete normalized.stream;
      return { ...normalized, type: "response.create" } as OpenAIResponseRequest;
    });
}

export function createCodexWebSocketEventNormalizer(): (
  event: ResponsesServerEvent,
) => ResponsesServerEvent {
  const normalize = createCodexResponsesEventNormalizer();
  return (event) => ({ ...event, ...normalize({ ...event }) });
}

const codexTurnStateEventSchema = z.object({
  type: z.literal("response.metadata"),
  headers: z.record(z.string(), z.unknown()),
});

export function readCodexTurnState(event: ResponsesServerEvent): string | undefined {
  const parsed = codexTurnStateEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  for (const [name, value] of Object.entries(parsed.data.headers)) {
    if (name.toLowerCase() !== "x-codex-turn-state") continue;
    if (typeof value === "string") return value || undefined;
    if (!Array.isArray(value)) return undefined;
    const state = value.find((entry) => typeof entry === "string");
    return typeof state === "string" && state.length > 0 ? state : undefined;
  }
  return undefined;
}
