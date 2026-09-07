import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { UnauthorizedError } from "@ai-sdk/mcp";
import { Panic } from "better-result";

import {
  MCP_OAUTH_CALLBACK_URL,
  McpOAuthCallbackService,
  McpOAuthProviderService,
  readMcpOAuthCredentialFile,
  resolveMcpOAuthCredentialPath,
  writeMcpOAuthCredentialFileAtomic,
  type UniversalMcpConfig,
} from "../../src/mcp";

const SERVER_URL = "https://mcp.example.test/service";
const ISSUER = "https://auth.example.test";
const temporaryDirectories: string[] = [];
const callbackServices: McpOAuthCallbackService[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-mcp-oauth-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function oauthConfig(scopes: readonly string[] = ["read", "write"]): UniversalMcpConfig {
  return {
    configVersion: 1,
    servers: {
      docs: {
        id: "docs",
        allowSubagents: false,
        transportConfig: {
          transport: "http",
          url: SERVER_URL,
          headers: {},
          auth: {
            type: "oauth",
            grant: "authorization_code",
            scopes,
            client: { type: "dynamic" },
          },
        },
      },
    },
  };
}

function oauthFetch(options: { tokenRequests: URLSearchParams[]; rejectRefresh?: () => boolean }) {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.hostname === "mcp.example.test" &&
        url.pathname.includes("oauth-protected-resource")
      ) {
        return Response.json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
      }
      if (url.href === `${ISSUER}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === `${ISSUER}/register`) {
        return Response.json({
          client_id: "registered-client",
          redirect_uris: [MCP_OAUTH_CALLBACK_URL],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }
      if (url.href === `${ISSUER}/token`) {
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        options.tokenRequests.push(body);
        if (body.get("grant_type") === "refresh_token" && options.rejectRefresh?.()) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: "saved-access-token",
          refresh_token: "saved-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
}

async function startFlow() {
  const dataDir = await createDataDir();
  const tokenRequests: URLSearchParams[] = [];
  const providers = new McpOAuthProviderService({
    dataDir,
    fetchFn: oauthFetch({ tokenRequests }),
  });
  providers.reconcile(oauthConfig());
  const providerBefore = providers.getProvider("docs");
  providers.reconcile(oauthConfig());
  const start = await providers.startAuthorization("docs");
  if (start.status !== "authorization_required") throw new Error("Expected OAuth redirect");
  const authorizationUrl = new URL(start.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("Expected OAuth state");
  const callbacks = new McpOAuthCallbackService({ providers });
  callbackServices.push(callbacks);
  return { dataDir, tokenRequests, providers, providerBefore, start, state, callbacks };
}

afterEach(async () => {
  await Promise.all(callbackServices.splice(0).map((service) => service.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Core-owned MCP OAuth", () => {
  it("uses one provider for start, registry lookup, callback, and durable credentials", async () => {
    const flow = await startFlow();

    expect(flow.providers.getProvider("docs")).toBe(flow.providerBefore);
    expect(flow.start.callbackUrl).toBe(MCP_OAUTH_CALLBACK_URL);
    expect(flow.start.authorizationUrl).toStartWith(`${ISSUER}/authorize?`);
    expect(flow.start.authorizationUrl).toContain("code_challenge=");
    expect(flow.start.authorizationUrl).toContain("scope=read+write");

    const beforeCallback = await readMcpOAuthCredentialFile({
      dataDir: flow.dataDir,
      serverId: "docs",
    });
    expect(beforeCallback?.clientInformation?.client_id).toBe("registered-client");
    expect(beforeCallback?.clientInformation?.issuer).toBe(ISSUER);
    expect(beforeCallback?.authorizationServerInformation).toEqual({
      issuer: ISSUER,
      authorizationServerUrl: `${ISSUER}/`,
      tokenEndpoint: `${ISSUER}/token`,
    });
    expect(beforeCallback?.tokens).toBeUndefined();
    expect(JSON.stringify(beforeCallback)).not.toContain("code_verifier");
    expect(JSON.stringify(beforeCallback)).not.toContain(flow.state);

    const response = await flow.callbacks.handleRequest(
      new Request(
        `${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=${flow.state}&iss=${encodeURIComponent(ISSUER)}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OAuth authorization completed.\n");
    expect(flow.tokenRequests).toHaveLength(1);
    expect(flow.tokenRequests[0]?.get("code")).toBe("callback-code");
    expect(flow.tokenRequests[0]?.get("code_verifier")).toBeTruthy();

    const credential = await readMcpOAuthCredentialFile({
      dataDir: flow.dataDir,
      serverId: "docs",
    });
    expect(credential?.tokens).toMatchObject({
      access_token: "saved-access-token",
      refresh_token: "saved-refresh-token",
      issuer: ISSUER,
      authorization_server: `${ISSUER}/`,
      token_endpoint: `${ISSUER}/token`,
    });
    expect(
      (await stat(resolveMcpOAuthCredentialPath({ dataDir: flow.dataDir, serverId: "docs" })))
        .mode & 0o777,
    ).toBe(0o600);
    expect(flow.providers.getProviderForState(flow.state)).toBeUndefined();
  });

  it("rejects an OAuth callback whose issuer does not match the authorization server", async () => {
    const flow = await startFlow();
    const credentialBefore = await readMcpOAuthCredentialFile({
      dataDir: flow.dataDir,
      serverId: "docs",
    });
    const response = await flow.callbacks.handleRequest(
      new Request(
        `${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=${flow.state}&iss=https%3A%2F%2Fevil.example.test`,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("OAuth authorization failed.\n");
    expect(flow.tokenRequests).toHaveLength(0);
    expect(await readMcpOAuthCredentialFile({ dataDir: flow.dataDir, serverId: "docs" })).toEqual(
      credentialBefore,
    );
    expect(flow.providers.getProviderForState(flow.state)).toBeDefined();
  });

  it("retains multiple pending attempts and completes their callbacks in either order", async () => {
    const dataDir = await createDataDir();
    const tokenRequests: URLSearchParams[] = [];
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests }),
    });
    providers.reconcile(oauthConfig());
    const provider = providers.getProvider("docs");

    const [first, second] = await Promise.all([
      providers.startAuthorization("docs"),
      providers.startAuthorization("docs"),
    ]);
    if (first.status !== "authorization_required" || second.status !== "authorization_required") {
      throw new Error("Expected OAuth redirects");
    }
    const firstState = new URL(first.authorizationUrl).searchParams.get("state");
    const secondState = new URL(second.authorizationUrl).searchParams.get("state");
    if (!firstState || !secondState) throw new Error("Expected OAuth states");
    expect(firstState).not.toBe(secondState);
    expect(providers.getProvider("docs")).toBe(provider);
    expect(providers.getProviderForState(firstState) === provider).toBe(true);
    expect(providers.getProviderForState(secondState) === provider).toBe(true);

    const callbacks = new McpOAuthCallbackService({ providers });
    callbackServices.push(callbacks);
    const secondResponse = await callbacks.handleRequest(
      new Request(`${MCP_OAUTH_CALLBACK_URL}?code=second-code&state=${secondState}`),
    );
    expect(secondResponse.status).toBe(200);
    expect(providers.getProviderForState(secondState)).toBeUndefined();
    expect(providers.getProviderForState(firstState) === provider).toBe(true);

    const firstResponse = await callbacks.handleRequest(
      new Request(`${MCP_OAUTH_CALLBACK_URL}?code=first-code&state=${firstState}`),
    );
    expect(firstResponse.status).toBe(200);
    expect(providers.getProviderForState(firstState)).toBeUndefined();
    expect(tokenRequests.map((request) => request.get("code"))).toEqual([
      "second-code",
      "first-code",
    ]);
    expect(tokenRequests[0]?.get("code_verifier")).toBeTruthy();
    expect(tokenRequests[1]?.get("code_verifier")).toBeTruthy();
    expect(tokenRequests[0]?.get("code_verifier")).not.toBe(tokenRequests[1]?.get("code_verifier"));
  });

  it("keeps runtime OAuth limited to token refresh and explicit mcp.auth", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests: [] }),
    });
    providers.reconcile(oauthConfig());
    const provider = providers.getProvider("docs");
    if (!provider) throw new Error("Expected OAuth provider");

    await expect(provider.clientInformation()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      provider.saveClientInformation?.({ client_id: "implicit-registration" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(() => provider.state?.()).toThrow(UnauthorizedError);
    expect(() => provider.saveCodeVerifier("implicit-verifier")).toThrow(UnauthorizedError);
    expect(provider.storedState?.()).toBeUndefined();

    const explicit = await providers.startAuthorization("docs");
    expect(explicit.status).toBe("authorization_required");
  });

  it("returns owned Results for missing providers and invalid callback state", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({ dataDir });

    const missing = await providers.startAuthorizationResult("missing");
    expect(missing.status).toBe("error");
    if (missing.status === "error") {
      expect(missing.error).toMatchObject({
        _tag: "McpOAuthProviderError",
        serverId: "missing",
        operation: "start",
      });
    }

    providers.reconcile(oauthConfig());
    const provider = providers.getProvider("docs");
    if (!provider) throw new Error("Expected OAuth provider");
    const invalidCallback = await provider.completeAuthorizationResult("code", "wrong-state");
    expect(invalidCallback.status).toBe("error");
    if (invalidCallback.status === "error") {
      expect(invalidCallback.error.operation).toBe("complete");
    }
  });

  it("treats a zero dynamic client secret expiration as non-expiring", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({ dataDir });
    providers.reconcile(oauthConfig());
    const provider = providers.getProvider("docs");
    if (!provider) throw new Error("Expected OAuth provider");

    await writeMcpOAuthCredentialFileAtomic({
      dataDir,
      serverId: "docs",
      credential: {
        version: 1,
        serverUrl: SERVER_URL,
        clientInformation: {
          client_id: "registered-client",
          client_secret: "registered-secret",
          client_secret_expires_at: 0,
        },
      },
    });

    expect(await provider.clientInformation()).toMatchObject({
      client_id: "registered-client",
      client_secret_expires_at: 0,
    });
  });

  it("binds legacy dynamic client information to the authorization server", async () => {
    const dataDir = await createDataDir();
    await writeMcpOAuthCredentialFileAtomic({
      dataDir,
      serverId: "docs",
      credential: {
        version: 1,
        serverUrl: SERVER_URL,
        clientInformation: { client_id: "legacy-registered-client" },
      },
    });
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests: [] }),
    });
    providers.reconcile(oauthConfig());

    const started = await providers.startAuthorization("docs");

    expect(started.status).toBe("authorization_required");
    expect(
      (await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" }))?.clientInformation,
    ).toMatchObject({
      client_id: "legacy-registered-client",
      issuer: ISSUER,
      authorization_server: `${ISSUER}/`,
      token_endpoint: `${ISSUER}/token`,
    });
  });

  it("expires abandoned authorization states without affecting new explicit flows", async () => {
    const dataDir = await createDataDir();
    let now = 0;
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests: [] }),
      now: () => now,
    });
    providers.reconcile(oauthConfig());

    const first = await providers.startAuthorization("docs");
    const second = await providers.startAuthorization("docs");
    if (first.status !== "authorization_required" || second.status !== "authorization_required") {
      throw new Error("Expected OAuth redirects");
    }
    const firstState = new URL(first.authorizationUrl).searchParams.get("state");
    const secondState = new URL(second.authorizationUrl).searchParams.get("state");
    if (!firstState || !secondState) throw new Error("Expected OAuth states");

    now = Number.MAX_SAFE_INTEGER;
    const current = await providers.startAuthorization("docs");
    if (current.status !== "authorization_required") throw new Error("Expected OAuth redirect");
    const currentState = new URL(current.authorizationUrl).searchParams.get("state");
    if (!currentState) throw new Error("Expected OAuth state");

    expect(providers.getProviderForState(firstState)).toBeUndefined();
    expect(providers.getProviderForState(secondState)).toBeUndefined();
    expect(providers.getProviderForState(currentState)).toBeDefined();
  });

  it("discards pending authorization states when provider configuration changes", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests: [] }),
    });
    providers.reconcile(oauthConfig());
    const started = await providers.startAuthorization("docs");
    if (started.status !== "authorization_required") throw new Error("Expected OAuth redirect");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Expected OAuth state");

    providers.reconcile(oauthConfig(["changed-scope"]));

    expect(providers.getProviderForState(state)).toBeUndefined();
  });

  it("clears a rejected refresh token when explicit mcp.auth restarts authorization", async () => {
    const dataDir = await createDataDir();
    const tokenRequests: URLSearchParams[] = [];
    let rejectRefresh = false;
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests, rejectRefresh: () => rejectRefresh }),
    });
    providers.reconcile(oauthConfig());
    const callbacks = new McpOAuthCallbackService({ providers });
    callbackServices.push(callbacks);

    const initial = await providers.startAuthorization("docs");
    if (initial.status !== "authorization_required") throw new Error("Expected OAuth redirect");
    const initialState = new URL(initial.authorizationUrl).searchParams.get("state");
    if (!initialState) throw new Error("Expected OAuth state");
    expect(
      await callbacks.handleRequest(
        new Request(`${MCP_OAUTH_CALLBACK_URL}?code=initial-code&state=${initialState}`),
      ),
    ).toMatchObject({ status: 200 });

    rejectRefresh = true;
    const restarted = await providers.startAuthorization("docs");
    expect(restarted.status).toBe("authorization_required");
    expect(tokenRequests.map((request) => request.get("grant_type"))).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(
      (await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" }))?.tokens,
    ).toBeUndefined();
  });

  it("prevents an expired authorization attempt from clearing newer tokens", async () => {
    const dataDir = await createDataDir();
    await writeMcpOAuthCredentialFileAtomic({
      dataDir,
      serverId: "docs",
      credential: {
        version: 1,
        serverUrl: SERVER_URL,
        tokens: {
          access_token: "old-access-token",
          refresh_token: "shared-refresh-token",
          token_type: "Bearer",
          authorization_server: `${ISSUER}/`,
          token_endpoint: `${ISSUER}/token`,
        },
        clientInformation: { client_id: "registered-client" },
        authorizationServerInformation: {
          authorizationServerUrl: `${ISSUER}/`,
          tokenEndpoint: `${ISSUER}/token`,
        },
      },
    });

    let resolveFirstRefresh: (response: Response) => void = () => undefined;
    const firstRefreshResponse = new Promise<Response>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    let markFirstRefreshStarted: () => void = () => undefined;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const tokenRequests: URLSearchParams[] = [];
    const baseFetch = oauthFetch({ tokenRequests: [] });
    const fetchFn = Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.href !== `${ISSUER}/token`) return await baseFetch(input, init);

        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        tokenRequests.push(body);
        if (tokenRequests.length === 1) {
          markFirstRefreshStarted();
          return await firstRefreshResponse;
        }
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "shared-refresh-token",
          token_type: "Bearer",
        });
      },
      { preconnect: fetch.preconnect },
    );
    let now = 0;
    const providers = new McpOAuthProviderService({ dataDir, fetchFn, now: () => now });
    providers.reconcile(oauthConfig());

    const expiredAttempt = providers.startAuthorization("docs");
    await firstRefreshStarted;
    now = Number.MAX_SAFE_INTEGER;
    const currentCredential = await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" });
    if (!currentCredential) throw new Error("Expected persisted OAuth credential");
    await writeMcpOAuthCredentialFileAtomic({
      dataDir,
      serverId: "docs",
      credential: {
        ...currentCredential,
        tokens: {
          access_token: "new-access-token",
          refresh_token: "shared-refresh-token",
          token_type: "Bearer",
          authorization_server: `${ISSUER}/`,
          token_endpoint: `${ISSUER}/token`,
        },
      },
    });

    resolveFirstRefresh(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(expiredAttempt).rejects.toThrow("Could not start MCP OAuth authorization");
    expect(
      (await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" }))?.tokens?.access_token,
    ).toBe("new-access-token");
  });

  it("bounds retained pending attempts", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: oauthFetch({ tokenRequests: [] }),
    });
    providers.reconcile(oauthConfig());
    const states: string[] = [];

    for (let index = 0; index < 33; index += 1) {
      const start = await providers.startAuthorization("docs");
      if (start.status !== "authorization_required") throw new Error("Expected OAuth redirect");
      const state = new URL(start.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("Expected OAuth state");
      states.push(state);
    }

    expect(providers.getProviderForState(states[0] ?? "")).toBeUndefined();
    for (const state of states.slice(1)) {
      expect(providers.getProviderForState(state)).toBeDefined();
    }
  });

  it("propagates Panic from OAuth start and completion", async () => {
    const startDataDir = await createDataDir();
    const startPanic = new Panic({ message: "OAuth start invariant failed" });
    const startProviders = new McpOAuthProviderService({
      dataDir: startDataDir,
      fetchFn: Object.assign(async () => Promise.reject(startPanic), {
        preconnect: fetch.preconnect,
      }),
    });
    startProviders.reconcile(oauthConfig());
    await expect(startProviders.startAuthorization("docs")).rejects.toBe(startPanic);

    const completeDataDir = await createDataDir();
    const tokenRequests: URLSearchParams[] = [];
    const baseFetch = oauthFetch({ tokenRequests });
    const completePanic = new Panic({ message: "OAuth completion invariant failed" });
    let panicOnToken = false;
    const completeProviders = new McpOAuthProviderService({
      dataDir: completeDataDir,
      fetchFn: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (panicOnToken && url.href === `${ISSUER}/token`) throw completePanic;
          return await baseFetch(input, init);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    completeProviders.reconcile(oauthConfig());
    const started = await completeProviders.startAuthorization("docs");
    if (started.status !== "authorization_required") throw new Error("Expected OAuth redirect");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Expected OAuth state");
    const provider = completeProviders.getProviderForState(state);
    if (!provider) throw new Error("Expected pending OAuth provider");

    panicOnToken = true;
    await expect(provider.completeAuthorization("callback-code", state)).rejects.toBe(
      completePanic,
    );
  });

  it("rejects missing, wrong, duplicate, error, and bare-code callbacks without tokens", async () => {
    const flow = await startFlow();
    const credentialBefore = await readMcpOAuthCredentialFile({
      dataDir: flow.dataDir,
      serverId: "docs",
    });
    const callbacks = [
      `${MCP_OAUTH_CALLBACK_URL}?code=callback-code`,
      `${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=wrong-state`,
      `${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=${flow.state}&state=other`,
      `${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=${flow.state}&iss=${encodeURIComponent(ISSUER)}&iss=https%3A%2F%2Fother.example.test`,
      `${MCP_OAUTH_CALLBACK_URL}?error=access_denied&error_description=private&state=${flow.state}`,
      `${MCP_OAUTH_CALLBACK_URL}/callback-code`,
    ];

    for (const callback of callbacks) {
      const response = await flow.callbacks.handleRequest(new Request(callback));
      expect([400, 404]).toContain(response.status);
      const body = await response.text();
      expect(body).not.toContain("callback-code");
      expect(body).not.toContain("wrong-state");
      expect(body).not.toContain("private");
    }

    expect(flow.tokenRequests).toHaveLength(0);
    expect(
      (await readMcpOAuthCredentialFile({ dataDir: flow.dataDir, serverId: "docs" }))?.tokens,
    ).toBeUndefined();
    expect(await readMcpOAuthCredentialFile({ dataDir: flow.dataDir, serverId: "docs" })).toEqual(
      credentialBefore,
    );
  });

  it("writes no tokens when exchange fails and does not expose callback data", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({
      dataDir,
      fetchFn: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const response = await oauthFetch({ tokenRequests: [] })(input, init);
          const url = new URL(input instanceof Request ? input.url : String(input));
          return url.href === `${ISSUER}/token`
            ? new Response("callback-code secret-token", { status: 500 })
            : response;
        },
        { preconnect: fetch.preconnect },
      ),
    });
    providers.reconcile(oauthConfig());
    const start = await providers.startAuthorization("docs");
    if (start.status !== "authorization_required") throw new Error("Expected OAuth redirect");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Expected OAuth state");
    const callbacks = new McpOAuthCallbackService({ providers });
    callbackServices.push(callbacks);
    const credentialBefore = await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" });

    const response = await callbacks.handleRequest(
      new Request(`${MCP_OAUTH_CALLBACK_URL}?code=callback-code&state=${state}`),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("OAuth authorization failed.\n");
    expect(
      (await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" }))?.tokens,
    ).toBeUndefined();
    expect(await readMcpOAuthCredentialFile({ dataDir, serverId: "docs" })).toEqual(
      credentialBefore,
    );
    expect(providers.getProviderForState(state)).toBeDefined();
  });

  it("starts and stops the callback listener on an ephemeral port", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({ dataDir });
    providers.reconcile(oauthConfig());
    const callbacks = new McpOAuthCallbackService({ providers, hostname: "127.0.0.1", port: 0 });
    callbackServices.push(callbacks);

    const listener = callbacks.start();
    const response = await fetch(
      `http://${listener.hostname}:${listener.port}/mcp/oauth/callback?code=code&state=state`,
    );
    expect(response.status).toBe(400);
    await callbacks.stop();
  });

  it("reports a bind failure and allows a later start retry", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({ dataDir });
    let attempts = 0;
    let stopped = false;
    const callbacks = new McpOAuthCallbackService({
      providers,
      serverFactory: (options) => {
        attempts += 1;
        expect(options.hostname).toBe("localhost");
        expect(options.port).toBe(1456);
        if (attempts === 1) throw new Error("listen EADDRINUSE");
        return {
          port: options.port,
          stop: () => {
            stopped = true;
          },
        };
      },
    });
    callbackServices.push(callbacks);

    const unavailable = callbacks.start();
    expect(unavailable).toEqual({
      status: "unavailable",
      hostname: "localhost",
      port: 1456,
      error: "listen EADDRINUSE",
    });
    expect(callbacks.getStatus()).toBe(unavailable);

    const listening = callbacks.start();
    expect(listening).toEqual({ status: "listening", hostname: "localhost", port: 1456 });
    expect(callbacks.getStatus()).toBe(listening);
    expect(callbacks.start()).toBe(listening);
    expect(attempts).toBe(2);

    await callbacks.stop();
    expect(stopped).toBe(true);
    expect(callbacks.getStatus()).toEqual({
      status: "unavailable",
      hostname: "localhost",
      port: 1456,
      error: "OAuth callback listener is stopped",
    });
  });

  it("updates listener status when server stop throws synchronously", async () => {
    const dataDir = await createDataDir();
    const providers = new McpOAuthProviderService({ dataDir });
    const failure = new Error("stop failed synchronously");
    const callbacks = new McpOAuthCallbackService({
      providers,
      serverFactory: (options) => ({
        port: options.port,
        stop() {
          throw failure;
        },
      }),
    });
    callbackServices.push(callbacks);

    expect(callbacks.start().status).toBe("listening");
    await expect(callbacks.stop()).rejects.toBe(failure);
    expect(callbacks.getStatus()).toEqual({
      status: "unavailable",
      hostname: "localhost",
      port: 1456,
      error: "OAuth callback listener is stopped",
    });
  });

  it("drops providers on removal without deleting their credential file", async () => {
    const flow = await startFlow();
    const credentialPath = resolveMcpOAuthCredentialPath({
      dataDir: flow.dataDir,
      serverId: "docs",
    });
    flow.providers.reconcile({ configVersion: 1, servers: {} });

    expect(flow.providers.getProvider("docs")).toBeUndefined();
    expect((await stat(credentialPath)).isFile()).toBe(true);
  });
});
