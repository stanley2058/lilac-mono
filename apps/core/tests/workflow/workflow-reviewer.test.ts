import { describe, expect, it } from "bun:test";

import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { createWorkflowReviewerResolver } from "../../src/workflow/workflow-reviewer";
import type { AuthenticatedRequestOrigin } from "../../src/tool-server/request-message-cache";

class ReviewerAdapter implements SurfaceAdapter {
  constructor(
    private readonly platform: "discord" | "github",
    private readonly message: SurfaceMessage | null,
  ) {}

  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }
  async getCapabilities() {
    return {
      platform: this.platform,
      send: true,
      edit: true,
      delete: false,
      reactions: false,
      readHistory: true,
      threads: false,
      markRead: false,
    };
  }
  async listSessions() {
    return [];
  }
  async startOutput(): Promise<SurfaceOutputStream> {
    throw new Error("not used");
  }
  async sendMsg(_session: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    throw new Error("not used");
  }
  async readMsg() {
    return this.message;
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return [];
  }
  async editMsg() {}
  async deleteMsg() {}
  async getReplyContext() {
    return [];
  }
  async addReaction() {}
  async removeReaction() {}
  async listReactions() {
    return [];
  }
  async subscribe(_handler: AdapterEventHandler) {
    return { stop: async () => {} };
  }
  async getUnRead() {
    return [];
  }
  async markRead() {}
}

describe("workflow reviewer resolution", () => {
  it("requires server-owned origin state and resolves the originating human", async () => {
    const origin: AuthenticatedRequestOrigin = {
      requestId: "discord:channel-1:message-1",
      sessionId: "channel-1",
      platform: "discord",
      messageRef: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
      actorUserId: null,
    };
    const adapter = new ReviewerAdapter("discord", {
      ref: { platform: "discord", channelId: "channel-1", messageId: "message-1" },
      session: { platform: "discord", channelId: "channel-1" },
      userId: "user-1",
      text: "run it",
      ts: 1,
    });
    const resolver = createWorkflowReviewerResolver({
      requestOrigins: {
        getOrigin: (requestId) => (requestId === origin.requestId ? origin : undefined),
      },
      adapters: new Map([["discord", adapter]]),
    });

    await expect(
      resolver.resolve({
        requestId: origin.requestId,
        sessionId: "channel-1",
        requestClient: "discord",
      }),
    ).resolves.toMatchObject({ userId: "user-1", platform: "discord" });
    await expect(
      resolver.resolve({
        requestId: origin.requestId,
        sessionId: "forged-channel",
        requestClient: "discord",
      }),
    ).resolves.toBeNull();
    await expect(
      resolver.resolve({
        requestId: "forged-request",
        sessionId: "channel-1",
        requestClient: "discord",
      }),
    ).resolves.toBeNull();
  });

  it("rejects bot actors so an agent cannot become the reviewer", async () => {
    const origin: AuthenticatedRequestOrigin = {
      requestId: "github:owner/repo#1:1",
      sessionId: "owner/repo#1",
      platform: "github",
      messageRef: { platform: "github", channelId: "owner/repo#1", messageId: "1" },
      actorUserId: "lilac[bot]",
    };
    const resolver = createWorkflowReviewerResolver({
      requestOrigins: { getOrigin: () => origin },
      adapters: new Map([["github", new ReviewerAdapter("github", null)]]),
    });
    expect(
      await resolver.resolve({
        requestId: origin.requestId,
        sessionId: origin.sessionId,
        requestClient: origin.platform,
      }),
    ).toBeNull();
  });
});
