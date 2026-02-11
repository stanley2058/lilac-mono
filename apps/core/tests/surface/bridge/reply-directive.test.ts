import { describe, expect, it } from "bun:test";

import {
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
