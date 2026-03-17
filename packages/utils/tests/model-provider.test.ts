import { describe, expect, it } from "bun:test";

import { CODEX_BASE_INSTRUCTIONS } from "../codex-instructions";
import { normalizeCodexResponsesRequestRecord } from "../model-provider";

describe("normalizeCodexResponsesRequestRecord", () => {
  it("backfills missing instructions and store for codex responses", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      input: [{ type: "message", role: "user", id: "msg_123", content: [] }],
    });

    expect(normalized.store).toBe(false);
    expect(normalized.instructions).toBe(CODEX_BASE_INSTRUCTIONS);
    expect((normalized.input as Array<Record<string, unknown>>)[0]?.id).toBeUndefined();
  });

  it("preserves explicit non-empty instructions", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      instructions: "Keep this exact instruction",
      store: false,
      input: [],
    });

    expect(normalized.instructions).toBe("Keep this exact instruction");
    expect(normalized.store).toBe(false);
  });

  it("removes previous_response_id but keeps required item ids", () => {
    const normalized = normalizeCodexResponsesRequestRecord({
      previous_response_id: "resp_123",
      input: [
        { type: "item_reference", id: "item_123" },
        { type: "computer_call", id: "call_123" },
        { type: "message", id: "msg_123" },
      ],
    });

    expect(normalized.previous_response_id).toBeUndefined();
    expect((normalized.input as Array<Record<string, unknown>>)[0]?.id).toBe("item_123");
    expect((normalized.input as Array<Record<string, unknown>>)[1]?.id).toBe("call_123");
    expect((normalized.input as Array<Record<string, unknown>>)[2]?.id).toBeUndefined();
  });
});
