import { describe, expect, test } from "bun:test";
import { isHiddenSlot, messageText, safeText, slotText, textWindow } from "../src/plaintext.ts";
import { deliveryMode, hasSkill } from "../src/controller.ts";

describe("terminal display", () => {
  test("removes OSC, cursor movement, C1 controls and bidi spoofing", () => {
    expect(
      safeText("hi\x1b]52;c;c2VjcmV0\x07there\x1b[2J!\x1bPpayload\x1b\\\x9b31m\u202etest"),
    ).toBe("hithere!test");
    expect(safeText("one\ntwo\tthree")).toBe("one\ntwo\tthree");
  });
  test("hides a wake's turn until the agent writes something", () => {
    const hidden = {
      kind: "ready",
      slotId: "t",
      turnId: "t",
      position: 0,
      messages: [],
      state: "complete",
    };
    expect(isHiddenSlot(hidden as never)).toBe(true);
    expect(
      isHiddenSlot({
        ...hidden,
        messages: [{ id: "m", role: "assistant", parts: [{ type: "text", text: "Reply" }] }],
      } as never),
    ).toBe(false);
    expect(isHiddenSlot({ kind: "deferred", slotId: "d" } as never)).toBe(false);
  });
  test("retains markdown, math and diagram source without rendering", () => {
    const source = "| A | B |\n|---|---|\n$x$\n```mermaid\nflowchart LR\n```";
    expect(
      messageText({ id: "m", role: "assistant", parts: [{ type: "text", text: source }] }),
    ).toBe(`assistant:\n${source}`);
  });
  test("bounds rendered lines and clamps scrolling", () => {
    const view = textWindow("x".repeat(10000), 20, 10, 100000);
    expect(view.lines).toHaveLength(10);
    expect(view.total).toBe(500);
    expect(view.offset).toBe(490);
  });
  test("placeholder failures stay actionable", () => {
    expect(
      slotText({
        kind: "failed",
        slotId: "s",
        position: 0,
        endPosition: 20,
        retryable: true,
        message: "Offline",
      }),
    ).toContain(":older retries");
  });
});

test("custom commands queue during active runs while ordinary prompts steer", () => {
  expect(deliveryMode(true, "steer", true)).toBe("followup");
  expect(deliveryMode(true, "steer", false)).toBe("steer");
  expect(deliveryMode(false, "followup", true)).toBe("prompt");
});
test("skill mentions include spaced names and reject partial matches", () => {
  expect(hasSkill("Use $Code Review please", "Code Review")).toBe(true);
  expect(hasSkill("/skill:Code Review", "Code Review")).toBe(true);
  expect(hasSkill("$Code Reviewer", "Code Review")).toBe(false);
});

test("terminal viewport wraps cells and preserves emoji and combining graphemes", () => {
  const input = "中文中文中文👩‍👩‍👧‍👦e\u0301中文";
  const window = textWindow(input, 8, 100, 0);
  expect(window.lines.join("")).toBe(input);
  for (const line of window.lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(8);
  expect(window.lines.some((line) => line.includes("👩‍👩‍👧‍👦"))).toBe(true);
  expect(window.lines.some((line) => line.includes("e\u0301"))).toBe(true);
});
