import { describe, expect, it } from "bun:test";

import {
  isPossibleNoReplyPrefix,
  NO_REPLY_TOKEN,
  resolveReplyDeliveryFromFinalText,
} from "../../../src/surface/bridge/reply-directive";

describe("resolveReplyDeliveryFromFinalText", () => {
  it("marks exact NO_REPLY token as skip", () => {
    expect(resolveReplyDeliveryFromFinalText(NO_REPLY_TOKEN)).toBe("skip");
    expect(resolveReplyDeliveryFromFinalText(`  ${NO_REPLY_TOKEN}  `)).toBe("skip");
  });

  it("keeps normal replies as reply", () => {
    expect(resolveReplyDeliveryFromFinalText("hello")).toBe("reply");
    expect(resolveReplyDeliveryFromFinalText("NO_REPLY because ...")).toBe("reply");
  });
});

describe("isPossibleNoReplyPrefix", () => {
  it("accepts leading whitespace and partial token", () => {
    expect(isPossibleNoReplyPrefix("")).toBe(true);
    expect(isPossibleNoReplyPrefix(" ")).toBe(true);
    expect(isPossibleNoReplyPrefix("N")).toBe(true);
    expect(isPossibleNoReplyPrefix("NO_REP")).toBe(true);
    expect(isPossibleNoReplyPrefix(`\n${NO_REPLY_TOKEN}`)).toBe(true);
    expect(isPossibleNoReplyPrefix(`${NO_REPLY_TOKEN}   `)).toBe(true);
  });

  it("rejects text that can no longer become a silent token", () => {
    expect(isPossibleNoReplyPrefix("hello")).toBe(false);
    expect(isPossibleNoReplyPrefix("NO_REPLY because")).toBe(false);
    expect(isPossibleNoReplyPrefix("NO_REPLY.")).toBe(false);
  });
});
