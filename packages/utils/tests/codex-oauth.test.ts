import { describe, expect, it, jest } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Panic } from "better-result";

import {
  clearCodexTokensResult,
  codexTokensCodecCases,
  decodeCodexTokens,
  exchangeCodeForTokens,
  parseCodexOAuthCallback,
  readCodexTokens,
  readCodexTokensResult,
  refreshAccessToken,
  refreshAccessTokenResult,
  startCodexOAuthLogin,
  writeCodexTokens,
  writeCodexTokensResult,
  writeSecretFileResult,
  type CodexSecretFileOperations,
  type CodexOAuthFetch,
  type CodexOAuthTokens,
} from "../codex-oauth";
import { formatTaggedErrorForLog } from "../tagged-error-log";

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

function secretFileOperations(
  overrides: Partial<CodexSecretFileOperations> = {},
): CodexSecretFileOperations {
  const handle = {
    writeFile: async () => {},
    sync: async () => {},
    close: async () => {},
  };
  return {
    ensureDirectory: async () => {},
    openTemporaryFile: async () => handle,
    openDirectory: async () => handle,
    rename: async () => {},
    chmod: async () => {},
    unlink: async () => {},
    syncDirectory: false,
    ...overrides,
  };
}

describe("Codex OAuth login", () => {
  it("classifies every persisted token codec outcome", () => {
    const current = decodeCodexTokens(codexTokensCodecCases.current.input);
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const legacy = decodeCodexTokens(codexTokensCodecCases.legacy.input);
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") expect(legacy.value.provenance).toBe("migrated");

    const missing = decodeCodexTokens(codexTokensCodecCases["missing-defaulted"].input);
    expect(missing.status).toBe("ok");
    if (missing.status === "ok") {
      expect(missing.value.provenance).toBe("missing-defaulted");
      expect(missing.value.value).toBeNull();
    }

    const unsupported = decodeCodexTokens(codexTokensCodecCases["unsupported-version"].input);
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("CodexTokensUnsupportedVersion");
    }

    const malformed = decodeCodexTokens(codexTokensCodecCases["malformed-serialization"].input);
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") expect(malformed.error._tag).toBe("CodexTokensMalformed");

    const corrupt = decodeCodexTokens(codexTokensCodecCases["corrupt-fields"].input);
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("CodexTokensCorrupt");

    const loggedOut = decodeCodexTokens({ serialized: "{}", storagePath: "/tmp/codex.json" });
    expect(loggedOut.status).toBe("ok");
    if (loggedOut.status === "ok") {
      expect(loggedOut.value).toEqual({ value: null, provenance: "current" });
    }
  });

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
      const readResult = await readCodexTokensResult(storagePath);
      expect(readResult.status).toBe("ok");
      if (readResult.status === "ok") expect(readResult.value.provenance).toBe("current");
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(storagePath))).mode & 0o077).toBe(0);
        expect((await stat(storagePath)).mode & 0o077).toBe(0);
      }
      expect(
        (await readdir(path.dirname(storagePath))).filter((file) => file.endsWith(".tmp")),
      ).toEqual([]);
      expect((await clearCodexTokensResult(storagePath)).isOk()).toBe(true);
      expect(await readCodexTokens(storagePath)).toBeNull();
      const cleared = await readCodexTokensResult(storagePath);
      expect(cleared.status).toBe("ok");
      if (cleared.status === "ok") {
        expect(cleared.value).toEqual({ value: null, provenance: "current" });
      }
      expect(await readFile(storagePath, "utf8")).toBe("{}\n");
      await readCodexTokensResult(storagePath);
      expect(await readFile(storagePath, "utf8")).toBe("{}\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports cleanup-only and combined secret write failures with exact causes", async () => {
    const writeFailure = new Error("write failed");
    const closeFailure = new Error("close failed");
    const unlinkFailure = new Error("unlink failed");
    let unlinkAttempts = 0;

    const cleanupOnly = await writeSecretFileResult(
      "/secret/codex.json",
      "{}\n",
      secretFileOperations({
        openTemporaryFile: async () => ({
          writeFile: async () => {},
          sync: async () => {},
          close: async () => {
            throw closeFailure;
          },
        }),
        unlink: async () => {
          unlinkAttempts += 1;
        },
      }),
    );
    expect(cleanupOnly.status).toBe("error");
    if (cleanupOnly.status === "error") {
      expect(cleanupOnly.error._tag).toBe("CodexTokensCleanupFailed");
      if (cleanupOnly.error._tag === "CodexTokensCleanupFailed") {
        expect(cleanupOnly.error.causes).toEqual([closeFailure]);
      }
    }

    const combined = await writeSecretFileResult(
      "/secret/codex.json",
      "{}\n",
      secretFileOperations({
        openTemporaryFile: async () => ({
          writeFile: async () => {
            throw writeFailure;
          },
          sync: async () => {},
          close: async () => {
            throw closeFailure;
          },
        }),
        unlink: async () => {
          unlinkAttempts += 1;
          throw unlinkFailure;
        },
      }),
    );
    expect(combined.status).toBe("error");
    if (combined.status === "error") {
      expect(combined.error._tag).toBe("CodexTokensWriteAndCleanupFailed");
      if (combined.error._tag === "CodexTokensWriteAndCleanupFailed") {
        expect(combined.error.writeError.cause).toBe(writeFailure);
        expect(combined.error.cleanupError.causes).toEqual([closeFailure, unlinkFailure]);
      }
    }
    expect(unlinkAttempts).toBe(2);
  });

  it("attempts every cleanup before rethrowing an exact Panic", async () => {
    const panic = new Panic({ message: "write invariant" });
    const cleanupAttempts: string[] = [];
    let caught: unknown;
    try {
      await writeSecretFileResult(
        "/secret/codex.json",
        "{}\n",
        secretFileOperations({
          openTemporaryFile: async () => ({
            writeFile: async () => {
              throw panic;
            },
            sync: async () => {},
            close: async () => {
              cleanupAttempts.push("close");
            },
          }),
          unlink: async () => {
            cleanupAttempts.push("unlink");
          },
        }),
      );
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(panic);
    expect(cleanupAttempts).toEqual(["close", "unlink"]);

    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    const laterCleanupAttempts: string[] = [];
    caught = undefined;
    try {
      await writeSecretFileResult(
        "/secret/codex.json",
        "{}\n",
        secretFileOperations({
          openTemporaryFile: async () => ({
            writeFile: async () => {},
            sync: async () => {},
            close: async () => {
              throw cleanupPanic;
            },
          }),
          unlink: async () => {
            laterCleanupAttempts.push("unlink");
          },
        }),
      );
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(cleanupPanic);
    expect(laterCleanupAttempts).toEqual(["unlink"]);
  });

  it("preserves legacy write AggregateError ordering and external rejection identity", async () => {
    const writeFailure = new Error("write failed");
    const closeFailure = new Error("close failed");
    const unlinkFailure = new Error("unlink failed");
    let caught: unknown;
    try {
      await writeCodexTokens(
        { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
        "/secret/codex.json",
        secretFileOperations({
          openTemporaryFile: async () => ({
            writeFile: async () => {
              throw writeFailure;
            },
            sync: async () => {},
            close: async () => {
              throw closeFailure;
            },
          }),
          unlink: async () => {
            throw unlinkFailure;
          },
        }),
      );
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (caught instanceof AggregateError) {
      expect(caught.errors).toEqual([writeFailure, closeFailure, unlinkFailure]);
    }

    const requestFailure = new Error("request failed");
    await expect(
      exchangeCodeForTokens({
        code: "code",
        redirectUri: "http://localhost/callback",
        pkce: { verifier: "verifier", challenge: "challenge" },
        fetch: async () => {
          throw requestFailure;
        },
      }),
    ).rejects.toBe(requestFailure);
  });

  it("keeps secrets out of the approved TaggedError log projection", async () => {
    const secret = "sk-review-secret-value";
    const result = await refreshAccessTokenResult("refresh", async () => {
      throw new Error(secret);
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(JSON.stringify(formatTaggedErrorForLog(result.error))).not.toContain(secret);
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
      expect(caught.constructor).toBe(Error);
      expect(caught.message).toContain(storagePath);
      expect(caught.cause).toBeDefined();
      expect((await readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      const result = await writeCodexTokensResult(
        { type: "oauth", access: "access", refresh: "refresh", expires: 123 },
        storagePath,
      );
      expect(result.status).toBe("error");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes malformed persisted tokens and invalid refresh responses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-corrupt-"));
    const storagePath = path.join(directory, "codex.json");
    try {
      await Bun.write(storagePath, "not-json");
      const read = await readCodexTokensResult(storagePath);
      expect(read.status).toBe("error");
      if (read.status === "error") expect(read.error._tag).toBe("CodexTokensMalformed");

      await Bun.write(
        storagePath,
        JSON.stringify({ access: "legacy-access", refresh: "legacy-refresh", expires: 1 }),
      );
      const legacySerialization = await readFile(storagePath, "utf8");
      const legacy = await readCodexTokensResult(storagePath);
      expect(legacy.status).toBe("ok");
      if (legacy.status === "ok") {
        expect(legacy.value.provenance).toBe("migrated");
        expect(legacy.value.value?.type).toBe("oauth");
      }
      expect(await readFile(storagePath, "utf8")).toBe(legacySerialization);

      const refresh = await refreshAccessTokenResult("refresh", async () => Response.json({}));
      expect(refresh.status).toBe("error");
      if (refresh.status === "error") expect(refresh.error._tag).toBe("CodexOAuthResponseInvalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy token reads best-effort when an existing path cannot be decoded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-unreadable-"));
    const storagePath = path.join(directory, "codex.json");
    await mkdir(storagePath);
    try {
      expect(await readCodexTokens(storagePath)).toBeNull();
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
    const invalidState = await login.exchangeResult({
      code: "manual",
      state: "wrong",
      pkceVerifier: login.pkce.verifier,
    });
    expect(invalidState.status).toBe("error");
    if (invalidState.status === "error") expect(invalidState.error.issue).toBe("invalid-state");
    await expect(
      login.exchange({ code: "manual", pkceVerifier: login.pkce.verifier }),
    ).rejects.toThrow("Invalid state");
    await login.exchange({
      callbackUrl: `${login.redirectUri}?code=manual&state=${login.state}`,
      pkceVerifier: login.pkce.verifier,
    });
    expect(writes).toHaveLength(1);
  });

  it("preserves a caller token-write rejection through the legacy exchange", async () => {
    const failure = new Error("caller write failed");
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: tokenFetch([]),
      writeTokens: async () => {
        throw failure;
      },
    });

    await expect(login.exchange({ code: "code", state: login.state })).rejects.toBe(failure);
    await login.close();
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

  it("propagates an active exchange Panic through close without changing identity", async () => {
    const fetchStarted = deferred<void>();
    const panic = new Panic({ message: "exchange invariant" });
    let rejectFetch: (cause: unknown) => void = () => {};
    const fetchResult = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const login = await startCodexOAuthLogin({
      callbackServer: "disabled",
      fetch: async () => {
        fetchStarted.resolve();
        return fetchResult;
      },
    });
    const exchange = login.exchange({ code: "code", state: login.state });
    await fetchStarted.promise;
    const close = login.close();
    rejectFetch(panic);

    const [exchangeOutcome, closeOutcome] = await Promise.allSettled([exchange, close]);
    expect(exchangeOutcome).toEqual({ status: "rejected", reason: panic });
    expect(closeOutcome).toEqual({ status: "rejected", reason: panic });
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

  it("bounds a refresh even when the fetch implementation ignores abort", async () => {
    jest.useFakeTimers({ now: 0 });
    const signals: AbortSignal[] = [];
    try {
      const refresh = refreshAccessTokenResult("refresh", async (_input, init) => {
        if (init?.signal) signals.push(init.signal);
        return await new Promise<Response>(() => {});
      });

      jest.advanceTimersByTime(45_000);
      const result = await refresh;

      expect(signals[0]?.aborted).toBe(true);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("CodexOAuthRequestFailed");
        expect(result.error.cause).toBeInstanceOf(DOMException);
        expect((result.error.cause as DOMException).name).toBe("TimeoutError");
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("preserves the caller abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const refresh = refreshAccessTokenResult(
      "refresh",
      async () => await new Promise<Response>(() => {}),
      controller.signal,
    );

    controller.abort(reason);
    const result = await refresh;

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.cause).toBe(reason);
  });
});
