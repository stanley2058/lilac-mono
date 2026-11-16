import {
  Err,
  Ok,
  Panic,
  Result,
  TaggedError,
  type AnyTaggedError,
  type Result as ResultType,
} from "better-result";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import type { RawBus } from "./raw-bus";
import type {
  Cursor,
  FetchOptions,
  OutputStreamExpiry,
  RedisMessageDecodeFailure,
  RequestPublicationClaim,
  RequestPublicationClaimAbandonment,
  RequestPublicationClaimAcquisition,
  RequestPublicationConfirmation,
  SubscriptionOptions,
} from "./types";
import {
  createContractInvalidDeadLetterReason,
  createHandlerErrorDeadLetterReason,
  redisDecodeIssuesForDeadLetter,
} from "./event-dead-letter";
import type { RedisEventDeadLetter } from "./redis-event-dead-letter";
import {
  applyEventDeliveryPolicy,
  EventBusCloseFailed,
  EventContractInvalid,
  type EventDeliveryDoneError,
  EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  EventFetchContractInvalid,
  EventFetchTransportFailed,
  EventOutputStreamExpiryUnavailable,
  EventPublishContractInvalid,
  EventPublishTransportFailed,
  EventPostCommitObservationFailed,
  EventRequestPublicationClaimFailed,
  EventRequestPublicationClaimFenced,
  EventRequestPublicationClaimUnsupported,
  EventRequestPublicationConfirmationFailed,
  EventRequestPublicationConfirmationUnsupported,
  EventTopicOperationFailed,
  EventTopicOperationUnsupported,
  type DeliveryDisposition,
  type EventDeliveryContext,
  type EventDeliveryFatalReporter,
  type EventDeliveryLogger,
  type RawDeliveryAction,
} from "./event-delivery";
import {
  decodeLilacMessage,
  decodeLilacMessageForTopic,
  lilacEventCodecRegistry,
  type DecodedLilacMessage,
  type LilacEventDecodeError,
} from "./lilac-codecs";
import { panic as signalEventBusPanic } from "./redis-managed-delivery";
import {
  lilacEventTypes,
  outReqTopic,
  type AdapterPlatform,
  type LilacDataForType,
  type LilacEventType,
  type LilacEventTypesForTopic,
  type LilacTopic,
  type LilacTopicForType,
} from "./lilac-spec";

/**
 * Canonical request-scoped envelope headers.
 *
 * These are optional at the type level because adapter ingestion events may not
 * be tied to a request. For request/workflow/output events, publishers should
 * treat missing `request_id` as an error.
 */
export type LilacEnvelopeHeaders = {
  request_id?: string;
  session_id?: string;
  request_client?: AdapterPlatform;
};

/** Discriminated union of all events that may appear on `TTopic`. */
export type LilacMessageForTopic<TTopic extends LilacTopic> = DecodedLilacMessage<
  LilacEventTypesForTopic<TTopic>
>;

export type DecodedLilacMessageForTopic<TTopic extends LilacTopic> = DecodedLilacMessage<
  LilacEventTypesForTopic<TTopic>
>;

export type CreateLilacBusOptions = {
  readonly deadLetter?: RedisEventDeadLetter;
  readonly logger?: EventDeliveryLogger;
  readonly reportFatal?: EventDeliveryFatalReporter;
  /** Called only after Redis durably commits a managed delivery. */
  readonly postCommitObserver?: {
    observe(
      message: DecodedLilacMessage,
      context: Extract<EventDeliveryContext, { mode: "work" | "fanout" }>,
    ): Promise<ResultType<void, EventPostCommitObservationFailed>>;
  };
};

const KNOWN_EVENT_TYPES = new Set<string>(Object.values(lilacEventTypes));

type CapturedLilacBusFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary"; readonly restoreCause: () => unknown };

type LilacBusFailureSettlement = () => CapturedLilacBusFailure;

function captureLilacBusFailure(cause: unknown): LilacBusFailureSettlement {
  return () => {
    const inspected = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspected.match({
      ok: (value) => value,
      err: () => undefined,
    });
    return panic ? { kind: "panic", panic } : { kind: "ordinary", restoreCause: () => cause };
  };
}

