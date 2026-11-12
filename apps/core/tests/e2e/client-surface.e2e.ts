import { afterAll, beforeAll, expect, test } from "bun:test";
import { startE2E, type E2E, type NativeSession } from "./harness";

let e2e: E2E;
let admin: NativeSession;
beforeAll(async () => {
  e2e = await startE2E();
  admin = await e2e.session({ style: "bearer" });
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

const echoTag = () =>
  e2e.model.script("echo", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo streamed-tool" } }] };
    return { text: `Echo: ${model.lastUserText.split("] ").at(-1)}` };
  });

async function roundTrip(session: NativeSession, text: string) {
  const tag = echoTag();
  const threadId = await session.createThread(text);
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} ${text}`);
  const [turn] = await session.settled(store, 1);
  expect(turn!.state).toBe("complete");
  expect(turn!.assistant).toBe(`Echo: ${text}`);
  expect(turn!.activities).toEqual([
    expect.objectContaining({
      state: "complete",
      output: expect.stringContaining("streamed-tool"),
    }),
  ]);
}

test("Auto transport falls back to HTTP and SSE when the socket upgrade is refused", async () => {
  const session = await e2e.session({
    style: "web",
    transport: "auto",
    interceptSocket: () => "refuse",
  });
  expect(session.client.currentTransport).toBe("http-sse");
  expect(session.sockets.length).toBeGreaterThan(0);
  await roundTrip(session, "after fallback");
}, 60_000);

test("changing the deployment transport policy moves connected clients", async () => {
  const session = await e2e.session({ style: "web" });
  expect(session.client.currentTransport).toBe("websocket");
  const before = await admin.rpc.config.readDeployment({});
  await admin.rpc.config.setDeployment({
    settings: { ...before.settings, transport: "http-sse" },
    expectedRevision: before.revision,
  });
  try {
    await session.until(
      () =>
        session.client.currentTransport === "http-sse" &&
        session.client.connectionState === "online",
      "client moved to SSE",
    );
    await roundTrip(session, "after policy change");
    // A client that starts under the policy uses SSE from its first connection.
    const late = await e2e.session({ style: "web" });
    expect(late.client.currentTransport).toBe("http-sse");
    expect(late.sockets).toEqual([]);
    await roundTrip(late, "started on sse");
  } finally {
    const current = await admin.rpc.config.readDeployment({});
    await admin.rpc.config.setDeployment({
      settings: { ...current.settings, transport: "auto" },
      expectedRevision: current.revision,
    });
  }
}, 60_000);

test("a file uploaded with the browser's cookie reaches the model", async () => {
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Upload");
  const store = session.watch(threadId);
  const body = "The secret word is marmalade.\n";
  const resource = await session.rpc.resources.reserve({
    threadId,
    commandId: crypto.randomUUID(),
    name: "secret.txt",
    mediaType: "text/plain",
    size: body.length,
  });
  const upload = await fetch(
    `${e2e.layout.nativeUrl}/api/uploads/${encodeURIComponent(resource.id)}`,
    {
      method: "PUT",
      headers: {
        cookie: session.credentials.cookie,
        origin: e2e.layout.nativeUrl,
        "content-type": "text/plain",
        "content-length": String(body.length),
      },
      body,
    },
  );
  expect(upload.status).toBeLessThan(300);
  const tag = e2e.model.script("upload", (_request, model) => {
    if (model.step === 0) {
      // Uploads reach the model as a resource reference in the user message.
      const reference = /uri="(resource:\/\/[^"]+)"[^\]]*filename="secret\.txt"/u.exec(
        model.lastUserText,
      )?.[1];
      if (!reference) throw new Error(`No attachment reference in ${model.lastUserText}`);
      return { toolCalls: [{ name: "read", args: { path: reference } }] };
    }
    const read = model.result("read");
    if (!read.includes("marmalade")) throw new Error(`Reading the attachment returned ${read}`);
    return { text: "The word is marmalade." };
  });
  await session.send(threadId, `${tag} What is the secret word?`, { attachmentIds: [resource.id] });
  const [turn] = await session.settled(store, 1);
  expect(turn!.assistant).toBe("The word is marmalade.");
  expect(JSON.stringify(turn!.messages)).toContain("secret.txt");
}, 60_000);

test("rewinding a turn restores its prompt and removes it from the model's history", async () => {
  const tag = e2e.model.script("rewind", (_request, model) => ({
    text: `Answer to ${model.lastUserText.split("] ").at(-1)} (history: ${model.userTexts.length})`,
  }));
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Rewind");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} alpha-prompt`);
  await session.settled(store, 1);
  await session.send(threadId, `${tag} rewound-prompt`);
  const turns = await session.settled(store, 2);
  const checkpoint = store.checkpoint!;
  const rewound = await session.rpc.threads.rewind({
    threadId,
    commandId: crypto.randomUUID(),
    historyGeneration: checkpoint.historyGeneration,
    expectedRevision: checkpoint.projectionRevision,
    turnId: turns[1]!.turnId,
  });
  expect(rewound.text).toContain("rewound-prompt");
  await session.waitForTurns(store, (rendered) => rendered.length === 1, "rewound turn removed");
  await session.send(threadId, `${tag} gamma-prompt`);
  const after = await session.waitForTurns(
    store,
    (rendered) => rendered.length === 2 && rendered[1]!.state === "complete",
    "turn after rewind",
  );
  expect(after.map((turn) => turn.assistant)).toEqual([
    expect.stringContaining("Answer to alpha-prompt"),
    expect.stringContaining("Answer to gamma-prompt"),
  ]);
  const last = e2e.model.forScenario("rewind").at(-1)!.request;
  expect(JSON.stringify(last.messages)).not.toContain("rewound-prompt");
  expect(JSON.stringify(last.messages)).toContain("Answer to alpha-prompt");
}, 60_000);
