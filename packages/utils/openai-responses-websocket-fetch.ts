import { createHash } from "node:crypto";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { ResponsesTransportMode } from "./env";
import { captureResultOutcome, isPanic, isRecord, settleSyncResult } from "./runtime-utils";

import {
  connectOpenAIResponsesWebSocket,
  openAIResponsesWebSocketUrl,
  toOpenAIResponsesWebSocketHeaders,
} from "./openai-responses-connection";
const WEBSOCKET_OPEN_STATE = 1;
const CONTINUATION_CACHE_TTL_MS = 30 * 60 * 1000;
const RESPONSES_WEBSOCKET_TIMEOUT_MS = 30_000;

export type CreateOpenAIResponsesWebSocketFetchOptions = {
  mode: ResponsesTransportMode;
  url?: string | ((requestUrl: URL) => string);
  fetch?: typeof globalThis.fetch;
  completionEventTypes?: readonly string[];
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  createEventNormalizer?: () => (event: Record<string, unknown>) => Record<string, unknown>;
  idleTimeoutMs?: number;
  turnStateHeaderName?: string;
  onTransportSelected?: (details: ResponsesTransportSelectionDetails) => void;
  onAutoFallback?: (details: {
    reason: "websocket_connect_failed";
    requestUrl: string;
    errorMessage?: string;
  }) => void;
};

export type OpenAIResponsesWebSocketFetch = typeof globalThis.fetch & {
  close: () => void;
};

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type ResponsesRequestBody = JsonObject & {
  input?: JsonValue;
  previous_response_id?: JsonValue;
  store?: JsonValue;
};

const responsesRequestBodySchema: z.ZodType<ResponsesRequestBody> = z.record(z.string(), z.json());

export class ResponsesRequestBodyInvalid extends TaggedError("ResponsesRequestBodyInvalid")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export function decodeResponsesRequestBody(
  text: string,
): ResultType<ResponsesRequestBody, ResponsesRequestBodyInvalid> {
  const captured = Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => ({ cause }),
  });
  const outcome = captureResultOutcome(captured);
  if (!outcome.ok && isPanic(outcome.error.cause)) throw outcome.error.cause;
  if (!outcome.ok) {
    return Result.err(
      new ResponsesRequestBodyInvalid({
        cause: outcome.error.cause,
        message: "Responses request body is not valid JSON",
      }),
    );
  }
  const decoded = outcome.value;
  const parsed = responsesRequestBodySchema.safeParse(decoded);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ResponsesRequestBodyInvalid({
          cause: parsed.error,
          message: "Responses request body is not a JSON object",
        }),
      );
}

export function projectResponsesStreamError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function signalResponsesStreamError<T>(
  controller: ReadableStreamDefaultController<T>,
  error: Error,
): void {
  controller.error(error);
}

type CapturedResponsesFailure =
  | { readonly kind: "panic"; readonly panic: import("better-result").Panic }
  | { readonly kind: "error"; readonly error: Error };

type CapturedResponsesResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | CapturedResponsesFailure;