function settleLilacBusCapture<T>(
  result: ResultType<T, LilacBusFailureSettlement>,
): ResultType<T, CapturedLilacBusFailure> {
  return result.mapError((settle) => settle());
}

function lilacBusOutcome<T, E>(
  result: ResultType<T, E>,
): { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly error: E } {
  return result.match<
    { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly error: E }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
}

function requireRequestId(
  headers: LilacEnvelopeHeaders | undefined,
  eventType: LilacEventType,
): ResultType<string, EventPublishContractInvalid> {
  const requestId = headers?.request_id;
  if (!requestId) {
    return Result.err(
      new EventPublishContractInvalid({
        eventType,
        message: `publish(${eventType}) requires headers.request_id`,
      }),
    );
  }
  return Result.ok(requestId);
}

function getTopicForType<TType extends LilacEventType>(
  type: TType,
  headers: LilacEnvelopeHeaders | undefined,
): ResultType<LilacTopicForType<TType>, EventPublishContractInvalid> {
  const codec = lilacEventCodecRegistry[type];
  if (!codec.requiresRequestId) return Result.ok(codec.resolveTopic(""));
  return requireRequestId(headers, type).map((requestId) => codec.resolveTopic(requestId));
}

function getKeyForType<TType extends LilacEventType>(
  type: TType,
  headers: LilacEnvelopeHeaders | undefined,
  data: LilacDataForType<TType>,
): ResultType<string | undefined, EventPublishContractInvalid> {
  const keySource = lilacEventCodecRegistry[type].keySource;
  if (keySource === "request_id") {
    return requireRequestId(headers, type);
  }
  const key: unknown = Reflect.get(data, keySource);
  return Result.ok(typeof key === "string" ? key : undefined);
}

function normalizeTransportInvalid(failure: RedisMessageDecodeFailure): EventContractInvalid {
  return new EventContractInvalid({
    source: "transport",
    stage: "transport",
    issues: redisDecodeIssuesForDeadLetter(failure.error.issues),
    message: "Invalid event transport envelope",
  });
}

function normalizeContractInvalid(error: LilacEventDecodeError): EventContractInvalid {
  return new EventContractInvalid({
    source: "contract",
    stage: error.stage,
    eventType: error.eventType,
    issues: error.issues,
    message: "Invalid Lilac event contract",
  });
}

function logContractInvalid(
  logger: EventDeliveryLogger | undefined,
  topic: LilacTopic,
  cursor: Cursor,
  error: EventContractInvalid,
): void {
  let eventType: string | undefined;
  if (error.eventType !== undefined) {
    eventType = KNOWN_EVENT_TYPES.has(error.eventType) ? error.eventType : "<unknown>";
  }
  logger?.warn("event_bus.contract_invalid", {
    topic,
    cursor,
    source: error.source,
    stage: error.stage,
    eventType,
  });
}

function checkedDisposition(value: DeliveryDisposition): DeliveryDisposition {
  switch (value) {
    case "commit":
    case "retry":
    case "park-pending":
    case "dead-letter":
    case "stop":
      return value;
    default: {
      const unhandled: never = value;
      throw new Panic({
        message: `Event delivery policy returned an unknown disposition: ${String(unhandled)}`,
      });
    }
  }
}

function checkedHandlerResult<TError extends AnyTaggedError>(
  value: ResultType<void, TError>,
): ResultType<void, TError> {
  if (value instanceof Ok && Object.getPrototypeOf(value) === Ok.prototype) {
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const payload = Object.getOwnPropertyDescriptor(value, "value");
    if (
      status === undefined ||
      !("value" in status) ||
      status.value !== "ok" ||
      payload === undefined ||
      !("value" in payload) ||
      payload.value !== undefined
    ) {
      return signalEventBusPanic(
        new Panic({
          message: "Event handler returned an incomplete Ok<void> Result",
        }),
      );
    }
    return value;
  }

  if (value instanceof Err && Object.getPrototypeOf(value) === Err.prototype) {
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const error = Object.getOwnPropertyDescriptor(value, "error");
    if (
      status === undefined ||
      !("value" in status) ||
      status.value !== "error" ||
      error === undefined ||
      !("value" in error)
    ) {
      return signalEventBusPanic(
        new Panic({
          message: "Event handler returned an incomplete Err Result",
        }),
      );
    }
    if (Panic.is(error.value)) return signalEventBusPanic(error.value);
    if (
      !TaggedError.is(error.value) ||
      !Object.hasOwn(error.value, "_tag") ||
      !Object.hasOwn(error.value, "name") ||
      !Object.hasOwn(error.value, "message") ||
      typeof error.value._tag !== "string" ||
      typeof error.value.name !== "string" ||
      typeof error.value.message !== "string"
    ) {
      return signalEventBusPanic(
        new Panic({
          message: "Event handler returned an incomplete Err Result",
        }),
      );
    }
    return value;
  }

  return signalEventBusPanic(
    new Panic({
      message: "Event handler returned a forged or malformed Result",
    }),
  );
}

