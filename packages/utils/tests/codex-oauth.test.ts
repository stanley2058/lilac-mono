import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearCodexTokens,
  parseCodexOAuthCallback,
  readCodexTokens,
  refreshAccessToken,
  startCodexOAuthLogin,
  writeCodexTokens,
  type CodexOAuthFetch,
  type CodexOAuthTokens,
} from "../codex-oauth";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function tokenFetch(calls: URLSearchParams[]): CodexOAuthFetch {
  return async (_input, init) => {
    calls.push(new URLSearchParams(String(init?.body)));
    return Response.json({
      id_token: jwt({ chatgpt_account_id: "account-123" }),
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 120,
    });
  };
}

function expectPortReleased(port: number): void {
  const probe = Bun.serve({
    hostname: "localhost",
    port,
    fetch: () => new Response("probe"),
  });
  probe.stop(true);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Codex OAuth login", () => {
  it("supports an isolated caller-provided token path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-storage-"));
    const storagePath = path.join(directory, "nested", "codex.json");
    const tokens: CodexOAuthTokens = {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 123,
    };
    try {
      await writeCodexTokens(tokens, storagePath);
      expect(await readCodexTokens(storagePath)).toEqual(tokens);
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(storagePath))).mode & 0o077).toBe(0);
        expect((await stat(storagePath)).mode & 0o077).toBe(0);
      }
      expect(
        (await readdir(path.dirname(storagePath))).filter((file) => file.endsWith(".tmp")),
      ).toEqual([]);
      await clearCodexTokens(storagePath);
      expect(await readCodexTokens(storagePath)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adds destination context and removes temporary files when a write fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-failure-"));
    const storagePath = path.join(directory, "codex.json");
    await mkdir(storagePath);
    let caught: unknown;
    try {
      await writeCodexTokens(
        { type: "oauth", access: "access", refresh: "refresh", expires: 123 },
        storagePath,
      );
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) throw new Error("Expected token write to fail");
      expect(caught.message).toContain(storagePath);
      expect(caught.cause).toBeDefined();
      expect((await readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates callback state, exchanges, stores account metadata, and stops the server", async () => {
    const calls: URLSearchParams[] = [];
    const writes: CodexOAuthTokens[] = [];
    const login = await startCodexOAuthLogin({
      port: 0,
      fetch: tokenFetch(calls),
      writeTokens: async (tokens) => {
        writes.push(tokens);
      },
      storagePath: "/test/codex.json",
      now: () => 1_000,
    });

    const callback = await fetch(`${login.redirectUri}?code=code-123&state=${login.state}`);
    expect(callback.status).toBe(200);
    expect(await login.result).toEqual({
      ok: true,
      accountId: "account-123",
      expires: 121_000,
      storagePath: "/test/codex.json",
    });
    expect(calls[0]?.get("code")).toBe("code-123");
    expect(calls[0]?.get("code_verifier")).toBe(login.pkce.verifier);
    expect(writes).toEqual([
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 121_000,
        accountId: "account-123",
        idToken: expect.any(String),
      },
    ]);
    expectPortReleased(login.port);
  });

  it("returns 400 for missing or mismatched state without settling the legitimate login", async () => {
    const calls: URLSearchParams[] = [];
    const login = await startCodexOAuthLogin({ port: 0, fetch: tokenFetch(calls) });
    const wrong = await fetch(`${login.redirectUri}?code=code-123&state=wrong`);
    const missing = await fetch(`${login.redirectUri}?code=code-123`);
    const cancel = await fetch(new URL("/cancel", login.redirectUri));

    expect(wrong.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(cancel.status).toBe(404);
    expect(calls).toHaveLength(0);
    const legitimate = await fetch(`${login.redirectUri}?code=code-123&state=${login.state}`);
    expect(legitimate.status).toBe(200);
    await expect(login.result).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expectPortReleased(login.port);
  });

  it("surfaces provider callback errors and cleans up", async () => {
    const calls: URLSearchParams[] = [];
    const login = await startCodexOAuthLogin({ port: 0, fetch: tokenFetch(calls) });
    const callback = await fetch(
      `${login.redirectUri}?error=access_denied&error_description=Nope&state=${login.state}`,
    );

    expect(callback.status).toBe(400);
    await expect(login.result).rejects.toThrow("OAuth error: Nope");
    expect(calls).toHaveLength(0);
    expectPortReleased(login.port);
  });

  it("supports manual callback parsing and exchange without a listener", async () => {
    const writes: CodexOAuthTokens[] = [];
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: tokenFetch([]),
      writeTokens: async (tokens) => {
        writes.push(tokens);
      },
    });
    const parsed = parseCodexOAuthCallback({
      callbackUrl: `${login.redirectUri}?code=manual&state=${login.state}`,
    });
    expect(parsed).toEqual({
      code: "manual",
      state: login.state,
      error: undefined,
      errorDescription: undefined,
    });
    await expect(
      login.exchange({ code: "manual", state: "wrong", pkceVerifier: login.pkce.verifier }),
    ).rejects.toThrow("Invalid state");
    await expect(
      login.exchange({ code: "manual", pkceVerifier: login.pkce.verifier }),
    ).rejects.toThrow("Invalid state");
    await login.exchange({
      callbackUrl: `${login.redirectUri}?code=manual&state=${login.state}`,
      pkceVerifier: login.pkce.verifier,
    });
    expect(writes).toHaveLength(1);
  });

  it("rejects the pending result when explicitly closed", async () => {
    const login = await startCodexOAuthLogin({ port: 0 });
    await login.close();
    await expect(login.result).rejects.toThrow("login closed");
  });

  it("aborts a deferred exchange and never writes tokens after close", async () => {
    const response = deferred<Response>();
    const fetchStarted = deferred<void>();
    const writes: CodexOAuthTokens[] = [];
    let signal: AbortSignal | undefined;
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        fetchStarted.resolve();
        return response.promise;
      },
      writeTokens: async (tokens) => {
        writes.push(tokens);
      },
    });
    const exchange = login.exchange({ code: "code", state: login.state });
    await fetchStarted.promise;

    const close = login.close();
    expect(signal?.aborted).toBe(true);
    response.resolve(
      Response.json({
        id_token: jwt({ chatgpt_account_id: "too-late" }),
        access_token: "too-late",
        refresh_token: "too-late",
      }),
    );

    await expect(exchange).rejects.toThrow("login closed");
    await close;
    expect(writes).toHaveLength(0);
  });

  it("waits for an active token write before close resolves", async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const writes: CodexOAuthTokens[] = [];
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: tokenFetch([]),
      writeTokens: async (tokens) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        writes.push(tokens);
      },
    });
    const exchange = login.exchange({ code: "code", state: login.state });
    await writeStarted.promise;

    let closeSettled = false;
    const close = login.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseWrite.resolve();
    await close;
    await expect(exchange).rejects.toThrow("login closed");
    expect(writes).toHaveLength(1);
  });

  it("allows only one exchange to run and rejects duplicates after completion", async () => {
    const response = deferred<Response>();
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: async () => response.promise,
      writeTokens: async () => {},
    });
    const first = login.exchange({ code: "first", state: login.state });

    await expect(login.exchange({ code: "second", state: login.state })).rejects.toThrow(
      "already in progress",
    );
    response.resolve(
      Response.json({
        id_token: jwt({}),
        access_token: "access",
        refresh_token: "refresh",
      }),
    );
    await first;
    await expect(login.exchange({ code: "third", state: login.state })).rejects.toThrow(
      "already completed",
    );
    await login.close();
  });
});

describe("Codex OAuth refresh", () => {
  it("accepts omitted ID and refresh tokens but still requires an access token", async () => {
    await expect(
      refreshAccessToken("refresh", async () =>
        Response.json({ access_token: "new-access", expires_in: 120 }),
      ),
    ).resolves.toEqual({ access_token: "new-access", expires_in: 120 });

    await expect(
      refreshAccessToken("refresh", async () => Response.json({ expires_in: 120 })),
    ).rejects.toThrow();
  });
});
