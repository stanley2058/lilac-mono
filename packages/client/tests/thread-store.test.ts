import { describe, expect, test } from "bun:test";
import type { ReadyTurnSlot, ReplayCheckpoint } from "@stanley2058/lilac-client-protocol";
import { NativeThreadStore } from "../src/thread-store.ts";
import {
  MemoryNativeCache,
  NoNativeCache,
  cacheProjectionKey,
  cacheScopeKey,
  type CacheScope,
} from "../src/cache.ts";
import { DisplayCatalogCache } from "../src/catalog.ts";

const checkpoint = (revision = 1, generation = 0): ReplayCheckpoint => ({
  protocolVersion: 1,
  historyGeneration: generation,
  projectionRevision: revision,
  cursor: `cursor_${generation}_${revision}`,
});
const ready = (position: number): ReadyTurnSlot => ({
  kind: "ready",
  slotId: `slot_${position}`,
  turnId: `turn_${position}`,
  position,
  messages: [
    { id: `message_${position}`, role: "assistant", parts: [{ type: "text", text: "start" }] },
  ],
});
const scope: CacheScope = {
  installationId: "install",
  principalId: "owner",
  protocolVersion: 1,
  projectionVersion: 1,
};

function initial(): NativeThreadStore {
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint: checkpoint(),
    slots: [{ kind: "deferred", slotId: "old", position: 0, endPosition: 2 }, ready(2)],
  });
  return store;
}

