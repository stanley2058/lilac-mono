import { truncateToLastValidBoundary } from "@stanley2058/lilac-agent/agent-runtime-support";
import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelMessage } from "ai";
import {
  createClaudeCode,
  claudeRuntime,
  type ClaudeCodeQueryController,
  createClaudeInput,
  type ClaudeQueryFactory,
} from "@stanley2058/lilac-utils/claude-sdk";
import { Panic } from "better-result";
import { executeClaudeSdkCall } from "../claude-sdk-call";
import type { AiSdkModelCallInput } from "@stanley2058/lilac-agent/adapters/ai-sdk/model-call";

function frame(value: object): SDKMessage {
  return value as SDKMessage;
}
const result = () =>
  frame({
    type: "result",
    subtype: "success",
    session_id: "session",
    result: "Done",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  });
function fixture(frames: SDKMessage[]) {
  let options: Parameters<ClaudeQueryFactory>[0]["options"];
  let initial: ModelMessage | undefined;
  let closed = 0;
  let interruptions = 0;
  const queryFactory: ClaudeQueryFactory = (request) => {
    options = request.options;
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof request.prompt !== "string") {
          const entry = await request.prompt[Symbol.asyncIterator]().next();
          initial = entry.value?.message;
        }
        yield* frames;
      },
      close() {
        closed += 1;
      },
      async return() {
        return { done: true, value: undefined };
      },
      async interrupt() {
        interruptions += 1;
        return undefined;
      },
      async getContextUsage() {
        return { totalTokens: 30, maxTokens: 200000 } as Awaited<
          ReturnType<ReturnType<ClaudeQueryFactory>["getContextUsage"]>
        >;
      },
    };
  };
  const model = createClaudeCode()("opus", {
    queryFactory,
    tools: ["ToolSearch"],
    settingSources: [],
  });
  const events: unknown[] = [];
  const drafts: ModelMessage[] = [];
  const input: AiSdkModelCallInput = {
    model,
    system: "You are Lilac. Use the supplied question and delegation tools.",
    messages: [{ role: "user", content: "Do the work" }],
    reasoning: "high",
    host: {
      emit: (event) => events.push(event),
      checkpointDraft: (message) => drafts.push(structuredClone(message)),
      setStreamMessage() {},
      normalizeNewToolMessage: async (message) => message,
      normalizeNewAssistantMessage: async (message) => message,
      clearNormalizedToolCallIds() {},
      markProviderTool() {},
      markLocalToolDraft() {},
      onErrorPhase() {},
      getAbortReason: () => "cancel",
      abortModel: () => {
        throw new Error("cancelled");
      },
      failModel: (error) => {
        throw error;
      },
    },
  };
  return {
    input,
    events,
    drafts,
    options: () => options,
    initial: () => initial,
    closed: () => closed,
    interruptions: () => interruptions,
  };
}

