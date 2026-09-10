import { captureError } from "../../shared/error-capture";
import {
  createLogger,
  extractAiErrorLogDetails,
  formatTaggedErrorForLog,
  getCoreConfig,
  env,
  isPanic,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import {
  buildCoreLineageManifestV2,
  createCorePrimaryLineageFreshOnlyV2,
  lilacEventTypes,
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
  type CorePrimaryLineageV2,
} from "@stanley2058/lilac-event-bus";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { Logger } from "@stanley2058/simple-module-logger";
import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import type { MsgRefFor } from "../runtime-descriptor";
import type { MsgRef, SurfaceMessage, SurfaceSelf } from "../types";
import { normalizeDiscordRaw, type NormalizedDiscordRaw } from "./discord-raw-normalizer";
import {
  CoreOwnedBlobIntegrityError,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import {
  composeRequestMessages,
  composeRecentChannelMessages,
  composeSingleMessageWithLineage,
  DiscordRequestCompositionAndCleanupFailed,
  type RequestCompositionError,
  type RequestCompositionResult,
} from "../bridge/request-composition";
import { deleteDiscordRequestBlobHandles } from "../bridge/request-composition/attachments";
import { formatDiscordMessageRequestId } from "../bridge/request-ids";
import { recordRequestLatencyStage } from "../bridge/request-latency-trace";

import {
  type SessionMode,
  previewText,
  resolveBotMentionNames,
  normalizeGateText,
  parseLeadingContinueDirective,
  parseLeadingModelOverride,
  stripLeadingModelOverrideDirective,
  parseSteerDirectiveMode,
  stripLeadingContinueDirective,
  stripLeadingInterruptDirective,
  shouldRunDirectReplyMentionGate,
  consumerId,
  randomRequestId,
  bufferedPromptRequestIdForActiveRequest,
  parseDiscordMsgRefFromAdapterEvent,
  resolveSessionConfigId,
  getSessionMode,
  resolveSessionGateEnabled,
  resolveSessionModelOverride,
  buildDiscordUserAliasById,
  getDiscordFlags,
} from "./discord-request-router/common";

import {
  type BufferedMessage,
  type RouterGateInput,
  type RouterGateDecision,
  shouldForwardByGate,
} from "./discord-request-router/gate";
import {
  type PendingMentionReplyBatch,
  type PendingMentionReplyBatchItem,
  enqueuePendingMentionReplyBatch as enqueuePendingMentionReplyBatchImpl,
  takePendingMentionReplyBatch as takePendingMentionReplyBatchImpl,
  transformPendingUserText as transformPendingUserTextImpl,
} from "./discord-request-router/pending-batch";
import {
  type PublishBusRequestInput,
  DiscordRequestDeliveryFailed,
  type DiscordRequestDeliveryPort,
  type DiscordRequestPublishError,
  publishActiveChannelPrompt as publishActiveChannelPromptImpl,
  publishBusRequest as publishBusRequestImpl,
  publishComposedRequest as publishComposedRequestImpl,
  publishSingleMessagePrompt as publishSingleMessagePromptImpl,
  publishSingleMessageToActiveRequest as publishSingleMessageToActiveRequestImpl,
  publishSurfaceOutputReanchor as publishSurfaceOutputReanchorImpl,
  resolveCorrelatedOriginMessage,
} from "./discord-request-router/publish";
import type { DiscordAttachmentCacheAccess } from "./discord-attachment";
import type { DiscordMessageCacheAccess } from "../store/discord-search-store";
import {
  ResourceIdCollisionExhausted,
  ResourceStoreFailure,
  type ResourceRegistry,
} from "../../resource";
import {
  resolvePreviousBatchMessageText as resolvePreviousBatchMessageTextImpl,
  resolvePreviousMessageText as resolvePreviousMessageTextImpl,
  resolveRepliedToMessageText as resolveRepliedToMessageTextImpl,
} from "./discord-request-router/context";
import { decideActiveRequestRoute } from "./discord-request-router/decisions";
import {
  customCommandInvocationErrorText,
  type CustomCommandManager,
} from "../../custom-commands/manager";
import { formatBridgeLogContext, formatBridgeTaggedErrorForLog } from "../bridge/bridge-log";
import {
  isDiscordContextTextCommand,
  type DiscordContextReportProvider,
} from "./discord-context-report";

function continueResult<T, E, ROk, RErr>(
  result: ResultType<T, E>,
  branches: { ok: (value: T) => ROk; err: (error: E) => RErr },
): ROk | RErr {
  const continuation = result.match<() => ROk | RErr>({
    ok: (value) => () => branches.ok(value),
    err: (error) => () => branches.err(error),
  });
  return continuation();
}

function createFreshOnlyLineage(
  reason: string,
  currentCanonicalStart: number,
): CorePrimaryLineageV2 {
  const created = createCorePrimaryLineageFreshOnlyV2(reason, currentCanonicalStart);
  return created.match({
    ok: (value) => value,
    err: () => ({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "lineage-fallback-construction-failed",
    }),
  });
}

export type DiscordRequestCompositionFailurePolicy = {
  readonly disposition:
    | "drop-integrity-failure"
    | "drop-permanent-gateway-event"
    | "drop-transient-gateway-event";
  readonly level: "error" | "warn";
  readonly retryable: boolean;
};

export function discordRequestCompositionFailurePolicy(
  error: RequestCompositionError,
): DiscordRequestCompositionFailurePolicy {
  if (error instanceof CoreOwnedBlobIntegrityError) {
    return { disposition: "drop-integrity-failure", level: "error", retryable: false };
  }
  if (error instanceof ResourceStoreFailure || error instanceof ResourceIdCollisionExhausted) {
    return {
      disposition: "drop-transient-gateway-event",
      level: "warn",
      retryable: true,
    };
  }
  if (
    error._tag === "DiscordRequestCompositionAndCleanupFailed" ||
    error._tag === "DiscordStoredBlobPreparationAndCleanupFailed" ||
    error._tag === "DiscordStoredBlobPreparationFailed" ||
    error._tag === "StoredMessageValidationError"
  ) {
    return { disposition: "drop-integrity-failure", level: "error", retryable: false };
  }
  if (error._tag === "DiscordAttachmentPreparationFailed") {
    return {
      disposition: "drop-transient-gateway-event",
      level: "warn",
      retryable: true,
    };
  }
  return discordSurfaceCompositionFailurePolicy(error);
}

function discordSurfaceCompositionFailurePolicy(
  error: SurfaceOperationError,
): DiscordRequestCompositionFailurePolicy {
  switch (error._tag) {
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      return {
        disposition: "drop-transient-gateway-event",
        level: "warn",
        retryable: true,
      };
    case "SurfaceOperationUnsupported":
    case "SurfacePlatformMismatch":
    case "SurfaceSessionMismatch":
    case "SurfaceInvalidInput":
    case "SurfaceOperationPartiallyCompleted":
    case "SurfaceMessageNotFound":
    case "SurfacePermissionDenied":
      return {
        disposition: "drop-permanent-gateway-event",
        level: "warn",
        retryable: false,
      };
  }
}

function logDiscordRequestCompositionFailure(
  logger: Logger,
  requestId: string,
  sessionId: string,
  error: RequestCompositionError,
): void {
  if (error instanceof CoreOwnedBlobIntegrityError) {
    logger.error("request composition failed", {
      requestId,
      sessionId,
      disposition: "drop-integrity-failure",
      retryable: false,
      errorType: "CoreOwnedBlobIntegrityError",
      errorMessage: "Core owned blob integrity check failed",
    });
    return;
  }
  if (
    error._tag === "DiscordRequestCompositionAndCleanupFailed" ||
    error._tag === "DiscordStoredBlobPreparationAndCleanupFailed" ||
    error._tag === "DiscordStoredBlobPreparationFailed" ||
    error._tag === "StoredMessageValidationError"
  ) {
    logger.error("request composition failed", {
      requestId,
      sessionId,
      disposition: "drop-integrity-failure",
      retryable: false,
      ...formatTaggedErrorForLog(error),
    });
    return;
  }
  if (error._tag === "DiscordAttachmentPreparationFailed") {
    logger.warn("request composition failed", {
      requestId,
      sessionId,
      disposition: "drop-transient-gateway-event",
      retryable: true,
      ...formatTaggedErrorForLog(error),
    });
    return;
  }
  switch (error._tag) {
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      logger.warn("request composition failed", {
        requestId,
        sessionId,
        disposition: "drop-transient-gateway-event",
        retryable: true,
        ...formatTaggedErrorForLog(error),
      });
      return;
    case "SurfaceOperationUnsupported":
    case "SurfacePlatformMismatch":
    case "SurfaceSessionMismatch":
    case "SurfaceInvalidInput":
    case "SurfaceOperationPartiallyCompleted":
    case "SurfaceMessageNotFound":
    case "SurfacePermissionDenied":
      logger.warn("request composition failed", {
        requestId,
        sessionId,
        disposition: "drop-permanent-gateway-event",
        retryable: false,
        ...formatTaggedErrorForLog(error),
      });
      return;
  }
}

function logDiscordRequestPublishFailure(
  logger: Logger,
  requestId: string,
  sessionId: string,
  error: DiscordRequestPublishError,
): void {
  if (error instanceof DiscordRequestDeliveryFailed) {
    logger.error("request delivery failed", {
      requestId,
      sessionId,
      ...formatTaggedErrorForLog(error),
    });
    return;
  }
  logDiscordRequestCompositionFailure(logger, requestId, sessionId, error);
}

function requestPublishRoutingError(
  error: DiscordRequestPublishError,
): BusRequestRouterRoutingError {
  return new BusRequestRouterRoutingError({
    topic: "evt.adapter",
    cause: error,
    message: "Bus request router failed while handling evt.adapter",
  });
}

type ActiveSessionState = {
  requestId: string;
  /** IDs of bot output messages in the current active output chain. */
  activeOutputMessageIds: Set<string>;
};

export class BusRequestRouterMissingHeadersError extends TaggedError(
  "BusRequestRouterMissingHeadersError",
)<{
  readonly topic: "evt.request" | "evt.surface";
  readonly messageType: string;
  readonly message: string;
}> {}

export class BusRequestRouterRoutingError extends TaggedError("BusRequestRouterRoutingError")<{
  readonly topic: "evt.request" | "evt.adapter";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusRequestRouterLifecycleCorrelationInvalid extends TaggedError(
  "BusRequestRouterLifecycleCorrelationInvalid",
)<{
  readonly requestId: string;
  readonly message: string;
}> {}

export class BusRequestRouterActiveBatchGateFailed extends TaggedError(
  "BusRequestRouterActiveBatchGateFailed",
)<{
  readonly sessionId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class BusRequestRouterDebounceFlushFailed extends TaggedError(
  "BusRequestRouterDebounceFlushFailed",
)<{
  readonly sessionId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class BusRequestRouterConfigReloadFailed extends TaggedError("BusRequestRouterConfigReloadFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class BusRequestRouterSuppressionFailed extends TaggedError("BusRequestRouterSuppressionFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

type RouterDeliverySubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

export type DiscordRequestRouter = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<void>;
};

export type ResidualDiscordRequestRouter = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResidualDiscordRequestRouterStopOutcome>;
};

export class DiscordRequestRouterSubscriptionStartRejected extends TaggedError(
  "DiscordRequestRouterSubscriptionStartRejected",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DiscordRequestRouterAdapterSelfLookupRejected extends TaggedError(
  "DiscordRequestRouterAdapterSelfLookupRejected",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DiscordRequestRouterSubscriptionStopRejected extends TaggedError(
  "DiscordRequestRouterSubscriptionStopRejected",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DiscordRequestRouterStartupFailure =
  | EventDeliveryStartFailed
  | DiscordRequestRouterSubscriptionStartRejected
  | DiscordRequestRouterAdapterSelfLookupRejected;

export type DiscordRequestRouterCleanupFailure =
  | EventDeliveryStopFailed
  | DiscordRequestRouterSubscriptionStopRejected;

export class ResidualDiscordRequestRouterStopFailed extends TaggedError(
  "ResidualDiscordRequestRouterStopFailed",
)<{
  readonly failures: readonly DiscordRequestRouterCleanupFailure[];
  readonly message: string;
}> {}

export type ResidualDiscordRequestRouterStopOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<void, ResidualDiscordRequestRouterStopFailed>;
      readonly residualRouter: ResidualDiscordRequestRouter | null;
    }
  | {
      readonly kind: "panic";
      readonly panic: Panic;
      readonly additionalPanics: readonly Panic[];
      readonly ordinaryFailure: ResidualDiscordRequestRouterStopFailed | null;
      readonly residualRouter: ResidualDiscordRequestRouter;
    };

export class DiscordRequestRouterStartupAndCleanupFailed extends TaggedError(
  "DiscordRequestRouterStartupAndCleanupFailed",
)<{
  readonly startup: DiscordRequestRouterStartupFailure;
  readonly cleanup: readonly DiscordRequestRouterCleanupFailure[];
  readonly message: string;
}> {}

type DiscordRequestRouterStartError =
  | DiscordRequestRouterStartupFailure
  | DiscordRequestRouterStartupAndCleanupFailed;

export type DiscordRequestRouterStartOutcome =
  | {
      readonly kind: "result";
      readonly result: ResultType<DiscordRequestRouter, DiscordRequestRouterStartError>;
      readonly residualRouter: ResidualDiscordRequestRouter | null;
    }
  | {
      readonly kind: "panic";
      readonly panic: Panic;
      readonly additionalPanics: readonly Panic[];
      readonly startupFailure: DiscordRequestRouterStartupFailure | null;
      readonly ordinaryCleanupFailure: ResidualDiscordRequestRouterStopFailed | null;
      readonly residualRouter: ResidualDiscordRequestRouter | null;
    };

function lifecycleDeliveryPolicy(
  error:
    | BusRequestRouterMissingHeadersError
    | BusRequestRouterRoutingError
    | BusRequestRouterLifecycleCorrelationInvalid,
): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterLifecycleCorrelationInvalid":
    case "BusRequestRouterMissingHeadersError":
      return "dead-letter";
    case "BusRequestRouterRoutingError":
      return "park-pending";
  }
}

function surfaceDeliveryPolicy(error: BusRequestRouterMissingHeadersError): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterMissingHeadersError":
      return "dead-letter";
  }
}

function adapterDeliveryPolicy(error: BusRequestRouterRoutingError): DeliveryDisposition {
  switch (error._tag) {
    case "BusRequestRouterRoutingError":
      return "park-pending";
  }
}

async function captureRouterRouting(
  topic: "evt.request" | "evt.adapter",
  operation: () => Promise<void | ResultType<void, BusRequestRouterRoutingError>>,
): Promise<ResultType<void, BusRequestRouterRoutingError>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return (await operation()) ?? Result.ok(undefined);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new BusRequestRouterRoutingError({
          topic,
          cause,
          message: `Bus request router failed while handling ${topic}`,
        }),
      );
    }
    return attempt.value;
  }
}

