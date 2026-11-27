import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { stripRejectedInputMedia } from "../../src/agent/rejected-input-media-recovery";

const details = {
  aiErrorName: "AgentAdapterFailure",
  aiErrorMessage: "This file format is not supported for this request.",
  statusCode: 400,
  providerMessage: "This file format is not supported for this request.",
  providerCode: "unsupported_parameter",
  providerType: "invalid_request_error",
  providerParam: "input",
};
const error = { name: "AgentAdapterFailure", message: details.aiErrorMessage, statusCode: 400 };

const history: ModelMessage = { role: "assistant", content: "earlier answer" };
const messages: ModelMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "read this" },
      { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
    ],
  },
  history,
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call", toolName: "read_file", input: {} }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "read_file",
        output: {
          type: "content",
          value: [
            { type: "text", text: "Attached file from read: ntmayor.pdf" },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "ntmayor.pdf",
              data: { type: "data", data: "JVBERi0=" },
            },
          ],
        },
      },
    ],
  },
];

test("replaces user and tool-result attachments with notes that name the file", () => {
  const stripped = stripRejectedInputMedia({ error, details, messages });
  expect(stripped).not.toBeNull();
  expect(stripped![1]).toBe(history);
  expect(stripped![2]).toBe(messages[2]!);
  expect(stripped![0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "read this" },
      {
        type: "text",
        text: expect.stringContaining("Attachment image/png was removed"),
      },
    ],
  });
  expect(stripped![3]).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call",
        output: {
          type: "content",
          value: [
            { type: "text", text: "Attached file from read: ntmayor.pdf" },
            {
              type: "text",
              text: expect.stringContaining(
                "Attachment 'ntmayor.pdf' (application/pdf) was removed because the model provider rejected it: This file format is not supported for this request.",
              ),
            },
          ],
        },
      },
    ],
  });
  expect(messages[3]).toHaveProperty("content.0.output.value.1.type", "file");
  expect(stripRejectedInputMedia({ error, details, messages: stripped! })).toBeNull();
});

test("leaves auth, transient, and context-overflow errors to other handlers", () => {
  expect(stripRejectedInputMedia({ error, details: undefined, messages })).toBeNull();
  expect(
    stripRejectedInputMedia({ error, details: { ...details, statusCode: 401 }, messages }),
  ).toBeNull();
  expect(
    stripRejectedInputMedia({
      error: { ...error, isRetryable: true },
      details,
      messages,
    }),
  ).toBeNull();
  expect(
    stripRejectedInputMedia({
      error: {
        name: "AI_APICallError",
        statusCode: 413,
        message: "Request exceeds the byte limit after encoding images",
        responseBody: '{"error":{"type":"request_too_large"}}',
      },
      details: {
        ...details,
        statusCode: 413,
        providerMessage: "Request exceeds the byte limit after encoding images",
      },
      messages,
    }),
  ).toBeNull();
});

test("recovers from rejections that do not name the attachment in plain words", () => {
  expect(
    stripRejectedInputMedia({
      error,
      details: { ...details, providerMessage: "Unsupported value: input_file" },
      messages,
    }),
  ).not.toBeNull();
  const stripped = stripRejectedInputMedia({
    error,
    details: { ...details, statusCode: 415, providerMessage: "", aiErrorMessage: "" },
    messages,
  });
  expect(stripped?.[0]).toHaveProperty(
    "content.1.text",
    expect.stringContaining("rejected it: HTTP 415 with no error message."),
  );
});