function captureResponsesFailure(restoreCause: () => unknown): CapturedResponsesFailure {
  const cause = restoreCause();
  const panic = Result.try({
    try: () => (Panic.is(cause) ? cause : undefined),
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  return panic
    ? { kind: "panic", panic }
    : {
        kind: "error",
        error:
          cause instanceof Error
            ? cause
            : new Error(
                typeof cause === "object" && cause !== null
                  ? "Opaque Responses stream failure"
                  : String(cause),
              ),
      };
}

function settleResponsesResult<T>(
  result: ResultType<T, { readonly restoreCause: () => unknown }>,
): CapturedResponsesResult<T> {
  return result.match<CapturedResponsesResult<T>>({
    ok: (value) => ({ kind: "value", value }),
    err: ({ restoreCause }) => captureResponsesFailure(restoreCause),
  });
}

function responsesFailureError(failure: CapturedResponsesFailure): Error {
  return failure.kind === "panic" ? failure.panic : failure.error;
}

function captureResponsesSyncFailure(effect: () => void): CapturedResponsesFailure | null {
  const captured = Result.try({
    try: effect,
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const outcome = settleResponsesResult(captured);
  return outcome.kind === "value" ? null : outcome;
}

type ResponsesContinuationCacheEntry = {
  requestShapeHash: string;
  prefixHash: string;
  prefix: JsonValue[];
  responseId: string | null;
  turnState: string | null;
  turnStateMatch: "prefix" | "exact";
  createdAt: number;
  lastUsedAt: number;
};

type ResponsesOptimizationReason =
  | "transport_not_websocket"
  | "no_continuation_state"
  | "existing_previous_response_id"
  | "missing_input"
  | "request_shape_changed"
  | "unreplayable_output_items"
  | "not_prefix_extension"
  | "incremental_replay"
  | "stale_previous_response_id_retry";

export type ResponsesTransportSelectionDetails = {
  mode: ResponsesTransportMode;
  transport: "sse" | "websocket";
  requestUrl: string;
  optimizationEnabled: boolean;
  optimizationReason: ResponsesOptimizationReason;
};

type IncrementalPayloadResult = {
  payload: ResponsesRequestBody;
  optimizationEnabled: boolean;
  optimizationReason: ResponsesOptimizationReason;
  turnState: string | null;
};

export function createOpenAIResponsesWebSocketFetch(
  options: CreateOpenAIResponsesWebSocketFetchOptions,
): OpenAIResponsesWebSocketFetch {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const completionEventTypes = new Set(options.completionEventTypes ?? ["response.completed"]);
  completionEventTypes.add("response.incomplete");
  const idleTimeoutMs = options.idleTimeoutMs ?? RESPONSES_WEBSOCKET_TIMEOUT_MS;

  let ws: WebSocket | null = null;
  let connecting: Promise<ResultType<WebSocket, CapturedResponsesFailure>> | null = null;
  let connectingAbortController: AbortController | null = null;
  let connectingKey: string | null = null;
  let reusableBusy = false;
  let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionHeadersKey: string | null = null;
  const reusableContinuationCache = new Map<string, ResponsesContinuationCacheEntry>();

  function reportAutoFallback(details: {
    reason: "websocket_connect_failed";
    requestUrl: URL;
    error?: unknown;
  }): void {
    if (options.mode !== "auto") return;
    let errorMessage: string | undefined;
    if (details.error instanceof Error) errorMessage = details.error.message;
    else if (details.error !== undefined) errorMessage = String(details.error);
    options.onAutoFallback?.({
      reason: details.reason,
      requestUrl: details.requestUrl.toString(),
      errorMessage,
    });
  }

  function reportTransportSelected(details: {
    requestUrl: URL;
    transport: "sse" | "websocket";
    optimizationEnabled: boolean;
    optimizationReason: ResponsesOptimizationReason;
  }): void {
    options.onTransportSelected?.({
      mode: options.mode,
      requestUrl: details.requestUrl.toString(),
      transport: details.transport,
      optimizationEnabled: details.optimizationEnabled,
      optimizationReason: details.optimizationReason,
    });
  }

  function getWebSocketUrl(requestUrl: URL): string {
    if (typeof options.url === "function") return options.url(requestUrl);
    if (typeof options.url === "string" && options.url.length > 0) return options.url;

    return openAIResponsesWebSocketUrl(requestUrl);
  }

  function closeSocket(socket: WebSocket | null): void {
    if (!socket) return;
    const outcome = settleSyncResult(() => socket.close());
    if (outcome.kind === "panic") throw outcome.panic;
  }

  function clearIdleCloseTimer(): void {
    if (!idleCloseTimer) return;
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }

  function scheduleIdleClose(): void {
    clearIdleCloseTimer();
    if (!ws || ws.readyState !== WEBSOCKET_OPEN_STATE) return;

    if (idleTimeoutMs <= 0) {
      closeSocket(ws);
      ws = null;
      connectionHeadersKey = null;
      invalidateReusableContinuationResponseIds();
      return;
    }

    idleCloseTimer = setTimeout(() => {
      if (!reusableBusy && ws?.readyState === WEBSOCKET_OPEN_STATE) {
        closeSocket(ws);
        ws = null;
        connectionHeadersKey = null;
        invalidateReusableContinuationResponseIds();
      }
      idleCloseTimer = null;
    }, idleTimeoutMs);
  }

  function clearReusableContinuationState(): void {
    reusableContinuationCache.clear();
  }

  function invalidateReusableContinuationResponseIds(): void {
    for (const entry of reusableContinuationCache.values()) {
      entry.responseId = null;
    }
  }

  function pruneContinuationCache(now: number): void {
    for (const [key, entry] of reusableContinuationCache) {
      if (now - entry.createdAt > CONTINUATION_CACHE_TTL_MS) {
        if (entry.turnState) {
          entry.responseId = null;
        } else {
          reusableContinuationCache.delete(key);
        }
      }
    }
  }

  function touchContinuationCacheEntry(key: string, entry: ResponsesContinuationCacheEntry): void {
    reusableContinuationCache.delete(key);
    reusableContinuationCache.set(key, entry);
  }

  function storeReusableContinuation(input: {
    requestBody: ResponsesRequestBody;
    requestUrl: URL;
    responseId: string;
    outputItems: readonly JsonObject[];
    turnState: string | null;
  }): void {
    const entry = buildContinuationCacheEntry({ ...input, now: Date.now() });
    clearReusableContinuationState();
    if (!entry) return;

    touchContinuationCacheEntry(continuationCacheKey(entry), entry);
    pruneContinuationCache(entry.createdAt);
  }

  function storeReusableTurnStateRetry(
    requestBody: ResponsesRequestBody,
    turnState: string | null,
  ): void {
    if (!turnState) return;
    const requestInput = asJsonArray(requestBody.input);
    if (!requestInput) return;

    const prefix = requestInput.map(cloneJsonValue);
    const now = Date.now();
    const entry: ResponsesContinuationCacheEntry = {
      requestShapeHash: stableJsonHash(omitRequestInputFields(requestBody)),
      prefixHash: stableJsonHash(prefix),
      prefix,
      responseId: null,
      turnState,
      turnStateMatch: "exact",
      createdAt: now,
      lastUsedAt: now,
    };
    clearReusableContinuationState();
    touchContinuationCacheEntry(continuationCacheKey(entry), entry);
  }

  async function connectWebSocket(
    socketUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ResultType<WebSocket, CapturedResponsesFailure>> {
    const captured = await Result.tryPromise({
      try: () => connectOpenAIResponsesWebSocket({ url: socketUrl, headers, signal }),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    const outcome = settleResponsesResult(captured);
    if (outcome.kind !== "value") return Result.err(outcome);
    return outcome.value.mapError((failure) => captureResponsesFailure(() => failure.error));
  }

  function getConnectionKey(socketUrl: string, headers: Record<string, string>): string {
    return `${socketUrl}|${JSON.stringify(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    )}`;
  }

  function getConnection(
    socketUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ResultType<WebSocket, CapturedResponsesFailure>> {
    const key = getConnectionKey(socketUrl, headers);

    if (ws?.readyState === WEBSOCKET_OPEN_STATE && connectionHeadersKey === key) {
      return Promise.resolve(Result.ok(ws));
    }

    if (connecting && connectingKey === key) {
      return connecting;
    }

    if (ws) {
      closeSocket(ws);
      ws = null;
      connectionHeadersKey = null;
      invalidateReusableContinuationResponseIds();
    }

    const connectionController = new AbortController();
    const connectionSignal = signal
      ? AbortSignal.any([signal, connectionController.signal])
      : connectionController.signal;
    connectingAbortController = connectionController;
    connecting = (async () => {
      const connected = captureResultOutcome(
        await connectWebSocket(socketUrl, headers, connectionSignal),
      );
      let result: ResultType<WebSocket, CapturedResponsesFailure>;
      if (!connected.ok) {
        result = Result.err(connected.error);
      } else {
        const socket = connected.value;
        ws = socket;
        connectionHeadersKey = key;
        socket.addEventListener(
          "close",
          () => {
            if (ws === socket) {
              ws = null;
              connectionHeadersKey = null;
              invalidateReusableContinuationResponseIds();
            }
          },
          { once: true },
        );
        result = Result.ok(socket);
      }
      connecting = null;
      connectingKey = null;
      if (connectingAbortController === connectionController) {
        connectingAbortController = null;
      }
      return result;
    })();

    connectingKey = key;

    return connecting;
  }

  async function websocketFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const requestUrl = getRequestUrl(input);
    const method = getRequestMethod(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const isResponsesRequest = method === "POST" && requestUrl.pathname.endsWith("/responses");
    const normalizeEvent = options.createEventNormalizer?.() ?? options.normalizeEvent;

    const forwardWithSseNormalization = async (): Promise<Response> => {
      const response = await fetchFn(input, init);
      return maybeNormalizeResponsesSseResponse({
        response,
        requestUrl,
        method,
        normalizeEvent,
        completionEventTypes,
      });
    };

    if (options.mode === "sse" || !isResponsesRequest) {
      if (options.mode === "sse" && isResponsesRequest) {
        reportTransportSelected({
          requestUrl,
          transport: "sse",
          optimizationEnabled: false,
          optimizationReason: "transport_not_websocket",
        });
      }
      return forwardWithSseNormalization();
    }

    const encodedBody = await decodeRequestBody(input, init);
    if (encodedBody === undefined) {
      return forwardWithSseNormalization();
    }

    const decodedBody = decodeResponsesRequestBody(encodedBody);
    const parsedBody = decodedBody.match({
      ok: (value) => value,
      err: () => undefined,
    });
    if (parsedBody === undefined) return forwardWithSseNormalization();

    if (parsedBody.stream !== true) {
      return forwardWithSseNormalization();
    }

    const wsHeaders = toOpenAIResponsesWebSocketHeaders(getRequestHeaders(input, init));
    const socketUrl = getWebSocketUrl(requestUrl);

    const useReusableConnection = !reusableBusy;
    if (useReusableConnection) {
      reusableBusy = true;
      clearIdleCloseTimer();
    }

    const connected = await (useReusableConnection
      ? getConnection(socketUrl, wsHeaders, signal ?? undefined)
      : connectWebSocket(socketUrl, wsHeaders, signal ?? undefined));
    const connectOutcome = captureResultOutcome(connected);
    if (!connectOutcome.ok) {
      if (useReusableConnection) reusableBusy = false;
      const connectionError = responsesFailureError(connectOutcome.error);
      if (signal?.aborted) throw projectResponsesStreamError(signal.reason);
      if (options.mode === "auto") {
        reportAutoFallback({
          reason: "websocket_connect_failed",
          requestUrl,
          error: connectionError,
        });
        reportTransportSelected({
          requestUrl,
          transport: "sse",
          optimizationEnabled: false,
          optimizationReason: "transport_not_websocket",
        });
        return forwardWithSseNormalization();
      }
      throw connectionError;
    }
    const connection = connectOutcome.value;
    const { stream: _stream, ...requestBody } = parsedBody;
    const fullRequestBody = cloneJsonObject(requestBody);
    pruneContinuationCache(Date.now());
    const payloadResult =
      useReusableConnection && reusableContinuationCache.size > 0
        ? buildIncrementalWebSocketPayload({
            requestBody: fullRequestBody,
            continuationCache: reusableContinuationCache,
          })
        : {
            payload: cloneJsonObject(fullRequestBody),
            optimizationEnabled: false,
            optimizationReason: "no_continuation_state" as const,
            turnState: null,
          };
    if (useReusableConnection) clearReusableContinuationState();
    let websocketPayload = applyTurnStateToPayload(
      payloadResult.payload,
      options.turnStateHeaderName,
      payloadResult.turnState,
    );
    reportTransportSelected({
      requestUrl,
      transport: "websocket",
      optimizationEnabled: payloadResult.optimizationEnabled,
      optimizationReason: payloadResult.optimizationReason,
    });
    const encoder = new TextEncoder();

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let cleanedUp = false;
        let responseId: string | null = null;
        let outputItems: JsonObject[] = [];
        let outputItemDrafts = new Map<string, JsonObject>();
        let canPersistContinuation = true;
        let responseTurnState = payloadResult.turnState;
        let forwardedEventCount = 0;
        let pendingPreOutputEvents: Record<string, unknown>[] = [];
        let stalePreviousResponseRetryAttempted = false;

        const sendPayload = (payload: ResponsesRequestBody) => {
          connection.send(JSON.stringify({ type: "response.create", ...payload }));
        };

        const retryWithoutOptimization = (): boolean => {
          if (!payloadResult.optimizationEnabled) return false;
          if (stalePreviousResponseRetryAttempted) return false;
          if (forwardedEventCount > 0) return false;

          stalePreviousResponseRetryAttempted = true;
          clearReusableContinuationState();
          websocketPayload = applyTurnStateToPayload(
            cloneJsonObject(fullRequestBody),
            options.turnStateHeaderName,
            responseTurnState,
          );
          responseId = null;
          outputItems = [];
          outputItemDrafts = new Map<string, JsonObject>();
          canPersistContinuation = true;
          pendingPreOutputEvents = [];
          reportTransportSelected({
            requestUrl,
            transport: "websocket",
            optimizationEnabled: false,
            optimizationReason: "stale_previous_response_id_retry",
          });
          sendPayload(websocketPayload);
          return true;
        };

        const enqueueNormalizedEvent = (event: Record<string, unknown>): boolean => {
          const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
          controller.enqueue(bytes);
          forwardedEventCount++;
          return true;
        };

        const flushPendingPreOutputEvents = (): boolean => {
          for (const event of pendingPreOutputEvents) {
            if (!enqueueNormalizedEvent(event)) return false;
          }
          pendingPreOutputEvents = [];
          return true;
        };

        const cleanup = (params?: { closeConnection?: boolean }) => {
          if (cleanedUp) return;
          cleanedUp = true;

          connection.removeEventListener("message", onMessage);
          connection.removeEventListener("error", onError);
          connection.removeEventListener("close", onClose);
          signal?.removeEventListener("abort", onAbort);

          if (useReusableConnection) {
            reusableBusy = false;
          }

          const shouldClose = params?.closeConnection === true || !useReusableConnection;

          if (useReusableConnection && (!canPersistContinuation || shouldClose)) {
            clearReusableContinuationState();
          }

          if (shouldClose) {
            closeSocket(connection);
            if (ws === connection) {
              ws = null;
              connectionHeadersKey = null;
              clearReusableContinuationState();
            }
          } else {
            scheduleIdleClose();
          }
        };

        const onMessage = (event: Event) => {
          void (async () => {
            const handled = await Result.tryPromise({
              try: async () => {
                if (cleanedUp) return;
                const text = await decodeWebSocketData(event);
                if (cleanedUp) return;
                if (!text) return;

                const eventJson = JSON.parse(text) as unknown;

                const eventRecord = asRecord(eventJson);
                if (!eventRecord) return;
                responseTurnState ??= extractTurnState(eventRecord, options.turnStateHeaderName);
                const nextResponseId = extractResponseId(eventRecord);
                if (nextResponseId) {
                  responseId = nextResponseId;
                }

                updateOutputItemDraft(outputItemDrafts, eventRecord);
                const doneItem = extractOutputItemDone(eventRecord);
                if (doneItem) {
                  outputItems.push(mergeOutputItemDraft(doneItem, outputItemDrafts));
                }
                const projectedEvent = projectResponsesEvent(eventRecord);
                if (options.turnStateHeaderName && projectedEvent.type === "response.metadata") {
                  return;
                }

                const normalized = projectResponsesEvent(
                  normalizeResponsesEvent(eventRecord, normalizeEvent),
                );

                if (
                  isPreviousResponseNotFoundError(normalized.record) &&
                  retryWithoutOptimization()
                ) {
                  return;
                }

                const type = normalized.type;
                if (forwardedEventCount === 0 && isPreOutputMetadataEvent(type)) {
                  pendingPreOutputEvents.push(normalized.record);
                  return;
                }

                if (!flushPendingPreOutputEvents()) return;
                if (!enqueueNormalizedEvent(normalized.record)) return;

                if (type === "error") {
                  canPersistContinuation = false;
                }
                if (completionEventTypes.has(type) || type === "error") {
                  if (
                    useReusableConnection &&
                    canPersistContinuation &&
                    responseId &&
                    connection === ws &&
                    connection.readyState === WEBSOCKET_OPEN_STATE
                  ) {
                    storeReusableContinuation({
                      requestBody: fullRequestBody,
                      requestUrl,
                      responseId,
                      outputItems,
                      turnState: responseTurnState,
                    });
                  }
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  cleanup({ closeConnection: type === "error" });
                  if (type === "error" && useReusableConnection) {
                    storeReusableTurnStateRetry(fullRequestBody, responseTurnState);
                  }
                  controller.close();
                }
              },
              catch: (cause) => ({ restoreCause: () => cause }),
            });
            const handledOutcome = settleResponsesResult(handled);
            if (handledOutcome.kind === "value") return;
            const error = responsesFailureError(handledOutcome);
            canPersistContinuation = false;
            cleanup({ closeConnection: true });
            if (useReusableConnection) {
              storeReusableTurnStateRetry(fullRequestBody, responseTurnState);
            }
            const signalled = Result.try({
              try: () => signalResponsesStreamError(controller, error),
              catch: (cause) => ({ restoreCause: () => cause }),
            });
            const signalOutcome = settleResponsesResult(signalled);
            if (signalOutcome.kind !== "value") {
              return Promise.reject(responsesFailureError(signalOutcome));
            }
            return;
          })();
        };

        const onError = (event: Event) => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          if (useReusableConnection) {
            storeReusableTurnStateRetry(fullRequestBody, responseTurnState);
          }
          signalResponsesStreamError(controller, extractWebSocketError(event));
        };

        const onClose = () => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          if (useReusableConnection) {
            storeReusableTurnStateRetry(fullRequestBody, responseTurnState);
          }
          const outcome = settleSyncResult(() =>
            signalResponsesStreamError(
              controller,
              new Error("WebSocket closed before a terminal response event"),
            ),
          );
          if (outcome.kind === "panic") throw outcome.panic;
        };

        const onAbort = () => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          const outcome = settleSyncResult(() =>
            signalResponsesStreamError(
              controller,
              projectResponsesStreamError(
                signal?.reason ?? new DOMException("Aborted", "AbortError"),
              ),
            ),
          );
          if (outcome.kind === "panic") throw outcome.panic;
        };

        connection.addEventListener("message", onMessage);
        connection.addEventListener("error", onError);
        connection.addEventListener("close", onClose);

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        const sendOutcome = settleSyncResult(() => sendPayload(websocketPayload));
        if (sendOutcome.kind !== "value") {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          if (useReusableConnection) {
            storeReusableTurnStateRetry(fullRequestBody, responseTurnState);
          }
          signalResponsesStreamError(
            controller,
            sendOutcome.kind === "panic"
              ? sendOutcome.panic
              : projectResponsesStreamError(sendOutcome.restoreCause()),
          );
        }
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  return Object.assign(websocketFetch as typeof globalThis.fetch, {
    close() {
      clearIdleCloseTimer();
      connectingAbortController?.abort(new Error("Responses WebSocket fetch closed"));
      connectingAbortController = null;
      if (connecting) {
        connecting = null;
        connectingKey = null;
      }
      closeSocket(ws);
      ws = null;
      connectionHeadersKey = null;
      clearReusableContinuationState();
      reusableBusy = false;
    },
  }) as OpenAIResponsesWebSocketFetch;
}

function buildIncrementalWebSocketPayload(input: {
  requestBody: ResponsesRequestBody;
  continuationCache: Map<string, ResponsesContinuationCacheEntry>;
}): IncrementalPayloadResult {
  const { requestBody, continuationCache } = input;
  if (requestBody.previous_response_id != null) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "existing_previous_response_id",
      turnState: null,
    };
  }

  const currentInput = asJsonArray(requestBody.input);
  if (!currentInput) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "missing_input",
      turnState: null,
    };
  }

  const currentWithoutInput = omitRequestInputFields(requestBody);
  const requestShapeHash = stableJsonHash(currentWithoutInput);
  let matchingPrefix: { entry: ResponsesContinuationCacheEntry; suffix: JsonValue[] } | null = null;
  let best: {
    key: string;
    entry: ResponsesContinuationCacheEntry;
    responseId: string;
    suffix: JsonValue[];
  } | null = null;

  for (const [key, entry] of continuationCache) {
    if (entry.prefix.length > currentInput.length) continue;
    const suffix = sliceJsonArrayPrefix(currentInput, entry.prefix);
    if (!suffix) continue;
    if (entry.turnStateMatch === "exact" && suffix.length > 0) continue;
    if (entry.turnStateMatch === "prefix" && suffix.length === 0) continue;
    if (!matchingPrefix || entry.prefix.length > matchingPrefix.entry.prefix.length) {
      matchingPrefix = { entry, suffix };
    }
    if (entry.requestShapeHash !== requestShapeHash || !entry.responseId) continue;
    if (
      !best ||
      entry.prefix.length > best.entry.prefix.length ||
      (entry.prefix.length === best.entry.prefix.length && entry.lastUsedAt > best.entry.lastUsedAt)
    ) {
      best = { key, entry, responseId: entry.responseId, suffix };
    }
  }

  if (!best) {
    let optimizationReason: ResponsesOptimizationReason = "not_prefix_extension";
    if (matchingPrefix?.entry.responseId) optimizationReason = "request_shape_changed";
    else if (matchingPrefix) optimizationReason = "no_continuation_state";
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason,
      turnState: matchingPrefix?.entry.turnState ?? null,
    };
  }

  best.entry.lastUsedAt = Date.now();
  continuationCache.delete(best.key);
  continuationCache.set(best.key, best.entry);

  return {
    payload: {
      ...cloneJsonObject(currentWithoutInput),
      previous_response_id: best.responseId,
      input: best.suffix,
    },
    optimizationEnabled: true,
    optimizationReason: "incremental_replay",
    turnState: best.entry.turnState,
  };
}

function buildContinuationCacheEntry(input: {
  requestBody: ResponsesRequestBody;
  requestUrl: URL;
  responseId: string;
  outputItems: readonly JsonObject[];
  turnState: string | null;
  now: number;
}): ResponsesContinuationCacheEntry | null {
  const requestInput = asJsonArray(input.requestBody.input);
  if (!requestInput) return null;

  const replayedItems = input.outputItems
    .map((item) =>
      normalizeOutputItemForReplay(item, {
        useStoreReferences: shouldUseStoreReferences(input.requestBody),
        stripCodexIds: isCodexResponsesRequest(input.requestUrl),
      }),
    )
    .filter(isJsonObject);
  if (replayedItems.length !== input.outputItems.length) return null;

  const prefix = [...requestInput.map(cloneJsonValue), ...replayedItems.map(cloneJsonValue)];
  if (prefix.length === 0) return null;

  return {
    requestShapeHash: stableJsonHash(omitRequestInputFields(input.requestBody)),
    prefixHash: stableJsonHash(prefix),
    prefix,
    responseId: input.responseId,
    turnState: responseNeedsClientFollowUp(input.outputItems) ? input.turnState : null,
    turnStateMatch: "prefix",
    createdAt: input.now,
    lastUsedAt: input.now,
  };
}

function continuationCacheKey(entry: ResponsesContinuationCacheEntry): string {
  return `${entry.requestShapeHash}:${entry.prefixHash}`;
}

function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function omitRequestInputFields(requestBody: ResponsesRequestBody): JsonObject {
  const cloned = cloneJsonObject(requestBody);
  delete cloned.input;
  delete cloned.previous_response_id;
  return cloned;
}

function applyTurnStateToPayload(
  payload: ResponsesRequestBody,
  headerName: string | undefined,
  turnState: string | null,
): ResponsesRequestBody {
  if (!headerName || !turnState) return payload;

  const clientMetadata = asRecord(payload.client_metadata);
  return {
    ...payload,
    client_metadata: {
      ...(clientMetadata ? cloneJsonObject(clientMetadata) : {}),
      [headerName]: turnState,
    },
  };
}

function shouldUseStoreReferences(requestBody: ResponsesRequestBody): boolean {
  return requestBody.store !== false;
}

function isCodexResponsesRequest(requestUrl: URL): boolean {
  return (
    requestUrl.origin === "https://chatgpt.com" &&
    requestUrl.pathname.endsWith("/backend-api/codex/responses")
  );
}

function extractResponseId(event: Record<string, unknown>): string | null {
  const type = readString(event.type);
  if (
    type !== "response.created" &&
    type !== "response.completed" &&
    type !== "response.done" &&
    type !== "response.incomplete"
  ) {
    return null;
  }
  return readString(asRecord(event.response)?.id) ?? null;
}

function extractTurnState(
  event: Record<string, unknown>,
  headerName: string | undefined,
): string | null {
  if (!headerName || readString(event.type) !== "response.metadata") return null;
  const value = readHeaderValue(event.headers, headerName);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function responseNeedsClientFollowUp(outputItems: readonly JsonObject[]): boolean {
  return outputItems.some((item) => {
    switch (readString(item.type)) {
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
      case "shell_call":
      case "apply_patch_call":
        return true;
      default:
        return false;
    }
  });
}

function extractOutputItemDone(event: Record<string, unknown>): JsonObject | null {
  if (readString(event.type) !== "response.output_item.done") return null;
  const item = asRecord(event.item);
  return item ? cloneJsonObject(item) : null;
}

function updateOutputItemDraft(
  drafts: Map<string, JsonObject>,
  event: Record<string, unknown>,
): void {
  const type = readString(event.type);
  const itemId = readString(event.item_id);
  if (!type || !itemId) return;

  switch (type) {
    case "response.output_item.added": {
      const item = asRecord(event.item);
      if (!item) return;
      drafts.set(itemId, cloneJsonObject(item));
      return;
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      const draft = ensureOutputItemDraft(drafts, itemId, "message");
      const part = asRecord(event.part);
      if (!part || readString(part.type) !== "output_text") return;
      const content = ensureDraftArray(draft, "content");
      const contentIndex = readNumber(event.content_index) ?? content.length;
      content[contentIndex] = cloneJsonObject(part);
      return;
    }
    case "response.output_text.delta": {
      const draft = ensureOutputItemDraft(drafts, itemId, "message");
      const content = ensureDraftArray(draft, "content");
      const contentIndex = readNumber(event.content_index) ?? 0;
      const existingPart = asRecord(content[contentIndex]) ?? { type: "output_text", text: "" };
      existingPart.type = "output_text";
      const currentText = readString(existingPart.text) ?? "";
      existingPart.text = `${currentText}${readString(event.delta) ?? ""}`;
      content[contentIndex] = existingPart as JsonValue;
      return;
    }
    case "response.reasoning_summary_part.added": {
      const draft = ensureOutputItemDraft(drafts, itemId, "reasoning");
      const summary = ensureDraftArray(draft, "summary");
      const summaryIndex = readNumber(event.summary_index) ?? summary.length;
      if (!asRecord(summary[summaryIndex])) {
        summary[summaryIndex] = { type: "summary_text", text: "" };
      }
      return;
    }
    case "response.reasoning_summary_text.delta": {
      const draft = ensureOutputItemDraft(drafts, itemId, "reasoning");
      const summary = ensureDraftArray(draft, "summary");
      const summaryIndex = readNumber(event.summary_index) ?? 0;
      const existingPart = asRecord(summary[summaryIndex]) ?? { type: "summary_text", text: "" };
      existingPart.type = "summary_text";
      const currentText = readString(existingPart.text) ?? "";
      existingPart.text = `${currentText}${readString(event.delta) ?? ""}`;
      summary[summaryIndex] = existingPart as JsonValue;
      return;
    }
    case "response.reasoning_summary_text.done": {
      const text = readString(event.text);
      if (text === undefined) return;
      const draft = ensureOutputItemDraft(drafts, itemId, "reasoning");
      const summary = ensureDraftArray(draft, "summary");
      const summaryIndex = readNumber(event.summary_index) ?? 0;
      summary[summaryIndex] = { type: "summary_text", text };
      return;
    }
    case "response.reasoning_summary_part.done": {
      const part = asRecord(event.part);
      if (!part || readString(part.type) !== "summary_text") return;
      const text = readString(part.text);
      if (text === undefined) return;
      const draft = ensureOutputItemDraft(drafts, itemId, "reasoning");
      const summary = ensureDraftArray(draft, "summary");
      const summaryIndex = readNumber(event.summary_index) ?? 0;
      summary[summaryIndex] = { type: "summary_text", text };
      return;
    }
    case "response.function_call_arguments.delta": {
      const draft = ensureOutputItemDraft(drafts, itemId, "function_call");
      const currentArgs = readString(draft.arguments) ?? "";
      draft.arguments = `${currentArgs}${readString(event.delta) ?? ""}`;
      return;
    }
    default:
      return;
  }
}

function ensureOutputItemDraft(
  drafts: Map<string, JsonObject>,
  itemId: string,
  defaultType: string,
): JsonObject {
  const existing = drafts.get(itemId);
  if (existing) return existing;

  const next: JsonObject = {
    id: itemId,
    type: defaultType,
  };
  drafts.set(itemId, next);
  return next;
}

function ensureDraftArray(draft: JsonObject, key: string): JsonValue[] {
  const existing = draft[key];
  if (Array.isArray(existing)) return existing;
  const next: JsonValue[] = [];
  draft[key] = next;
  return next;
}

function mergeOutputItemDraft(item: JsonObject, drafts: Map<string, JsonObject>): JsonObject {
  const itemId = readString(item.id);
  if (!itemId) return item;
  const draft = drafts.get(itemId);
  if (!draft) return item;
  return mergeJsonObjects(draft, item);
}

function mergeJsonObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged = cloneJsonObject(base);
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      const baseValue = merged[key];
      merged[key] = Array.isArray(baseValue)
        ? mergeJsonArrays(baseValue, value)
        : cloneJsonValue(value as JsonValue);
      continue;
    }

    const valueRecord = asRecord(value);
    const baseRecord = asRecord(merged[key]);
    if (valueRecord && baseRecord) {
      merged[key] = mergeJsonObjects(cloneJsonObject(baseRecord), cloneJsonObject(valueRecord));
      continue;
    }

    merged[key] = cloneJsonValue(value as JsonValue);
  }
  return merged;
}

