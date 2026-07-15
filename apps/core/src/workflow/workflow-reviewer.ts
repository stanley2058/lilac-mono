import type { RequestContext } from "../tool-server/types";
import type { AuthenticatedRequestOrigin } from "../tool-server/request-message-cache";
import type { SurfaceAdapter } from "../surface/adapter";
import type { MsgRef, SessionRef } from "../surface/types";

export type WorkflowReviewer = {
  platform: "discord" | "github";
  userId: string;
  sessionRef: SessionRef;
  originMessageRef: MsgRef | null;
};

export interface WorkflowReviewerResolver {
  resolve(context: RequestContext): Promise<WorkflowReviewer | null>;
}

export function createWorkflowReviewerResolver(input: {
  requestOrigins: {
    getOrigin(requestId: string): AuthenticatedRequestOrigin | undefined;
  };
  adapters: ReadonlyMap<"discord" | "github", SurfaceAdapter>;
}): WorkflowReviewerResolver {
  return {
    async resolve(context) {
      if (!context.requestId || !context.sessionId || !context.requestClient) return null;
      const origin = input.requestOrigins.getOrigin(context.requestId);
      if (
        !origin ||
        origin.sessionId !== context.sessionId ||
        origin.platform !== context.requestClient
      ) {
        return null;
      }

      const adapter = input.adapters.get(origin.platform);
      if (!adapter) return null;
      let userId = origin.actorUserId;
      if (origin.messageRef) {
        const message = await adapter.readMsg(origin.messageRef).catch(() => null);
        if (!message) return null;
        if (userId && message.userId !== userId && origin.platform !== "github") return null;
        userId ??= message.userId;
      }
      if (!userId) return null;

      const self = await adapter.getSelf().catch(() => null);
      if (self?.userId === userId || (origin.platform === "github" && userId.endsWith("[bot]"))) {
        return null;
      }

      return {
        platform: origin.platform,
        userId,
        sessionRef: { platform: origin.platform, channelId: origin.sessionId },
        originMessageRef: origin.messageRef,
      };
    },
  };
}
