import type { ModelMessage } from "ai";

import type { MsgRef } from "../../types";

import type { TranscriptStore } from "../../../transcript/transcript-store";

export type RequestCompositionResult = {
  messages: ModelMessage[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
};

export type ComposeRecentChannelMessagesOpts = {
  platform: "discord";
  sessionId: string;
  botUserId: string;
  botName: string;
  limit: number;
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
  /** Optional trigger message to force-include (mention/reply). */
  triggerMsgRef?: MsgRef;
  triggerType?: "mention" | "reply";
  /** Optional transform applied to one selected user message id. */
  transformUserTextForMessageId?: string;
  transformUserText?: (text: string) => string;
};

export type ComposeSingleMessageOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  msgRef: MsgRef;
  discordUserAliasById?: ReadonlyMap<string, string>;
  transformUserText?: (text: string) => string;
};

export type ComposeRequestOpts = {
  platform: "discord";
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
  trigger: {
    type: "mention" | "reply";
    msgRef: MsgRef;
  };
  maxDepth?: number;
  /** Optional transform applied to one selected user message id. */
  transformUserTextForMessageId?: string;
  transformUserText?: (text: string) => string;
};

export type DiscordAttachmentMeta = {
  url: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

export type ReplyChainMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  text: string;
  attachments: DiscordAttachmentMeta[];
  raw?: unknown;
};

export type MergedChunk = {
  messageIds: string[];
  authorId: string;
  authorName: string;
  tsStart: number;
  tsEnd: number;
  text: string;
  attachments: DiscordAttachmentMeta[];
};
