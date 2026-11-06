import { expect, test } from "bun:test";
import { createFileEditors } from "./file-editors";
test("a completed save retains edits made while the save was pending", () => {
  const store = createFileEditors();
  const actions = store.getState();
  actions.load("file", { path: "/file", text: "first", revision: "1" });
  actions.edit("file", "second");
  actions.edit("file", "third");
  actions.saved("file", { path: "/file", text: "second", revision: "2" });
  expect(store.getState().drafts.get("file")).toEqual({
    path: "/file",
    text: "third",
    savedText: "second",
    revision: "2",
  });
  expect(store.getState().dirty.has("file")).toBe(true);
  actions.edit("file", "second");
  expect(store.getState().dirty.has("file")).toBe(false);
});
test("background reads cannot replace a draft and discarding releases it", () => {
  const store = createFileEditors();
  const actions = store.getState();
  actions.load("file", { path: "/file", text: "first", revision: "1" });
  actions.edit("file", "draft");
  actions.load("file", { path: "/file", text: "external", revision: "2" });
  expect(store.getState().drafts.get("file")?.text).toBe("draft");
  actions.discard("file");
  expect(store.getState().drafts.size).toBe(0);
  expect(store.getState().dirty.size).toBe(0);
});
