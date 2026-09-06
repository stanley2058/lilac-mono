import { Result, type Result as ResultType } from "better-result";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import type {
  WebSocketError,
  ResponsesStreamMessage,
} from "openai/resources/responses/internal-base";
import {
  toOpenAIResponsesWebSocketHeaders,
  type OpenAIResponsesConnectionOptions,
} from "@stanley2058/lilac-utils/openai-responses-connection";
import { REMOTE_COMPACTION_BETA_FEATURE } from "@stanley2058/lilac-utils/server-compaction-request";
import { AgentAdapterFailure } from "../../agent-adapter";
import {
  captureAgentOperation,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";

export interface OpenAIResponsesSocket {
  readonly events: AsyncIterable<ResultType<ResponsesServerEvent, AgentAdapterFailure>>;
  send(payload: ResponsesClientEvent): ResultType<void, AgentAdapterFailure>;
  close(): void;
  isOpen?(): boolean;
  readonly managesContinuation?: boolean;
}
export type OpenAIResponsesConnect = (
  signal: AbortSignal,
) => Promise<ResultType<OpenAIResponsesSocket, AgentAdapterFailure>>;

export function createOpenAIResponsesConnect(
  options: OpenAIResponsesConnectionOptions,
): OpenAIResponsesConnect {
  return async (signal) => {
    const created = resultOutcome(
      captureAgentOperation(() => {
        signal.throwIfAborted();
        const client = new OpenAI({
          apiKey:
            new Headers(options.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "unused",
          baseURL: options.baseUrl,
          maxRetries: 0,
        });
        return new ResponsesWS(client, {
          headers: toOpenAIResponsesWebSocketHeaders(nativeHeaders(options.headers)),
          handshakeTimeout: 30_000,
          reconnect: null,
        });
      }),
    );
    if (!created.ok) {
      rethrowAgentPanic(created.error);
      return Result.err(
        connectionFailure("OpenAI WebSocket connection failed", "safe", created.error),
      );
    }
    const sdk = created.value;
    const stream = sdk.stream();
    const observed = observeSocket(sdk, stream);
    const abort = () => sdk.close();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const opened = await awaitOpen(stream, signal);
    signal.removeEventListener("abort", abort);
    if (opened.ok) return Result.ok(observed);
    const closed = resultOutcome(captureAgentOperation(() => observed.close()));
    const abortReason: {} | null | undefined = signal.reason;
    rethrowAgentPanic(abortReason);
    rethrowAgentPanic(opened.cause);
    if (!closed.ok) rethrowAgentPanic(closed.error);
    return Result.err(
      connectionFailure("OpenAI WebSocket closed before opening", "safe", opened.cause),
    );
  };
}

async function awaitOpen(
  stream: AsyncIterableIterator<ResponsesStreamMessage>,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; cause?: OpaqueAgentValue }> {
  while (true) {
    const next = await stream.next();
    if (signal.aborted || next.done) return { ok: false };
    const event = next.value;
    if (event.type === "open") return { ok: true };
    if (event.type === "connecting") continue;
    return {
      ok: false,
      cause: event.type === "error" ? sdkFailureCause(event.error) : undefined,
    };
  }
}

function nativeHeaders(headers: Record<string, string>): Record<string, string> {
  const resolved = new Headers(headers);
  const features = (resolved.get("x-codex-beta-features") ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  resolved.set(
    "x-codex-beta-features",
    [...new Set([...features, REMOTE_COMPACTION_BETA_FEATURE])].join(","),
  );
  const result = Object.fromEntries(resolved.entries());
  const authorization = result.authorization;
  if (authorization !== undefined) {
    delete result.authorization;
    result.Authorization = authorization;
  }
  return result;
}

function connectionFailure(
  message: string,
  replaySafety: "safe" | "reconcile",
  cause?: AgentAdapterFailure["cause"],
): AgentAdapterFailure {
  return new AgentAdapterFailure({ reason: "unavailable", message, replaySafety, cause });
}

function observeSocket(
  sdk: ResponsesWS,
  stream: AsyncIterableIterator<ResponsesStreamMessage>,
): OpenAIResponsesSocket {
  let disposed = false;
  let failed = false;
  const state: { failure?: WebSocketError } = {};
  const onError = (error: WebSocketError): void => {
    state.failure = error;
  };
  sdk.on("error", onError);
  sdk.once("close", () => sdk.off("error", onError));
  const currentFailure = (): WebSocketError | undefined => state.failure;
  return {
    isOpen: () => !disposed && !failed && sdk.socket.readyState === 1,
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (disposed) return;
          if (event.type === "message") {
            yield Result.ok(event.message);
            continue;
          }
          if (event.type === "error" && event.error.error) {
            yield Result.ok(event.error.error);
            continue;
          }
          failed = true;
          if (event.type === "error") rethrowAgentPanic(sdkFailureCause(event.error));
          yield Result.err(
            connectionFailure(
              event.type === "error"
                ? event.error.message
                : "OpenAI WebSocket closed or sent an invalid protocol frame",
              "reconcile",
              event.type === "error" ? event.error : undefined,
            ),
          );
          return;
        }
      },
    },
    send(payload) {
      if (disposed || failed || sdk.socket.readyState !== 1)
        return Result.err(connectionFailure("OpenAI WebSocket is not open", "reconcile"));
      state.failure = undefined;
      const sent = resultOutcome(captureAgentOperation(() => sdk.send(payload)));
      if (!sent.ok) {
        rethrowAgentPanic(sent.error);
        return Result.err(
          connectionFailure("OpenAI WebSocket send failed", "reconcile", sent.error),
        );
      }
      const failure = currentFailure();
      if (failure) {
        rethrowAgentPanic(sdkFailureCause(failure));
        return Result.err(
          connectionFailure("OpenAI WebSocket send failed", "reconcile", sdkFailureCause(failure)),
        );
      }
      return Result.ok(undefined);
    },
    close() {
      if (disposed) return;
      disposed = true;
      void stream.return?.();
      state.failure = undefined;
      const closed = resultOutcome(captureAgentOperation(() => sdk.close()));
      if (!closed.ok) signalSocketCloseFailure(closed.error);
      const failure = currentFailure();
      if (failure) signalSocketCloseFailure(sdkFailureCause(failure));
    },
  };
}

function signalSocketCloseFailure(cause: OpaqueAgentValue): never {
  throw cause;
}

function sdkFailureCause(error: WebSocketError): OpaqueAgentValue {
  return error.cause ?? error;
}
