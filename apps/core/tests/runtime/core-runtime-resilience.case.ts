import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { nativeContract } from "@stanley2058/lilac-client-protocol";
import {
  createIsolatedRedis,
  withinRedisDeadline,
} from "../../../../packages/event-bus/tests/helpers/isolated-redis";

type NativeClient = ContractRouterClient<typeof nativeContract>;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function startChild(env: Record<string, string | undefined>) {
  const phases = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const seen = new Set<string>();
  const failures: string[] = [];
  const child = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../helpers/fixtures/core-runtime-child.ts")],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: { phase: string; error?: string }) {
        if (message.phase === "fatal") failures.push(message.error ?? "Unknown runtime failure");
        seen.add(message.phase);
        phases.get(message.phase)?.resolve();
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    child,
    failures,
    async phase(name: string) {
      if (seen.has(name)) return;
      const waiter = Promise.withResolvers<void>();
      phases.set(name, waiter);
      await withinRedisDeadline(
        Promise.race([
          waiter.promise,
          child.exited.then(async (code) => {
            if (seen.has(name)) return;
            throw new Error(
              `Runtime exited ${code} before ${name}: ${await stderr}\n${await stdout}`,
            );
          }),
        ]),
        `Core runtime ${name}`,
        30_000,
      );
    },
    async stop() {
      child.send("stop");
      await this.phase("stopped");
      expect(await child.exited).toBe(0);
      expect(failures).toEqual([]);
    },
    async close() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    },
  };
}

