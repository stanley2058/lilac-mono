import { expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { jsonSchema, streamText, tool, type ModelMessage } from "ai";
import { prepareAnthropicToolSearch } from "../../agent/adapters/ai-sdk/tool-search";

test("Anthropic SDK encodes deferred definitions and client tool references on the wire", async () => {
  const requests: Record<string, unknown>[] = [];
  const model = createAnthropic({
    apiKey: "test",
    fetch: Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{
            content: string | Array<{ type: string; content?: string | Array<{ type: string }> }>;
          }>;
        };
        requests.push(request);
        const mixedReferences = request.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === "tool_result" &&
                Array.isArray(part.content) &&
                part.content.some((item) => item.type === "tool_reference") &&
                part.content.some((item) => item.type !== "tool_reference"),
            ),
        );
        if (mixedReferences)
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "Tool definitions/code execution functions cannot be mixed with other content",
              },
            },
            { status: 400 },
          );
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect() {} },
    ),
  })("claude-opus-5-5");
  const definition = tool({
    description: "lookup",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
  });
  const initial: ModelMessage[] = [{ role: "user", content: "search" }];
  const messages: ModelMessage[] = [
    ...initial,
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "search",
          providerOptions: { anthropic: { signature: "signed" } },
        },
        { type: "tool-call", toolCallId: "search", toolName: "find_tools", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "search",
          toolName: "find_tools",
          output: { type: "json", value: { matches: [{ name: "lookup" }] } },
        },
      ],
    },
  ];
  for (const [index, history] of [initial, messages].entries()) {
    const projected = prepareAnthropicToolSearch({
      model,
      tools: index ? { find_tools: definition, lookup: definition } : { find_tools: definition },
      deferredTools: { lookup: definition },
      messages: history,
    });
    const result = streamText({ model, ...projected, maxRetries: 0 });
    expect(await result.text).toBe("done");
  }
  expect(requests[1]?.tools).toEqual(requests[0]?.tools);
  expect(requests[0]?.tools).toMatchObject([
    { name: "find_tools" },
    { name: "lookup", defer_loading: true },
  ]);
  expect(requests[1]?.messages).toMatchObject([
    { role: "user" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "search", signature: "signed" },
        { type: "tool_use" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [{ type: "tool_reference", tool_name: "lookup" }],
        },
      ],
    },
  ]);
});
