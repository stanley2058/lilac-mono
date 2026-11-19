import { describe, expect, it } from "bun:test";
import { streamText } from "ai";

import type { CodexOAuthTokens } from "../codex-oauth";
import {
  CodexRequestInvalid,
  createCodexOAuthProvider,
  createCodexResponsesEventNormalizer,
  getModelProviders,
  normalizeCodexResponsesRequestRecord,
  normalizeCodexResponsesRequestRecordResult,
  refreshCodexOAuthTokens,
  shouldRefreshCodexOAuthTokens,
} from "../model-provider";

describe("claude-code provider", () => {
  it("is available without API credentials and uses isolated utility defaults", () => {
    const provider = getModelProviders()["claude-code"];
    const model = provider("sonnet");

    expect(model.provider).toBe("claude-code");
    expect(model.modelId).toBe("sonnet");
  });
});

describe("cerebras provider", () => {
  it("resolves native Cerebras models", () => {
    const provider = getModelProviders().cerebras;
    const model = provider("gpt-oss-120b");

    expect(model.provider).toBe("cerebras.chat");
    expect(model.modelId).toBe("gpt-oss-120b");
  });
});

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("normalizeCodexResponsesRequestRecord", () => {
  it("sets store to false and leaves instructions absent for Codex responses", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      input: [{ type: "message", role: "user", id: "msg_123", content: [] }],
    });

    expect(normalized.store).toBe(false);
    expect(normalized).not.toHaveProperty("instructions");
    expect(normalized.include).toEqual(["reasoning.encrypted_content"]);
    expect(normalized.parallel_tool_calls).toBe(true);
    expect((normalized.input as Array<Record<string, unknown>>)[0]?.id).toBeUndefined();
  });

  it("strips top-level instructions from older Codex requests", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      instructions: "Legacy instruction",
      store: false,
      input: [],
    });

    expect(normalized).not.toHaveProperty("instructions");
    expect(normalized.store).toBe(false);
  });

  it("defaults function tools to non-strict without overriding explicit strictness", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      tools: [
        { type: "function", name: "implicit", parameters: { type: "object" } },
        { type: "function", name: "strict", strict: true, parameters: { type: "object" } },
        { type: "function", name: "non-strict", strict: false, parameters: { type: "object" } },
        { type: "web_search_preview" },
        { type: "web_search", external_web_access: true },
      ],
    });

    expect(normalized.tools).toEqual([
      { type: "function", name: "implicit", strict: false, parameters: { type: "object" } },
      { type: "function", name: "strict", strict: true, parameters: { type: "object" } },
      { type: "function", name: "non-strict", strict: false, parameters: { type: "object" } },
      { type: "web_search_preview" },
      { type: "web_search", external_web_access: true },
    ]);
  });

  it("removes previous_response_id and every stateless input item id", () => {
    const input = [
      { type: "computer_call", id: "call_123" },
      { type: "tool_search_call", id: "search_123" },
      { type: "compaction", id: "cmp_123", encrypted_content: "encrypted" },
      { type: "message", id: "msg_123" },
    ];
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      previous_response_id: "resp_123",
      input,
    });

    expect(normalized.previous_response_id).toBeUndefined();
    expect(normalized.input).toEqual([
      { type: "computer_call" },
      { type: "tool_search_call" },
      { type: "compaction", encrypted_content: "encrypted" },
      { type: "message" },
    ]);
    expect(input).toEqual([
      { type: "computer_call", id: "call_123" },
      { type: "tool_search_call", id: "search_123" },
      { type: "compaction", id: "cmp_123", encrypted_content: "encrypted" },
      { type: "message", id: "msg_123" },
    ]);
  });

  it("rejects item references in stateless requests", () => {
    expect(() =>
      normalizeCodexResponsesRequestRecord({
        stream: true,
        store: false,
        previous_response_id: "resp_123",
        input: [{ type: "item_reference", id: "msg_123" }],
      }),
    ).toThrow("item_reference requires persisted response items");
  });

  it("keeps only the Codex Responses contract and strips unsupported OpenAI parameters", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      model: "gpt-5.6-sol",
      stream: true,
      input: [],
      max_output_tokens: 64,
      temperature: 0.5,
      top_p: 0.8,
      metadata: { source: "test" },
      max_tool_calls: 3,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
      parallel_tool_calls: false,
      text: { verbosity: "low" },
    });

    expect(normalized).toEqual({
      model: "gpt-5.6-sol",
      stream: true,
      input: [],
      reasoning: { effort: "medium", summary: "auto" },
      include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
      parallel_tool_calls: false,
      text: { verbosity: "low" },
      store: false,
    });
  });

  it("rejects non-streaming Codex requests before transport", () => {
    expect(() => normalizeCodexResponsesRequestRecord({ input: [] })).toThrow("requires streaming");
    expect(() => normalizeCodexResponsesRequestRecord({ stream: false, input: [] })).toThrow(
      "requires streaming",
    );

    const result = normalizeCodexResponsesRequestRecordResult({ input: [] });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(CodexRequestInvalid);
      expect(result.error.issue).toBe("streaming-required");
    }
  });

  it("keeps compaction triggers while stripping replay item IDs from the wire", () => {
    expect(
      normalizeCodexResponsesRequestRecord({
        stream: true,
        input: [
          { type: "compaction", id: "cmp_123", encrypted_content: "encrypted" },
          { type: "compaction_trigger" },
        ],
      }).input,
    ).toEqual([
      { type: "compaction", encrypted_content: "encrypted" },
      { type: "compaction_trigger" },
    ]);
  });
});

