import { expect, test } from "bun:test";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import type { ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { loadCitationSource } from "../src/components/use-citation-navigation";

const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "test",
};
const ready = (position: number): ReadyTurnSlot => ({
  kind: "ready",
  slotId: `slot_${position}`,
  turnId: `turn_${position}`,
  position,
  messages: [
    { id: `answer_${position}`, role: "assistant", parts: [{ type: "text", text: "Saved quote" }] },
  ],
});

test("finds a source after the hundredth hydration and beyond", async () => {
  for (const count of [100, 120]) {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint,
      slots: Array.from({ length: count }, (_, position) => ({
        kind: "deferred" as const,
        slotId: `slot_${position}`,
        position,
        endPosition: position + 1,
      })),
    });
    let calls = 0;
    const client = {
      hydrate: async (_threadId: string, slotId: string) => {
        calls++;
        const position = Number(slotId.slice(5));
        store.hydrate({ ...checkpoint, slotId, slots: [ready(position)] });
      },
      loadTurnPage: async () => {},
    };
    expect(
      await loadCitationSource({
        threadId: "thread",
        messageId: "answer_0",
        store,
        client,
        current: () => true,
      }),
    ).toBe("slot_0");
    expect(calls).toBe(count);
  }
});

test("follows a long turn's pagination until the cited message appears", async () => {
  const store = new NativeThreadStore();
  store.replay({ kind: "window", checkpoint, slots: [{ ...ready(0), partsCursor: "page_0" }] });
  let calls = 0;
  const client = {
    hydrate: async () => {},
    loadTurnPage: async (_threadId: string, slotId: string) => {
      const cursor = `page_${calls++}`;
      store.turnPage(slotId, cursor, {
        ...checkpoint,
        turnId: "turn_0",
        messages:
          calls === 120
            ? [
                {
                  id: "old-answer",
                  role: "assistant",
                  parts: [{ type: "text", text: "Old quote" }],
                },
              ]
            : [],
        nextCursor: calls < 120 ? `page_${calls}` : undefined,
      });
    },
  };
  expect(
    await loadCitationSource({
      threadId: "thread",
      messageId: "old-answer",
      store,
      client,
      current: () => true,
    }),
  ).toBe("slot_0");
  expect(calls).toBe(120);
});

test("stops when loading makes no progress or the navigation is canceled", async () => {
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint,
    slots: [{ kind: "deferred", slotId: "old", position: 0, endPosition: 1 }],
  });
  let calls = 0;
  const client = {
    hydrate: async () => {
      calls++;
    },
    loadTurnPage: async () => {},
  };
  const options = { threadId: "thread", messageId: "missing", store, client };
  expect(await loadCitationSource({ ...options, current: () => true })).toBeUndefined();
  expect(calls).toBe(1);
  expect(await loadCitationSource({ ...options, current: () => false })).toBeUndefined();
  expect(calls).toBe(1);
});

test("keeps paging while the cited message waits behind a turn's gap", async () => {
  const at = (position: number) => ({
    id: `m${position}`,
    role: "assistant" as const,
    metadata: { position },
    parts: [{ type: "text" as const, text: `Message ${position}` }],
  });
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint,
    slots: [{ ...ready(0), messages: [at(0), at(9)], partsCursor: "page_0" }],
  });
  const pages = [
    { messages: [1, 2, 3].map(at), nextCursor: "page_1" },
    { messages: [4, 5, 6, 7, 8].map(at), nextCursor: undefined },
  ];
  let calls = 0;
  const client = {
    hydrate: async () => {},
    loadTurnPage: async (_threadId: string, slotId: string) => {
      const page = pages[calls]!;
      store.turnPage(slotId, `page_${calls++}`, { ...checkpoint, turnId: "turn_0", ...page });
    },
  };
  expect(
    await loadCitationSource({
      threadId: "thread",
      messageId: "m2",
      store,
      client,
      current: () => true,
    }),
  ).toBe("slot_0");
  expect(calls).toBe(2);
});
