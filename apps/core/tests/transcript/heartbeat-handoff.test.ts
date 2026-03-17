import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  buildHeartbeatHandoffTranscript,
  extractHeartbeatSurfaceSendHandoffs,
  HEARTBEAT_HANDOFF_TOOL_RESULT_PLACEHOLDER,
  isHeartbeatSessionId,
} from "../../src/transcript/heartbeat-handoff";

describe("heartbeat handoff transcripts", () => {
  it("extracts a proactive send handoff and compacts tool results", () => {
    const messages = [
      { role: "assistant", content: "Checked sources." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "bash-1",
            toolName: "bash",
            input: { command: "curl https://example.com/feed" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-1",
            toolName: "bash",
            output: { type: "text", value: "feed data" },
          },
        ],
      },
      { role: "assistant", content: "Need to proactively notify Stanley." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "bash-2",
            toolName: "bash",
            input: { command: 'tools surface.messages.send --text "Heads up"' },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-2",
            toolName: "bash",
            output: { type: "text", value: '{"ok":true}' },
          },
        ],
      },
      { role: "assistant", content: "Post-send cleanup." },
    ] satisfies ModelMessage[];

    const handoffs = extractHeartbeatSurfaceSendHandoffs(messages);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.messages).toHaveLength(7);
    expect(handoffs[0]?.finalText).toBe("Heads up");
    expect(handoffs[0]?.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Heads up",
    });

    const toolMessages = handoffs[0]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(2);
    for (const toolMessage of toolMessages) {
      expect(toolMessage.role).toBe("tool");
      if (!Array.isArray(toolMessage.content)) continue;
      const result = toolMessage.content[0];
      expect(result?.type).toBe("tool-result");
      if (result?.type !== "tool-result") continue;
      expect(result.output).toEqual({
        type: "text",
        value: HEARTBEAT_HANDOFF_TOOL_RESULT_PLACEHOLDER,
      });
    }
  });

  it("duplicates a handoff when one tool call sends multiple proactive messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "bash-1",
            toolName: "bash",
            input: {
              command:
                'tools surface.messages.send --text "one" && tools surface.messages.send --text "two"',
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    const handoffs = extractHeartbeatSurfaceSendHandoffs(messages);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]?.finalText).toBe("one");
    expect(handoffs[1]?.finalText).toBe("two");
  });

  it("extracts proactive send text from structured batch payloads", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "batch-1",
            toolName: "batch",
            input: {
              tool_calls: [
                {
                  tool: "surface.messages.send",
                  parameters: { text: "batched update" },
                },
              ],
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "batch-1",
            toolName: "batch",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    const handoffs = extractHeartbeatSurfaceSendHandoffs(messages);

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.finalText).toBe("batched update");
  });

  it("builds a fallback compacted transcript", () => {
    const transcript = buildHeartbeatHandoffTranscript([
      { role: "assistant", content: "Intro" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "x",
            toolName: "bash",
            output: { type: "text", value: "raw" },
          },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(transcript).not.toBeNull();
    expect(transcript?.finalText).toBe("Intro");
  });

  it("recognizes the reserved heartbeat session id", () => {
    expect(isHeartbeatSessionId("__heartbeat__")).toBe(true);
    expect(isHeartbeatSessionId("discord-session")).toBe(false);
  });
});