async function connect(nativeUrl: string) {
  const login = await fetch(`${nativeUrl}/api/auth/login`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa("owner:fixture-password")}` },
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };
  const socket = new (WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  })(nativeUrl.replace("http:", "ws:") + "/api/socket", {
    headers: { authorization: `Bearer ${token}` },
  });
  const client: NativeClient = createORPCClient(new RPCLink({ websocket: socket }));
  return { socket, client };
}

async function watchCompletion(client: NativeClient, threadId: string) {
  const events = await client.threads.watch({ threadId });
  const first = await events.next();
  const completed = (async () => {
    if (!first.done && first.value.kind === "replay" && first.value.reply.kind === "window") {
      if (
        first.value.reply.slots.some((slot) => slot.kind === "ready" && slot.state === "complete")
      )
        return;
    }
    for await (const event of events) {
      const changes =
        event.kind === "update"
          ? event.update.changes
          : event.kind === "replay" && event.reply.kind === "delta"
            ? event.reply.changes
            : [];
      if (changes.some((change) => change.kind === "turn-state" && change.state === "complete"))
        return;
    }
    throw new Error("Native output stream ended before completion");
  })();
  return { completed, close: () => events.return?.() };
}

function submit(client: NativeClient, threadId: string, text: string) {
  return client.inputs.submit({
    commandId: crypto.randomUUID(),
    threadId,
    text,
    mode: "prompt",
    historyGeneration: 0,
    attachmentIds: [],
    skillIds: [],
  });
}

function completionResponse(stream: boolean): Response {
  if (!stream)
    return Response.json({
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Runtime test" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  const chunks = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Full runtime reply." },
          finish_reason: null,
        },
      ],
    },
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("full runtime readiness, ingress, graceful drain recovery and Redis outage use real services", async () => {
  await using cleanup = new AsyncDisposableStack();
  const redis = await createIsolatedRedis();
  cleanup.defer(() => redis.close());
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-runtime-boot-"));
  cleanup.defer(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const nativePort = await unusedPort();
  const toolPort = await unusedPort();
  const nativeUrl = `http://127.0.0.1:${nativePort}`;
  let blockNext = false;
  let streamRequests = 0;
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean };
      if (body.stream) streamRequests += 1;
      if (body.stream && blockNext) {
        blockNext = false;
        blocked.resolve();
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      }
      return completionResponse(Boolean(body.stream));
    },
  });
  cleanup.defer(async () => {
    release.resolve();
    await model.stop(true);
  });
  await writeFile(
    path.join(directory, "core-config.yaml"),
    JSON.stringify({
      configVersion: 3,
      basePrompt: "Answer the request briefly.",
      models: {
        main: { model: "openai-compatible/fixture" },
        fast: { model: "openai-compatible/fixture" },
      },
      surface: {
        native: {
          enabled: true,
          installationId: "runtime-test",
          host: "127.0.0.1",
          port: nativePort,
          publicUrl: nativeUrl,
          allowedOrigins: [nativeUrl],
        },
      },
    }),
  );
  await writeFile(path.join(directory, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    DATA_DIR: directory,
    REDIS_URL: redis.url,
    LILAC_WORKSPACE_DIR: workspace,
    LL_TOOL_SERVER_PORT: String(toolPort),
    LOG_LEVEL: "error",
    OPENAI_COMPATIBLE_BASE_URL: model.url.href,
    OPENAI_COMPATIBLE_API_KEY: "fixture",
    LILAC_NATIVE_LOCAL_USERNAME: "owner",
    LILAC_NATIVE_LOCAL_PASSWORD_HASH: await Bun.password.hash("fixture-password", {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    }),
    LILAC_NATIVE_SESSION_SECRET: "runtime-integration-session-key-0123456789",
  };
  try {
    const first = startChild(env);
    cleanup.defer(() => first.close());
    await first.phase("ready");
    expect((await fetch(`http://127.0.0.1:${toolPort}/readyz`)).status).toBe(200);
    const firstConnection = await connect(nativeUrl);
    cleanup.defer(() => firstConnection.socket.close());
    const thread = await firstConnection.client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Runtime readiness",
    });
    const firstOutput = await watchCompletion(firstConnection.client, thread.id);
    await submit(firstConnection.client, thread.id, "Answer now");
    await withinRedisDeadline(firstOutput.completed, "first request output");
    await firstOutput.close();
    expect(
      JSON.stringify(await firstConnection.client.threads.sync({ threadId: thread.id })),
    ).toContain("Full runtime reply.");
    expect(streamRequests).toBe(1);

    const recoveryThread = await firstConnection.client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Recover accepted work",
    });
    blockNext = true;
    await submit(
      firstConnection.client,
      recoveryThread.id,
      "Hold this request until the next boot",
    );
    await withinRedisDeadline(blocked.promise, "active model request");
    first.child.send("stop-held");
    await first.phase("ingress-stop-held");
    expect((await fetch(`http://127.0.0.1:${toolPort}/readyz`)).status).toBe(503);
    first.child.send("continue-stop");
    await first.phase("stopped");
    expect(await first.child.exited).toBe(0);
    expect(first.failures).toEqual([]);
    firstConnection.socket.close();
    release.resolve();
    const delivery = new Database(path.join(directory, "request-delivery.db"), { readonly: true });
    cleanup.defer(() => delivery.close());
    expect(
      delivery
        .query("SELECT count(*) AS count FROM request_delivery_records WHERE state = 'accepted'")
        .get(),
    ).toEqual({ count: 1 });

    const second = startChild(env);
    cleanup.defer(() => second.close());
    await second.phase("ready");
    const secondConnection = await connect(nativeUrl);
    cleanup.defer(() => secondConnection.socket.close());
    const recoveredOutput = await watchCompletion(secondConnection.client, recoveryThread.id);
    await withinRedisDeadline(recoveredOutput.completed, "recovered request output");
    await recoveredOutput.close();
    expect(
      JSON.stringify(await secondConnection.client.threads.sync({ threadId: recoveryThread.id })),
    ).toContain("Full runtime reply.");
    expect(streamRequests).toBe(3);
    expect((await fetch(`http://127.0.0.1:${toolPort}/readyz`)).status).toBe(200);

    await redis.stop();
    expect((await fetch(`http://127.0.0.1:${toolPort}/readyz`)).status).toBe(503);
  } finally {
    release.resolve();
  }
}, 60_000);
