import { describe, expect, it } from "bun:test";

import {
  buildMarkdownContinuationPrefix,
  getMarkdownContinuationState,
} from "../../../../src/surface/discord/output/markdown-state";

describe("markdown-state", () => {
  it("should not reopen closed block math at EOF", () => {
    const state = getMarkdownContinuationState("$$\nx = y\n$$");

    expect(buildMarkdownContinuationPrefix(state)).toBe("");
  });

  it("should close an outer markdown fence with a longer marker than an unclosed nested example", () => {
    const state = getMarkdownContinuationState("````md\n```ts\nconst x = 1;\n````");

    expect(buildMarkdownContinuationPrefix(state)).toBe("");
  });
});
