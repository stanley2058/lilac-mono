import type { ResponsesTransportMode } from "./env";

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export type CreateOpenAIResponsesWebSocketFetchOptions = {
  mode: ResponsesTransportMode;
  url?: string | ((requestUrl: URL) => string);
  fetch?: typeof globalThis.fetch;
  completionEventTypes?: readonly string[];
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  idleTimeoutMs?: number;
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

type WebSocketWithHeadersConstructor = {
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

export function createOpenAIResponsesWebSocketFetch(
  options: CreateOpenAIResponsesWebSocketFetchOptions,
): OpenAIResponsesWebSocketFetch {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const completionEventTypes = new Set(options.completionEventTypes ?? ["response.completed"]);
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;

  let ws: WebSocket | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let connectingKey: string | null = null;
  let reusableBusy = false;
  let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionHeadersKey: string | null = null;

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
      return;
    }

    idleCloseTimer = setTimeout(() => {
      if (!reusableBusy && ws?.readyState === WebSocket.OPEN) {
        closeSocket(ws);
        ws = null;
        connectionHeadersKey = null;
      }
      idleCloseTimer = null;
    }, idleTimeoutMs);
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

    if (
      options.mode === "sse" ||
      method !== "POST" ||
      !requestUrl.pathname.endsWith("/responses")
    ) {
      return fetchFn(input, init);
    }

    const encodedBody = await decodeRequestBody(input, init);
    if (encodedBody === undefined) {
      return fetchFn(input, init);
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(encodedBody) as Record<string, unknown>;
    } catch {
      return fetchFn(input, init);
    }

    if (parsedBody.stream !== true) {
      return fetchFn(input, init);
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
        return fetchFn(input, init);
      }
      throw error;
    }

    if (useReusableConnection) {
      reusableBusy = true;
      clearIdleCloseTimer();
    }

    const { stream: _stream, ...requestBody } = parsedBody;
    const encoder = new TextEncoder();

    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let cleanedUp = false;
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

          if (shouldClose) {
            closeSocket(connection);
            if (ws === connection) {
              ws = null;
              connectionHeadersKey = null;
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

            const normalized = options.normalizeEvent
              ? options.normalizeEvent(eventJson)
              : eventJson;

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));

            const type = typeof normalized.type === "string" ? normalized.type : "";
            if (completionEventTypes.has(type) || type === "error") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              cleanup();
              controller.close();
            }
          })();
        };

        const onError = (event: Event) => {
          cleanup({ closeConnection: true });
          controller.error(extractWebSocketError(event));
        };

        const onClose = () => {
          cleanup({ closeConnection: true });
          try {
            controller.close();
          } catch {}
        };

        const onAbort = () => {
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
          connection.send(JSON.stringify({ type: "response.create", ...requestBody }));
        } catch (error) {
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
      reusableBusy = false;
    },
  }) as OpenAIResponsesWebSocketFetch;
}

function getRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
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