describe("NativeThreadStore", () => {
  test("out-of-order hydration preserves newer live data and partial coverage", () => {
    const store = initial();
    store.update({
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn_2",
          position: 2,
          messageId: "message_2",
          partIndex: 0,
          text: " now",
        },
      ],
    });
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0), ready(1)],
      }),
    ).toBe("applied");
    expect(store.get("slot_2")).toMatchObject({ messages: [{ parts: [{ text: "start now" }] }] });
    expect(store.checkpoint).toEqual(checkpoint(2));
  });

  test("changing an unresolved range fences stale hydration", () => {
    const store = initial();
    store.update({
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn_1",
          position: 1,
          messageId: "message_1",
          partIndex: 0,
          text: " later",
        },
      ],
    });
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0), ready(1)],
      }),
    ).toBe("ignored");
    expect(store.get("old")?.kind).toBe("deferred");
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 2,
        slotId: "old",
        slots: [ready(0), ready(1)],
      }),
    ).toBe("applied");
  });

  test("rewind and revision gaps fence snapshots below the observed floor", () => {
    const store = initial();
    expect(store.update({ checkpoint: checkpoint(5, 1), changes: [] })).toBe("resync");
    expect(store.replay({ kind: "window", checkpoint: checkpoint(4, 1), slots: [ready(0)] })).toBe(
      "ignored",
    );
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0), ready(1)],
      }),
    ).toBe("ignored");
    expect(store.replay({ kind: "window", checkpoint: checkpoint(5, 1), slots: [ready(0)] })).toBe(
      "applied",
    );
    expect(store.get("slot_2")).toBeUndefined();
    expect(store.resyncRequired).toBe(false);
  });

  test("batch rollback does not partially apply an invalid suffix", () => {
    const store = initial();
    const before = store.get("slot_2");
    expect(
      store.update({
        checkpoint: checkpoint(2),
        changes: [
          {
            kind: "append-text",
            turnId: "turn_2",
            position: 2,
            messageId: "message_2",
            partIndex: 0,
            text: " accepted?",
          },
          {
            kind: "append-text",
            turnId: "turn_2",
            position: 2,
            messageId: "missing",
            partIndex: 0,
            text: "no",
          },
        ],
      }),
    ).toBe("resync");
    expect(store.get("slot_2")).toBe(before);
    expect(store.checkpoint).toEqual(checkpoint());
  });

  test("insert and append in one delta apply once without notifying unchanged slots", () => {
    const store = initial();
    let oldNotifications = 0;
    store.subscribeSlot("slot_2", () => oldNotifications++);
    const delta = {
      kind: "delta" as const,
      checkpoint: checkpoint(3),
      fromRevision: 1,
      changes: [
        { kind: "insert" as const, slot: ready(3) },
        {
          kind: "append-text" as const,
          turnId: "turn_3",
          position: 3,
          messageId: "message_3",
          partIndex: 0,
          text: " end",
        },
      ],
    };
    expect(store.replay(delta)).toBe("applied");
    expect(store.replay(delta)).toBe("ignored");
    expect(store.get("slot_3")).toMatchObject({ messages: [{ parts: [{ text: "start end" }] }] });
    expect(oldNotifications).toBe(0);
  });

  test("malformed hydration cannot collide, overlap or leave silent holes", () => {
    const store = initial();
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0)],
      }),
    ).toBe("ignored");
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0), { ...ready(1), turnId: "turn_2" }],
      }),
    ).toBe("ignored");
    expect(
      store.hydrate({
        historyGeneration: 0,
        projectionRevision: 1,
        slotId: "old",
        slots: [ready(0), { ...ready(1), slotId: "slot_2" }],
      }),
    ).toBe("ignored");
    expect(store.get("old")?.kind).toBe("deferred");
  });

  test("huge-turn pages append parts once without advancing the live cursor", () => {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: checkpoint(),
      slots: [{ ...ready(0), partsCursor: "page_1" }],
    });
    const page = {
      turnId: "turn_0",
      historyGeneration: 0,
      projectionRevision: 1,
      messages: [],
      chunks: [
        { messageId: "message_0", partIndex: 1, part: { type: "text" as const, text: "page" } },
      ],
    };
    expect(store.turnPage("slot_0", "page_1", page)).toBe("applied");
    expect(store.turnPage("slot_0", "page_1", page)).toBe("ignored");
    expect(store.checkpoint).toEqual(checkpoint());
    expect(store.get("slot_0")).toMatchObject({
      messages: [{ parts: [{ text: "start" }, { text: "page" }] }],
    });
  });

  test("backend overlapping page headers merge between first and latest messages", () => {
    const store = new NativeThreadStore();
    const first = {
      id: "first",
      role: "user" as const,
      metadata: { position: 0 },
      parts: [{ type: "text" as const, text: "prompt" }],
    };
    const last = {
      id: "last",
      role: "assistant" as const,
      metadata: { position: 2 },
      parts: [{ type: "text" as const, text: "final" }],
    };
    store.replay({
      kind: "window",
      checkpoint: checkpoint(),
      slots: [{ ...ready(0), messages: [first, last], partsCursor: "p_0_0" }],
    });
    expect(
      store.turnPage("slot_0", "p_0_0", {
        turnId: "turn_0",
        historyGeneration: 0,
        projectionRevision: 1,
        messages: [
          { ...first, parts: [] },
          { id: "middle", role: "assistant", metadata: { position: 1 }, parts: [] },
          { ...last, parts: [] },
        ],
        chunks: [
          { messageId: "first", partIndex: 0, part: { type: "text", text: "prompt" } },
          { messageId: "middle", partIndex: 0, part: { type: "text", text: "commentary" } },
          { messageId: "last", partIndex: 0, part: { type: "text", text: "final" } },
        ],
      }),
    ).toBe("applied");
    const slot = store.get("slot_0");
    expect(slot?.kind === "ready" && slot.messages.map((message) => message.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
  });

  test("late page cannot overwrite live updated turn", () => {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: checkpoint(),
      slots: [{ ...ready(0), partsCursor: "page_1" }],
    });
    store.update({
      checkpoint: checkpoint(2),
      changes: [
        {
          kind: "append-text",
          turnId: "turn_0",
          position: 0,
          messageId: "message_0",
          partIndex: 0,
          text: "new",
        },
      ],
    });
    expect(
      store.turnPage("slot_0", "page_1", {
        turnId: "turn_0",
        historyGeneration: 0,
        projectionRevision: 1,
        messages: [],
      }),
    ).toBe("ignored");
  });
});