async function captureRouterActiveBatchGate(
  sessionId: string,
  operation: () => Promise<RouterGateDecision>,
): Promise<ResultType<RouterGateDecision, BusRequestRouterActiveBatchGateFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await operation());
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (isPanic(cause)) throw cause;
      return Result.err(
        new BusRequestRouterActiveBatchGateFailed({
          sessionId,
          cause,
          message: "Active-batch router gate failed",
        }),
      );
    }
    return attempt.value;
  }
}

async function captureRouterDebounceFlush(input: {
  readonly sessionId: string;
  readonly operation: () => Promise<void>;
  readonly reportFatalPanic: (panic: Panic) => void;
}): Promise<ResultType<void, BusRequestRouterDebounceFlushFailed>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        await input.operation();
        return Result.ok(undefined);
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      const cause = attempt.error.cause;
      if (isPanic(cause)) {
        input.reportFatalPanic(cause);
        return Result.ok(undefined);
      }
      return Result.err(
        new BusRequestRouterDebounceFlushFailed({
          sessionId: input.sessionId,
          cause,
          message: "Bus request router debounce flush failed",
        }),
      );
    }
    return attempt.value;
  }
}

type RouterSubscriptionRollbackOutcome = {
  readonly failures: readonly DiscordRequestRouterCleanupFailure[];
  readonly panics: readonly Panic[];
  readonly residualSubscriptions: readonly RouterDeliverySubscription[];
};

async function stopRouterSubscriptionsAllSettled(
  subscriptions: readonly RouterDeliverySubscription[],
): Promise<RouterSubscriptionRollbackOutcome> {
  const failures: DiscordRequestRouterCleanupFailure[] = [];
  const panics: Panic[] = [];
  const residualSubscriptions: RouterDeliverySubscription[] = [];

  for (const subscription of subscriptions.toReversed()) {
    const [stopped] = await Promise.allSettled([Promise.resolve().then(() => subscription.stop())]);
    if (!stopped) continue;
    if (stopped.status === "rejected") {
      residualSubscriptions.push(subscription);
      if (isPanic(stopped.reason)) {
        panics.push(stopped.reason);
      } else {
        failures.push(
          new DiscordRequestRouterSubscriptionStopRejected({
            cause: stopped.reason,
            message: "Discord request router subscription stop rejected during cleanup",
          }),
        );
      }
      continue;
    }
    stopped.value.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => {
        residualSubscriptions.push(subscription);
        failures.push(error);
      },
    })();
  }

  return { failures, panics, residualSubscriptions };
}

async function adaptRouterSelfLookup(
  operation: () => Promise<SurfaceSelf>,
): Promise<ResultType<SurfaceSelf, DiscordRequestRouterAdapterSelfLookupRejected | Panic>> {
  return Result.tryPromise({
    try: operation,
    catch: <T>(cause: T) =>
      Panic.is(cause)
        ? cause
        : new DiscordRequestRouterAdapterSelfLookupRejected({
            cause,
            message: "Discord request router adapter self lookup rejected",
          }),
  });
}

async function rollbackRouterSubscriptionStartup(
  startedSubscriptions: readonly RouterDeliverySubscription[],
): Promise<RouterSubscriptionRollbackOutcome> {
  return stopRouterSubscriptionsAllSettled(startedSubscriptions);
}

async function adaptRouterSubscriptionStart(
  started: Promise<ResultType<RouterDeliverySubscription, EventDeliveryStartFailed>>,
): Promise<ResultType<RouterDeliverySubscription, DiscordRequestRouterStartupFailure | Panic>> {
  const captured = await Result.tryPromise({
    try: () => started,
    catch: <T>(cause: T) =>
      Panic.is(cause)
        ? cause
        : new DiscordRequestRouterSubscriptionStartRejected({
            cause,
            message: "Discord request router subscription start rejected",
          }),
  });
  return Result.flatten(captured);
}

function superviseRouterSubscriptionsDone(
  subscriptions: readonly RouterDeliverySubscription[],
): Promise<ResultType<void, EventDeliveryDoneError>> {
  return Promise.race(subscriptions.map((subscription) => subscription.done));
}

async function adaptRouterSubscriptionsStop(
  subscriptions: readonly RouterDeliverySubscription[],
): Promise<void> {
  const results = await Promise.all(subscriptions.map((subscription) => subscription.stop()));
  for (const result of results) {
    result.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => {
        throw error;
      },
    })();
  }
}

function createResidualDiscordRequestRouter(
  subscriptions: readonly RouterDeliverySubscription[],
): ResidualDiscordRequestRouter {
  return {
    done: superviseRouterSubscriptionsDone(subscriptions),
    stop: async () => {
      const stopped = await stopRouterSubscriptionsAllSettled(subscriptions);
      const residualRouter =
        stopped.residualSubscriptions.length > 0
          ? createResidualDiscordRequestRouter(stopped.residualSubscriptions)
          : null;
      const ordinaryFailure =
        stopped.failures.length > 0
          ? new ResidualDiscordRequestRouterStopFailed({
              failures: stopped.failures,
              message: "Discord request router residual subscription cleanup failed",
            })
          : null;

      const panic = stopped.panics[0];
      if (panic && residualRouter) {
        return {
          kind: "panic",
          panic,
          additionalPanics: stopped.panics.slice(1),
          ordinaryFailure,
          residualRouter,
        };
      }
      if (ordinaryFailure) {
        return {
          kind: "result",
          result: Result.err(ordinaryFailure),
          residualRouter,
        };
      }
      return { kind: "result", result: Result.ok(undefined), residualRouter: null };
    },
  };
}

