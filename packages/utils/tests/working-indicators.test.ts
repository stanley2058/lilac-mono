import { describe, expect, it } from "bun:test";

import { createWorkingIndicatorQueue, formatWorkingStatus } from "../working-indicators";

describe("working indicators", () => {
  it("formats a shared spinner frame and elapsed time", () => {
    expect(
      formatWorkingStatus({ nowMs: 21_500, startedAtMs: 20_000, indicator: " Compiling " }),
    ).toBe("⣽ Compiling... 1s");
  });

  it("creates a shuffled queue without mutating the source", () => {
    const indicators = ["One", "Two", "Three"] as const;
    const randomValues = [0, 0];
    const queue = createWorkingIndicatorQueue(indicators, () => randomValues.shift() ?? 0);

    expect(queue).toEqual(["Two", "Three", "One"]);
    expect(indicators).toEqual(["One", "Two", "Three"]);
  });
});