describe("cache and catalog", () => {
  test("atomic patches retain unresolved slots on a current checkpoint", async () => {
    const cache = new MemoryNativeCache();
    const store = new NativeThreadStore();
    const writes: Promise<void>[] = [];
    store.subscribe(({ patch }) => {
      if (patch) writes.push(cache.commit(scope, "thread", patch));
    });
    store.replay({
      kind: "window",
      checkpoint: checkpoint(),
      slots: [{ kind: "deferred", slotId: "old", position: 0, endPosition: 2 }, ready(2)],
    });
    store.replay({ kind: "unchanged", checkpoint: { ...checkpoint(), cursor: "renewed" } });
    await Promise.all(writes);
    const restored = new NativeThreadStore();
    const value = await cache.read(scope, "thread");
    expect(value).toBeDefined();
    if (value) restored.restore(value);
    expect(restored.checkpoint?.cursor).toBe("renewed");
    expect(restored.get("old")?.kind).toBe("deferred");
    expect(await cache.read({ ...scope, principalId: "other" }, "thread")).toBeUndefined();
    await cache.purge(scope);
    expect(await cache.read(scope, "thread")).toBeUndefined();
    expect(await new NoNativeCache().read()).toBeUndefined();
  });

  test("static catalog autocomplete filters locally within authorized scope", () => {
    const catalogs = new DisplayCatalogCache();
    catalogs.put(scope, {
      revision: "v1",
      models: [],
      skills: [{ id: "review", name: "Code review", description: "Review code", source: "Repo" }],
      commands: [{ id: "model", name: "model", description: "Choose model", kind: "builtin" }],
    });
    expect(catalogs.complete(scope, "$", "")).toHaveLength(1);
    expect(catalogs.complete(scope, "/", "model")[0]?.insertText).toBe("/model");
    expect(catalogs.complete(scope, "/", "review")[0]?.insertText).toBe("/skill:Code review");
    expect(catalogs.complete({ ...scope, principalId: "other" }, "/", "")).toEqual([]);
  });

  test("slash completions order builtins, custom commands, then skills before applying the limit", () => {
    const catalogs = new DisplayCatalogCache();
    catalogs.put(scope, {
      revision: "v1",
      models: [],
      skills: [{ id: "skill", name: "aaa", description: "find", source: "Repo" }],
      commands: [
        { id: "custom", name: "bbb", description: "find", kind: "custom" },
        { id: "builtin", name: "zzz", description: "find", kind: "builtin" },
        { id: "prefix", name: "find", description: "", kind: "builtin" },
      ],
    });
    expect(catalogs.complete(scope, "/", "").map((item) => item.id)).toEqual([
      "prefix",
      "builtin",
      "custom",
      "skill",
    ]);
    expect(catalogs.complete(scope, "/", "find", 3).map((item) => item.id)).toEqual([
      "prefix",
      "builtin",
      "custom",
    ]);
    expect(catalogs.complete(scope, "$", "").map((item) => item.id)).toEqual(["skill"]);
    expect(catalogs.complete(scope, "/", "skill:aaa").map((item) => item.id)).toEqual(["skill"]);
  });
});

test("projection keys discard version 1 records while scope keys stay stable", () => {
  expect(JSON.parse(cacheProjectionKey(scope))).toEqual(["install", "owner", 1, 2]);
  expect(JSON.parse(cacheScopeKey(scope))).toEqual(["install", "owner", 1, 1]);
});
test("an invalid fragment publishes a restart cursor", () => {
  const store = new NativeThreadStore();
  const slot = { ...ready(0), partsCursor: "p_0_1" };
  store.replay({ kind: "window", checkpoint: checkpoint(), slots: [slot] });
  let published: string | undefined;
  store.subscribe((change) => {
    const put = change.patch?.put[0]?.slot;
    if (put?.kind === "ready") published = put.partsCursor;
  });
  expect(
    store.turnPage(slot.slotId, "p_0_1", {
      turnId: slot.turnId,
      historyGeneration: 0,
      projectionRevision: 1,
      messages: [],
      chunks: [
        {
          messageId: "message_0",
          partIndex: 1,
          part: { type: "text", text: "" },
          fragment: { offset: 0, total: 1, json: "!" },
        },
      ],
      nextCursor: "p_1_0",
    }),
  ).toBe("applied");
  expect(store.get(slot.slotId)).toMatchObject({ partsCursor: "p_0_1" });
  expect(published).toBe("p_0_1");
});