/**
 * Typed bus API for the Lilac monorepo.
 *
 * This enforces event payload types based on `lilacEventTypes`.
 */
export interface LilacBus {
  /** Publish a typed event and return its id/cursor. */
  publish<TType extends LilacEventType>(
    type: TType,
    data: LilacDataForType<TType>,
    options?: {
      /** Optional metadata (string->string). */
      headers?: Record<string, string> & Partial<LilacEnvelopeHeaders>;
      /** Override the default routing topic (advanced). */
      topic?: LilacTopicForType<TType>;
      /** Override the default correlation key (advanced). */
      key?: string;
    },
  ): Promise<
    ResultType<
      {
        id: string;
        cursor: Cursor;
        topic: LilacTopicForType<TType>;
        duplicate?: boolean;
        replayDeadline?: number;
      },
      EventPublishContractInvalid | EventPublishTransportFailed
    >
  >;

  acquireRequestPublicationClaim(
    requestDeliveryId: string,
  ): Promise<
    ResultType<
      RequestPublicationClaimAcquisition,
      EventRequestPublicationClaimUnsupported | EventRequestPublicationClaimFailed
    >
  >;

  publishClaimedRequest(
    data: LilacDataForType<typeof lilacEventTypes.CmdRequestMessage>,
    claim: RequestPublicationClaim,
    options?: {
      headers?: Record<string, string> & Partial<LilacEnvelopeHeaders>;
      topic?: LilacTopicForType<typeof lilacEventTypes.CmdRequestMessage>;
      key?: string;
    },
  ): Promise<
    ResultType<
      {
        id: string;
        cursor: Cursor;
        topic: LilacTopicForType<typeof lilacEventTypes.CmdRequestMessage>;
        duplicate?: boolean;
      },
      | EventPublishContractInvalid
      | EventPublishTransportFailed
      | EventRequestPublicationClaimFenced
      | EventRequestPublicationClaimUnsupported
    >
  >;

  /** Confirm the recorded stream id under the exact live publication claim. */
  confirmRequestPublication(
    claim: RequestPublicationClaim,
    expectedStreamId: string,
  ): Promise<
    ResultType<
      RequestPublicationConfirmation,
      EventRequestPublicationConfirmationUnsupported | EventRequestPublicationConfirmationFailed
    >
  >;

  abandonRequestPublicationClaim(
    claim: RequestPublicationClaim,
  ): Promise<
    ResultType<
      RequestPublicationClaimAbandonment,
      EventRequestPublicationClaimUnsupported | EventRequestPublicationClaimFailed
    >
  >;

  /** Read the Redis-owned absolute replay expiry for a request output stream. */
  getOutputStreamExpiry(
    requestId: string,
  ): Promise<ResultType<OutputStreamExpiry, EventOutputStreamExpiryUnavailable>>;

  subscribeTopic<TTopic extends LilacTopic, TError extends AnyTaggedError>(
    topic: TTopic,
    opts: SubscriptionOptions,
    handler: (
      msg: DecodedLilacMessageForTopic<TTopic>,
      ctx: EventDeliveryContext,
    ) => Promise<ResultType<void, TError>>,
    deliveryPolicy: (error: TError) => DeliveryDisposition,
  ): Promise<
    ResultType<
      {
        readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
        stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
      },
      EventDeliveryStartFailed
    >
  >;

