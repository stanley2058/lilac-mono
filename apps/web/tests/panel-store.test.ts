import { describe, expect, test } from "bun:test";
import { createPanelStore, defaultRightPanel } from "../src/panel-store";

const scope = { installationId: "installation", principalId: "viewer" };
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("local panel layouts", () => {
  test("restores global sidebar and independent right panels across reloads", () => {
    const storage = memoryStorage();
    const store = createPanelStore(scope, storage).getState();
    store.resizeSidebar(345);
    store.toggleSidebar();
    store.resize("thread-a", 480);
    store.toggle("thread-a");
    store.resize("thread-b", 280);
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.sidebar).toEqual({ open: false, width: 345 });
    expect(loaded.threads.get("thread-a")).toEqual({ open: true, width: 480 });
    expect(loaded.threads.get("thread-b")).toEqual({ open: false, width: 280 });
    loaded.toggle("thread-b");
    loaded.toggle("thread-a");
    const again = createPanelStore(scope, storage).getState();
    expect(again.threads.get("thread-a")).toEqual({ open: false, width: 480 });
    expect(again.threads.get("thread-b")).toEqual({ open: true, width: 280 });
  });

  test("isolates installations and users", () => {
    const storage = memoryStorage();
    createPanelStore(scope, storage).getState().toggleSidebar();
    createPanelStore(scope, storage).getState().openFile("shared-thread-id", {
      type: "path",
      path: "/tmp/a.md",
      name: "a.md",
    });
    for (const other of [
      { ...scope, principalId: "other" },
      { ...scope, installationId: "other" },
    ]) {
      const state = createPanelStore(other, storage).getState();
      expect(state.sidebar.open).toBe(true);
      expect(state.threads.size).toBe(0);
      expect(state.tabs.size).toBe(0);
    }
  });

  test("opening a subagent saves only its thread layout, not transcript selection", () => {
    const storage = memoryStorage();
    const store = createPanelStore(scope, storage);
    store.getState().resize("a", 440);
    store.getState().select("a", "child-agent");
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.threads.get("a")).toEqual({ open: true, width: 440 });
    expect(loaded.threads.get("b") ?? defaultRightPanel).toEqual({ open: false, width: 360 });
    expect(loaded.selection).toBeUndefined();
  });

  test("transfers a local draft layout to its created thread", () => {
    const storage = memoryStorage();
    const state = createPanelStore(scope, storage).getState();
    state.resize("draft:a", 460);
    state.toggle("draft:a");
    state.moveThread("draft:a", "created-a");
    const loaded = createPanelStore(scope, storage).getState();
    expect(loaded.threads.has("draft:a")).toBe(false);
    expect(loaded.threads.get("created-a")).toEqual({ open: true, width: 460 });
  });

  test.each([
    "{invalid",
    JSON.stringify({ sidebar: { open: true, width: -10 }, threads: [] }),
    JSON.stringify({
      sidebar: { open: true, width: 288 },
      threads: [["a", { open: "yes", width: 360 }]],
    }),
    JSON.stringify({
      sidebar: { open: true, width: 288 },
      threads: [["a", { open: true, width: 99999 }]],
    }),
  ])("ignores invalid local layouts: %s", (raw) => {
    const storage = { getItem: () => raw, setItem: () => {} };
    const state = createPanelStore(scope, storage).getState();
    expect(state.sidebar).toEqual({ open: true, width: 288 });
    expect(state.threads.size).toBe(0);
  });

  test("keeps controls usable when storage is blocked", () => {
    const storage = {
      getItem: (): string => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createPanelStore(scope, storage);
    store.getState().toggleSidebar();
    store.getState().resize("a", 400);
    store.getState().toggle("a");
    expect(store.getState().sidebar.open).toBe(false);
    expect(store.getState().threads.get("a")).toEqual({ open: true, width: 400 });
  });

  test("unscoped design demos never read or write device preferences", () => {
    let accesses = 0;
    const storage = {
      getItem: () => {
        accesses++;
        return null;
      },
      setItem: () => {
        accesses++;
      },
    };
    const demo = createPanelStore(undefined, storage);
    demo.getState().toggle("demo");
    demo.getState().resize("demo", 400);
    expect(accesses).toBe(0);
    expect(createPanelStore(undefined, storage).getState().threads.size).toBe(0);
  });
});

