import { describe, expect, expectTypeOf, it } from "bun:test";
import { Result } from "better-result";

import {
  type StartOutputOpts,
  type StartTypingOpts,
  type SurfaceAdapter,
  type SurfaceOperation,
  type SurfaceMergeBlockPlanOptions,
  type SurfaceOperationResult,
  type SurfaceOutputStream,
  type SurfaceReplyChainPlanOptions,
  type SurfaceSendPreparationInput,
  type TypingIndicatorSubscription,
} from "../../src/surface/adapter";
import type {
  ContentOpts,
  DiscordMsgRef,
  DiscordSessionRef,
  GithubMsgRef,
  GithubSessionRef,
  LimitOpts,
  MsgRef,
  MsgRefFor,
  RegisteredSurfacePlatform,
  SendOpts,
  SessionRef,
  SessionRefFor,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceRefPlatformSetsExactlyEqual,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
} from "../../src/surface/types";
import type { RequestContext as PluginRequestContext } from "@stanley2058/lilac-plugin-runtime";
import type { RequestContext as CoreRequestContext } from "../../src/tool-server/types";

const SESSION_REF_FIXTURES = {
  discord: { platform: "discord", channelId: "discord-channel" },
  github: { platform: "github", channelId: "owner/repo#1" },
  native: { platform: "native", channelId: "thread-1" },
} as const satisfies Record<SessionRef["platform"], SessionRef>;

const MESSAGE_REF_FIXTURES = {
  discord: { platform: "discord", channelId: "discord-channel", messageId: "discord-message" },
  github: { platform: "github", channelId: "owner/repo#1", messageId: "101" },
  native: { platform: "native", channelId: "thread-1", messageId: "message-1" },
} as const satisfies Record<MsgRef["platform"], MsgRef>;

type SurfaceOperationEntrypoint =
  | {
      readonly target: "adapter";
      readonly method:
        | "resolveSessionAlias"
        | "listSessions"
        | "listSessionParticipants"
        | "startOutput"
        | "startTyping"
        | "sendMsg"
        | "readMsg"
        | "listMsg"
        | "editMsg"
        | "deleteMsg"
        | "getReplyContext"
        | "planReplyChain"
        | "planMergeBlockEndingAt"
        | "addReaction"
        | "removeReaction"
        | "listReactions"
        | "listReactionDetails"
        | "getUnRead"
        | "markRead";
    }
  | {
      readonly target: "output-stream";
      readonly method: "push" | "finish" | "abort";
    }
  | {
      readonly target: "typing-subscription";
      readonly method: "stop";
    };

type SurfaceAdapterOperationContractFixture<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly sessionRef: SessionRefFor<P>;
  readonly messageRef: MsgRefFor<P>;
  readonly operations: Record<SurfaceOperation, SurfaceOperationEntrypoint>;
  readonly result: SurfaceOperationResult<MsgRefFor<P>>;
};

const DISCORD_OPERATION_RESULT: SurfaceOperationResult<DiscordMsgRef> = Result.ok(
  MESSAGE_REF_FIXTURES.discord,
);

const DISCORD_ADAPTER_OPERATION_CONTRACT = {
  platform: "discord",
  sessionRef: SESSION_REF_FIXTURES.discord,
  messageRef: MESSAGE_REF_FIXTURES.discord,
  operations: {
    "resolve-session-alias": { target: "adapter", method: "resolveSessionAlias" },
    "list-sessions": { target: "adapter", method: "listSessions" },
    "list-session-participants": { target: "adapter", method: "listSessionParticipants" },
    "start-output": { target: "adapter", method: "startOutput" },
    "push-output": { target: "output-stream", method: "push" },
    "finish-output": { target: "output-stream", method: "finish" },
    "abort-output": { target: "output-stream", method: "abort" },
    "start-typing": { target: "adapter", method: "startTyping" },
    "stop-typing": { target: "typing-subscription", method: "stop" },
    "send-message": { target: "adapter", method: "sendMsg" },
    "read-message": { target: "adapter", method: "readMsg" },
    "list-messages": { target: "adapter", method: "listMsg" },
    "edit-message": { target: "adapter", method: "editMsg" },
    "delete-message": { target: "adapter", method: "deleteMsg" },
    "get-reply-context": { target: "adapter", method: "getReplyContext" },
    "plan-reply-chain": { target: "adapter", method: "planReplyChain" },
    "plan-merge-block": { target: "adapter", method: "planMergeBlockEndingAt" },
    "add-reaction": { target: "adapter", method: "addReaction" },
    "remove-reaction": { target: "adapter", method: "removeReaction" },
    "list-reactions": { target: "adapter", method: "listReactions" },
    "list-reaction-details": { target: "adapter", method: "listReactionDetails" },
    "get-unread": { target: "adapter", method: "getUnRead" },
    "mark-read": { target: "adapter", method: "markRead" },
  },
  result: DISCORD_OPERATION_RESULT,
} as const satisfies SurfaceAdapterOperationContractFixture<"discord">;

const GITHUB_OPERATION_RESULT: SurfaceOperationResult<GithubMsgRef> = Result.ok(
  MESSAGE_REF_FIXTURES.github,
);

