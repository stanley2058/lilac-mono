import { describe, expect, it } from "bun:test";

import { getDiscordSurfaceDisplayText } from "../../../src/surface/discord/discord-surface-display-text";

describe("discord-surface-display-text", () => {
  it("prefers stored tagged text over raw embed reconstruction", () => {
    const text = getDiscordSurfaceDisplayText({
      fallbackText: ["normal-text", "[discord_embed]", "embed-title", "embed-description"].join(
        "\n\n",
      ),
      raw: {
        content: "normal-text",
        embeds: [
          {
            title: "embed-title",
            description: "embed-description",
            fields: [{ name: "field-1", value: "value-1" }],
            footer: { text: "embed-footer" },
          },
        ],
      },
    });

    expect(text).toBe(
      ["normal-text", "[discord_embed]", "embed-title", "embed-description"].join("\n\n"),
    );
    expect(text).not.toContain("field-1");
    expect(text).not.toContain("embed-footer");
  });

  it("preserves stored untagged embed-only bot fallback text", () => {
    const text = getDiscordSurfaceDisplayText({
      fallbackText: ["embed-title", "embed-description"].join("\n\n"),
      raw: {
        content: "",
        embeds: [
          {
            title: "embed-title",
            description: "embed-description",
          },
        ],
      },
    });

    expect(text).toBe(["embed-title", "embed-description"].join("\n\n"));
    expect(text).not.toContain("[discord_embed]");
  });

  it("falls back to raw surface reconstruction when tagged text is missing", () => {
    const text = getDiscordSurfaceDisplayText({
      raw: {
        content: "normal-text",
        embeds: [
          {
            title: "embed-title",
            description: "embed-description",
            fields: [{ name: "field-1", value: "value-1" }],
            image: { url: "https://example.com/image.png" },
            footer: { text: "embed-footer" },
          },
        ],
      },
    });

    expect(text).toBe(
      [
        "normal-text",
        "embed-title",
        "embed-description",
        "field-1: value-1",
        "https://example.com/image.png",
        "embed-footer",
      ].join("\n\n"),
    );
  });
});
