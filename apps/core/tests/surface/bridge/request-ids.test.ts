import { describe, expect, it } from "bun:test";

import {
  formatDiscordMessageRequestId,
  formatDiscordSlashRequestId,
  formatGenericRequestId,
  formatQueuedRequestId,
  formatWorkflowRequestId,
  isDiscordRequestId,
  parseRequestId,
} from "../../../src/surface/bridge/request-ids";

describe("request id protocol", () => {
  it("roundtrips generic request ids", () => {
    const requestId = formatGenericRequestId("abc");
    expect(requestId).toBe("req:abc");
    expect(parseRequestId(requestId)).toEqual({ kind: "generic", id: "abc" });
  });

  it("roundtrips queued request ids", () => {
    const inner = formatDiscordMessageRequestId({ channelId: "c1", messageId: "m1" });
    const requestId = formatQueuedRequestId(inner);
    expect(requestId).toBe("queued:discord:c1:m1");
    expect(parseRequestId(requestId)).toEqual({ kind: "queued", requestId: inner });
  });

  it("roundtrips discord message request ids", () => {
    const requestId = formatDiscordMessageRequestId({ channelId: "c1", messageId: "m1" });
    expect(requestId).toBe("discord:c1:m1");
    expect(parseRequestId(requestId)).toEqual({
      kind: "discord_message",
      channelId: "c1",
      messageId: "m1",
    });
    expect(isDiscordRequestId(requestId)).toBe(true);
  });

  it("roundtrips discord slash request ids", () => {
    const requestId = formatDiscordSlashRequestId({ channelId: "c1", interactionId: "i1" });
    expect(requestId).toBe("discord:c1:slash:i1");
    expect(parseRequestId(requestId)).toEqual({
      kind: "discord_slash",
      channelId: "c1",
      interactionId: "i1",
    });
    expect(isDiscordRequestId(requestId)).toBe(true);
  });

  it("roundtrips workflow request ids", () => {
    const requestId = formatWorkflowRequestId({ workflowId: "wf:with:colon", sequence: 12 });
    expect(requestId).toBe("wf:wf:with:colon:12");
    expect(parseRequestId(requestId)).toEqual({
      kind: "workflow",
      workflowId: "wf:with:colon",
      sequence: 12,
    });
    expect(isDiscordRequestId(requestId)).toBe(false);
  });
});
