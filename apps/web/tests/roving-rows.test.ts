import { expect, test } from "bun:test";
import { rovingTarget } from "../src/components/roving-rows";

test("arrow keys move to the next row with a control and stop at either end", () => {
  // Row 2 is a divider with nothing to focus.
  const focusable = (index: number) => index !== 2;
  expect(rovingTarget(1, "ArrowDown", 5, focusable)).toBe(3);
  expect(rovingTarget(3, "ArrowUp", 5, focusable)).toBe(1);
  expect(rovingTarget(4, "ArrowDown", 5, focusable)).toBeUndefined();
  expect(rovingTarget(0, "ArrowUp", 5, focusable)).toBeUndefined();
  expect(rovingTarget(3, "Home", 5, (index) => index > 0)).toBe(1);
  expect(rovingTarget(0, "End", 5, (index) => index < 4)).toBe(3);
});
