import { describe, expect, it } from "bun:test";

import { HEARTBEAT_OK_TOKEN, isHeartbeatAckText } from "../../src/heartbeat/common";

describe("isHeartbeatAckText", () => {
  it("accepts bare and quoted heartbeat ack tokens", () => {
    expect(isHeartbeatAckText(HEARTBEAT_OK_TOKEN)).toBe(true);
    expect(isHeartbeatAckText(`  ${HEARTBEAT_OK_TOKEN}  `)).toBe(true);
    expect(isHeartbeatAckText(`"${HEARTBEAT_OK_TOKEN}"`)).toBe(true);
    expect(isHeartbeatAckText(`'${HEARTBEAT_OK_TOKEN}'`)).toBe(true);
    expect(isHeartbeatAckText(`\`${HEARTBEAT_OK_TOKEN}\``)).toBe(true);
  });

  it("rejects non-exact heartbeat ack text", () => {
    expect(isHeartbeatAckText("HEARTBEAT_OK all good")).toBe(false);
    expect(isHeartbeatAckText(`"${HEARTBEAT_OK_TOKEN}" all good`)).toBe(false);
    expect(isHeartbeatAckText("<b>HEARTBEAT_OK</b>")).toBe(false);
  });
});
