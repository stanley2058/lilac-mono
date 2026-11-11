import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { Result } from "better-result";
import { z } from "zod";
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";
import {
  createGithubWebhookApp,
  decodeGithubWebhookEvent,
  githubWebhookApi,
  handleEvent,
  superviseGithubWebhookHandler,
} from "../../src/github/webhook/github-webhook-server";
import {
  clearGithubRequest,
  getGithubAck,
  getGithubLatestRequestForSession,
  getGithubRequestMeta,
} from "../../src/github/github-state";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const core = await createRealCoreBusFixture();
  const { bus, transportBus, store } = core;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected external operation");
  };
  const received: LilacMessageForTopic<"cmd.request">[] = [];
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const subscription = requireBusOk(
    await transportBus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "github-contract",
        startFrom: "beginning",
        batch: { maxWaitMs: 10 },
      },
      async (message) => {
        received.push(message);
        waiters.get(received.length)?.resolve();
        return Result.ok(undefined);
      },
      () => "dead-letter",
    ),
  );
  const waitReceived = async (count: number) => {
    if (received.length < count) {
      const waiter = Promise.withResolvers<void>();
      waiters.set(count, waiter);
      await withBusDeadline(waiter.promise, `GitHub delivery ${count}`);
    }
    await core.waitForCommit(received[count - 1]!.id, "cmd.request");
  };
  const fetch = async () =>
    requireBusOk(await bus.fetchTopic("cmd.request", { offset: { type: "begin" }, limit: 100 }))
      .messages;
  const deleted: number[] = [];
  let sha = "head-1";
  const api: typeof githubWebhookApi = {
    addEyesReactionToIssue: async () => 42,
    addEyesReactionToIssueComment: async () => 43,
    getIssue: async () => ({ title: "Synthetic issue", body: null, comments: 1 }),
    getPullRequest: async () => ({
      title: "Synthetic PR",
      body: null,
      head: { sha, ref: "branch" },
      base: { ref: "main" },
    }),
    listIssueComments: async () => [],
    createIssueComment: unexpected,
    hasGithubCollaboratorPermission: async () => true,
    deleteIssueCommentReactionById: async ({ reactionId }) => {
      deleted.push(reactionId);
    },
    deleteIssueReactionById: async ({ reactionId }) => {
      deleted.push(reactionId);
    },
  };
  const repo = `synthetic/${crypto.randomUUID()}`;
  const session = `${repo}#1`;
  const requestIds = new Set<string>();
  const run = async (event: string, payload: unknown, deliveryId?: string) => {
    const result = await handleEvent({
      bus,
      api,
      logger: createLogger({ module: "github-durable-test" }),
      event,
      projected: decodeGithubWebhookEvent(event, payload),
      botLogins: ["lilac"],
      deliveryId,
    });
    if (result.requestId) requestIds.add(result.requestId);
    return result;
  };
  cleanups.push(async () => {
    for (const requestId of requestIds) clearGithubRequest(requestId);
    requireBusOk(await subscription.stop());
    await core.close();
  });
  return {
    bus,
    store,
    transportBus,
    core,
    received,
    waitReceived,
    fetch,
    deleted,
    api,
    session,
    run,
    changeHead: () => {
      sha = "head-2";
    },
    comment: {
      action: "created",
      repository: { full_name: repo },
      issue: { number: 1 },
      comment: {
        id: 123,
        body: "@lilac investigate",
        author_association: "OWNER",
        user: { login: "synthetic-owner" },
      },
    },
    review: {
      action: "review_requested",
      repository: { full_name: repo },
      pull_request: { number: 1, head: { sha } },
      requested_reviewer: { login: "lilac" },
      sender: { login: "synthetic-owner" },
    },
  };
}

