import { describe, expect, it } from "bun:test";
import { ButtonStyle } from "discord.js";

import {
  buildDiscordActionComponents,
  buildDiscordActionCustomId,
  parseDiscordActionCustomId,
} from "../../../src/surface/discord/discord-actions";

describe("Discord generic surface actions", () => {
  it("renders review/run controls with opaque IDs and parses interactions", () => {
    const token = "85d381a4-fbb4-4414-8f07-a1b56578b48e";
    const rows = buildDiscordActionComponents([
      { actionId: token, label: "Approve", style: "success" },
      { actionId: "cancel-token-123456", label: "Cancel", style: "danger" },
    ]);
    const json = rows[0]?.toJSON();
    expect(json?.components).toHaveLength(2);
    expect(json?.components[0]).toMatchObject({
      custom_id: buildDiscordActionCustomId(token),
      label: "Approve",
      style: ButtonStyle.Success,
    });
    expect(parseDiscordActionCustomId(buildDiscordActionCustomId(token))).toBe(token);
    expect(parseDiscordActionCustomId("lilac_cancel:v2:channel:m:message")).toBeNull();
  });
});
