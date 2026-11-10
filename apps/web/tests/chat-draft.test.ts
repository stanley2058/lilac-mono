import { describe, expect, test } from "bun:test";
import { shallow } from "zustand/shallow";
import { localDraftSummary, localThreadSettings } from "../src/components/chat-draft";
import { newDraftThread } from "../src/draft-thread";

describe("local conversation selectors", () => {
  test("typing more text keeps both selections shallow-equal", () => {
    const thread = { ...newDraftThread(), draft: { text: "h", skillIds: [], attachments: [] } };
    const typed = { ...thread, draft: { ...thread.draft, text: "hello" } };
    expect(shallow(localThreadSettings(thread), localThreadSettings(typed))).toBe(true);
    expect(shallow(localDraftSummary(thread), localDraftSummary(typed))).toBe(true);
  });

  test("the summary changes when the draft gains its first text", () => {
    const thread = newDraftThread();
    const typed = { ...thread, draft: { ...thread.draft, text: "h" } };
    expect(shallow(localDraftSummary(thread), localDraftSummary(typed))).toBe(false);
  });
});
