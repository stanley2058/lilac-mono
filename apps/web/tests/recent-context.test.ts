import { expect, test } from "bun:test";
import { contextCoversTurn } from "../src/components/RecentContext";

test("a context read from before a fast reply settled does not mark a new context", () => {
  const turn = { startedAt: 1_000, settledAt: 1_400 };
  // The last poll ran while the DM was idle, before this turn was sent.
  expect(contextCoversTurn(900, turn)).toBe(false);
  // It also ran during the turn, which had not settled yet.
  expect(contextCoversTurn(1_200, turn)).toBe(false);
  expect(contextCoversTurn(1_400, turn)).toBe(true);
  expect(contextCoversTurn(undefined, turn)).toBe(false);
  expect(contextCoversTurn(5, {})).toBe(true);
});
