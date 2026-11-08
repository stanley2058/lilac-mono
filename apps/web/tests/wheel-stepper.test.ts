import { expect, test } from "bun:test";
import { createWheelStepper } from "../src/wheel-stepper";

const wheel = (deltaY: number, timeStamp: number, deltaMode = 0) => ({
  deltaY,
  deltaMode,
  timeStamp,
});

test("one mouse notch moves one step in its direction", () => {
  const step = createWheelStepper();
  expect(step(wheel(100, 0))).toBe(1);
  expect(step(wheel(-100, 1_000))).toBe(-1);
});

test("line-based wheels count the same as pixel ones", () => {
  expect(createWheelStepper()(wheel(3, 0, 1))).toBe(1);
});

test("small trackpad deltas add up to one step", () => {
  const step = createWheelStepper();
  expect([step(wheel(15, 0)), step(wheel(15, 16)), step(wheel(15, 32))]).toEqual([0, 0, 1]);
});

test("inertia right after a step does not skip the next view", () => {
  const step = createWheelStepper();
  expect(step(wheel(100, 0))).toBe(1);
  expect(step(wheel(100, 16))).toBe(0);
  expect(step(wheel(100, 150))).toBe(0);
  expect(step(wheel(100, 260))).toBe(1);
});

test("a pause discards distance from the earlier gesture", () => {
  const step = createWheelStepper();
  expect(step(wheel(30, 0))).toBe(0);
  expect(step(wheel(30, 500))).toBe(0);
});
