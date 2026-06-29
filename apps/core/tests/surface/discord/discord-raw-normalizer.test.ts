import { describe, expect, it } from "bun:test";

import {
  DISCORD_REFERENCE_TYPE_FORWARD,
  normalizeDiscordRaw,
} from "../../../src/surface/discord/discord-raw-normalizer";

describe("discord-raw-normalizer", () => {
  it("normalizes persisted message rows", () => {
    const normalized = normalizeDiscordRaw({
      content: "hello",
      embeds: [{ title: "preview" }],
      reference: {
        messageId: "root",
        channelId: "channel",
        type: 0,
      },
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/file.txt",
          filename: "file.txt",
          mimeType: "text/plain",
          size: 12,
        },
      ],
    });

    expect(normalized?.content).toBe("hello");
    expect(normalized?.embeds).toEqual([{ title: "preview" }]);
    expect(normalized?.attachments).toEqual([
      {
        url: "https://cdn.discordapp.com/attachments/1/file.txt",
        filename: "file.txt",
        mimeType: "text/plain",
        size: 12,
      },
    ]);
    expect(normalized?.replyReference).toEqual({
      messageId: "root",
      channelId: "channel",
    });
  });

  it("normalizes adapter event fallback fields from the discord envelope", () => {
    const normalized = normalizeDiscordRaw({
      discord: {
        content: "fallback content",
        embeds: [{ description: "fallback embed" }],
        replyToMessageId: "parent",
        referenceType: 0,
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/1/image.png",
            name: "image.png",
            contentType: "image/png",
          },
        ],
      },
    });

    expect(normalized?.content).toBe("fallback content");
    expect(normalized?.embeds).toEqual([{ description: "fallback embed" }]);
    expect(normalized?.attachments).toEqual([
      {
        url: "https://cdn.discordapp.com/attachments/1/image.png",
        filename: "image.png",
        mimeType: "image/png",
      },
    ]);
    expect(normalized?.replyReference).toEqual({ messageId: "parent" });
  });

  it("treats null or malformed optional nested objects as absent", () => {
    const normalized = normalizeDiscordRaw({
      content: "top content",
      embeds: [{ title: "top embed" }],
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/top.png",
          filename: "top.png",
        },
      ],
      reference: null,
      discord: "legacy-corrupt-envelope",
    });

    expect(normalized?.content).toBe("top content");
    expect(normalized?.embeds).toEqual([{ title: "top embed" }]);
    expect(normalized?.attachments).toEqual([
      {
        url: "https://cdn.discordapp.com/attachments/1/top.png",
        filename: "top.png",
      },
    ]);
    expect(normalized?.reference).toBeUndefined();
    expect(normalized?.replyReference).toBeUndefined();
  });

  it("treats forwarded references as roots and exposes the visible snapshot", () => {
    const normalized = normalizeDiscordRaw({
      reference: {
        type: DISCORD_REFERENCE_TYPE_FORWARD,
        messageId: "original",
        channelId: "other",
      },
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/original/hidden.png",
          filename: "hidden.png",
        },
      ],
      messageSnapshots: [
        {
          message: {
            content: "forwarded content",
            embeds: [{ title: "forwarded title" }],
            attachments: [
              {
                url: "https://cdn.discordapp.com/attachments/forward/visible.png",
                filename: "visible.png",
              },
            ],
          },
        },
      ],
    });

    expect(normalized?.replyReference).toBeUndefined();
    expect(normalized?.forwardSnapshot?.content).toBe("forwarded content");
    expect(normalized?.forwardSnapshot?.embeds).toEqual([{ title: "forwarded title" }]);
    expect(normalized?.forwardSnapshot?.attachments).toEqual([
      {
        url: "https://cdn.discordapp.com/attachments/forward/visible.png",
        filename: "visible.png",
      },
    ]);
  });
});
