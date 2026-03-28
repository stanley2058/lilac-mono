import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  dedupeToolResultMessages,
  normalizeAssistantToolCallInputMessage,
  normalizeAssistantToolCallInputs,
  normalizeReplayMessages,
  normalizeToolCallInputValue,
} from "../tool-call-input-normalization";

describe("tool call input normalization", () => {
  it("parses stringified object tool inputs", () => {
    expect(normalizeToolCallInputValue('{"path":"note.txt","replaceAll":false}')).toEqual({
      path: "note.txt",
      replaceAll: false,
    });
  });

  it("repairs truncated object json when a closer is missing", () => {
    expect(
      normalizeToolCallInputValue(
        '{"path":"note.txt","edits":[{"op":"replace","lines":["after"]}}',
      ),
    ).toEqual({
      path: "note.txt",
      edits: [
        {
          op: "replace",
          lines: ["after"],
        },
      ],
    });
  });

  it("leaves invalid json unchanged", () => {
    expect(normalizeToolCallInputValue('{"path":')).toBe('{"path":');
  });

  it("leaves primitive and array json unchanged", () => {
    expect(normalizeToolCallInputValue('"hello"')).toBe('"hello"');
    expect(normalizeToolCallInputValue("[1,2,3]")).toBe("[1,2,3]");
  });

  it("normalizes assistant tool-call messages only", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "edit_file",
          input: '{"path":"note.txt","oldText":"before","newText":"after"}',
        },
      ],
    };
    const tool: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "edit_file",
          output: { type: "json", value: { ok: true } },
        },
      ],
    };

    expect(normalizeAssistantToolCallInputMessage(assistant)).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "edit_file",
          input: {
            path: "note.txt",
            oldText: "before",
            newText: "after",
          },
        },
      ],
    });
    expect(normalizeAssistantToolCallInputMessage(tool)).toBe(tool);
  });

  it("normalizes arrays of messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: '{"path":"note.txt"}',
          },
        ],
      },
    ];

    expect(normalizeAssistantToolCallInputs(messages)).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: { path: "note.txt" },
          },
        ],
      },
    ]);
  });

  it("drops duplicate tool results for the same toolCallId", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: { path: "note.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "edit_file",
            output: { type: "error-text", value: "first" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "edit_file",
            output: { type: "error-text", value: "second" },
          },
        ],
      },
    ];

    expect(dedupeToolResultMessages(messages)).toEqual(messages.slice(0, 2));
  });

  it("normalizes replay messages by repairing inputs and deduping tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: '{"path":"note.txt","edits":[{"op":"replace","lines":["after"]}}',
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "edit_file",
            output: { type: "error-text", value: "first" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "edit_file",
            output: { type: "error-text", value: "second" },
          },
        ],
      },
    ];

    expect(normalizeReplayMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: {
              path: "note.txt",
              edits: [
                {
                  op: "replace",
                  lines: ["after"],
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
            toolCallId: "call-1",
            toolName: "edit_file",
            output: { type: "error-text", value: "first" },
          },
        ],
      },
    ]);
  });
});
