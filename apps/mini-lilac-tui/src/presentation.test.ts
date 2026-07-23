import { describe, expect, it } from "bun:test";

import {
  formatSessionTitle,
  formatTokenCount,
  formatTokenUsage,
  resolveContextWindow,
  sessionPresentation,
} from "./presentation";

describe("presentation formatting", () => {
  it("formats token counts with compact K and M suffixes", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(12_450)).toBe("12.5K");
    expect(formatTokenCount(999_999)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("derives rounded context usage and hides unavailable values", () => {
    expect(formatTokenUsage(12_500, 50_000)).toBe("12.5K (25%)");
    expect(formatTokenUsage(0, 128_000)).toBe("0 (0%)");
    expect(formatTokenUsage(null, 128_000)).toBeUndefined();
    expect(formatTokenUsage(12_500, null)).toBeUndefined();
  });

  it("falls back to catalog context limits for migrated resumed sessions", () => {
    expect(resolveContextWindow(null, 128_000)).toBe(128_000);
    expect(resolveContextWindow(64_000, 128_000)).toBe(64_000);
    expect(resolveContextWindow(null, undefined)).toBeNull();
  });

  it("limits source titles to one hundred characters", () => {
    const title = formatSessionTitle("x".repeat(101));
    expect(Array.from(title)).toHaveLength(100);
    expect(title.endsWith("...")).toBe(true);
  });

  it("normalizes absent snapshot presentation fields", () => {
    expect(sessionPresentation(undefined)).toEqual({
      title: "Mini Lilac",
      inputTokens: null,
      contextWindow: null,
    });
    expect(
      sessionPresentation({ title: "Fix streaming", inputTokens: 4_000, contextWindow: 16_000 }),
    ).toEqual({ title: "Fix streaming", inputTokens: 4_000, contextWindow: 16_000 });
  });
});
