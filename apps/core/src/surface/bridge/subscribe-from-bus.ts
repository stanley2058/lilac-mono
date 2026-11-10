import { captureError } from "../../shared/error-capture";
import {
  lilacEventTypes,
  outReqTopic,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { createLogger, env, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import type {
  SurfaceFinalTextMode,
  SurfaceAdapter,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  SurfaceOutputStream,
  SurfaceOperationError,
  SurfaceOperationResult,
  StartOutputOpts,
  TypingIndicatorSubscription,
} from "../adapter";
import type { MsgRef, SessionRef } from "../types";
import type {
  RegisteredSurfacePlatform,
  SurfaceIngressAcknowledgementCleanupFailed,
  SurfaceRelayPolicy,
  SurfaceReplyTargetInvalid,
  SurfaceRefInvalid,
} from "../runtime-descriptor";
import { requireSurfaceRelayPolicyRefs } from "../produced-ref-guard";

import { parseRequestControlFromRaw } from "./bus-agent-runner/raw";
import { resolveReplyDeliveryFromFinalText } from "./reply-directive";

import type { TranscriptStore } from "../../transcript/transcript-store";
import { consumerId } from "../../shared/event-bus-consumer";
import { adaptEventPublishResultToHost } from "../../shared/event-bus-result";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import { formatBridgeTaggedErrorForLog } from "./bridge-log";
import {
  createRelayStreamState,
  reduceRelayStreamEvent,
  withoutStreamPhaseBoundary,
} from "./relay-output-reducer";
import {
  finishDiscordMessageLatencyTrace,
  recordRequestLatencyStage,
} from "./request-latency-trace";
import {
  materializeSurfaceOutputAttachment,
  type SurfaceOutputBlobMaterializationFailed,
} from "./generated-output-materialization";

class CmdRequestRequiredHeadersMissing extends TaggedError("CmdRequestRequiredHeadersMissing")<{
  readonly message: string;
}> {}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

class CmdRequestCancelFailed extends TaggedError("CmdRequestCancelFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class RelayEventCorrelationInvalid extends TaggedError("RelayEventCorrelationInvalid")<{
  readonly messageType: string;
  readonly message: string;
}> {}

type CmdRequestDeliveryError =
  | CmdRequestRequiredHeadersMissing
  | CmdRequestCancelFailed
  | RelayEventCorrelationInvalid;

function applyCmdRequestDeliveryPolicy(error: CmdRequestDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "CmdRequestRequiredHeadersMissing":
      return "dead-letter";
    case "CmdRequestCancelFailed":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class CmdSurfaceRequiredHeadersMissing extends TaggedError("CmdSurfaceRequiredHeadersMissing")<{
  readonly message: string;
}> {}

class CmdSurfaceReanchorFailed extends TaggedError("CmdSurfaceReanchorFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class CmdSurfaceReplyTargetInvalid extends TaggedError("CmdSurfaceReplyTargetInvalid")<{
  readonly cause: SurfaceRefInvalid;
  readonly message: string;
}> {}

type CmdSurfaceDeliveryError =
  | CmdSurfaceRequiredHeadersMissing
  | CmdSurfaceReanchorFailed
  | CmdSurfaceReplyTargetInvalid
  | RelayEventCorrelationInvalid;

function applyCmdSurfaceDeliveryPolicy(error: CmdSurfaceDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "CmdSurfaceRequiredHeadersMissing":
      return "dead-letter";
    case "CmdSurfaceReanchorFailed":
    case "CmdSurfaceReplyTargetInvalid":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class EvtRequestRequiredHeadersMissing extends TaggedError("EvtRequestRequiredHeadersMissing")<{
  readonly message: string;
}> {}

class EvtRequestStopTypingFailed extends TaggedError("EvtRequestStopTypingFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class EvtRequestReplyTargetInvalid extends TaggedError("EvtRequestReplyTargetInvalid")<{
  readonly cause: SurfaceReplyTargetInvalid;
  readonly message: string;
}> {}

type EvtRequestDeliveryError =
  | EvtRequestRequiredHeadersMissing
  | EvtRequestStopTypingFailed
  | EvtRequestReplyTargetInvalid
  | RelayEventCorrelationInvalid;

function applyEvtRequestDeliveryPolicy(error: EvtRequestDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "EvtRequestRequiredHeadersMissing":
      return "dead-letter";
    case "EvtRequestReplyTargetInvalid":
      return "dead-letter";
    case "EvtRequestStopTypingFailed":
      return "commit";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

class OutReqPushFailed extends TaggedError("OutReqPushFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

class OutReqFinishFailed extends TaggedError("OutReqFinishFailed")<{
  readonly cause: BusToAdapterEffectFailed;
  readonly message: string;
}> {}

type OutReqDeliveryError =
  | OutReqPushFailed
  | OutReqFinishFailed
  | SurfaceOutputBlobMaterializationFailed
  | RelayEventCorrelationInvalid;

type BusToAdapterEffect =
  | "abort-output"
  | "cancel-active-relay"
  | "cleanup-skipped-output"
  | "clear-ingress-acknowledgement"
  | "delete-transcript-checkpoint"
  | "finish-output"
  | "link-transcript"
  | "publish-output-created"
  | "push-output"
  | "reanchor-output"
  | "start-output"
  | "start-typing"
  | "stop-output-subscription"
  | "stop-relay"
  | "stop-typing"
  | "unlink-output";

export class BusToAdapterEffectFailed extends TaggedError("BusToAdapterEffectFailed")<{
  readonly operation: BusToAdapterEffect;
  readonly failureKind: "external-effect" | "partial-completion" | "permanent" | "transient";
  readonly surfaceErrorTag: SurfaceOperationError["_tag"] | null;
  readonly created: MsgRef | null;
  readonly cause: unknown;
  readonly message: string;
}> {}

function applyOutReqDeliveryPolicy(error: OutReqDeliveryError): DeliveryDisposition {
  switch (error._tag) {
    case "OutReqPushFailed":
    case "OutReqFinishFailed":
    case "SurfaceOutputBlobMaterializationFailed":
      return "stop";
    case "RelayEventCorrelationInvalid":
      return "dead-letter";
  }
}

type ResultSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export function rethrowBusToAdapterPanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

export async function captureBusToAdapterEffect<T>(
  operation: BusToAdapterEffect,
  effect: () => Promise<T>,
): Promise<ResultType<T, BusToAdapterEffectFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await effect());
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      rethrowBusToAdapterPanic(cause);
      if (cause instanceof BusToAdapterEffectFailed) return Result.err(cause);
      return Result.err(
        new BusToAdapterEffectFailed({
          operation,
          failureKind: "external-effect",
          surfaceErrorTag: null,
          created: null,
          cause,
          message: `Bus-to-adapter effect failed: ${operation}`,
        }),
      );
    }
    return attempt.value;
  }
}

function classifySurfaceOperationForRelay(
  operation: BusToAdapterEffect,
  error: SurfaceOperationError,
): BusToAdapterEffectFailed {
  switch (error._tag) {
    case "SurfaceOperationUnsupported":
    case "SurfacePlatformMismatch":
    case "SurfaceSessionMismatch":
    case "SurfaceInvalidInput":
    case "SurfaceMessageNotFound":
    case "SurfacePermissionDenied":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "permanent",
        surfaceErrorTag: error._tag,
        created: null,
        cause: { errorTag: error._tag },
        message: `Surface relay operation '${operation}' was rejected permanently (${error._tag})`,
      });
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "transient",
        surfaceErrorTag: error._tag,
        created: null,
        cause:
          error._tag === "SurfaceRateLimited"
            ? { errorTag: error._tag, retryAfterMs: error.retryAfterMs }
            : { errorTag: error._tag },
        message: `Surface relay operation '${operation}' failed transiently (${error._tag})`,
      });
    case "SurfaceOperationPartiallyCompleted":
      return new BusToAdapterEffectFailed({
        operation,
        failureKind: "partial-completion",
        surfaceErrorTag: error._tag,
        created: error.created,
        cause: { errorTag: error._tag },
        message: `Surface relay operation '${operation}' partially completed`,
      });
  }
}

