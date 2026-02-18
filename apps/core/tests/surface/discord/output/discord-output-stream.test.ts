import { describe, expect, it } from "bun:test";

import {
  buildOutputAllowedMentions,
  buildThinkingDisplay,
  clampReasoningDetail,
  escapeDiscordMarkdown,
  formatReasoningAsBlockquote,
  toPreviewTail,
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
  it("clamps long reasoning output and preserves leading content", () => {
    expect(clampReasoningDetail("0123456789", 4)).toBe("012…");
  });

  it("renders reasoning text as blockquote lines", () => {
    expect(formatReasoningAsBlockquote("**Title**\nline 1\nline 2")).toBe(
      "> **Title**\n> line 1\n> line 2",
    );
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

  it("renders detailed thinking status with blockquoted detail", () => {
    expect(
      buildThinkingDisplay({
        nowMs: 21_500,
        startedAtMs: 20_000,
        mode: "detailed",
        detailText: "line 1\nline 2",
      }),
    ).toBe("⣽ Thinking... 1s\n> line 1\n> line 2");
  });

  it("clamps detailed reasoning body to 512 chars", () => {
    const detail = `${"a".repeat(520)}\n${"b".repeat(10)}`;
    const output = buildThinkingDisplay({
      nowMs: 21_500,
      startedAtMs: 20_000,
      mode: "detailed",
      detailText: detail,
    });

    expect(output.startsWith("⣽ Thinking... 1s\n> ")).toBe(true);
    expect(output.includes("…")).toBe(true);
    expect(output.length).toBeLessThanOrEqual("⣽ Thinking... 1s\n> ".length + 512);
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

describe("preview tail helper", () => {
  it("returns input unchanged when already within limit", () => {
    expect(toPreviewTail("hello", 10)).toBe("hello");
  });

  it("tails to exact max length with ellipsis prefix", () => {
    const out = toPreviewTail("0123456789", 6);
    expect(out).toBe("...789");
    expect(out.length).toBe(6);
  });
});

describe("output mention policy", () => {
  it("disables reply and mentions when notifications are off", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: false,
        previewMode: false,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("suppresses notifications on preview transient lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: false,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("enables user mentions and reply ping on preview final lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: ["users"], repliedUser: true });
  });
});