describe("direct Claude SDK execution", () => {
  test.each([true, false])(
    "gates Claude skip permission on the full assistant batch, sibling=%s",
    async (sibling) => {
      const f = fixture([]);
      const settings = claudeRuntime(f.input.model)!.settings;
      const factory = settings.queryFactory!;
      let decision: string | undefined;
      f.input.model = createClaudeCode()("opus", {
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        queryFactory: (request) => ({
          ...factory(request),
          async *[Symbol.asyncIterator]() {
            const stream = (event: object) => frame({ type: "stream_event", event });
            yield stream({ type: "message_start" });
            yield stream({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", name: "mcp__lilac__skip_reply", id: "skip" },
            });
            const permission = request.options!.canUseTool!(
              "mcp__lilac__skip_reply",
              {},
              { toolUseID: "skip", requestId: "permission", signal: AbortSignal.timeout(2000) },
            );
            if (sibling)
              yield stream({
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", name: "mcp__lilac__read", id: "read" },
              });
            yield stream({ type: "message_stop" });
            decision = (await permission)?.behavior;
            yield result();
          },
        }),
      });
      await executeClaudeSdkCall(f.input);
      expect(decision).toBe(sibling ? "deny" : "allow");
    },
  );

  test("preserves a cleanup Panic over an ordinary utility query failure", async () => {
    const panic = new Panic({ message: "cleanup invariant" });
    const model = createClaudeCode()("opus", {
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("query failed");
        },
        close() {
          throw panic;
        },
        async return() {
          return { done: true, value: undefined };
        },
        async interrupt() {},
        async getContextUsage() {
          throw new Error("unused");
        },
      }),
    });
    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(panic);
  });

  test("preserves a delivery Panic when closing the query also fails", async () => {
    const f = fixture([]);
    const panic = new Panic({ message: "delivery invariant" });
    f.input.model = createClaudeCode()("opus", {
      onStreamStart(injector) {
        injector.inject("unsent", () => {
          throw panic;
        });
      },
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield result();
        },
        close() {
          throw new Error("close failed");
        },
        async return() {
          return { done: true, value: undefined };
        },
        async interrupt() {},
        async getContextUsage() {
          throw new Error("unused");
        },
      }),
    });
    await expect(executeClaudeSdkCall(f.input)).rejects.toBe(panic);
  });

  test("groups SDK assistant blocks around interleaved parallel tool results into valid history", async () => {
    const f = fixture([
      frame({
        type: "assistant",
        message: { id: "response-1", content: [{ type: "text", text: "Working" }] },
      }),
      frame({
        type: "assistant",
        message: {
          id: "response-1",
          content: [{ type: "tool_use", id: "a", name: "mcp__lilac__read", input: { path: "a" } }],
        },
      }),
      frame({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "a", content: "A" }] },
      }),
      frame({
        type: "assistant",
        message: {
          id: "response-1",
          content: [{ type: "tool_use", id: "b", name: "mcp__lilac__read", input: { path: "b" } }],
        },
      }),
      frame({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "b", content: "B" }] },
      }),
      frame({
        type: "assistant",
        message: { id: "response-2", content: [{ type: "text", text: "Done" }] },
      }),
      result(),
    ]);
    const output = await executeClaudeSdkCall(f.input);
    expect(output.newMessages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(output.newMessages[0]).toMatchObject({
      content: [{ type: "text" }, { toolCallId: "a" }, { toolCallId: "b" }],
    });
    expect(truncateToLastValidBoundary(output.newMessages).droppedMessageCount).toBe(0);
  });

  test("forwards claude-code provider options without overriding Lilac settings", async () => {
    const f = fixture([result()]);
    await executeClaudeSdkCall({
      ...f.input,
      providerOptions: {
        "claude-code": {
          taskBudget: { total: 50_000 },
          settings: { fastMode: true, includeGitInstructions: true },
          permissionMode: "bypassPermissions",
        },
      },
    });
    expect(f.options()?.taskBudget).toEqual({ total: 50_000 });
    expect(f.options()?.settings).toMatchObject({ fastMode: true, includeGitInstructions: false });
    expect(f.options()?.permissionMode).toBeUndefined();
  });

  test("uses the preset plus Lilac instructions and preserves streamed text, reasoning, tools and usage", async () => {
    const f = fixture([
      frame({
        type: "stream_event",
        uuid: "chunk",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      }),
      frame({
        type: "stream_event",
        uuid: "chunk",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Working" },
        },
      }),
      frame({
        type: "stream_event",
        uuid: "chunk",
        event: { type: "content_block_stop", index: 0 },
      }),
      frame({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Working" },
            { type: "thinking", thinking: "Inspect the files" },
            { type: "tool_use", id: "tool-a", name: "mcp__lilac__read", input: { path: "a" } },
            { type: "tool_use", id: "tool-b", name: "mcp__lilac__read", input: { path: "b" } },
          ],
        },
      }),
      frame({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-b", content: "B" },
            { type: "tool_result", tool_use_id: "tool-a", content: "A" },
          ],
        },
      }),
      frame({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } }),
      result(),
    ]);
    const output = await executeClaudeSdkCall(f.input);
    expect(f.options()?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
      append: "You are Lilac. Use the supplied question and delegation tools.",
    });
    expect(f.options()?.settingSources).toEqual([]);
    expect(f.options()?.tools).toEqual(["ToolSearch"]);
    expect(f.options()?.effort).toBe("high");
    expect(f.options()?.settings).toMatchObject({
      autoMemoryEnabled: false,
      includeGitInstructions: false,
    });
    expect(output.newMessages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(output.newMessages[1]).toMatchObject({
      content: [{ toolCallId: "tool-b", toolName: "read", output: { value: "B" } }],
    });
    expect(output.newMessages[2]).toMatchObject({
      content: [{ toolCallId: "tool-a", toolName: "read", output: { value: "A" } }],
    });
    expect(output.toolCalls).toEqual([]);
    expect(output.usage).toMatchObject({ inputTokens: 33, outputTokens: 5, totalTokens: 38 });
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "message_update",
        assistantMessageEvent: expect.objectContaining({ type: "text_delta", delta: "Working" }),
      }),
    );
    expect(f.closed()).toBe(1);
  });

  test("replays historical screenshots as image blocks without JSON-encoding their bytes into text", async () => {
    const f = fixture([result()]);
    const data = "YWJj".repeat(10000);
    f.input.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "screen",
            toolName: "computer",
            input: {},
            providerExecuted: true,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "screen",
            toolName: "computer",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Captured screen" },
                { type: "image-data", data, mediaType: "image/png" },
              ],
            },
          },
        ],
      },
      { role: "user", content: "What changed?" },
    ];
    await executeClaudeSdkCall(f.input);
    const content = f.initial()?.content;
    expect(content).toEqual(
      expect.arrayContaining([
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
      ]),
    );
    const texts = Array.isArray(content)
      ? content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      : "";
    expect(texts).toContain("Captured screen");
    expect(texts).not.toContain(data);
    expect(texts.length).toBeLessThan(1000);
  });

  test("restores screenshot blocks from previously persisted SDK JSON text on rewind", async () => {
    const f = fixture([result()]);
    const data = "YWJj".repeat(10000);
    const serialized = JSON.stringify([
      { type: "text", text: "screen result" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ]);
    const original: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old-screen",
            toolName: "computer",
            output: { type: "text", value: serialized },
          },
        ],
      },
      { role: "user", content: "Try again" },
    ];
    f.input.messages = structuredClone(original);
    await executeClaudeSdkCall(f.input);
    const content = f.initial()?.content;
    expect(content).toEqual(
      expect.arrayContaining([
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
      ]),
    );
    const text = Array.isArray(content)
      ? content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      : "";
    expect(text).toContain("screen result");
    expect(text).not.toContain(data);
    expect(f.input.messages).toEqual(original);
  });

  test("stores new SDK screenshot results as structured content", async () => {
    const data = "YWJj";
    const f = fixture([
      frame({
        type: "assistant",
        message: {
          id: "screen-response",
          content: [{ type: "tool_use", id: "screen", name: "mcp__lilac__computer", input: {} }],
        },
      }),
      frame({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "screen",
              content: [
                { type: "text", text: "screen result" },
                { type: "image", source: { type: "base64", media_type: "image/png", data } },
              ],
            },
          ],
        },
      }),
      result(),
    ]);
    const output = await executeClaudeSdkCall(f.input);
    expect(output.newMessages[1]).toMatchObject({
      content: [
        {
          output: {
            type: "content",
            value: [
              { type: "text", text: "screen result" },
              { type: "image-data", data, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
  });

  test("passes current image attachments without flattening them into historical text", async () => {
    const f = fixture([result()]);
    f.input.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
    ];
    await executeClaudeSdkCall(f.input);
    expect(f.initial()).toMatchObject({
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      ],
    });
  });

  test("rejects a missing terminal result and still closes the native query", async () => {
    const f = fixture([]);
    await expect(executeClaudeSdkCall(f.input)).rejects.toThrow("ended without a result");
    expect(f.closed()).toBe(1);
  });

  test("cleans up when query setup fails after construction", async () => {
    const f = fixture([result()]);
    const failure = new Error("controller setup failed");
    let closed = 0;
    f.input.model = createClaudeCode()("opus", {
      queryFactory: () => ({
        async *[Symbol.asyncIterator]() {
          yield result();
        },
        close() {
          closed += 1;
        },
        async return() {
          return { done: true, value: undefined };
        },
        async interrupt() {},
        async getContextUsage() {
          throw new Error("unused");
        },
      }),
      onQueryControllerCreated() {
        throw failure;
      },
    });
    await expect(executeClaudeSdkCall(f.input)).rejects.toBe(failure);
    expect(closed).toBe(1);
  });

  test("does not interrupt a query after its result closed the transport", async () => {
    const f = fixture([result()]);
    let controller: ClaudeCodeQueryController | undefined;
    claudeRuntime(f.input.model)!.settings.onQueryControllerCreated = (value) => {
      controller = value;
    };
    await executeClaudeSdkCall(f.input);
    expect(controller).toBeDefined();
    await controller!.interrupt();
    expect(f.interruptions()).toBe(0);
  });

  test("honors cancellation and closes the query", async () => {
    const f = fixture([result()]);
    const controller = new AbortController();
    controller.abort();
    f.input.abortSignal = controller.signal;
    await expect(executeClaudeSdkCall(f.input)).rejects.toThrow("cancelled");
    expect(f.options()?.abortController?.signal.aborted).toBe(true);
    expect(f.closed()).toBe(1);
  });

  test("consumes a queued steering turn after the first SDK result", async () => {
    const f = fixture([]);
    const delivered: boolean[] = [];
    let injector: ReturnType<typeof createClaudeInput>["injector"];
    f.input.model = createClaudeCode()("opus", {
      onStreamStart(value) {
        injector = value;
      },
      queryFactory: (request) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof request.prompt === "string") throw new Error("Expected streaming input");
          const iterator = request.prompt[Symbol.asyncIterator]();
          await iterator.next();
          injector.inject("late steering", (ok) => delivered.push(ok));
          const next = await iterator.next();
          yield result();
          yield frame({ ...next.value, isReplay: true });
          yield frame({
            type: "assistant",
            message: { id: "steered", content: [{ type: "text", text: "Steered answer" }] },
          });
          yield result();
        },
        close() {},
        async return() {
          return { done: true, value: undefined };
        },
        async interrupt() {},
        async getContextUsage() {
          throw new Error("unused");
        },
      }),
    });
    const output = await executeClaudeSdkCall(f.input);
    expect(delivered).toEqual([true]);
    expect(output.newMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Steered answer" }] },
    ]);
  });

  test("acknowledges injected inputs only when the runtime echoes their identity", async () => {
    const queue = createClaudeInput({
      type: "user",
      message: { role: "user", content: "start" },
      parent_tool_use_id: null,
    });
    const delivered: Array<[string, boolean]> = [];
    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next();
    queue.injector.inject("one", (ok) => delivered.push(["one", ok]));
    queue.injector.inject("two", (ok) => delivered.push(["two", ok]));
    const first = await iterator.next();
    await iterator.next();
    expect(delivered).toEqual([]);
    queue.acknowledge(first.value!.uuid!);
    expect(delivered).toEqual([["one", true]]);
    expect(queue.hasPending()).toBe(true);
    queue.injector.inject("unsent", (ok) => delivered.push(["unsent", ok]));
    queue.finish();
    expect(delivered).toEqual([
      ["one", true],
      ["unsent", false],
    ]);
  });
});
