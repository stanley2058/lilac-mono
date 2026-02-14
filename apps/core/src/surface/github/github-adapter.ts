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
} from "../types";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../adapter";

import {
  createIssueComment,
  editIssueComment,
  getIssue,
  listIssueComments,
} from "../../github/github-api";
import { isGithubIssueTriggerId, parseGithubSessionId } from "../../github/github-ids";
import { GithubOutputStream } from "./output/github-output-stream";

function assertGithubSessionRef(sessionRef: SessionRef) {
  if (sessionRef.platform !== "github") {
    throw new Error(`Expected github sessionRef (got '${sessionRef.platform}')`);
  }
}

function assertGithubMsgRef(msgRef: MsgRef) {
  if (msgRef.platform !== "github") {
    throw new Error(`Expected github msgRef (got '${msgRef.platform}')`);
  }
}

export class GithubAdapter implements SurfaceAdapter {
  async connect(): Promise<void> {
    // No persistent connection.
  }

  async disconnect(): Promise<void> {
    // No persistent connection.
  }

  async getSelf(): Promise<SurfaceSelf> {
    // We don't have a stable user id for GitHub App installation tokens.
    // Best-effort: return a placeholder; webhook matching uses gh/app slug.
    return { platform: "github", userId: "github", userName: "github" };
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "github",
      send: true,
      edit: true,
      delete: false,
      reactions: true,
      readHistory: true,
      threads: false,
      markRead: false,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts): Promise<SurfaceOutputStream> {
    assertGithubSessionRef(sessionRef);
    const replyTo = opts?.replyTo;
    return new GithubOutputStream(sessionRef, replyTo ? { replyTo } : undefined);
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    assertGithubSessionRef(sessionRef);
    const thread = parseGithubSessionId(sessionRef.channelId);
    const text = content.text ?? "";
    if (!text.trim()) {
      throw new Error("github adapter: sendMsg requires non-empty text");
    }
    const res = await createIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      issueNumber: thread.number,
      body: text,
    });
    return {
      platform: "github",
      channelId: sessionRef.channelId,
      messageId: String(res.id),
    };
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    assertGithubMsgRef(msgRef);
    const thread = parseGithubSessionId(msgRef.channelId);

    // If messageId matches issue number, treat it as the PR/issue description.
    if (
      isGithubIssueTriggerId({
        sessionId: msgRef.channelId,
        triggerId: msgRef.messageId,
      })
    ) {
      const issue = await getIssue({
        owner: thread.owner,
        repo: thread.repo,
        number: thread.number,
      });
      return {
        ref: msgRef,
        session: { platform: "github", channelId: msgRef.channelId },
        userId: "github",
        userName: undefined,
        text: issue.body ?? "",
        ts: Date.now(),
        raw: issue,
      };
    }

    // Fetch comment via list (best-effort; keep adapter minimal).
    const comments = await listIssueComments({
      owner: thread.owner,
      repo: thread.repo,
      number: thread.number,
      limit: 100,
    });
    const id = Number(msgRef.messageId);
    const match = comments.find((c) => c.id === id);
    if (!match) return null;
    return {
      ref: msgRef,
      session: { platform: "github", channelId: msgRef.channelId },
      userId: typeof match.user?.login === "string" ? match.user.login : "unknown",
      userName: typeof match.user?.login === "string" ? match.user.login : undefined,
      text: typeof match.body === "string" ? match.body : "",
      ts: match.created_at ? Date.parse(match.created_at) : Date.now(),
      raw: match,
    };
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    assertGithubSessionRef(sessionRef);
    const thread = parseGithubSessionId(sessionRef.channelId);
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const comments = await listIssueComments({
      owner: thread.owner,
      repo: thread.repo,
      number: thread.number,
      limit,
    });
    return comments.map((c) => ({
      ref: {
        platform: "github",
        channelId: sessionRef.channelId,
        messageId: String(c.id),
      },
      session: sessionRef,
      userId: typeof c.user?.login === "string" ? c.user.login : "unknown",
      userName: typeof c.user?.login === "string" ? c.user.login : undefined,
      text: typeof c.body === "string" ? c.body : "",
      ts: c.created_at ? Date.parse(c.created_at) : Date.now(),
      raw: c,
    }));
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void> {
    assertGithubMsgRef(msgRef);
    const thread = parseGithubSessionId(msgRef.channelId);
    const body = content.text ?? "";
    if (!body.trim()) {
      throw new Error("github adapter: editMsg requires non-empty text");
    }
    const commentId = Number(msgRef.messageId);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      throw new Error(`github adapter: invalid comment id '${msgRef.messageId}'`);
    }
    await editIssueComment({
      owner: thread.owner,
      repo: thread.repo,
      commentId,
      body,
    });
  }

  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    throw new Error("github adapter: deleteMsg not supported");
  }

  async getReplyContext(sessionMsgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    assertGithubMsgRef(sessionMsgRef);
    const sessionRef: SessionRef = {
      platform: "github",
      channelId: sessionMsgRef.channelId,
    };
    return await this.listMsg(sessionRef, opts);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error(
      "github adapter: reactions should be handled via github-api helpers (needs reaction id for safe removal)",
    );
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error(
      "github adapter: reactions should be handled via github-api helpers (needs reaction id for safe removal)",
    );
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [];
  }

  async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
    // GitHub ingress is webhook-driven (not adapter subscription).
    return {
      stop: async () => undefined,
    };
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    return [];
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
    // no-op
  }
}
