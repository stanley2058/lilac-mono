import { describe, expect, test } from "bun:test";
import { outlineContextWindows } from "./outline";

const gap = 2 * 60 * 60_000;
const turn = (position: number, createdAt: number | null, completedAt = createdAt) => ({
  position,
  createdAt,
  completedAt: completedAt === null ? null : completedAt + 1_000,
});

describe("outline context windows", () => {
  test("a pause longer than the gap starts a new window", () => {
    expect(
      outlineContextWindows(
        [turn(0, 0), turn(1, 60_000), turn(2, 60_000 + gap + 5_000), turn(3, 60_000 + gap + 9_000)],
        gap,
      ),
    ).toEqual([
      { firstPosition: 0, endPosition: 2, startAt: 0, endAt: 61_000 },
      {
        firstPosition: 2,
        endPosition: 4,
        startAt: 60_000 + gap + 5_000,
        endAt: 60_000 + gap + 10_000,
      },
    ]);
  });

  test("a pause exactly at the gap stays in the window, matching session selection", () => {
    expect(outlineContextWindows([turn(0, 0), turn(1, gap + 1_000)], gap)).toHaveLength(1);
  });

  test("the first window continues unless the turn before the page proves a gap", () => {
    const previous = turn(9, 0);
    expect(outlineContextWindows([turn(10, 60_000)], gap, previous)[0]?.continues).toBe(true);
    expect(outlineContextWindows([turn(10, gap * 2)], gap, previous)[0]?.continues).toBeUndefined();
  });

  test("turns without timing join the open window instead of splitting it", () => {
    expect(outlineContextWindows([turn(0, 0), turn(1, null), turn(2, 30_000)], gap)).toEqual([
      { firstPosition: 0, endPosition: 3, startAt: 0, endAt: 31_000 },
    ]);
  });
});
