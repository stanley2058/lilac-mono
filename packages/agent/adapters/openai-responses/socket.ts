import { Result, type Result as ResultType } from "better-result";
import {
  connectOpenAIResponsesWebSocket,
  type OpenAIResponsesConnectionOptions,
} from "@stanley2058/lilac-utils/openai-responses-connection";
import { REMOTE_COMPACTION_BETA_FEATURE } from "@stanley2058/lilac-utils/server-compaction-request";
import { AgentAdapterFailure } from "../../agent-adapter";
import { captureAgentOperation, rethrowAgentPanic } from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";

export interface OpenAIResponsesSocket {
  readonly events: AsyncIterable<ResultType<string, AgentAdapterFailure>>;
  send(payload: string): ResultType<void, AgentAdapterFailure>;
  close(): void;
}
export type OpenAIResponsesConnect = (
  signal: AbortSignal,
) => Promise<ResultType<OpenAIResponsesSocket, AgentAdapterFailure>>;

export function createOpenAIResponsesConnect(
  options: OpenAIResponsesConnectionOptions,
): OpenAIResponsesConnect {
  return async (signal) => {
    const connected = await connectOpenAIResponsesWebSocket({
      url: options.websocketUrl,
      headers: nativeHeaders(options.headers),
      signal,
    });
    return connected
      .mapError(
        (error) =>
          new AgentAdapterFailure({
            reason: "unavailable",
            message: error.message,
            replaySafety: "safe",
            cause: error.error,
          }),
      )
      .map(observeSocket);
  };
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
  return Object.fromEntries(resolved.entries());
}

function observeSocket(socket: WebSocket): OpenAIResponsesSocket {
  const pending: Array<ResultType<string, AgentAdapterFailure>> = [];
  let notify = Promise.withResolvers<void>();
  let closed = false;
  let disposed = false;
  const push = (value: ResultType<string, AgentAdapterFailure>): void => {
    if (closed) return;
    pending.push(value);
    notify.resolve();
  };
  const fail = (message: string): void => {
    push(
      Result.err(
        new AgentAdapterFailure({ reason: "unavailable", message, replaySafety: "reconcile" }),
      ),
    );
    closed = true;
    notify.resolve();
  };
  const onMessage = (event: MessageEvent): void => {
    if (typeof event.data === "string") {
      push(Result.ok(event.data));
      return;
    }
    fail("OpenAI WebSocket sent a non-text protocol frame");
  };
  const onError = (): void => fail("OpenAI WebSocket connection failed");
  const onClose = (): void => fail("OpenAI WebSocket closed before execution settled");
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        while (!closed || pending.length > 0) {
          const value = pending.shift();
          if (value) {
            yield value;
            continue;
          }
          await notify.promise;
          notify = Promise.withResolvers<void>();
        }
      },
    },
    send(payload) {
      if (closed || socket.readyState !== WebSocket.OPEN)
        return Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            message: "OpenAI WebSocket is not open",
            replaySafety: "reconcile",
          }),
        );
      const result = resultOutcome(captureAgentOperation(() => socket.send(payload)));
      if (!result.ok) {
        rethrowAgentPanic(result.error);
        return Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            message: "OpenAI WebSocket send failed",
            replaySafety: "reconcile",
            cause: result.error,
          }),
        );
      }
      return Result.ok(undefined);
    },
    close() {
      if (disposed) return;
      disposed = true;
      closed = true;
      notify.resolve();
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.close();
    },
  };
}
