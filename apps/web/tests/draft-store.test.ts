import { expect, test } from "bun:test";
import { createDraftStore } from "../src/draft-store";
import { newDraftThread, prepareDraftSend } from "../src/draft-thread";

test("draft edits retain sidebar snapshots when the visible summary is unchanged", () => {
  const store = createDraftStore();
  const first = newDraftThread();
  first.draft.text = "a".repeat(80);
  const second = newDraftThread();
  second.draft.text = "Other draft";
  store.getState().setLocalDrafts(
    new Map([
      [first.id, first],
      [second.id, second],
    ]),
  );
  const summaries = store.getState().summaries;
  const ids = store.getState().ids;
  const edited = { ...first, draft: { ...first.draft, text: first.draft.text + " more typing" } };
  store.getState().setLocalDrafts(
    new Map([
      [first.id, edited],
      [second.id, second],
    ]),
  );
  expect(store.getState().summaries).toBe(summaries);
  expect(store.getState().localDrafts.get(first.id)).toBe(edited);
  expect(store.getState().localDrafts.get(second.id)).toBe(second);
  store.getState().setLocalDrafts(
    new Map([
      [first.id, { ...edited, title: "Renamed" }],
      [second.id, second],
    ]),
  );
  expect(store.getState().summaries[0]?.title).toBe("Renamed");
  expect(store.getState().ids).toBe(ids);
  expect(store.getState().summaries[1]).toBe(summaries[1]);
});

test("draft summaries track creation, clearing and removal without crossing sessions", () => {
  const store = createDraftStore();
  const other = createDraftStore();
  const draft = newDraftThread();
  draft.draft.text = "Ready";
  const creation = prepareDraftSend(draft, {
    text: "Ready",
    skillIds: [],
    attachments: [],
    mode: "steer",
  });
  store.getState().setLocalDrafts(new Map([[draft.id, { ...draft, creation }]]));
  expect(store.getState().summaries[0]?.editable).toBe(false);
  expect(other.getState().summaries).toEqual([]);
  expect(other.getState().localDrafts.has(draft.id)).toBe(false);
  store
    .getState()
    .setLocalDrafts(new Map([[draft.id, { ...draft, draft: { ...draft.draft, text: "" } }]]));
  expect(store.getState().summaries).toEqual([]);
  store.getState().setLocalDrafts(new Map());
  expect(store.getState().localDrafts.size).toBe(0);
});

test("rewind preparation claims survive navigation and reject stale owners", () => {
  const store = createDraftStore();
  const first = store.getState().claimRewind("dm", "turn", "question-draft")!;
  expect(store.getState().claimRewind("other", "other-turn")).toBeDefined();
  expect(store.getState().claimRewind("dm", "turn")).toBeUndefined();
  store.getState().setRewind("dm", first.owner, { ...first, running: false });
  const retry = store.getState().claimRewind("dm", "turn")!;
  expect(retry.owner).toBe(first.owner);
  expect(retry.draftKey).toBe("question-draft");
  store.getState().setRewind("dm", first.owner);
  const next = store.getState().claimRewind("dm", "next")!;
  store.getState().setRewind("dm", first.owner, first);
  store.getState().setRewind("dm", first.owner);
  expect(store.getState().rewinds.get("dm")).toBe(next);
});

test("completed rewind waits for its composer without allowing another claim", () => {
  const store = createDraftStore();
  const pending = store.getState().claimRewind("dm", "turn", "question-draft")!;
  const completed = {
    ...pending,
    running: false,
    completed: { text: "Restored", attachments: [] },
  };
  store.getState().setRewind("dm", pending.owner, completed);
  store.getState().claimRewind("other", "other-turn");
  expect(store.getState().rewinds.get("dm")).toBe(completed);
  expect(store.getState().claimRewind("dm", "turn")).toBeUndefined();
  store.getState().setRewind("dm", pending.owner);
  expect(store.getState().rewinds.has("dm")).toBe(false);
});