describe("GitHub webhook real bus contracts", () => {
  it("delivers an authenticated HTTP mention through durable publication and typed Redis consumption", async () => {
    const f = await fixture();
    const finished = Promise.withResolvers<void>();
    const app = createGithubWebhookApp({
      secret: "test-secret",
      path: "/webhook",
      logger: createLogger({ module: "github-real-bus" }),
      reportFatalError: (error) => finished.reject(error),
      handle: async (event, projected, deliveryId) => {
        const result = await handleEvent({
          bus: f.bus,
          api: f.api,
          logger: createLogger({ module: "github-real-bus" }),
          event,
          projected,
          botLogins: ["lilac"],
          deliveryId,
        });
        if (result.requestId) cleanups.push(async () => clearGithubRequest(result.requestId!));
        finished.resolve();
      },
    }).compile();
    const body = JSON.stringify(f.comment);
    const request = (signature: string) =>
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-github-delivery": "mention-delivery",
          "x-hub-signature-256": signature,
        },
      });
    expect((await app.handle(request("sha256=invalid"))).status).toBe(401);
    expect(await f.fetch()).toHaveLength(0);
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    expect((await app.handle(request(signature))).status).toBe(200);
    await withBusDeadline(finished.promise, "webhook completion");
    await f.waitReceived(1);
    const message = f.received[0]!;
    expect(message.data.requestDeliveryId).toBe("2629def0-45cf-8cfe-bc73-3f5831f976b0");
    expect(message.headers).toMatchObject({
      request_id: `github:${f.session}:123`,
      session_id: f.session,
      request_client: "github",
    });
    expect(message.data.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "synthetic-owner" },
      github: { trigger: { kind: "comment", commentId: 123 } },
    });
    expect(requireBusOk(f.store.load(message.data.requestDeliveryId)).publication?.streamId).toBe(
      (await f.fetch())[0]!.cursor,
    );
    expect((await app.handle(request(signature))).status).toBe(200);
    expect(await f.fetch()).toHaveLength(1);
  });

  it("deduplicates delayed mentions and preserves newer acknowledgement ownership", async () => {
    const f = await fixture();
    const first = await f.run("issue_comment", f.comment, "first");
    const newer = await f.run(
      "issue_comment",
      { ...f.comment, comment: { ...f.comment.comment, id: 456 } },
      "newer",
    );
    const ack = getGithubAck(newer.requestId!);
    expect((await f.run("issue_comment", f.comment, "first")).requestId).toBe(first.requestId);
    await f.waitReceived(2);
    expect(await f.fetch()).toHaveLength(2);
    expect(getGithubLatestRequestForSession(f.session)).toBe(newer.requestId);
    expect(getGithubRequestMeta(newer.requestId!)?.superseded).not.toBe(true);
    expect(getGithubAck(newer.requestId!)).toEqual(ack);
    expect(f.deleted).toEqual([]);
  });

  it("delivers unique review, replacement and interrupt identities with the original actor", async () => {
    const f = await fixture();
    const first = await f.run("pull_request", f.review, "review-one");
    const second = await f.run("pull_request", f.review, "review-two");
    expect(first.requestId).not.toBe(second.requestId);
    f.changeHead();
    const sync = {
      ...f.review,
      action: "synchronize",
      pull_request: { number: 1, head: { sha: "head-2" } },
    };
    const replacement = await f.run("pull_request", sync, "synchronize");
    await f.waitReceived(4);
    expect(f.received.map((message) => message.data.queue)).toEqual([
      "prompt",
      "prompt",
      "prompt",
      "interrupt",
    ]);
    expect(new Set(f.received.map((message) => message.data.requestDeliveryId)).size).toBe(4);
    for (const message of f.received)
      expect(z.uuid().safeParse(message.data.requestDeliveryId).success).toBe(true);
    expect(f.received[2]!.headers?.request_id).toBe(replacement.requestId);
    expect(f.received[2]!.data.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "synthetic-owner" },
      github: { restartedFrom: second.requestId, headSha: "head-2" },
    });
    expect(f.received[3]!.headers?.request_id).toBe(second.requestId);
    expect(f.received[3]!.data.raw).toEqual({ cancel: true, requiresActive: true });
    expect(getGithubAck(second.requestId!)).toBeUndefined();
    expect(getGithubAck(replacement.requestId!)?.reactionId).toBe(42);
    await f.run("pull_request", sync, "synchronize");
    expect(await f.fetch()).toHaveLength(4);
  });

  it("keeps missing delivery headers valid and independent", async () => {
    const f = await fixture();
    await f.run("issue_comment", f.comment);
    await f.run("issue_comment", { ...f.comment, comment: { ...f.comment.comment, id: 456 } }, "");
    await f.waitReceived(2);
    expect(new Set(f.received.map((message) => message.data.requestDeliveryId)).size).toBe(2);
    for (const message of f.received)
      expect(z.uuid().safeParse(message.data.requestDeliveryId).success).toBe(true);
  });

  it("cleans failed mention state and delivers a retry through the same prepared identity", async () => {
    const f = await fixture();
    const publish = spyOn(f.core.raw, "publishClaimedRequest").mockRejectedValueOnce(
      new Error("Synthetic transport interruption"),
    );
    const result = await superviseGithubWebhookHandler({
      reportFatalError: (error) => {
        throw error;
      },
      run: () => f.run("issue_comment", f.comment, "retry-mention"),
    });
    publish.mockRestore();
    expect(result.isErr()).toBe(true);
    expect(await f.fetch()).toHaveLength(0);
    expect(f.deleted).toEqual([43]);
    expect(getGithubLatestRequestForSession(f.session)).toBeUndefined();
    expect(getGithubAck(`github:${f.session}:123`)).toBeUndefined();
    await f.run("issue_comment", f.comment, "retry-mention");
    await f.waitReceived(1);
    expect(await f.fetch()).toHaveLength(1);
  });

  for (const failureStage of ["before-write", "after-write"] as const) {
    it(`retries replacement cancellation after ${failureStage} failure without duplicate publication`, async () => {
      const f = await fixture();
      const original = await f.run("pull_request", f.review, "review");
      f.changeHead();
      const sync = {
        ...f.review,
        action: "synchronize",
        pull_request: { number: 1, head: { sha: "head-2" } },
      };
      const originalPublish = f.core.raw.publishClaimedRequest.bind(f.core.raw);
      const publish = spyOn(f.core.raw, "publishClaimedRequest").mockImplementation(
        async (...args) => {
          if (args[1].headers?.request_id !== original.requestId) return originalPublish(...args);
          if (failureStage === "after-write") await originalPublish(...args);
          throw new Error("Synthetic interrupt failure");
        },
      );
      const failed = await superviseGithubWebhookHandler({
        reportFatalError: (error) => {
          throw error;
        },
        run: () => f.run("pull_request", sync, "synchronize"),
      });
      publish.mockRestore();
      expect(failed.isErr()).toBe(true);
      expect(await f.fetch()).toHaveLength(failureStage === "before-write" ? 2 : 3);
      const replacementId = getGithubLatestRequestForSession(f.session)!;
      cleanups.push(async () => clearGithubRequest(replacementId));
      expect(replacementId).not.toBe(original.requestId);
      if (failureStage === "after-write") {
        const pending = getGithubRequestMeta(replacementId)!.pr!.pendingInterrupt!;
        // Model expiry of the interrupted producer's lease without waiting 30 seconds.
        expect(
          await f.core.redis.pexpire(
            `${f.core.keyPrefix}:v2:request-publication-claim:${pending.requestDeliveryId}`,
            0,
          ),
        ).toBe(1);
      }
      await f.run("pull_request", sync, "synchronize");
      expect((await f.fetch()).map(({ msg }) => msg.data.queue)).toEqual([
        "prompt",
        "prompt",
        "interrupt",
      ]);
      await f.waitReceived(3);
      expect(f.received[2]!.headers?.request_id).toBe(original.requestId);
      expect(getGithubLatestRequestForSession(f.session)).toBe(replacementId);
      expect(getGithubAck(replacementId)?.reactionId).toBe(42);
      await f.run("pull_request", sync, "synchronize");
      expect(await f.fetch()).toHaveLength(3);
    });
  }
});