async function finishRouterSubscriptionStartFailure(
  startup: DiscordRequestRouterStartupFailure | Panic,
  startedSubscriptions: readonly RouterDeliverySubscription[],
): Promise<DiscordRequestRouterStartOutcome> {
  const rollback = await rollbackRouterSubscriptionStartup(startedSubscriptions);
  const residualRouter =
    rollback.residualSubscriptions.length > 0
      ? createResidualDiscordRequestRouter(rollback.residualSubscriptions)
      : null;
  const ordinaryCleanupFailure =
    rollback.failures.length > 0
      ? new ResidualDiscordRequestRouterStopFailed({
          failures: rollback.failures,
          message: "Discord request router startup rollback cleanup failed",
        })
      : null;

  if (isPanic(startup)) {
    return {
      kind: "panic",
      panic: startup,
      additionalPanics: rollback.panics,
      startupFailure: null,
      ordinaryCleanupFailure,
      residualRouter,
    };
  }
  const rollbackPanic = rollback.panics[0];
  if (rollbackPanic) {
    return {
      kind: "panic",
      panic: rollbackPanic,
      additionalPanics: rollback.panics.slice(1),
      startupFailure: startup,
      ordinaryCleanupFailure,
      residualRouter,
    };
  }
  if (rollback.failures.length === 0) {
    return { kind: "result", result: Result.err(startup), residualRouter: null };
  }
  return {
    kind: "result",
    result: Result.err(
      new DiscordRequestRouterStartupAndCleanupFailed({
        startup,
        cleanup: rollback.failures,
        message: `${startup.message}; startup rollback also failed`,
      }),
    ),
    residualRouter,
  };
}

export function adaptDiscordRequestRouterStartOutcomeToHost(
  outcome: DiscordRequestRouterStartOutcome,
  retainResidualRouter: (router: ResidualDiscordRequestRouter) => void,
  recordPanicDiagnostics: (diagnostics: {
    readonly additionalPanicCount: number;
    readonly startupFailure: DiscordRequestRouterStartupFailure | null;
    readonly ordinaryCleanupFailure: ResidualDiscordRequestRouterStopFailed | null;
  }) => void,
): DiscordRequestRouter {
  if (outcome.residualRouter) retainResidualRouter(outcome.residualRouter);
  if (outcome.kind === "panic") {
    recordPanicDiagnostics({
      additionalPanicCount: outcome.additionalPanics.length,
      startupFailure: outcome.startupFailure,
      ordinaryCleanupFailure: outcome.ordinaryCleanupFailure,
    });
    throw outcome.panic;
  }
  return outcome.result.match<() => DiscordRequestRouter>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

function resolveTriggerType(input: {
  replyToBot: boolean | undefined;
  mentionsBot: boolean | undefined;
}): "reply" | "mention" | undefined {
  if (input.replyToBot) return "reply";
  if (input.mentionsBot) return "mention";
  return undefined;
}

function surfaceMessageFromIngress(input: {
  event: EvtAdapterMessageCreatedData;
  raw: NormalizedDiscordRaw | null;
  parentChannelId?: string;
  guildId?: string;
}): SurfaceMessage {
  const normalizedRaw = input.raw;
  const reference = normalizedRaw?.reference ?? normalizedRaw?.replyReference;
  return {
    ref: parseDiscordMsgRefFromAdapterEvent(input.event),
    session: {
      platform: "discord",
      channelId: input.event.channelId,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.parentChannelId ? { parentChannelId: input.parentChannelId } : {}),
    },
    userId: input.event.userId,
    ...(input.event.userName ? { userName: input.event.userName } : {}),
    text: input.event.text,
    ts: input.event.ts,
    raw: normalizedRaw
      ? {
          ...(normalizedRaw.content ? { content: normalizedRaw.content } : {}),
          embeds: normalizedRaw.embeds,
          attachments: normalizedRaw.attachments,
          ...(reference ? { reference } : {}),
          ...(normalizedRaw.forwardSnapshot
            ? { messageSnapshots: [{ message: normalizedRaw.forwardSnapshot.raw }] }
            : {}),
          discord: normalizedRaw.isChat === undefined ? {} : { isChat: normalizedRaw.isChat },
        }
      : {},
  };
}

function uniqueParticipantUserIds(input: {
  values: readonly (string | undefined)[];
  exclude: string;
}): string[] {
  const exclude = input.exclude.trim();
  return [
    ...new Set(
      input.values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value && value !== exclude),
    ),
  ];
}

