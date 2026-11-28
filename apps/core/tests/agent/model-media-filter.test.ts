import { expect, test } from "bun:test";
import { cloneMessages } from "@stanley2058/lilac-agent";
import type { ModelMessage } from "ai";
import { createModelMediaFilter } from "../../src/agent/model-media-filter";

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
const vision = { family: "ai-sdk", supportsImage: true, supportsPdf: true } as const;
const textOnly = { family: "ai-sdk", supportsImage: false, supportsPdf: false } as const;
const claudeCode = { family: "claude-code", supportsImage: true, supportsPdf: false } as const;

const acceptedImage = { type: "image" as const, image: "iVBORw0KGgo=", mediaType: "image/png" };
const rejectedPdf = {
  type: "file" as const,
  mediaType: "application/pdf",
  filename: "ntmayor.pdf",
  data: { type: "data" as const, data: "JVBERi0=" },
};
const messages: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "read this" }, acceptedImage] },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call",
        toolName: "read",
        input: { path: "/workspace/ntmayor.pdf" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "read",
        output: {
          type: "content",
          value: [{ type: "text", text: "Attached file from read: ntmayor.pdf" }, rejectedPdf],
        },
      },
    ],
  },
];

test("omits latest-turn media after a rejection, in the view alone, with the read path", () => {
  const filter = createModelMediaFilter();
  expect(filter.recordRejection({ error, details, messages })).toBe(true);

  const view = filter.apply(cloneMessages(messages), vision);
  expect(view[0]).toEqual(messages[0]!);
  expect(view[2]).toHaveProperty("content.0.output.value", [
    { type: "text", text: "Attached file from read: ntmayor.pdf" },
    {
      type: "text",
      text: '[attachment_omitted filename="ntmayor.pdf" mime="application/pdf" code="provider_rejected"] The model provider rejected the request that included this file, so it is left out. Provider error: This file format is not supported for this request. To use the file, convert it or extract its contents with a tool from /workspace/ntmayor.pdf.',
    },
  ]);
  expect(messages[2]).toHaveProperty("content.0.output.value.1", rejectedPdf);
});

test("widens to earlier media once the latest turn is omitted, then stops retrying", () => {
  const filter = createModelMediaFilter();
  expect(filter.recordRejection({ error, details, messages })).toBe(true);
  expect(filter.apply(messages, vision)[0]).toEqual(messages[0]!);

  expect(filter.recordRejection({ error, details, messages })).toBe(true);
  expect(filter.apply(messages, vision)[0]).toHaveProperty(
    "content.1.text",
    expect.stringContaining('[attachment_omitted mime="image/png" code="provider_rejected"]'),
  );
  expect(filter.recordRejection({ error, details, messages })).toBe(false);
});

test("retries a replayed earlier attachment when the latest turn has no media", () => {
  const filter = createModelMediaFilter();
  const nextRun: ModelMessage[] = [
    ...messages,
    { role: "assistant", content: "The PDF could not be read directly." },
    { role: "user", content: "summarize it anyway" },
  ];
  expect(filter.recordRejection({ error, details, messages: nextRun })).toBe(true);
  expect(filter.apply(nextRun, vision)[2]).toHaveProperty(
    "content.0.output.value.1.text",
    expect.stringContaining('code="provider_rejected"'),
  );
});

test("matches recorded media by content across cloned steps and provider options", () => {
  const filter = createModelMediaFilter();
  expect(filter.recordRejection({ error, details, messages })).toBe(true);
  const later: ModelMessage[] = [
    ...cloneMessages(messages),
    { role: "assistant", content: "noted" },
    {
      role: "user",
      content: [
        { type: "text", text: "try again" },
        { ...rejectedPdf, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      ],
    },
  ];
  expect(filter.apply(later, vision)[4]).toHaveProperty(
    "content.1.text",
    expect.stringContaining("attachment_omitted"),
  );
});

test("omits media the target model cannot read without a rejection", () => {
  const filter = createModelMediaFilter();
  const view = filter.apply(messages, textOnly);
  expect(view[0]).toHaveProperty(
    "content.1.text",
    '[attachment_omitted mime="image/png" code="unsupported_provider"] The current model cannot read this file type, so it is left out. To use the file, convert it or extract its contents with a tool, using resource.materialize with the uri from the attachment marker above when there is one.',
  );
  expect(view[2]).toHaveProperty(
    "content.0.output.value.1.text",
    expect.stringContaining('code="unsupported_provider"'),
  );
  expect(filter.apply(messages, vision)).toEqual(messages);
  expect(filter.apply(messages, claudeCode)).toEqual(messages);
});

test("treats image parts without an image MIME type as images", () => {
  const filter = createModelMediaFilter();
  const untyped: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", image: "iVBORw0KGgo=" },
        {
          type: "file",
          mediaType: "image",
          data: { type: "url", url: new URL("https://example.com/cat.png") },
        },
      ],
    },
  ];
  expect(filter.apply(untyped, textOnly)[0]).toHaveProperty("content", [
    { type: "text", text: expect.stringContaining('code="unsupported_provider"') },
    { type: "text", text: expect.stringContaining('mime="image" code="unsupported_provider"') },
  ]);
  expect(filter.apply(untyped, vision)).toEqual(untyped);
});

test("leaves auth, transient, and context-overflow errors to other handlers", () => {
  const filter = createModelMediaFilter();
  expect(filter.recordRejection({ error, details: undefined, messages })).toBe(false);
  expect(
    filter.recordRejection({ error, details: { ...details, statusCode: 401 }, messages }),
  ).toBe(false);
  expect(
    filter.recordRejection({ error: { ...error, isRetryable: true }, details, messages }),
  ).toBe(false);
  expect(
    filter.recordRejection({
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
  ).toBe(false);
  expect(filter.apply(messages, vision)).toEqual(messages);
});

test("reports the status code when the provider gives no error message", () => {
  const filter = createModelMediaFilter();
  expect(
    filter.recordRejection({
      error,
      details: { ...details, statusCode: 415, providerMessage: "", aiErrorMessage: "" },
      messages,
    }),
  ).toBe(true);
  expect(filter.apply(messages, vision)[2]).toHaveProperty(
    "content.0.output.value.1.text",
    expect.stringContaining("Provider error: HTTP 415 with no error message."),
  );
});
