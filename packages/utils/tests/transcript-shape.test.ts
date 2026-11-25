import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { buildTranscriptShapeSnapshot } from "../transcript-shape";

describe("buildTranscriptShapeSnapshot", () => {
  it("strips user content, provider-echoed prose, and unknown keys while preserving pairing, indices, and error categories", () => {
    const rawCallId = "toolu_01AbCdEfGhIjKlMnOpQrStUv";
    const externalToolName = "acme_internal_jira_search";

    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Please check our secret customer contract at /home/alice/acme-deal.pdf",
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Private chain of thought about Alice's contract",
            providerOptions: {
              anthropic: { signature: "sig_super_secret_blob", privateCustomOpt: "leak" },
              privateVendor: { secretVendorKey: "leak" },
              constructor: { protoKey: "must_not_throw" },
              toString: { protoKey2: "must_not_throw" },
            },
          },
          {
            type: "tool-call",
            toolCallId: rawCallId,
            toolName: "bash",
            input: {
              command: "cat /home/alice/acme-deal.pdf",
              timeoutMs: 5000,
              secretExtraKey: "must_be_hashed",
            },
            providerOptions: {
              openai: { itemId: "fc_raw_item_id", phase: "commentary" },
            },
          },
          {
            type: "tool-call",
            toolCallId: "mcp:bad.id/1",
            toolName: externalToolName,
            input: { projectKey: "SECRET-PROJ", limit: 10 },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: rawCallId,
            toolName: "bash",
            output: { type: "text", value: "CONFIDENTIAL CONTRACT BODY" },
          },
        ],
      },
      {
        role: "user",
        content: "Why did it fail?",
      },
    ];

    const snapshot = buildTranscriptShapeSnapshot({
      messages,
      target: {
        provider: "anthropic",
        profileFamily: "anthropic",
        routed: false,
      },
      provenance: {
        source: "wal-recovery",
        compacted: true,
        didSwitchModel: true,
        step: 2,
      },
      errorDetails: {
        aiErrorName: "AI_APICallError",
        aiErrorMessage: `messages.1: tool_use ids were found without tool_result blocks immediately after: mcp:bad.id/1 Green Finch ${externalToolName}`,
        statusCode: 400,
        providerType: "invalid_request_error",
        providerParam: "messages.1.content.2.secretSegment",
        providerMessage: `messages.1: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: mcp:bad.id/1 ("Green Finch")`,
      },
      hashExternalName: (domain, raw) => `${domain}_${raw.length}_hash`,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("acme-deal");
    expect(serialized).not.toContain("CONFIDENTIAL");
    expect(serialized).not.toContain("sig_super_secret_blob");
    expect(serialized).not.toContain("fc_raw_item_id");
    expect(serialized).not.toContain("SECRET-PROJ");
    expect(serialized).not.toContain("Green Finch");
    expect(serialized).not.toContain("secretExtraKey");
    expect(serialized).not.toContain("privateCustomOpt");
    expect(serialized).not.toContain("privateVendor");
    expect(serialized).not.toContain("secretVendorKey");
    expect(serialized).not.toContain("secretSegment");
    expect(serialized).not.toContain(rawCallId);
    expect(serialized).not.toContain("mcp:bad.id/1");
    expect(serialized).not.toContain(externalToolName);
    expect(serialized).not.toContain("projectKey");

    // Structured provider diagnostics identify category, failing index, param path, and local alias.
    expect(snapshot.errorCategory).toBe("orphan_tool_call");
    expect(snapshot.referencedMessageIndices).toEqual([1]);
    expect(snapshot.referencedCallIds).toEqual(["tc_2"]);
    expect(snapshot.referencedParamPath).toBe("messages.1.content.2.<field>");

    // Anomalies catch both the orphaned tool call and the illegal characters in the ID.
    expect(snapshot.anomalies).toContain("tool_call_id_chars:tc_2=colon+dot+slash");
    expect(snapshot.anomalies).toContain("unmatched_tool_call_before_user:tc_2@msg=3");
    expect(snapshot.anomalies).toContain("orphan_tool_call:tc_2@msg=1");

    // Built-in tool retains allowlisted argument keys with JS types and hashes unknown extra keys.
    const assistantMsg = snapshot.window[1];
    expect(assistantMsg?.parts?.[1]).toMatchObject({
      type: "tool-call",
      tool: "bash",
      callId: "tc_1",
      callIdShape: { len: rawCallId.length, prefix: "toolu_", chars: "alnum_dash_underscore" },
      inputShape: {
        kind: "object",
        keyCount: 3,
        keys: {
          command: "string",
          timeoutMs: "number",
          k_arg_14_h: "string",
        },
      },
      phase: "commentary",
      providerOptions: { openai: ["itemId", "phase"] },
    });
  });

  it("records pre-projection differences and windows long transcripts around the failing index", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }

    const preProjectionMessages: ModelMessage[] = [...messages, { role: "assistant", content: [] }];

    const snapshot = buildTranscriptShapeSnapshot({
      messages,
      preProjectionMessages,
      errorDetails: {
        aiErrorName: "AI_APICallError",
        aiErrorMessage: "messages.10: invalid content",
        statusCode: 400,
        providerParam: "messages.10",
      },
      hashExternalName: (_d, raw) => raw.slice(0, 8),
    });

    expect(snapshot.totalMessages).toBe(60);
    expect(snapshot.preProjectionSummary?.totalMessages).toBe(61);
    expect(snapshot.window.length).toBeLessThanOrEqual(32);
    expect(snapshot.window.some((msg) => msg.i === 10)).toBe(true);
    expect(snapshot.window.some((msg) => msg.i === 59)).toBe(true);
  });

  it("reserves all cited failing message indices in long transcripts before adding tail entries", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 100; i += 1) {
      messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` });
    }
    const snapshot = buildTranscriptShapeSnapshot({
      messages,
      errorDetails: {
        aiErrorName: "AI_APICallError",
        aiErrorMessage: "messages.2, messages.12, messages.22, messages.32, messages.42 invalid",
        statusCode: 400,
      },
      hashExternalName: (_d, raw) => raw.slice(0, 8),
    });

    const indices = new Set(snapshot.window.map((msg) => msg.i));
    for (const cited of [2, 12, 22, 32, 42]) {
      expect(indices.has(cited)).toBe(true);
    }
  });

  it("handles empty transcripts and truncates oversized first segments at balanced token boundaries", () => {
    const emptySnapshot = buildTranscriptShapeSnapshot({
      messages: [],
      hashExternalName: (_d, raw) => raw.slice(0, 8),
    });
    expect(emptySnapshot.totalMessages).toBe(0);
    expect(emptySnapshot.roleTrace).toBe("");

    const manyParts = Array.from({ length: 400 }, (_, i) => ({
      type: "tool-call" as const,
      toolCallId: `call_${i}`,
      toolName: "bash",
      input: { command: "echo ok" },
    }));
    const oversizedSnapshot = buildTranscriptShapeSnapshot({
      messages: [{ role: "assistant", content: manyParts }],
      hashExternalName: (_d, raw) => raw.slice(0, 8),
    });
    expect(oversizedSnapshot.roleTrace.length).toBeLessThanOrEqual(2_000);
    expect(oversizedSnapshot.roleTrace.endsWith(")...")).toBe(true);
    expect(oversizedSnapshot.roleTrace.startsWith("a(tc_1,")).toBe(true);
  });
});
