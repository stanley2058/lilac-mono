import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import SuperJSON from "superjson";

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
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "doc.pdf",
                  data: { type: "data", data: hugeBase64 },
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
      (v) => !!v && typeof v === "object" && (v as Record<string, unknown>)["type"] === "file",
    ) as Record<string, unknown> | undefined;

    expect(filePart).toBeDefined();
    expect(filePart?.["filename"]).toBe("doc.pdf");
    expect(filePart?.["data"]).toEqual({ type: "data", data: hugeBase64 });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns latest transcript by session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    await new Promise((resolve) => setTimeout(resolve, 2));

    store.saveRequestTranscript({
      requestId: "r2",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "second" }],
      finalText: "second",
      modelLabel: "test-model",
    });

    const latest = store.getLatestTranscriptBySession({ sessionId: "sub:s:1:r1" });
    expect(latest).not.toBeNull();
    expect(latest?.requestId).toBe("r2");
    expect(latest?.finalText).toBe("second");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("heals stringified assistant tool-call inputs when loading old transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: '{"path":"note.txt","edits":[{"op":"replace","lines":["after install."]}}',
              },
            ],
          },
        ] satisfies ModelMessage[]),
      ],
    );
    rawDb.close();

    const latest = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(latest).not.toBeNull();

    const assistant = latest?.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toEqual({
      path: "note.txt",
      edits: [
        {
          op: "replace",
          lines: ["after install."],
        },
      ],
    });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("drops duplicate tool results when loading old transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: { path: "note.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "first" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "second" },
              },
            ],
          },
        ] satisfies ModelMessage[]),
      ],
    );
    rawDb.close();

    const latest = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(latest).not.toBeNull();
    expect(latest?.messages).toHaveLength(2);

    const tool = latest?.messages[1];
    expect(tool?.role).toBe("tool");
    if (!tool || tool.role !== "tool") {
      throw new Error("expected tool message");
    }

    const part = tool.content[0];
    expect(part?.type).toBe("tool-result");
    if (!part || part.type !== "tool-result") {
      throw new Error("expected tool-result part");
    }

    expect(part.output).toEqual({ type: "error-text", value: "first" });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists linked surface messages by request in creation order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    expect(store.listSurfaceMessagesForRequest?.({ requestId: "r1" })).toEqual([
      { platform: "discord", channelId: "chan", messageId: "m1" },
      { platform: "discord", channelId: "chan", messageId: "m2" },
    ]);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips compaction metadata and degrades invalid metadata to ordinary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m1",
      })?.contextMeta,
    ).toEqual({ type: "compaction", formatVersion: 1 });

    const db = new Database(dbPath);
    db.run("UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = ?", [
      '{"type":"compaction","formatVersion":999}',
      "checkpoint",
    ]);
    db.close();
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m1",
      })?.contextMeta,
    ).toBeUndefined();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("migrates existing transcript databases with ordinary metadata defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      )
    `);
    db.run(`INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "old",
      "chan",
      "discord",
      1,
      1,
      null,
      "old",
      SuperJSON.stringify([{ role: "assistant", content: "old" }]),
    ]);
    db.close();

    const store = new SqliteTranscriptStore(dbPath);
    const old = store.getLatestTranscriptBySession({ sessionId: "chan" });
    expect(old?.requestId).toBe("old");
    expect(old?.contextMeta).toBeUndefined();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves split-output checkpoints until the final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: false });
    expect(
      store.getTranscriptBySurfaceMessage({
        platform: "discord",
        channelId: "chan",
        messageId: "m2",
      })?.requestId,
    ).toBe("checkpoint");
    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: true });
    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ checkpointDeleted: false });
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not delete ordinary transcripts when their final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    store.saveRequestTranscript({
      requestId: "ordinary",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ordinary" }],
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "ordinary",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(
      store.unlinkSurfaceMessage({ platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "ordinary", checkpointDeleted: false });
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })?.requestId).toBe("ordinary");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cleans only unlinked checkpoint candidates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    for (const requestId of ["unlinked", "linked"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      });
    }
    store.linkSurfaceMessagesToRequest({
      requestId: "linked",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "unlinked" })).toBe(true);
    expect(store.deleteUnlinkedCheckpointCandidate({ requestId: "linked" })).toBe(false);
    expect(store.getLatestTranscriptBySession({ sessionId: "chan" })?.requestId).toBe("linked");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
