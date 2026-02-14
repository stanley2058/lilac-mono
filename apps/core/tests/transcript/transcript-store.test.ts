import { describe, expect, it } from "bun:test";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";

import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";

describe("SqliteTranscriptStore", () => {
  it("roundtrips transcripts without mutating tool outputs", async () => {
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
            output: { type: "text", value: big },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] satisfies ModelMessage[];

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

    const parts = Array.isArray(toolMsg!.content) ? (toolMsg!.content as unknown[]) : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    const output = toolResult?.["output"] as Record<string, unknown> | undefined;
    expect(output?.["type"]).toBe("text");
    expect(output?.["value"]).toBe(big);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips large base64 tool attachments without scrubbing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const hugeBase64 = "A".repeat(400_000);

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "doc.pdf" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Attached file from read_file" },
                {
                  type: "file-data",
                  mediaType: "application/pdf",
                  filename: "doc.pdf",
                  data: hugeBase64,
                },
              ],
            },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] satisfies ModelMessage[];

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

    const toolMsg = snap!.messages.find((m) => m.role === "tool");
    expect(toolMsg).not.toBeUndefined();

    const parts = Array.isArray(toolMsg!.content) ? (toolMsg!.content as unknown[]) : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    const output = toolResult?.["output"] as Record<string, unknown> | undefined;
    expect(output?.["type"]).toBe("content");

    const value = Array.isArray(output?.["value"]) ? (output?.["value"] as unknown[]) : [];

    // The binary data should be preserved in the persisted transcript.
    const filePart = value.find(
      (v) => !!v && typeof v === "object" && (v as Record<string, unknown>)["type"] === "file-data",
    ) as Record<string, unknown> | undefined;

    expect(filePart).toBeDefined();
    expect(filePart?.["filename"]).toBe("doc.pdf");
    expect(typeof filePart?.["data"]).toBe("string");
    expect(String(filePart?.["data"]).length).toBe(hugeBase64.length);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
