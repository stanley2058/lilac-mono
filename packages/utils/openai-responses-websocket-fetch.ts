import type { ResponsesTransportMode } from "./env";

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export type CreateOpenAIResponsesWebSocketFetchOptions = {
  mode: ResponsesTransportMode;
  url?: string | ((requestUrl: URL) => string);
  fetch?: typeof globalThis.fetch;
  completionEventTypes?: readonly string[];
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  idleTimeoutMs?: number;
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

type ResponsesContinuationState = {
  requestBody: ResponsesRequestBody;
  responseId: string;
  outputItems: readonly JsonObject[];
};

type ResponsesOptimizationReason =
  | "transport_not_websocket"
  | "no_continuation_state"
  | "existing_previous_response_id"
  | "missing_input"
  | "request_shape_changed"
  | "unreplayable_output_items"
  | "not_prefix_extension"
  | "incremental_replay";

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
};

type WebSocketWithHeadersConstructor = {
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

export function createOpenAIResponsesWebSocketFetch(
  options: CreateOpenAIResponsesWebSocketFetchOptions,
): OpenAIResponsesWebSocketFetch {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const completionEventTypes = new Set(options.completionEventTypes ?? ["response.completed"]);
  completionEventTypes.add("response.incomplete");
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;

  let ws: WebSocket | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let connectingKey: string | null = null;
  let reusableBusy = false;
  let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionHeadersKey: string | null = null;
  let reusableContinuationState: ResponsesContinuationState | null = null;

  function reportAutoFallback(details: {
    reason: "websocket_connect_failed";
    requestUrl: URL;
    error?: unknown;
  }): void {
    if (options.mode !== "auto") return;
    options.onAutoFallback?.({
      reason: details.reason,
      requestUrl: details.requestUrl.toString(),
      errorMessage:
        details.error instanceof Error
          ? details.error.message
          : details.error === undefined
            ? undefined
            : String(details.error),
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

    const url = new URL(requestUrl.toString());
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol === "http:") url.protocol = "ws:";
    return url.toString();
  }

  function closeSocket(socket: WebSocket | null): void {
    if (!socket) return;
    try {
      socket.close();
    } catch {}
  }

  function clearIdleCloseTimer(): void {
    if (!idleCloseTimer) return;
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }

  function scheduleIdleClose(): void {
    clearIdleCloseTimer();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (idleTimeoutMs <= 0) {
      closeSocket(ws);
      ws = null;
      connectionHeadersKey = null;
      reusableContinuationState = null;
      return;
    }

    idleCloseTimer = setTimeout(() => {
      if (!reusableBusy && ws?.readyState === WebSocket.OPEN) {
        closeSocket(ws);
        ws = null;
        connectionHeadersKey = null;
        reusableContinuationState = null;
      }
      idleCloseTimer = null;
    }, idleTimeoutMs);
  }

  function clearReusableContinuationState(): void {
    reusableContinuationState = null;
  }

  function connectWebSocket(
    socketUrl: string,
    headers: Record<string, string>,
  ): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      const WebSocketCtor = globalThis.WebSocket as typeof globalThis.WebSocket &
        WebSocketWithHeadersConstructor;

      try {
        socket = new WebSocketCtor(socketUrl, { headers });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const onOpen = () => {
        socket.removeEventListener("error", onError);
        resolve(socket);
      };

      const onError = (event: Event) => {
        socket.removeEventListener("open", onOpen);
        reject(extractWebSocketError(event));
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
  }

  function getConnection(socketUrl: string, headers: Record<string, string>): Promise<WebSocket> {
    const key = `${socketUrl}|${JSON.stringify(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    )}`;

    if (ws?.readyState === WebSocket.OPEN && connectionHeadersKey === key) {
      return Promise.resolve(ws);
    }

    if (connecting && connectingKey === key) {
      return connecting;
    }

    if (ws && connectionHeadersKey !== key) {
      closeSocket(ws);
      ws = null;
      connectionHeadersKey = null;
      clearReusableContinuationState();
    }

    connecting = connectWebSocket(socketUrl, headers)
      .then((socket) => {
        ws = socket;
        connectionHeadersKey = key;
        socket.addEventListener(
          "close",
          () => {
            if (ws === socket) {
              ws = null;
              connectionHeadersKey = null;
              clearReusableContinuationState();
            }
          },
          { once: true },
        );
        return socket;
      })
      .finally(() => {
        connecting = null;
        connectingKey = null;
      });

    connectingKey = key;

    return connecting;
  }

  async function websocketFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const requestUrl = getRequestUrl(input);
    const method = getRequestMethod(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const isResponsesRequest = method === "POST" && requestUrl.pathname.endsWith("/responses");

    const forwardWithSseNormalization = async (): Promise<Response> => {
      const response = await fetchFn(input, init);
      return maybeNormalizeResponsesSseResponse({
        response,
        requestUrl,
        method,
        normalizeEvent: options.normalizeEvent,
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

    let parsedBody: ResponsesRequestBody;
    try {
      parsedBody = parseJsonObject(encodedBody);
    } catch {
      return forwardWithSseNormalization();
    }

    if (parsedBody.stream !== true) {
      return forwardWithSseNormalization();
    }

    const wsHeaders = toWebSocketHeaders(getRequestHeaders(input, init));
    const socketUrl = getWebSocketUrl(requestUrl);

    let connection: WebSocket;
    const useReusableConnection = !reusableBusy;
    try {
      connection = useReusableConnection
        ? await getConnection(socketUrl, wsHeaders)
        : await connectWebSocket(socketUrl, wsHeaders);
    } catch (error) {
      if (options.mode === "auto") {
        reportAutoFallback({
          reason: "websocket_connect_failed",
          requestUrl,
          error,
        });
        reportTransportSelected({
          requestUrl,
          transport: "sse",
          optimizationEnabled: false,
          optimizationReason: "transport_not_websocket",
        });
        return forwardWithSseNormalization();
      }
      throw error;
    }

    if (useReusableConnection) {
      reusableBusy = true;
      clearIdleCloseTimer();
    }

    const { stream: _stream, ...requestBody } = parsedBody;
    const fullRequestBody = cloneJsonObject(requestBody);
    const payloadResult =
      useReusableConnection && reusableContinuationState
        ? buildIncrementalWebSocketPayload({
            requestBody: fullRequestBody,
            continuationState: reusableContinuationState,
            requestUrl,
          })
        : {
            payload: cloneJsonObject(fullRequestBody),
            optimizationEnabled: false,
            optimizationReason: "no_continuation_state" as const,
          };
    const websocketPayload = payloadResult.payload;
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
        const outputItems: JsonObject[] = [];
        const outputItemDrafts = new Map<string, JsonObject>();
        let canPersistContinuation = true;
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
            const text = await decodeWebSocketData(event);
            if (!text) return;

            let eventJson: Record<string, unknown>;
            try {
              eventJson = JSON.parse(text) as Record<string, unknown>;
            } catch {
              return;
            }

            const eventRecord = asRecord(eventJson);
            if (eventRecord) {
              const nextResponseId = extractResponseId(eventRecord);
              if (nextResponseId) {
                responseId = nextResponseId;
              }

              updateOutputItemDraft(outputItemDrafts, eventRecord);
              const doneItem = extractOutputItemDone(eventRecord);
              if (doneItem) {
                outputItems.push(mergeOutputItemDraft(doneItem, outputItemDrafts));
              }
            }

            const normalized = normalizeResponsesEvent(eventJson, options.normalizeEvent);

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));

            const type = typeof normalized.type === "string" ? normalized.type : "";
            if (type === "error") {
              canPersistContinuation = false;
            }
            if (completionEventTypes.has(type) || type === "error") {
              if (
                useReusableConnection &&
                canPersistContinuation &&
                responseId &&
                connection === ws &&
                connection.readyState === WebSocket.OPEN
              ) {
                reusableContinuationState = {
                  requestBody: fullRequestBody,
                  responseId,
                  outputItems,
                };
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              cleanup();
              controller.close();
            }
          })();
        };

        const onError = (event: Event) => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          controller.error(extractWebSocketError(event));
        };

        const onClose = () => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          try {
            controller.close();
          } catch {}
        };

        const onAbort = () => {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          try {
            controller.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          } catch {}
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

        try {
          connection.send(JSON.stringify({ type: "response.create", ...websocketPayload }));
        } catch (error) {
          canPersistContinuation = false;
          cleanup({ closeConnection: true });
          controller.error(error instanceof Error ? error : new Error(String(error)));
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
  continuationState: ResponsesContinuationState;
  requestUrl: URL;
}): IncrementalPayloadResult {
  const { requestBody, continuationState, requestUrl } = input;
  if (requestBody.previous_response_id != null) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "existing_previous_response_id",
    };
  }

  const currentInput = asJsonArray(requestBody.input);
  const previousInput = asJsonArray(continuationState.requestBody.input);
  if (!currentInput || !previousInput) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "missing_input",
    };
  }

  const currentWithoutInput = omitRequestInputFields(requestBody);
  const previousWithoutInput = omitRequestInputFields(continuationState.requestBody);
  if (!deepEqualJson(currentWithoutInput, previousWithoutInput)) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "request_shape_changed",
    };
  }

  const replayedItems = continuationState.outputItems
    .map((item) =>
      normalizeOutputItemForReplay(item, {
        useStoreReferences: shouldUseStoreReferences(requestBody),
        stripCodexIds: isCodexResponsesRequest(requestUrl),
      }),
    )
    .filter(isJsonObject);
  if (replayedItems.length !== continuationState.outputItems.length) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "unreplayable_output_items",
    };
  }

  const baseline = [...previousInput, ...replayedItems];
  const suffix = sliceJsonArrayPrefix(currentInput, baseline);
  if (!suffix) {
    return {
      payload: cloneJsonObject(requestBody),
      optimizationEnabled: false,
      optimizationReason: "not_prefix_extension",
    };
  }

  return {
    payload: {
      ...cloneJsonObject(currentWithoutInput),
      previous_response_id: continuationState.responseId,
      input: suffix,
    },
    optimizationEnabled: true,
    optimizationReason: "incremental_replay",
  };
}

