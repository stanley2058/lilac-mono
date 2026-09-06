import { createHash } from "node:crypto";

import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { OpenAIProtocolEvent, OpenAIResponseRequest } from "./protocol";

const CONTINUATION_CACHE_TTL_MS = 30 * 60 * 1000;

type ContinuationEntry = {
  requestShapeHash: string;
  prefix: ResponseInputItem[];
  responseId: string | null;
  turnState: string | null;
  turnStateMatch: "prefix" | "exact";
  createdAt: number;
};

export type OpenAIResponsesContinuationResult = {
  payload: OpenAIResponseRequest;
  optimizationEnabled: boolean;
  optimizationReason:
    | "no_continuation_state"
    | "existing_previous_response_id"
    | "existing_conversation"
    | "request_shape_changed"
    | "not_prefix_extension"
    | "incremental_replay";
  turnState: string | null;
};

export class OpenAIResponsesContinuation {
  private entry: ContinuationEntry | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  prepare(request: OpenAIResponseRequest): OpenAIResponsesContinuationResult {
    const entry = this.entry;
    // Submission consumes the previous state, so an interrupted request cannot reuse a stale chain.
    this.entry = undefined;
    const payload = structuredClone(request);
    if (request.previous_response_id != null)
      return unchanged(payload, "existing_previous_response_id");
    if (request.conversation != null) return unchanged(payload, "existing_conversation");
    if (!entry) return unchanged(payload, "no_continuation_state");
    if (this.now() - entry.createdAt > CONTINUATION_CACHE_TTL_MS) entry.responseId = null;
    if (!entry.responseId && !entry.turnState) return unchanged(payload, "no_continuation_state");

    const suffix = inputSuffix(request.input, entry.prefix);
    if (!suffix) return unchanged(payload, "not_prefix_extension");
    if (entry.turnStateMatch === "exact" && suffix.length > 0)
      return unchanged(payload, "not_prefix_extension");
    if (entry.turnStateMatch === "prefix" && suffix.length === 0)
      return unchanged(payload, "not_prefix_extension");
    if (!entry.responseId) return unchanged(payload, "no_continuation_state", entry.turnState);
    if (entry.requestShapeHash !== requestShapeHash(request))
      return unchanged(payload, "request_shape_changed", entry.turnState);
    return {
      payload: { ...payload, previous_response_id: entry.responseId, input: suffix },
      optimizationEnabled: true,
      optimizationReason: "incremental_replay",
      turnState: entry.turnState,
    };
  }

  store(input: {
    request: OpenAIResponseRequest;
    responseId: string;
    replayInput: readonly ResponseInputItem[];
    needsClientFollowUp: boolean;
    turnState: string | null;
  }): void {
    const prefix = [...input.request.input, ...input.replayInput];
    this.entry = undefined;
    if (prefix.length === 0) return;
    this.entry = {
      requestShapeHash: requestShapeHash(input.request),
      prefix: structuredClone(prefix),
      responseId: input.responseId,
      turnState: input.needsClientFollowUp ? input.turnState : null,
      turnStateMatch: "prefix",
      createdAt: this.now(),
    };
  }

  retainTurnStateRetry(request: OpenAIResponseRequest, turnState: string | null): void {
    this.entry = undefined;
    if (!turnState) return;
    this.entry = {
      requestShapeHash: requestShapeHash(request),
      prefix: structuredClone(request.input),
      responseId: null,
      turnState,
      turnStateMatch: "exact",
      createdAt: this.now(),
    };
  }

  invalidateResponseIds(): void {
    if (this.entry) this.entry.responseId = null;
  }

  clear(): void {
    this.entry = undefined;
  }
}

export function isPreviousResponseNotFoundError(
  event: Extract<OpenAIProtocolEvent, { type: "error" }>,
): boolean {
  const message = event.message.toLowerCase();
  return (
    event.details?.code === "previous_response_not_found" ||
    event.details?.param === "previous_response_id" ||
    (message.includes("previous response") && message.includes("not found"))
  );
}

function unchanged(
  payload: OpenAIResponseRequest,
  optimizationReason: OpenAIResponsesContinuationResult["optimizationReason"],
  turnState: string | null = null,
): OpenAIResponsesContinuationResult {
  return { payload, optimizationEnabled: false, optimizationReason, turnState };
}

function inputSuffix(
  input: readonly ResponseInputItem[],
  prefix: readonly ResponseInputItem[],
): ResponseInputItem[] | null {
  if (prefix.length > input.length) return null;
  for (let index = 0; index < prefix.length; index += 1) {
    if (stableJsonStringify(prefix[index]) !== stableJsonStringify(input[index])) return null;
  }
  return structuredClone(input.slice(prefix.length));
}

function requestShapeHash(request: OpenAIResponseRequest): string {
  const { input: _input, previous_response_id: _previousResponseId, ...settings } = request;
  return createHash("sha256").update(stableJsonStringify(settings)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`;
}
