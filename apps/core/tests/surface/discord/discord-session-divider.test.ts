import { describe, expect, it } from "bun:test";

import {
  buildDiscordSessionDividerText,
  isDiscordSessionDividerText,
} from "../../../src/surface/discord/discord-session-divider";

describe("discord session divider", () => {
  it("builds compact divider text without timestamp", () => {
    const text = buildDiscordSessionDividerText({
      createdByUserName: "user",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(text).toBe("[LILAC_SESSION_DIVIDER] (by user)");
    expect(text).not.toContain("T00:00:00.000Z");
  });

  it("detects compact divider text", () => {
    expect(isDiscordSessionDividerText("[LILAC_SESSION_DIVIDER] (by user)")).toBe(true);
  });

  it("does not detect marker prefix in normal chat text", () => {
    expect(isDiscordSessionDividerText("[LILAC_SESSION_DIVIDER] please summarize this text")).toBe(
      false,
    );
  });

  it("normalizes label whitespace in compact format", () => {
    const text = buildDiscordSessionDividerText({
      createdByUserName: "user",
      label: "hello\nworld",
    });

    expect(text).toBe("[LILAC_SESSION_DIVIDER] (by user): hello world");
    expect(isDiscordSessionDividerText(text)).toBe(true);
  });

  it("still detects legacy divider text", () => {
    expect(isDiscordSessionDividerText("--- Session Divider ---\n[LILAC_SESSION_DIVIDER]")).toBe(
      true,
    );
  });
});
