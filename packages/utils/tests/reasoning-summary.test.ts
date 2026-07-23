import { describe, expect, it } from "bun:test";

import { parseReasoningSummary } from "../reasoning-summary";

describe("parseReasoningSummary", () => {
  it("extracts a leading title and body", () => {
    expect(parseReasoningSummary("**Inspecting the stream**\n\nChecking event ordering.")).toEqual({
      title: "Inspecting the stream",
      body: "Checking event ordering.",
    });
  });

  it("accepts a title without a body", () => {
    expect(parseReasoningSummary("**Inspecting the stream**")).toEqual({
      title: "Inspecting the stream",
      body: "",
    });
  });

  it("preserves ordinary leading bold prose", () => {
    expect(parseReasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    });
  });
});
