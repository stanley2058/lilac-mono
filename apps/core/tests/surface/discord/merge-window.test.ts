import { describe, expect, it } from "bun:test";

import {
  mergeByDiscordWindow,
  splitByDiscordWindowOldestToNewest,
} from "../../../src/surface/discord/merge-window";

describe("discord merge window", () => {
  it("splits groups by author and group-start window", () => {
    const minuteMs = 60_000;
    const groups = splitByDiscordWindowOldestToNewest([
      { authorId: "u", ts: 47 * minuteMs, id: "a" },
      { authorId: "u", ts: 50 * minuteMs, id: "b" },
      { authorId: "u", ts: 55 * minuteMs, id: "c" },
      { authorId: "v", ts: 56 * minuteMs, id: "d" },
    ]);

    expect(groups.map((g) => g.map((m) => m.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
  });

  it("merges only the newest discord-style group for descending input", () => {
    const minuteMs = 60_000;
    const out = mergeByDiscordWindow([
      { messageId: "c", authorId: "u", ts: 55 * minuteMs, content: "C" },
      { messageId: "b", authorId: "u", ts: 50 * minuteMs, content: "B" },
      { messageId: "a", authorId: "u", ts: 47 * minuteMs, content: "A" },
    ]);

    expect(out.mergedMessageIds).toEqual(["c"]);
    expect(out.mergedText).toBe("C");
  });
});
