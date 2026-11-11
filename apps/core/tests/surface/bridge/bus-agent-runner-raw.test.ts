import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  parseGuildIdFromRaw,
  parseParentChannelIdFromRaw,
  parseRequestControlFromRaw,
} from "../../../src/surface/bridge/bus-agent-runner/raw";

const EMPTY_REQUEST_CONTROL = {
  requiresActive: false,
  autoFollowUp: null,
  cancel: false,
  cancelQueued: false,
  targetMessageId: null,
};

describe("session hierarchy raw projection", () => {
  it("projects normalized parent channel and guild ids", () => {
    const raw = { parentChannelId: " parent ", guildId: " guild " };

    expect(parseParentChannelIdFromRaw(raw)).toBe("parent");
    expect(parseGuildIdFromRaw(raw)).toBe("guild");
  });
});

describe("request control raw projection", () => {
  it("projects valid own request-control fields", () => {
    expect(
      parseRequestControlFromRaw({
        requiresActive: true,
        autoFollowUp: { parentRequestId: "parent", parentToolCallId: "call" },
        cancel: true,
        cancelQueued: true,
        messageId: "message-1",
        unrelated: "preserved only in opaque raw",
      }),
    ).toEqual({
      requiresActive: true,
      autoFollowUp: { parentRequestId: "parent", parentToolCallId: "call" },
      cancel: true,
      cancelQueued: true,
      targetMessageId: "message-1",
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "cancel"],
    ["string cancel", { cancel: "true" }],
    ["numeric cancel", { cancel: 1 }],
  ] as const)("fails closed for malformed %s raw", (_, raw) => {
    expect(parseRequestControlFromRaw(raw)).toEqual(EMPTY_REQUEST_CONTROL);
  });

  it("ignores inherited fields and hostile accessors without invoking them", () => {
    let getterCalls = 0;
    const inherited = Object.setPrototypeOf({}, { cancel: true, requiresActive: true });
    const accessor = Object.defineProperty({}, "cancel", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile getter must not run");
      },
    });

    expect(parseRequestControlFromRaw(inherited)).toEqual(EMPTY_REQUEST_CONTROL);
    expect(parseRequestControlFromRaw(accessor)).toEqual(EMPTY_REQUEST_CONTROL);
    expect(getterCalls).toBe(0);
  });

  it("preserves Panic from hostile record reflection", () => {
    const panic = new Panic({ message: "request-control reflection invariant failed" });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw panic;
        },
      },
    );

    expect(() => parseRequestControlFromRaw(hostile)).toThrow(panic);
  });
});
