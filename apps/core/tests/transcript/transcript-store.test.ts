import { describe, expect, it } from "bun:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";

import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";

describe("SqliteTranscriptStore", () => {
  it("roundtrips transcripts and prunes old tool outputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const big = "x".repeat(60_000);

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            // The exact tool result output type is provider-utils dependent;
            // for this test we only care that it roundtrips and gets pruned.
            output: { type: "text", value: big },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] as unknown as ModelMessage[];

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "discord",
      messages,
      finalText: "done",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [{ platform: "discord", channelId: "chan", messageId: "bot-1" }],
      last: { platform: "discord", channelId: "chan", messageId: "bot-1" },
    });

    const snap = store.getTranscriptBySurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "bot-1",
    });

    expect(snap).not.toBeNull();
    expect(snap!.requestId).toBe("r1");
    expect(snap!.messages.length).toBe(messages.length);

    const toolMsg = snap!.messages.find((m) => m.role === "tool");
    expect(toolMsg).not.toBeUndefined();

    const parts = Array.isArray(toolMsg!.content)
      ? (toolMsg!.content as unknown[])
      : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    expect(toolResult?.["output"]).toEqual({
      type: "text",
      value: "[Old tool result content cleared]",
    });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
