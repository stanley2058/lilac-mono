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
import { redactErrorTextForLog } from "@stanley2058/lilac-utils/tagged-error-log";
import { REMOTE_COMPACTION_BETA_FEATURE } from "@stanley2058/lilac-utils/server-compaction-request";
import { AgentAdapterFailure } from "../../agent-adapter";
import {
  captureAgentOperation,
  isAgentPanic,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";
import type { ResponsesDiagnostics } from "./diagnostics";

export interface OpenAIResponsesSocket {
  readonly events: AsyncIterable<ResultType<ResponsesServerEvent, AgentAdapterFailure>>;
  send(payload: ResponsesClientEvent): ResultType<void, AgentAdapterFailure>;
  close(): void;
  isOpen?(): boolean;
  readonly managesContinuation?: boolean;
}
export type OpenAIResponsesConnect = (
  signal: AbortSignal,
  diagnostics?: ResponsesDiagnostics,
) => Promise<ResultType<OpenAIResponsesSocket, AgentAdapterFailure>>;

export function createOpenAIResponsesConnect(
  options: OpenAIResponsesConnectionOptions,
): OpenAIResponsesConnect {
  return async (signal, diagnostics) => {
    const started = performance.now();
    diagnostics?.log("socket.connecting");
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
      diagnostics?.log("socket.connect_failed", { elapsedMs: performance.now() - started }, "warn");
      return Result.err(
        connectionFailure("OpenAI WebSocket connection failed", "safe", created.error),
      );
    }
    const sdk = created.value;
    const stream = sdk.stream();
    const observed = observeSocket(sdk, stream, diagnostics);
    const abort = () => sdk.close();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const opened = await awaitOpen(stream, signal);
    signal.removeEventListener("abort", abort);
    if (opened.ok) {
      const logged = resultOutcome(
        captureAgentOperation(() =>
          diagnostics?.log("socket.open", { elapsedMs: performance.now() - started }),
        ),
      );
      if (!logged.ok && isAgentPanic(logged.error)) {
        const closed = resultOutcome(captureAgentOperation(() => observed.close()));
        if (!closed.ok) rethrowAgentPanic(closed.error);
        rethrowAgentPanic(logged.error);
      }
      return Result.ok(observed);
    }
    const closed = resultOutcome(captureAgentOperation(() => observed.close()));
    const abortReason: {} | null | undefined = signal.reason;
    rethrowAgentPanic(abortReason);
    rethrowAgentPanic(opened.cause);
    if (!closed.ok) rethrowAgentPanic(closed.error);
    diagnostics?.log(
      "socket.connect_failed",
      {
        elapsedMs: performance.now() - started,
        aborted: signal.aborted,
        ...socketFailureFields(opened.cause),
      },
      "warn",
    );
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
  diagnostics?: ResponsesDiagnostics,
): OpenAIResponsesSocket {
  let disposed = false;
  let failed = false;
  let closingOwned = false;
  const state: { failure?: WebSocketError; diagnosticFailure?: OpaqueAgentValue } = {};
  const observeDiagnostic = (operation: () => void): void => {
    const logged = resultOutcome(captureAgentOperation(operation));
    if (!logged.ok && isAgentPanic(logged.error)) state.diagnosticFailure ??= logged.error;
  };
  const settleDiagnosticFailure = (): void => {
    const failure = state.diagnosticFailure;
    state.diagnosticFailure = undefined;
    rethrowAgentPanic(failure);
  };
  const onError = (error: WebSocketError): void => {
    state.failure = error;
    observeDiagnostic(() =>
      diagnostics?.log(
        "socket.error",
        { serverError: error.error !== undefined, ...socketFailureFields(error) },
        "warn",
      ),
    );
  };
  sdk.on("error", onError);
  sdk.on("event", (event) =>
    observeDiagnostic(() => {
      diagnostics?.wire("websocket.receive", event, { eventType: event.type });
      if (
        event.type === "response.created" ||
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        diagnostics?.log("socket.response", {
          eventType: event.type,
          responseId: event.response?.id,
        });
      }
    }),
  );
  sdk.on("raw", (data) =>
    observeDiagnostic(() => {
      diagnostics?.wire(
        "websocket.invalid_frame",
        typeof data === "string"
          ? data
          : {
              binary: true,
              byteLength: Array.isArray(data)
                ? data.reduce((total, part) => total + part.byteLength, 0)
                : data.byteLength,
            },
      );
      diagnostics?.log("socket.invalid_frame", {}, "warn");
    }),
  );
  sdk.once("close", (code, reason, unsent) => {
    sdk.off("error", onError);
    observeDiagnostic(() =>
      diagnostics?.log("socket.close", {
        closeCode: code,
        closeReason: reason,
        unsentCount: unsent.length,
        intentional: disposed,
      }),
    );
    if (disposed && !closingOwned) settleDiagnosticFailure();
  });
  const currentFailure = (): WebSocketError | undefined => state.failure;
  return {
    isOpen: () => !disposed && !failed && sdk.socket.readyState === 1,
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === "error") rethrowAgentPanic(sdkFailureCause(event.error));
          settleDiagnosticFailure();
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
        settleDiagnosticFailure();
      },
    },
    send(payload) {
      if (disposed || failed || sdk.socket.readyState !== 1)
        return Result.err(connectionFailure("OpenAI WebSocket is not open", "reconcile"));
      state.failure = undefined;
      diagnostics?.wire("websocket.send", payload, { eventType: payload.type });
      diagnostics?.log("socket.send", { eventType: payload.type });
      const sent = resultOutcome(captureAgentOperation(() => sdk.send(payload)));
      const failure = currentFailure();
      state.failure = undefined;
      const diagnosticFailure = state.diagnosticFailure;
      state.diagnosticFailure = undefined;
      if (!sent.ok) rethrowAgentPanic(sent.error);
      if (failure) rethrowAgentPanic(sdkFailureCause(failure));
      rethrowAgentPanic(diagnosticFailure);
      if (!sent.ok) {
        return Result.err(
          connectionFailure("OpenAI WebSocket send failed", "reconcile", sent.error),
        );
      }
      if (failure) {
        return Result.err(
          connectionFailure("OpenAI WebSocket send failed", "reconcile", sdkFailureCause(failure)),
        );
      }
      settleDiagnosticFailure();
      return Result.ok(undefined);
    },
    close() {
      if (disposed) {
        settleDiagnosticFailure();
        return;
      }
      disposed = true;
      const previousFailure = currentFailure();
      observeDiagnostic(() => diagnostics?.log("socket.closing"));
      void stream.return?.();
      state.failure = undefined;
      closingOwned = true;
      const closed = resultOutcome(captureAgentOperation(() => sdk.close()));
      closingOwned = false;
      const failure = currentFailure();
      const diagnosticFailure = state.diagnosticFailure;
      state.diagnosticFailure = undefined;
      if (previousFailure) rethrowAgentPanic(sdkFailureCause(previousFailure));
      if (!closed.ok) rethrowAgentPanic(closed.error);
      if (failure) rethrowAgentPanic(sdkFailureCause(failure));
      rethrowAgentPanic(diagnosticFailure);
      if (!closed.ok) signalSocketCloseFailure(closed.error);
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

function socketFailureFields(cause: OpaqueAgentValue) {
  if (!(cause instanceof Error)) return {};
  return {
    errorTag: redactErrorTextForLog(cause.name),
    errorMessage: redactErrorTextForLog(cause.message),
  };
}
