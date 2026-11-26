import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { buildSafeRecoveryCheckpoint } from "../recovery-checkpoint";

describe("buildSafeRecoveryCheckpoint", () => {
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

  it("keeps a complete inline provider tool exchange unchanged", () => {
    const messages = [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "inline",
            toolName: "mcp__lilac__read",
            input: { path: "README.md" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "inline",
            toolName: "mcp__lilac__read",
            output: { type: "text", value: "contents" },
          },
          { type: "text", text: "done" },
        ],
      },
    ] satisfies ModelMessage[];

    expect(buildSafeRecoveryCheckpoint(messages)).toEqual(messages);
  });

  it("synthesizes failure only for a dangling call in a mixed inline exchange", () => {
    const messages = [
      { role: "user", content: "run both" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "complete",
            toolName: "mcp__lilac__read",
            input: {},
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "complete",
            toolName: "mcp__lilac__read",
            output: { type: "text", value: "ok" },
          },
          {
            type: "tool-call",
            toolCallId: "dangling",
            toolName: "mcp__lilac__bash",
            input: {},
            providerExecuted: true,
          },
        ],
      },
    ] satisfies ModelMessage[];

    const checkpoint = buildSafeRecoveryCheckpoint(messages);
    expect(checkpoint.slice(0, 2)).toEqual(messages);
    expect(checkpoint[2]).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "dangling", output: { type: "error-text" } }],
    });
  });
});
