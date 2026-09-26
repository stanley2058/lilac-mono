import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { buildCoreLineageManifestV2, type StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { displayMessageSchema } from "@stanley2058/lilac-client-protocol";
import {
  NativeExternalThreads,
  externalThreadId,
  type ExternalOutputs,
  type ExternalHistory,
} from "../../../src/surface/native/search-external";
import type {
  CoreStoredLineageManifestV2,
  TranscriptSnapshot,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";
import type { SurfaceAdapterResolver } from "../../../src/surface/runtime-descriptor";
import { formatSurfaceMetadataLine } from "../../../src/surface/bridge/surface-metadata";

function snapshot(
  id: string,
  timestamp: number,
  messages: StoredMessageV1[],
  sessionId = "123",
): TranscriptSnapshot {
  return {
    requestId: id,
    sessionId,
    requestClient: "discord",
    createdTs: timestamp,
    updatedTs: timestamp,
    messages,
  };
}
function fixture(
  snapshots: TranscriptSnapshot[],
  manifests = new Map<string, CoreStoredLineageManifestV2>(),
  outputs?: ExternalOutputs,
  projections?: Partial<
    Pick<SqliteTranscriptStore, "getCoreSurfaceProjection" | "getLatestCoreSurfaceSegment">
  >,
  history?: ExternalHistory,
  extraReplyIds: readonly string[] = [],
) {
  let reads = 0;
  const service = new NativeExternalThreads({
    getUser: (id) =>
      Result.ok({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
        createdAt: 0,
        updatedAt: 0,
      }),
    getAgent: () =>
      Result.ok({
        id: "lilac",
        providerId: "lilac",
        displayName: "Garden",
        role: "service",
        toolMode: "full",
        createdAt: 0,
        updatedAt: 0,
      }),
    profileProvider: {
      lookupUser: async (providerUserId) =>
        Result.ok({ providerUserId, displayName: "Stanley", discordUserIds: ["42"] }),
    },
    adapters: {
      registeredPlatforms: () => ["discord"],
      resolve: () => ({
        adapter: {
          listSessions: async () =>
            Result.ok([
              {
                ref: { platform: "discord", channelId: "123", guildId: "456" },
                title: "Calendar",
                kind: "thread",
              },
              {
                ref: { platform: "discord", channelId: "unused" },
                title: "No runs",
                kind: "thread",
              },
            ]),
          listMsg: async () => {
            throw new Error("Must not fetch channel history");
          },
        },
      }),
    } as unknown as SurfaceAdapterResolver,
    transcripts: {
      getCoreSurfaceProjection: () => Result.ok(null),
      getLatestCoreSurfaceSegment: () => Result.ok(null),
      ...projections,
      listDiscoveryRecords: () =>
        snapshots.map((s) => ({
          ...s,
          surfaceRefs: [
            {
              platform: s.requestClient === "github" ? "github" : "discord",
              channelId: s.sessionId,
              messageId: `reply-${s.requestId}`,
            },
            ...extraReplyIds.map((messageId) => ({
              platform: "discord" as const,
              channelId: s.sessionId,
              messageId,
            })),
          ],
        })),
      getRequestTranscript: ({ requestId }) => {
        reads++;
        return Result.ok(snapshots.find((s) => s.requestId === requestId) ?? null);
      },
      getCorePrimaryLineageManifest: ({ requestId }) => Result.ok(manifests.get(requestId) ?? null),
    },
    outputs,
    history,
    now: () => 1000,
  });
  return { service, reads: () => reads };
}
function lineage(messages: StoredMessageV1[]): CoreStoredLineageManifestV2 {
  return buildCoreLineageManifestV2(
    messages.map((message, index) => ({
      atoms: [
        {
          kind: "surface",
          requestClient: "discord",
          surfaceId: "discord:123",
          sessionId: "123",
          messageId: String(index),
        },
      ],
      canonicalMessages: [message],
    })),
    { currentSegmentIndex: messages.length - 1 },
  ).unwrap() as CoreStoredLineageManifestV2;
}

describe("retained external runs", () => {
  test("recovers active-channel inputs and images through cached thread membership without lineage", async () => {
    const prompt: StoredMessageV1 = {
      role: "user",
      content: [
        { type: "text", text: "Current prompt" },
        {
          type: "resource",
          uri: `resource://r1_${"a".repeat(32)}`,
          mediaType: "image/png",
          filename: "one.png",
        },
        {
          type: "resource",
          uri: `resource://r1_${"b".repeat(32)}`,
          mediaType: "image/png",
          filename: "two.png",
        },
      ],
    };
    const run = snapshot("req:active", 2, [{ role: "assistant", content: "Answer" }]);
    const previous = snapshot("req:previous", 1, [
      { role: "assistant", content: "Previous answer" },
    ]);
    const projectionsRead: string[] = [];
    const history: ExternalHistory = {
      getMessagePosition: (channelId, messageId) => {
        expect(channelId).toBe("123");
        return {
          threadId: "cached-thread",
          ordinal: messageId === "reply-req:active" ? 3 : 1,
          authorId: "bot",
        };
      },
      listMessagePositionsBefore: (threadId, beforeOrdinal) => {
        expect(threadId).toBe("cached-thread");
        if (beforeOrdinal === 1) return [];
        return [
          { messageId: "current", ordinal: 2, authorId: "owner" },
          { messageId: "previous-output", ordinal: 1, authorId: "bot" },
          { messageId: "old-input", ordinal: 0, authorId: "owner" },
        ];
      },
    };
    const f = fixture(
      [previous, run],
      undefined,
      undefined,
      {
        getCoreSurfaceProjection: (key) => {
          projectionsRead.push(key.messageId);
          return Result.ok({
            ...key,
            canonicalMessages: [prompt],
            sourceFacts: {},
            ownedBlobs: [],
            createdAt: 1,
          });
        },
      },
      history,
    );
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(projectionsRead).toEqual(["current"]);
    expect(page.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(page.messages[1]!.parts).toMatchObject([
      { type: "text", text: "Current prompt" },
      { type: "data-resource", data: { name: "one.png" } },
      { type: "data-resource", data: { name: "two.png" } },
    ]);
    expect(new Set(page.messages.map((m) => m.metadata?.externalRunId)).size).toBe(1);
  });

  test("hides assistant commentary while retaining final text and attachments", async () => {
    const f = fixture([
      snapshot("phases", 1, [
        {
          role: "assistant",
          content: "message commentary",
          providerOptions: { openai: { phase: "commentary" } },
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "part commentary",
              providerOptions: { openai: { phase: "commentary" } },
            },
            { type: "resource", uri: `resource://r1_${"a".repeat(32)}`, mediaType: "image/png" },
            {
              type: "text",
              text: "Final answer",
              providerOptions: { openai: { phase: "final_answer" } },
            },
          ],
        },
      ]),
    ]);
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.parts).toMatchObject([
      { type: "data-resource" },
      { type: "text", text: "Final answer" },
    ]);
  });

  test.each(["absent", "partial", "conflicting"] as const)(
    "continuations share a divider group with %s cached thread membership",
    async (membership) => {
      const firstInput: StoredMessageV1 = { role: "user", content: "First" };
      const secondInput: StoredMessageV1 = {
        role: "user",
        content: `${formatSurfaceMetadataLine({ message_id: "followup", user_id: "42" })}\nFollow up`,
      };
      const first = snapshot("first", 1, [{ role: "assistant", content: "First answer" }]);
      const second = snapshot("second", 2, [{ role: "assistant", content: "Second answer" }]);
      const linked = buildCoreLineageManifestV2(
        [
          {
            atoms: [
              {
                kind: "request",
                requestId: "first",
                transcriptDigest: "a".repeat(64),
                providerFamily: "ai-sdk",
                containsCrossFamilyTurns: false,
              },
            ],
            canonicalMessages: first.messages,
            requestSource: {
              aliases: [
                {
                  requestClient: "discord",
                  surfaceId: "discord:123",
                  sessionId: "123",
                  messageId: "first-output",
                },
              ],
            },
          },
          {
            atoms: [
              {
                kind: "surface",
                requestClient: "discord",
                surfaceId: "discord:123",
                sessionId: "123",
                messageId: "followup",
              },
            ],
            canonicalMessages: [secondInput],
          },
        ],
        { currentSegmentIndex: 1 },
      ).unwrap() as CoreStoredLineageManifestV2;
      const f = fixture(
        [first, second, snapshot("unrelated", 3, [{ role: "assistant", content: "Other thread" }])],
        new Map([
          ["first", lineage([firstInput])],
          ["second", linked],
        ]),
        undefined,
        undefined,
        {
          getMessagePosition: (_channelId, messageId) => {
            if (membership === "absent") return null;
            if (messageId === "reply-second" || messageId === "followup")
              return { threadId: "isolated-output-chunks", ordinal: 0, authorId: "bot" };
            if (membership === "conflicting" && messageId === "reply-first")
              return { threadId: "original-thread", ordinal: 0, authorId: "bot" };
            return null;
          },
          listMessagePositionsBefore: () => [],
        },
      );
      const page = (
        await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
      ).unwrap();
      expect(page.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "assistant",
      ]);
      expect(new Set(page.messages.slice(0, 4).map((m) => m.metadata?.externalRunId)).size).toBe(1);
      expect(page.messages[4]!.metadata?.externalRunId).not.toBe(
        page.messages[3]!.metadata?.externalRunId,
      );
      const anchored = (
        await f.service.readReference("owner", {
          target: { surface: "discord", sessionId: "123", messageId: "reply-second" },
        })
      ).unwrap();
      expect(anchored.messageFound).toBe(true);
      expect(anchored.messages.map((message) => message.id)).toEqual(
        page.messages.slice(0, 4).map((message) => message.id),
      );
      const inputAnchor = (
        await f.service.readReference("owner", {
          target: { surface: "discord", sessionId: "123", messageId: "followup" },
        })
      ).unwrap();
      expect(inputAnchor.messageFound).toBe(true);
      expect(inputAnchor.anchorMessageId).toBe(page.messages[2]!.id);
      expect(inputAnchor.messages.map((message) => message.id)).toEqual(
        page.messages.slice(0, 4).map((message) => message.id),
      );
    },
  );

  test("keeps the attributed user and attachment after compaction without a lineage manifest", async () => {
    const run = snapshot("req:compacted", 1, [
      { role: "user", content: "Internal checkpoint summary" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${formatSurfaceMetadataLine({ user_id: "42", user_name: "Stanley", message_id: "prompt" })}\nCurrent input`,
          },
          {
            type: "resource",
            uri: `resource://r1_${"a".repeat(32)}`,
            mediaType: "image/png",
            filename: "input.png",
          },
        ],
      },
      { role: "assistant", content: "Final reply" },
    ]);
    run.contextMeta = { type: "compaction", formatVersion: 1 };
    const f = fixture([run]);
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0]!.parts).toMatchObject([
      { type: "text", text: "Current input" },
      { type: "data-resource", data: { name: "input.png" } },
    ]);
  });

  test("recovers queued trigger inputs from a retained surface segment", async () => {
    const run = snapshot("queued:discord:123:trigger", 1, [
      { role: "assistant", content: "Answer" },
    ]);
    const f = fixture([run], undefined, undefined, {
      getLatestCoreSurfaceSegment: (key) => {
        expect(key.messageId).toBe("trigger");
        return Result.ok({
          requestId: "descendant",
          segmentIndex: 0,
          messageIds: ["trigger"],
          canonicalMessages: [{ role: "user", content: "Retained prompt" }],
        });
      },
    });
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0]!.parts).toEqual([{ type: "text", text: "Retained prompt" }]);
  });

  test("lists only sessions with retained runs and reads without live messages", async () => {
    const f = fixture([
      snapshot("old", 10, [{ role: "assistant", content: "old reply" }]),
      snapshot("new", 20, [{ role: "assistant", content: "new reply" }]),
      snapshot("other", 15, [], "other"),
    ]);
    const first = (await f.service.list("owner", { limit: 1 })).unwrap();
    expect(first.items.map((item) => item.title)).toEqual(["Calendar"]);
    expect(first.items[0]?.updatedAt).toBe(20);
    const second = (await f.service.list("owner", { cursor: first.nextCursor })).unwrap();
    expect(second.items.map((item) => item.title)).toEqual(["other"]);
    const read = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(read.thread.sourceUrl).toBe("https://discord.com/channels/456/123");
    expect(read.messages.map((m) => m.parts)).toEqual([
      [{ type: "text", text: "old reply" }],
      [{ type: "text", text: "new reply" }],
    ]);
    expect(read.messages[0]?.metadata?.externalRunId).not.toBe(
      read.messages[1]?.metadata?.externalRunId,
    );
    expect(read.messages[0]?.role).toBe("assistant");
  });
  test("uses current lineage inputs, preserves attachments and complete assistant text", async () => {
    const uri = `resource://r1_${"a".repeat(32)}`;
    const prompt: StoredMessageV1 = {
      role: "user",
      content: [
        {
          type: "text",
          text: `${formatSurfaceMetadataLine({ user_id: "42", user_name: "Stanley" })}\nLook at this`,
        },
        { type: "resource", uri, filename: "image.png", mediaType: "image/png", size: 10 },
      ],
    };
    const fullText = "long response ".repeat(6000);
    const f = fixture(
      [
        snapshot("run", 10, [
          {
            role: "assistant",
            content: [
              { type: "text", text: fullText.slice(0, 2000) },
              { type: "text", text: fullText.slice(2000) },
            ],
          },
        ]),
      ],
      new Map([["run", lineage([{ role: "user", content: "inherited history" }, prompt])]]),
    );
    const read = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(read.messages).toHaveLength(2);
    expect(read.messages[0]?.parts).toMatchObject([
      { type: "text", text: "Look at this" },
      { type: "data-resource", data: { resourceId: uri.slice(11), name: "image.png" } },
    ]);
    expect(read.messages[0]?.metadata).toMatchObject({
      authorId: "owner",
      authorDisplayName: "Stanley (Discord)",
    });
    expect(read.messages[1]?.parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toBe(
      fullText,
    );
    for (const message of read.messages)
      expect(displayMessageSchema.safeParse(message).success).toBe(true);
  });
  test("paginates large runs backward without dropping or duplicating messages", async () => {
    const f = fixture([
      snapshot("old", 1, [{ role: "assistant", content: "older" }]),
      snapshot(
        "new",
        2,
        Array.from({ length: 205 }, (_, i) => ({ role: "assistant", content: String(i) })),
      ),
    ]);
    const messages = [];
    let cursor: string | undefined;
    do {
      const page = (
        await f.service.read("owner", { threadId: externalThreadId("discord", "123"), cursor })
      ).unwrap();
      messages.unshift(...page.messages);
      cursor = page.nextCursor;
    } while (cursor);
    expect(messages).toHaveLength(206);
    expect(new Set(messages.map((m) => m.id)).size).toBe(206);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "older" }]);
    expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "204" }]);
  });
  test("resolves stored blobs only for the owner and retained runs", () => {
    const file = {
      type: "blob" as const,
      blob: { version: 1 as const, objectId: "object", sha256: "a".repeat(64), byteLength: 10 },
      mediaType: "image/png",
      filename: "output.png",
    };
    const f = fixture([snapshot("file", 1, [{ role: "assistant", content: [file] }])]);
    return f.service
      .read("owner", { threadId: externalThreadId("discord", "123") })
      .then((result) => {
        const part = result.unwrap().messages[0]!.parts[0]!;
        if (part.type !== "data-resource") throw new Error("Missing resource");
        expect(f.service.file("owner", part.data.resourceId).unwrap()).toEqual(file);
        expect(f.service.file("alice", part.data.resourceId).isErr()).toBe(true);
        expect(f.service.file("owner", `${part.data.resourceId}x`).isErr()).toBe(true);
      });
  });
  test("rejects unauthorized and invalid reads before reading transcripts", async () => {
    const f = fixture([]);
    expect((await f.service.list("alice", {})).isErr()).toBe(true);
    expect(
      (await f.service.read("alice", { threadId: externalThreadId("discord", "123") })).isErr(),
    ).toBe(true);
    expect(f.reads()).toBe(0);
    expect((await f.service.read("owner", { threadId: "invalid" })).isErr()).toBe(true);
    expect(
      (await f.service.read("owner", { threadId: externalThreadId("discord", "123") })).isErr(),
    ).toBe(true);
  });
  test("compaction preserves retained output parts without repeating inherited context", async () => {
    const input: StoredMessageV1 = { role: "user", content: "current prompt" };
    const file = {
      type: "resource" as const,
      uri: `resource://r1_${"c".repeat(32)}`,
      mediaType: "image/png",
      filename: "retained.png",
    };
    const run = snapshot("compacted", 10, [
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old response" },
      input,
      { role: "assistant", content: [{ type: "text", text: "new response" }, file] },
    ]);
    run.contextMeta = { type: "compaction", formatVersion: 1 };
    run.finalText = "new response";
    const f = fixture([run], new Map([[run.requestId, lineage([input])]]));
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]!.parts).toMatchObject([
      { type: "text", text: "new response" },
      { type: "data-resource", data: { name: "retained.png" } },
    ]);
    expect(JSON.stringify(page.messages)).not.toContain("old response");
    const fallback = fixture([run]);
    expect(
      (
        await fallback.service.read("owner", { threadId: externalThreadId("discord", "123") })
      ).unwrap().messages[0]!.parts,
    ).toHaveLength(2);
  });
  test("sent attachments resolve retained handles and leave placeholders after expiration", async () => {
    const result = {
      ok: true,
      attachments: [{ filename: "sent.png", mimeType: "image/png", bytes: 12 }],
    };
    const run = snapshot("sent", 1, [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "attachment.add_files",
            output: { type: "json", value: result },
          },
        ],
      },
      { role: "assistant", content: "Here is the image." },
    ]);
    const blob = { version: 1 as const, objectId: `b1_${"d".repeat(32)}` };
    let retained = true;
    const f = fixture([run], undefined, () =>
      Result.ok(
        retained
          ? [
              {
                requestId: "sent",
                requestDeliveryId: "delivery",
                target: { kind: "handle", blob },
                metadata: { filename: "sent.png", mimeType: "image/png" },
                createdAt: 1,
              },
            ]
          : [],
      ),
    );
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    const part = page.messages[0]!.parts[0]!;
    if (part.type !== "data-resource") throw new Error("Missing sent attachment");
    expect(part.data.state).toBe("ready");
    expect(f.service.file("owner", part.data.resourceId).unwrap()).toMatchObject({
      type: "pending-blob",
      blob,
    });
    expect(f.service.file("alice", part.data.resourceId).isErr()).toBe(true);
    retained = false;
    expect(f.service.file("owner", part.data.resourceId).isErr()).toBe(true);
    const expired = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(expired.messages[0]!.parts[0]).toMatchObject({
      type: "data-resource",
      data: { state: "failed", name: "sent.png", mediaType: "image/png" },
    });
  });
  test("CLI attachment metadata requires a correlated attachment command", async () => {
    const result = {
      ok: true,
      attachments: [{ filename: "sent.png", mimeType: "image/png", bytes: 12 }],
    };
    const run = snapshot("cli", 1, [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "bash",
            toolCallId: "send",
            input: { command: "tools attachment.add_files --paths image.png" },
          },
          {
            type: "tool-call",
            toolName: "bash",
            toolCallId: "unrelated",
            input: { command: "cat data.json" },
          },
        ],
      },
      {
        role: "tool",
        content: ["send", "unrelated"].map((toolCallId) => ({
          type: "tool-result" as const,
          toolName: "bash",
          toolCallId,
          output: {
            type: "json" as const,
            value: { stdout: JSON.stringify(result, null, 2), stderr: "", exitCode: 0 },
          },
        })),
      },
    ]);
    const f = fixture([run]);
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.parts).toHaveLength(1);
    expect(page.messages[0]!.parts[0]).toMatchObject({
      type: "data-resource",
      data: { name: "sent.png", state: "failed" },
    });
  });
  test("compaction without a retained trigger keeps expired sent-image metadata", async () => {
    const run = snapshot("checkpoint-sent", 1, [
      { role: "user", content: "compacted context summary" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call", toolName: "attachment.add_files", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "attachment.add_files",
            output: {
              type: "json",
              value: {
                ok: true,
                attachments: [{ filename: "image.png", mimeType: "image/png", bytes: 100 }],
              },
            },
          },
        ],
      },
      { role: "assistant", content: "Here is the image." },
    ]);
    run.contextMeta = { type: "compaction", formatVersion: 1 };
    const f = fixture([run]);
    const page = (
      await f.service.read("owner", { threadId: externalThreadId("discord", "123") })
    ).unwrap();
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]!.parts[0]).toMatchObject({
      type: "data-resource",
      data: { name: "image.png", state: "failed" },
    });
    expect(JSON.stringify(page.messages)).not.toContain("compacted context summary");
  });
});

