import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "./types";
import type { AdapterEvent } from "./events";

export type AdapterSubscription = {
  stop(): Promise<void>;
};

export type AdapterEventHandler = (evt: AdapterEvent) => Promise<void> | void;

export interface SurfaceAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSelf(): Promise<SurfaceSelf>;
  getCapabilities(): Promise<AdapterCapabilities>;

  listSessions(): Promise<SurfaceSession[]>;

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
