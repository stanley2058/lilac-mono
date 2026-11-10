import { expect, test } from "bun:test";
import { highlightParts } from "../src/components/search-highlight";

test("search terms are marked wherever they appear, ignoring case", () => {
  expect(highlightParts("Search latency investigation", "LATENCY search")).toEqual([
    { text: "Search", match: true },
    { text: " ", match: false },
    { text: "latency", match: true },
    { text: " investigation", match: false },
  ]);
  expect(highlightParts("a.b and a+b", "a+b")).toEqual([
    { text: "a.b and ", match: false },
    { text: "a+b", match: true },
  ]);
  expect(highlightParts("unchanged", "  ")).toEqual([{ text: "unchanged", match: false }]);
});