test("file tabs coexist with Agents, refocus without duplicates, and stay per thread", () => {
  const storage = memoryStorage();
  const store = createPanelStore(scope, storage);
  const actions = store.getState();
  const a = { type: "path", path: "/tmp/a.md", name: "a.md", line: 123 } as const;
  const b = {
    type: "resource",
    href: "/api/resources/b",
    resourceId: "b",
    name: "b.pdf",
    mediaType: "application/pdf",
  } as const;
  actions.resize("thread", 480);
  actions.openFile("thread", a);
  const layout = store.getState().threads.get("thread");
  actions.openFile("thread", b);
  actions.openFile("thread", { ...a, line: 140 });
  expect(store.getState().tabs.get("thread")?.items).toHaveLength(3);
  expect(store.getState().tabs.get("thread")?.activeId).toBe("path:/tmp/a.md");
  expect(store.getState().threads.get("thread")).toBe(layout);
  actions.select("thread", "agent");
  expect(store.getState().tabs.get("thread")?.activeId).toBe("agents");
  actions.openAgents("thread");
  expect(store.getState().tabs.get("thread")?.items).toHaveLength(3);
  actions.openFile("other", b);
  expect(store.getState().tabs.get("other")?.items).toHaveLength(2);
  actions.moveThread("thread", "saved");
  expect(store.getState().tabs.get("saved")?.items).toHaveLength(3);
  expect(store.getState().tabs.has("thread")).toBe(false);
  expect(createPanelStore(scope, storage).getState().tabs).toEqual(store.getState().tabs);
});

test("closing tabs selects a neighbor and Agents can be reopened after the last tab closes", () => {
  const store = createPanelStore();
  const actions = store.getState();
  actions.openFile("thread", { type: "path", path: "/a", name: "a" });
  actions.openFile("thread", { type: "path", path: "/b", name: "b" });
  actions.closeTab("thread", "path:/b");
  expect(store.getState().tabs.get("thread")?.activeId).toBe("path:/a");
  actions.closeTab("thread", "agents");
  expect(store.getState().tabs.get("thread")?.activeId).toBe("path:/a");
  actions.closeTab("thread", "path:/a");
  expect(store.getState().tabs.get("thread")?.items).toEqual([]);
  actions.openAgents("thread");
  expect(store.getState().tabs.get("thread")).toEqual({
    items: [{ id: "agents", type: "agents" }],
    activeId: "agents",
  });
});

test("resolved path aliases merge into the existing tab and retain line navigation", () => {
  const store = createPanelStore();
  const actions = store.getState();
  const resolved = {
    type: "resource",
    path: "/work/a.ts",
    href: "/api/files/a",
    name: "a.ts",
    mediaType: "text/plain",
  } as const;
  actions.openFile("thread", resolved);
  actions.openFile("thread", { type: "path", path: "./a.ts", name: "a.ts", line: 123 });
  actions.resolveFile("thread", "path:./a.ts", { ...resolved, line: 123 });
  expect(store.getState().tabs.get("thread")).toEqual({
    items: [
      { id: "agents", type: "agents" },
      { id: "path:/work/a.ts", type: "file", target: { ...resolved, line: 123 } },
    ],
    activeId: "path:/work/a.ts",
  });
});

test("restores independent tab order and selection, including closed tabs and an empty panel", () => {
  const storage = memoryStorage();
  const store = createPanelStore(scope, storage);
  const a = { type: "path", path: "/tmp/a.md", name: "a.md", line: 12, endLine: 15 } as const;
  const b = {
    type: "resource",
    href: "/api/resources/b",
    resourceId: "b",
    name: "b.pdf",
    mediaType: "application/pdf",
  } as const;
  store.getState().openFile("a", a);
  store.getState().openFile("a", b);
  store.getState().openFile("b", b);
  store.getState().focusTab("a", "path:/tmp/a.md");
  store.getState().toggle("a");
  const loaded = createPanelStore(scope, storage);
  expect(loaded.getState().tabs).toEqual(store.getState().tabs);
  expect(loaded.getState().threads.get("a")?.open).toBe(false);
  loaded.getState().closeTab("a", "resource:b");
  loaded.getState().closeTab("b", "resource:b");
  loaded.getState().closeTab("b", "agents");
  const reloaded = createPanelStore(scope, storage);
  expect(
    reloaded
      .getState()
      .tabs.get("a")
      ?.items.map((tab) => tab.id),
  ).toEqual(["agents", "path:/tmp/a.md"]);
  expect(reloaded.getState().tabs.get("b")).toEqual({ items: [] });
  reloaded.getState().openFile("a", a);
  expect(reloaded.getState().tabs.get("a")?.items).toHaveLength(2);
});