function parseJsonObject(text: string): ResponsesRequestBody {
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Request body is not a JSON object");
  }
  return cloneJsonObject(record);
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
  if (readString(event.type) !== "response.created") return null;
  return readString(asRecord(event.response)?.id) ?? null;
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

function asJsonArray(value: unknown): JsonValue[] | null {
  return Array.isArray(value) ? (value as JsonValue[]) : null;
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
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
    const leftRecord = asRecord(left);
    const rightRecord = asRecord(right);
    if (!leftRecord || !rightRecord) return false;

    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      const key = leftKeys[i]!;
      if (
        !deepEqualJson(
          leftRecord[key] as JsonValue | undefined,
          rightRecord[key] as JsonValue | undefined,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
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
}): Response {
  const { response, requestUrl, method, normalizeEvent } = input;

  if (!response.body) return response;
  if (method !== "POST" || !requestUrl.pathname.endsWith("/responses")) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/event-stream/i.test(contentType)) return response;

  const source = response.body;
  const transformed = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffered = "";

      const flushFrame = (frame: string) => {
        if (frame.length === 0) return;
        const next = normalizeSseFrame(frame, normalizeEvent);
        controller.enqueue(encoder.encode(next));
      };

      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            buffered += decoder.decode(value, { stream: true });

            while (true) {
              const split = findSseFrameDelimiter(buffered);
              if (!split) break;
              const frame = buffered.slice(0, split.index);
              buffered = buffered.slice(split.index + split.delimiterLength);
              flushFrame(frame);
            }
          }

          const tail = decoder.decode();
          if (tail.length > 0) {
            buffered += tail;
          }
          if (buffered.length > 0) {
            flushFrame(buffered);
          }

          controller.close();
        } catch (error) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      })();
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
): string {
  const normalizedFrame = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const dataLines = normalizedFrame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return `${normalizedFrame}\n\n`;
  }

  const data = dataLines.join("\n");
  if (data.trim() === "[DONE]") {
    return "data: [DONE]\n\n";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return `${normalizedFrame}\n\n`;
  }

  const event = asRecord(parsed);
  if (!event) {
    return `${normalizedFrame}\n\n`;
  }

  return `data: ${JSON.stringify(normalizeResponsesEvent(event, normalizeEvent))}\n\n`;
}

