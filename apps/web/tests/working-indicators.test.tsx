import { expect, test } from "bun:test";
import {
  pastTense,
  rememberShownWorkingIndicator,
  settledWorkingIndicatorBucket,
  workingIndicatorAt,
  workingIndicatorBucket,
  WORKING_INDICATOR_INTERVAL_MS,
} from "../src/working-indicators";

const words = ["Brewing", "Photosynthesizing", "Tiptoeing", "Tuning", "Humming"];

test("past tense replaces a trailing -ing", () => {
  expect(
    ["Brewing", "Composing", "Humming", "Tiptoeing", "Origami-ing", "WORKING", "Zest"].map(
      pastTense,
    ),
  ).toEqual(["Brewed", "Composed", "Hummed", "Tiptoed", "Origami-ed", "WORKED", "Zest"]);
});

test("a turn picks the same word sequence everywhere and never repeats a word back to back", () => {
  const sequence = Array.from({ length: 50 }, (_, bucket) =>
    workingIndicatorAt(words, "turn_1", bucket),
  );
  expect(sequence).toEqual(
    Array.from({ length: 50 }, (_, bucket) => workingIndicatorAt(words, "turn_1", bucket)),
  );
  for (let index = 1; index < sequence.length; index += 1)
    expect(sequence[index]).not.toBe(sequence[index - 1]);
  expect(new Set(sequence).size).toBeGreaterThan(1);
  expect(workingIndicatorAt([], "turn_1", 3)).toBe("Working");
});

test("buckets advance once per interval", () => {
  expect(workingIndicatorBucket(-5)).toBe(0);
  expect(workingIndicatorBucket(WORKING_INDICATOR_INTERVAL_MS - 1)).toBe(0);
  expect(workingIndicatorBucket(WORKING_INDICATOR_INTERVAL_MS * 3)).toBe(3);
});

test("a turn watched live settles on the bucket it last showed", () => {
  expect(settledWorkingIndicatorBucket("turn_unseen", WORKING_INDICATOR_INTERVAL_MS * 5)).toBe(5);
  rememberShownWorkingIndicator("turn_seen", 4);
  expect(settledWorkingIndicatorBucket("turn_seen", WORKING_INDICATOR_INTERVAL_MS * 5)).toBe(4);
});
