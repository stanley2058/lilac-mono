import type { ModelMessage } from "ai";

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

export type AdapterRequestEvent = AdapterEventBase & {
  type: "adapter.request";
  requestId: string;
  channelId: string;
  channelName?: string;
  messages: ModelMessage[];
  raw?: unknown;
};

export type AdapterEvent =
  | AdapterMessageCreatedEvent
  | AdapterMessageUpdatedEvent
  | AdapterMessageDeletedEvent
  | AdapterReactionAddedEvent
  | AdapterReactionRemovedEvent
  | AdapterRequestEvent;