function normalizeResponsesEvent(
  event: Record<string, unknown>,
  normalizeEvent: ((event: Record<string, unknown>) => Record<string, unknown>) | undefined,
): Record<string, unknown> {
  const normalized = normalizeEvent ? normalizeEvent(event) : event;
  const withResponseFailureHandled = normalizeResponsesFailureEvent(normalized);
  return normalizeErrorEventShape(withResponseFailureHandled);
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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

function toWebSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const wsHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    wsHeaders[key] = value;
  }

  const existingBeta = wsHeaders["openai-beta"];
  if (existingBeta && existingBeta.length > 0) {
    if (!existingBeta.includes(OPENAI_BETA_RESPONSES_WEBSOCKETS)) {
      wsHeaders["OpenAI-Beta"] = `${existingBeta}, ${OPENAI_BETA_RESPONSES_WEBSOCKETS}`;
      delete wsHeaders["openai-beta"];
    } else {
      wsHeaders["OpenAI-Beta"] = existingBeta;
      delete wsHeaders["openai-beta"];
    }
  } else {
    wsHeaders["OpenAI-Beta"] = OPENAI_BETA_RESPONSES_WEBSOCKETS;
  }

  return wsHeaders;
}

async function decodeRequestBody(input: FetchInput, init?: FetchInit): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));

  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
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
  if (event && typeof event === "object" && "message" in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }
  }

  return new Error("WebSocket error");
}
