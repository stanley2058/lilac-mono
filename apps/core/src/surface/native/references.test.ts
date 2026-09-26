import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { referenceHref } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";
import { NativeSurfaceStore } from "./store-surface";
import { NativeReferences } from "./references";
import { NativeExternalThreads } from "./search-external";
import { Result } from "better-result";

function fixture() {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const id of ["owner", "reader"])
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "restricted",
      })
      .unwrap();
  const surface = new NativeSurfaceStore(db, store);
  surface.initialize().unwrap();
  const external = new NativeExternalThreads({
    getUser: (id) => store.getUser(id),
    adapters: { resolve: () => null, registeredPlatforms: () => [] },
    transcripts: {
      listDiscoveryRecords: () => [],
      getRequestTranscript: () => Result.ok(null),
      getCorePrimaryLineageManifest: () => Result.ok(null),
      getCoreSurfaceProjection: () => Result.ok(null),
      getLatestCoreSurfaceSegment: () => Result.ok(null),
    },
  });
  const references = new NativeReferences(store, surface, external);
  const thread = store
    .createThread("owner", { commandId: "create", title: "Private thread" })
    .unwrap();
  return { store, references, thread, [Symbol.dispose]: () => store.close() };
}

test("native message references open around old messages and page in both directions", async () => {
  using f = fixture();
  for (let i = 0; i < 210; i++)
    f.store
      .postMessage("owner", f.thread.id, {
        id: `message-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Message ${i}` }],
      })
      .unwrap();
  const target = { surface: "native" as const, sessionId: f.thread.id, messageId: "message-100" };
  const first = (await f.references.read("owner", { target })).unwrap();
  expect(first.messages).toHaveLength(81);
  expect(first.messages[40]?.id).toBe("message-100");
  expect(first.messageFound).toBe(true);
  const before = (await f.references.read("owner", { target, cursor: first.nextCursor })).unwrap();
  const after = (
    await f.references.read("owner", { target, cursor: first.nextAfter, direction: "after" })
  ).unwrap();
  expect(before.messages.at(-1)?.id).toBe("message-59");
  expect(after.messages[0]?.id).toBe("message-141");
  expect(after.messages.at(-1)?.id).toBe("message-209");
  expect(after.nextCursor).toBe("message-141");
  const refetched = (
    await f.references.read("owner", { target, cursor: after.nextCursor })
  ).unwrap();
  expect(refetched.messages.some((message) => message.id === target.messageId)).toBe(true);
  const session = (
    await f.references.read("owner", { target: { surface: "native", sessionId: f.thread.id } })
  ).unwrap();
  expect(session.messages.at(-1)?.id).toBe("message-209");
});

test("reference titles and model expansion respect the executing principal", async () => {
  using f = fixture();
  f.store
    .postMessage("owner", f.thread.id, {
      id: "message",
      role: "assistant",
      parts: [{ type: "text", text: "Secret" }],
    })
    .unwrap();
  const target = { surface: "native" as const, sessionId: f.thread.id, messageId: "message" };
  const text = `[thread](${referenceHref(target)})`;
  expect((await f.references.resolve("reader", target)).isErr()).toBe(true);
  expect((await f.references.read("reader", { target })).isErr()).toBe(true);
  const expanded = (await f.references.expand("owner", text)).unwrap();
  expect(expanded).toContain(`"sessionId":"${f.thread.id}"`);
  expect(expanded).toContain("messageId: message");
  expect(expanded).toContain("Secret");
  const denied = (await f.references.expand("reader", text)).unwrap();
  expect(denied).toContain("unavailable");
  expect(denied).not.toContain("Private thread");
  expect(denied).not.toContain("conversationThreadId");
});

test("exact native preview page boundaries do not advertise an empty newer page", async () => {
  using f = fixture();
  for (let i = 0; i < 141; i++)
    f.store
      .postMessage("owner", f.thread.id, {
        id: `message-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Message ${i}` }],
      })
      .unwrap();
  const target = { surface: "native" as const, sessionId: f.thread.id, messageId: "message-100" };
  const anchor = (await f.references.read("owner", { target })).unwrap();
  expect(anchor.messages.at(-1)?.id).toBe("message-140");
  expect(anchor.nextAfter).toBeUndefined();
  const fullPage = (
    await f.references.read("owner", { target, cursor: "message-40", direction: "after" })
  ).unwrap();
  expect(fullPage.messages).toHaveLength(100);
  expect(fullPage.nextAfter).toBeUndefined();
  const refetched = (
    await f.references.read("owner", { target, cursor: fullPage.nextCursor })
  ).unwrap();
  expect(refetched.messages.at(-1)?.id).toBe("message-40");
  expect(fullPage.messages.some((message) => message.id === target.messageId)).toBe(true);
});

