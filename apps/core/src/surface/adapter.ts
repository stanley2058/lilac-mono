import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceAttachment,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "./types";
import type { AdapterEvent } from "./events";

export type SurfaceToolStatusUpdate = {
  toolCallId: string;
  display: string;
  status: "start" | "end";
  ok?: boolean;
  error?: string;
};

export type SurfaceReasoningStatusUpdate = {
  startedAtMs: number;
  /** Freeze timer at this timestamp once text starts streaming. */
  frozenAtMs?: number;
  /** Collapsed provider reasoning text (optional). */
  detailText?: string;
};

export type SurfaceOutputPart =
  | { type: "text.delta"; delta: string }
  | { type: "text.set"; text: string }
  | { type: "reasoning.status"; update: SurfaceReasoningStatusUpdate }
  | { type: "meta.stats"; line: string }
  | { type: "tool.status"; update: SurfaceToolStatusUpdate }
  | { type: "attachment.add"; attachment: SurfaceAttachment };

export type SurfaceOutputResult = {
  created: MsgRef[];
  last: MsgRef;
};

export type SurfaceFinalTextMode = "continuation" | "full";

export type SurfaceReplyChainPlanOptions = {
  maxDepth?: number;
};

export type SurfaceMergeBlockPlanOptions = {
  lookbackLimit?: number;
};

export interface SurfaceOutputStream {
  push(part: SurfaceOutputPart): Promise<void>;
  finish(): Promise<SurfaceOutputResult>;
  abort(reason?: string): Promise<void>;
  /**
   * Optional final-text policy for bridge slicing behavior.
   * - continuation: treat finalText as current-lane continuation after reanchor
   * - full: treat finalText as complete reply text for the lane
   */
  getFinalTextMode?(): SurfaceFinalTextMode;
}

export type StartOutputOpts = {
  replyTo?: MsgRef;
  /** Disable all Discord notifications for this output stream (mentions + reply ping). */
  silent?: boolean;
  /** Router-derived session mode. Used for surface-specific behaviors (e.g. mention pings). */
  sessionMode?: "mention" | "active";
  /** Request id for this stream (used for surface controls like Cancel buttons). */
  requestId?: string;
  /** Request lifetime start timestamp used by streaming progress UIs. */
  requestStartedAtMs?: number;
  /** Optional hook invoked when the surface creates a message for this stream. */
  onMessageCreated?: (msgRef: MsgRef) => void;
  /** Optional resume metadata used to continue editing an existing output chain. */
  resume?: {
    /** Previously created output messages for this request (oldest to newest). */
    created: MsgRef[];
  };
};

export type AdapterSubscription = {
  stop(): Promise<void>;
};

export type TypingIndicatorSubscription = {
  stop(): Promise<void>;
};

/** Optional capability: start/stop a typing indicator for a session. */
export interface TypingIndicatorProvider {
  startTyping(sessionRef: SessionRef): Promise<TypingIndicatorSubscription>;
}

export type AdapterEventHandler = (evt: AdapterEvent) => Promise<void> | void;

export interface SurfaceAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSelf(): Promise<SurfaceSelf>;
  getCapabilities(): Promise<AdapterCapabilities>;

  listSessions(): Promise<SurfaceSession[]>;

  startOutput(sessionRef: SessionRef, opts?: StartOutputOpts): Promise<SurfaceOutputStream>;

  sendMsg(sessionRef: SessionRef, content: ContentOpts, opts?: SendOpts): Promise<MsgRef>;
  readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null>;
  listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]>;
  editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void>;
  deleteMsg(msgRef: MsgRef): Promise<void>;
  getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]>;

  addReaction(msgRef: MsgRef, reaction: string): Promise<void>;
  removeReaction(msgRef: MsgRef, reaction: string): Promise<void>;
  listReactions(msgRef: MsgRef): Promise<string[]>;

  subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription>;

  getUnRead(sessionRef: SessionRef): Promise<SurfaceMessage[]>;
  markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<void>;
}

/** Optional capability: plan reply-chain traversal using local metadata/indexes. */
export interface SurfaceReplyChainPlannerProvider {
  planReplyChain(msgRef: MsgRef, opts?: SurfaceReplyChainPlanOptions): Promise<readonly MsgRef[]>;
  planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<readonly MsgRef[]>;
}

export function hasReplyChainPlannerProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & SurfaceReplyChainPlannerProvider {
  const maybe = adapter as unknown as {
    planReplyChain?: unknown;
    planMergeBlockEndingAt?: unknown;
  };

  return (
    typeof maybe.planReplyChain === "function" && typeof maybe.planMergeBlockEndingAt === "function"
  );
}

export type SurfaceBurstCacheInput = {
  /** Prefer passing msgRef for targeted invalidation. */
  msgRef?: MsgRef;
  /** Used when msgRef is unknown (e.g. listing a session). */
  sessionRef?: SessionRef;
  /** Why the cache is being invalidated. */
  reason: "surface_tool" | "other";
};

/** Optional capability: invalidate in-memory provider caches for a "latest view" read. */
export interface SurfaceCacheBurstProvider {
  burstCache(input: SurfaceBurstCacheInput): Promise<void>;
}

export function hasCacheBurstProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & SurfaceCacheBurstProvider {
  const maybe = adapter as unknown as { burstCache?: unknown };
  return typeof maybe.burstCache === "function";
}
