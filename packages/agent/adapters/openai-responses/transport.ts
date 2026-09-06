import { Result, type Result as ResultType } from "better-result";
import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import type { OpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import { AgentAdapterFailure } from "../../agent-adapter";
import { captureAgentOperation, rethrowAgentPanic } from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";
import { createOpenAIResponsesConnectionPool, type OpenAIResponsesLease } from "./connection";
import { OpenAIResponsesContinuation, isPreviousResponseNotFoundError } from "./continuation";
import { createResponsesEventNormalizer } from "./events";
import { openAIRequestCodec } from "./input";
import { openAIResponseCodec } from "./output";
import type { OpenAIResponse, OpenAIResponseRequest } from "./protocol";
import type { OpenAIResponsesSocket } from "./socket";

type TransportOptions = {
  pool?: ReturnType<typeof createOpenAIResponsesConnectionPool>;
  continuation?: OpenAIResponsesContinuation;
  normalizeRequest?: (
    request: OpenAIResponseRequest,
  ) => ResultType<OpenAIResponseRequest, AgentAdapterFailure>;
  createEventNormalizer?: () => (event: ResponsesServerEvent) => ResponsesServerEvent;
  readTurnState?: (event: ResponsesServerEvent) => string | undefined;
};

export function createResponsesTransport(options: TransportOptions = {}) {
  const pool = options.pool ?? createOpenAIResponsesConnectionPool();
  const continuation = options.continuation ?? new OpenAIResponsesContinuation();
  let connectionId: number | undefined;
  return {
    async connect(
      settings: OpenAIResponsesConnectionOptions,
      signal: AbortSignal,
    ): Promise<ResultType<OpenAIResponsesSocket, AgentAdapterFailure>> {
      const acquired = resultOutcome(await pool.connect(settings, signal));
      if (!acquired.ok) return Result.err(acquired.error);
      const lease = acquired.value;
      if (lease.reusable && connectionId !== lease.connectionId) {
        continuation.invalidateResponseIds();
        connectionId = lease.connectionId;
      }
      return Result.ok(
        observeLease(
          lease,
          lease.reusable ? continuation : new OpenAIResponsesContinuation(),
          options,
          signal,
        ),
      );
    },
    close() {
      continuation.clear();
      pool.close();
    },
  };
}

function observeLease(
  lease: OpenAIResponsesLease,
  continuation: OpenAIResponsesContinuation,
  options: TransportOptions,
  signal: AbortSignal,
): OpenAIResponsesSocket {
  let fullRequest: OpenAIResponseRequest | undefined;
  let optimized = false;
  let retried = false;
  let exposed = false;
  let failed = false;
  let active = false;
  let steered = false;
  let turnState: string | null = null;
  let pending: ResponsesServerEvent[] = [];
  let repair = createResponsesEventNormalizer();
  let normalizeEvent = options.createEventNormalizer?.();
  const normalizeRequest =
    options.normalizeRequest ?? ((request: OpenAIResponseRequest) => Result.ok(request));

  const retainFailure = () => {
    failed = true;
    if (signal.aborted || !fullRequest || steered) {
      continuation.clear();
      return;
    }
    continuation.retainTurnStateRetry(fullRequest, turnState);
  };

  const sendWire = (event: ResponsesClientEvent): ResultType<void, AgentAdapterFailure> => {
    const abort = resultOutcome(captureAgentOperation(() => signal.throwIfAborted()));
    if (!abort.ok) {
      continuation.clear();
      rethrowAgentPanic(abort.error);
      return Result.err(
        new AgentAdapterFailure({
          reason: "cancelled",
          replaySafety: "safe",
          message: "Responses submission cancelled",
          cause: abort.error,
        }),
      );
    }
    return lease.send(event);
  };

  const normalizeFrame = (
    event: ResponsesServerEvent,
  ): ResultType<ResponsesServerEvent[], AgentAdapterFailure> => {
    const captured = resultOutcome(
      captureAgentOperation(() => {
        turnState ??= options.readTurnState?.(event) ?? null;
        return repair(normalizeEvent ? normalizeEvent(event) : event);
      }),
    );
    if (captured.ok) return captured.value;
    retainFailure();
    rethrowAgentPanic(captured.error);
    return Result.err(
      new AgentAdapterFailure({
        reason: "protocol",
        replaySafety: "reconcile",
        message: "Responses event normalization failed",
        cause: captured.error,
      }),
    );
  };

  return {
    managesContinuation: true,
    isOpen: () => lease.isOpen?.() ?? true,
    send(event: ResponsesClientEvent) {
      if (signal.aborted) return sendWire(event);
      active = true;
      if (event.type === "response.steer") {
        steered = true;
        continuation.clear();
        return sendWire(event);
      }
      if (typeof event.model !== "string" || !Array.isArray(event.input))
        return Result.err(
          new AgentAdapterFailure({
            reason: "protocol",
            replaySafety: "safe",
            message: "Responses transport requires a model and full input items",
          }),
        );
      const normalized = resultOutcome(
        normalizeRequest({ ...event, model: event.model, input: event.input }),
      );
      if (!normalized.ok) return Result.err(normalized.error);
      fullRequest = normalized.value;
      const prepared = continuation.prepare(fullRequest);
      optimized = prepared.optimizationEnabled;
      turnState = prepared.turnState;
      retried = false;
      exposed = false;
      pending = [];
      repair = createResponsesEventNormalizer();
      normalizeEvent = options.createEventNormalizer?.();
      return sendWire(withTurnState(prepared.payload, turnState)).mapError((error) => {
        retainFailure();
        return error;
      });
    },
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of lease.events) {
          if (signal.aborted) {
            continuation.clear();
            return;
          }
          const incoming = resultOutcome(frame);
          if (!incoming.ok) {
            retainFailure();
            yield Result.err(incoming.error);
            return;
          }
          const repaired = resultOutcome(normalizeFrame(incoming.value));
          if (!repaired.ok) {
            retainFailure();
            yield Result.err(repaired.error);
            return;
          }
          for (const event of repaired.value) {
            const decoded = resultOutcome(openAIResponseCodec.decode(event));
            if (!decoded.ok) {
              retainFailure();
              yield Result.err(decoded.error);
              return;
            }
            if (
              decoded.value.type === "error" &&
              fullRequest &&
              optimized &&
              !retried &&
              !exposed &&
              !steered &&
              isPreviousResponseNotFoundError(decoded.value)
            ) {
              retried = true;
              pending = [];
              repair = createResponsesEventNormalizer();
              normalizeEvent = options.createEventNormalizer?.();
              const sent = resultOutcome(sendWire(withTurnState(fullRequest, turnState)));
              if (!sent.ok) {
                retainFailure();
                yield Result.err(sent.error);
                return;
              }
              continue;
            }
            if (decoded.value.type === "ignored") continue;
            if (optimized && !exposed && decoded.value.type === "created") {
              pending.push(event);
              continue;
            }
            for (const buffered of pending.splice(0)) yield Result.ok(buffered);
            exposed = true;
            if (decoded.value.type === "error") retainFailure();
            if (decoded.value.type === "finished") {
              active = false;
              if (
                fullRequest &&
                !steered &&
                fullRequest.previous_response_id == null &&
                fullRequest.conversation == null
              ) {
                await storeContinuation(
                  continuation,
                  fullRequest,
                  decoded.value.response,
                  turnState,
                  normalizeRequest,
                  signal,
                );
              }
            }
            yield Result.ok(event);
          }
        }
        if (active) retainFailure();
      },
    },
    close() {
      if (signal.aborted) continuation.clear();
      lease.release({ reusable: !failed && !active && !signal.aborted });
    },
  };
}

function withTurnState(
  request: OpenAIResponseRequest,
  turnState: string | null,
): OpenAIResponseRequest {
  if (!turnState) return request;
  return {
    ...request,
    client_metadata: { ...request.client_metadata, "x-codex-turn-state": turnState },
  };
}

async function storeContinuation(
  continuation: OpenAIResponsesContinuation,
  request: OpenAIResponseRequest,
  response: OpenAIResponse,
  turnState: string | null,
  normalizeRequest: NonNullable<TransportOptions["normalizeRequest"]>,
  signal: AbortSignal,
): Promise<void> {
  const projected = resultOutcome(openAIResponseCodec.project(response));
  if (!projected.ok) return;
  const replay = resultOutcome(
    await openAIRequestCodec.messages(projected.value.messages, { store: request.store !== false }),
  );
  if (!replay.ok) return;
  const normalized = resultOutcome(normalizeRequest({ ...request, input: replay.value }));
  if (!normalized.ok || signal.aborted) return;
  continuation.store({
    request,
    responseId: response.id,
    replayInput: normalized.value.input,
    needsClientFollowUp: projected.value.calls.length > 0,
    turnState,
  });
}
