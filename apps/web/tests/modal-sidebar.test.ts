import { expect, test } from "bun:test";
import { cycleTabStop } from "../src/modal-sidebar";

const stops = ["toggle", "search", "thread", "settings"];

test("Tab from the last sidebar control returns to the toggle", () => {
  expect(cycleTabStop(stops, "settings", false)).toBe("toggle");
  expect(cycleTabStop(stops, "search", false)).toBe("thread");
});

test("Shift+Tab from the toggle moves to the last sidebar control", () => {
  expect(cycleTabStop(stops, "toggle", true)).toBe("settings");
  expect(cycleTabStop(stops, "thread", true)).toBe("search");
});

test("focus that escaped to the page re-enters at the matching end", () => {
  expect(cycleTabStop(stops, undefined, false)).toBe("toggle");
  expect(cycleTabStop(stops, undefined, true)).toBe("settings");
});

test("focus in an element outside the stops is left to the browser", () => {
  expect(cycleTabStop(stops, "menu item", false)).toBeUndefined();
  expect(cycleTabStop([], undefined, false)).toBeUndefined();
});
