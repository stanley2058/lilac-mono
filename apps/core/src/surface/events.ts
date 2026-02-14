import type { SurfaceMessage, SurfacePlatform } from "./types";

export type AdapterEventBase = {
  platform: SurfacePlatform;
  ts: number;
};

export type AdapterMessageCreatedEvent = AdapterEventBase & {
  type: "adapter.message.created";
  message: SurfaceMessage;
  channelName?: string;
};

export type AdapterMessageUpdatedEvent = AdapterEventBase & {
  type: "adapter.message.updated";
  message: SurfaceMessage;
  channelName?: string;
};

export type AdapterMessageDeletedEvent = AdapterEventBase & {
  type: "adapter.message.deleted";
  messageRef: SurfaceMessage["ref"];
  session: SurfaceMessage["session"];
  channelName?: string;
  raw?: unknown;
};

export type AdapterReactionAddedEvent = AdapterEventBase & {
  type: "adapter.reaction.added";
  messageRef: SurfaceMessage["ref"];
  session: SurfaceMessage["session"];
  channelName?: string;
  reaction: string;
  userId?: string;
  userName?: string;
  raw?: unknown;
};

export type AdapterReactionRemovedEvent = AdapterEventBase & {
  type: "adapter.reaction.removed";
  messageRef: SurfaceMessage["ref"];
  session: SurfaceMessage["session"];
  channelName?: string;
  reaction: string;
  userId?: string;
  userName?: string;
  raw?: unknown;
};

export type AdapterRequestCancelEvent = AdapterEventBase & {
  type: "adapter.request.cancel";
  /** Target request id to cancel (as used on the bus). */
  requestId: string;
  /** Target session id (discord channel/thread id). */
  sessionId: string;
  /** Whether cancellation may target queued requests, not only active runs. */
  cancelScope?: "active_only" | "active_or_queued";
  /** Surface control source. */
  source?: "button" | "context_menu";
  /** Optional user who clicked the control. */
  userId?: string;
  /** Optional surface message containing the control. */
  messageId?: string;
};

export type AdapterEvent =
  | AdapterMessageCreatedEvent
  | AdapterMessageUpdatedEvent
  | AdapterMessageDeletedEvent
  | AdapterReactionAddedEvent
  | AdapterReactionRemovedEvent
  | AdapterRequestCancelEvent;
