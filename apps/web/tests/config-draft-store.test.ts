import { expect, it } from "bun:test";
import { createConfigDraftStore } from "../src/config-ui/draft-store";
import { createConfigSaveLock } from "../src/config-ui/save-lock";

function loaded() {
  const store = createConfigDraftStore();
  store.getState().load({ kind: "core", revision: "core_old", text: "configVersion: 3\n" });
  store.getState().load({ kind: "mcp", revision: "mcp_old", text: "configVersion: 1\n" });
  return store;
}

it("settles a late Core save only in the Core draft", () => {
  const store = loaded();
  store.getState().setText("core", "configVersion: 3\nbasePrompt: hi\n");
  const mcp = store.getState().drafts.mcp;
  const { editRevision } = store.getState().drafts.core!;
  store.getState().completeSave("core", editRevision, {
    kind: "core",
    revision: "core_new",
    text: "configVersion: 3\nbasePrompt: hi\n",
  });
  expect(store.getState().drafts.mcp).toBe(mcp);
  expect(store.getState().drafts.core?.saved.revision).toBe("core_new");
  expect(store.getState().drafts.core?.status).toBe("Saved");
});

it("preserves newer typing while advancing the revision for the next save", () => {
  const store = loaded();
  store.getState().setText("core", "configVersion: 3\nbasePrompt: a\n");
  const { editRevision } = store.getState().drafts.core!;
  store.getState().setText("core", "configVersion: 3\nbasePrompt: ab\n");
  store.getState().completeSave("core", editRevision, {
    kind: "core",
    revision: "core_new",
    text: "configVersion: 3\nbasePrompt: a\n",
  });
  const draft = store.getState().drafts.core!;
  expect(draft.text).toBe("configVersion: 3\nbasePrompt: ab\n");
  expect(draft.saved.revision).toBe("core_new");
  expect(draft.status).toContain("unsaved");
});

it("records form edits for replay and drops them after a YAML edit", () => {
  const store = loaded();
  expect(store.getState().apply("core", [{ op: "set", path: ["basePrompt"], value: "x" }])).toBe(
    undefined,
  );
  expect(store.getState().drafts.core?.operations).toHaveLength(1);
  expect(store.getState().drafts.core?.value).toEqual({ configVersion: 3, basePrompt: "x" });
  store.getState().setText("core", "configVersion: 3\nbasePrompt: y\n");
  expect(store.getState().drafts.core?.operations).toBeNull();
});

it("keeps the last valid value out of a draft with a syntax error", () => {
  const store = loaded();
  store.getState().setText("core", "configVersion: [\n");
  expect(store.getState().drafts.core?.value).toBeUndefined();
  expect(store.getState().drafts.core?.parseError).toBeTruthy();
  store.getState().discard("core");
  expect(store.getState().drafts.core?.text).toBe("configVersion: 3\n");
});

it("replays form edits on a newer file, or leaves the draft alone when they no longer apply", () => {
  const store = loaded();
  store.getState().apply("core", [{ op: "set", path: ["agent", "idleTimeoutMs"], value: 5 }]);
  const operations = store.getState().drafts.core!.operations!;
  const before = store.getState().drafts.core;
  const failed = store
    .getState()
    .rebase(
      { kind: "core", revision: "core_new", text: "configVersion: 3\nagent: off\n" },
      operations,
    );
  expect(failed).toBeDefined();
  expect(store.getState().drafts.core).toBe(before);
  const latest = {
    kind: "core",
    revision: "core_new",
    text: "configVersion: 3\nbasePrompt: x\n",
  } as const;
  expect(store.getState().rebase(latest, operations)).toBeUndefined();
  expect(store.getState().drafts.core?.saved.revision).toBe("core_new");
  expect(store.getState().drafts.core?.value).toEqual({
    configVersion: 3,
    basePrompt: "x",
    agent: { idleTimeoutMs: 5 },
  });
});

it("allows one save at a time per file", () => {
  const lock = createConfigSaveLock();
  const first = lock.getState().begin("mcp");
  expect(first).toBe(1);
  expect(lock.getState().begin("mcp")).toBeUndefined();
  expect(lock.getState().begin("core")).toBe(1);
  lock.getState().end("mcp", first!);
  expect(lock.getState().begin("mcp")).toBe(2);
});

it("counts wholesale replacements so field editors can drop local text", () => {
  const store = loaded();
  store.getState().apply("core", [{ op: "set", path: ["basePrompt"], value: "x" }]);
  expect(store.getState().drafts.core?.resets).toBe(0);
  store.getState().discard("core");
  expect(store.getState().drafts.core?.resets).toBe(1);
  store.getState().replace({ kind: "core", revision: "core_new", text: "configVersion: 3\n" });
  expect(store.getState().drafts.core?.resets).toBe(2);
});
