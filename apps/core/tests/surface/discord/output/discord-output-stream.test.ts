import { describe, expect, it } from "bun:test";

import {
  buildThinkingDisplay,
  escapeDiscordMarkdown,
  normalizeReasoningDetail,
  tailReasoningDetail,
} from "../../../../src/surface/discord/output/discord-output-stream";

describe("escapeDiscordMarkdown", () => {
  it("escapes emphasis markers in glob-like patterns", () => {
    expect(escapeDiscordMarkdown("**/*")).toBe("\\*\\*/\\*");
  });

  it("escapes common markdown control characters", () => {
    expect(escapeDiscordMarkdown("[x](y) _z_ `k` ~u~")).toBe(
      "\\[x\\]\\(y\\) \\_z\\_ \\`k\\` \\~u\\~",
    );
  });
});

describe("reasoning display helpers", () => {
  it("normalizes line breaks and whitespace", () => {
    expect(normalizeReasoningDetail("foo\n\n  bar   baz")).toBe("foo bar baz");
  });

  it("keeps the tail of long reasoning output", () => {
    expect(tailReasoningDetail("0123456789", 4)).toBe("6789");
  });

  it("renders simple thinking status with spinner and elapsed seconds", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 10_500,
        startedAtMs: 10_000,
        mode: "simple",
      }),
    ).toBe("⣟ Thinking... 0s");
  });

  it("renders detailed thinking status with normalized tail text", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 21_500,
        startedAtMs: 20_000,
        mode: "detailed",
        detailText: "line 1\nline 2",
      }),
    ).toBe("⣽ Thinking... 1s\nline 1 line 2");
  });

  it("renders empty output for none mode", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 21_500,
        startedAtMs: 20_000,
        mode: "none",
        detailText: "line 1\nline 2",
      }),
    ).toBe("");
  });
});