  /** Fetch and decode a complete batch without exposing invalid entries as typed messages. */
  fetchTopic<TTopic extends LilacTopic>(
    topic: TTopic,
    opts: FetchOptions,
  ): Promise<
    ResultType<
      {
        messages: Array<{
          msg: DecodedLilacMessageForTopic<TTopic>;
          cursor: Cursor;
        }>;
        next?: Cursor;
      },
      EventFetchContractInvalid | EventFetchTransportFailed
    >
  >;

  /** Return the latest durable cursor currently present on a topic. */
  getTopicWatermark(
    topic: LilacTopic,
  ): Promise<ResultType<Cursor | null, EventTopicOperationUnsupported | EventTopicOperationFailed>>;

  /** Reclaim a processed prefix while retaining a safety margin behind all durable frontiers. */
  trimTopicBeforeCheckpoint(
    topic: LilacTopic,
    checkpoint: Cursor,
    safetyMargin: number,
  ): Promise<ResultType<number, EventTopicOperationUnsupported | EventTopicOperationFailed>>;

  /** Remove a retired durable consumer group after checking for registered old-version consumers. */
  retireTopicConsumerGroup(
    topic: LilacTopic,
    group: string,
    confirmSingleVersionRollout?: boolean,
  ): Promise<
    ResultType<"absent" | "destroyed", EventTopicOperationUnsupported | EventTopicOperationFailed>
  >;

  /** Close the underlying transport. */
  close(): Promise<ResultType<void, EventBusCloseFailed>>;
}

