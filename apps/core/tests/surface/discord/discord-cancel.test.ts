import { describe, expect, it } from "bun:test";

import {
  buildCancelCustomId,
  formatCancelCustomId,
  parseCancelCustomId,
} from "../../../src/surface/discord/discord-cancel";

describe("discord cancel customId", () => {
  it("roundtrips sessionId + requestId", () => {
    const sessionId = "c1";
    const requestId = "discord:c1:m1";
    const id = buildCancelCustomId({ sessionId, requestId });
    expect(id).not.toBeNull();
    expect(parseCancelCustomId(id!)).toEqual({ sessionId, requestId });
    expect(formatCancelCustomId({ sessionId, requestId })).toBe(id);
  });

  it("roundtrips typical slash request IDs under Discord's custom_id limit", () => {
    const sessionId = "1234567890123456789";
    const requestId = "discord:1234567890123456789:slash:9876543210987654321";
    const id = buildCancelCustomId({ sessionId, requestId });

    expect(id).not.toBeNull();
    expect(id!.length).toBeLessThanOrEqual(100);
    expect(parseCancelCustomId(id!)).toEqual({ sessionId, requestId });
  });

  it("roundtrips typical message request IDs under Discord's custom_id limit", () => {
    const sessionId = "1234567890123456789";
    const requestId = "discord:1234567890123456789:9876543210987654321";
    const id = buildCancelCustomId({ sessionId, requestId });

    expect(id).not.toBeNull();
    expect(id!.length).toBeLessThanOrEqual(100);
    expect(parseCancelCustomId(id!)).toEqual({ sessionId, requestId });
  });

  it("returns null if customId would exceed 100 chars", () => {
    const sessionId = "c";
    const requestId = "x".repeat(200);
    expect(buildCancelCustomId({ sessionId, requestId })).toBeNull();
  });
});