function mergeJsonArrays(base: readonly JsonValue[], override: readonly JsonValue[]): JsonValue[] {
  const length = Math.max(base.length, override.length);
  const merged: JsonValue[] = [];

  for (let i = 0; i < length; i += 1) {
    const overrideValue = override[i];
    const baseValue = base[i];
    if (overrideValue === undefined) {
      if (baseValue !== undefined) {
        merged[i] = cloneJsonValue(baseValue);
      }
      continue;
    }

    if (Array.isArray(baseValue) && Array.isArray(overrideValue)) {
      merged[i] = mergeJsonArrays(baseValue, overrideValue);
      continue;
    }

    const baseRecord = asRecord(baseValue);
    const overrideRecord = asRecord(overrideValue);
    if (baseRecord && overrideRecord) {
      merged[i] = mergeJsonObjects(cloneJsonObject(baseRecord), cloneJsonObject(overrideRecord));
      continue;
    }

    merged[i] = cloneJsonValue(overrideValue);
  }

  return merged;
}

function normalizeOutputItemForReplay(
  item: JsonObject,
  options: {
    useStoreReferences: boolean;
    stripCodexIds: boolean;
  },
): JsonObject | null {
  const id = readString(item.id);
  if (options.useStoreReferences) {
    return id ? { type: "item_reference", id } : null;
  }

  const type = readString(item.type);
  if (!type) return null;

  const normalized = (() => {
    switch (type) {
      case "message":
        return normalizeReplayMessageItem(item);
      case "reasoning":
        return normalizeReplayReasoningItem(item);
      case "function_call":
        return normalizeReplayFunctionCallItem(item);
      case "custom_tool_call":
        return normalizeReplayCustomToolCallItem(item);
      case "local_shell_call":
        return normalizeReplayLocalShellCallItem(item);
      case "shell_call":
        return normalizeReplayShellCallItem(item);
      case "apply_patch_call":
        return normalizeReplayApplyPatchCallItem(item);
      default:
        return null;
    }
  })();

  if (!normalized) return null;
  return options.stripCodexIds ? stripCodexReplayIds(normalized) : normalized;
}