type DebounceBuffer = {
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  guildId?: string;
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

export type StartDiscordRequestRouterInput = {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  blobStore: BlobStore;
  resourceRegistry: ResourceRegistry;
  attachmentCache?: DiscordAttachmentCacheAccess;
  messageCache?: DiscordMessageCacheAccess;
  requestDelivery: DiscordRequestDeliveryPort;
  subscriptionId: string;
  customCommands?: CustomCommandManager;
  contextReport?: DiscordContextReportProvider;
  /** Optionally inject config; defaults to getCoreConfig(). */
  config?: CoreConfig;
  transcriptStore?: TranscriptStore;
  /**
   * Optionally suppress routing for specific adapter events.
   * Used to prevent workflow-resume replies from also being treated as normal prompts.
   */
  shouldSuppressAdapterEvent?: (input: {
    evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ suppress: boolean; reason?: string }>;
  /** Optional injection for unit tests (bypasses real model call). */
  routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
  /** Optional structured logger injection for embedding and tests. */
  logger?: Logger;
};

export function signalDiscordRequestRouterPlatformMismatch(
  platform: SurfaceSelf["platform"],
): never {
  throw new Panic({
    message: `Discord request router requires a Discord adapter (got '${platform}')`,
  });
}

export async function startDiscordRequestRouter(
  params: StartDiscordRequestRouterInput,
): Promise<DiscordRequestRouterStartOutcome> {
  const selfLookup = await adaptRouterSelfLookup(() => params.adapter.getSelf());
  const selfOrFailure = continueResult(selfLookup, {
    err: (error) => finishRouterSubscriptionStartFailure(error, []),
    ok: (self) => self,
  });
  if (selfOrFailure instanceof Promise) return selfOrFailure;
  const self = selfOrFailure;
  const { adapter, bus, subscriptionId, customCommands } = params;
  if (self.platform !== "discord") signalDiscordRequestRouterPlatformMismatch(self.platform);

  const logger =
    params.logger ??
    createLogger({
      module: "discord-request-router",
    });

  let cfg = params.config ?? (await getCoreConfig());
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    {
      const attempt = await Result.tryPromise({
        try: async () => {
          cfg = await getCoreConfig();

          if (coreConfigReloadHadError) {
            logger.info("core-config reload recovered", {
              path: "core-config.yaml",
            });
          }

          coreConfigReloadHadError = false;
          lastCoreConfigReloadError = null;
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const e = attempt.error.cause;
        if (isPanic(e)) throw e;
        const failure = new BusRequestRouterConfigReloadFailed({
          cause: e,
          message: "Core config reload failed",
        });
        const logContext = formatBridgeTaggedErrorForLog(failure, {
          path: "core-config.yaml",
        });
        const msg = logContext.errorMessage;
        if (!coreConfigReloadHadError || lastCoreConfigReloadError !== msg) {
          logger.warn("core-config reload failed; using last known config", logContext);
        }

        coreConfigReloadHadError = true;
        lastCoreConfigReloadError = msg;
      }
    }
  }

  const activeBySession = new Map<string, ActiveSessionState>();
  const activeSessionForRequest = (requestId: string): string | undefined => {
    for (const [sessionId, active] of activeBySession) {
      if (active.requestId === requestId) return sessionId;
    }
    return undefined;
  };
  const buffers = new Map<string, DebounceBuffer>();
  const pendingMentionReplyBatchBySession = new Map<string, PendingMentionReplyBatch>();
  const debounceDefect = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
  const evaluateRouterGate = (input: RouterGateInput): Promise<RouterGateDecision> => {
    return params.routerGate
      ? params.routerGate(input)
      : shouldForwardByGate({ cfg, input, logger });
  };

  async function sendContextCommandReply(input: {
    ingressMessage: SurfaceMessage;
    text: string;
    accentColor?: number;
  }): Promise<void> {
    const sent = await adapter.sendMsg(
      input.ingressMessage.session,
      {
        text: input.text,
        ...(input.accentColor === undefined ? {} : { accentColor: input.accentColor }),
      },
      { replyTo: input.ingressMessage.ref, silent: true },
    );
    const sendError = sent.match({ ok: () => null, err: (error) => error });
    if (!sendError) return;
    logger.warn("context report reply failed", {
      source: "snapshot",
      sessionId: input.ingressMessage.session.channelId,
      ...formatTaggedErrorForLog(sendError),
    });
  }

  async function reportContextTextCommand(input: {
    cfg: CoreConfig;
    sessionId: string;
    parentChannelId?: string;
    guildId?: string;
    msgRef: MsgRef;
    ingressMessage: SurfaceMessage;
    requestId?: string;
    modelOverride?: string;
    botMentionNames: readonly string[];
  }): Promise<void> {
    const requestId = formatDiscordMessageRequestId({
      channelId: input.sessionId,
      messageId: input.msgRef.messageId,
    });
    const discordUserAliasById = buildDiscordUserAliasById(input.cfg);
    const composed = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: input.sessionId,
      botUserId: self.userId,
      botName: input.cfg.surface.discord.botName,
      botMentionNames: input.botMentionNames,
      limit: 8,
      transcriptStore: params.transcriptStore,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      attachmentCacheTtl: input.cfg.surface.discord.attachmentCache.ttlMs,
      messageCache: params.messageCache,
      ingressMessages: [input.ingressMessage],
      currentRequestId: input.requestId ?? requestId,
      currentMessageIds: [input.msgRef.messageId],
      discordUserAliasById,
      triggerMsgRef: input.msgRef,
    });
    const compositionError = composed.match({ ok: () => null, err: (error) => error });
    if (compositionError) {
      logDiscordRequestCompositionFailure(logger, requestId, input.sessionId, compositionError);
      await sendContextCommandReply({
        ingressMessage: input.ingressMessage,
        text: "Unable to build the context snapshot.",
      });
      return;
    }
    const composition = composed.match({ ok: (value) => value, err: () => null });
    if (!composition) return;

    const cleanup = await deleteDiscordRequestBlobHandles(
      params.blobStore,
      composition.inputHandles,
    );
    const cleanupError = cleanup.match({ ok: () => null, err: (error) => error });
    if (cleanupError) {
      logger.warn("context snapshot input cleanup failed", {
        sessionId: input.sessionId,
        requestId,
        ...formatTaggedErrorForLog(cleanupError),
      });
    }

    const contextReport = params.contextReport;
    if (!contextReport) {
      await sendContextCommandReply({
        ingressMessage: input.ingressMessage,
        text: "Context reporting is not ready yet.",
      });
      return;
    }
    const report = await contextReport({
      source: "snapshot",
      config: input.cfg,
      sessionId: input.sessionId,
      requestId: input.requestId ?? requestId,
      userId: input.ingressMessage.userId,
      ...(input.parentChannelId ? { parentChannelId: input.parentChannelId } : {}),
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      messages: composition.messages,
      corePrimaryLineage: composition.corePrimaryLineage,
    });
    const reportError = report.match({ ok: () => null, err: (error) => error });
    if (reportError) {
      logger.warn("context report failed", {
        source: "snapshot",
        sessionId: input.sessionId,
        ...formatTaggedErrorForLog(reportError),
      });
      await sendContextCommandReply({
        ingressMessage: input.ingressMessage,
        text: "Unable to build the context snapshot.",
      });
      return;
    }
    const presentation = report.match({ ok: (value) => value, err: () => null });
    if (!presentation) return;
    await sendContextCommandReply({
      ingressMessage: input.ingressMessage,
      text: presentation.text,
      accentColor: presentation.accentColor,
    });
  }

  async function resolvePreviousMessageText(input: {
    msgRef: MsgRef;
    triggerTs: number;
  }): Promise<string | undefined> {
    return resolvePreviousMessageTextImpl({ adapter, messageCache: params.messageCache, input });
  }

  async function resolveRepliedToMessageText(input: {
    sessionId: string;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    return resolveRepliedToMessageTextImpl({
      adapter,
      messageCache: params.messageCache,
      transcriptStore: params.transcriptStore,
      input,
    });
  }

  async function resolvePreviousBatchMessageText(
    messages: readonly BufferedMessage[],
  ): Promise<string | undefined> {
    return resolvePreviousBatchMessageTextImpl({
      adapter,
      messageCache: params.messageCache,
      messages,
    });
  }

  function combineTextTransforms(
    ...transforms: Array<((text: string) => string) | undefined>
  ): ((text: string) => string) | undefined {
    const activeTransforms = transforms.filter(
      (transform): transform is (text: string) => string => typeof transform === "function",
    );
    if (activeTransforms.length === 0) return undefined;
    return (text: string) => activeTransforms.reduce((acc, transform) => transform(acc), text);
  }

  function stripCurrentContinueDirective(input: {
    text: string;
    botNames: readonly string[];
    continueCount?: number;
  }): ((text: string) => string) | undefined {
    if (input.continueCount === undefined) return undefined;
    return (text: string) =>
      stripLeadingContinueDirective({
        text,
        botNames: input.botNames,
      });
  }

  async function evaluateAdapterSuppression(
    evt: EvtAdapterMessageCreatedData,
  ): Promise<{ suppress: boolean; reason?: string }> {
    const shouldSuppressAdapterEvent = params.shouldSuppressAdapterEvent;
    if (!shouldSuppressAdapterEvent) return { suppress: false };
    const captured = await Result.tryPromise({
      try: () => shouldSuppressAdapterEvent({ evt }),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    const outcome = captured.match<
      | {
          readonly kind: "success";
          readonly decision: Awaited<
            ReturnType<NonNullable<typeof params.shouldSuppressAdapterEvent>>
          >;
        }
      | { readonly kind: "failure"; readonly restoreCause: () => unknown }
    >({
      ok: (decision) => ({ kind: "success", decision }),
      err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
    });
    if (outcome.kind === "failure") {
      const cause = outcome.restoreCause();
      if (isPanic(cause)) throw cause;
      const error = new BusRequestRouterSuppressionFailed({
        cause,
        message: "Router suppression hook failed",
      });
      logger.error(
        "router suppression hook failed; proceeding",
        formatBridgeTaggedErrorForLog(error),
      );
      return { suppress: false };
    }
    return outcome.decision;
  }

  async function evaluateDirectReplyRouterGate(input: {
    readonly sessionId: string;
    readonly gateInput: RouterGateInput;
  }): Promise<RouterGateDecision> {
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          return await evaluateRouterGate(input.gateInput);
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        if (isPanic(cause)) throw cause;
        const failure = new BusRequestRouterActiveBatchGateFailed({
          sessionId: input.sessionId,
          cause,
          message: "Direct-reply router gate failed",
        });
        logger.error(
          "router direct-reply gate failed; forwarding",
          formatBridgeTaggedErrorForLog(failure, {
            sessionId: input.sessionId,
            ...extractAiErrorLogDetails(cause),
          }),
        );
        return { forward: true, reason: "error-fail-open" };
      }
      return attempt.value;
    }
  }

  const startedSubscriptions: RouterDeliverySubscription[] = [];
  const lifecycleStarted = await adaptRouterSubscriptionStart(
    bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:lifecycle`,
        consumerId: consumerId(`${subscriptionId}:lifecycle`),
        batch: { maxWaitMs: 1000 },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.EvtRequestLifecycleChanged) {
          return Result.ok(undefined);
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        const requestClient = msg.headers?.request_client;
        if (!requestId || !sessionId || !requestClient) {
          logger.error("router.message.invalid_headers", {
            topic: "evt.request",
            messageType: msg.type,
            hasRequestId: Boolean(requestId),
            hasSessionId: Boolean(sessionId),
            cursor: ctx.cursor,
            rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
            action: "dead_letter",
          });
          return Result.err(
            new BusRequestRouterMissingHeadersError({
              topic: "evt.request",
              messageType: msg.type,
              message:
                "evt.request.lifecycle.changed missing required headers.request_id/session_id/request_client",
            }),
          );
        }

        const activeSessionId = activeSessionForRequest(requestId);
        if (requestClient !== "discord") {
          if (activeSessionId !== undefined) {
            return Result.err(
              new BusRequestRouterLifecycleCorrelationInvalid({
                requestId,
                message: "Request lifecycle platform conflicts with Discord router ownership",
              }),
            );
          }
          return Result.ok(undefined);
        }
        if (activeSessionId !== undefined && activeSessionId !== sessionId) {
          return Result.err(
            new BusRequestRouterLifecycleCorrelationInvalid({
              requestId,
              message: "Request lifecycle session conflicts with Discord router ownership",
            }),
          );
        }

        return captureRouterRouting("evt.request", async () => {
          if (msg.data.state === "running") {
            const current = activeBySession.get(sessionId);
            if (current?.requestId !== requestId) {
              activeBySession.set(sessionId, {
                requestId,
                activeOutputMessageIds: new Set(),
              });
            }
          }

          if (
            msg.data.state === "resolved" ||
            msg.data.state === "failed" ||
            msg.data.state === "cancelled"
          ) {
            const cur = activeBySession.get(sessionId);
            if (cur?.requestId === requestId) {
              const flushed = await flushPendingMentionReplyBatchAsPrompt({
                sessionId,
                sourceRequestId: requestId,
              });
              const flushError = flushed.match({ ok: () => null, err: (error) => error });
              if (flushError) return Result.err(flushError);
              activeBySession.delete(sessionId);
            }
          }
        });
      },
      lifecycleDeliveryPolicy,
    ),
  );
  const lifecycleStartFailure = continueResult(lifecycleStarted, {
    err: (error) => finishRouterSubscriptionStartFailure(error, startedSubscriptions),
    ok: (subscription) => {
      startedSubscriptions.push(subscription);
      return null;
    },
  });
  if (lifecycleStartFailure) return lifecycleStartFailure;

  const surfaceStarted = await adaptRouterSubscriptionStart(
    bus.subscribeTopic(
      "evt.surface",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:surface`,
        consumerId: consumerId(`${subscriptionId}:surface`),
        batch: { maxWaitMs: 1000 },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.EvtSurfaceOutputMessageCreated) {
          return Result.ok(undefined);
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        if (!requestId || !sessionId) {
          logger.error("router.message.invalid_headers", {
            topic: "evt.surface",
            messageType: msg.type,
            hasRequestId: Boolean(requestId),
            hasSessionId: Boolean(sessionId),
            cursor: ctx.cursor,
            rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
            action: "dead_letter",
          });
          return Result.err(
            new BusRequestRouterMissingHeadersError({
              topic: "evt.surface",
              messageType: msg.type,
              message:
                "evt.surface.output.message.created missing required headers.request_id/session_id",
            }),
          );
        }

        const cur = activeBySession.get(sessionId);
        if (!cur || cur.requestId !== requestId) {
          return Result.ok(undefined);
        }

        const msgRef = msg.data.msgRef;
        if (
          msgRef?.platform === "discord" &&
          typeof msgRef.messageId === "string" &&
          msgRef.messageId
        ) {
          cur.activeOutputMessageIds.add(msgRef.messageId);
        }

        return Result.ok(undefined);
      },
      surfaceDeliveryPolicy,
    ),
  );
  const surfaceStartFailure = continueResult(surfaceStarted, {
    err: (error) => finishRouterSubscriptionStartFailure(error, startedSubscriptions),
    ok: (subscription) => {
      startedSubscriptions.push(subscription);
      return null;
    },
  });
  if (surfaceStartFailure) return surfaceStartFailure;

  const adapterStarted = await adaptRouterSubscriptionStart(
    bus.subscribeTopic(
      "evt.adapter",
      {
        mode: "fanout",
        subscriptionId: `${subscriptionId}:adapter`,
        consumerId: consumerId(`${subscriptionId}:adapter`),
        batch: { maxWaitMs: 1000 },
      },
      async (msg) => {
        if (msg.type !== lilacEventTypes.EvtAdapterMessageCreated) {
          return Result.ok(undefined);
        }
        if (msg.data.platform !== "discord") {
          return Result.ok(undefined);
        }

        const latencyRequestId = formatDiscordMessageRequestId({
          channelId: msg.data.channelId,
          messageId: msg.data.messageId,
        });
        recordRequestLatencyStage(latencyRequestId, "adapterEventPublishedAt", msg.ts);
        recordRequestLatencyStage(latencyRequestId, "routerReceivedAt");

        return captureRouterRouting("evt.adapter", async () => {
          if (env.perf.log) {
            const lagMs = Date.now() - msg.ts;
            const shouldWarn = lagMs >= env.perf.lagWarnMs;
            const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
            if (shouldWarn || shouldSample) {
              if (shouldWarn) {
                logger.warn("perf.bus_lag", {
                  stage: "evt.adapter->router",
                  lagMs,
                  sessionId: msg.data.channelId,
                  messageId: msg.data.messageId,
                  userId: msg.data.userId,
                });
              } else {
                logger.info("perf.bus_lag", {
                  stage: "evt.adapter->router",
                  lagMs,
                  sessionId: msg.data.channelId,
                  messageId: msg.data.messageId,
                  userId: msg.data.userId,
                });
              }
            }
          }

          const suppression = await evaluateAdapterSuppression(msg.data);
          if (suppression.suppress) {
            logger.info("router suppressed adapter message", {
              sessionId: msg.data.channelId,
              messageId: msg.data.messageId,
              userId: msg.data.userId,
              reason: suppression.reason,
            });
            return;
          }

          // reload config opportunistically (mtime cached in getCoreConfig).
          // If reload fails, keep using the last known good config.
          await reloadCoreConfigIfNeeded();

          const sessionId = msg.data.channelId;
          const msgRef = parseDiscordMsgRefFromAdapterEvent(msg.data);

          const flags = getDiscordFlags(msg.data.raw);
          const isDm = flags.isDMBased === true;
          const parentChannelId = flags.parentChannelId;
          const ingressMessage = surfaceMessageFromIngress({
            event: msg.data,
            raw: normalizeDiscordRaw(msg.data.raw),
            parentChannelId,
            guildId: flags.guildId,
          });
          const botMentionNames = resolveBotMentionNames({
            cfg,
            botUserId: flags.botUserId ?? (await adapter.getSelf()).userId,
          });
          const requestModelOverride = parseLeadingModelOverride({
            text: msg.data.text,
            botNames: botMentionNames,
          });
          const continueCount = parseLeadingContinueDirective({
            text: msg.data.text,
            botNames: botMentionNames,
          });
          const configuredSessionModelOverride = resolveSessionModelOverride(
            cfg,
            sessionId,
            parentChannelId,
            flags.guildId,
          );
          const modelOverride =
            requestModelOverride ?? flags.sessionModelOverride ?? configuredSessionModelOverride;
          const sessionConfigId = isDm
            ? sessionId
            : resolveSessionConfigId({
                cfg,
                sessionId,
                parentChannelId,
                guildId: flags.guildId,
              });

          const mode: SessionMode = isDm
            ? "active"
            : getSessionMode(cfg, sessionId, parentChannelId, flags.guildId);
          const gateEnabled = resolveSessionGateEnabled(
            cfg,
            sessionId,
            parentChannelId,
            flags.guildId,
          );

          const active = activeBySession.get(sessionId);

          const logRouteDecision = (input: {
            decision:
              | "forward"
              | "skip"
              | "queue_followup"
              | "queue_prompt"
              | "steer"
              | "interrupt";
            reason: string;
          }) => {
            logger.info("router.route.decision", {
              sessionId,
              messageId: msgRef.messageId,
              userId: msg.data.userId,
              mode,
              gateEnabled,
              decision: input.decision,
              reason: input.reason,
              activeRequestId: active?.requestId,
              sessionConfigId,
              modelOverride,
              requestModelOverride,
              continueCount,
            });
          };

          logger.debug("adapter.message.created", {
            sessionId,
            messageId: msgRef.messageId,
            userId: msg.data.userId,
            mode,
            isDm,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            activeRequestId: active?.requestId,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            continueCount,
            textPreview:
              typeof msg.data.text === "string" && msg.data.text.trim().length > 0
                ? previewText(msg.data.text)
                : undefined,
          });

          if (isDiscordContextTextCommand(msg.data.text)) {
            if (active) {
              const published = await publishSingleMessageToActiveRequest({
                adapter,
                bus,
                cfg,
                requestId: active.requestId,
                sessionId,
                sessionConfigId,
                parentChannelId,
                queue: "followUp",
                msgRef,
                ingressMessage,
                sessionMode: mode,
                modelOverride,
              });
              const publishError = published.match({ ok: () => null, err: (error) => error });
              if (publishError) return Result.err(publishError);
            }

            await reportContextTextCommand({
              cfg,
              sessionId,
              parentChannelId,
              guildId: flags.guildId,
              msgRef,
              ingressMessage,
              ...(active ? { requestId: active.requestId } : {}),
              modelOverride,
              botMentionNames,
            });
            logRouteDecision(
              active
                ? { decision: "queue_followup", reason: "context_snapshot" }
                : { decision: "skip", reason: "context_snapshot_no_active_run" },
            );
            return;
          }

          const customName = customCommands?.peekTextName(msg.data.text) ?? null;
          if (customName) {
            const requestId = formatDiscordMessageRequestId({
              channelId: sessionId,
              messageId: msgRef.messageId,
            });
            const raw = (() => {
              const known = customCommands?.get(customName);
              if (!known) {
                return {
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: `Unknown custom command '${customName}'.`,
                  },
                };
              }

              const parsed = customCommands?.parseText(msg.data.text);
              if (!parsed) {
                return {
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: `Unknown custom command '${customName}'.`,
                  },
                };
              }
              return parsed.match({
                err: (error) => ({
                  customCommand: {
                    name: customName,
                    args: [],
                    text: msg.data.text,
                    source: "text",
                    error: customCommandInvocationErrorText(error),
                  },
                }),
                ok: (value) =>
                  value
                    ? {
                        customCommand: {
                          name: value.command.def.name,
                          args: value.args,
                          ...(value.prompt ? { prompt: value.prompt } : {}),
                          text: value.text,
                          source: value.source,
                        },
                      }
                    : {
                        customCommand: {
                          name: customName,
                          args: [],
                          text: msg.data.text,
                          source: "text",
                          error: `Unknown custom command '${customName}'.`,
                        },
                      },
              });
            })();

            await publishSingleMessagePrompt({
              adapter,
              bus,
              cfg,
              requestId,
              sessionId,
              sessionConfigId,
              parentChannelId,
              msgRef,
              ingressMessage,
              sessionMode: mode,
              modelOverride,
              raw,
            });

            logRouteDecision({
              decision: "forward",
              reason: `custom_command:${customName}`,
            });
            return;
          }

          if (
            !isDm &&
            gateEnabled &&
            shouldRunDirectReplyMentionGate({
              replyToBot: flags.replyToBot === true,
              mentionsBot: flags.mentionsBot === true,
              text: msg.data.text,
              botNames: botMentionNames,
            })
          ) {
            const [previousMessageText, repliedToMessageText] = await Promise.all([
              resolvePreviousMessageText({ msgRef, triggerTs: msg.data.ts }),
              resolveRepliedToMessageText({
                sessionId,
                replyToMessageId: flags.replyToMessageId,
              }),
            ]);

            const decision = await evaluateDirectReplyRouterGate({
              sessionId,
              gateInput: {
                sessionId,
                botName: cfg.surface.discord.botName,
                messages: [
                  {
                    msgRef,
                    userId: msg.data.userId,
                    text: msg.data.text,
                    ts: msg.data.ts,
                    mentionsBot: flags.mentionsBot === true,
                    replyToBot: flags.replyToBot === true,
                  },
                ],
                context: {
                  mode: "direct-reply-mention-disambiguation",
                  triggerMessageText: normalizeGateText(msg.data.text),
                  previousMessageText,
                  repliedToMessageText,
                },
              },
            });

            if (!decision.forward) {
              logRouteDecision({
                decision: "skip",
                reason: `direct_reply_gate:${decision.reason ?? "skip"}`,
              });
              return;
            }

            logRouteDecision({
              decision: "forward",
              reason: `direct_reply_gate:${decision.reason ?? "forward"}`,
            });
          }

          if (mode === "active") {
            if (isDm) {
              return handleActiveDmMode({
                adapter,
                bus,
                cfg,
                sessionId,
                msgRef,
                ingressMessage,
                userId: msg.data.userId,
                userText: msg.data.text,
                mentionsBot: flags.mentionsBot === true,
                replyToBot: flags.replyToBot === true,
                replyToMessageId: flags.replyToMessageId,
                active,
                sessionMode: mode,
                sessionConfigId,
                modelOverride,
                requestModelOverride,
                continueCount,
                botMentionNames,
              });
            }
            return handleActiveChannelMode({
              adapter,
              bus,
              cfg,
              buffers,
              sessionId,
              msgRef,
              ingressMessage,
              userId: msg.data.userId,
              userText: msg.data.text,
              messageTs: msg.data.ts,
              mentionsBot: flags.mentionsBot === true,
              replyToBot: flags.replyToBot === true,
              replyToMessageId: flags.replyToMessageId,
              botUserId: flags.botUserId,
              parentChannelId,
              guildId: flags.guildId,
              active,
              sessionMode: mode,
              sessionConfigId,
              modelOverride,
              requestModelOverride,
              continueCount,
              botMentionNames,
            });
          }

          return handleMentionMode({
            adapter,
            bus,
            cfg,
            activeBySession,
            sessionId,
            msgRef,
            ingressMessage,
            userText: msg.data.text,
            mentionsBot: flags.mentionsBot,
            replyToBot: flags.replyToBot,
            replyToMessageId: flags.replyToMessageId,
            active,
            parentChannelId,
            sessionMode: mode,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            continueCount,
            botMentionNames,
          });
        });
      },
      adapterDeliveryPolicy,
    ),
  );
  const adapterStartFailure = continueResult(adapterStarted, {
    err: (error) => finishRouterSubscriptionStartFailure(error, startedSubscriptions),
    ok: (subscription) => {
      startedSubscriptions.unshift(subscription);
      return null;
    },
  });
  if (adapterStartFailure) return adapterStartFailure;

  function clearDebounceBuffer(sessionId: string) {
    const b = buffers.get(sessionId);
    if (!b) return;
    buffers.delete(sessionId);
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
  }

  async function enqueuePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    item: PendingMentionReplyBatchItem;
  }): Promise<ResultType<void, BusRequestRouterRoutingError>> {
    const existing = pendingMentionReplyBatchBySession.get(input.sessionId);
    if (existing && existing.sourceRequestId !== input.sourceRequestId) {
      const flushed = await flushPendingMentionReplyBatchAsFollowUp({
        sessionId: input.sessionId,
        sourceRequestId: existing.sourceRequestId,
      });
      const flushError = flushed.match({ ok: () => null, err: (error) => error });
      if (flushError) return Result.err(flushError);
    }
    enqueuePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
    return Result.ok(undefined);
  }

  function takePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
  }): PendingMentionReplyBatch | null {
    return takePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
  }

  function transformPendingUserText(
    item: PendingMentionReplyBatchItem,
  ): ((text: string) => string) | undefined {
    return transformPendingUserTextImpl(item);
  }

  async function flushPendingMentionReplyBatchAsFollowUp(input: {
    sessionId: string;
    sourceRequestId: string;
  }): Promise<ResultType<void, BusRequestRouterRoutingError>> {
    const batch = pendingMentionReplyBatchBySession.get(input.sessionId);
    if (!batch || batch.sourceRequestId !== input.sourceRequestId) return Result.ok(undefined);

    while (batch.items.length > 0) {
      const item = batch.items[0]!;
      const published = await publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: batch.sourceRequestId,
        sessionId: input.sessionId,
        sessionConfigId: batch.sessionConfigId,
        parentChannelId: batch.parentChannelId,
        queue: "followUp",
        msgRef: item.msgRef,
        ingressMessage: item.ingressMessage,
        sessionMode: batch.sessionMode,
        modelOverride: batch.modelOverride,
        transformUserText: transformPendingUserText(item),
      });
      const publishError = published.match({ ok: () => null, err: (error) => error });
      if (publishError) {
        return Result.err(
          new BusRequestRouterRoutingError({
            topic: "evt.adapter",
            cause: publishError,
            message: "Bus request router failed while handling evt.adapter",
          }),
        );
      }
      batch.items.shift();
    }

    if (pendingMentionReplyBatchBySession.get(input.sessionId) === batch) {
      pendingMentionReplyBatchBySession.delete(input.sessionId);
    }
    return Result.ok(undefined);
  }

  async function flushPendingMentionReplyBatchAsPrompt(input: {
    sessionId: string;
    sourceRequestId: string;
  }): Promise<ResultType<void, BusRequestRouterRoutingError>> {
    const batch = takePendingMentionReplyBatch(input);
    if (!batch || batch.items.length === 0) return Result.ok(undefined);
    const restoreBatch = (): void => {
      if (!pendingMentionReplyBatchBySession.has(input.sessionId)) {
        pendingMentionReplyBatchBySession.set(input.sessionId, batch);
      }
    };

    const last = batch.items[batch.items.length - 1]!;
    const originResult = await resolveCorrelatedOriginMessage({
      adapter,
      ref: last.msgRef,
      ingressMessages: last.ingressMessage ? [last.ingressMessage] : undefined,
    });
    const { originMessage, originError } = originResult.match<{
      originMessage: SurfaceMessage | null;
      originError: RequestCompositionError | null;
    }>({
      ok: (message) => ({ originMessage: message, originError: null }),
      err: (error) => ({ originMessage: null, originError: error }),
    });
    if (originError) {
      restoreBatch();
      return Result.err(requestPublishRoutingError(originError));
    }
    const requestId = formatDiscordMessageRequestId({
      channelId: input.sessionId,
      messageId: last.msgRef.messageId,
    });
    const requestDeliveryId = crypto.randomUUID();

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      transcriptStore: params.transcriptStore,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      attachmentCacheTtl: cfg.surface.discord.attachmentCache.ttlMs,
      messageCache: params.messageCache,
      ingressMessages: batch.items.flatMap((item) =>
        item.ingressMessage ? [item.ingressMessage] : [],
      ),
      currentRequestId: requestId,
      currentMessageIds: batch.items.map((item) => item.msgRef.messageId),
      discordUserAliasById,
      transformUserText: transformPendingUserText(last),
      transformUserTextForMessageId: last.msgRef.messageId,
      trigger: {
        type: "reply",
        msgRef: last.msgRef,
      },
    });
    const compositionError = composed.match({ ok: () => null, err: (error) => error });
    if (compositionError) {
      logDiscordRequestCompositionFailure(logger, requestId, input.sessionId, compositionError);
      restoreBatch();
      return Result.err(requestPublishRoutingError(compositionError));
    }
    const composition = composed.match({ ok: (value) => value, err: () => null });
    if (!composition) {
      restoreBatch();
      return Result.err(
        new BusRequestRouterRoutingError({
          topic: "evt.request",
          cause: null,
          message: "Deferred Discord request composition returned no result",
        }),
      );
    }

    const chainMessageIds = new Set(composition.chainMessageIds);
    const extraCompositions: RequestCompositionResult[] = [];
    const batchParticipantUserIds: string[] = [];

    for (const item of batch.items) {
      const surfaceMessage = item.ingressMessage
        ? Result.ok(item.ingressMessage)
        : await adapter.readMsg(item.msgRef);
      const userId = surfaceMessage.match({ ok: (value) => value?.userId, err: () => undefined });
      if (userId) batchParticipantUserIds.push(userId);
      if (chainMessageIds.has(item.msgRef.messageId)) continue;
      const extra = await composeSingleMessageWithLineage(adapter, {
        platform: "discord",
        botUserId: self.userId,
        botName: cfg.surface.discord.botName,
        msgRef: item.msgRef,
        discordUserAliasById,
        transcriptStore: params.transcriptStore,
        blobStore: params.blobStore,
        resourceRegistry: params.resourceRegistry,
        attachmentCache: params.attachmentCache,
        attachmentCacheTtl: cfg.surface.discord.attachmentCache.ttlMs,
        messageCache: params.messageCache,
        ingressMessages: item.ingressMessage ? [item.ingressMessage] : undefined,
        transformUserText: transformPendingUserText(item),
      });
      const extraError = extra.match({ ok: () => null, err: (error) => error });
      if (extraError) {
        const cleanup = await deleteDiscordRequestBlobHandles(params.blobStore, [
          ...composition.inputHandles,
          ...extraCompositions.flatMap((value) => value.inputHandles),
        ]);
        const finalError = cleanup.match<RequestCompositionError>({
          ok: () => extraError,
          err: (cleanupError) =>
            new DiscordRequestCompositionAndCleanupFailed({
              primary: extraError,
              cleanup: cleanupError,
              message: "Deferred Discord request composition and input handle cleanup failed",
            }),
        });
        logDiscordRequestCompositionFailure(logger, requestId, input.sessionId, finalError);
        restoreBatch();
        return Result.err(requestPublishRoutingError(finalError));
      }
      const extraValue = extra.match({ ok: (value) => value, err: () => null });
      if (!extraValue) continue;
      extraCompositions.push(extraValue);
      chainMessageIds.add(item.msgRef.messageId);
    }

    let baseInsertAt = composition.messages.length;
    const finalMessages = (() => {
      const extraMessages = extraCompositions.flatMap((extra) => extra.messages);
      if (extraMessages.length === 0) return composition.messages;

      for (let i = composition.messages.length - 1; i >= 0; i--) {
        if (composition.messages[i]?.role === "user") {
          baseInsertAt = i;
          break;
        }
      }

      if (baseInsertAt === composition.messages.length) {
        return [...composition.messages, ...extraMessages];
      }

      return [
        ...composition.messages.slice(0, baseInsertAt),
        ...extraMessages,
        ...composition.messages.slice(baseInsertAt),
      ];
    })();
    const finalLineage = (() => {
      if (extraCompositions.length === 0) return composition.corePrimaryLineage;
      if (
        composition.corePrimaryLineage.state !== "complete" ||
        extraCompositions.some((extra) => extra.corePrimaryLineage.state !== "complete")
      ) {
        return createFreshOnlyLineage(
          "deferred-batch-incomplete-lineage",
          Math.min(baseInsertAt, composition.corePrimaryLineage.currentCanonicalStart),
        );
      }
      const baseSegments = composition.corePrimaryLineage.segments;
      const insertSegmentIndex =
        baseInsertAt === composition.messages.length
          ? baseSegments.length
          : baseSegments.findIndex((segment) => segment.canonicalStart === baseInsertAt);
      if (insertSegmentIndex < 0) {
        return createFreshOnlyLineage(
          "deferred-batch-unaligned-insertion",
          composition.corePrimaryLineage.currentCanonicalStart,
        );
      }
      const extraSegments = extraCompositions.flatMap((extra) =>
        extra.corePrimaryLineage.state === "complete" ? extra.corePrimaryLineage.segments : [],
      );
      const combinedSegments = [
        ...baseSegments.slice(0, insertSegmentIndex),
        ...extraSegments,
        ...baseSegments.slice(insertSegmentIndex),
      ];
      const baseCurrentSegment = baseSegments.findIndex(
        (segment) =>
          segment.canonicalStart === composition.corePrimaryLineage.currentCanonicalStart,
      );
      const currentSegmentIndex = Math.min(
        insertSegmentIndex,
        baseCurrentSegment < 0
          ? insertSegmentIndex
          : baseCurrentSegment +
              (insertSegmentIndex <= baseCurrentSegment ? extraSegments.length : 0),
      );
      const built = buildCoreLineageManifestV2(
        combinedSegments.map((segment) => ({
          atoms: segment.atoms,
          canonicalMessages: segment.canonicalMessages,
          ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
        })),
        { currentSegmentIndex },
      );
      return built.match({
        ok: (value) => value,
        err: () =>
          createFreshOnlyLineage(
            "deferred-batch-lineage-build-failed",
            composition.corePrimaryLineage.currentCanonicalStart,
          ),
      });
    })();

    const published = await publishBusRequest({
      requestDeliveryId,
      requestId,
      sessionId: input.sessionId,
      sessionConfigId: batch.sessionConfigId,
      parentChannelId: batch.parentChannelId,
      queue: "prompt",
      triggerType: "reply",
      sessionMode: batch.sessionMode,
      modelOverride: batch.modelOverride,
      messages: finalMessages,
      inputHandles: [
        ...composition.inputHandles,
        ...extraCompositions.flatMap((value) => value.inputHandles),
      ],
      corePrimaryLineage: finalLineage,
      originMessage,
      raw: {
        triggerType: "reply",
        chainMessageIds: [...chainMessageIds],
        mergedGroups: composition.mergedGroups,
        participantUserIds: uniqueParticipantUserIds({
          values: [
            ...composition.mergedGroups.map((group) => group.authorId),
            ...batchParticipantUserIds,
          ],
          exclude: self.userId,
        }),
        pendingMentionReplyBatch: {
          sourceRequestId: batch.sourceRequestId,
          size: batch.items.length,
        },
      },
    });
    const publishError = published.match({ ok: () => null, err: (error) => error });
    if (publishError) restoreBatch();
    return published;
  }

  async function handleActiveDmMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    sessionId: string;
    msgRef: MsgRef;
    ingressMessage: SurfaceMessage;
    userId: string;
    userText: string;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      sessionId,
      msgRef,
      ingressMessage,
      userText,
      userId: _userId,
      mentionsBot,
      replyToBot,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    if (active && requestModelOverride) {
      return publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        }),
        sessionId,
        triggerMsgRef: msgRef,
        ingressMessages: [ingressMessage],
        triggerType: resolveTriggerType({ replyToBot, mentionsBot }),
        sessionMode,
        sessionConfigId,
        modelOverride: requestModelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: false,
      });
    }

    if (active) {
      // While a request is running:
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          const steerMode = parseSteerDirectiveMode({
            text: userText,
            botNames: botMentionNames,
          });

          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
            mode: steerMode,
          });
          active.activeOutputMessageIds.clear();

          return publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: steerMode,
            msgRef,
            ingressMessage,
            sessionMode,
            sessionConfigId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
              steerMode === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
            ),
          });
        }

        return publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "followUp",
          msgRef,
          ingressMessage,
          sessionMode,
          sessionConfigId,
          modelOverride,
          transformUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
          ),
        });
      }

      if (replyToBot) {
        const requestId = formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        });

        return publishActiveChannelPrompt({
          adapter,
          bus,
          cfg,
          requestId,
          sessionId,
          triggerMsgRef: msgRef,
          ingressMessages: [ingressMessage],
          triggerType: "reply",
          sessionMode,
          sessionConfigId,
          modelOverride,
          botMentionNames,
          transformTriggerUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
          ),
          transformUserTextForMessageId: msgRef.messageId,
          markActive: false,
        });
      }

      return publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: active.requestId,
        sessionId,
        queue: "followUp",
        msgRef,
        ingressMessage,
        sessionMode,
        sessionConfigId,
        modelOverride,
        transformUserText: continueDirectiveTransform,
      });
    }

    const requestId = formatDiscordMessageRequestId({
      channelId: sessionId,
      messageId: msgRef.messageId,
    });

    const triggerType = resolveTriggerType({ replyToBot, mentionsBot });

    // DMs are ungated: start a new request immediately.
    return publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      triggerMsgRef: msgRef,
      ingressMessages: [ingressMessage],
      triggerType,
      sessionMode,
      sessionConfigId,
      modelOverride,
      botMentionNames,
      transformTriggerUserText: combineTextTransforms(
        modelOverrideTransform,
        continueDirectiveTransform,
      ),
      transformUserTextForMessageId: msgRef.messageId,
      markActive: true,
    });
  }

  async function handleActiveChannelMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    buffers: Map<string, DebounceBuffer>;
    sessionId: string;
    msgRef: MsgRef;
    ingressMessage: SurfaceMessage;
    userId: string;
    userText: string;
    messageTs: number;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    botUserId?: string;
    parentChannelId?: string;
    guildId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      buffers,
      sessionId,
      msgRef,
      ingressMessage,
      userId,
      userText,
      messageTs,
      mentionsBot,
      replyToBot,
      botUserId,
      parentChannelId,
      guildId,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;
    const hasReplyTarget =
      typeof input.replyToMessageId === "string" && input.replyToMessageId.trim().length > 0;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    if (active && requestModelOverride) {
      return publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: formatDiscordMessageRequestId({
          channelId: sessionId,
          messageId: msgRef.messageId,
        }),
        sessionId,
        triggerMsgRef: msgRef,
        ingressMessages: [ingressMessage],
        triggerType: resolveTriggerType({ replyToBot, mentionsBot }),
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride: requestModelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: false,
      });
    }

    if (active) {
      // Active channels behave like group chats while a request is running.
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Mentions (not replies) can steer the active request (plus output reanchor).
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const routeDecision = decideActiveRequestRoute({
        activeOutputMessageIds: active.activeOutputMessageIds,
        replyToBot,
        mentionsBot,
        replyToMessageId: input.replyToMessageId,
        userText,
        botMentionNames,
        allowMentionSteer: true,
        plainMessageBehavior: "buffered_prompt",
      });

      switch (routeDecision.kind) {
        case "active_output_steer":
        case "active_mention_steer": {
          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: routeDecision.inheritReplyTo,
            ...(routeDecision.inheritReplyTo ? {} : { replyTo: msgRef }),
            mode: routeDecision.queue,
          });
          active.activeOutputMessageIds.clear();

          return publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: routeDecision.queue,
            msgRef,
            ingressMessage,
            sessionMode,
            sessionConfigId,
            parentChannelId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
              routeDecision.queue === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
            ),
          });
        }
        case "active_output_follow_up":
        case "plain_follow_up": {
          return publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: "followUp",
            msgRef,
            ingressMessage,
            sessionMode,
            sessionConfigId,
            parentChannelId,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
          });
        }
        case "fork_reply_prompt": {
          const requestId = formatDiscordMessageRequestId({
            channelId: sessionId,
            messageId: msgRef.messageId,
          });

          return publishActiveChannelPrompt({
            adapter,
            bus,
            cfg,
            requestId,
            sessionId,
            triggerMsgRef: msgRef,
            ingressMessages: [ingressMessage],
            triggerType: "reply",
            sessionMode,
            sessionConfigId,
            parentChannelId,
            botMentionNames,
            transformTriggerUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
            transformUserTextForMessageId: msgRef.messageId,
            modelOverride,
            markActive: false,
          });
        }
        case "buffered_prompt": {
          return publishSingleMessagePrompt({
            adapter,
            bus,
            cfg,
            requestId: bufferedPromptRequestIdForActiveRequest(active.requestId),
            sessionId,
            sessionConfigId,
            parentChannelId,
            msgRef,
            ingressMessage,
            sessionMode,
            modelOverride,
            transformUserText: combineTextTransforms(
              modelOverrideTransform,
              continueDirectiveTransform,
            ),
            raw: {
              bufferedForActiveRequestId: active.requestId,
            },
          });
        }
      }
    }

    // No active request.
    if (continueCount !== undefined && !mentionsBot && !replyToBot && !hasReplyTarget) {
      clearDebounceBuffer(sessionId);

      return publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId: randomRequestId(),
        sessionId,
        triggerMsgRef: msgRef,
        ingressMessages: [ingressMessage],
        triggerType: undefined,
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: true,
      });
    }

    if (mentionsBot || replyToBot) {
      // Mention/reply is a bypass trigger.
      // Discard any pending buffer to avoid a second gated request for the same context.
      clearDebounceBuffer(sessionId);

      const triggerType: "mention" | "reply" = replyToBot ? "reply" : "mention";
      const requestId = formatDiscordMessageRequestId({
        channelId: sessionId,
        messageId: msgRef.messageId,
      });

      return publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        triggerMsgRef: msgRef,
        ingressMessages: [ingressMessage],
        triggerType,
        sessionMode,
        sessionConfigId,
        parentChannelId,
        modelOverride,
        botMentionNames,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
        markActive: true,
      });
    }

    bufferActiveChannelMessage({
      buffers,
      cfg,
      sessionId,
      sessionConfigId,
      parentChannelId,
      guildId,
      message: {
        msgRef,
        ingressMessage,
        userId,
        text: userText,
        ts: messageTs,
        mentionsBot,
        replyToBot,
        botUserId,
        sessionModelOverride: modelOverride,
        requestModelOverride,
      },
    });
  }

  function bufferActiveChannelMessage(input: {
    buffers: Map<string, DebounceBuffer>;
    cfg: CoreConfig;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    guildId?: string;
    message: BufferedMessage;
  }) {
    const { buffers, cfg, sessionId, sessionConfigId, parentChannelId, guildId, message } = input;

    const existing = buffers.get(sessionId);
    if (!existing) {
      logger.debug("router debounce start", {
        sessionId,
        debounceMs: cfg.surface.router.activeDebounceMs,
      });

      const buffer: DebounceBuffer = {
        sessionId,
        sessionConfigId,
        parentChannelId,
        guildId,
        messages: [message],
        timer: null,
      };

      buffer.timer = setTimeout(() => {
        void runDebounceTimer(sessionId);
      }, cfg.surface.router.activeDebounceMs);

      buffers.set(sessionId, buffer);
      return;
    }

    existing.messages.push(message);
  }

  async function runDebounceTimer(sessionId: string): Promise<void> {
    const flushed = await captureRouterDebounceFlush({
      sessionId,
      operation: () => flushDebounce(sessionId),
      reportFatalPanic: debounceDefect.reject,
    });
    flushed.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () =>
        logger.error(
          "router flushDebounce failed",
          formatBridgeTaggedErrorForLog(error, { sessionId }),
        ),
    })();
  }

  async function flushDebounce(sessionId: string): Promise<void> {
    const b = buffers.get(sessionId);
    if (!b) return;
    clearDebounceBuffer(sessionId);

    // Gate is only for active channels with no running request.
    const gateEnabled = resolveSessionGateEnabled(cfg, b.sessionId, b.parentChannelId, b.guildId);
    const previousMessageText = gateEnabled
      ? await resolvePreviousBatchMessageText(b.messages)
      : undefined;

    let decision: RouterGateDecision = { forward: true, reason: "disabled" };
    if (gateEnabled) {
      const evaluated = await captureRouterActiveBatchGate(sessionId, () =>
        evaluateRouterGate({
          sessionId,
          botName: cfg.surface.discord.botName,
          messages: b.messages,
          context: {
            mode: "active-batch",
            previousMessageText,
          },
        }),
      );
      decision = evaluated.match<() => RouterGateDecision>({
        ok: (value) => () => value,
        err: (error) => () => {
          logger.error(
            "router gate failed; skipping",
            formatBridgeTaggedErrorForLog(error, {
              sessionId,
              ...extractAiErrorLogDetails(error.cause),
            }),
          );
          return { forward: false, reason: "error" };
        },
      })();
    }

    if (!decision.forward) {
      logger.info(
        "router.route.decision",
        formatBridgeLogContext({
          sessionId,
          mode: "active",
          gateEnabled,
          decision: "skip",
          reason: `active_batch_gate:${decision.reason ?? "skip"}`,
          messageCount: b.messages.length,
        }),
      );
      return;
    }

    logger.info(
      "router.route.decision",
      formatBridgeLogContext({
        sessionId,
        mode: "active",
        gateEnabled,
        decision: "forward",
        reason: `active_batch_gate:${decision.reason ?? "forward"}`,
        messageCount: b.messages.length,
      }),
    );

    const overrideCarrier = (() => {
      for (let i = b.messages.length - 1; i >= 0; i--) {
        const requestOverride = b.messages[i]?.requestModelOverride;
        if (requestOverride) {
          const messageId = b.messages[i]?.msgRef.messageId;
          if (messageId) {
            return {
              model: requestOverride,
              messageId,
              botUserId: b.messages[i]?.botUserId,
            };
          }
          return {
            model: requestOverride,
            messageId: undefined,
            botUserId: b.messages[i]?.botUserId,
          };
        }
      }
      return undefined;
    })();
    const modelOverride =
      overrideCarrier?.model ?? b.messages[b.messages.length - 1]?.sessionModelOverride;
    const self = await adapter.getSelf();
    const newestBufferedMessage = b.messages[b.messages.length - 1];

    // Gate-forwarded prompt: do NOT reply-to a message.
    // Use newest message as the context anchor.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId: randomRequestId(),
      sessionId,
      sessionConfigId: b.sessionConfigId,
      parentChannelId: b.parentChannelId,
      // Use newest message as the context anchor (not a reply trigger).
      triggerMsgRef: newestBufferedMessage?.msgRef,
      ingressMessages: b.messages.flatMap((message) =>
        message.ingressMessage ? [message.ingressMessage] : [],
      ),
      currentMessageIds: b.messages.map((message) => message.msgRef.messageId),
      triggerType: undefined,
      sessionMode: "active",
      modelOverride,
      botMentionNames: resolveBotMentionNames({
        cfg,
        botUserId:
          overrideCarrier?.botUserId ?? b.messages[b.messages.length - 1]?.botUserId ?? self.userId,
      }),
      transformTriggerUserText: overrideCarrier
        ? (text: string) =>
            stripLeadingModelOverrideDirective({
              text,
              botNames: resolveBotMentionNames({ cfg, botUserId: overrideCarrier?.botUserId }),
            })
        : undefined,
      transformUserTextForMessageId: overrideCarrier?.messageId,
      markActive: true,
    });
  }

  async function handleMentionMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    activeBySession: Map<string, ActiveSessionState>;
    sessionId: string;
    msgRef: MsgRefFor<"discord">;
    ingressMessage: SurfaceMessage;
    userText: string;
    mentionsBot?: boolean;
    replyToBot?: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    parentChannelId?: string;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    continueCount?: number;
    botMentionNames: readonly string[];
  }): Promise<ResultType<void, BusRequestRouterRoutingError>> {
    const {
      adapter,
      bus,
      cfg,
      activeBySession,
      sessionId,
      msgRef,
      ingressMessage,
      userText,
      mentionsBot,
      replyToBot,
      active,
      parentChannelId,
      requestModelOverride,
      continueCount,
      botMentionNames,
    } = input;

    const modelOverrideTransform = requestModelOverride
      ? (text: string) =>
          stripLeadingModelOverrideDirective({
            text,
            botNames: botMentionNames,
          })
      : undefined;
    const continueDirectiveTransform = stripCurrentContinueDirective({
      text: userText,
      botNames: botMentionNames,
      continueCount,
    });

    const triggerType = resolveTriggerType({ replyToBot, mentionsBot }) ?? null;

    if (!triggerType) {
      // Mention-only channels: ignore non-triggers (even if a request is active).
      logger.debug("router.route.decision", {
        sessionId,
        mode: input.sessionMode,
        gateEnabled: false,
        decision: "skip",
        reason: "mention_mode_non_trigger",
        activeRequestId: active?.requestId,
      });
      return Result.ok(undefined);
    }

    const requestId = formatDiscordMessageRequestId({
      channelId: sessionId,
      messageId: msgRef.messageId,
    });

    if (active && requestModelOverride) {
      return publishComposedRequest({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        queue: "prompt",
        triggerType,
        msgRef,
        ingressMessages: [ingressMessage],
        sessionMode: input.sessionMode,
        sessionConfigId: input.sessionConfigId,
        parentChannelId,
        modelOverride: requestModelOverride,
        transformTriggerUserText: combineTextTransforms(
          modelOverrideTransform,
          continueDirectiveTransform,
        ),
        transformUserTextForMessageId: msgRef.messageId,
      });
    }

    // Special case: if the user is replying to the currently active output message chain,
    // treat mention replies as steer/interrupt into the running request, and
    // queue plain replies into a deferred prompt batch.
    if (
      active &&
      replyToBot &&
      typeof input.replyToMessageId === "string" &&
      active.activeOutputMessageIds.has(input.replyToMessageId)
    ) {
      if (mentionsBot) {
        const steerMode = parseSteerDirectiveMode({
          text: userText,
          botNames: botMentionNames,
        });

        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: false,
          replyTo: msgRef,
          mode: steerMode,
        });
        active.activeOutputMessageIds.clear();

        const published = await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: steerMode,
          msgRef,
          ingressMessage,
          sessionMode: input.sessionMode,
          sessionConfigId: input.sessionConfigId,
          parentChannelId,
          modelOverride: input.modelOverride,
          transformUserText: combineTextTransforms(
            modelOverrideTransform,
            continueDirectiveTransform,
            steerMode === "interrupt"
              ? (text) =>
                  stripLeadingInterruptDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : undefined,
          ),
        });
        const publishError = published.match({ ok: () => null, err: (error) => error });
        if (publishError) return Result.err(publishError);

        return flushPendingMentionReplyBatchAsFollowUp({
          sessionId,
          sourceRequestId: active.requestId,
        });
      }
      return enqueuePendingMentionReplyBatch({
        sessionId,
        sourceRequestId: active.requestId,
        sessionConfigId: input.sessionConfigId,
        parentChannelId,
        sessionMode: input.sessionMode,
        modelOverride: input.modelOverride,
        item: {
          msgRef,
          ingressMessage,
          requestModelOverride,
          continueCount,
          botMentionNames,
        },
      });
    }

    if (!active) {
      // Optimistically mark active to avoid a brief window before lifecycle updates.
      activeBySession.set(sessionId, {
        requestId,
        activeOutputMessageIds: new Set(),
      });
    }

    // Triggers always start a new request. If a request is running, the runner will queue it.
    return publishComposedRequest({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      queue: "prompt",
      triggerType,
      msgRef,
      ingressMessages: [ingressMessage],
      sessionMode: input.sessionMode,
      sessionConfigId: input.sessionConfigId,
      parentChannelId,
      modelOverride: input.modelOverride,
      transformTriggerUserText: combineTextTransforms(
        modelOverrideTransform,
        continueDirectiveTransform,
      ),
      transformUserTextForMessageId: msgRef.messageId,
    });
  }

  async function publishBusRequest(input: PublishBusRequestInput) {
    const published = await publishBusRequestImpl({
      logger,
      blobStore: params.blobStore,
      requestDelivery: params.requestDelivery,
      input,
    });
    published.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () =>
        logDiscordRequestPublishFailure(logger, input.requestId, input.sessionId, error),
    })();
    return published.mapError(requestPublishRoutingError);
  }

  type PublishComposedLocalInput = Parameters<typeof publishComposedRequestImpl>[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishComposedRequest(input: PublishComposedLocalInput) {
    const { adapter, bus: _bus, cfg, ...requestInput } = input;
    const published = await publishComposedRequestImpl({
      adapter,
      cfg,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      messageCache: params.messageCache,
      requestDelivery: params.requestDelivery,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
    published.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () =>
        logDiscordRequestPublishFailure(logger, input.requestId, input.sessionId, error),
    })();
    return published.mapError(requestPublishRoutingError);
  }

  type PublishActiveChannelPromptLocalInput = Parameters<
    typeof publishActiveChannelPromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    markActive: boolean;
  };

  async function publishActiveChannelPrompt(input: PublishActiveChannelPromptLocalInput) {
    const { adapter, bus: _bus, cfg, markActive, ...requestInput } = input;
    const published = await publishActiveChannelPromptImpl({
      adapter,
      cfg,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      messageCache: params.messageCache,
      requestDelivery: params.requestDelivery,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
    const publishError = published.match({ ok: () => null, err: (error) => error });
    if (publishError) {
      logDiscordRequestPublishFailure(logger, input.requestId, input.sessionId, publishError);
      return Result.err(requestPublishRoutingError(publishError));
    }
    if (markActive) {
      activeBySession.set(input.sessionId, {
        requestId: input.requestId,
        activeOutputMessageIds: new Set(),
      });
    }
    return Result.ok(undefined);
  }

  type PublishSingleMessageToActiveRequestLocalInput = Parameters<
    typeof publishSingleMessageToActiveRequestImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessageToActiveRequest(
    input: PublishSingleMessageToActiveRequestLocalInput,
  ) {
    const { adapter, bus: _bus, cfg, ...requestInput } = input;
    const published = await publishSingleMessageToActiveRequestImpl({
      adapter,
      cfg,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      messageCache: params.messageCache,
      requestDelivery: params.requestDelivery,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
    published.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () =>
        logDiscordRequestPublishFailure(logger, input.requestId, input.sessionId, error),
    })();
    return published.mapError(requestPublishRoutingError);
  }

  type PublishSingleMessagePromptLocalInput = Parameters<
    typeof publishSingleMessagePromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessagePrompt(input: PublishSingleMessagePromptLocalInput) {
    const { adapter, bus: _bus, cfg, ...requestInput } = input;
    const published = await publishSingleMessagePromptImpl({
      adapter,
      cfg,
      blobStore: params.blobStore,
      resourceRegistry: params.resourceRegistry,
      attachmentCache: params.attachmentCache,
      messageCache: params.messageCache,
      requestDelivery: params.requestDelivery,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
    published.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () =>
        logDiscordRequestPublishFailure(logger, input.requestId, input.sessionId, error),
    })();
    return published.mapError(requestPublishRoutingError);
  }

  async function publishSurfaceOutputReanchor(
    input: Parameters<typeof publishSurfaceOutputReanchorImpl>[0],
  ) {
    await publishSurfaceOutputReanchorImpl(input);
  }

  const subscriptions = startedSubscriptions;
  const done = Promise.race([
    superviseRouterSubscriptionsDone(subscriptions),
    debounceDefect.promise,
  ]);

  return {
    kind: "result",
    residualRouter: null,
    result: Result.ok({
      done,
      stop: async () => {
        await adaptRouterSubscriptionsStop(subscriptions).finally(() => {
          for (const b of buffers.values()) {
            if (b.timer) clearTimeout(b.timer);
          }
          buffers.clear();
          pendingMentionReplyBatchBySession.clear();
        });
      },
    }),
  };
}
