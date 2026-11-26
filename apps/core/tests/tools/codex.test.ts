import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import {
  startCodexOAuthLogin,
  type CodexOAuthFetch,
  type CodexOAuthLoginWithResult,
  type CodexOAuthTokens,
} from "@stanley2058/lilac-utils";

import { Codex, type CodexDependencies } from "../../src/tool-server/tools/codex";

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

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

async function deferredLogin(): Promise<{
  login: CodexOAuthLoginWithResult;
  started: Promise<void>;
  release: () => void;
  writes: CodexOAuthTokens[];
}> {
  const response = deferred<Response>();
  const fetchStarted = deferred<void>();
  const writes: CodexOAuthTokens[] = [];
  const fetch: CodexOAuthFetch = async () => {
    fetchStarted.resolve();
    return response.promise;
  };
  const login = await startCodexOAuthLogin({
    callbackServer: "disabled",
    fetch,
    writeTokens: async (tokens) => {
      writes.push(tokens);
    },
  });
  return {
    login,
    started: fetchStarted.promise,
    release: () =>
      response.resolve(
        Response.json({
          id_token: jwt({ chatgpt_account_id: "too-late" }),
          access_token: "too-late",
          refresh_token: "too-late",
        }),
      ),
    writes,
  };
}

function dependencies(
  startLogin: CodexDependencies["startLogin"],
  clearTokens: CodexDependencies["clearTokens"] = async () => Result.ok(undefined),
): CodexDependencies {
  return {
    startLogin,
    readTokens: async () => Result.ok({ value: null, provenance: "missing-defaulted" as const }),
    clearTokens,
    storagePath: () => "/test/codex.json",
  };
}

describe("Codex Core tool OAuth lifecycle", () => {
  it("requires state with a manually extracted authorization code", async () => {
    const tool = new Codex(
      dependencies(async () => {
        throw new Error("unexpected start");
      }),
    );

    expect(
      await tool.call("codex.login", {
        mode: "exchange",
        code: "code",
        pkceVerifier: "verifier",
      }),
    ).toMatchObject({
      status: "error",
      error: { kind: "usage", message: expect.stringContaining("requires state") },
    });
  });

  it("waits for a pending write before logout clears tokens", async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let storedAccess: string | null = "old-access";
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: async () =>
        Response.json({
          id_token: jwt({ chatgpt_account_id: "account" }),
          access_token: "new-access",
          refresh_token: "new-refresh",
        }),
      writeTokens: async (tokens) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        storedAccess = tokens.access;
      },
    });
    let cleared = false;
    const tool = new Codex(
      dependencies(
        async () => login,
        async () => {
          cleared = true;
          storedAccess = null;
          return Result.ok(undefined);
        },
      ),
    );
    expect(await tool.call("codex.login", { mode: "start" })).toMatchObject({ status: "ok" });
    const exchange = login.exchange({ code: "code", state: login.state });
    await writeStarted.promise;

    const logout = tool.call("codex.logout", {});
    await Promise.resolve();
    expect(cleared).toBe(false);

    releaseWrite.resolve();
    await logout;
    await expect(exchange).rejects.toThrow("login closed");
    expect(cleared).toBe(true);
    expect(storedAccess).toBeNull();
  });

  it("closes a superseded login and prevents its deferred exchange from writing", async () => {
    const first = await deferredLogin();
    const second = await deferredLogin();
    const logins = [first.login, second.login];
    const tool = new Codex(
      dependencies(async () => {
        const login = logins.shift();
        if (!login) throw new Error("unexpected start");
        return login;
      }),
    );
    expect(await tool.call("codex.login", { mode: "start" })).toMatchObject({ status: "ok" });
    const exchange = first.login.exchange({ code: "code", state: first.login.state });
    await first.started;

    const replacement = tool.call("codex.login", { mode: "start" });
    await expect(first.login.result).rejects.toThrow("login closed");
    first.release();
    await replacement;

    await expect(exchange).rejects.toThrow("login closed");
    expect(first.writes).toHaveLength(0);
    await tool.destroy();
  });

  it("clears the same pending login when its automatic result settles", async () => {
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: async () =>
        Response.json({
          id_token: jwt({}),
          access_token: "access",
          refresh_token: "refresh",
        }),
      writeTokens: async () => {},
    });
    const tool = new Codex(dependencies(async () => login));
    expect(await tool.call("codex.login", { mode: "start" })).toMatchObject({ status: "ok" });
    await login.exchange({ code: "code", state: login.state });
    await login.result;

    expect(
      await tool.call("codex.login", {
        mode: "exchange",
        code: "code",
        state: login.state,
        pkceVerifier: login.pkce.verifier,
      }),
    ).toMatchObject({
      status: "error",
      error: { kind: "conflict", message: expect.stringContaining("Missing PKCE challenge") },
    });
  });
});
