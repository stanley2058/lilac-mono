import type { RawBus } from "./raw-bus";
import type { Cursor, FetchOptions, Message, SubscriptionOptions } from "./types";
import {
  lilacEventTypes,
  outReqTopic,
  type LilacDataForType,
  type LilacEventSpec,
  type LilacEventType,
  type LilacEventTypesForTopic,
  type LilacKeyForType,
  type LilacTopic,
  type LilacTopicForType,
} from "./lilac-spec";

/**
 * Strongly-typed event message envelope.
 *
 * `type` controls the `data` payload shape.
 */
export type LilacMessage<TType extends LilacEventType> =
  TType extends LilacEventType
    ? Message<LilacDataForType<TType>> & {
        type: TType;
        topic: LilacTopicForType<TType>;
        key?: LilacKeyForType<TType>;
      }
    : never;

/** Discriminated union of all events that may appear on `TTopic`. */
export type LilacMessageForTopic<TTopic extends LilacTopic> =
  LilacMessage<LilacEventTypesForTopic<TTopic>>;

type OutputEventType =
  | typeof lilacEventTypes.EvtAgentOutputDeltaReasoning
  | typeof lilacEventTypes.EvtAgentOutputDeltaText
  | typeof lilacEventTypes.EvtAgentOutputResponseText
  | typeof lilacEventTypes.EvtAgentOutputResponseBinary
  | typeof lilacEventTypes.EvtAgentOutputToolCall;

function isOutputEventType(type: LilacEventType): type is OutputEventType {
  return (
    type === lilacEventTypes.EvtAgentOutputDeltaReasoning ||
    type === lilacEventTypes.EvtAgentOutputDeltaText ||
    type === lilacEventTypes.EvtAgentOutputResponseText ||
    type === lilacEventTypes.EvtAgentOutputResponseBinary ||
    type === lilacEventTypes.EvtAgentOutputToolCall
  );
}

function getStaticTopicForType<TType extends Exclude<LilacEventType, OutputEventType>>(
  type: TType,
): LilacTopicForType<TType> {
  return (
    {
      [lilacEventTypes.CmdRequestMessage]: "cmd.request",

      [lilacEventTypes.EvtAdapterMessageCreated]: "evt.adapter",
      [lilacEventTypes.EvtAdapterMessageUpdated]: "evt.adapter",
      [lilacEventTypes.EvtAdapterMessageDeleted]: "evt.adapter",
      [lilacEventTypes.EvtAdapterReactionAdded]: "evt.adapter",
      [lilacEventTypes.EvtAdapterReactionRemoved]: "evt.adapter",

      [lilacEventTypes.EvtRequestLifecycleChanged]: "evt.request",
      [lilacEventTypes.EvtRequestReply]: "evt.request",

      [lilacEventTypes.CmdWorkflowTaskCreate]: "cmd.workflow",
      [lilacEventTypes.CmdWorkflowCreate]: "cmd.workflow",
      [lilacEventTypes.CmdWorkflowCancel]: "cmd.workflow",

      [lilacEventTypes.EvtWorkflowTaskResolved]: "evt.workflow",
      [lilacEventTypes.EvtWorkflowTaskLifecycleChanged]: "evt.workflow",
      [lilacEventTypes.EvtWorkflowResolved]: "evt.workflow",
      [lilacEventTypes.EvtWorkflowLifecycleChanged]: "evt.workflow",

      [lilacEventTypes.CmdAgentCreate]: "cmd.agent",
    } as const satisfies Record<string, string>
  )[type] as LilacTopicForType<TType>;
}

function getTopicForType<TType extends LilacEventType>(
  type: TType,
  data: LilacEventSpec[TType]["data"],
): LilacEventSpec[TType]["topic"] {
  switch (type) {
    case lilacEventTypes.EvtAgentOutputDeltaReasoning:
    case lilacEventTypes.EvtAgentOutputDeltaText:
    case lilacEventTypes.EvtAgentOutputResponseText:
    case lilacEventTypes.EvtAgentOutputResponseBinary:
    case lilacEventTypes.EvtAgentOutputToolCall: {
      const requestId = (data as { requestId: string }).requestId;
      return outReqTopic(requestId) as LilacEventSpec[TType]["topic"];
    }

    default:
      return getStaticTopicForType(
        type as unknown as Exclude<LilacEventType, OutputEventType>,
      ) as LilacEventSpec[TType]["topic"];
  }
}

