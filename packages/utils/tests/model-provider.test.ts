import { describe, expect, it } from "bun:test";

import { CODEX_BASE_INSTRUCTIONS } from "../codex-instructions";
import type { CodexOAuthTokens } from "../codex-oauth";
import {
  createCodexResponsesEventNormalizer,
  normalizeCodexResponsesRequestRecord,
  refreshCodexOAuthTokens,
  shouldRefreshCodexOAuthTokens,
} from "../model-provider";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("normalizeCodexResponsesRequestRecord", () => {
  it("backfills missing instructions and store for codex responses", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      input: [{ type: "message", role: "user", id: "msg_123", content: [] }],
    });

    expect(normalized.store).toBe(false);
    expect(normalized.instructions).toBe(CODEX_BASE_INSTRUCTIONS);
    expect(normalized.include).toEqual(["reasoning.encrypted_content"]);
    expect(normalized.parallel_tool_calls).toBe(true);
    expect((normalized.input as Array<Record<string, unknown>>)[0]?.id).toBeUndefined();
  });

  it("preserves explicit non-empty instructions", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      stream: true,
      instructions: "Keep this exact instruction",
      store: false,
      input: [],
    });

    expect(normalized.instructions).toBe("Keep this exact instruction");
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
      instructions: CODEX_BASE_INSTRUCTIONS,
    });
  });

  it("rejects non-streaming Codex requests before transport", () => {
    expect(() => normalizeCodexResponsesRequestRecord({ input: [] })).toThrow("requires streaming");
    expect(() => normalizeCodexResponsesRequestRecord({ stream: false, input: [] })).toThrow(
      "requires streaming",
    );
  });
});

describe("createCodexResponsesEventNormalizer", () => {
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
});
