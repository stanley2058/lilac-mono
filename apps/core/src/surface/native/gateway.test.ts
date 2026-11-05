import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { RPCLink as HttpRPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { nativeContract } from "@stanley2058/lilac-client-protocol";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { createNativeClerkAuthenticator } from "./auth-clerk";
import { authFailure } from "./auth";
import { Panic, Result } from "better-result";
import { createNativeLocalAuthenticator } from "./auth-local";
import { createNativeGateway, type NativeGatewayOptions } from "./gateway";
import { nativeRpcValue, type NativeRpcServices } from "./rpc";
import { nativeFailure } from "./errors";
import { createNativeMetrics, type NativeMetricSink } from "./metrics";
import { BinaryRelay } from "@stanley2058/lilac-utils/binary-relay";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const user = {
  id: "owner",
  displayName: "Owner",
  role: "owner" as const,
  toolMode: "full" as const,
};
const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "n_0_1",
};

async function fixture(
  webRoot?: string,
  resources?: NativeGatewayOptions["resources"],
  computer?: NativeGatewayOptions["computer"],
) {
  const measurements: { event: string; fields: Parameters<NativeMetricSink>[1] }[] = [];
  const metrics = createNativeMetrics((event, fields) => measurements.push({ event, fields }));
  const fatalErrors: Error[] = [];
  const fatal = Promise.withResolvers<Error>();
  const auth = createNativeLocalAuthenticator({
    ownerUserId: user.id,
    username: "operator",
    passwordHash: await Bun.password.hash("test-password", {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    }),
    signingKey: crypto.getRandomValues(new Uint8Array(32)),
    installationId: "test",
    allowedOrigins: ["http://localhost"],
  });
  const services = {
    bootstrap: {
      get: () =>
        Result.ok({
          installationId: "test",
          viewer: user,
          threads: { items: [] },
          catalog: {
            kind: "catalog",
            catalog: { revision: "catalog1", models: [], skills: [], commands: [] },
          },
          catalogCursor: "catalog1",
        }),
    },
    threads: {
      watch: () =>
        Result.ok(
          (async function* () {
            yield {
              kind: "replay",
              reply: {
                kind: "window",
                checkpoint,
                slots: [
                  { kind: "deferred", slotId: "older", position: 0, endPosition: 9 },
                  {
                    kind: "ready",
                    slotId: "latest",
                    turnId: "turn_latest",
                    position: 9,
                    messages: [],
                  },
                ],
              },
            };
            yield {
              kind: "hydration",
              hydration: {
                historyGeneration: 0,
                projectionRevision: 1,
                slotId: "older",
                slots: [
                  { kind: "ready", slotId: "old", turnId: "turn_old", position: 0, messages: [] },
                ],
              },
            };
          })(),
        ),
      sync: (_principal: object, input: { threadId: string }) =>
        input.threadId === "private-other"
          ? Result.err(nativeFailure("forbidden", "Thread access denied"))
          : Result.ok({ kind: "unchanged", checkpoint }),
    },
  } as unknown as NativeRpcServices;
  const gateway = createNativeGateway({
    computer,
    metrics,
    hostname: "127.0.0.1",
    port: 0,
    webRoot,
    resources,
    auth,
    login: auth.login,
    services,
    getViewer: () => Result.ok(user),
    reportFatalError: (error) => {
      fatalErrors.push(error);
      fatal.resolve(error);
    },
    publicAuth: { provider: "local" },
  });
  const { url } = gateway.start().unwrap();
  cleanup.push(gateway.stop);
  const login = await fetch(new URL("api/auth/login", url), {
    method: "POST",
    headers: { authorization: `Basic ${btoa("operator:test-password")}` },
  });
  const { token } = (await login.json()) as { token: string };
  return {
    url,
    token,
    auth,
    gateway,
    services,
    fatalErrors,
    fatal: fatal.promise,
    metrics,
    measurements,
  };
}

function connect(url: string, token: string) {
  const endpoint = new URL("api/socket", url);
  endpoint.protocol = "ws:";
  const socket = new (WebSocket as unknown as {
    new (url: URL, options: { headers: Record<string, string> }): WebSocket;
  })(endpoint, { headers: { authorization: `Bearer ${token}` } });
  cleanup.push(() => socket.close());
  const client: ContractRouterClient<typeof nativeContract> = createORPCClient(
    new RPCLink({ websocket: socket }),
  );
  return { socket, client };
}

