import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";

import {
  decodeGithubWebhookEvent,
  projectGithubAuthenticatedActor,
} from "../../src/github/webhook/github-webhook-server";
import {
  claimGithubAcknowledgement,
  clearGithubAck,
  getGithubAck,
  getGithubLatestRequestForSession,
  restoreGithubLatestRequestForSession,
  rollbackGithubAcknowledgementClaim,
  setGithubAck,
  setGithubLatestRequestForSession,
} from "../../src/github/github-state";

describe("GitHub webhook actor projection", () => {
  it("omits anonymous actors instead of emitting an incomplete actor", () => {
    expect(projectGithubAuthenticatedActor(undefined)).toEqual({});
    expect(projectGithubAuthenticatedActor("")).toEqual({});
    expect(projectGithubAuthenticatedActor("octocat")).toEqual({
      authenticatedActor: { platform: "github", userId: "octocat" },
    });
  });
});

describe("github webhook signature", () => {
  it("projects supported payloads and bounds malformed or hostile payloads", () => {
    expect(
      decodeGithubWebhookEvent("issue_comment", {
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 7 },
        comment: { id: 9, body: "/lilac inspect", user: { login: "octocat" } },
        private_future_field: "ignored",
      }),
    ).toMatchObject({
      kind: "issue-comment-created",
      payload: { repository: { full_name: "owner/repo" }, issue: { number: 7 } },
    });
    expect(decodeGithubWebhookEvent("issue_comment", { action: "created" })).toEqual({
      kind: "unsupported",
      reason: "unsupported_event",
      action: "created",
    });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("private payload getter");
        },
      },
    );
    expect(decodeGithubWebhookEvent("issue_comment", hostile)).toEqual({
      kind: "unsupported",
      reason: "payload_invalid",
    });
  });

  it("treats an existing same-request acknowledgement as already owned", () => {
    const requestId = `github-review-${crypto.randomUUID()}`;
    const acknowledgement = {
      target: { kind: "issue" as const, issueNumber: 12 },
      reactionId: 42,
    };
    setGithubAck(requestId, acknowledgement);

    try {
      const claim = claimGithubAcknowledgement(requestId, requestId);
      expect(claim).toEqual({
        kind: "already-owned",
        requestId,
        acknowledgement,
      });
      expect(rollbackGithubAcknowledgementClaim(claim)).toBe(false);
      expect(getGithubAck(requestId)).toBe(acknowledgement);
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("transfers acknowledgement ownership to a distinct request", () => {
    const previousRequestId = `github-review-old-${crypto.randomUUID()}`;
    const requestId = `github-review-new-${crypto.randomUUID()}`;
    const acknowledgement = {
      target: { kind: "issue" as const, issueNumber: 12 },
      reactionId: 42,
    };
    setGithubAck(previousRequestId, acknowledgement);

    try {
      expect(claimGithubAcknowledgement(previousRequestId, requestId)).toEqual({
        kind: "transferred",
        previousRequestId,
        requestId,
        acknowledgement,
      });
      expect(getGithubAck(previousRequestId)).toBeUndefined();
      expect(getGithubAck(requestId)).toBe(acknowledgement);
    } finally {
      clearGithubAck(previousRequestId);
      clearGithubAck(requestId);
    }
  });

  it("rolls back acknowledgement ownership and latest request", () => {
    const sessionId = `owner/repo#${crypto.randomUUID()}`;
    const previousRequestId = `github-review-old-${crypto.randomUUID()}`;
    const requestId = `github-review-new-${crypto.randomUUID()}`;
    const acknowledgement = {
      target: { kind: "issue" as const, issueNumber: 12 },
      reactionId: 42,
    };
    setGithubAck(previousRequestId, acknowledgement);
    const initialLatestTransition = setGithubLatestRequestForSession(sessionId, previousRequestId);
    const claim = claimGithubAcknowledgement(previousRequestId, requestId);
    const latestTransition = setGithubLatestRequestForSession(sessionId, requestId);

    try {
      expect(rollbackGithubAcknowledgementClaim(claim)).toBe(true);
      expect(restoreGithubLatestRequestForSession(latestTransition)).toBe(true);
      expect(getGithubAck(previousRequestId)).toBe(acknowledgement);
      expect(getGithubAck(requestId)).toBeUndefined();
      expect(getGithubLatestRequestForSession(sessionId)).toBe(previousRequestId);
    } finally {
      clearGithubAck(previousRequestId);
      clearGithubAck(requestId);
      restoreGithubLatestRequestForSession(initialLatestTransition);
    }
  });

  it("does not clobber a newer acknowledgement or latest-request transition", () => {
    const sessionId = `owner/repo#${crypto.randomUUID()}`;
    const previousRequestId = `github-review-old-${crypto.randomUUID()}`;
    const requestId = `github-review-current-${crypto.randomUUID()}`;
    const newerRequestId = `github-review-newer-${crypto.randomUUID()}`;
    const acknowledgement = {
      target: { kind: "issue" as const, issueNumber: 12 },
      reactionId: 42,
    };
    setGithubAck(previousRequestId, acknowledgement);
    const initialLatestTransition = setGithubLatestRequestForSession(sessionId, previousRequestId);
    const failedClaim = claimGithubAcknowledgement(previousRequestId, requestId);
    const failedLatestTransition = setGithubLatestRequestForSession(sessionId, requestId);
    claimGithubAcknowledgement(requestId, newerRequestId);
    const newerLatestTransition = setGithubLatestRequestForSession(sessionId, newerRequestId);

    try {
      expect(rollbackGithubAcknowledgementClaim(failedClaim)).toBe(false);
      expect(restoreGithubLatestRequestForSession(failedLatestTransition)).toBe(false);
      expect(getGithubAck(previousRequestId)).toBeUndefined();
      expect(getGithubAck(requestId)).toBeUndefined();
      expect(getGithubAck(newerRequestId)).toBe(acknowledgement);
      expect(getGithubLatestRequestForSession(sessionId)).toBe(newerRequestId);
    } finally {
      clearGithubAck(previousRequestId);
      clearGithubAck(requestId);
      clearGithubAck(newerRequestId);
      restoreGithubLatestRequestForSession(newerLatestTransition);
      restoreGithubLatestRequestForSession(failedLatestTransition);
      restoreGithubLatestRequestForSession(initialLatestTransition);
    }
  });
});