function getKeyForType<TType extends LilacEventType>(
  type: TType,
  data: LilacEventSpec[TType]["data"],
): string | undefined {
  switch (type) {
    case lilacEventTypes.CmdRequestMessage:
    case lilacEventTypes.EvtRequestLifecycleChanged:
    case lilacEventTypes.EvtRequestReply:
    case lilacEventTypes.EvtAgentOutputDeltaReasoning:
    case lilacEventTypes.EvtAgentOutputDeltaText:
    case lilacEventTypes.EvtAgentOutputResponseText:
    case lilacEventTypes.EvtAgentOutputResponseBinary:
    case lilacEventTypes.EvtAgentOutputToolCall: {
      return (data as { requestId: string }).requestId;
    }

    case lilacEventTypes.EvtAdapterMessageCreated:
    case lilacEventTypes.EvtAdapterMessageUpdated:
    case lilacEventTypes.EvtAdapterMessageDeleted:
    case lilacEventTypes.EvtAdapterReactionAdded:
    case lilacEventTypes.EvtAdapterReactionRemoved: {
      return (data as { channelId: string; messageId: string }).messageId;
    }

    case lilacEventTypes.CmdWorkflowTaskCreate:
    case lilacEventTypes.EvtWorkflowTaskResolved:
    case lilacEventTypes.EvtWorkflowTaskLifecycleChanged:
    case lilacEventTypes.CmdWorkflowCreate:
    case lilacEventTypes.EvtWorkflowResolved:
    case lilacEventTypes.CmdWorkflowCancel:
    case lilacEventTypes.EvtWorkflowLifecycleChanged: {
      return (data as { workflowId: string }).workflowId;
    }

    case lilacEventTypes.CmdAgentCreate: {
      return (data as { agentId: string }).agentId;
    }

    default:
      return undefined;
  }
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
      headers?: Record<string, string>;
      /** Override the default routing topic (advanced). */
      topic?: LilacTopicForType<TType>;
      /** Override the default correlation key (advanced). */
      key?: string;
      /** Best-effort retention hint. */
      retention?: { maxLenApprox?: number };
    },
  ): Promise<{ id: string; cursor: Cursor; topic: LilacTopicForType<TType> }>;

  /** Subscribe to a topic and receive a discriminated union of events. */
  subscribeTopic<TTopic extends LilacTopic>(
    topic: TTopic,
    opts: SubscriptionOptions,
    handler: (
      msg: LilacMessageForTopic<TTopic>,
      ctx: { cursor: Cursor; commit(): Promise<void> },
    ) => Promise<void>,
  ): Promise<{ stop(): Promise<void> }>;

  /**
   * Subscribe to a single event type.
   *
   * For output-stream event types you must provide `opts.topic` (e.g. `outReqTopic(requestId)`).
   */
  subscribeType<TType extends LilacEventType>(
    type: TType,
    opts: SubscriptionOptions &
      (TType extends OutputEventType
        ? { topic: LilacTopicForType<TType> }
        : { topic?: never }),
    handler: (
      msg: LilacMessage<TType>,
      ctx: { cursor: Cursor; commit(): Promise<void> },
    ) => Promise<void>,
  ): Promise<{ stop(): Promise<void> }>;

  /** Fetch typed messages from a topic (manual pull API). */
  fetchTopic<TTopic extends LilacTopic>(
    topic: TTopic,
    opts: FetchOptions,
  ): Promise<{
    messages: Array<{ msg: LilacMessageForTopic<TTopic>; cursor: Cursor }>;
    next?: Cursor;
  }>;

  /** Close the underlying transport. */
  close(): Promise<void>;
}

/** Wrap a `RawBus` with the Lilac typed event spec. */
export function createLilacBus(raw: RawBus): LilacBus {
  const bus: LilacBus = {
    publish: async <TType extends LilacEventType>(
      type: TType,
      data: LilacDataForType<TType>,
      options?: {
        headers?: Record<string, string>;
        topic?: LilacTopicForType<TType>;
        key?: string;
        retention?: { maxLenApprox?: number };
      },
    ) => {
      const topic = options?.topic ?? getTopicForType(type, data);
      const key = options?.key ?? getKeyForType(type, data);

      const res = await raw.publish(
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
          retention: options?.retention,
        },
      );

      return { ...res, topic };
    },

    subscribeTopic: async <TTopic extends LilacTopic>(
      topic: TTopic,
      opts: SubscriptionOptions,
      handler: (
        msg: LilacMessageForTopic<TTopic>,
        ctx: { cursor: Cursor; commit(): Promise<void> },
      ) => Promise<void>,
    ) => {
      return await raw.subscribe(topic, opts, async (msg, ctx) => {
        await handler(msg as unknown as LilacMessageForTopic<TTopic>, ctx);
      });
    },

    subscribeType: async <TType extends LilacEventType>(
      type: TType,
      opts: SubscriptionOptions &
        (TType extends OutputEventType
          ? { topic: LilacTopicForType<TType> }
          : { topic?: never }),
      handler: (
        msg: LilacMessage<TType>,
        ctx: { cursor: Cursor; commit(): Promise<void> },
      ) => Promise<void>,
    ) => {
      const topic = isOutputEventType(type)
        ? (opts as unknown as { topic: LilacTopicForType<TType> }).topic
        : getStaticTopicForType(
            type as unknown as Exclude<LilacEventType, OutputEventType>,
          );

      if (!topic) {
        throw new Error(
          `subscribeType(${type}) requires an explicit topic (e.g. outReqTopic(requestId))`,
        );
      }

      return await raw.subscribe(topic, opts, async (msg, ctx) => {
        if (msg.type !== type) return;
        await handler(msg as unknown as LilacMessage<TType>, ctx);
      });
    },

    fetchTopic: async <TTopic extends LilacTopic>(
      topic: TTopic,
      opts: FetchOptions,
    ) => {
      const res = await raw.fetch(topic, opts);
      return {
        messages: res.messages as unknown as Array<{
          msg: LilacMessageForTopic<TTopic>;
          cursor: Cursor;
        }>,
        next: res.next,
      };
    },

    close: async () => {
      await raw.close();
    },
  };

  return bus;
}
