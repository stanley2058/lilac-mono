import { describe, expect, it, spyOn } from "bun:test";
import crypto from "node:crypto";
import { createLogger } from "@stanley2058/lilac-utils";
import {
  createGithubWebhookApp,
  githubDeliveryId,
} from "../../src/github/webhook/github-webhook-server";

function request(body: string, signature = true, delivery = "delivery-1") {
  return new Request("http://localhost/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature
        ? `sha256=${crypto.createHmac("sha256", "test-secret").update(body).digest("hex")}`
        : "invalid",
    },
  });
}
function app(
  handle: Parameters<typeof createGithubWebhookApp>[0]["handle"],
  logger = createLogger({ module: "webhook-test" }),
) {
  return createGithubWebhookApp({
    secret: "test-secret",
    path: "/webhook",
    logger,
    handle,
    reportFatalError: (error) => {
      throw error;
    },
  }).compile();
}
describe("webhook ingress", () => {
  it("rejects oversized HTTP bodies before invoking the handler", async () => {
    let calls = 0;
    const server = app(async () => {
      calls++;
    }).listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.server!.port}/webhook`, {
        method: "POST",
        body: "x".repeat(2 * 1024 * 1024 + 1),
      });
      expect(response.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await server.stop();
    }
  });
  it("keeps dispatch details in the handled log", async () => {
    const logged = Promise.withResolvers<unknown>();
    const logger = createLogger({ module: "webhook-test" });
    const result = {
      action: "created",
      repoFullName: "owner/repo",
      handled: true,
      reason: "accepted",
      requestId: "request-1",
    };
    const log = spyOn(logger, "info").mockImplementation((message, fields) => {
      if (message === "github.webhook.handled") logged.resolve(fields);
    });
    try {
      expect((await app(async () => result, logger).handle(request("{}"))).status).toBe(200);
      expect(await logged.promise).toMatchObject({
        action: "created",
        repo: "owner/repo",
        handled: true,
        reason: "accepted",
        requestId: "request-1",
      });
    } finally {
      log.mockRestore();
    }
  });
  it("rejects invalid signatures and signed invalid JSON before handling", async () => {
    let calls = 0;
    const server = app(async () => {
      calls++;
    });
    expect((await server.handle(request("{}", false))).status).toBe(401);
    expect((await server.handle(request("{bad"))).status).toBe(400);
    expect(calls).toBe(0);
  });
  it("acknowledges before handling settles and dedupes only after success", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const logger = createLogger({ module: "webhook-test" });
    const log = spyOn(logger, "info").mockImplementation((message) => {
      if (message === "github.webhook.handled") finished.resolve();
    });
    let calls = 0;
    const server = app(async () => {
      calls++;
      started.resolve();
      await release.promise;
    }, logger);
    try {
      const response = await server.handle(request("{}"));
      expect(response.status).toBe(200);
      await started.promise;
      expect(calls).toBe(1);
      release.resolve();
      await finished.promise;
      expect(await (await server.handle(request("{}"))).json()).toMatchObject({ deduped: true });
      expect(calls).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
  it("allows retry after a handler failure", async () => {
    const failed = Promise.withResolvers<void>();
    const logger = createLogger({ module: "webhook-test" });
    const log = spyOn(logger, "error").mockImplementation(() => {
      failed.resolve();
    });
    const retried = Promise.withResolvers<void>();
    let calls = 0;
    const server = app(async () => {
      if (++calls === 1) throw new Error("temporary failure");
      retried.resolve();
    }, logger);
    try {
      expect((await server.handle(request("{}"))).status).toBe(200);
      await failed.promise;
      expect(await (await server.handle(request("{}"))).json()).toEqual({ ok: true });
      await retried.promise;
      expect(calls).toBe(2);
    } finally {
      log.mockRestore();
    }
  });
  it("derives stable, operation-specific delivery identities", () => {
    expect(githubDeliveryId("one", "prompt")).toBe(githubDeliveryId("one", "prompt"));
    expect(githubDeliveryId("one", "prompt")).not.toBe(githubDeliveryId("one", "interrupt"));
    expect(githubDeliveryId("one", "prompt")).not.toBe(githubDeliveryId("two", "prompt"));
  });
});
