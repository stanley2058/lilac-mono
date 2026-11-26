import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { DisplayPart, ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { THINKING_PREVIEW_CHARS, wireActivityPart } from "./activity-text";
import { NativeStore } from "./store";

const long = "x".repeat(THINKING_PREVIEW_CHARS + 1);

function activity(data: Partial<Extract<DisplayPart, { type: "data-activity" }>["data"]>) {
  return {
    type: "data-activity" as const,
    id: "call",
    data: { kind: "tool" as const, label: "bash ls", state: "complete" as const, ...data },
  };
}

test("tool output and long thinking text leave the part with their lengths", () => {
  expect(wireActivityPart(activity({ detail: `bash ${long}`, output: "ok" }))).toEqual(
    activity({ detail: `bash ${long}`, omitted: { output: 2 } }),
  );
  expect(wireActivityPart(activity({ kind: "thinking", label: "Thinking", detail: long }))).toEqual(
    activity({
      kind: "thinking",
      label: "Thinking",
      detail: long.slice(0, THINKING_PREVIEW_CHARS),
      omitted: { detail: long.length },
    }),
  );
  const short = activity({ kind: "thinking", label: "Thinking", detail: "Checking" });
  expect(wireActivityPart(short)).toBe(short);
});

test("whitespace-only output leaves without a marker", () => {
  expect(wireActivityPart(activity({ detail: "bash ls", output: "\n".repeat(5_000) }))).toEqual(
    activity({ detail: "bash ls" }),
  );
});

test("projecting a projected part changes nothing", () => {
  const once = wireActivityPart(activity({ kind: "thinking", detail: long, output: long }));
  expect(wireActivityPart(once)).toEqual(once);
});

function fixture() {
  const store = new NativeStore(new Database(":memory:"));
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  const receipt = store
    .acceptInput("owner", {
      threadId: thread.id,
      historyGeneration: 0,
      commandId: "prompt",
      text: "prompt",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const turnId = receipt.turnId!;
  return { store, thread, turnId };
}

function readyTurns(slots: readonly { kind: string }[]): ReadyTurnSlot[] {
  return slots.filter((slot): slot is ReadyTurnSlot => slot.kind === "ready");
}

test("replay leaves out long activity text and the thread reads it in full", () => {
  const { store, thread, turnId } = fixture();
  const initial = store.sync("owner", thread.id).unwrap();
  const part = activity({ detail: "bash ls", output: long });
  store
    .appendMessage(thread.id, 0, turnId, { id: "assistant", role: "assistant", parts: [part] })
    .unwrap();

  const window = store.sync("owner", thread.id).unwrap();
  if (window.kind !== "window") throw new Error("Expected a window");
  const parts = readyTurns(window.slots).flatMap((slot) =>
    slot.messages.flatMap((message) => message.parts),
  );
  const sent = parts.find((candidate) => candidate.type === "data-activity");
  expect(sent).toEqual({
    type: "data-activity",
    id: "call",
    data: {
      kind: "tool",
      label: "bash ls",
      state: "complete",
      detail: "bash ls",
      omitted: { output: long.length },
    },
  });

  const delta = store.sync("owner", thread.id, initial.checkpoint).unwrap();
  if (delta.kind !== "delta") throw new Error("Expected a delta");
  expect(JSON.stringify(delta.changes)).not.toContain(long);

  expect(
    store.activityText("owner", { threadId: thread.id, turnId, partId: "call" }).unwrap(),
  ).toEqual({
    detail: "bash ls",
    output: long,
  });
});

test("activity text stays inside the thread that owns the turn", () => {
  const { store, thread, turnId } = fixture();
  store
    .appendMessage(thread.id, 0, turnId, {
      id: "assistant",
      role: "assistant",
      parts: [activity({ output: long })],
    })
    .unwrap();
  const other = store.createThread("owner", { commandId: "other" }).unwrap();
  const read = (threadId: string, partId: string) =>
    store.activityText("owner", { threadId, turnId, partId }).match({
      ok: () => "ok",
      err: (error) => error.message,
    });
  expect(read(other.id, "call")).toBe("Activity is unavailable");
  expect(read(thread.id, "missing")).toBe("Activity is unavailable");
  expect(read(thread.id, "call")).toBe("ok");
});

test("a window cuts only a newest message too large to send whole", () => {
  const { store, thread, turnId } = fixture();
  for (let index = 0; index < 20; index++)
    store
      .appendMessage(thread.id, 0, turnId, {
        id: `report_${index}`,
        role: "assistant",
        parts: [{ type: "text", text: `${index} ${"x".repeat(20_000)}` }],
      })
      .unwrap();
  const window = store.sync("owner", thread.id).unwrap();
  if (window.kind !== "window") throw new Error("Expected a window");
  const [slot] = readyTurns(window.slots);
  expect(slot?.partsCursor).toBeDefined();
  const sent = slot!.messages.slice(1);
  expect(sent.every((message) => message.parts.length === 1)).toBe(true);
  expect(slot!.messages[0]?.metadata?.position).toBe(0);
  expect(sent.at(-1)?.metadata?.position).toBe(20);
});
