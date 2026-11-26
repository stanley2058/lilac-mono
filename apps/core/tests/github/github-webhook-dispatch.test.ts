import { describe, expect, it } from "bun:test";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { Result } from "better-result";
import {
  decodeGithubWebhookEvent,
  githubWebhookApi,
  handleEvent,
} from "../../src/github/webhook/github-webhook-server";
import {
  clearGithubRequest,
  getGithubLatestRequestForSession,
} from "../../src/github/github-state";

function fixture() {
  const publications: Array<{ payload: Record<string, unknown>; headers: Record<string, string> }> =
    [];
  const pages: number[] = [];
  const deleted: number[] = [];
  const api: typeof githubWebhookApi = {
    ...githubWebhookApi,
    getIssue: async () => ({ title: "issue", body: null, comments: 91 }),
    listIssueComments: async ({ page }) => {
      pages.push(page ?? 1);
      return [];
    },
    addEyesReactionToIssue: async () => 42,
    addEyesReactionToIssueComment: async () => 43,
    deleteIssueCommentReactionById: async ({ reactionId }) => {
      deleted.push(reactionId);
    },
    deleteIssueReactionById: async ({ reactionId }) => {
      deleted.push(reactionId);
    },
    hasGithubCollaboratorPermission: async () => true,
  };
  const bus = {
    publish: async (
      _type: string,
      payload: Record<string, unknown>,
      options: { headers: Record<string, string> },
    ) => {
      publications.push({ payload, headers: options.headers });
      return Result.ok({ duplicate: false });
    },
  } as unknown as LilacBus;
  const repo = `webhook-test/${crypto.randomUUID()}`;
  const run = (event: string, payload: unknown, deliveryId: string = crypto.randomUUID()) =>
    handleEvent({
      bus,
      api,
      logger: createLogger({ module: "webhook-dispatch-test" }),
      event,
      projected: decodeGithubWebhookEvent(event, payload),
      botLogins: ["lilac"],
      deliveryId,
    });
  const comment = {
    action: "created",
    repository: { full_name: repo },
    issue: { number: 1 },
    comment: {
      id: 123,
      body: "/lilac hello",
      author_association: "OWNER",
      user: { login: "stanley" },
    },
  };
  return {
    api,
    pages,
    deleted,
    publications,
    run,
    comment,
    session: `${repo}#1`,
  };
}

describe("GitHub webhook dispatch", () => {
  it("selects the recent comment page and owns the latest issue request", async () => {
    const f = fixture();
    const result = await f.run("issue_comment", f.comment, "delivery-one");
    expect(f.pages).toEqual([3, 4]);
    expect(getGithubLatestRequestForSession(f.session)).toBe(result.requestId);
    expect(f.publications[0]?.payload.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "stanley" },
    });
    clearGithubRequest(result.requestId!);
  });
  it("includes context when the trigger starts a new page", async () => {
    const f = fixture();
    f.api.getIssue = async () => ({ title: "issue", body: null, comments: 31 });
    f.api.listIssueComments = async ({ page }) => [
      { id: page ?? 1, body: page === 1 ? "previous context" : "/lilac hello" },
    ];
    const result = await f.run("issue_comment", f.comment);
    expect(JSON.stringify(f.publications)).toContain("previous context");
    clearGithubRequest(result.requestId!);
  });
  it("removes the acknowledgement when issue setup fails", async () => {
    const f = fixture();
    f.api.getIssue = async () => {
      throw new Error("issue unavailable");
    };
    await expect(f.run("issue_comment", f.comment)).rejects.toThrow("issue unavailable");
    expect(f.deleted).toEqual([43]);
    expect(getGithubLatestRequestForSession(f.session)).toBeUndefined();
  });
});
