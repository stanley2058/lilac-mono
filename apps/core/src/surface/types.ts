import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

export type SurfacePlatform = Exclude<AdapterPlatform, "unknown"> | "unknown";

export type DiscordSessionRef = {
  platform: "discord";
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
};

/**
 * GitHub session:
 * - channelId: "OWNER/REPO#<number>" (issue or PR)
 */
export type GithubSessionRef = {
  platform: "github";
  channelId: string;
};

export type DiscordMsgRef = {
  platform: "discord";
  channelId: string;
  messageId: string;
};

/**
 * GitHub message reference:
 * - messageId: either issue/pr number (for PR description trigger) or an issue_comment id.
 */
export type GithubMsgRef = {
  platform: "github";
  channelId: string;
  messageId: string;
};

export type SessionRef = DiscordSessionRef | GithubSessionRef;
export type MsgRef = DiscordMsgRef | GithubMsgRef;

export type SurfaceSelf = {
  platform: SurfacePlatform;
  userId: string;
  userName: string;
};

export type SurfaceSession = {
  ref: SessionRef;
  title?: string;
  kind: "channel" | "thread" | "dm";
};

export type SurfaceMessage = {
  ref: MsgRef;
  session: SessionRef;
  userId: string;
  userName?: string;
  text: string;
  ts: number;
  editedTs?: number;
  deleted?: boolean;
  raw?: unknown;
};

export type SurfaceReactionUser = {
  userId: string;
  userName?: string;
};

export type SurfaceReactionDetail = {
  emoji: string;
  count: number;
  users: SurfaceReactionUser[];
};

export type SurfaceReactionSummary = {
  emoji: string;
  count: number;
};

export type LimitOpts = {
  limit?: number;
  /**
   * Optional paging cursor.
   *
   * For Discord this is a message id; behavior is adapter-specific.
   */
  beforeMessageId?: string;
  /**
   * Optional paging cursor.
   *
   * For Discord this is a message id; behavior is adapter-specific.
   */
  afterMessageId?: string;
};

export type SurfaceAttachment = {
  kind: "image" | "file";
  mimeType: string;
  filename: string;
  bytes: Uint8Array;
};

export type ContentOpts = {
  text?: string;
  format?: "markdown" | "plain";
  attachments?: SurfaceAttachment[];
};

export type SendOpts = {
  replyTo?: MsgRef;
};

export type AdapterCapabilities = {
  platform: SurfacePlatform;
  send: boolean;
  edit: boolean;
  delete: boolean;
  reactions: boolean;
  readHistory: boolean;
  threads: boolean;
  markRead: boolean;
};