test("computer lane authenticates separately, carries binary frames, and closes on logout", async () => {
  const received = Promise.withResolvers<number[]>();
  const disconnected = Promise.withResolvers<void>();
  let calls = 0;
  const current = await fixture(undefined, undefined, {
    async connect(actor, thread, generation, _signal, authenticated) {
      calls++;
      expect(actor).toBe(user.id);
      expect(thread).toBe("desktop-thread");
      expect(generation).toBe("936ea9b5-eae1-4c79-97af-c56fd48b2c8c");
      const relay = new BinaryRelay(
        async (bytes) => {
          received.resolve([...bytes]);
        },
        () => disconnected.resolve(),
        authenticated,
      );
      relay.push(new Uint8Array([82, 70, 66]));
      return Result.ok(relay);
    },
  });
  const endpoint = new URL(
    "api/computer/socket?threadId=desktop-thread&generation=936ea9b5-eae1-4c79-97af-c56fd48b2c8c",
    current.url,
  );
  await expectSocketRejected(endpoint);
  await expectSocketRejected(endpoint, {
    authorization: `Bearer ${current.token}`,
    origin: "https://other.example",
  });
  expect(calls).toBe(0);
  endpoint.protocol = "ws:";
  const socket = new (WebSocket as unknown as {
    new (url: URL, options: { headers: Record<string, string> }): WebSocket;
  })(endpoint, { headers: { authorization: `Bearer ${current.token}` } });
  cleanup.push(() => socket.close());
  socket.binaryType = "arraybuffer";
  const greeting = Promise.withResolvers<number[]>();
  socket.addEventListener("message", (event) => greeting.resolve([...new Uint8Array(event.data)]));
  expect(await greeting.promise).toEqual([82, 70, 66]);
  socket.send(new Uint8Array([7, 8]));
  expect(await received.promise).toEqual([7, 8]);
  const logout = await fetch(new URL("api/auth/logout", current.url), {
    method: "POST",
    headers: { authorization: `Bearer ${current.token}` },
  });
  expect(logout.status).toBe(200);
  await disconnected.promise;
  expect(calls).toBe(1);
  expect(current.fatalErrors).toEqual([]);
});

test("computer lane reserves capacity during handshakes and releases failed upgrades", async () => {
  const admitted = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let calls = 0;
  const current = await fixture(undefined, undefined, {
    async connect() {
      if (++calls === 64) admitted.resolve();
      await proceed.promise;
      return Result.ok(
        new BinaryRelay(
          async () => {},
          () => {},
        ),
      );
    },
  });
  const url = new URL(
    "api/computer/socket?threadId=t&generation=936ea9b5-eae1-4c79-97af-c56fd48b2c8c",
    current.url,
  );
  const headers = { authorization: `Bearer ${current.token}` };
  const pending = Array.from({ length: 64 }, () => fetch(url, { headers }));
  try {
    await admitted.promise;
    expect((await fetch(url, { headers })).status).toBe(503);
    expect(calls).toBe(64);
  } finally {
    proceed.resolve();
  }
  const responses = await Promise.all(pending);
  expect(responses.every((response) => response.status === 426)).toBe(true);
  expect((await fetch(url, { headers })).status).toBe(426);
  expect(calls).toBe(65);
});

async function expectSocketRejected(url: URL, headers: Record<string, string> = {}) {
  const endpoint = new URL(url);
  endpoint.protocol = "ws:";
  const socket = new (WebSocket as unknown as {
    new (url: URL, options: { headers: Record<string, string> }): WebSocket;
  })(endpoint, { headers });
  cleanup.push(() => socket.close());
  let opened = false;
  socket.addEventListener("open", () => {
    opened = true;
    socket.close();
  });
  await new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true }),
  );
  expect(opened).toBe(false);
}

