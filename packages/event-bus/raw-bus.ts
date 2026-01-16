import type {
  Cursor,
  FetchOptions,
  HandleContext,
  Message,
  PublishOptions,
  SubscriptionOptions,
  Topic,
} from "./types";

/**
 * Low-level bus interface.
 *
 * This is transport-focused (topics are strings, payload is generic/unknown).
 * Most app code should prefer `LilacBus` from `lilac-bus.ts`.
 */
export interface RawBus {
  /** Append a message to a topic/stream. */
  publish<TData>(
    msg: Omit<Message<TData>, "id" | "ts">,
    opts: PublishOptions,
  ): Promise<{ id: string; cursor: Cursor }>;

  /** Subscribe to a topic with the requested delivery mode. */
  subscribe<TData>(
    topic: Topic,
    opts: SubscriptionOptions,
    handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
  ): Promise<{ stop(): Promise<void> }>;

  /** Fetch messages without creating a subscription. */
  fetch<TData>(
    topic: Topic,
    opts: FetchOptions,
  ): Promise<{
    messages: Array<{ msg: Message<TData>; cursor: Cursor }>;
    next?: Cursor;
  }>;

  /** Close any owned resources (connections, timers, etc). */
  close(): Promise<void>;
}
