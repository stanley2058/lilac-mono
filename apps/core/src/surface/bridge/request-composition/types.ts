import type { BlobHandleV1, BlobStore } from "@stanley2058/lilac-blob-storage";
import type { BusMessageV2, CorePrimaryLineageV2 } from "@stanley2058/lilac-event-bus";
import type { RetentionLimit } from "@stanley2058/lilac-utils";

import type { MsgRef, SurfaceMessage } from "../../types";
import type {
  DiscordAttachmentCacheAccess,
  DiscordAttachmentMeta,
} from "../../discord/discord-attachment";
import type { DiscordMessageCacheAccess } from "../../store/discord-search-store";
import type { DiscordRelayRaw } from "../../discord/discord-relay";

import type { TranscriptStore } from "../../../transcript/transcript-store";
import type { ResourceRegistry } from "../../../resource";

export type RequestCompositionResult = {
  messages: BusMessageV2[];
  inputHandles: readonly BlobHandleV1[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
  corePrimaryLineage: CorePrimaryLineageV2;
};

type RequestCompositionDependencies = {
  blobStore?: BlobStore;
  /** Required when a newly observed Discord message contains visible attachments. */
  resourceRegistry?: ResourceRegistry;
  attachmentCache?: DiscordAttachmentCacheAccess;
  attachmentCacheTtl?: RetentionLimit;
  messageCache?: DiscordMessageCacheAccess;
  /** Trusted messages already carried by the admitted adapter event. */
  ingressMessages?: readonly SurfaceMessage[];
};

export type ComposeRecentChannelMessagesOpts = RequestCompositionDependencies & {
  platform: "discord";
  sessionId: string;
  botUserId: string;
  botName: string;
  botMentionNames?: readonly string[];
  limit: number;
  transcriptStore?: TranscriptStore;
  currentRequestId?: string;
  currentMessageIds?: readonly string[];
  discordUserAliasById?: ReadonlyMap<string, string>;
  /** Optional trigger message to force-include (mention/reply). */
  triggerMsgRef?: MsgRef;
  triggerType?: "mention" | "reply";
  /** Optional transform applied to one selected user message id. */
  transformUserTextForMessageId?: string;
  transformUserText?: (text: string) => string;
};

export type ComposeSingleMessageOpts = RequestCompositionDependencies & {
  platform: "discord";
  botUserId: string;
  botName: string;
  msgRef: MsgRef;
  discordUserAliasById?: ReadonlyMap<string, string>;
  transcriptStore?: TranscriptStore;
  currentMessageIds?: readonly string[];
  transformUserText?: (text: string) => string;
};

export type ComposeRequestOpts = RequestCompositionDependencies & {
  platform: "discord";
  botUserId: string;
  botName: string;
  transcriptStore?: TranscriptStore;
  currentRequestId?: string;
  currentMessageIds?: readonly string[];
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

export type ReplyChainMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  text: string;
  attachments: DiscordAttachmentMeta[];
  isChat?: boolean;
  /** Set when Lilac posted this message for a run on another surface. */
  relay?: DiscordRelayRaw;
  replyReference: {
    messageId?: string;
    channelId?: string;
  };
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