test("reads existing layout preferences and ignores malformed tab data independently", () => {
  const layout = {
    sidebar: { open: false, width: 330 },
    threads: [["a", { open: true, width: 470 }]],
  };
  for (const value of [layout, { ...layout, tabs: [["a", { items: [], activeId: "missing" }]] }]) {
    const storage = { getItem: () => JSON.stringify(value), setItem: () => {} };
    const state = createPanelStore(scope, storage).getState();
    expect(state.sidebar).toEqual(layout.sidebar);
    expect(state.threads.get("a")).toEqual({ open: true, width: 470 });
    expect(state.tabs.size).toBe(0);
  }
});

test("published links and canonical inline paths share a tab in either opening order", () => {
  const published = {
    type: "resource",
    href: "/api/files/published",
    name: "example.md",
    mediaType: "text/markdown",
  } as const;
  const resolved = { ...published, path: "/tmp/example.md", line: 12, endLine: 15 };
  for (const [first, second] of [
    [published, resolved],
    [resolved, published],
  ] as const) {
    const store = createPanelStore();
    store.getState().openFile("thread", first);
    const id = store.getState().tabs.get("thread")?.activeId;
    store.getState().openFile("thread", second);
    expect(store.getState().tabs.get("thread")?.items).toHaveLength(2);
    expect(store.getState().tabs.get("thread")?.activeId).toBe(id);
  }
  const store = createPanelStore();
  store.getState().openFile("thread", published);
  store.getState().openFile("thread", { type: "path", path: "./example.md", name: "example.md" });
  store.getState().resolveFile("thread", "path:./example.md", resolved);
  expect(store.getState().tabs.get("thread")?.items).toHaveLength(2);
  expect(store.getState().tabs.get("thread")?.items[1]).toMatchObject({ target: resolved });
  expect(store.getState().tabs.get("thread")?.activeId).toBe("resource:/api/files/published");
});

test("refocusing a resolved file preserves its media type and path while updating navigation", () => {
  const store = createPanelStore();
  const target = {
    type: "resource",
    href: "/api/files/image",
    path: "/tmp/image.png",
    name: "image.png",
    mediaType: "image/png",
    line: 12,
  } as const;
  store.getState().openFile("thread", target);
  store.getState().openFile("thread", {
    type: "resource",
    href: target.href,
    name: target.name,
    mediaType: "application/octet-stream",
  });
  expect(store.getState().tabs.get("thread")?.items[1]).toMatchObject({
    target: { path: target.path, mediaType: "image/png" },
  });
  store.getState().openFile("thread", {
    type: "path",
    path: target.path,
    name: target.name,
    line: 4,
    endLine: 6,
  });
  expect(store.getState().tabs.get("thread")?.items[1]).toMatchObject({
    target: {
      type: "resource",
      href: target.href,
      path: target.path,
      mediaType: "image/png",
      line: 4,
      endLine: 6,
    },
  });
  expect(store.getState().tabs.get("thread")?.items).toHaveLength(2);
});

test("thread previews reuse a conversation tab and preserve message navigation on reload", () => {
  const storage = memoryStorage();
  const store = createPanelStore(scope, storage);
  store
    .getState()
    .openThread(
      "origin",
      { surface: "discord", sessionId: "session", messageId: "first" },
      "Title",
      "conversation",
    );
  store
    .getState()
    .openThread(
      "origin",
      { surface: "discord", sessionId: "session", messageId: "second" },
      "Title",
      "conversation",
    );
  store
    .getState()
    .openThread(
      "origin",
      { surface: "discord", sessionId: "session", messageId: "third" },
      "Other",
      "other-conversation",
    );
  const restored = createPanelStore(scope, storage).getState();
  const tabs = restored.tabs.get("origin")!.items.filter((tab) => tab.type === "thread");
  expect(tabs).toHaveLength(2);
  expect(tabs[0]?.target.messageId).toBe("second");
  expect(restored.threads.get("origin")?.open).toBe(true);
});

test("computer geometry survives conversation switches within its workspace session", () => {
  const storage = memoryStorage();
  const panels = createPanelStore(scope, storage);
  const first = { x: 120, y: 80, width: 600, height: 400 };
  const second = { x: 8, y: 8, width: 320, height: 240 };
  panels.getState().setComputerGeometry("a", first);
  panels.getState().setComputerGeometry("b", second);
  panels.getState().openAgents("b");
  panels.getState().openAgents("a");
  expect(panels.getState().computerGeometry.get("a")).toEqual(first);
  expect(panels.getState().computerGeometry.get("b")).toEqual(second);
  expect(createPanelStore(scope, storage).getState().computerGeometry.size).toBe(0);
});