function normalizeReplayMessageItem(item: JsonObject): JsonObject | null {
  const content = asJsonArray(item.content) ?? [];
  const normalizedContent = content
    .map((part) => {
      const record = asRecord(part);
      if (!record || readString(record.type) !== "output_text") return null;
      const text = readString(record.text);
      return text === undefined ? null : ({ type: "output_text", text } satisfies JsonObject);
    })
    .filter(isJsonObject);

  if (normalizedContent.length === 0) return null;

  const next: JsonObject = {
    role: "assistant",
    content: normalizedContent,
  };

  const id = readString(item.id);
  if (id) next.id = id;
  const phase = readString(item.phase);
  if (phase) next.phase = phase;
  return next;
}

function normalizeReplayReasoningItem(item: JsonObject): JsonObject | null {
  const summary = asJsonArray(item.summary) ?? [];
  const normalizedSummary = summary
    .map((part) => {
      const record = asRecord(part);
      if (!record || readString(record.type) !== "summary_text") return null;
      const text = readString(record.text);
      return text === undefined ? null : ({ type: "summary_text", text } satisfies JsonObject);
    })
    .filter(isJsonObject);

  const next: JsonObject = {
    type: "reasoning",
    summary: normalizedSummary,
  };

  const id = readString(item.id);
  if (id) next.id = id;
  const encryptedContent = readString(item.encrypted_content);
  if (encryptedContent) next.encrypted_content = encryptedContent;
  return next;
}

