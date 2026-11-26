import { describe, expect, it, spyOn } from "bun:test";
import { Panic } from "better-result";

import { GithubApiError } from "../../../src/github/github-api";
import {
  createGithubRelayPolicy,
  type GithubAcknowledgementApi,
} from "../../../src/surface/github/github-runtime-descriptor";
import {
  clearGithubAck,
  getGithubAck,
  setGithubAck,
  type GithubAckState,
} from "../../../src/github/github-state";

function acknowledgementCleanup(input: {
  readonly requestId: string;
  readonly target: GithubAckState["target"];
  readonly api: GithubAcknowledgementApi;
  readonly sessionId?: string;
}) {
  setGithubAck(input.requestId, { target: input.target, reactionId: 42 });
  const cleanup = createGithubRelayPolicy({
    acknowledgementApi: input.api,
  }).finalization?.clearIngressAcknowledgement;
  if (!cleanup) throw new Error("GitHub acknowledgement cleanup is unavailable");
  return cleanup({ requestId: input.requestId, sessionId: input.sessionId ?? "octo/repo#12" });
}

describe("GitHub relay acknowledgement finalization", () => {
  it("treats a GitHub 404 deletion as completed cleanup", async () => {
    const requestId = `github-ack-404-${crypto.randomUUID()}`;
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw new GithubApiError(404, "/repos/octo/repo/issues/12/reactions/42", "missing");
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("ok");
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("does not classify a generic deletion error containing 404 as not found", async () => {
    const requestId = `github-ack-generic-404-${crypto.randomUUID()}`;
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw new Error("proxy request 404 timed out");
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("error");
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("owns malformed fallback session parsing as cleanup failure without calling GitHub", async () => {
    const requestId = `github-ack-malformed-session-${crypto.randomUUID()}`;
    let deleteCalls = 0;
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        deleteCalls += 1;
      },
      deleteIssueCommentReactionById: async () => {
        deleteCalls += 1;
      },
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        sessionId: "malformed",
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("error");
      if (cleaned.status === "error") {
        expect(cleaned.error._tag).toBe("SurfaceIngressAcknowledgementCleanupFailed");
      }
      expect(deleteCalls).toBe(0);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("returns a narrow failure without logging when deletion fails", async () => {
    const requestId = `github-ack-failure-${crypto.randomUUID()}`;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw new Error("GitHub API unavailable");
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("error");
      if (cleaned.status === "error") {
        expect(cleaned.error._tag).toBe("SurfaceIngressAcknowledgementCleanupFailed");
        expect(cleaned.error.cause).toMatchObject({
          errorTag: "GithubAcknowledgementDeleteFailed",
          errorMessage: "Failed to delete GitHub acknowledgement reaction",
        });
        expect(JSON.stringify(cleaned.error.cause)).not.toContain("GitHub API unavailable");
      }
      expect(getGithubAck(requestId)).toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      clearGithubAck(requestId);
    }
  });

  it("preserves Panic while still clearing acknowledgement state", async () => {
    const requestId = `github-ack-panic-${crypto.randomUUID()}`;
    const panic = new Panic({ message: "GitHub acknowledgement invariant failed" });
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw panic;
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      await expect(
        acknowledgementCleanup({
          requestId,
          target: { kind: "issue", issueNumber: 12 },
          api,
        }),
      ).rejects.toBe(panic);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });
});
