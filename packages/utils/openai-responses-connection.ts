import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { ResponsesTransportMode } from "./env";
import { isPanic } from "./runtime-utils";

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const CONNECTION_TIMEOUT_MS = 30_000;

export class OpenAIResponsesConfigurationInvalid extends TaggedError(
  "OpenAIResponsesConfigurationInvalid",
)<{
  readonly reason: "missing-api-key" | "invalid-base-url";
  readonly message: string;
}> {}

export class OpenAIResponsesConnectionFailed extends TaggedError(
  "OpenAIResponsesConnectionFailed",
)<{
  readonly reason: "connection" | "aborted" | "timeout";
  readonly message: string;
  readonly error: Error;
}> {}

export type OpenAIResponsesConnectionOptions = {
  readonly baseUrl: string;
  readonly requestUrl: URL;
  readonly websocketUrl: string;
  readonly headers: Record<string, string>;
  readonly mode: ResponsesTransportMode;
};

export function resolveOpenAIResponsesConnectionOptions(settings: {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly responsesTransport: ResponsesTransportMode;
}): ResultType<OpenAIResponsesConnectionOptions, OpenAIResponsesConfigurationInvalid> {
  if (settings.apiKey === undefined) {
    return Result.err(
      new OpenAIResponsesConfigurationInvalid({
        reason: "missing-api-key",
        message: "OpenAI API key is missing",
      }),
    );
  }
  const baseUrl = (settings.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "");
  const parsed = Result.try({
    try: () => new URL(`${baseUrl}/responses`),
    catch: (cause) => ({ cause }),
  });
  if (parsed.isErr()) {
    if (isPanic(parsed.error.cause)) throw parsed.error.cause;
    return Result.err(
      new OpenAIResponsesConfigurationInvalid({
        reason: "invalid-base-url",
        message: "OpenAI base URL is invalid",
      }),
    );
  }
  return parsed
    .mapError(
      () =>
        new OpenAIResponsesConfigurationInvalid({
          reason: "invalid-base-url",
          message: "OpenAI base URL is invalid",
        }),
    )
    .andThen((requestUrl) => {
      if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
        return Result.err(
          new OpenAIResponsesConfigurationInvalid({
            reason: "invalid-base-url",
            message: "OpenAI base URL must use HTTP or HTTPS",
          }),
        );
      }
      return Result.ok({
        baseUrl,
        requestUrl,
        websocketUrl: openAIResponsesWebSocketUrl(requestUrl),
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        mode: settings.responsesTransport,
      });
    });
}

export function openAIResponsesWebSocketUrl(requestUrl: URL): string {
  const url = new URL(requestUrl.toString());
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

export function toOpenAIResponsesWebSocketHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const wsHeaders = { ...headers };
  const existingBeta = wsHeaders["openai-beta"] ?? wsHeaders["OpenAI-Beta"];
  let beta = OPENAI_BETA_RESPONSES_WEBSOCKETS;
  if (existingBeta) {
    beta = existingBeta.includes(OPENAI_BETA_RESPONSES_WEBSOCKETS)
      ? existingBeta
      : `${existingBeta}, ${OPENAI_BETA_RESPONSES_WEBSOCKETS}`;
  }
  wsHeaders["OpenAI-Beta"] = beta;
  delete wsHeaders["openai-beta"];
  return wsHeaders;
}

type WebSocketWithHeadersConstructor = {
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

export function connectOpenAIResponsesWebSocket(options: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
}): Promise<ResultType<WebSocket, OpenAIResponsesConnectionFailed>> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (reason: OpenAIResponsesConnectionFailed["reason"], error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const closed = Result.try({ try: () => socket?.close(), catch: (cause) => ({ cause }) });
      if (closed.isErr()) {
        if (isPanic(closed.error.cause)) {
          reject(closed.error.cause);
          return;
        }
      }
      if (isPanic(error)) {
        reject(error);
        return;
      }
      resolve(
        Result.err(new OpenAIResponsesConnectionFailed({ reason, error, message: error.message })),
      );
    };
    const onOpen = () => {
      if (!socket || settled) return;
      settled = true;
      cleanup();
      resolve(Result.ok(socket));
    };
    const onError = (event: Event) =>
      fail(
        "connection",
        new Error(event instanceof ErrorEvent && event.message ? event.message : "WebSocket error"),
      );
    const onAbort = () => {
      const cause = options.signal?.reason ?? new DOMException("Aborted", "AbortError");
      fail("aborted", cause instanceof Error ? cause : new Error(String(cause)));
    };
    const timeout = setTimeout(
      () =>
        fail(
          "timeout",
          new DOMException("WebSocket connection timed out before opening", "TimeoutError"),
        ),
      CONNECTION_TIMEOUT_MS,
    );
    const created = Result.try({
      try: () => {
        options.signal?.throwIfAborted();
        const WebSocketCtor = globalThis.WebSocket as typeof globalThis.WebSocket &
          WebSocketWithHeadersConstructor;
        return new WebSocketCtor(options.url, {
          headers: toOpenAIResponsesWebSocketHeaders(options.headers),
        });
      },
      catch: (cause) => ({ cause }),
    });
    if (created.isErr()) {
      cleanup();
      const cause = created.error.cause;
      if (isPanic(cause)) {
        reject(cause);
        return;
      }
      fail(
        options.signal?.aborted ? "aborted" : "connection",
        cause instanceof Error ? cause : new Error(String(cause)),
      );
      return;
    }
    socket = created.match({ ok: (value) => value, err: () => undefined });
    socket?.addEventListener("open", onOpen, { once: true });
    socket?.addEventListener("error", onError, { once: true });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