describe("createCodexResponsesEventNormalizer", () => {
  it("assigns a stable synthetic ID to no-ID compaction items", () => {
    const normalize = createCodexResponsesEventNormalizer();
    const event = {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "encrypted-state" },
    };

    const first = normalize(event);
    const second = normalize(event);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      output_index: 0,
      item: {
        type: "compaction",
        encrypted_content: "encrypted-state",
        id: expect.stringMatching(/^cmp_lilac_[a-f0-9]{32}$/),
      },
    });
  });

  it("recovers atomic completed reasoning summaries", () => {
    const normalize = createCodexResponsesEventNormalizer();

    expect(
      normalize({
        type: "response.reasoning_summary_text.done",
        item_id: "reasoning-1",
        summary_index: 0,
        text: "**Inspecting the stream**",
      }),
    ).toMatchObject({
      type: "response.reasoning_summary_text.delta",
      delta: "**Inspecting the stream**",
    });
  });

  it("does not duplicate text streamed before completion", () => {
    const normalize = createCodexResponsesEventNormalizer();
    normalize({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      summary_index: 0,
      delta: "**Inspecting",
    });

    expect(
      normalize({
        type: "response.reasoning_summary_part.done",
        item_id: "reasoning-1",
        summary_index: 0,
        part: { type: "summary_text", text: "**Inspecting the stream**" },
      }),
    ).toMatchObject({
      type: "response.reasoning_summary_text.delta",
      delta: " the stream**",
    });
  });

  it("turns duplicate done events into no-op deltas", () => {
    const normalize = createCodexResponsesEventNormalizer();
    normalize({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      summary_index: 0,
      delta: "**Inspecting the stream**",
    });
    normalize({
      type: "response.reasoning_summary_text.done",
      item_id: "reasoning-1",
      summary_index: 0,
      text: "**Inspecting the stream**",
    });

    expect(
      normalize({
        type: "response.reasoning_summary_part.done",
        item_id: "reasoning-1",
        summary_index: 0,
        part: { type: "summary_text", text: "**Inspecting the stream**" },
      }),
    ).toMatchObject({ type: "response.reasoning_summary_text.delta", delta: "" });
  });

  it("keeps request normalizers isolated", () => {
    const first = createCodexResponsesEventNormalizer();
    const second = createCodexResponsesEventNormalizer();
    first({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      summary_index: 0,
      delta: "**Inspecting",
    });
    second({ type: "response.completed" });

    expect(
      first({
        type: "response.reasoning_summary_text.done",
        item_id: "reasoning-1",
        summary_index: 0,
        text: "**Inspecting the stream**",
      }),
    ).toMatchObject({
      type: "response.reasoning_summary_text.delta",
      delta: " the stream**",
    });
  });

  it("keeps repeated part completion events idempotent", () => {
    const normalize = createCodexResponsesEventNormalizer();
    const event = {
      type: "response.reasoning_summary_part.done",
      item_id: "reasoning-1",
      summary_index: 0,
      part: { type: "summary_text", text: "**Inspecting the stream**" },
    };

    expect(normalize(event)).toMatchObject({ delta: "**Inspecting the stream**" });
    expect(normalize(event)).toMatchObject({ delta: "" });
  });
});

