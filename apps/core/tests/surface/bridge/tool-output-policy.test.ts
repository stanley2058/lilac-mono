import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  applyToolOutputCompactionView,
  maybeMarkOldToolOutputsCompacted,
  scrubLargeBinaryForModelView,
} from "../../../src/surface/bridge/bus-agent-runner";

function toolResult(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value },
      },
    ],
  };
}

describe("tool output model-view policy", () => {
  it("uses configured historical pruning thresholds and protects skill output", () => {
    const compacted = new Set<string>();
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      toolResult("old", "bash", "x".repeat(100)),
      toolResult("skill", "skill", "x".repeat(100)),
      { role: "user", content: "middle" },
      toolResult("middle", "bash", "current"),
      { role: "user", content: "new" },
      toolResult("new", "bash", "current"),
    ];

    expect(
      maybeMarkOldToolOutputsCompacted({
        messages,
        compactedToolCallIds: compacted,
        protectTokens: 1,
        minimumTokens: 1,
      }),
    ).toBeGreaterThan(0);
    expect(compacted).toEqual(new Set(["old"]));
    const view = applyToolOutputCompactionView({ messages, compactedToolCallIds: compacted });
    expect(JSON.stringify(view)).toContain("[Old tool result content cleared]");
    expect(JSON.stringify(view)).toContain("current");
    expect(
      maybeMarkOldToolOutputsCompacted({
        messages,
        compactedToolCallIds: compacted,
        protectTokens: 1,
        minimumTokens: 1,
      }),
    ).toBe(0);

    const disabledView = applyToolOutputCompactionView({
      messages,
      compactedToolCallIds: new Set(),
    });
    expect(disabledView).toEqual(messages);
  });

  it("keeps in-limit images and gives resize guidance for oversized images", () => {
    const image = (id: string, bytes: number): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read_file",
          output: {
            type: "content",
            value: [
              {
                type: "file",
                mediaType: "image/png",
                filename: `${id}.png`,
                data: { type: "data", data: Buffer.alloc(bytes).toString("base64") },
              },
            ],
          },
        },
      ],
    });
    const messages = [image("small", 4), image("large", 9)];
    const view = scrubLargeBinaryForModelView(messages, {
      maxBytesPerPart: 8,
      maxBytesTotal: 12,
    });
    expect(JSON.stringify(view[0])).toContain('"type":"file"');
    expect(JSON.stringify(view[1])).toContain("Resize the image before reading it again");
    expect(JSON.stringify(view[1])).toContain("large.png");

    const exact = scrubLargeBinaryForModelView([image("exact", 8)], {
      maxBytesPerPart: 8,
      maxBytesTotal: 8,
    });
    expect(JSON.stringify(exact)).toContain('"type":"file"');

    const cumulative = scrubLargeBinaryForModelView([image("one", 5), image("two", 5)], {
      maxBytesPerPart: 8,
      maxBytesTotal: 8,
    });
    expect(JSON.stringify(cumulative[0])).toContain("Resize the image before reading it again");
    expect(JSON.stringify(cumulative[1])).toContain('"type":"file"');
  });

  it("uses reduce-before-reading guidance for non-image files", () => {
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "pdf",
          toolName: "read_file",
          output: {
            type: "content",
            value: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "large.pdf",
                data: { type: "data", data: Buffer.alloc(9).toString("base64") },
              },
            ],
          },
        },
      ],
    };
    const view = scrubLargeBinaryForModelView([message], {
      maxBytesPerPart: 8,
      maxBytesTotal: 8,
    });
    expect(JSON.stringify(view)).toContain("must be reduced before reading it again");
    expect(JSON.stringify(view)).toContain("application/pdf");
  });
});