function normalizeReplayFunctionCallItem(item: JsonObject): JsonObject | null {
  const callId = readString(item.call_id);
  const name = readString(item.name);
  const args = readString(item.arguments);
  if (!callId || !name || args === undefined) return null;

  const next: JsonObject = {
    type: "function_call",
    call_id: callId,
    name,
    arguments: args,
  };
  const id = readString(item.id);
  if (id) next.id = id;
  return next;
}

function normalizeReplayCustomToolCallItem(item: JsonObject): JsonObject | null {
  const callId = readString(item.call_id);
  const name = readString(item.name);
  const input = readString(item.input);
  if (!callId || !name || input === undefined) return null;

  const next: JsonObject = {
    type: "custom_tool_call",
    call_id: callId,
    name,
    input,
  };
  const id = readString(item.id);
  if (id) next.id = id;
  return next;
}

function normalizeReplayLocalShellCallItem(item: JsonObject): JsonObject | null {
  const callId = readString(item.call_id);
  const id = readString(item.id);
  const action = asRecord(item.action);
  if (!callId || !id || !action) return null;

  return {
    type: "local_shell_call",
    call_id: callId,
    id,
    action: cloneJsonObject(action),
  };
}

function normalizeReplayShellCallItem(item: JsonObject): JsonObject | null {
  const callId = readString(item.call_id);
  const id = readString(item.id);
  const action = asRecord(item.action);
  if (!callId || !id || !action) return null;

  return {
    type: "shell_call",
    call_id: callId,
    id,
    status: readString(item.status) ?? "completed",
    action: cloneJsonObject(action),
  };
}