const GITHUB_ADAPTER_OPERATION_CONTRACT = {
  platform: "github",
  sessionRef: SESSION_REF_FIXTURES.github,
  messageRef: MESSAGE_REF_FIXTURES.github,
  operations: {
    "resolve-session-alias": { target: "adapter", method: "resolveSessionAlias" },
    "list-sessions": { target: "adapter", method: "listSessions" },
    "list-session-participants": { target: "adapter", method: "listSessionParticipants" },
    "start-output": { target: "adapter", method: "startOutput" },
    "push-output": { target: "output-stream", method: "push" },
    "finish-output": { target: "output-stream", method: "finish" },
    "abort-output": { target: "output-stream", method: "abort" },
    "start-typing": { target: "adapter", method: "startTyping" },
    "stop-typing": { target: "typing-subscription", method: "stop" },
    "send-message": { target: "adapter", method: "sendMsg" },
    "read-message": { target: "adapter", method: "readMsg" },
    "list-messages": { target: "adapter", method: "listMsg" },
    "edit-message": { target: "adapter", method: "editMsg" },
    "delete-message": { target: "adapter", method: "deleteMsg" },
    "get-reply-context": { target: "adapter", method: "getReplyContext" },
    "plan-reply-chain": { target: "adapter", method: "planReplyChain" },
    "plan-merge-block": { target: "adapter", method: "planMergeBlockEndingAt" },
    "add-reaction": { target: "adapter", method: "addReaction" },
    "remove-reaction": { target: "adapter", method: "removeReaction" },
    "list-reactions": { target: "adapter", method: "listReactions" },
    "list-reaction-details": { target: "adapter", method: "listReactionDetails" },
    "get-unread": { target: "adapter", method: "getUnRead" },
    "mark-read": { target: "adapter", method: "markRead" },
  },
  result: GITHUB_OPERATION_RESULT,
} as const satisfies SurfaceAdapterOperationContractFixture<"github">;

interface SurfaceAdapterSignatureFixture {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSelf(): Promise<SurfaceSelf>;
  resolveSessionAlias?(alias: string): Promise<SurfaceOperationResult<SessionRef>>;
  listSessions(opts?: {
    limit?: number;
    archived?: boolean;
  }): Promise<SurfaceOperationResult<SurfaceSession[]>>;
  listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>>;
  startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>>;
  startTyping(
    sessionRef: SessionRef,
    opts?: StartTypingOpts,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>>;
  prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>>;
  sendToolMsg?: SurfaceAdapter["sendToolMsg"];
  sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>>;
  readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>>;
  listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>>;
  deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>>;
  getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  planReplyChain(
    msgRef: MsgRef,
    opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>>;
  planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>>;
  addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>>;
  removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>>;
  listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>>;
  listReactionDetails(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>>;
  getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<SurfaceOperationResult<void>>;
}

describe("surface operation contract", () => {
  it("keeps session and message platform sets exactly equal", () => {
    expectTypeOf<SessionRef["platform"]>().toEqualTypeOf<MsgRef["platform"]>();
    expectTypeOf<RegisteredSurfacePlatform>().toEqualTypeOf<"discord" | "github" | "native">();
    expectTypeOf<
      NonNullable<PluginRequestContext["requestInitiator"]>["platform"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<CoreRequestContext["requestInitiator"]>["platform"]
    >().toEqualTypeOf<RegisteredSurfacePlatform>();
    expectTypeOf<SurfaceRefPlatformSetsExactlyEqual>().toEqualTypeOf<true>();
    expect(Object.keys(SESSION_REF_FIXTURES).sort()).toEqual(
      Object.keys(MESSAGE_REF_FIXTURES).sort(),
    );
  });

  it("correlates platform-specific session and message refs", () => {
    expectTypeOf<SessionRefFor<"discord">>().toEqualTypeOf<DiscordSessionRef>();
    expectTypeOf<SessionRefFor<"github">>().toEqualTypeOf<GithubSessionRef>();
    expectTypeOf<MsgRefFor<"discord">>().toEqualTypeOf<DiscordMsgRef>();
    expectTypeOf<MsgRefFor<"github">>().toEqualTypeOf<GithubMsgRef>();
    expectTypeOf(DISCORD_ADAPTER_OPERATION_CONTRACT.sessionRef).toMatchTypeOf<DiscordSessionRef>();
    expectTypeOf(DISCORD_ADAPTER_OPERATION_CONTRACT.messageRef).toMatchTypeOf<DiscordMsgRef>();
    expectTypeOf(DISCORD_ADAPTER_OPERATION_CONTRACT.result).toMatchTypeOf<
      SurfaceOperationResult<DiscordMsgRef>
    >();
    expectTypeOf(GITHUB_ADAPTER_OPERATION_CONTRACT.sessionRef).toMatchTypeOf<GithubSessionRef>();
    expectTypeOf(GITHUB_ADAPTER_OPERATION_CONTRACT.messageRef).toMatchTypeOf<GithubMsgRef>();
    expectTypeOf(GITHUB_ADAPTER_OPERATION_CONTRACT.result).toMatchTypeOf<
      SurfaceOperationResult<GithubMsgRef>
    >();
  });

  it("matches the normalized production adapter signatures", () => {
    expectTypeOf<SurfaceAdapter>().toEqualTypeOf<SurfaceAdapterSignatureFixture>();
  });

  it("independently enumerates the complete Stage 1 operation set for both platforms", () => {
    const expectedOperations = [
      "abort-output",
      "add-reaction",
      "delete-message",
      "edit-message",
      "finish-output",
      "get-reply-context",
      "get-unread",
      "list-messages",
      "list-reaction-details",
      "list-reactions",
      "list-session-participants",
      "list-sessions",
      "mark-read",
      "plan-merge-block",
      "plan-reply-chain",
      "push-output",
      "read-message",
      "remove-reaction",
      "resolve-session-alias",
      "send-message",
      "start-output",
      "start-typing",
      "stop-typing",
    ];

    expect(Object.keys(DISCORD_ADAPTER_OPERATION_CONTRACT.operations).sort()).toEqual(
      expectedOperations,
    );
    expect(Object.keys(GITHUB_ADAPTER_OPERATION_CONTRACT.operations).sort()).toEqual(
      expectedOperations,
    );
  });
});
