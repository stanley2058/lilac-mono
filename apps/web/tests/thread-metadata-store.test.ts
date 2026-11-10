import { expect, test } from "bun:test";
import type { ClientEvent } from "@stanley2058/lilac-client";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { createThreadMetadataStore, followClientThreads } from "../src/thread-metadata-store";
import { sidebarSnapshot } from "../src/sidebar-order";

function thread(revision: number, title: string, archived = false): NativeThread {
  return {
    id: "thread",
    kind: "thread",
    title,
    archived,
    updatedAt: revision * 1000,
    revision,
  } as NativeThread;
}

test("a stale list page never replaces newer metadata", () => {
  const store = createThreadMetadataStore([thread(1, "First")]);
  store.getState().put([thread(3, "Renamed")]);
  store.getState().put([thread(2, "Older page")]);
  expect(store.getState().threads.get("thread")?.title).toBe("Renamed");
});

test("live updates reach the store and the sidebar rows read them over their page", () => {
  const store = createThreadMetadataStore();
  let listener: ((event: ClientEvent) => void) | undefined;
  const stop = followClientThreads(store, {
    subscribe: (callback) => {
      listener = callback;
      return () => {};
    },
  });
  listener!({ kind: "thread", thread: thread(4, "Renamed live") });
  const page = [thread(2, "Page copy")];
  const queues = sidebarSnapshot([{ section: "active", items: page, updatedAt: 1 }], [], (id) =>
    store.getState().threads.get(id),
  );
  expect(queues.active[0]?.source?.title).toBe("Renamed live");
  listener!({ kind: "thread", thread: thread(5, "Archived", true) });
  expect(
    sidebarSnapshot([{ section: "active", items: page, updatedAt: 1 }], [], (id) =>
      store.getState().threads.get(id),
    ).active,
  ).toEqual([]);
  listener!({ kind: "removed", threadId: "thread" });
  expect(store.getState().threads.has("thread")).toBe(false);
  stop();
});