function normalizeReplayApplyPatchCallItem(item: JsonObject): JsonObject | null {
  const callId = readString(item.call_id);
  const id = readString(item.id);
  const operation = asRecord(item.operation);
  if (!callId || !id || !operation) return null;

  return {
    type: "apply_patch_call",
    call_id: callId,
    id,
    status: readString(item.status) ?? "completed",
    operation: cloneJsonObject(operation),
  };
}

function stripCodexReplayIds(item: JsonObject): JsonObject {
  const cloned = cloneJsonObject(item);
  if (!("id" in cloned)) return cloned;

  const type = readString(cloned.type);
  if (
    type === "item_reference" ||
    type === "local_shell_call" ||
    type === "shell_call" ||
    type === "computer_call"
  ) {
    return cloned;
  }

  delete cloned.id;
  return cloned;
}

function asJsonArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function sliceJsonArrayPrefix(
  values: readonly JsonValue[],
  prefix: readonly JsonValue[],
): JsonValue[] | null {
  if (prefix.length > values.length) return null;
  for (let i = 0; i < prefix.length; i += 1) {
    if (!deepEqualJson(values[i], prefix[i])) {
      return null;
    }
  }
  return values.slice(prefix.length).map(cloneJsonValue);
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function stableJsonHash(value: JsonValue | undefined): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function stableJsonStringify(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;

  const record = asJsonObject(value);
  if (!record) return JSON.stringify(value);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function deepEqualJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqualJson(left[i], right[i])) return false;
    }
    return true;
  }

  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = asJsonObject(left);
    const rightRecord = asJsonObject(right);
    if (!leftRecord || !rightRecord) return false;

    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      const key = leftKeys[i]!;
      if (!deepEqualJson(leftRecord[key], rightRecord[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function isJsonObject(value: JsonObject | null): value is JsonObject {
  return value !== null;
}

function getRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function maybeNormalizeResponsesSseResponse(input: {
  response: Response;
  requestUrl: URL;
  method: string;
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  completionEventTypes: ReadonlySet<string>;
}): Response {
  const { response, requestUrl, method, normalizeEvent, completionEventTypes } = input;

  if (!response.body) return response;
  if (method !== "POST" || !requestUrl.pathname.endsWith("/responses")) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/event-stream/i.test(contentType)) return response;

  const source = response.body;
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawTerminalEvent = false;
  let released = false;

  const releaseReader = (): CapturedResponsesFailure | null => {
    if (released) return null;
    released = true;
    return captureResponsesSyncFailure(() => reader.releaseLock());
  };

  const signalFailureAndRelease = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    primaryFailure: CapturedResponsesFailure,
  ): CapturedResponsesFailure | null => {
    const signalFailure = captureResponsesSyncFailure(() =>
      signalResponsesStreamError(controller, responsesFailureError(primaryFailure)),
    );
    releaseReader();
    return signalFailure;
  };

  const flushFrame = (controller: ReadableStreamDefaultController<Uint8Array>, frame: string) => {
    if (frame.length === 0) return;
    const next = normalizeSseFrame(frame, normalizeEvent);
    if (completionEventTypes.has(next.type) || next.type === "error") {
      sawTerminalEvent = true;
    }
    controller.enqueue(encoder.encode(next.frame));
  };

  const transformed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const read = await Result.tryPromise({
          try: () => reader.read(),
          catch: (cause) => ({ restoreCause: () => cause }),
        });
        const readOutcome = settleResponsesResult(read);
        if (readOutcome.kind !== "value") {
          signalFailureAndRelease(controller, readOutcome);
          return;
        }

        let emittedFrame = false;
        const processed = Result.try({
          try: () => {
            const { value, done } = readOutcome.value;
            if (!done && value) {
              buffered += decoder.decode(value, { stream: true });
              while (true) {
                const split = findSseFrameDelimiter(buffered);
                if (!split) break;
                const frame = buffered.slice(0, split.index);
                buffered = buffered.slice(split.index + split.delimiterLength);
                flushFrame(controller, frame);
                emittedFrame = true;
              }
            }
            return done;
          },
          catch: (cause) => ({ restoreCause: () => cause }),
        });
        const processedOutcome = settleResponsesResult(processed);
        if (processedOutcome.kind !== "value") {
          signalFailureAndRelease(controller, processedOutcome);
          return;
        }
        if (processedOutcome.value) break;
        if (emittedFrame) return;
      }

      const completed = Result.try({
        try: () => {
          const tail = decoder.decode();
          if (tail.length > 0) buffered += tail;
          if (buffered.length > 0) flushFrame(controller, buffered);
        },
        catch: (cause) => ({ restoreCause: () => cause }),
      });
      const completedOutcome = settleResponsesResult(completed);
      if (completedOutcome.kind !== "value") {
        signalFailureAndRelease(controller, completedOutcome);
        return;
      }

      if (!sawTerminalEvent) {
        const primaryFailure = captureResponsesFailure(
          () => new Error("Response stream ended before a terminal response event"),
        );
        signalFailureAndRelease(controller, primaryFailure);
        return;
      }

      const releaseFailure = releaseReader();
      if (releaseFailure) {
        const signalFailure = captureResponsesSyncFailure(() =>
          signalResponsesStreamError(controller, responsesFailureError(releaseFailure)),
        );
        void signalFailure;
        return;
      }
      const closeFailure = captureResponsesSyncFailure(() => controller.close());
      if (closeFailure) {
        const signalFailure = captureResponsesSyncFailure(() =>
          signalResponsesStreamError(controller, responsesFailureError(closeFailure)),
        );
        void signalFailure;
      }
    },
    cancel(reason) {
      const cancelled = Result.try({
        try: () => reader.cancel(reason),
        catch: (cause) => ({ restoreCause: () => cause }),
      });
      const cancelledOutcome = settleResponsesResult(cancelled);
      const releaseFailure = releaseReader();
      if (cancelledOutcome.kind !== "value") return;
      void releaseFailure;
      return cancelledOutcome.value;
    },
  });

  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeSseFrame(
  frame: string,
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>,
): { readonly frame: string; readonly type: string } {
  const normalizedFrame = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const dataLines = normalizedFrame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return { frame: `${normalizedFrame}\n\n`, type: "" };
  }

  const data = dataLines.join("\n");
  if (data.trim() === "[DONE]") {
    return { frame: "data: [DONE]\n\n", type: "" };
  }

  const decoded = Result.try({
    try: () => JSON.parse(data) as unknown,
    catch: () => undefined,
  });
  const parsed = decoded.match({ ok: (value) => value, err: () => undefined });
  if (parsed === undefined) return { frame: `${normalizedFrame}\n\n`, type: "" };

  const event = asRecord(parsed);
  if (!event) {
    return { frame: `${normalizedFrame}\n\n`, type: "" };
  }

  const normalized = projectResponsesEvent(normalizeResponsesEvent(event, normalizeEvent));
  return {
    frame: `data: ${JSON.stringify(normalized.record)}\n\n`,
    type: normalized.type,
  };
}

