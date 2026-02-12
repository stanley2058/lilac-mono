import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { buildSafeRecoveryCheckpoint } from "../../../src/surface/bridge/recovery-checkpoint";

describe("buildSafeRecoveryCheckpoint", () => {
  it("keeps complete transcripts unchanged", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      { role: "assistant", content: "done" },
    ] satisfies ModelMessage[];

    const checkpoint = buildSafeRecoveryCheckpoint(messages, "server restarted");
    expect(checkpoint).toEqual(messages);
  });

  it("synthesizes failed tool result for unresolved trailing tool call", () => {
    const messages = [
      { role: "user", content: "deploy" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "restart-1",
            toolName: "restart_server",
            input: {},
          },
        ],
      },
    ] satisfies ModelMessage[];

    const checkpoint = buildSafeRecoveryCheckpoint(messages, "server restarted");

    expect(checkpoint).toHaveLength(3);
    expect(checkpoint[1]).toEqual(messages[1]);
    expect(checkpoint[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "restart-1",
          toolName: "restart_server",
          output: {
            type: "error-text",
            value: "server restarted",
          },
        },
      ],
    });
  });

  it("keeps completed tool results and synthesizes only missing ones", () => {
    const messages = [
      { role: "user", content: "run both" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "bash",
            input: { command: "echo a" },
          },
          {
            type: "tool-call",
            toolCallId: "b",
            toolName: "restart_server",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] satisfies ModelMessage[];

    const checkpoint = buildSafeRecoveryCheckpoint(messages, "server restarted");
    expect(checkpoint).toHaveLength(4);
    expect(checkpoint[0]).toEqual(messages[0]);
    expect(checkpoint[1]).toEqual(messages[1]);
    expect(checkpoint[2]).toEqual(messages[2]);
    expect(checkpoint[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "restart_server",
          output: {
            type: "error-text",
            value: "server restarted",
          },
        },
      ],
    });
  });

  it("drops invalid standalone tool messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan",
            toolName: "bash",
            output: { type: "text", value: "x" },
          },
        ],
      },
      { role: "assistant", content: "should be removed" },
    ] satisfies ModelMessage[];

    const checkpoint = buildSafeRecoveryCheckpoint(messages, "server restarted");
    expect(checkpoint).toEqual([{ role: "user", content: "hi" }]);
  });
});
