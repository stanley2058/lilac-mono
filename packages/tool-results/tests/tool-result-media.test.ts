import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { boundToolResultMediaForModelView } from "../src/tool-result-media";

describe("tool result media", () => {
  it("bounds every inline media representation while preserving remote URLs", () => {
    const encoded = Buffer.alloc(5, 1).toString("base64");
    const remoteUrl = "https://example.test/image.png";
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "media",
            toolName: "plugin",
            output: {
              type: "content",
              value: [
                {
                  type: "file",
                  data: { type: "data", data: Buffer.alloc(5, 2) },
                  mediaType: "application/pdf",
                },
                { type: "file-data", data: encoded, mediaType: "application/pdf" },
                { type: "image-data", data: encoded, mediaType: "image/png" },
                { type: "file-url", url: `DATA:application/pdf;base64,${encoded}` },
                { type: "image-url", url: `data:image/png;base64,${encoded}` },
                { type: "image-url", url: remoteUrl },
              ],
            },
          },
        ],
      },
    ];

    const view = boundToolResultMediaForModelView(messages, {
      maxBytesPerPart: 4,
      maxBytesTotal: 20,
    });
    expect(JSON.stringify(view)).not.toContain(encoded);
    expect(JSON.stringify(view)).toContain(remoteUrl);
  });

  it("retains newest media while enforcing the decoded aggregate limit", () => {
    const result = (id: string): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read",
          output: {
            type: "content",
            value: [
              {
                type: "file",
                data: { type: "data", data: Buffer.alloc(4, id).toString("base64") },
                mediaType: "image/png",
                filename: `${id}.png`,
              },
            ],
          },
        },
      ],
    });
    const messages = [result("old"), result("new")];
    const view = boundToolResultMediaForModelView(messages, {
      maxBytesPerPart: 4,
      maxBytesTotal: 4,
    });

    expect(JSON.stringify(view[0])).toContain("Resize the image");
    expect(JSON.stringify(view[1])).toContain(Buffer.alloc(4, "new").toString("base64"));
  });

  it("bounds malformed percent-encoded data URLs without throwing", () => {
    const malformedUrl = "data:text/plain,%";
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "malformed-data-url",
            toolName: "read",
            output: {
              type: "content",
              value: [{ type: "file-url", url: malformedUrl, mediaType: "text/plain" }],
            },
          },
        ],
      },
    ];

    expect(
      boundToolResultMediaForModelView(messages, {
        maxBytesPerPart: 1,
        maxBytesTotal: 1,
      }),
    ).toEqual(messages);
  });
});