function normalizeResponsesEvent(
  event: Record<string, unknown>,
  normalizeEvent: ((event: Record<string, unknown>) => Record<string, unknown>) | undefined,
): Record<string, unknown> {
  const normalized = normalizeEvent ? normalizeEvent(event) : event;
  const withResponseFailureHandled = normalizeResponsesFailureEvent(normalized);
  return normalizeErrorEventShape(withResponseFailureHandled);
}

type ProjectedResponsesEvent = {
  readonly record: Record<string, unknown>;
  readonly type: string;
};

function projectResponsesEvent(record: Record<string, unknown>): ProjectedResponsesEvent {
  return {
    record,
    type: typeof record.type === "string" ? record.type : "",
  };
}

function normalizeResponsesFailureEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = readString(event.type);
  if (!type) return event;

  const response = asRecord(event.response);
  const responseStatus = readString(response?.status);
  const responseError = asRecord(response?.error) ?? asRecord(event.error);

  const isTerminalType =
    type === "response.completed" || type === "response.incomplete" || type === "response.done";
  const shouldConvertToError =
    type === "response.failed" ||
    (responseStatus === "failed" && (isTerminalType || type === "response.failed")) ||
    (isTerminalType && responseError !== null);

  if (!shouldConvertToError) return event;

  const fallback =
    responseStatus && responseStatus.length > 0
      ? `Responses request failed (status=${responseStatus})`
      : "Responses request failed";

  const details = extractErrorDetails(responseError, fallback);

  return {
    type: "error",
    sequence_number: readNumber(event.sequence_number) ?? 0,
    error: {
      type: details.type,
      code: details.code,
      message: details.message,
      param: details.param,
    },
  };
}

