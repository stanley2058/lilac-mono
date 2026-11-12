import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  EventPublishContractInvalid,
  lilacEventTypes,
  type RawBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import type { Result } from "better-result";
import { z } from "zod";

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
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  type CorePreparedRequestEnvelope,
} from "../../src/surface/bridge/request-delivery";
import { corePreparedRequestEnvelopeSchema } from "../../src/surface/bridge/request-delivery/core-integration";

function value<T, E extends Error>(result: Result<T, E>): T {
  return result.match({
    ok: (resultValue) => resultValue,
    err: (error) => {
      throw error;
    },
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(dbPath = ":memory:") {
  const store = new SqliteRequestDeliveryStore({
    dbPath,
    codecs: coreRequestDeliveryCodecs,
  });
  const blobs = value(await createMemoryBlobStore());
  const coordinator = new RequestDeliveryCoordinator({
    store,
    blobStore: blobs,
    admission: createCoreRequestDeliveryAdmission(blobs),
  });
  const publications: CorePreparedRequestEnvelope[] = [];
  let failPublication = false;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected external operation");
  };
  const raw: RawBus = {
    publish: unexpected,
    async acquireRequestPublicationClaim(requestDeliveryId) {
      return { status: "acquired", claim: { requestDeliveryId, token: crypto.randomUUID() } };
    },
    async publishClaimedRequest(message, options, claim) {
      if (failPublication) throw new Error("Synthetic transport failure");
      const envelope = corePreparedRequestEnvelopeSchema.parse({
        headers: options.headers,
        data: message.data,
      });
      expect(value(store.load(claim.requestDeliveryId)).state).toBe("prepared");
      publications.push(envelope);
      const id = `${publications.length}-0`;
      return { status: "published", receipt: { id, cursor: id } };
    },
    async confirmRequestPublication() {
      return "confirmed";
    },
    async abandonRequestPublicationClaim() {
      return "abandoned";
    },
    subscribe: unexpected,
    fetch: unexpected,
    close: async () => {},
  };
  const transportBus = createLilacBus(raw);
  const bus = createDurableCoreRequestBus({
    transportBus,
    coordinator,
    publisher: createLilacBusRequestDeliveryPublisher(transportBus),
  });
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
    store.close();
    if (dbPath !== ":memory:") rmSync(path.dirname(dbPath), { recursive: true, force: true });
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });
  return {
    bus,
    store,
    coordinator,
    transportBus,
    publications,
    deleted,
    api,
    session,
    run,
    failPublication: () => {
      failPublication = true;
    },
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

describe("GitHub webhook durable delivery", () => {
  it("publishes a mention with a delivery header through the UUID contract and retains its acknowledgement", async () => {
    const f = await fixture();
    const result = await f.run("issue_comment", f.comment, "mention-delivery");
    expect(result.handled).toBe(true);
    expect(f.publications).toHaveLength(1);
    const envelope = f.publications[0]!;
    expect(z.uuid().safeParse(envelope.data.requestDeliveryId).success).toBe(true);
    expect(envelope.data.requestDeliveryId).toBe("2629def0-45cf-8cfe-bc73-3f5831f976b0");
    expect(envelope.headers).toEqual({
      request_id: result.requestId!,
      session_id: f.session,
      request_client: "github",
    });
    expect(envelope.data.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "synthetic-owner" },
      github: { trigger: { kind: "comment", commentId: 123 } },
    });
    expect(value(f.store.load(envelope.data.requestDeliveryId)).publication?.streamId).toBe("1-0");
    expect(getGithubAck(result.requestId!)?.reactionId).toBe(43);
    expect(getGithubLatestRequestForSession(f.session)).toBe(result.requestId);
    expect(f.deleted).toEqual([]);
  });

  it("deduplicates a delayed mention with the real coordinator and preserves newer ownership", async () => {
    const f = await fixture();
    const first = await f.run("issue_comment", f.comment, "first");
    const newer = await f.run(
      "issue_comment",
      { ...f.comment, comment: { ...f.comment.comment, id: 456 } },
      "newer",
    );
    const before = getGithubAck(newer.requestId!);
    const duplicate = await f.run("issue_comment", f.comment, "first");
    expect(duplicate.requestId).toBe(first.requestId);
    expect(f.publications).toHaveLength(2);
    expect(new Set(f.publications.map((entry) => entry.data.requestDeliveryId)).size).toBe(2);
    expect(getGithubLatestRequestForSession(f.session)).toBe(newer.requestId);
    expect(getGithubRequestMeta(newer.requestId!)?.superseded).not.toBe(true);
    expect(getGithubAck(newer.requestId!)).toEqual(before);
    expect(f.deleted).toEqual([]);
  });

  it("publishes distinct review, replacement and interrupt identities and transfers acknowledgement ownership", async () => {
    const f = await fixture();
    const first = await f.run("pull_request", f.review, "review-one");
    const second = await f.run("pull_request", f.review, "review-two");
    expect(second.requestId).not.toBe(first.requestId);
    f.changeHead();
    const replacement = await f.run(
      "pull_request",
      { ...f.review, action: "synchronize", pull_request: { number: 1, head: { sha: "head-2" } } },
      "synchronize",
    );
    expect(f.publications.map((entry) => entry.data.queue)).toEqual([
      "prompt",
      "prompt",
      "prompt",
      "interrupt",
    ]);
    expect(new Set(f.publications.map((entry) => entry.data.requestDeliveryId)).size).toBe(4);
    expect(f.publications[2]?.headers.request_id).toBe(replacement.requestId);
    expect(f.publications[3]?.headers.request_id).toBe(second.requestId);
    expect(f.publications[2]?.data.raw).toMatchObject({
      authenticatedActor: { platform: "github", userId: "synthetic-owner" },
      github: { restartedFrom: second.requestId, headSha: "head-2" },
    });
    expect(f.publications[3]?.data.raw).toEqual({ cancel: true, requiresActive: true });
    expect(getGithubAck(second.requestId!)).toBeUndefined();
    expect(getGithubAck(replacement.requestId!)?.reactionId).toBe(42);
    expect(getGithubLatestRequestForSession(f.session)).toBe(replacement.requestId);
    expect(f.deleted).toEqual([]);
  });

  it("keeps generated UUIDs for missing and empty delivery headers", async () => {
    const f = await fixture();
    await f.run("issue_comment", f.comment);
    await f.run("issue_comment", { ...f.comment, comment: { ...f.comment.comment, id: 456 } }, "");
    expect(f.publications).toHaveLength(2);
    expect(f.publications[0]?.data.requestDeliveryId).not.toBe(
      f.publications[1]?.data.requestDeliveryId,
    );
    for (const entry of f.publications)
      expect(z.uuid().safeParse(entry.data.requestDeliveryId).success).toBe(true);
  });

  it("cleans acknowledgement and request state on a real durable publication failure", async () => {
    const f = await fixture();
    f.failPublication();
    const result = await superviseGithubWebhookHandler({
      reportFatalError: (error) => {
        throw error;
      },
      run: () => f.run("issue_comment", f.comment, "failed-delivery"),
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected publication failure");
    expect(result.error).toMatchObject({
      _tag: "GithubWebhookOperationError",
      cause: { _tag: "EventPublishTransportFailed" },
    });
    expect(f.publications).toHaveLength(0);
    expect(f.deleted).toEqual([43]);
    const requestId = `github:${f.session}:123`;
    expect(getGithubAck(requestId)).toBeUndefined();
    expect(getGithubRequestMeta(requestId)).toBeUndefined();
    expect(getGithubLatestRequestForSession(f.session)).toBeUndefined();
  });

  it("keeps invalid delivery identities rejected before durable preparation", async () => {
    const f = await fixture();
    const prepare = spyOn(f.coordinator, "prepareAndPublish");
    const result = await f.bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: "github-delivery:invalid:prompt",
        queue: "prompt",
        messages: [{ role: "user", content: "synthetic" }],
      },
      { headers: { request_id: "synthetic", session_id: f.session, request_client: "github" } },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("EventPublishContractInvalid");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.publications).toHaveLength(0);
    prepare.mockRestore();
  });

  it("deduplicates a redelivery after its request completed and the store reopened", async () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "github-redelivery-")), "rd.db");
    const f = await fixture(dbPath);
    const first = await f.run("issue_comment", f.comment, "completed-delivery");
    const requestDeliveryId = f.publications[0]!.data.requestDeliveryId;
    value(await f.coordinator.handleDelivery(requestDeliveryId));
    value(
      await f.coordinator.terminalize({
        requestDeliveryId,
        outcome: { kind: "completed" },
        transportCommitRequired: false,
      }),
    );
    expect(value(await f.coordinator.maintain()).tombstonesDeleted).toBe(1);
    clearGithubRequest(first.requestId!);
    f.store.close();

    // Reopening the database stands in for a Core restart: process memory is gone.
    const reopened = new SqliteRequestDeliveryStore({ dbPath, codecs: coreRequestDeliveryCodecs });
    const handled: Array<string | undefined> = [];
    const reached = Promise.withResolvers<void>();
    const app = createGithubWebhookApp({
      secret: "test-secret",
      path: "/webhook",
      logger: createLogger({ module: "github-redelivery-test" }),
      hasPublishedRequest: (id) => reopened.hasReceipt(id),
      handle: async (_event, _projected, deliveryId) => {
        handled.push(deliveryId);
        reached.resolve();
      },
      reportFatalError: (cause) => {
        throw cause;
      },
    }).compile();
    const deliver = async (deliveryId: string) => {
      const body = JSON.stringify(f.comment);
      const response = await app.handle(
        new Request("http://localhost/webhook", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": deliveryId,
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      return { status: response.status, body: await response.json() };
    };
    try {
      expect(await deliver("completed-delivery")).toEqual({
        status: 200,
        body: { ok: true, deduped: true },
      });
      expect(handled).toEqual([]);
      expect(await deliver("new-delivery")).toEqual({ status: 200, body: { ok: true } });
      await reached.promise;
      expect(handled).toEqual(["new-delivery"]);
    } finally {
      reopened.close();
    }
  });

  it("logs a redacted nested contract error while retaining the handler error", async () => {
    const logger = createLogger({ module: "github-contract-log-test" });
    const logged = Promise.withResolvers<unknown>();
    const log = spyOn(logger, "error").mockImplementation((_message, fields) =>
      logged.resolve(fields),
    );
    const error = new EventPublishContractInvalid({
      eventType: lilacEventTypes.CmdRequestMessage,
      message: "Invalid UUID at data.requestDeliveryId; token=synthetic-private-value",
    });
    const body = "{}";
    const app = createGithubWebhookApp({
      secret: "test-secret",
      path: "/webhook",
      logger,
      handle: async () => {
        throw error;
      },
      reportFatalError: (cause) => {
        throw cause;
      },
    }).compile();
    try {
      const response = await app.handle(
        new Request("http://localhost/webhook", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`,
          },
        }),
      );
      expect(response.status).toBe(200);
      const fields = await logged.promise;
      expect(fields).toMatchObject({
        errorTag: "GithubWebhookOperationError",
        errorMessage: expect.stringContaining(
          "EventPublishContractInvalid: Invalid UUID at data.requestDeliveryId; token=<redacted>",
        ),
      });
      expect(JSON.stringify(fields)).not.toContain("synthetic-private-value");
    } finally {
      log.mockRestore();
    }
  });
});