/** Wrap a `RawBus` with the Lilac typed event spec. */
export function createLilacBus(raw: RawBus, options: CreateLilacBusOptions = {}): LilacBus {
  const bus: LilacBus = {
    publish: async <TType extends LilacEventType>(
      type: TType,
      data: LilacDataForType<TType>,
      options?: {
        headers?: Record<string, string> & Partial<LilacEnvelopeHeaders>;
        topic?: LilacTopicForType<TType>;
        key?: string;
      },
    ) => {
      let topic = options?.topic;
      if (topic === undefined) {
        const resolvedTopic = getTopicForType(type, options?.headers).match<
          LilacTopicForType<TType> | EventPublishContractInvalid
        >({
          ok: (value) => value,
          err: (error) => error,
        });
        if (EventPublishContractInvalid.is(resolvedTopic)) return Result.err(resolvedTopic);
        topic = resolvedTopic;
      }
      let key = options?.key;
      if (key === undefined) {
        const resolvedKey = getKeyForType(type, options?.headers, data).match<
          string | undefined | EventPublishContractInvalid
        >({
          ok: (value) => value,
          err: (error) => error,
        });
        if (EventPublishContractInvalid.is(resolvedKey)) return Result.err(resolvedKey);
        key = resolvedKey;
      }

      const validated = decodeLilacMessage({
        topic,
        id: "publish-validation",
        type,
        ts: Date.now(),
        key,
        headers: options?.headers,
        data,
      });
      const validationError = validated.match({
        ok: () => undefined,
        err: (error) => error,
      });
      if (validationError !== undefined) {
        return Result.err(
          new EventPublishContractInvalid({
            eventType: type,
            message: `publish(${type}) failed ${validationError.stage} validation`,
          }),
        );
      }

      const published = settleLilacBusCapture(
        await Result.tryPromise({
          try: () =>
            raw.publish(
              {
                topic,
                type,
                key,
                headers: options?.headers,
                data,
              },
              {
                topic,
                type,
                key,
                headers: options?.headers,
              },
            ),
          catch: captureLilacBusFailure,
        }),
      );
      const publishOutcome = lilacBusOutcome(published);
      if (publishOutcome.kind === "error") {
        if (publishOutcome.error.kind === "panic") {
          throw publishOutcome.error.panic;
        }
        return Result.err(
          new EventPublishTransportFailed({
            cause: publishOutcome.error.restoreCause(),
            eventType: type,
            topic,
            message: "Event publish failed",
          }),
        );
      }
      const res = publishOutcome.value;

      return Result.ok({ ...res, topic });
    },

    acquireRequestPublicationClaim: async (requestDeliveryId) => {
      const acquire = raw.acquireRequestPublicationClaim?.bind(raw);
      if (acquire === undefined) {
        return Result.err(
          new EventRequestPublicationClaimUnsupported({
            operation: "acquire",
            message: "The configured raw bus does not support request publication claims",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => acquire(requestDeliveryId),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
      return Result.err(
        new EventRequestPublicationClaimFailed({
          cause: outcome.error.restoreCause(),
          operation: "acquire",
          requestDeliveryId,
          message: "Request publication claim acquisition failed",
        }),
      );
    },

    publishClaimedRequest: async (data, claim, options) => {
      const type = lilacEventTypes.CmdRequestMessage;
      if (data.requestDeliveryId !== claim.requestDeliveryId) {
        return Result.err(
          new EventPublishContractInvalid({
            eventType: type,
            message: "The request publication claim does not match data.requestDeliveryId",
          }),
        );
      }
      const topicResult = getTopicForType(type, options?.headers);
      const topicOutcome = lilacBusOutcome(topicResult);
      if (topicOutcome.kind === "error") return Result.err(topicOutcome.error);
      const topic = options?.topic ?? topicOutcome.value;
      const keyResult = getKeyForType(type, options?.headers, data);
      const keyOutcome = lilacBusOutcome(keyResult);
      if (keyOutcome.kind === "error") return Result.err(keyOutcome.error);
      const key = options?.key ?? keyOutcome.value;
      const validated = decodeLilacMessage({
        topic,
        id: "publish-validation",
        type,
        ts: Date.now(),
        key,
        headers: options?.headers,
        data,
      });
      const validationError = validated.match({
        ok: () => undefined,
        err: (error) => error,
      });
      if (validationError !== undefined) {
        return Result.err(
          new EventPublishContractInvalid({
            eventType: type,
            message: `publishClaimedRequest failed ${validationError.stage} validation`,
          }),
        );
      }
      const publishClaimed = raw.publishClaimedRequest?.bind(raw);
      if (publishClaimed === undefined) {
        return Result.err(
          new EventRequestPublicationClaimUnsupported({
            operation: "publish",
            message: "The configured raw bus does not support claimed request publication",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () =>
            publishClaimed(
              { topic, type, key, headers: options?.headers, data },
              { topic, type, key, headers: options?.headers },
              claim,
            ),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "error") {
        if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
        return Result.err(
          new EventPublishTransportFailed({
            cause: outcome.error.restoreCause(),
            eventType: type,
            topic,
            message: "Claimed request publication failed",
          }),
        );
      }
      if (outcome.value.status === "fenced") {
        return Result.err(
          new EventRequestPublicationClaimFenced({
            requestDeliveryId: claim.requestDeliveryId,
            message: "The request publication claim is no longer live",
          }),
        );
      }
      return Result.ok({ ...outcome.value.receipt, topic });
    },

    confirmRequestPublication: async (claim, expectedStreamId) => {
      if (raw.confirmRequestPublication === undefined) {
        return Result.err(
          new EventRequestPublicationConfirmationUnsupported({
            message: "The configured raw bus does not support request publication confirmation",
          }),
        );
      }
      const confirmed = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.confirmRequestPublication!(claim, expectedStreamId),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(confirmed);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
      return Result.err(
        new EventRequestPublicationConfirmationFailed({
          cause: outcome.error.restoreCause(),
          requestDeliveryId: claim.requestDeliveryId,
          expectedStreamId,
          message: "Request publication confirmation failed",
        }),
      );
    },

    abandonRequestPublicationClaim: async (claim) => {
      const abandon = raw.abandonRequestPublicationClaim?.bind(raw);
      if (abandon === undefined) {
        return Result.err(
          new EventRequestPublicationClaimUnsupported({
            operation: "abandon",
            message:
              "The configured raw bus does not support abandoning request publication claims",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => abandon(claim),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
      return Result.err(
        new EventRequestPublicationClaimFailed({
          cause: outcome.error.restoreCause(),
          operation: "abandon",
          requestDeliveryId: claim.requestDeliveryId,
          message: "Request publication claim abandon failed",
        }),
      );
    },

    getOutputStreamExpiry: async (requestId) => {
      const topic = outReqTopic(requestId);
      const readOutputStreamExpiry = raw.readOutputStreamExpiry?.bind(raw);
      if (readOutputStreamExpiry === undefined) {
        return Result.err(
          new EventOutputStreamExpiryUnavailable({
            reason: "unsupported",
            requestId,
            topic,
            message: "The configured raw bus cannot read output stream expiry",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => readOutputStreamExpiry(topic),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "error") {
        if (outcome.error.kind === "panic") return signalEventBusPanic(outcome.error.panic);
        return Result.err(
          new EventOutputStreamExpiryUnavailable({
            reason: "transport-unavailable",
            requestId,
            topic,
            message: "Output stream expiry read failed",
          }),
        );
      }
      if (outcome.value.kind === "uncertain") {
        return Result.err(
          new EventOutputStreamExpiryUnavailable({
            reason: "expiry-uncertain",
            requestId,
            topic,
            message: "The output stream exists without an absolute expiry",
          }),
        );
      }
      return Result.ok(outcome.value);
    },

    subscribeTopic: async <TTopic extends LilacTopic, TError extends AnyTaggedError>(
      topic: TTopic,
      opts: SubscriptionOptions,
      handler: (
        msg: DecodedLilacMessageForTopic<TTopic>,
        ctx: EventDeliveryContext,
      ) => Promise<ResultType<void, TError>>,
      deliveryPolicy: (error: TError) => DeliveryDisposition,
    ) => {
      if (typeof raw.subscribe !== "function") {
        return Result.err(
          new EventDeliveryStartFailed({
            cause: undefined,
            topic,
            message: "The configured raw bus does not implement subscribe",
          }),
        );
      }
      const handlerFailureAction = (error: TError): RawDeliveryAction => {
        const disposition = checkedDisposition(deliveryPolicy(error));
        const formatted = formatTaggedErrorForLog(error);
        if (disposition === "retry") {
          return {
            disposition,
            failure: createHandlerErrorDeadLetterReason({
              errorTag: formatted.errorTag,
              errorMessage: formatted.errorMessage,
            }),
          };
        }
        if (disposition !== "dead-letter") return { disposition };
        return {
          disposition,
          reason: createHandlerErrorDeadLetterReason({
            errorTag: formatted.errorTag,
            errorMessage: formatted.errorMessage,
          }),
        };
      };
      const deliverDecoded = async (
        decoded: DecodedLilacMessageForTopic<TTopic>,
        context: EventDeliveryContext,
      ): Promise<RawDeliveryAction> => {
        const handled = checkedHandlerResult(await handler(decoded, context));
        if (handled.isErr()) return handlerFailureAction(handled.error);
        return {
          disposition: "commit",
          ...(options.postCommitObserver !== undefined && context.mode !== "tail"
            ? { observePostCommit: () => options.postCommitObserver!.observe(decoded, context) }
            : {}),
        };
      };
      return await raw.subscribe(
        topic,
        opts,
        async (message, context): Promise<RawDeliveryAction> => {
          let contractError: EventContractInvalid | undefined;
          let eventType: string | undefined;
          if ("_tag" in message) {
            contractError = normalizeTransportInvalid(message);
          } else {
            eventType = message.type;
            const decoded = decodeLilacMessageForTopic(message, topic);
            if (decoded.isErr()) contractError = normalizeContractInvalid(decoded.error);
            else return await deliverDecoded(decoded.value, context);
          }

          if (contractError === undefined) {
            throw new Panic({
              message: "Event contract failure was not captured",
            });
          }
          logContractInvalid(options.logger, topic, context.cursor, contractError);
          const disposition = applyEventDeliveryPolicy(contractError);
          if (disposition === "retry") {
            throw new Panic({
              message: "Package event delivery policy cannot retry without a failure",
            });
          }
          if (disposition !== "dead-letter") return { disposition };
          return {
            disposition,
            reason: createContractInvalidDeadLetterReason({
              stage: contractError.stage,
              eventType: contractError.eventType ?? eventType,
              issues: contractError.issues,
            }),
          };
        },
        {
          deadLetter: options.deadLetter,
          logger: options.logger,
          reportFatal: options.reportFatal,
        },
      );
    },

    fetchTopic: async <TTopic extends LilacTopic>(topic: TTopic, opts: FetchOptions) => {
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.fetch(topic, opts),
          catch: captureLilacBusFailure,
        }),
      );
      const fetchOutcome = lilacBusOutcome(captured);
      if (fetchOutcome.kind === "error") {
        if (fetchOutcome.error.kind === "panic") {
          return signalEventBusPanic(fetchOutcome.error.panic);
        }
        return Result.err(
          new EventFetchTransportFailed({
            cause: fetchOutcome.error.restoreCause(),
            topic,
            message: "Event topic fetch failed",
          }),
        );
      }
      const fetched = fetchOutcome.value;

      const messages: Array<{
        msg: DecodedLilacMessageForTopic<TTopic>;
        cursor: Cursor;
      }> = [];
      for (const entry of fetched.messages) {
        let contractError: EventContractInvalid;
        if ("_tag" in entry.msg) {
          contractError = normalizeTransportInvalid(entry.msg);
        } else {
          const continueDecoded = decodeLilacMessageForTopic(entry.msg, topic).match<
            () => EventContractInvalid | undefined
          >({
            ok: (message) => () => {
              messages.push({ msg: message, cursor: entry.cursor });
              return undefined;
            },
            err: (error) => () => normalizeContractInvalid(error),
          });
          const decodedError = continueDecoded();
          if (decodedError === undefined) continue;
          contractError = decodedError;
        }
        logContractInvalid(options.logger, topic, entry.cursor, contractError);
        return Result.err(
          new EventFetchContractInvalid({
            topic,
            cursor: entry.cursor,
            contractError,
            evidence: entry.evidence,
            message: "Fetched event failed its contract",
          }),
        );
      }
      return Result.ok({ messages, next: fetched.next });
    },

    getTopicWatermark: async (topic) => {
      if (!raw.watermark) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "watermark",
            topic,
            message: "The configured event bus does not expose durable topic watermarks",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.watermark!(topic),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") throw outcome.error.panic;
      return Result.err(
        new EventTopicOperationFailed({
          cause: outcome.error.restoreCause(),
          operation: "watermark",
          topic,
          message: "Event topic watermark read failed",
        }),
      );
    },

    trimTopicBeforeCheckpoint: async (topic, checkpoint, safetyMargin) => {
      if (!raw.trimBeforeCheckpoint) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "trim",
            topic,
            message: "The configured event bus does not expose checkpoint trimming",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.trimBeforeCheckpoint!(topic, checkpoint, safetyMargin),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") throw outcome.error.panic;
      return Result.err(
        new EventTopicOperationFailed({
          cause: outcome.error.restoreCause(),
          operation: "trim",
          topic,
          message: "Event topic checkpoint trim failed",
        }),
      );
    },

    retireTopicConsumerGroup: async (topic, group, confirmSingleVersionRollout = false) => {
      if (!raw.retireConsumerGroup) {
        return Result.err(
          new EventTopicOperationUnsupported({
            operation: "retire-consumer-group",
            topic,
            message: "The configured event bus does not expose consumer-group retirement",
          }),
        );
      }
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.retireConsumerGroup!(topic, group, confirmSingleVersionRollout),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(outcome.value);
      if (outcome.error.kind === "panic") throw outcome.error.panic;
      return Result.err(
        new EventTopicOperationFailed({
          cause: outcome.error.restoreCause(),
          operation: "retire-consumer-group",
          topic,
          message: "Event topic consumer-group retirement failed",
        }),
      );
    },

    close: async () => {
      const captured = settleLilacBusCapture(
        await Result.tryPromise({
          try: () => raw.close(),
          catch: captureLilacBusFailure,
        }),
      );
      const outcome = lilacBusOutcome(captured);
      if (outcome.kind === "ok") return Result.ok(undefined);
      if (outcome.error.kind === "panic") throw outcome.error.panic;
      return Result.err(
        new EventBusCloseFailed({
          cause: outcome.error.restoreCause(),
          message: "Event bus close failed",
        }),
      );
    },
  };

  return bus;
}
