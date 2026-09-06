import { describe, expect, test } from "bun:test";
import { Panic } from "better-result";
import type { CodexOAuthTokens } from "@stanley2058/lilac-utils/codex-oauth";
import { createCodexConnectionOptions } from "./connection";

const tokens: CodexOAuthTokens = {
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  accountId: "test-account",
  expires: Number.MAX_SAFE_INTEGER,
};

describe("Codex connection authorization", () => {
  test("resolves the Codex endpoint and refreshes identity from storage on every acquisition", async () => {
    let current = tokens;
    const resolve = createCodexConnectionOptions({
      responsesTransport: "websocket",
      readTokens: async () => current,
    });
    const initial = (await resolve(new AbortController().signal)).unwrap();
    expect(initial).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      websocketUrl: "wss://chatgpt.com/backend-api/codex/responses",
      mode: "websocket",
      headers: {
        authorization: "Bearer test-access",
        "chatgpt-account-id": "test-account",
        originator: "lilac",
      },
    });
    current = { ...tokens, access: "changed-access", accountId: "changed-account" };
    const changed = (await resolve(new AbortController().signal)).unwrap();
    expect(changed.headers).toMatchObject({
      authorization: "Bearer changed-access",
      "chatgpt-account-id": "changed-account",
    });
  });

  test("returns a safe pre-submission failure when OAuth is missing", async () => {
    const resolve = createCodexConnectionOptions({
      responsesTransport: "auto",
      readTokens: async () => null,
    });
    const result = await resolve(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ reason: "unavailable", replaySafety: "safe" });
  });

  test("pre-aborted acquisition does not read credentials", async () => {
    let read = false;
    const resolve = createCodexConnectionOptions({
      responsesTransport: "auto",
      readTokens: async () => {
        read = true;
        return tokens;
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect((await resolve(controller.signal)).isErr()).toBe(true);
    expect(read).toBe(false);
  });

  test("preserves credential-read Panic identity", async () => {
    const panic = new Panic({ message: "credential defect" });
    const resolve = createCodexConnectionOptions({
      responsesTransport: "auto",
      readTokens: async () => {
        throw panic;
      },
    });
    await expect(resolve(new AbortController().signal)).rejects.toBe(panic);
  });
});
