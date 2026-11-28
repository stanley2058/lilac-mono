import type { MsgRef, SurfaceMessage, SurfacePlatform } from "./types";

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
  /** Surface control source; `orchestrate` is an agent on another surface. */
  source?: "button" | "context_menu" | "orchestrate";
  /** Optional user who clicked the control. */
  userId?: string;
  /** Optional surface message containing the control. */
  messageId?: string;
};

export type AdapterCommandInvokedEvent = Omit<AdapterEventBase, "platform"> & {
  type: "adapter.command.invoked";
  platform: "discord";
  requestId: string;
  sessionId: string;
  commandName: string;
  args: unknown[];
  prompt?: string;
  text: string;
  userId?: string;
  userName?: string;
  sessionMode: "mention" | "active";
  sessionConfigId: string;
  parentChannelId?: string;
  guildId?: string;
  modelOverride?: string;
};

export type AdapterActionInvokedEvent = AdapterEventBase & {
  type: "adapter.action.invoked";
  actionId: string;
  userId: string;
  messageRef: MsgRef;
  sourceMessageId?: string;
};

export type AdapterEvent =
  | AdapterMessageCreatedEvent
  | AdapterMessageUpdatedEvent
  | AdapterMessageDeletedEvent
  | AdapterReactionAddedEvent
  | AdapterReactionRemovedEvent
  | AdapterRequestCancelEvent
  | AdapterCommandInvokedEvent
  | AdapterActionInvokedEvent;
