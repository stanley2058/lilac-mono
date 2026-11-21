import { expect, test } from "bun:test";
import {
  rewindReasonText,
  rewindRestrictionReason,
  rewindTooltipText,
  type RewindReason,
} from "../src/rewind-policy";

test("rewindTooltipText returns concise copy for every rewind reason", () => {
  const reasons: RewindReason[] = [
    "busy",
    "not-latest",
    "outside",
    "unsettled",
    "expired",
    "loading",
    "unavailable",
    "changed",
  ];
  for (const reason of reasons) {
    const tooltip = rewindTooltipText(reason);
    expect(tooltip.length).toBeGreaterThan(0);
    expect(tooltip.endsWith(".")).toBe(false);
    expect(tooltip.length).toBeLessThanOrEqual(rewindReasonText(reason).length);
  }
  expect(rewindTooltipText("busy")).toBe("Wait for active run to finish");
  expect(rewindTooltipText("not-latest")).toBe("Latest turn only");
  expect(rewindTooltipText("expired")).toBe("Rewind window expired");
});

test("rewindRestrictionReason resolves restriction reasons and non-latest turns", () => {
  expect(rewindRestrictionReason(undefined, "turn-1")).toBeUndefined();
  expect(rewindRestrictionReason({ reason: "busy" }, "turn-1")).toBe("busy");
  expect(rewindRestrictionReason({ turnId: "turn-2" }, "turn-1")).toBe("not-latest");
  expect(rewindRestrictionReason({ turnId: "turn-2" }, "turn-2")).toBeUndefined();
});