describe("refreshCodexOAuthTokens", () => {
  it("refreshes tokens within the thirty-second expiry skew", () => {
    const tokens: CodexOAuthTokens = {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 31_000,
    };

    expect(shouldRefreshCodexOAuthTokens(tokens, 1_000)).toBe(true);
    expect(shouldRefreshCodexOAuthTokens({ ...tokens, expires: 31_001 }, 1_000)).toBe(false);
  });

  it("persists a new access token while preserving omitted rotated tokens", async () => {
    const current: CodexOAuthTokens = {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 500,
      accountId: "old-account",
      idToken: "old-id-token",
    };
    const writes: CodexOAuthTokens[] = [];

    const refreshed = await refreshCodexOAuthTokens(current, {
      now: () => 1_000,
      fetch: async () =>
        Response.json({
          access_token: jwt({ chatgpt_account_id: "new-account" }),
          expires_in: 120,
        }),
      writeTokens: async (tokens) => {
        writes.push(tokens);
      },
    });

    expect(refreshed).toEqual({
      type: "oauth",
      access: expect.any(String),
      refresh: "old-refresh",
      expires: 121_000,
      accountId: "new-account",
      idToken: "old-id-token",
    });
    expect(writes).toEqual([refreshed]);
  });

  it("shares one provider refresh while one request aborts and the other completes", async () => {
    const originalFetch = globalThis.fetch;
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<Response>();
    const secondReadStarted = Promise.withResolvers<void>();
    const releaseSecondRead = Promise.withResolvers<void>();
    let tokens: CodexOAuthTokens = {
      type: "oauth",
      access: "expired-access",
      refresh: "refresh-token",
      expires: 0,
    };
    let readCalls = 0;
    let refreshCalls = 0;
    let responseCalls = 0;
    let responseBody: unknown;
    let refreshSignal: AbortSignal | undefined;

    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === "https://auth.openai.com") {
        refreshCalls += 1;
        refreshSignal = init?.signal ?? undefined;
        refreshStarted.resolve();
        return await releaseRefresh.promise;
      }
      if (url.pathname.endsWith("/backend-api/codex/responses")) {
        responseCalls += 1;
        responseBody = JSON.parse(String(init?.body));
        return new Response(
          [
            `data: ${JSON.stringify({
              type: "response.created",
              response: { id: `resp_${responseCalls}`, created_at: 1, model: "gpt-5.6" },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: `resp_${responseCalls}`,
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 0,
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              },
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    }) as typeof globalThis.fetch;

    try {
      const provider = createCodexOAuthProvider({
        responsesTransport: "sse",
        readTokens: async () => {
          readCalls += 1;
          if (readCalls === 3) {
            secondReadStarted.resolve();
            await releaseSecondRead.promise;
          }
          return tokens;
        },
        writeTokens: async (next) => {
          tokens = next;
        },
      });
      const model = provider.responses("gpt-5.6");
      const firstController = new AbortController();
      const firstResult = streamText({
        model,
        prompt: "first request",
        abortSignal: firstController.signal,
        onError: () => {},
      });
      const firstPartsPromise = (async () => {
        const parts = [];
        try {
          for await (const part of firstResult.stream) parts.push(part);
          return { parts, error: undefined };
        } catch (error) {
          return { parts, error };
        }
      })();

      await refreshStarted.promise;
      const secondResult = streamText({
        model,
        instructions: "Base prompt\n\nWorkspace prompt",
        prompt: "second request",
        providerOptions: { openai: { instructions: "Legacy instruction" } },
      });
      const secondPartsPromise = (async () => {
        const parts = [];
        for await (const part of secondResult.stream) parts.push(part);
        return parts;
      })();
      await secondReadStarted.promise;
      releaseSecondRead.resolve();

      const abortReason = new DOMException("first caller stopped", "AbortError");
      firstController.abort(abortReason);
      const firstOutcome = await firstPartsPromise;

      expect(refreshCalls).toBe(1);
      expect(refreshSignal?.aborted).toBe(false);
      expect(responseCalls).toBe(0);
      expect(
        firstOutcome.error === abortReason ||
          firstOutcome.parts.some(
            (part) =>
              part.type === "abort" || (part.type === "error" && part.error === abortReason),
          ),
      ).toBe(true);

      releaseRefresh.resolve(
        Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh" }),
      );
      const secondParts = await secondPartsPromise;

      expect(refreshCalls).toBe(1);
      expect(responseCalls).toBe(1);
      expect(responseBody).not.toHaveProperty("instructions");
      expect(responseBody).toMatchObject({
        input: [
          { role: "developer", content: "Base prompt\n\nWorkspace prompt" },
          { role: "user" },
        ],
      });
      expect(secondParts.some((part) => part.type === "finish")).toBe(true);
      expect(tokens.access).toBe("fresh-access");
      expect(tokens.refresh).toBe("fresh-refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
