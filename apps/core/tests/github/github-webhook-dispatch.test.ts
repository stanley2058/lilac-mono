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
  getGithubRequestMeta,
} from "../../src/github/github-state";

function fixture() {
  const publications: Array<{ payload: Record<string, unknown>; headers: Record<string, string> }> =
    [];
  const pages: number[] = [];
  const deleted: number[] = [];
  let sha = "head-1";
  const api: typeof githubWebhookApi = {
    ...githubWebhookApi,
    getIssue: async () => ({ title: "issue", body: null, comments: 91 }),
    getPullRequest: async () => ({
      title: "PR",
      body: null,
      head: { sha, ref: "branch" },
      base: { ref: "main" },
    }),
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
      return Result.ok(undefined);
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
  const review = {
    action: "review_requested",
    repository: { full_name: repo },
    pull_request: { number: 1, head: { sha } },
    requested_reviewer: { login: "lilac" },
    sender: { login: "stanley" },
  };
  return {
    api,
    pages,
    deleted,
    publications,
    run,
    comment,
    review,
    session: `${repo}#1`,
    changeHead: () => {
      sha = "head-2";
    },
  };
}

describe("GitHub webhook dispatch", () => {
  it("selects the recent comment page and owns the latest issue request", async () => {
    const f = fixture();
    const result = await f.run("issue_comment", f.comment, "delivery-one");
    expect(f.pages).toEqual([4]);
    expect(getGithubLatestRequestForSession(f.session)).toBe(result.requestId);
    expect(f.publications[0]?.payload.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "stanley" },
    });
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
  it("gives repeated review requests unique IDs and carries the original actor into synchronize", async () => {
    const f = fixture();
    const first = await f.run("pull_request", f.review, "first");
    const second = await f.run("pull_request", f.review, "second");
    expect(second.requestId).not.toBe(first.requestId);
    f.changeHead();
    const restarted = await f.run(
      "pull_request",
      { ...f.review, action: "synchronize", pull_request: { number: 1, head: { sha: "head-2" } } },
      "synchronize",
    );
    expect(f.publications[2]?.payload.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "stanley" },
    });
    expect(f.publications[2]?.payload.requestDeliveryId).not.toBe(
      f.publications[3]?.payload.requestDeliveryId,
    );
    expect(getGithubRequestMeta(restarted.requestId!)?.actorLogin).toBe("stanley");
    for (const request of [first, second, restarted]) clearGithubRequest(request.requestId!);
  });
});