describe("native gateway", () => {
  test("question operations cross the authenticated socket and list pending questions", async () => {
    const { url, token, services } = await fixture();
    const calls: unknown[] = [];
    services.questions = {
      read: (principal, input) => {
        calls.push([principal.userId, input]);
        return Result.ok({
          questionCallId: "q1",
          requestId: "r1",
          respondentId: "owner",
          historyGeneration: 0,
          mode: "deferred",
          view: { state: "interrupted" },
        });
      },
      pending: (principal, input) => {
        calls.push([principal.userId, input]);
        return Result.ok([]);
      },
      dismiss: (principal, input) => {
        calls.push([principal.userId, input]);
        return Result.ok({ ok: true });
      },
    };
    const { client } = connect(url, token);
    const target = { threadId: "thread", messageId: "q1" };
    expect((await client.questions.read(target)).view.state).toBe("interrupted");
    expect(await client.questions.pending({ threadId: target.threadId })).toEqual([]);
    expect(
      await client.questions.dismiss({ ...target, historyGeneration: 0, token: "token" }),
    ).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(["owner", { threadId: "thread" }]);
  });

  test("notification presence receives a socket lifetime signal", async () => {
    const { url, token, services } = await fixture();
    const closed = Promise.withResolvers<void>();
    let lifetime: AbortSignal | undefined;
    services.notifications = {
      presence: (_principal, _input, signal) => {
        lifetime = signal;
        signal?.addEventListener("abort", () => closed.resolve(), { once: true });
        return Result.ok({ ok: true });
      },
      key: () => Result.ok({ publicKey: "key" }),
      subscribe: () => Result.ok({ ok: true }),
      unsubscribe: () => Result.ok({ ok: true }),
      read: () => Result.ok({ threadId: "thread", title: "title", body: "body", tag: "tag" }),
    };
    const { client, socket } = connect(url, token);
    await client.notifications.presence({ clientId: "phone", threadId: "thread" });
    expect(lifetime).toBeDefined();
    expect(lifetime?.aborted).toBe(false);
    socket.close();
    await closed.promise;
    expect(lifetime?.aborted).toBe(true);
  });

  test("remote images require authentication and reject private destinations", async () => {
    const { url, token } = await fixture();
    const endpoint = new URL("api/remote-image?url=http%3A%2F%2F127.0.0.1%2Fimage.png", url);
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      502,
    );
  });
  test("link metadata uses the authenticated RPC contract", async () => {
    const { url, token, services } = await fixture();
    let viewer: string | undefined;
    services.links = {
      preview(principal, input) {
        viewer = principal.userId;
        expect(input.url).toBe("https://example.com/page");
        return Result.ok({ title: "Page", icon: "https://example.com/icon.svg" });
      },
    };
    const { client } = connect(url, token);
    expect(await client.links.preview({ url: "https://example.com/page" })).toEqual({
      title: "Page",
      icon: "https://example.com/icon.svg",
    });
    expect(viewer).toBe(user.id);
    await expectSocketRejected(new URL("api/socket", url));
  });
  test("private HTTP routes reject missing and forged credentials before calling services", async () => {
    let resourceCalls = 0;
    const { url, token, services, fatalErrors } = await fixture(undefined, {
      handle: async () => {
        resourceCalls += 1;
        return new Response("private resource");
      },
    });
    let bootstrapCalls = 0;
    const bootstrap = services.bootstrap.get;
    services.bootstrap.get = (...args) => {
      bootstrapCalls += 1;
      return bootstrap(...args);
    };
    const credentials: Record<string, string>[] = [
      {},
      { authorization: "Bearer forged" },
      { cookie: "lilac_native_session=forged" },
      { authorization: `Basic ${btoa("operator:test-password")}` },
      { "x-forwarded-user": "owner", "x-lilac-operator-session": crypto.randomUUID() },
    ];
    for (const route of [
      "api/bootstrap",
      "api/socket",
      "api/auth/logout",
      "api/operator/session",
      "api/uploads/fixture",
      "api/resources/fixture",
      "api/resources/fixture/preview",
      "api/files/fixture/preview",
      "api/identity/avatar",
      "api/profile/avatar",
      "api/users/owner/avatar",
      "api/unknown",
    ]) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
        for (const headers of credentials) {
          const endpoint = new URL(route, url);
          endpoint.searchParams.set("token", token);
          const response = await fetch(endpoint, {
            method,
            headers: { origin: "http://localhost", ...headers },
          });
          expect(response.status).toBe(401);
          await response.arrayBuffer();
        }
      }
    }
    expect(resourceCalls).toBe(0);
    expect(bootstrapCalls).toBe(0);
    expect(fatalErrors).toEqual([]);
    expect(
      (
        await fetch(new URL("api/bootstrap", url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(bootstrapCalls).toBe(1);
  });

  test("WebSocket upgrades require credentials and enforce browser origins", async () => {
    const { url, token, fatalErrors } = await fixture();
    const endpoint = new URL("api/socket", url);
    endpoint.searchParams.set("token", token);
    const credentials: Record<string, string>[] = [
      {},
      { origin: "http://localhost" },
      { authorization: "Bearer forged" },
      { cookie: "lilac_native_session=forged", origin: "http://localhost" },
      { cookie: `lilac_native_session=${token}` },
      { cookie: `lilac_native_session=${token}`, origin: "https://evil.example" },
      { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    ];
    for (const headers of credentials) {
      await expectSocketRejected(endpoint, headers);
    }
    const { client } = connect(url, token);
    expect((await client.threads.sync({ threadId: "shared" })).kind).toBe("unchanged");
    expect(fatalErrors).toEqual([]);
  });

  test("shutdown waits for an in-flight RPC mutation after closing its socket", async () => {
    const { url, token, gateway, services } = await fixture();
    const entered = Promise.withResolvers<void>();
    const finishMutation = Promise.withResolvers<void>();
    let writes = 0;
    services.threads.sync = async () => {
      entered.resolve();
      await finishMutation.promise;
      writes += 1;
      return Result.ok({ kind: "unchanged", checkpoint });
    };
    const { client, socket } = connect(url, token);
    const socketClosed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    const pending = client.threads.sync({ threadId: "shared" }).then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    let stopped = false;
    const stopping = gateway.stop().then(() => {
      stopped = true;
    });
    await socketClosed;
    expect(stopped).toBe(false);
    expect(writes).toBe(0);
    finishMutation.resolve();
    await stopping;
    expect(writes).toBe(1);
    await pending;
  });

  test("shutdown aborts a live subscription before awaiting RPC drain", async () => {
    const { url, token, gateway, services, fatalErrors } = await fixture();
    const waiting = Promise.withResolvers<void>();
    services.threads.watch = (_principal, _input, signal) =>
      Result.ok(
        (async function* () {
          yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
            waiting.resolve();
          });
        })(),
      );
    const { client } = connect(url, token);
    const stream = await client.threads.watch({ threadId: "shared" });
    await stream.next();
    await waiting.promise;
    await gateway.stop();
    expect(fatalErrors).toEqual([]);
  });

  test("RPC defects reach the supervisor with their original Panic identity", async () => {
    const { url, token, services, fatalErrors } = await fixture();
    const defect = new Panic({ message: "Native service invariant failed" });
    services.threads.sync = () => {
      throw defect;
    };
    const { client } = connect(url, token);
    await expect(client.threads.sync({ threadId: "shared" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBe(defect);
  });

  test("watch iteration defects reach the supervisor before protocol serialization", async () => {
    const { url, token, gateway, services, fatalErrors, fatal } = await fixture();
    const defect = new Panic({ message: "Native watch invariant failed" });
    services.threads.watch = () =>
      Result.ok(
        (async function* () {
          yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
          throw defect;
        })(),
      );
    const { client } = connect(url, token);
    const stream = await client.threads.watch({ threadId: "shared" });
    expect((await stream.next()).value).toMatchObject({ kind: "replay" });
    expect(await fatal).toBe(defect);
    const pending = stream.next().then(
      () => undefined,
      () => undefined,
    );
    await gateway.stop();
    await pending;
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]).toBe(defect);
  });

  test("malformed socket envelopes close the connection without reporting a defect", async () => {
    const { url, token, fatalErrors } = await fixture();
    for (const frame of [
      "{",
      '{"i":"malformed","p":{}}',
      JSON.stringify({
        i: "multipart",
        p: {
          u: "/threads/sync",
          h: { "content-type": "multipart/form-data; boundary=bad" },
          b: {},
        },
      }),
    ]) {
      const { client, socket } = connect(url, token);
      await client.threads.sync({ threadId: "shared" });
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      socket.send(frame);
      expect((await closed).code).toBe(4400);
    }
    expect(fatalErrors).toEqual([]);
  });

  test("shutdown aborts authenticated uploads and waits for their storage cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    let storageClosed = false;
    let writesAfterClose = 0;
    let cleanupWrites = 0;
    let enteredCount = 0;
    const { url, token, gateway } = await fixture(undefined, {
      async handle(request, actorId) {
        expect(actorId).toBe("owner");
        enteredCount += 1;
        entered.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted.resolve();
            resolve();
          };
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
        await finishCleanup.promise;
        if (storageClosed) writesAfterClose += 1;
        cleanupWrites += 1;
        return new Response(null, { status: 409 });
      },
    });
    const { client, socket } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const socketClosed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    const upload = fetch(new URL("api/resources/upload", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "file",
    }).then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    let stopped = false;
    const stopping = gateway.stop().then(() => {
      stopped = true;
    });
    await aborted.promise;
    await socketClosed;
    expect(stopped).toBe(false);
    expect(gateway.start().isErr()).toBe(true);
    const refused = await fetch(new URL("api/resources/upload", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "late",
    }).then(
      (response) => response.status,
      () => 503,
    );
    expect(refused).toBe(503);
    expect(enteredCount).toBe(1);
    finishCleanup.resolve();
    await stopping;
    storageClosed = true;
    await upload;
    expect(cleanupWrites).toBe(1);
    expect(writesAfterClose).toBe(0);
    await gateway.stop();
    const restarted = gateway.start().unwrap();
    expect((await fetch(new URL("api/auth/info", restarted.url))).status).toBe(200);
  });

  test("SPA shell and immutable assets share the origin without filesystem traversal", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "native-gateway-"));
    cleanup.push(() => rmSync(temporary, { recursive: true, force: true }));
    const webRoot = path.join(temporary, "web");
    mkdirSync(path.join(webRoot, "assets"), { recursive: true });
    writeFileSync(path.join(webRoot, "index.html"), "<main>Lilac</main>");
    writeFileSync(path.join(webRoot, "assets", "app-fixture.js"), "export {};");
    writeFileSync(path.join(temporary, "secret.txt"), "private");
    const { url } = await fixture(webRoot);
    const shell = await fetch(new URL("threads/thread-id", url));
    expect(await shell.text()).toBe("<main>Lilac</main>");
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(new URL("assets/app-fixture.js", url));
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(new URL("assets/missing.js", url))).status).toBe(404);
    expect((await fetch(new URL("%2e%2e%2fsecret.txt", url))).status).toBe(404);
  });

  test("one socket delivers latest-first replay and deferred hydration", async () => {
    const { url, token } = await fixture();
    const { client } = connect(url, token);
    const events = [];
    for await (const event of await client.threads.watch({ threadId: "shared" }))
      events.push(event);
    expect(events[0]).toMatchObject({
      kind: "replay",
      reply: {
        kind: "window",
        slots: [
          { kind: "deferred", slotId: "older" },
          { kind: "ready", turnId: "turn_latest" },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      kind: "hydration",
      hydration: { slotId: "older", slots: [{ kind: "ready", turnId: "turn_old" }] },
    });
  });

  test("socket logout acknowledges before closing", async () => {
    const { url, token } = await fixture();
    const { socket, client } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    expect(await client.connection.logout({})).toEqual({ ok: true });
    expect((await closed).code).toBe(4401);
  });

  test("signed Clerk principals remain isolated across RPC and same-connection refresh", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const issuer = "https://fixture.clerk.accounts.dev";
    const auth = (
      await createNativeClerkAuthenticator({
        secretKey: "sk_test_fixture",
        oauthClientId: "client_fixture",
        publishableKey: `pk_test_${btoa("fixture.clerk.accounts.dev$")}`,
        jwtKey: await exportSPKI(keys.publicKey),
        issuer,
        allowedOrigins: ["http://localhost"],
        resolveUser: async (id) =>
          ["alice", "bob"].includes(id)
            ? Result.ok({ userId: id })
            : Result.err(authFailure("forbidden", "Unknown user")),
      })
    ).unwrap();
    const sign = (id: string, expires: string | number = "1m") =>
      new SignJWT({ sid: `sess_${id}`, azp: "http://localhost" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "fixture" })
        .setIssuer(issuer)
        .setSubject(id)
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) - 1)
        .setExpirationTime(expires)
        .sign(keys.privateKey);
    const services = {
      threads: {
        sync: (principal: { userId: string }, input: { threadId: string }) =>
          input.threadId === principal.userId
            ? Result.ok({ kind: "unchanged", checkpoint })
            : Result.err(nativeFailure("forbidden", "Thread denied")),
      },
    } as unknown as NativeRpcServices;
    const gateway = createNativeGateway({
      hostname: "127.0.0.1",
      port: 0,
      auth,
      publicAuth: { provider: "clerk", issuer, oauthClientId: "client_fixture" },
      services,
      getViewer: (id) => Result.ok({ ...user, id }),
      reportFatalError: (error) => {
        throw error;
      },
    });
    const { url } = gateway.start().unwrap();
    cleanup.push(gateway.stop);
    const publicInfo = await fetch(new URL("api/auth/info", url));
    expect(publicInfo.headers.get("cache-control")).toContain("no-store");
    expect(await publicInfo.json()).toEqual({
      provider: "clerk",
      issuer,
      oauthClientId: "client_fixture",
    });
    const aliceToken = await sign("alice");
    const bobToken = await sign("bob");
    await expectSocketRejected(new URL("api/socket", url));
    for (const token of [
      "forged",
      `${aliceToken.slice(0, -10)}aaaaaaaaaa`,
      await sign("alice", 1),
      await sign("unknown"),
    ]) {
      const headers = { authorization: `Bearer ${token}` };
      const response = await fetch(new URL("api/bootstrap", url), { headers });
      expect([401, 403]).toContain(response.status);
      await expectSocketRejected(new URL("api/socket", url), headers);
    }
    const alice = connect(url, aliceToken).client;
    const bob = connect(url, bobToken).client;
    expect((await alice.threads.sync({ threadId: "alice" })).kind).toBe("unchanged");
    expect((await bob.threads.sync({ threadId: "bob" })).kind).toBe("unchanged");
    await expect(alice.threads.sync({ threadId: "bob" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(alice.connection.reauthenticate({ token: bobToken })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await alice.connection.reauthenticate({ token: await sign("alice") })).id).toBe(
      "alice",
    );
    expect((await alice.threads.sync({ threadId: "alice" })).kind).toBe("unchanged");
    const shortLived = connect(url, await sign("alice", Math.floor(Date.now() / 1000) + 2));
    const expired = new Promise<CloseEvent>((resolve) =>
      shortLived.socket.addEventListener("close", resolve, { once: true }),
    );
    await shortLived.client.threads.sync({ threadId: "alice" });
    expect((await expired).code).toBe(4401);
  });

  test("bootstrap checks auth directly and oRPC preserves domain rejection identity", async () => {
    const { url, token } = await fixture();
    expect((await fetch(new URL("api/bootstrap", url))).status).toBe(401);
    const initial = await fetch(new URL("api/bootstrap", url), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(((await initial.json()) as { viewer: { id: string } }).viewer.id).toBe("owner");
    const { client } = connect(url, token);
    expect(await client.threads.sync({ threadId: "shared", checkpoint })).toEqual({
      kind: "unchanged",
      checkpoint,
    });
    await expect(client.threads.sync({ threadId: "private-other" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(() => nativeRpcValue(Result.err(nativeFailure("forbidden", "denied")))).toThrow(
      "denied",
    );
  });

  test("logout revokes open sockets and subsequent HTTP requests", async () => {
    const { url, token } = await fixture();
    const { socket, client } = connect(url, token);
    await client.threads.sync({ threadId: "shared" });
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    const logout = await fetch(new URL("api/auth/logout", url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    expect((await closed).code).toBe(4401);
    expect(
      (
        await fetch(new URL("api/bootstrap", url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });

  test("foreign origins and malformed checkpoint are rejected before bootstrap", async () => {
    const { url, token } = await fixture();
    expect(
      (
        await fetch(new URL("api/bootstrap", url), {
          headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(new URL("api/bootstrap?checkpoint=%7B", url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(422);
  });
});

test("real oRPC frames produce redacted replay and bootstrap measurements", async () => {
  const { url, token, metrics, measurements } = await fixture();
  metrics.committed("thread", 1, 0, "request");
  const bootstrap = await fetch(new URL("api/bootstrap", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(bootstrap.status).toBe(200);
  const { client } = connect(url, token);
  const stream = await client.threads.watch({ threadId: "thread" });
  expect((await stream.next()).value).toMatchObject({ kind: "replay" });
  await stream.return?.();
  expect(measurements.find((item) => item.event === "bootstrap.complete")?.fields.status).toBe(200);
  const replay = measurements.find((item) => item.event === "replay.enqueue")?.fields;
  expect(replay).toMatchObject({
    threadId: "thread",
    requestId: "request",
    kind: "window",
    cacheReset: false,
  });
  expect(replay?.commitToSocketEnqueueMs).toBeGreaterThanOrEqual(0);
  expect(replay?.bytes).toBeGreaterThan(0);
  expect(JSON.stringify(measurements)).not.toContain(token);
});

function connectHttp(url: string, token: string) {
  return createORPCClient<ContractRouterClient<typeof nativeContract>>(
    new HttpRPCLink({
      url: new URL("api/rpc", url),
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

test("HTTP RPC uses the same auth, domain errors and SSE replay as WebSocket", async () => {
  const f = await fixture();
  const client = connectHttp(f.url, f.token);
  expect(await client.bootstrap.get({})).toMatchObject({ viewer: user });
  await expect(client.threads.sync({ threadId: "private-other" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const events = [];
  for await (const event of await client.threads.watch({ threadId: "thread" })) events.push(event);
  expect(events.map((event) => event.kind)).toEqual(["replay", "hydration"]);
  const endpoint = new URL("api/rpc/bootstrap/get", f.url);
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: '{"json":{}}',
  });
  expect(unauthorized.status).toBe(401);
  const foreign = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${f.token}`,
      origin: "https://other.example",
    },
    body: '{"json":{}}',
  });
  expect(foreign.status).toBe(403);
  const getMutation = await fetch(new URL("api/rpc/connection/logout", f.url), {
    headers: { authorization: `Bearer ${f.token}` },
  });
  expect(getMutation.status).toBe(405);
  expect(f.fatalErrors).toEqual([]);
});

for (const ending of ["cancel", "logout", "shutdown"] as const) {
  test(`HTTP SSE ${ending} releases an idle server subscription`, async () => {
    const f = await fixture();
    const watching = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    f.services.threads.watch = (_principal, _input, signal) =>
      Result.ok(
        (async function* () {
          yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
          watching.resolve();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          released.resolve();
        })(),
      );
    const client = connectHttp(f.url, f.token);
    const abort = new AbortController();
    const stream = await client.threads.watch({ threadId: "thread" }, { signal: abort.signal });
    expect((await stream.next()).value).toMatchObject({ kind: "replay" });
    await watching.promise;
    if (ending === "cancel") abort.abort();
    if (ending === "logout") expect(await client.connection.logout({})).toEqual({ ok: true });
    if (ending === "shutdown") await f.gateway.stop();
    await released.promise;
    if (ending === "cancel")
      await expect(stream.return()).rejects.toHaveProperty("name", "AbortError");
    else await stream.return();
    expect(f.fatalErrors).toEqual([]);
  });
}

test("HTTP SSE expires an idle authenticated stream", async () => {
  const f = await fixture();
  const authenticate = f.auth.authenticate.bind(f.auth);
  const auth = spyOn(f.auth, "authenticate").mockImplementation(async (request, context) =>
    (await authenticate(request, context)).map((principal) => ({
      ...principal,
      expiresAt: Date.now() / 1000 + 60,
    })),
  );
  cleanup.push(() => auth.mockRestore());
  const checkSession = spyOn(f.auth, "checkSession").mockReturnValue(Result.ok());
  cleanup.push(() => checkSession.mockRestore());
  const originalTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...values] = args;
      if (delay && delay > 59_000 && delay <= 60_000) expire = () => callback(...values);
      return originalTimeout(...args);
    }, originalTimeout),
  );
  cleanup.push(() => timer.mockRestore());
  const released = Promise.withResolvers<void>();
  f.services.threads.watch = (_principal, _input, signal) =>
    Result.ok(
      (async function* () {
        yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        released.resolve();
      })(),
    );
  const stream = await connectHttp(f.url, f.token).threads.watch({ threadId: "thread" });
  await stream.next();
  expect(expire).toBeDefined();
  expire!();
  await released.promise;
  expect((await stream.next()).done).toBe(true);
  expect(f.fatalErrors).toEqual([]);
});
