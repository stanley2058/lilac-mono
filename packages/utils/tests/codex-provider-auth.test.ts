import { afterEach, describe, expect, test } from "bun:test";
import { Panic } from "better-result";
import {
  clearCodexTokensResult,
  readCodexTokens,
  writeCodexTokens,
  type CodexOAuthTokens,
} from "../codex-oauth";
import { createCodexOAuthAuthorization } from "../codex-provider-auth";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const expired: CodexOAuthTokens = {
  type: "oauth",
  access: "expired",
  refresh: "refresh",
  expires: 0,
  accountId: "account",
};

describe("shared Codex OAuth authorization", () => {
  test("one caller can cancel a shared refresh while another receives rotated credentials", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<Response>();
    const secondRead = Promise.withResolvers<void>();
    let refreshCalls = 0;
    let reads = 0;
    let current = expired;
    globalThis.fetch = (async (_input, init) => {
      refreshCalls += 1;
      expect(init?.signal?.aborted).not.toBe(true);
      refreshStarted.resolve();
      return await releaseRefresh.promise;
    }) as typeof fetch;
    const authorize = createCodexOAuthAuthorization({
      readTokens: async () => {
        reads += 1;
        if (reads === 3) secondRead.resolve();
        return current;
      },
      writeTokens: async (tokens) => {
        current = tokens;
      },
    });
    const controller = new AbortController();
    const first = authorize(controller.signal).then(
      () => undefined,
      (error) => error,
    );
    await refreshStarted.promise;
    const second = authorize();
    await secondRead.promise;
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    expect(await first).toBe(reason);
    releaseRefresh.resolve(Response.json({ access_token: "fresh", refresh_token: "rotated" }));
    expect(await second).toEqual({
      authorization: "Bearer fresh",
      "chatgpt-account-id": "account",
      originator: "lilac",
    });
    expect(refreshCalls).toBe(1);
    expect(current.refresh).toBe("rotated");
  });

  test("retains the original Panic after a refresh failure and permits a later attempt", async () => {
    const panic = new Panic({ message: "refresh defect" });
    let calls = 0;
    let current = expired;
    globalThis.fetch = (async (_input, _init) => {
      calls += 1;
      if (calls === 1) throw panic;
      return Response.json({ access_token: "fresh" });
    }) as typeof fetch;
    const authorize = createCodexOAuthAuthorization({
      readTokens: async () => current,
      writeTokens: async (tokens) => {
        current = tokens;
      },
    });
    await expect(authorize()).rejects.toBe(panic);
    expect(await authorize()).toMatchObject({ authorization: "Bearer fresh" });
    expect(calls).toBe(2);
  });
});

test("default native and fallback factories share one refresh while callers cancel independently", async () => {
  await writeCodexTokens(expired);
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<Response>();
  let refreshCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    refreshCalls += 1;
    expect(init?.signal?.aborted).not.toBe(true);
    refreshStarted.resolve();
    return await releaseRefresh.promise;
  }) as typeof fetch;
  try {
    const nativeAuthorization = createCodexOAuthAuthorization();
    const fallbackAuthorization = createCodexOAuthAuthorization();
    expect(nativeAuthorization).toBe(fallbackAuthorization);
    const controller = new AbortController();
    const native = nativeAuthorization(controller.signal).then(
      () => undefined,
      (error) => error,
    );
    await refreshStarted.promise;
    const fallback = fallbackAuthorization();
    const reason = new DOMException("native caller cancelled", "AbortError");
    controller.abort(reason);
    expect(await native).toBe(reason);
    releaseRefresh.resolve(
      Response.json({ access_token: "shared-fresh", refresh_token: "shared-rotated" }),
    );
    expect(await fallback).toMatchObject({ authorization: "Bearer shared-fresh" });
    expect(refreshCalls).toBe(1);
    expect((await readCodexTokens())?.refresh).toBe("shared-rotated");
  } finally {
    releaseRefresh.resolve(Response.json({ access_token: "cleanup" }));
    expect((await clearCodexTokensResult()).isOk()).toBe(true);
  }
});

test("injected authorization stores retain isolated refresh coordinators", () => {
  const options = { readTokens: async () => expired, writeTokens: async () => {} };
  expect(createCodexOAuthAuthorization(options)).not.toBe(createCodexOAuthAuthorization(options));
});
