import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { Panic } from "better-result";
import type { AgentPreparedContext } from "../../agent-adapter";
import { openAIRequestCodec } from "./input";

const context: AgentPreparedContext = {
  scopeId: "scope",
  step: 0,
  canonicalMessages: [],
  messages: [{ role: "user", content: "hello" }],
  system: "Be precise",
  tools: [],
};

describe("OpenAI Responses input", () => {
  test("maps request options and function schemas without stream transport fields", async () => {
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: {
        ...context,
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchemaJson: '{"type":"object","properties":{"path":{"type":"string"}}}',
            strict: false,
          },
        ],
      },
      providerOptions: {
        openai: {
          store: false,
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          reasoningMode: "standard",
          reasoningContext: "ctx",
          textVerbosity: "low",
          serviceTier: "priority",
          parallelToolCalls: true,
          promptCacheKey: "cache",
          maxToolCalls: 4,
          metadata: { a: "b" },
          include: ["message.output_text.logprobs"],
          logprobs: 5,
          allowedTools: { toolNames: ["read"], mode: "required" },
        },
      },
    });
    const request = result.unwrap();
    expect(request).toMatchObject({
      type: "response.create",
      model: "gpt-6-astra",
      store: false,
      service_tier: "priority",
      max_tool_calls: 4,
      reasoning: { effort: "high", summary: "detailed", mode: "standard", context: "ctx" },
      text: { verbosity: "low" },
      top_logprobs: 5,
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "read" }],
      },
      tools: [
        {
          type: "function",
          name: "read",
          strict: false,
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    expect(request.include).toEqual([
      "message.output_text.logprobs",
      "reasoning.encrypted_content",
    ]);
    expect(request.input).toEqual([
      { role: "developer", content: "Be precise" },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    expect(request.stream).toBeUndefined();
  });

  test("encodes materialized binary, URL, base64 and provider file resources", async () => {
    const result = await openAIRequestCodec.messages([
      {
        role: "user",
        content: [
          {
            type: "image",
            image: new Uint8Array([1, 2]),
            mediaType: "image/png",
            providerOptions: { openai: { imageDetail: "high" } },
          },
          {
            type: "file",
            data: { type: "url", url: new URL("https://example.com/file.pdf") },
            mediaType: "application/pdf",
          },
          {
            type: "file",
            data: { type: "data", data: "AQI=" },
            mediaType: "application/pdf",
            filename: "notes.pdf",
          },
          {
            type: "file",
            data: { type: "reference", reference: { openai: "file-image" } },
            mediaType: "image/png",
          },
          { type: "image", image: new URL("https://example.com/a.png") },
        ],
      },
    ]);
    expect(result.unwrap()[0]?.content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,AQI=", detail: "high" },
      { type: "input_file", file_url: "https://example.com/file.pdf" },
      { type: "input_file", filename: "notes.pdf", file_data: "data:application/pdf;base64,AQI=" },
      { type: "input_image", file_id: "file-image", detail: undefined },
      { type: "input_image", image_url: "https://example.com/a.png", detail: undefined },
    ]);
  });

  test("keeps assistant phases and groups encrypted reasoning with matching ids", async () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "first",
            providerOptions: { openai: { itemId: "rs_1" } },
          },
          {
            type: "reasoning",
            text: "second",
            providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "final" } },
          },
          {
            type: "text",
            text: "working",
            providerOptions: { openai: { itemId: "msg_1", phase: "commentary" } },
          },
          { type: "reasoning", text: "foreign provider reasoning" },
          { type: "text", text: "done", providerOptions: { openai: { phase: "final_answer" } } },
        ],
      },
    ];
    expect((await openAIRequestCodec.messages(messages)).unwrap()).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "final",
        summary: [
          { type: "summary_text", text: "first" },
          { type: "summary_text", text: "second" },
        ],
      },
      {
        role: "assistant",
        id: "msg_1",
        phase: "commentary",
        content: [{ type: "output_text", text: "working" }],
      },
      {
        role: "assistant",
        id: undefined,
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      },
    ]);
  });

  test("stored history uses references but preserves function call and output pairing", async () => {
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: {
        ...context,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking", providerOptions: { openai: { itemId: "msg_1" } } },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "read",
                input: { path: "x" },
                providerOptions: { openai: { itemId: "fc_1" } },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "read",
                output: { type: "json", value: { found: true } },
              },
            ],
          },
        ],
      },
    });
    expect(result.unwrap().input.slice(1)).toEqual([
      { type: "item_reference", id: "msg_1" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"x"}',
      },
      { type: "function_call_output", call_id: "call_1", output: '{"found":true}' },
    ]);
  });

  test("encodes tool content resources and denied execution", async () => {
    const result = await openAIRequestCodec.messages([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "found" },
                {
                  type: "file",
                  data: { type: "data", data: new Uint8Array([1]) },
                  mediaType: "image/png",
                },
                { type: "file-id", fileId: { openai: "file-2" } },
              ],
            },
          },
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "write",
            output: { type: "execution-denied", reason: "User declined" },
          },
        ],
      },
    ]);
    expect(result.unwrap()).toMatchObject([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "found" },
          { type: "input_image", image_url: "data:image/png;base64,AQ==" },
          { type: "input_file", file_id: "file-2" },
        ],
      },
      { type: "function_call_output", call_id: "call_2", output: "User declined" },
    ]);
  });

  test("steering contains only user inputs and rejects unsupported roles", async () => {
    expect((await openAIRequestCodec.steer([{ role: "system", content: "wrong" }])).isErr()).toBe(
      true,
    );
    expect((await openAIRequestCodec.steer([])).isErr()).toBe(true);
    expect(
      (await openAIRequestCodec.steer([{ role: "user", content: "change" }])).unwrap(),
    ).toEqual([{ role: "user", content: [{ type: "input_text", text: "change" }] }]);
  });

  test("preserves explicit compaction payload and trigger", async () => {
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: {
        ...context,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "custom",
                kind: "openai.compaction",
                providerOptions: { openai: { itemId: "cmp_1", encryptedContent: "encrypted" } },
              },
            ],
          },
        ],
      },
      providerOptions: {
        openai: {
          store: false,
          compactionTrigger: true,
          contextManagement: [{ type: "compaction", compactThreshold: 20000 }],
          systemMessageMode: "developer",
        },
      },
    });
    expect(result.unwrap().input).toEqual([
      { role: "developer", content: "Be precise" },
      { type: "compaction", id: "cmp_1", encrypted_content: "encrypted" },
      { type: "compaction_trigger" },
    ]);
    expect(result.unwrap().context_management).toEqual([
      { type: "compaction", compact_threshold: 20000 },
    ]);
  });

  test("rejects missing provider references, invalid JSON schemas and unknown options", async () => {
    expect(
      (
        await openAIRequestCodec.messages([
          {
            role: "user",
            content: [
              {
                type: "file",
                data: { type: "reference", reference: { anthropic: "file-x" } },
                mediaType: "application/pdf",
              },
            ],
          },
        ])
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await openAIRequestCodec.request({
          model: "gpt-6-astra",
          context: { ...context, tools: [{ name: "x", description: "", inputSchemaJson: "{" }] },
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await openAIRequestCodec.request({
          model: "gpt-6-astra",
          context,
          providerOptions: { openai: { mysteryOption: true } },
        })
      ).isErr(),
    ).toBe(true);
  });

  test("detects image media types when callers supply generic image data", async () => {
    const result = await openAIRequestCodec.messages([
      {
        role: "user",
        content: [
          { type: "image", image: "/9j/AA==" },
          { type: "file", mediaType: "image", data: { type: "data", data: "iVBORw0KGgo=" } },
        ],
      },
    ]);
    expect(result.unwrap()[0]?.content).toEqual([
      { type: "input_image", image_url: "data:image/jpeg;base64,/9j/AA==", detail: undefined },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: undefined },
    ]);
  });

  test("honors explicit unsupported-file passthrough and default reasoning summary", async () => {
    const fileContext: AgentPreparedContext = {
      ...context,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: { type: "data", data: "AQ==" }, mediaType: "text/plain" },
          ],
        },
      ],
    };
    expect(
      (await openAIRequestCodec.request({ model: "gpt-6-astra", context: fileContext })).isErr(),
    ).toBe(true);
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: fileContext,
      reasoning: "high",
      providerOptions: { openai: { passThroughUnsupportedFiles: true } },
    });
    expect(result.unwrap().reasoning).toMatchObject({ effort: "high", summary: "detailed" });
    expect(result.unwrap().input[1]?.content).toEqual([
      { type: "input_file", filename: "file", file_data: "data:text/plain;base64,AQ==" },
    ]);
  });

  test("matches installed model-family system role defaults and explicit overrides", async () => {
    for (const [model, expectedRole] of [
      ["gpt-6-astra", "developer"],
      ["o3-mini", "developer"],
      ["o1", "developer"],
      ["gpt-5-chat-latest", "system"],
      ["gpt-5.1-chat-latest", "developer"],
      ["gpt-4.1", "system"],
      ["ft:gpt-6-astra:custom", "system"],
      ["custom", "system"],
    ]) {
      const result = await openAIRequestCodec.request({ model: model!, context });
      expect(result.unwrap().input[0]?.role).toBe(expectedRole);
    }
    expect(
      (
        await openAIRequestCodec.request({
          model: "custom",
          context,
          providerOptions: { openai: { forceReasoning: true } },
        })
      ).unwrap().input[0]?.role,
    ).toBe("developer");
    expect(
      (
        await openAIRequestCodec.request({
          model: "gpt-6-astra",
          context,
          providerOptions: { openai: { forceReasoning: false } },
        })
      ).unwrap().input[0]?.role,
    ).toBe("developer");
    expect(
      (
        await openAIRequestCodec.request({
          model: "gpt-6-astra",
          context,
          providerOptions: { openai: { systemMessageMode: "system" } },
        })
      ).unwrap().input[0]?.role,
    ).toBe("system");
    expect(
      (
        await openAIRequestCodec.request({
          model: "gpt-6-astra",
          context,
          providerOptions: { openai: { systemMessageMode: "remove" } },
        })
      ).unwrap().input[0]?.role,
    ).toBe("user");
  });

  test("output schemas encode text results as JSON string literals in history and continuations", async () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_text",
            toolName: "typed",
            output: { type: "text", value: 'hello "world"' },
          },
          {
            type: "tool-result",
            toolCallId: "call_error",
            toolName: "typed",
            output: { type: "error-text", value: "failed" },
          },
          {
            type: "tool-result",
            toolCallId: "call_denied",
            toolName: "typed",
            output: { type: "execution-denied" },
          },
          {
            type: "tool-result",
            toolCallId: "call_raw",
            toolName: "plain",
            output: { type: "text", value: "plain text" },
          },
          {
            type: "tool-result",
            toolCallId: "call_json",
            toolName: "typed",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ];
    const expected = [
      JSON.stringify('hello "world"'),
      JSON.stringify("failed"),
      JSON.stringify("Tool call execution denied."),
      "plain text",
      '{"ok":true}',
    ];
    const continuation = (
      await openAIRequestCodec.messages(messages, { outputSchemaToolNames: ["typed"] })
    ).unwrap();
    expect(continuation.map((item) => item.output)).toEqual(expected);
    const request = (
      await openAIRequestCodec.request({
        model: "gpt-6-astra",
        context: {
          ...context,
          messages,
          tools: [
            {
              name: "typed",
              description: "",
              inputSchemaJson: "{}",
              outputSchemaJson: '{"type":"string"}',
            },
          ],
        },
      })
    ).unwrap();
    expect(request.input.slice(1).map((item) => item.output)).toEqual(expected);
    const assistantResult: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_inline",
          toolName: "typed",
          output: { type: "text", value: "inline" },
        },
      ],
    };
    expect(
      (
        await openAIRequestCodec.messages([assistantResult], { outputSchemaToolNames: ["typed"] })
      ).unwrap()[0]?.output,
    ).toBe('"inline"');
  });

  test("preserves Panic identity at the JSON boundary", async () => {
    const panic = new Panic({ message: "defect" });
    const input = {
      toJSON() {
        throw panic;
      },
    };
    await expect(
      openAIRequestCodec.messages([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "x", input }],
        },
      ]),
    ).rejects.toBe(panic);
  });
  test("preserves prompt cache breakpoints on every user resource form", async () => {
    const options = { openai: { promptCacheBreakpoint: true } };
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: new URL("https://example.test/image.png"),
            providerOptions: options,
          },
          { type: "image", image: "file-image", providerOptions: options },
          {
            type: "image",
            image: new Uint8Array([1]),
            mediaType: "image/png",
            providerOptions: options,
          },
          {
            type: "file",
            data: new Uint8Array([2]),
            mediaType: "application/pdf",
            providerOptions: options,
          },
          {
            type: "file",
            data: new URL("https://example.test/doc.pdf"),
            mediaType: "application/pdf",
            providerOptions: options,
          },
          {
            type: "file",
            data: { openai: "file-document" },
            mediaType: "application/pdf",
            providerOptions: options,
          },
        ],
      },
    ];
    const input = (await openAIRequestCodec.messages(messages)).unwrap();
    expect(input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input_image", prompt_cache_breakpoint: true }),
        expect.objectContaining({ type: "input_file", prompt_cache_breakpoint: true }),
      ]),
    );
    const encoded = JSON.stringify(input);
    expect(encoded.match(/prompt_cache_breakpoint/g)).toHaveLength(6);
  });
  test("conversation requests omit stored assistant items but retain pending function outputs", async () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "stored text", providerOptions: { openai: { itemId: "msg" } } },
          {
            type: "reasoning",
            text: "stored reasoning",
            providerOptions: { openai: { itemId: "rs", reasoningEncryptedContent: "encrypted" } },
          },
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "lookup",
            input: {},
            providerOptions: { openai: { itemId: "fc" } },
          },
          {
            type: "custom",
            kind: "openai.compaction",
            providerOptions: { openai: { itemId: "cmp", encryptedContent: "compact" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "lookup",
            output: { type: "text", value: "new result" },
          },
        ],
      },
      { role: "user", content: "next instruction" },
    ];
    const request = (
      await openAIRequestCodec.request({
        model: "gpt-6-astra",
        context: { ...context, system: "", messages },
        providerOptions: { openai: { conversation: "conversation" } },
      })
    ).unwrap();
    expect(request.input).toEqual([
      { type: "function_call_output", call_id: "call", output: "new result" },
      { role: "user", content: [{ type: "input_text", text: "next instruction" }] },
    ]);
    const previous = (
      await openAIRequestCodec.request({
        model: "gpt-6-astra",
        context: { ...context, system: "", messages },
        providerOptions: { openai: { previousResponseId: "response" } },
      })
    ).unwrap();
    expect(previous.input.some((item) => item.id === "rs")).toBe(false);
    expect(
      previous.input.some((item) => item.type === "function_call" && item.call_id === "call"),
    ).toBe(true);
  });
});