export function adaptSurfaceOperationToRelay<T>(
  operation: BusToAdapterEffect,
  result: SurfaceOperationResult<T>,
): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw classifySurfaceOperationForRelay(operation, error);
    },
  })();
}

export function adaptBusToAdapterSubscriptionStart(
  started: ResultType<ResultSubscription, EventDeliveryStartFailed>,
): ResultSubscription {
  return started.match({
    ok: (subscription) => () => subscription,
    err: (error) => () => {
      throw error;
    },
  })();
}

export function adaptBusToAdapterSubscriptionStop(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  stopped.match({
    ok: () => () => undefined,
    err: (error) => () => {
      throw error;
    },
  })();
}

export async function superviseBusToAdapterCleanup(
  effects: readonly (() => Promise<void>)[],
): Promise<void> {
  let failureCause: unknown;
  let failureIsPanic = false;
  let hasFailure = false;
  for (const effect of effects) {
    await Result.tryPromise({
      try: effect,
      catch: (cause) => {
        const panic = Panic.is(cause);
        if (!hasFailure || (panic && !failureIsPanic)) {
          failureCause = cause;
          failureIsPanic = panic;
          hasFailure = true;
        }
      },
    });
  }
  if (hasFailure) throw failureCause;
}

async function runBusToAdapterBestEffort(input: {
  operation: BusToAdapterEffect;
  effect: () => Promise<void>;
  logger?: Logger;
  logLevel?: "debug" | "warn" | "error";
  logMessage?: string;
  context?: Readonly<Record<string, string | number | boolean | undefined>>;
}): Promise<void> {
  const result = await captureBusToAdapterEffect(input.operation, input.effect);
  result.match({
    ok: () => undefined,
    err: (error) => {
      if (!input.logger || !input.logLevel || !input.logMessage) return;
      input.logger[input.logLevel](
        input.logMessage,
        formatBridgeTaggedErrorForLog(error, input.context),
      );
    },
  });
}

export function logIngressAcknowledgementCleanupFailure(input: {
  readonly logger: Pick<Logger, "warn">;
  readonly error: SurfaceIngressAcknowledgementCleanupFailed;
  readonly requestId: string;
  readonly sessionId: string;
}): void {
  input.logger.warn(
    "failed to clear ingress acknowledgement",
    formatBridgeTaggedErrorForLog(input.error, {
      requestId: input.requestId,
      sessionId: input.sessionId,
      causeErrorTag: input.error.cause.errorTag,
      causeErrorMessage: input.error.cause.errorMessage,
    }),
  );
}

function observeSubscriptionDone(
  subscription: ResultSubscription,
  topic: string,
  logger: Logger,
): void {
  void subscription.done.then((done) => {
    done.match({
      ok: () => undefined,
      err: (error) => {
        logger.error("event subscription stopped", formatBridgeTaggedErrorForLog(error, { topic }));
      },
    });
  });
}

