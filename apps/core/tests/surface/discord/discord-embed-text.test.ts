import { describe, expect, it } from "bun:test";

import {
  buildDiscordModelContextTextFromContentAndEmbeds,
  buildDiscordRichTextFromContentAndEmbeds,
  normalizeDiscordEmbeds,
} from "../../../src/surface/discord/discord-embed-text";

describe("discord-embed-text", () => {
  it("includes title/description/image in inbound mode", () => {
    const embeds = normalizeDiscordEmbeds([
      {
        title: "embed-title",
        description: "embed-description",
        fields: [{ name: "field-1", value: "value-1" }],
        image: { url: "https://example.com/image.png" },
        footer: { text: "embed-footer" },
      },
    ]);

    const text = buildDiscordRichTextFromContentAndEmbeds({
      content: "normal-text",
      embeds,
      mode: "inbound",
    });

    expect(text).toBe(
      ["normal-text", "embed-title", "embed-description", "https://example.com/image.png"].join(
        "\n\n",
      ),
    );
  });

  it("includes fields/footer in surface mode", () => {
    const embeds = normalizeDiscordEmbeds([
      {
        title: "embed-title",
        description: "embed-description",
        fields: [
          { name: "field-1", value: "value-1" },
          { name: "field-2", value: "value-2" },
        ],
        image: { url: "https://example.com/image.png" },
        footer: { text: "embed-footer" },
      },
    ]);

    const text = buildDiscordRichTextFromContentAndEmbeds({
      content: "normal-text",
      embeds,
      mode: "surface",
    });

    expect(text).toBe(
      [
        "normal-text",
        "embed-title",
        "embed-description",
        "field-1: value-1\nfield-2: value-2",
        "https://example.com/image.png",
        "embed-footer",
      ].join("\n\n"),
    );
  });

  it("keeps compatibility for string-only embeds", () => {
    const embeds = normalizeDiscordEmbeds(["legacy description"]);

    const text = buildDiscordRichTextFromContentAndEmbeds({
      content: "",
      embeds,
      mode: "surface",
    });

    expect(text).toBe("legacy description");
  });

  it("preserves intentional leading and trailing whitespace in content", () => {
    const text = buildDiscordRichTextFromContentAndEmbeds({
      content: "  line with padding  ",
      embeds: [],
      mode: "inbound",
    });

    expect(text).toBe("  line with padding  ");
  });

  it("labels embeds separately for model context", () => {
    const embeds = normalizeDiscordEmbeds([
      {
        title: "embed-title",
        description: "embed-description",
        fields: [{ name: "field-1", value: "value-1" }],
        image: { url: "https://example.com/image.png" },
        footer: { text: "embed-footer" },
      },
    ]);

    const text = buildDiscordModelContextTextFromContentAndEmbeds({
      content: "normal-text",
      embeds,
    });

    expect(text).toBe(
      [
        "normal-text",
        "[discord_embed]",
        "embed-title",
        "embed-description",
        "https://example.com/image.png",
      ].join("\n\n"),
    );
    expect(text).not.toContain("field-1");
    expect(text).not.toContain("embed-footer");
  });
});