test("absolute native references retain principal checks and missing-message failures", async () => {
  using f = fixture();
  const url = `https://chat.example${referenceHref({ surface: "native", sessionId: f.thread.id })}`;
  const expanded = (await f.references.expand("owner", url, "https://chat.example")).unwrap();
  expect(expanded).toContain('"client":"native"');
  expect(expanded).not.toContain("unavailable");
  expect((await f.references.expand("reader", url, "https://chat.example")).unwrap()).toContain(
    "unavailable",
  );
  expect(
    (await f.references.expand("owner", `${url}&message=missing`, "https://chat.example")).unwrap(),
  ).toContain("unavailable");
  expect((await f.references.expand("owner", url, "https://other.example")).unwrap()).toBe(url);
});

test("native range references are inclusive, paginated, and exclude later replies", async () => {
  using f = fixture();
  for (let i = 0; i < 230; i++)
    f.store
      .postMessage("owner", f.thread.id, {
        id: `message-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Message ${i}` }],
      })
      .unwrap();
  const target = {
    surface: "native" as const,
    sessionId: f.thread.id,
    range: { startMessageId: "message-20", endMessageId: "message-220" },
  };
  const first = (await f.references.read("owner", { target })).unwrap();
  expect(first.messages).toHaveLength(100);
  expect(first.messages[0]?.id).toBe("message-121");
  expect(first.messages.at(-1)?.id).toBe("message-220");
  const second = (await f.references.read("owner", { target, cursor: first.nextCursor })).unwrap();
  expect(second.messages[0]?.id).toBe("message-21");
  const third = (await f.references.read("owner", { target, cursor: second.nextCursor })).unwrap();
  expect(third.messages.map((message) => message.id)).toEqual(["message-20"]);
  expect(third.nextCursor).toBeUndefined();
  expect((await f.references.read("reader", { target })).isErr()).toBe(true);
  for (const range of [
    { startMessageId: "missing", endMessageId: "message-220" },
    { startMessageId: "message-220", endMessageId: "message-20" },
  ])
    expect((await f.references.read("owner", { target: { ...target, range } })).isErr()).toBe(true);
});

test("message previews exclude neighbors and session previews retain the latest text", async () => {
  using f = fixture();
  for (let i = 0; i < 4; i++)
    f.store
      .postMessage("owner", f.thread.id, {
        id: `message-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `content-${i} ` + "x".repeat(5000) }],
      })
      .unwrap();
  const session = { surface: "native" as const, sessionId: f.thread.id };
  const message = (
    await f.references.expand("owner", referenceHref({ ...session, messageId: "message-1" }))
  ).unwrap();
  expect(message).toContain("content-1");
  expect(message).not.toContain("content-0");
  expect(message).not.toContain("content-2");
  const input = referenceHref(session);
  const expanded = (await f.references.expand("owner", input)).unwrap();
  expect(expanded).toContain("content-3");
  expect(expanded).toContain("content-2");
  expect(expanded).not.toContain("content-0");
  expect(expanded.indexOf("Preview truncated")).toBeLessThan(expanded.indexOf("content-2"));
  expect(expanded.indexOf("content-2")).toBeLessThan(expanded.indexOf("content-3"));
  expect(expanded.length - input.length).toBeLessThan(12_200);
});

test("complete discussion endpoints are resolved on the server across both paging directions", async () => {
  using f = fixture();
  for (let i = 0; i < 310; i++)
    f.store
      .postMessage("owner", f.thread.id, {
        id: `message-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Message ${i}` }],
      })
      .unwrap();
  const target = { surface: "native" as const, sessionId: f.thread.id, messageId: "message-150" };
  expect((await f.references.range("owner", target)).unwrap()).toEqual({
    surface: "native",
    sessionId: f.thread.id,
    range: { startMessageId: "message-0", endMessageId: "message-309" },
  });
  expect((await f.references.range("reader", target)).isErr()).toBe(true);
  expect((await f.references.range("owner", { ...target, messageId: "missing" })).isErr()).toBe(
    true,
  );
  expect(
    (await f.references.range("owner", { surface: "native", sessionId: f.thread.id })).isErr(),
  ).toBe(true);
});
