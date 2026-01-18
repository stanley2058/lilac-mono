/** Logical channel name (backed by a Redis stream). */
export type Topic = string;

/**
 * Opaque checkpoint token.
 *
 * In the Redis Streams transport this is the stream entry id (e.g. `1736973100000-0`).
 */
export type Cursor = string;

/** Where to start reading from when consuming a topic. */
export type Offset =
  | { type: "begin" }
  | { type: "now" }
  | { type: "cursor"; cursor: Cursor };

/** Delivery model for subscriptions. */
export type Mode = "work" | "fanout" | "tail";

/** Envelope stored in / read from the bus. */
export type Message<TData = unknown> = {
  topic: Topic;
  id: string;
  type: string;
  ts: number;
  key?: string;
  headers?: Record<string, string>;
  data: TData;
};

/** Low-level publish options (mostly transport-focused). */
export type PublishOptions = {
  /** Destination topic/stream. */
  topic: Topic;
  /** Event type string (e.g. `cmd.request.message`). */
  type: string;
  /** Optional correlation/partition key (e.g. request_id). */
  key?: string;
  /** Optional metadata (string->string). */
  headers?: Record<string, string>;
  /** Best-effort retention hint (e.g. approximate MAXLEN). */
  retention?: { maxLenApprox?: number };
};

/** Flow control options for read loops. */
export type BatchOptions = {
  /** Max messages per poll. */
  maxMessages?: number;
  /** Max time to block waiting for messages. */
  maxWaitMs?: number;
};

/** Durable subscription (consumer group) options. */
export type WorkOrFanoutSubscriptionOptions = {
  /**
   * `work`: competing consumers (queue semantics).
   * `fanout`: each subscriptionId receives all events.
   */
  mode: "work" | "fanout";
  /** Consumer group identifier (durable). */
  subscriptionId: string;
  /** Optional consumer identity within the group. */
  consumerId?: string;
  /**
   * Only applied if the consumer group needs to be created.
   * If the group already exists, the offset is ignored.
   */
  offset?: Exclude<Offset, { type: "cursor" }>;
  batch?: BatchOptions;
};

/** Non-durable streaming read options (no consumer group). */
export type TailSubscriptionOptions = {
  mode: "tail";
  offset?: Offset;
  batch?: BatchOptions;
};

/** Options shared by `subscribe()` variants. */
export type SubscriptionOptions =
  | WorkOrFanoutSubscriptionOptions
  | TailSubscriptionOptions;

/** Manual pull API options for `fetch()`. */
export type FetchOptions = {
  offset: Offset;
  limit?: number;
};

/** Context passed to subscription handlers. */
export type HandleContext = {
  /** Cursor of the current message. */
  cursor: Cursor;
  /** Acknowledge the message for durable modes (work/fanout). */
  commit(): Promise<void>;
};
