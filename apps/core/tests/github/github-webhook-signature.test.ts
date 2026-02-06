import { describe, expect, it } from "bun:test";

import crypto from "node:crypto";
import { verifyGithubWebhookSignature } from "../../src/github/webhook/github-webhook-server";

describe("github webhook signature", () => {
  it("verifies sha256 signature", () => {
    const secret = "shh";
    const raw = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("hex");

    expect(
      verifyGithubWebhookSignature({
        secret,
        signature256: `sha256=${digest}`,
        rawBody: raw,
      }),
    ).toBe(true);
  });

  it("rejects invalid signature", () => {
    const secret = "shh";
    const raw = new TextEncoder().encode("x");
    expect(
      verifyGithubWebhookSignature({
        secret,
        signature256:
          "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody: raw,
      }),
    ).toBe(false);
  });
});