test("message links retain Discord coordinates and restrict previews to the containing conversation", async () => {
  const metadata = formatSurfaceMetadataLine({
    platform: "discord",
    user_id: "42",
    user_name: "Stanley",
    message_id: "question",
    channel_id: "123",
  });
  const first = snapshot("first", 1, [
    { role: "user", content: `${metadata}\nQuestion` },
    { role: "assistant", content: "First answer" },
  ]);
  const second = snapshot("second", 2, [{ role: "assistant", content: "Second answer" }]);
  const history: ExternalHistory = {
    getMessagePosition: (_channelId, messageId) => ({
      threadId: messageId === "reply-second" ? "other-thread" : "first-thread",
      ordinal: 0,
      authorId: "42",
    }),
    listMessagePositionsBefore: () => [],
  };
  const { service } = fixture([first, second], undefined, undefined, undefined, history);
  const target = { surface: "discord" as const, sessionId: "123", messageId: "reply-first" };
  expect(service.resolveReference("owner", target).unwrap()).toEqual({
    conversationThreadId: "first-thread",
  });
  expect(service.resolveReference("participant", target).isErr()).toBe(true);
  const page = (await service.readReference("owner", { target })).unwrap();
  expect(page.messageFound).toBe(true);
  expect(
    page.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => p.text),
  ).toContain("First answer");
  expect(
    page.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => p.text),
  ).not.toContain("Second answer");
  expect(page.messages.find((m) => m.role === "assistant")?.metadata?.reference).toEqual(target);
  expect(page.sourceUrl).toBe("https://discord.com/channels/456/123/reply-first");
  expect(page.nextAfter).toBeUndefined();
  expect(page.nextCursor).toBeUndefined();
  const session = (
    await service.readReference("owner", { target: { surface: "discord", sessionId: "123" } })
  ).unwrap();
  expect(session.messages.some((m) => m.metadata?.reference?.messageId === "reply-second")).toBe(
    true,
  );
  const missing = (
    await service.readReference("owner", { target: { ...target, messageId: "missing" } })
  ).unwrap();
  expect(missing.messageFound).toBe(false);
});

