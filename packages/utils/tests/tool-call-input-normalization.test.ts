import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
  dedupeToolResultMessages,
  normalizeAssistantToolCallInputMessage,
  normalizeAssistantToolCallInputs,
  normalizeLegacyUserImagePartMessage,
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

  it("normalizes legacy user image parts to file parts", () => {
    const message: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        { type: "image", image: new URL("https://example.com/image.jpg") },
      ],
    };

    expect(normalizeLegacyUserImagePartMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        { type: "file", data: new URL("https://example.com/image.jpg"), mediaType: "image" },
      ],
    });
  });

  it("normalizes replay messages by repairing inputs, migrating images, and deduping tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
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
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
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