async function stopResultSubscription(subscription: ResultSubscription): Promise<void> {
  adaptBusToAdapterSubscriptionStop(await subscription.stop());
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

function parseRouterSessionMode(raw: string | undefined): "mention" | "active" | undefined {
  if (raw === "mention" || raw === "active") return raw;
  return undefined;
}

type ActiveRelay = {
  requestId: string;
  sessionId: string;
  platform: RegisteredSurfacePlatform;
  stopTyping(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  startedAt: number;
  firstOutLogged: boolean;
  reanchor(input: {
    inheritReplyTo: boolean;
    mode?: "steer" | "interrupt";
    replyTo?: MsgRef;
  }): Promise<void>;
};

export function mergeContinuationText(existing: string, continuation: string): string {
  if (existing.length === 0) return continuation;
  if (continuation.length === 0) return existing;
  if (continuation.startsWith(existing)) return continuation;

  const overlap = longestSuffixPrefixOverlap(existing, continuation);
  return `${existing}${continuation.slice(overlap)}`;
}

/** Length of the longest suffix of `text` that is a prefix of `pattern`, in linear time (KMP). */
function longestSuffixPrefixOverlap(text: string, pattern: string): number {
  const maxOverlap = Math.min(text.length, pattern.length);
  const prefix = pattern.slice(0, maxOverlap);
  const failure = new Int32Array(prefix.length);
  for (let index = 1, matched = 0; index < prefix.length; index += 1) {
    while (matched > 0 && prefix[index] !== prefix[matched]) matched = failure[matched - 1] ?? 0;
    if (prefix[index] === prefix[matched]) matched += 1;
    failure[index] = matched;
  }
  let matched = 0;
  for (let index = text.length - maxOverlap; index < text.length; index += 1) {
    while (matched > 0 && (matched === prefix.length || text[index] !== prefix[matched])) {
      matched = failure[matched - 1] ?? 0;
    }
    if (text[index] === prefix[matched]) matched += 1;
  }
  return matched;
}

export async function bridgeBusToAdapter<P extends RegisteredSurfacePlatform>(params: {
  adapter: SurfaceAdapter;
  blobStore: BlobStore;
  bus: LilacBus;
  platform: P;
  policy: SurfaceRelayPolicy<P>;
  subscriptionId: string;
  idleTimeoutMs?: number;
  scheduleIdleTimeout?: (callback: () => void, delayMs: number) => () => void;
  transcriptStore?: TranscriptStore;
}) {
  const logger = createLogger({
    module: "bridge:bus-to-adapter",
  });

  const {
    adapter,
    bus,
    platform,
    subscriptionId,
    idleTimeoutMs = 60 * 60 * 1000,
    scheduleIdleTimeout = scheduleTimeout,
  } = params;
  const policy = requireSurfaceRelayPolicyRefs(platform, params.policy);

  const activeRelays = new Map<string, ActiveRelay>();
  const terminalLifecycleByRequestId = new Map<
    string,
    {
      readonly platform: RegisteredSurfacePlatform;
      readonly sessionId: string;
      readonly at: number;
    }
  >();
  const TERMINAL_LIFECYCLE_TTL_MS = 5 * 60 * 1000;

  const pruneTerminalLifecycleCache = (nowMs: number) => {
    for (const [rid, terminal] of terminalLifecycleByRequestId) {
      if (nowMs - terminal.at > TERMINAL_LIFECYCLE_TTL_MS) {
        terminalLifecycleByRequestId.delete(rid);
      }
    }
  };
  let ingressStopped = false;
  const correlationError = (messageType: string) =>
    Result.err(
      new RelayEventCorrelationInvalid({
        messageType,
        message: "Relay event platform or session does not match its request correlation",
      }),
    );
  const matchesRelay = (relay: ActiveRelay, eventPlatform: string, eventSessionId: string) =>
    relay.platform === eventPlatform && relay.sessionId === eventSessionId;

  const cmdRequestStarted = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:cmd_request`,
      consumerId: consumerId(`${subscriptionId}:cmd_request`),
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, CmdRequestDeliveryError>> => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;

      if (!requestId || !sessionId || !requestClient) {
        if (requestId && activeRelays.has(requestId)) return correlationError(msg.type);
        logger.warn("relay.event.rejected", {
          requestId,
          sessionId,
          platform,
          reason: "missing_headers",
          messageType: msg.type,
        });
        return Result.err(
          new CmdRequestRequiredHeadersMissing({
            message:
              "cmd.request.message missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        const relay = activeRelays.get(requestId);
        if (relay) return correlationError(msg.type);
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      const cancel = parseRequestControlFromRaw(msg.data.raw).cancel;

      if (!cancel) {
        return Result.ok(undefined);
      }

      const relay = activeRelays.get(requestId);
      if (!relay) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          reason: "no_active_relay",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }
      if (!matchesRelay(relay, requestClient, sessionId)) return correlationError(msg.type);

      const cancelled = await captureBusToAdapterEffect("cancel-active-relay", () =>
        relay.cancel(),
      );
      return cancelled.match<ResultType<void, CmdRequestDeliveryError>>({
        ok: () => Result.ok(undefined),
        err: (error) => {
          logger.error(
            "failed to cancel active relay",
            formatBridgeTaggedErrorForLog(error, { requestId, sessionId }),
          );
          return Result.err(
            new CmdRequestCancelFailed({
              cause: error,
              message: "Failed to cancel active relay",
            }),
          );
        },
      });
    },
    applyCmdRequestDeliveryPolicy,
  );
  const cmdRequestSub = adaptBusToAdapterSubscriptionStart(cmdRequestStarted);
  observeSubscriptionDone(cmdRequestSub, "cmd.request", logger);

  const cmdSurfaceStarted = await bus.subscribeTopic(
    "cmd.surface",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:cmd_surface`,
      consumerId: consumerId(`${subscriptionId}:cmd_surface`),
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, CmdSurfaceDeliveryError>> => {
      if (msg.type !== lilacEventTypes.CmdSurfaceOutputReanchor) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      if (!requestId || !sessionId || !requestClient) {
        if (requestId && activeRelays.has(requestId)) return correlationError(msg.type);
        return Result.err(
          new CmdSurfaceRequiredHeadersMissing({
            message:
              "cmd.surface.output.reanchor missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        const relay = activeRelays.get(requestId);
        if (relay) return correlationError(msg.type);
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      const relay = activeRelays.get(requestId);
      if (!relay) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          reason: "no_active_relay",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }
      if (!matchesRelay(relay, requestClient, sessionId)) return correlationError(msg.type);

      let replyTo: MsgRef | undefined;
      if (msg.data.replyTo) {
        const decoded = policy.refs.decodeReanchorTarget({
          ref: msg.data.replyTo,
          expectedSessionId: sessionId,
        });
        const decodedError = decoded.match({ ok: () => null, err: (error) => error });
        if (decodedError) {
          logger.warn(
            "relay reanchor target rejected",
            formatBridgeTaggedErrorForLog(decodedError, { requestId, sessionId, platform }),
          );
          return Result.err(
            new CmdSurfaceReplyTargetInvalid({
              cause: decodedError,
              message: "Output reanchor target is invalid",
            }),
          );
        }
        replyTo = selectResultValue(decoded);
      }

      const reanchored = await captureBusToAdapterEffect("reanchor-output", () =>
        relay.reanchor({
          inheritReplyTo: msg.data.inheritReplyTo,
          mode: msg.data.mode,
          replyTo,
        }),
      );
      return reanchored.match<ResultType<void, CmdSurfaceDeliveryError>>({
        ok: () => Result.ok(undefined),
        err: (error) => {
          logger.error(
            "reanchor failed",
            formatBridgeTaggedErrorForLog(error, { requestId, sessionId }),
          );
          return Result.err(
            new CmdSurfaceReanchorFailed({
              cause: error,
              message: "Output reanchor failed",
            }),
          );
        },
      });
    },
    applyCmdSurfaceDeliveryPolicy,
  );
  const cmdSurfaceStartError = cmdSurfaceStarted.match({ ok: () => null, err: (error) => error });
  if (cmdSurfaceStartError) {
    await runBusToAdapterBestEffort({
      operation: "stop-output-subscription",
      effect: () => stopResultSubscription(cmdRequestSub),
    });
  }
  const cmdSurfaceSub = adaptBusToAdapterSubscriptionStart(cmdSurfaceStarted);
  observeSubscriptionDone(cmdSurfaceSub, "cmd.surface", logger);

  const subStarted = await bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      batch: { maxWaitMs: 1000 },
    },
    async (msg): Promise<ResultType<void, EvtRequestDeliveryError>> => {
      if (
        msg.type !== lilacEventTypes.EvtRequestReply &&
        msg.type !== lilacEventTypes.EvtRequestLifecycleChanged
      ) {
        return Result.ok(undefined);
      }

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      const requestClient = msg.headers?.request_client;
      const routerSessionMode = parseRouterSessionMode(msg.headers?.router_session_mode);

      if (!requestId || !sessionId || !requestClient) {
        if (
          requestId &&
          (activeRelays.has(requestId) || terminalLifecycleByRequestId.has(requestId))
        ) {
          return correlationError(msg.type);
        }
        // Do not ack malformed messages: they need investigation.
        logger.error("relay.event.rejected", {
          requestId,
          sessionId,
          platform,
          reason: "missing_headers",
          messageType: msg.type,
        });
        return Result.err(
          new EvtRequestRequiredHeadersMissing({
            message:
              "evt.request event missing required headers.request_id/session_id/request_client",
          }),
        );
      }

      if (requestClient !== platform) {
        if (activeRelays.has(requestId) || terminalLifecycleByRequestId.has(requestId)) {
          return correlationError(msg.type);
        }
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "platform_mismatch",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      pruneTerminalLifecycleCache(Date.now());

      const activeRelay = activeRelays.get(requestId);
      if (activeRelay && !matchesRelay(activeRelay, requestClient, sessionId)) {
        return correlationError(msg.type);
      }
      const terminalLifecycle = terminalLifecycleByRequestId.get(requestId);
      if (
        terminalLifecycle &&
        (terminalLifecycle.platform !== requestClient || terminalLifecycle.sessionId !== sessionId)
      ) {
        return correlationError(msg.type);
      }

      if (msg.type === lilacEventTypes.EvtRequestLifecycleChanged) {
        if (
          msg.data.state === "resolved" ||
          msg.data.state === "failed" ||
          msg.data.state === "cancelled"
        ) {
          terminalLifecycleByRequestId.set(requestId, {
            platform,
            sessionId,
            at: Date.now(),
          });

          const relay = activeRelays.get(requestId);
          if (relay) {
            const stoppedTyping = await captureBusToAdapterEffect("stop-typing", () =>
              relay.stopTyping(),
            );
            const stoppedTypingError = stoppedTyping.match({
              ok: () => null,
              err: (error) => error,
            });
            if (stoppedTypingError) {
              logger.debug(
                "failed to stop relay typing from lifecycle event",
                formatBridgeTaggedErrorForLog(stoppedTypingError, {
                  requestId,
                  sessionId,
                  lifecycleState: msg.data.state,
                }),
              );
              return Result.err(
                new EvtRequestStopTypingFailed({
                  cause: stoppedTypingError,
                  message: "Failed to stop relay typing from lifecycle event",
                }),
              );
            }
            terminalLifecycleByRequestId.delete(requestId);
          }
        }

        return Result.ok(undefined);
      }

      if (activeRelays.has(requestId)) {
        logger.debug("relay.event.ignored", {
          requestId,
          sessionId,
          platform,
          requestClient,
          reason: "already_active",
          messageType: msg.type,
        });
        return Result.ok(undefined);
      }

      if (requestClient === "discord") {
        recordRequestLatencyStage(requestId, "replyPublishedAt", msg.ts);
        recordRequestLatencyStage(requestId, "relayReceivedAt");
      }

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          if (shouldWarn) {
            logger.warn("perf.bus_lag", {
              stage: "evt.request.reply->bus_to_adapter",
              lagMs,
              requestId,
              sessionId,
              requestClient,
            });
          } else {
            logger.info("perf.bus_lag", {
              stage: "evt.request.reply->bus_to_adapter",
              lagMs,
              requestId,
              sessionId,
              requestClient,
            });
          }
        }
      }

      logger.debug("starting reply relay", {
        requestId,
        sessionId,
        requestClient,
      });

      const initialReplyTarget = policy.refs.resolveInitialReplyTarget({ requestId, sessionId });
      if (initialReplyTarget.kind === "invalid") {
        logger.error(
          "relay initial reply target rejected",
          formatBridgeTaggedErrorForLog(initialReplyTarget.error, {
            requestId,
            sessionId,
            platform,
          }),
        );
        return Result.err(
          new EvtRequestReplyTargetInvalid({
            cause: initialReplyTarget.error,
            message: "Initial output reply target is invalid",
          }),
        );
      }

      const relay = await startRelay({
        adapter,
        bus,
        platform,
        requestId,
        sessionId,
        requestStartedAtMs: msg.ts,
        routerSessionMode,
        requestClient,
        idleTimeoutMs,
        initialReplyTo: initialReplyTarget.kind === "target" ? initialReplyTarget.ref : undefined,
      });

      activeRelays.set(requestId, relay);

      if (terminalLifecycleByRequestId.has(requestId)) {
        const stoppedTyping = await captureBusToAdapterEffect("stop-typing", () =>
          relay.stopTyping(),
        );
        const stoppedTypingError = stoppedTyping.match({ ok: () => null, err: (error) => error });
        if (stoppedTypingError) {
          logger.debug(
            "failed to stop relay typing after delayed terminal lifecycle",
            formatBridgeTaggedErrorForLog(stoppedTypingError, { requestId, sessionId }),
          );
          return Result.err(
            new EvtRequestStopTypingFailed({
              cause: stoppedTypingError,
              message: "Failed to stop relay typing after delayed terminal lifecycle",
            }),
          );
        }
        terminalLifecycleByRequestId.delete(requestId);
      }

      return Result.ok(undefined);
    },
    applyEvtRequestDeliveryPolicy,
  );
  const subStartError = subStarted.match({ ok: () => null, err: (error) => error });
  if (subStartError) {
    await superviseBusToAdapterCleanup([
      () =>
        runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: () => stopResultSubscription(cmdRequestSub),
        }),
      () =>
        runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: () => stopResultSubscription(cmdSurfaceSub),
        }),
    ]);
  }
  const sub = adaptBusToAdapterSubscriptionStart(subStarted);
  observeSubscriptionDone(sub, "evt.request", logger);

  const stopIngress = async () => {
    if (ingressStopped) return;
    ingressStopped = true;
    await superviseBusToAdapterCleanup([
      () => stopResultSubscription(sub),
      () => stopResultSubscription(cmdSurfaceSub),
      () => stopResultSubscription(cmdRequestSub),
    ]);
  };

  type RelayStartupResources = {
    output?: SurfaceOutputStream;
    subscription?: ResultSubscription;
    typing?: TypingIndicatorSubscription;
  };

  async function startRelayUnchecked(
    input: {
      adapter: SurfaceAdapter;
      bus: LilacBus;
      platform: P;
      requestId: string;
      sessionId: string;
      requestStartedAtMs?: number;
      routerSessionMode?: "mention" | "active";
      requestClient?: string;
      idleTimeoutMs: number;
      initialReplyTo?: MsgRef;
    },
    startupResources: RelayStartupResources,
  ): Promise<ActiveRelay> {
    const { requestId, sessionId, idleTimeoutMs } = input;
    let stopped = false;

    const relayStartedAt = Date.now();
    const requestStartedAtMs = Math.max(0, input.requestStartedAtMs ?? relayStartedAt);

    const sessionRef: SessionRef = policy.refs.createSessionRef(sessionId);
    const baseReplyTo = input.initialReplyTo;
    let currentReplyTo: MsgRef | undefined = baseReplyTo;

    const resolveRecoveredOutputRef = (): MsgRef | undefined => {
      const listSurfaceMessages = params.transcriptStore?.listSurfaceMessagesForRequest;
      if (!listSurfaceMessages || !params.transcriptStore) return undefined;
      const listed = Result.try({
        try: () => listSurfaceMessages.call(params.transcriptStore, { requestId }),
        catch: captureError,
      });
      const outcome = listed.match<
        | { readonly kind: "refs"; readonly refs: readonly MsgRef[] }
        | { readonly kind: "failed"; readonly cause: Error }
      >({
        ok: (refs) => ({ kind: "refs", refs }),
        err: (error) => ({ kind: "failed", cause: error.cause }),
      });
      if (outcome.kind === "failed") {
        rethrowBusToAdapterPanic(outcome.cause);
        logger.warn("failed to resolve recovered surface output", {
          requestId,
          sessionId,
          errorTag: outcome.cause.name,
        });
        return undefined;
      }

      for (let index = outcome.refs.length - 1; index >= 0; index -= 1) {
        const ref = outcome.refs[index];
        if (!ref || ref.platform !== platform || ref.channelId !== sessionId) continue;
        const decoded = policy.refs.decodeReanchorTarget({
          ref,
          expectedSessionId: sessionId,
        });
        const resumeAt = decoded.match({ ok: (value) => value, err: () => undefined });
        if (resumeAt) return resumeAt;
      }
      return undefined;
    };
    const recoveredOutputRef = resolveRecoveredOutputRef();

    let relayStream = createRelayStreamState();
    let streamShouldFinish = false;
    const createdOutputRefs: MsgRef[] = [];
    const createdOutputRefKeys = new Set<string>();
    let activeOutputRefs: MsgRef[] = [];
    let activeOutputRefKeys = new Set(
      activeOutputRefs.map((ref) => `${ref.platform}:${ref.channelId}:${ref.messageId}`),
    );
    let lastOutCursor: string | undefined;

    const recordCreatedOutputRef = (msgRef: MsgRef) => {
      const key = `${msgRef.platform}:${msgRef.channelId}:${msgRef.messageId}`;
      if (createdOutputRefKeys.has(key)) return;
      createdOutputRefKeys.add(key);
      createdOutputRefs.push(msgRef);
    };

    // Serialize all mutations to the active output stream so reanchor doesn't race.
    let op = Promise.resolve();
    const enqueue = async (fn: () => Promise<void>) => {
      op = op.then(fn);
      await op;
    };

    let streamToken = 0;

    const publishOutputCreated = (msgRef: MsgRef) =>
      runBusToAdapterBestEffort({
        operation: "publish-output-created",
        effect: async () => {
          adaptEventPublishResultToHost(
            await bus.publish(
              lilacEventTypes.EvtSurfaceOutputMessageCreated,
              {
                msgRef: {
                  platform: msgRef.platform,
                  channelId: msgRef.channelId,
                  messageId: msgRef.messageId,
                },
              },
              {
                headers: {
                  request_id: requestId,
                  session_id: sessionId,
                  request_client: input.platform,
                },
              },
            ),
          );
        },
        logger,
        logLevel: "debug",
        logMessage: "failed to publish output message created",
        context: { requestId },
      });

    const publishCreatedForToken = (token: number) => (msgRef: MsgRef) => {
      recordCreatedOutputRef(msgRef);

      // Only publish created messages for the currently active output stream.
      // This prevents a reanchor from temporarily treating "frozen" follow-up messages
      // (e.g. attachment flushes) as the active streaming target.
      if (token !== streamToken) return;
      const transcriptStore = params.transcriptStore;
      if (transcriptStore) {
        const linked = Result.try({
          try: () =>
            transcriptStore.linkSurfaceMessagesToRequest({
              requestId,
              created: [msgRef],
              last: msgRef,
            }),
          catch: captureError,
        });
        const linkError = linked.match({ ok: () => null, err: (error) => error.cause });
        if (linkError) {
          rethrowBusToAdapterPanic(linkError);
          logger.warn("failed to persist active surface output", {
            requestId,
            sessionId,
            errorTag: linkError.name,
          });
        }
      }
      const key = `${msgRef.platform}:${msgRef.channelId}:${msgRef.messageId}`;
      if (!activeOutputRefKeys.has(key)) {
        activeOutputRefKeys.add(key);
        activeOutputRefs.push(msgRef);
      }
      if (!stopped) void publishOutputCreated(msgRef);
    };

    const buildStartOpts = (
      overrideReplyTo: MsgRef | undefined,
      token: number,
      resumeAt?: MsgRef,
    ): StartOutputOpts => {
      const startOpts: StartOutputOpts = {
        replyTo: overrideReplyTo,
        ...(resumeAt ? { resumeAt } : {}),
        requestId,
        requestStartedAtMs,
        onMessageCreated: publishCreatedForToken(token),
      };
      if (input.routerSessionMode) {
        startOpts.sessionMode = input.routerSessionMode;
      }
      return startOpts;
    };

    streamToken += 1;
    let out = adaptSurfaceOperationToRelay(
      "start-output",
      await adapter.startOutput(
        sessionRef,
        buildStartOpts(baseReplyTo, streamToken, recoveredOutputRef),
      ),
    );
    startupResources.output = out;
    let finalTextMode: SurfaceFinalTextMode = out.getFinalTextMode?.() ?? "continuation";
    const recordOutputPartDisposition = (disposition: SurfaceOutputPartDisposition): void => {
      if (disposition === "visible" || disposition === "terminal") {
        streamShouldFinish = true;
      }
    };

    const switchOutputLane = async (lane: {
      replyTo?: MsgRef;
      resolveReplyToAfterAbort?: () => MsgRef | undefined;
      abortReason: "reanchor" | "reanchor_interrupt";
      replayStatus: boolean;
    }): Promise<void> => {
      // Make the new stream active before abort can create follow-up messages.
      streamToken += 1;
      activeOutputRefs = [];
      activeOutputRefKeys = new Set();
      await runBusToAdapterBestEffort({
        operation: "abort-output",
        effect: async () => {
          adaptSurfaceOperationToRelay("abort-output", await out.abort(lane.abortReason));
        },
      });

      const nextReplyTo = lane.resolveReplyToAfterAbort?.() ?? lane.replyTo;
      currentReplyTo = nextReplyTo;
      relayStream = {
        ...relayStream,
        streamTextPrefixChars: Math.max(
          0,
          relayStream.totalTextChars - relayStream.pendingNoReplyPrefix.length,
        ),
        streamPhaseBoundaryPrefixChars: 0,
        streamPhaseBoundaryOffsetChars: 0,
        streamPhaseBoundaryPrefix: undefined,
        awaitingFinalPhaseBoundaryPrefix: false,
        textPhase: undefined,
        commentaryText: "",
        finalAnswerText: "",
        phaseSegmentsValid: true,
        visibleTextAcc: "",
      };
      streamShouldFinish = false;
      out = adaptSurfaceOperationToRelay(
        "start-output",
        await adapter.startOutput(sessionRef, buildStartOpts(nextReplyTo, streamToken)),
      );
      finalTextMode = out.getFinalTextMode?.() ?? "continuation";

      if (!lane.replayStatus) return;
      if (typeof relayStream.reasoningStartedAtMs === "number") {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({
              type: "reasoning.status",
              update: {
                startedAtMs: relayStream.reasoningStartedAtMs,
                frozenAtMs: relayStream.reasoningFrozenAtMs,
                detailText: relayStream.reasoningDetailText,
              },
            }),
          ),
        );
      }
      for (const update of relayStream.toolStatusById.values()) {
        recordOutputPartDisposition(
          adaptSurfaceOperationToRelay(
            "push-output",
            await out.push({ type: "tool.status", update }),
          ),
        );
      }
    };

    let typing: TypingIndicatorSubscription | null = null;
    let typingAttempted = false;

    const stopTyping = async () => {
      const currentTyping = typing;
      typing = null;
      if (!currentTyping) return;
      await runBusToAdapterBestEffort({
        operation: "stop-typing",
        effect: async () => {
          adaptSurfaceOperationToRelay("stop-typing", await currentTyping.stop());
        },
      });
    };

    let cancelTimeout: (() => void) | null = null;
    const bumpTimeout = () => {
      cancelTimeout?.();
      cancelTimeout = scheduleIdleTimeout(() => {
        const expire = () => {
          if (stopped) return;
          logger.warn("reply relay idle timeout", {
            requestId,
            sessionId,
            idleTimeoutMs,
          });

          const abortOutput = runBusToAdapterBestEffort({
            operation: "abort-output",
            effect: async () => {
              adaptSurfaceOperationToRelay("abort-output", await out.abort("timeout"));
            },
            logger,
            logLevel: "error",
            logMessage: "failed to abort output stream",
            context: { requestId },
          });
          const stopRelay = runBusToAdapterBestEffort({
            operation: "stop-relay",
            effect: relayStop,
            logger,
            logLevel: "error",
            logMessage: "failed to stop relay",
            context: { requestId },
          });
          void superviseBusToAdapterCleanup([() => abortOutput, () => stopRelay]);
        };
        expire();
      }, idleTimeoutMs);
    };

    let outputSub: ResultSubscription | null = null;
    let firstOutLogged = false;
    let handlingOutputEvent = false;

    const cleanupSkippedOutput = async () => {
      const cleanup = policy.finalization?.cleanupSkippedOutput;
      if (!cleanup) return;
      const deletions: Array<() => Promise<void>> = [];
      for (let i = createdOutputRefs.length - 1; i >= 0; i--) {
        const ref = createdOutputRefs[i];
        if (!ref) continue;
        const decoded = policy.refs.decodeReanchorTarget({
          ref,
          expectedSessionId: sessionId,
        });
        const decodedError = decoded.match({ ok: () => null, err: (error) => error });
        if (decodedError) {
          logger.warn(
            "skipped output cleanup ref rejected",
            formatBridgeTaggedErrorForLog(decodedError, { requestId, sessionId, platform }),
          );
          continue;
        }
        deletions.push(() =>
          runBusToAdapterBestEffort({
            operation: "cleanup-skipped-output",
            effect: async () => {
              await cleanup({ ref: selectResultValue(decoded) });
              const unlinked = params.transcriptStore?.unlinkSurfaceMessage?.({
                platform: ref.platform,
                channelId: ref.channelId,
                messageId: ref.messageId,
              });
              if (unlinked) selectResultValue(unlinked);
            },
            logger,
            logLevel: "debug",
            logMessage: "failed to delete skipped output message",
            context: { requestId, sessionId, messageId: ref.messageId },
          }),
        );
      }
      await superviseBusToAdapterCleanup(deletions);
    };

    const unlinkDiscardedFinishedOutputRefs = async (
      result: SurfaceOutputResult,
    ): Promise<void> => {
      const unlink = params.transcriptStore?.unlinkSurfaceMessage;
      if (!unlink || !params.transcriptStore) return;
      const retainedKeys = new Set(
        [...result.created, result.last].map(
          (ref) => `${ref.platform}:${ref.channelId}:${ref.messageId}`,
        ),
      );
      const discarded = activeOutputRefs.filter(
        (ref) => !retainedKeys.has(`${ref.platform}:${ref.channelId}:${ref.messageId}`),
      );
      await superviseBusToAdapterCleanup(
        discarded.map(
          (ref) => () =>
            runBusToAdapterBestEffort({
              operation: "unlink-output",
              effect: async () => {
                selectResultValue(
                  unlink.call(params.transcriptStore, {
                    platform: ref.platform,
                    channelId: ref.channelId,
                    messageId: ref.messageId,
                  }),
                );
              },
              logger,
              logLevel: "warn",
              logMessage: "failed to unlink discarded surface output",
              context: { requestId, sessionId, messageId: ref.messageId },
            }),
        ),
      );
    };

    const clearIngressAcknowledgement = async () => {
      const clear = policy.finalization?.clearIngressAcknowledgement;
      if (!clear) return;
      const cleared = await captureBusToAdapterEffect("clear-ingress-acknowledgement", () =>
        clear({ requestId, sessionId }),
      );
      const clearError = cleared.match({ ok: () => null, err: (error) => error });
      if (clearError) {
        logger.warn(
          "failed to clear ingress acknowledgement",
          formatBridgeTaggedErrorForLog(clearError, { requestId, sessionId }),
        );
        return;
      }
      const clearResult = selectResultValue(cleared);
      const clearResultError = clearResult.match({ ok: () => null, err: (error) => error });
      if (clearResultError) {
        logIngressAcknowledgementCleanupFailure({
          logger,
          error: clearResultError,
          requestId,
          sessionId,
        });
      }
    };

    const deleteUnlinkedCheckpointCandidate = async () => {
      const deleted = params.transcriptStore?.deleteUnlinkedCheckpointCandidate?.({ requestId });
      if (!deleted) return;
      deleted.match({
        ok: (wasDeleted) => {
          if (!wasDeleted) return;
          logger.info("compaction checkpoint deleted", {
            requestId,
            sessionId,
            reason: "unlinked_candidate_cleanup",
          });
        },
        err: (error) => {
          logger.warn(
            "failed to delete unlinked transcript checkpoint",
            formatBridgeTaggedErrorForLog(error, { requestId, sessionId }),
          );
        },
      });
    };

    const relayStop = async () => {
      if (stopped) return;
      stopped = true;
      activeRelays.delete(requestId);
      terminalLifecycleByRequestId.delete(requestId);

      cancelTimeout?.();
      cancelTimeout = null;

      const subToStop = outputSub;
      if (!subToStop) {
        await stopTyping();
      } else if (handlingOutputEvent) {
        const stopOutputSubscription = () => stopResultSubscription(subToStop);
        void runBusToAdapterBestEffort({
          operation: "stop-output-subscription",
          effect: stopOutputSubscription,
        });
        await stopTyping();
      } else {
        await superviseBusToAdapterCleanup([
          stopTyping,
          () =>
            runBusToAdapterBestEffort({
              operation: "stop-output-subscription",
              effect: () => stopResultSubscription(subToStop),
            }),
        ]);
      }
    };

    bumpTimeout();

    const pushOutputPart = async (
      part: SurfaceOutputPart,
    ): Promise<ResultType<SurfaceOutputPartDisposition, OutReqPushFailed>> => {
      const pushed = await out.push(part);
      return pushed.mapError((error) => {
        logger.error(
          "failed to push relay output",
          formatBridgeTaggedErrorForLog(error, { requestId, sessionId }),
        );
        return new OutReqPushFailed({
          cause: classifySurfaceOperationForRelay("push-output", error),
          message: "Failed to push relay output",
        });
      });
    };

    const finishOutput = async (): Promise<ResultType<SurfaceOutputResult, OutReqFinishFailed>> => {
      const finished = await out.finish();
      return finished.mapError((error) => {
        logger.error(
          "failed to finish relay output",
          formatBridgeTaggedErrorForLog(error, { requestId, sessionId }),
        );
        return new OutReqFinishFailed({
          cause: classifySurfaceOperationForRelay("finish-output", error),
          message: "Failed to finish relay output",
        });
      });
    };

    const subStart = Date.now();
    const outputStarted = await bus.subscribeTopic(
      outReqTopic(requestId),
      {
        mode: "tail",
        offset: lastOutCursor ? { type: "cursor", cursor: lastOutCursor } : { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (outMsg, outCtx): Promise<ResultType<void, OutReqDeliveryError>> => {
        if (
          outMsg.headers?.request_id !== requestId ||
          outMsg.headers?.session_id !== sessionId ||
          outMsg.headers?.request_client !== input.platform
        ) {
          return correlationError(outMsg.type);
        }
        if (stopped) {
          lastOutCursor = outCtx.cursor;
          return Result.ok(undefined);
        }
        await startTyping();

        if (env.perf.log && !firstOutLogged) {
          firstOutLogged = true;
          const now = Date.now();
          const sinceRelayStartMs = now - relayStartedAt;
          const outBusLagMs = now - outMsg.ts;
          const shouldWarn =
            sinceRelayStartMs >= env.perf.lagWarnMs || outBusLagMs >= env.perf.lagWarnMs;
          const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
          if (shouldWarn || shouldSample) {
            if (shouldWarn) {
              logger.warn("perf.output_first_event", {
                requestId,
                sessionId,
                sinceRelayStartMs,
                outBusLagMs,
                outType: outMsg.type,
              });
            } else {
              logger.info("perf.output_first_event", {
                requestId,
                sessionId,
                sinceRelayStartMs,
                outBusLagMs,
                outType: outMsg.type,
              });
            }
          }
        }

        bumpTimeout();

        let processingError: OutReqDeliveryError | undefined;
        await enqueue(async () => {
          if (stopped) {
            return;
          }

          handlingOutputEvent = true;
          const outcome = await (async () => {
            let part: SurfaceOutputPart | null = null;

            switch (outMsg.type) {
              case lilacEventTypes.EvtAgentOutputActivity:
              case lilacEventTypes.EvtAgentOutputDeltaReasoning:
              case lilacEventTypes.EvtAgentOutputDeltaText:
              case lilacEventTypes.EvtAgentOutputTextReset:
              case lilacEventTypes.EvtAgentOutputToolCall: {
                const reduced = reduceRelayStreamEvent(relayStream, outMsg);
                relayStream = reduced.state;
                part = reduced.part;
                break;
              }

              case lilacEventTypes.EvtAgentOutputResponseBinary: {
                const materialized = await materializeSurfaceOutputAttachment({
                  blobStore: params.blobStore,
                  ...outMsg.data,
                });
                const materializationError = materialized.match({
                  ok: () => undefined,
                  err: (error) => error,
                });
                if (materializationError) {
                  logger.error("failed to materialize generated surface output", {
                    requestId,
                    sessionId,
                    ...formatTaggedErrorForLog(materializationError),
                  });
                  processingError = materializationError;
                  return { status: "return", value: undefined } as const;
                }
                part = {
                  type: "attachment.add",
                  attachment: selectResultValue(materialized).attachment,
                };
                break;
              }

              case lilacEventTypes.EvtAgentOutputResponseText: {
                const delivery =
                  outMsg.data.delivery ?? resolveReplyDeliveryFromFinalText(outMsg.data.finalText);

                if (delivery === "skip") {
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay("abort-output", await out.abort("skip"));
                        },
                      }),
                    cleanupSkippedOutput,
                    deleteUnlinkedCheckpointCandidate,
                    relayStop,
                    clearIngressAcknowledgement,
                  ]);

                  logger.info("reply relay skipped final surface reply", {
                    requestId,
                    sessionId,
                  });
                  return { status: "return", value: undefined } as const;
                }

                if (
                  policy.finalization?.isFinalResponseSuperseded?.({
                    requestId,
                    sessionId,
                  }) === true
                ) {
                  logger.info("surface reply suppressed (superseded)", {
                    requestId,
                    sessionId,
                    platform,
                  });
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay(
                            "abort-output",
                            await out.abort("superseded"),
                          );
                        },
                      }),
                    relayStop,
                    clearIngressAcknowledgement,
                  ]);
                  return { status: "return", value: undefined } as const;
                }

                const statsLineRaw = outMsg.data.statsForNerdsLine;
                const statsLine = typeof statsLineRaw === "string" ? statsLineRaw.trim() : "";

                const previousVisibleText = relayStream.visibleTextAcc;
                const finalText = outMsg.data.finalText;
                const clampedStreamPrefixChars = Math.max(
                  0,
                  Math.min(relayStream.streamTextPrefixChars, finalText.length),
                );
                const isContinuationOnlyFinal = finalText.length < relayStream.totalTextChars;
                const hasPriorLanePrefix = clampedStreamPrefixChars > 0;
                const shouldUseFullLaneFinal = finalTextMode === "full" && !hasPriorLanePrefix;
                let streamFinalText = finalText;
                if (!shouldUseFullLaneFinal && !isContinuationOnlyFinal) {
                  streamFinalText = finalText.slice(clampedStreamPrefixChars);
                }

                const hasTrackedPhasedText =
                  relayStream.commentaryText.trim().length > 0 &&
                  relayStream.finalAnswerText.trim().length > 0;
                if (!hasTrackedPhasedText) {
                  streamFinalText = withoutStreamPhaseBoundary(relayStream, streamFinalText);
                }

                // On recovery resumes, the agent may emit only the continuation suffix
                // (instead of the full final text). In that case, preserve already visible
                // stream text and append the new suffix with overlap-aware merge.
                if (isContinuationOnlyFinal) {
                  streamFinalText = mergeContinuationText(previousVisibleText, streamFinalText);
                }

                if (streamFinalText.length === 0 && !streamShouldFinish) {
                  await superviseBusToAdapterCleanup([
                    () =>
                      runBusToAdapterBestEffort({
                        operation: "abort-output",
                        effect: async () => {
                          adaptSurfaceOperationToRelay("abort-output", await out.abort("skip"));
                        },
                      }),
                    cleanupSkippedOutput,
                    deleteUnlinkedCheckpointCandidate,
                    relayStop,
                    clearIngressAcknowledgement,
                  ]);

                  logger.info("reply relay skipped empty post-reanchor stream", {
                    requestId,
                    sessionId,
                  });
                  return { status: "return", value: undefined } as const;
                }

                if (statsLine.length > 0) {
                  const pushedStats = await pushOutputPart({
                    type: "meta.stats",
                    line: statsLine,
                  });
                  const pushedStatsError = pushedStats.match({
                    ok: () => undefined,
                    err: (error) => error,
                  });
                  if (pushedStatsError) {
                    processingError = pushedStatsError;
                    return { status: "return", value: undefined } as const;
                  }
                }

                relayStream = {
                  ...relayStream,
                  totalTextChars: Math.max(
                    relayStream.totalTextChars,
                    finalText.length,
                    clampedStreamPrefixChars + streamFinalText.length,
                  ),
                  visibleTextAcc: streamFinalText,
                  pendingNoReplyPrefix: "",
                  bufferNoReplyPrefix: false,
                  reasoningFrozenAtMs:
                    typeof relayStream.reasoningStartedAtMs === "number" &&
                    typeof relayStream.reasoningFrozenAtMs !== "number"
                      ? outMsg.ts
                      : relayStream.reasoningFrozenAtMs,
                };
                const preservesCommentaryPrefix = streamFinalText.startsWith(
                  relayStream.commentaryText,
                );
                const authoritativeFinalAnswer = preservesCommentaryPrefix
                  ? withoutStreamPhaseBoundary(
                      relayStream,
                      streamFinalText.slice(relayStream.commentaryText.length),
                      relayStream.commentaryText.length,
                    )
                  : "";
                const preservesKnownPhaseBoundary =
                  preservesCommentaryPrefix &&
                  relayStream.streamPhaseBoundaryPrefixChars > 0 &&
                  relayStream.streamPhaseBoundaryPrefix !== undefined &&
                  streamFinalText.slice(
                    relayStream.commentaryText.length,
                    relayStream.commentaryText.length + relayStream.streamPhaseBoundaryPrefixChars,
                  ) === relayStream.streamPhaseBoundaryPrefix;
                const preservesFinalAnswerSplit =
                  authoritativeFinalAnswer.startsWith(relayStream.finalAnswerText) ||
                  preservesKnownPhaseBoundary;
                const finalSegments =
                  relayStream.phaseSegmentsValid &&
                  relayStream.commentaryText.trim().length > 0 &&
                  relayStream.finalAnswerText.trim().length > 0 &&
                  preservesFinalAnswerSplit &&
                  authoritativeFinalAnswer.trim().length > 0
                    ? [relayStream.commentaryText, authoritativeFinalAnswer]
                    : undefined;
                const pushedFinal = await pushOutputPart({
                  type: "text.set",
                  text: streamFinalText,
                  phase: relayStream.textPhase,
                  ...(finalSegments === undefined ? {} : { finalSegments }),
                });
                const pushedFinalError = pushedFinal.match({
                  ok: () => undefined,
                  err: (error) => error,
                });
                if (pushedFinalError) {
                  processingError = pushedFinalError;
                  return { status: "return", value: undefined } as const;
                }
                recordOutputPartDisposition(selectResultValue(pushedFinal));
                const finished = await finishOutput();
                const finishError = finished.match({
                  ok: () => undefined,
                  err: (error) => error,
                });
                if (finishError) {
                  processingError = finishError;
                  return { status: "return", value: undefined } as const;
                }
                const res = selectResultValue(finished);

                const transcriptStore = params.transcriptStore;
                await superviseBusToAdapterCleanup([
                  () => unlinkDiscardedFinishedOutputRefs(res),
                  ...(transcriptStore
                    ? [
                        () =>
                          runBusToAdapterBestEffort({
                            operation: "link-transcript",
                            effect: async () => {
                              transcriptStore.linkSurfaceMessagesToRequest({
                                requestId,
                                created: res.created,
                                last: res.last,
                              });
                            },
                            logger,
                            logLevel: "error",
                            logMessage: "failed to link transcript to surface messages",
                            context: { requestId, sessionId },
                          }),
                      ]
                    : []),
                  relayStop,
                  clearIngressAcknowledgement,
                ]);

                logger.info("reply relay finished", {
                  requestId,
                  sessionId,
                  finalTextChars: streamFinalText.length,
                });
                return { status: "return", value: undefined } as const;
              }

              default:
                return { status: "return", value: undefined } as const;
            }

            if (part) {
              const pushed = await pushOutputPart(part);
              const pushError = pushed.match({ ok: () => undefined, err: (error) => error });
              if (pushError) {
                processingError = pushError;
                return { status: "return", value: undefined } as const;
              }
              recordOutputPartDisposition(selectResultValue(pushed));
            }

            return { status: "continue" } as const;
          })().finally(() => {
            handlingOutputEvent = false;
          });
          if (outcome.status === "return") return outcome.value;
        });

        if (processingError) return Result.err(processingError);
        lastOutCursor = outCtx.cursor;
        return Result.ok(undefined);
      },
      applyOutReqDeliveryPolicy,
    );
    outputSub = adaptBusToAdapterSubscriptionStart(outputStarted);
    startupResources.subscription = outputSub;
    observeSubscriptionDone(outputSub, outReqTopic(requestId), logger);

    if (env.perf.log) {
      const setupMs = Date.now() - subStart;
      const shouldWarn = setupMs >= env.perf.lagWarnMs;
      const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
      if (shouldWarn || shouldSample) {
        if (shouldWarn) {
          logger.warn("perf.subscription_setup", {
            stage: "bus_to_adapter.output_subscribe",
            requestId,
            sessionId,
            setupMs,
          });
        } else {
          logger.info("perf.subscription_setup", {
            stage: "bus_to_adapter.output_subscribe",
            requestId,
            sessionId,
            setupMs,
          });
        }
      }
    }

    async function startTyping(): Promise<void> {
      if (typing || typingAttempted) return;
      typingAttempted = true;
      recordRequestLatencyStage(requestId, "typingRequestedAt");
      const captured = await captureBusToAdapterEffect("start-typing", () =>
        adapter.startTyping(sessionRef, {
          onStarted: () => {
            const timing = finishDiscordMessageLatencyTrace(requestId);
            if (!timing || !env.perf.log) return;

            const shouldWarn = timing.totalMs >= env.perf.lagWarnMs;
            const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
            if (shouldWarn) {
              logger.warn("perf.discord_message_to_typing", timing);
              return;
            }
            if (shouldSample) logger.info("perf.discord_message_to_typing", timing);
          },
        }),
      );
      const capturedError = captured.match({ ok: () => null, err: (error) => error });
      if (capturedError) {
        logger.warn("surface typing indicator unavailable", {
          requestId,
          sessionId,
          ...formatTaggedErrorForLog(capturedError),
        });
        return;
      }
      selectResultValue(captured).match({
        ok: (subscription) => {
          typing = subscription;
          startupResources.typing = typing;
        },
        err: (error) => {
          typing = null;
          logger.warn("surface typing indicator unavailable", {
            requestId,
            sessionId,
            ...formatTaggedErrorForLog(error),
          });
        },
      });
    }
    await startTyping();

    return {
      requestId,
      sessionId,
      platform: input.platform,
      stopTyping,
      stop: relayStop,
      cancel: async () => {
        await enqueue(async () => {
          await superviseBusToAdapterCleanup([
            () =>
              runBusToAdapterBestEffort({
                operation: "abort-output",
                effect: async () => {
                  adaptSurfaceOperationToRelay("abort-output", await out.abort("cancel"));
                },
                logger,
                logLevel: "error",
                logMessage: "failed to abort output stream on cancel",
                context: { requestId },
              }),
            relayStop,
          ]);
        });
      },
      startedAt: relayStartedAt,
      firstOutLogged,
      reanchor: async (reanchorInput) => {
        await enqueue(async () => {
          const nextReplyTo = reanchorInput.inheritReplyTo ? currentReplyTo : reanchorInput.replyTo;
          const reanchorAbortReason =
            reanchorInput.mode === "interrupt" ? "reanchor_interrupt" : "reanchor";
          await switchOutputLane({
            replyTo: nextReplyTo,
            abortReason: reanchorAbortReason,
            replayStatus: true,
          });
        });
      },
    };
  }

  async function startRelay(
    input: Parameters<typeof startRelayUnchecked>[0],
  ): Promise<ActiveRelay> {
    const resources: RelayStartupResources = {};
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          return await startRelayUnchecked(input, resources);
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        const settled = await Promise.allSettled([
          resources.output
            ? resources.output
                .abort("relay_start_failed")
                .then((result) => result.match({ ok: () => true, err: () => false }))
            : Promise.resolve(true),
          resources.subscription
            ? resources.subscription.stop().then(async (stopped) => {
                const stoppedCleanly = stopped.match({ ok: () => true, err: () => false });
                if (!stoppedCleanly) return false;
                const done = await resources.subscription?.done;
                return done?.match({ ok: () => true, err: () => false }) ?? false;
              })
            : Promise.resolve(true),
          resources.typing
            ? resources.typing
                .stop()
                .then((result) => result.match({ ok: () => true, err: () => false }))
            : Promise.resolve(true),
        ]);
        if (settled.some((result) => result.status === "rejected" || result.value === false)) {
          throw new Panic({
            message: "Relay startup cleanup left atomicity unknown",
            cause,
          });
        }
        throw cause;
      }
      return attempt.value;
    }
  }

  const handle = {
    platform,
    beginDrain: async (opts?: { deadlineMs?: number }) => {
      await stopIngress();

      const deadlineMs = Math.max(1, opts?.deadlineMs ?? 3_000);
      const startedAt = Date.now();

      while (activeRelays.size > 0 && Date.now() - startedAt < deadlineMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    stop: async () => {
      await stopIngress();
      await superviseBusToAdapterCleanup(
        [...activeRelays.values()].map((relay) => () => relay.stop()),
      );
    },
  };
  return handle;
}