test("a link to a later Discord output chunk highlights the assistant, not its input", async () => {
  const header = formatSurfaceMetadataLine({
    platform: "discord",
    user_id: "42",
    user_name: "Stanley",
    message_id: "question",
    channel_id: "123",
  });
  const run = snapshot("split", 1, [
    { role: "user", content: `${header}\nQuestion` },
    { role: "assistant", content: "Long answer" },
  ]);
  const { service } = fixture([run], undefined, undefined, undefined, undefined, ["second-chunk"]);
  const page = (
    await service.readReference("owner", {
      target: { surface: "discord", sessionId: "123", messageId: "second-chunk" },
    })
  ).unwrap();
  expect(page.messages[0]?.role).toBe("user");
  expect(page.messageFound).toBe(true);
  expect(page.messages.find((message) => message.id === page.anchorMessageId)?.role).toBe(
    "assistant",
  );
  expect(
    page.messages.find((message) => message.role === "assistant")?.metadata?.reference?.messageId,
  ).toBe("reply-split");
});

test("display message anchors keep pagination within their complete conversation", async () => {
  const service = fixture([
    snapshot(
      "first",
      1,
      Array.from({ length: 220 }, (_, i) => ({
        role: "assistant" as const,
        content: `First ${i}`,
      })),
    ),
    snapshot("second", 2, [{ role: "assistant", content: "Unrelated" }]),
  ]).service;
  const session = (
    await service.readReference("owner", { target: { surface: "discord", sessionId: "123" } })
  ).unwrap();
  const anchor = session.messages.find((message) =>
    message.parts.some((part) => part.type === "text" && part.text === "First 219"),
  )!;
  const target = { surface: "discord" as const, sessionId: "123", messageId: anchor.id };
  let page = (await service.readReference("owner", { target })).unwrap();
  const messages = [...page.messages];
  while (page.nextCursor) {
    page = (await service.readReference("owner", { target, cursor: page.nextCursor })).unwrap();
    messages.unshift(...page.messages);
  }
  expect(messages).toHaveLength(220);
  expect(messages[0]?.parts).toEqual([{ type: "text", text: "First 0" }]);
  expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "First 219" }]);
});
