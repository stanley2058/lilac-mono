import { describe, expect, it } from "bun:test";

import {
  buildCancelCustomId,
  parseCancelCustomId,
} from "../../../src/surface/discord/discord-cancel";

describe("discord cancel customId", () => {
  it("roundtrips sessionId + requestId", () => {
    const sessionId = "c1";
    const requestId = "discord:c1:m1";
    const id = buildCancelCustomId({ sessionId, requestId });
    expect(id).not.toBeNull();
    expect(parseCancelCustomId(id!)).toEqual({ sessionId, requestId });
  });

  it("returns null if customId would exceed 100 chars", () => {
    const sessionId = "c";
    const requestId = "x".repeat(200);
    expect(buildCancelCustomId({ sessionId, requestId })).toBeNull();
  });
});