function normalizeErrorEventShape(event: Record<string, unknown>): Record<string, unknown> {
  if (readString(event.type) !== "error") return event;

  const nested = asRecord(event.error);
  const message =
    readString(nested?.message) ?? readString(event.message) ?? "Response stream error";
  const code = readString(nested?.code) ?? readString(event.code) ?? "response_error";
  const errorType = readString(nested?.type) ?? code;
  const param = readString(nested?.param) ?? readString(event.param) ?? null;

  return {
    type: "error",
    sequence_number: readNumber(event.sequence_number) ?? 0,
    error: {
      type: errorType,
      code,
      message,
      param,
    },
  };
}

function isPreviousResponseNotFoundError(event: Record<string, unknown>): boolean {
  if (readString(event.type) !== "error") return false;

  const error = asRecord(event.error);
  const message = readString(error?.message) ?? "";
  const code = readString(error?.code) ?? "";
  const param = readString(error?.param) ?? "";
  const lowerMessage = message.toLowerCase();

  return (
    code === "previous_response_not_found" ||
    param === "previous_response_id" ||
    (lowerMessage.includes("previous response") && lowerMessage.includes("not found"))
  );
}

function isPreOutputMetadataEvent(type: string): boolean {
  return (
    type === "response.created" || type === "response.in_progress" || type === "response.metadata"
  );
}

function extractErrorDetails(
  errorLike: Record<string, unknown> | null,
  fallbackMessage: string,
): {
  message: string;
  code: string;
  type: string;
  param: string | null;
} {
  const message = readString(errorLike?.message) ?? fallbackMessage;
  const code = readString(errorLike?.code) ?? "response_failed";
  const type = readString(errorLike?.type) ?? code;
  const param = readString(errorLike?.param) ?? null;

  return {
    message,
    code,
    type,
    param,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function findSseFrameDelimiter(buffer: string): { index: number; delimiterLength: number } | null {
  const idxCrlf = buffer.indexOf("\r\n\r\n");
  const idxLf = buffer.indexOf("\n\n");
  const idxCr = buffer.indexOf("\r\r");

  let bestIndex = -1;
  let bestLength = 0;

  if (idxCrlf >= 0 && (bestIndex < 0 || idxCrlf < bestIndex)) {
    bestIndex = idxCrlf;
    bestLength = 4;
  }

  if (idxLf >= 0 && (bestIndex < 0 || idxLf < bestIndex)) {
    bestIndex = idxLf;
    bestLength = 2;
  }

  if (idxCr >= 0 && (bestIndex < 0 || idxCr < bestIndex)) {
    bestIndex = idxCr;
    bestLength = 2;
  }

  if (bestIndex < 0) return null;
  return { index: bestIndex, delimiterLength: bestLength };
}

function getRequestMethod(input: FetchInput, init?: FetchInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

function normalizeHeaders(headers: RequestInit["headers"] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (typeof key === "string" && value != null) {
        result[key.toLowerCase()] = String(value);
      }
    }
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      result[key.toLowerCase()] = String(value);
    }
  }

  return result;
}

function getRequestHeaders(input: FetchInput, init?: FetchInit): Record<string, string> {
  const base = input instanceof Request ? normalizeHeaders(input.headers) : {};
  const override = normalizeHeaders(init?.headers);
  return {
    ...base,
    ...override,
  };
}

function readHeaderValue(headers: unknown, name: string): string | null | undefined {
  if (headers instanceof Headers) return headers.get(name);

  const record = asRecord(headers);
  if (!record) return undefined;

  const getter = record.get;
  if (typeof getter === "function") {
    const value = Reflect.apply(getter, headers, [name]);
    if (typeof value === "string") return value;
    if (value === null) return null;
    if (value !== undefined) return String(value);
  }

  const lowerName = name.toLowerCase();
  const directValue = record[name] ?? record[lowerName];
  if (typeof directValue === "string") return directValue;
  if (Array.isArray(directValue)) {
    const firstString = directValue.find((entry) => typeof entry === "string");
    return typeof firstString === "string" ? firstString : null;
  }

  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const firstString = value.find((entry) => typeof entry === "string");
      return typeof firstString === "string" ? firstString : null;
    }
    return value === undefined ? undefined : String(value);
  }

  return null;
}

async function decodeRequestBody(input: FetchInput, init?: FetchInit): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));

  if (input instanceof Request) {
    const captured = await Result.tryPromise({
      try: () => input.clone().text(),
      catch: () => undefined,
    });
    return captured.match({ ok: (value) => value, err: () => undefined });
  }

  return undefined;
}

async function decodeWebSocketData(event: Event): Promise<string | null> {
  if (!(event instanceof MessageEvent)) return null;

  const data = event.data;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
    const arrayBuffer = await blobLike.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }

  return null;
}

function extractWebSocketError(event: Event): Error {
  return new Error(
    event instanceof ErrorEvent && event.message ? event.message : "WebSocket error",
  );
}
