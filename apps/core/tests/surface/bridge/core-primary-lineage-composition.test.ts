import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelMessage } from "ai";
import { Result, type Result as ResultType } from "better-result";
import {
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  decodeCorePrimaryLineageV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";

import {
  composeRecentChannelMessages as composeRecentChannelMessagesResult,
  composeRequestMessages as composeRequestMessagesResult,
  composeSingleMessageWithLineage as composeSingleMessageWithLineageResult,
} from "../../../src/surface/bridge/request-composition";
import type { SurfaceOperationResult, SurfaceOutputStream } from "../../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";
import { hashCanonicalStoredMessagesV2 } from "../../../src/transcript/transcript-persistence-codec";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import { getTestBlobStore } from "../../helpers/blob-store";
import { CoreResourceService, ResourceOriginAdapterRegistry } from "../../../src/resource";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

async function composeRecentChannelMessages(
  ...args: Parameters<typeof composeRecentChannelMessagesResult>
) {
  return resultValue(await composeRecentChannelMessagesResult(...args));
}

async function composeRequestMessages(...args: Parameters<typeof composeRequestMessagesResult>) {
  return resultValue(await composeRequestMessagesResult(...args));
}

async function composeSingleMessageWithLineage(
  ...args: Parameters<typeof composeSingleMessageWithLineageResult>
) {
  return resultValue(await composeSingleMessageWithLineageResult(...args));
}

function buildCoreLineageManifestV2(...args: Parameters<typeof buildCoreLineageManifestResultV2>) {
  return resultValue(buildCoreLineageManifestResultV2(...args));
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function createStore(): Promise<{ dbPath: string; store: SqliteTranscriptStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "lilac-primary-lineage-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "transcripts.db");
  return { dbPath, store: new SqliteTranscriptStore(dbPath) };
}

class MutableAdapter extends SurfaceAdapterTestBase {
  readonly reactions = new Map<string, string[]>();

  constructor(readonly messages: SurfaceMessage[]) {
    super();
  }

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async readMsg(ref: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    return Result.ok(
      this.messages.find(
        (message) =>
          message.session.channelId === ref.channelId && message.ref.messageId === ref.messageId,
      ) ?? null,
    );
  }

  async listMsg(
    session: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const before = opts?.beforeMessageId;
    const beforeMessage = before
      ? this.messages.find((message) => message.ref.messageId === before)
      : undefined;
    const messages = this.messages
      .filter((message) => message.session.channelId === session.channelId)
      .filter((message) => !beforeMessage || message.ts < beforeMessage.ts)
      .toSorted((left, right) => left.ts - right.ts);
    return Result.ok(messages.slice(-Math.max(1, opts?.limit ?? 50)));
  }

  async getReplyContext(ref: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const messageResult = await this.readMsg(ref);
    if (messageResult.status === "error") return Result.err(messageResult.error);
    return Result.ok(messageResult.value ? [messageResult.value] : []);
  }

  async listReactions(ref: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    return Result.ok([...(this.reactions.get(ref.messageId) ?? [])]);
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    throw new Error("not used");
  }
  async startOutput(): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    throw new Error("not used");
  }
  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    throw new Error("not used");
  }
  async editMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async deleteMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async addReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async removeReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async subscribe(): Promise<{ stop(): Promise<void> }> {
    throw new Error("not used");
  }
  async getUnRead(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    return Result.ok([]);
  }
  async markRead(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
}

function surfaceMessage(input: {
  id: string;
  text: string;
  ts: number;
  userId?: string;
  userName?: string;
  raw?: unknown;
}): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: "channel", messageId: input.id },
    session: { platform: "discord", channelId: "channel" },
    userId: input.userId ?? "user",
    userName: input.userName ?? "First Author",
    text: input.text,
    ts: input.ts,
    raw: input.raw ?? { reference: {} },
  };
}

function admitSurfaceProjection(input: {
  store: SqliteTranscriptStore;
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  messages: readonly StoredMessageV1[];
}): void {
  resultValue(
    input.store.admitCoreSurfaceProjection({
      requestClient: "discord",
      surfaceId: "discord:channel",
      sessionId: "channel",
      messageId: input.messageId,
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
      canonicalMessages: input.messages,
      sourceFacts: {
        authorId: input.authorId,
        authorName: input.authorName,
        messageTs: input.ts,
        reactions: [],
        attachments: [],
        segmentMessageIds: [input.messageId],
      },
      ownedBlobs: [],
    }),
  );
}

class LayeredCompositionAdapter extends MutableAdapter {
  readonly readMessageIds: string[] = [];
  listMessageCalls = 0;
  activeReads = 0;
  maximumActiveReads = 0;

  constructor(
    messages: SurfaceMessage[],
    private readonly replyChain: readonly MsgRef[],
  ) {
    super(messages);
  }

  override async readMsg(ref: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    this.readMessageIds.push(ref.messageId);
    this.activeReads += 1;
    this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
    const read = await super.readMsg(ref);
    this.activeReads -= 1;
    return read;
  }

  override async listMsg(
    session: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    this.listMessageCalls += 1;
    return super.listMsg(session, opts);
  }

  override async planReplyChain(): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    return Result.ok(this.replyChain);
  }

  override async planMergeBlockEndingAt(
    ref: MsgRef,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    return Result.ok([ref]);
  }
}

describe("layered Discord composition enrichment", () => {
  it("uses ingress, projections, and a linked bot transcript without reading Discord", async () => {
    const { store } = await createStore();
    const now = Date.now();
    admitSurfaceProjection({
      store,
      messageId: "root",
      authorId: "user",
      authorName: "User",
      ts: now - 1_000,
      messages: [{ role: "user", content: "stored root" }],
    });
    store.saveRequestTranscript({
      requestId: "answer-request",
      sessionId: "channel",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "stored answer" }],
      finalText: "stored answer",
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "answer-request",
      created: [{ platform: "discord", channelId: "channel", messageId: "answer" }],
      last: { platform: "discord", channelId: "channel", messageId: "answer" },
    });
    const trigger = surfaceMessage({
      id: "trigger",
      text: "follow up",
      ts: now + 1_000,
      raw: { reference: { messageId: "answer", channelId: "channel" } },
    });
    const refs = ["root", "answer", "trigger"].map(
      (messageId) => ({ platform: "discord", channelId: "channel", messageId }) satisfies MsgRef,
    );
    const adapter = new LayeredCompositionAdapter([], refs);

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      ingressMessages: [trigger],
      trigger: { type: "reply", msgRef: trigger.ref },
    });

    expect(adapter.readMessageIds).toEqual([]);
    expect(composed.chainMessageIds).toEqual(["root", "answer", "trigger"]);
    expect(JSON.stringify(composed.messages)).toContain("stored root");
    expect(JSON.stringify(composed.messages)).toContain("stored answer");
    expect(JSON.stringify(composed.messages)).toContain("follow up");
    store.close();
  });

  it("concurrently fetches only projection misses", async () => {
    const { store } = await createStore();
    admitSurfaceProjection({
      store,
      messageId: "root",
      authorId: "user",
      authorName: "User",
      ts: 1,
      messages: [{ role: "user", content: "stored root" }],
    });
    const missingOne = surfaceMessage({ id: "missing-1", text: "one", ts: 2, userId: "bot" });
    const missingTwo = surfaceMessage({ id: "missing-2", text: "two", ts: 3, userId: "bot" });
    const trigger = surfaceMessage({
      id: "trigger",
      text: "follow up",
      ts: 4,
      raw: { reference: { messageId: "missing-2", channelId: "channel" } },
    });
    const refs = ["root", "missing-1", "missing-2", "trigger"].map(
      (messageId) => ({ platform: "discord", channelId: "channel", messageId }) satisfies MsgRef,
    );
    const adapter = new LayeredCompositionAdapter([missingOne, missingTwo], refs);

    await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      ingressMessages: [trigger],
      trigger: { type: "reply", msgRef: trigger.ref },
    });

    expect(adapter.readMessageIds.toSorted()).toEqual(["missing-1", "missing-2"]);
    expect(adapter.maximumActiveReads).toBe(2);
    store.close();
  });

  it("checks an active ingress message for an effective reply before recent-channel selection", async () => {
    const { store } = await createStore();
    admitSurfaceProjection({
      store,
      messageId: "root",
      authorId: "other-user",
      authorName: "Other user",
      ts: 1,
      messages: [{ role: "user", content: "stored thread root" }],
    });
    const trigger = surfaceMessage({
      id: "trigger",
      text: "active reply",
      ts: 2,
      raw: {},
    });
    const refs = ["root", "trigger"].map(
      (messageId) => ({ platform: "discord", channelId: "channel", messageId }) satisfies MsgRef,
    );
    const adapter = new LayeredCompositionAdapter([], refs);

    const composed = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
      messageCache: {
        getIndexedMessage: () => null,
        listIndexedMessagesBefore: () => [],
      },
      ingressMessages: [trigger],
      triggerMsgRef: trigger.ref,
      triggerType: undefined,
    });

    expect(adapter.readMessageIds).toEqual([]);
    expect(adapter.listMessageCalls).toBe(0);
    expect(composed.chainMessageIds).toEqual(["root", "trigger"]);
    expect(JSON.stringify(composed.messages)).toContain("stored thread root");
    expect(JSON.stringify(composed.messages)).toContain("active reply");
    store.close();
  });

  it("applies a cached divider to an active reply without listing Discord messages", async () => {
    const { store } = await createStore();
    admitSurfaceProjection({
      store,
      messageId: "root",
      authorId: "other-user",
      authorName: "Other user",
      ts: 1,
      messages: [{ role: "user", content: "stored thread root" }],
    });
    const trigger = surfaceMessage({ id: "trigger", text: "active reply", ts: 3, raw: {} });
    const refs = ["root", "trigger"].map(
      (messageId) => ({ platform: "discord", channelId: "channel", messageId }) satisfies MsgRef,
    );
    const adapter = new LayeredCompositionAdapter([], refs);

    const composed = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
      messageCache: {
        getIndexedMessage: () => null,
        listIndexedMessagesBefore: () => [
          {
            ref: { platform: "discord", channelId: "channel", messageId: "divider" },
            session: { platform: "discord", channelId: "channel" },
            userId: "bot",
            text: "[LILAC_SESSION_DIVIDER]",
            ts: 2,
            deleted: false,
            updatedTs: 2,
            attachments: [],
          },
        ],
      },
      ingressMessages: [trigger],
      triggerMsgRef: trigger.ref,
      triggerType: undefined,
    });

    expect(adapter.readMessageIds).toEqual([]);
    expect(adapter.listMessageCalls).toBe(0);
    expect(composed.chainMessageIds).toEqual(["trigger"]);
    expect(JSON.stringify(composed.messages)).not.toContain("stored thread root");
    store.close();
  });
});

describe("Core primary lineage composition", () => {
  it("reuses first-seen text, attribution, reactions, forwarded content, and owned attachments", async () => {
    const { store } = await createStore();
    const blobStore = await getTestBlobStore();
    const resourceService = new CoreResourceService({
      store,
      blobStore,
      originAdapters: new ResourceOriginAdapterRegistry([]),
    });
    const message = surfaceMessage({
      id: "m1",
      text: "first text",
      ts: 1,
      raw: {
        reference: {},
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/image.png",
              filename: "image.png",
              mimeType: "image/png",
            },
            {
              url: "https://cdn.discordapp.com/attachments/1/document.pdf",
              filename: "document.pdf",
              mimeType: "application/pdf",
            },
            {
              url: "https://cdn.discordapp.com/attachments/1/note.txt",
              filename: "note.txt",
              mimeType: "text/plain",
            },
          ],
        },
      },
    });
    const adapter = new MutableAdapter([message]);
    adapter.reactions.set("m1", ["first"]);
    let fetches = 0;
    // @ts-expect-error test fetch stub
    globalThis.fetch = async (request) => {
      fetches += 1;
      const url = String(request);
      if (url.endsWith("image.png")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.endsWith("document.pdf")) return new Response(new Uint8Array([4, 5, 6]));
      return new Response("owned text");
    };

    const first = await composeSingleMessageWithLineage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: message.ref,
      transcriptStore: store,
      blobStore,
      resourceRegistry: resourceService,
      discordUserAliasById: new Map([["user", "First Alias"]]),
    });
    expect(first?.corePrimaryLineage.state).toBe("complete");
    expect(fetches).toBe(0);
    expect(JSON.stringify(first?.messages)).toContain("resource://r1_");
    expect(JSON.stringify(first?.messages)).not.toContain("owned text");

    message.text = "edited text";
    message.userId = "edited-user";
    message.userName = "Edited Author";
    message.ts = 999;
    message.raw = {
      reference: { type: 1, messageId: "edited-forward" },
      messageSnapshots: [{ message: { content: "edited forwarded content", attachments: [] } }],
    };
    adapter.reactions.set("m1", ["edited"]);

    const second = await composeSingleMessageWithLineage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: message.ref,
      transcriptStore: store,
      blobStore,
      resourceRegistry: resourceService,
      discordUserAliasById: new Map([["edited-user", "Edited Alias"]]),
    });
    expect(second?.messages).toEqual(first?.messages);
    expect(fetches).toBe(0);
    const serialized = JSON.stringify(second?.messages);
    expect(serialized).toContain("first text");
    expect(serialized).toContain("First Author");
    expect(serialized).toContain("First Alias");
    expect(serialized).toContain("first");
    expect(serialized).not.toContain("edited");
    await resourceService.close();
    store.close();
  });

  it("reuses an admitted origin-backed resource without a cache blob", async () => {
    const { store } = await createStore();
    const blobStore = await getTestBlobStore();
    const resourceService = new CoreResourceService({
      store,
      blobStore,
      originAdapters: new ResourceOriginAdapterRegistry([]),
    });
    const message = surfaceMessage({
      id: "m1",
      text: "image",
      ts: 1,
      raw: {
        reference: {},
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/image.png",
              filename: "image.png",
              mimeType: "image/png",
            },
          ],
        },
      },
    });
    const adapter = new MutableAdapter([message]);
    // @ts-expect-error test fetch stub
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    await composeSingleMessageWithLineage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: message.ref,
      transcriptStore: store,
      blobStore,
      resourceRegistry: resourceService,
    });
    const projection = resultValue(
      store.getCoreSurfaceProjection({
        requestClient: "discord",
        surfaceId: "discord:channel",
        sessionId: "channel",
        messageId: "m1",
        projectionFormatVersion: 1,
      }),
    );
    expect(projection?.ownedBlobs).toEqual([]);
    expect(JSON.stringify(projection?.canonicalMessages)).toContain("resource://r1_");

    const second = await composeSingleMessageWithLineage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: message.ref,
      transcriptStore: store,
      blobStore,
      resourceRegistry: resourceService,
    });
    expect(JSON.stringify(second?.messages)).toContain("resource://r1_");
    await resourceService.close();
    store.close();
  });

  it("keeps the current input separate from adjacent same-author history", async () => {
    const { store } = await createStore();
    const messages = [
      surfaceMessage({ id: "m1", text: "one", ts: 1 }),
      surfaceMessage({ id: "m2", text: "two", ts: 2 }),
    ];
    const adapter = new MutableAdapter(messages);
    const first = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });
    expect(first.mergedGroups).toEqual([
      { authorId: "user", messageIds: ["m1"] },
      { authorId: "user", messageIds: ["m2"] },
    ]);
    if (first.corePrimaryLineage.state !== "complete") throw new Error("expected lineage");
    expect(first.corePrimaryLineage.currentCanonicalStart).toBe(1);
    store.saveRequestTranscript({
      requestId: "request-1",
      sessionId: "channel",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "response" }],
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
      corePrimaryLineage: first.corePrimaryLineage,
    });

    messages.push(surfaceMessage({ id: "m3", text: "three", ts: 3 }));
    const second = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });
    expect(second.mergedGroups).toEqual([
      { authorId: "user", messageIds: ["m1"] },
      { authorId: "user", messageIds: ["m2"] },
      { authorId: "user", messageIds: ["m3"] },
    ]);
    expect(second.corePrimaryLineage.state).toBe("complete");
    if (second.corePrimaryLineage.state === "complete") {
      expect(
        second.corePrimaryLineage.segments.map((segment) => segment.canonicalMessages.length),
      ).toEqual([1, 1, 1]);
      expect(second.corePrimaryLineage.currentCanonicalStart).toBe(2);
    }
    store.close();
  });

  it("preserves multiple trailing current messages as one current segment", async () => {
    const { store } = await createStore();
    const messages = [
      surfaceMessage({ id: "m1", text: "history", ts: 1 }),
      surfaceMessage({ id: "m2", text: "current one", ts: 2 }),
      surfaceMessage({ id: "m3", text: "current two", ts: 3 }),
    ];
    const composed = await composeRecentChannelMessages(new MutableAdapter(messages), {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      currentMessageIds: ["m2", "m3"],
      transcriptStore: store,
    });

    expect(composed.mergedGroups).toEqual([
      { authorId: "user", messageIds: ["m1"] },
      { authorId: "user", messageIds: ["m2", "m3"] },
    ]);
    if (composed.corePrimaryLineage.state !== "complete") throw new Error("expected lineage");
    expect(composed.corePrimaryLineage.currentCanonicalStart).toBe(1);
    expect(composed.corePrimaryLineage.segments[1]?.atoms).toHaveLength(2);
    store.close();
  });

  it("expands split Discord output aliases as one complete request atom and segment", async () => {
    const { store } = await createStore();
    const transcript = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      { role: "assistant", content: "complete output" },
    ] satisfies StoredMessageV1[];
    store.saveRequestTranscript({
      requestId: "source-request",
      sessionId: "channel",
      requestClient: "discord",
      messages: transcript,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    });
    const botOne = surfaceMessage({ id: "bot-1", text: "part one", ts: 1, userId: "bot" });
    const botTwo = surfaceMessage({ id: "bot-2", text: "part two", ts: 2, userId: "bot" });
    const user = surfaceMessage({ id: "user-1", text: "next", ts: 3 });
    store.linkSurfaceMessagesToRequest({
      requestId: "source-request",
      created: [botOne.ref, botTwo.ref],
      last: botTwo.ref,
    });

    const composed = await composeRecentChannelMessages(
      new MutableAdapter([botOne, botTwo, user]),
      {
        platform: "discord",
        sessionId: "channel",
        botUserId: "bot",
        botName: "lilac",
        limit: 8,
        transcriptStore: store,
      },
    );
    expect(composed.messages.slice(0, transcript.length)).toEqual(transcript);
    expect(JSON.stringify(composed.messages).match(/complete output/gu)).toHaveLength(1);
    expect(composed.corePrimaryLineage.state).toBe("complete");
    if (composed.corePrimaryLineage.state === "complete") {
      const requestAtoms = composed.corePrimaryLineage.segments.flatMap((segment) =>
        segment.atoms.filter((atom) => atom.kind === "request"),
      );
      expect(requestAtoms).toHaveLength(1);
      expect(composed.corePrimaryLineage.segments[0]?.atoms).toEqual([
        expect.objectContaining({ kind: "request", requestId: "source-request" }),
      ]);
      expect(composed.corePrimaryLineage.segments[0]?.requestSource?.aliases).toEqual([
        {
          requestClient: "discord",
          surfaceId: "discord:channel",
          sessionId: "channel",
          messageId: "bot-1",
        },
        {
          requestClient: "discord",
          surfaceId: "discord:channel",
          sessionId: "channel",
          messageId: "bot-2",
        },
      ]);
      expect(composed.corePrimaryLineage.segments[0]?.canonicalMessages).toEqual(transcript);
    }
    store.close();
  });

  it("persists follow-up lineage after its replied-to preview is deleted", async () => {
    const { store } = await createStore();
    const preview = surfaceMessage({ id: "preview", text: "working", ts: 1, userId: "bot" });
    const user = surfaceMessage({
      id: "follow-up",
      text: "next",
      ts: 2,
      raw: { reference: { messageId: "preview", channelId: "channel" } },
    });
    const final = surfaceMessage({ id: "final", text: "answer", ts: 3, userId: "bot" });
    resultValue(
      store.saveRequestTranscript({
        requestId: "source",
        sessionId: "channel",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "canonical answer" }],
        providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
      }),
    );
    store.linkSurfaceMessagesToRequest({
      requestId: "source",
      created: [preview.ref],
      last: preview.ref,
    });
    const adapter = new LayeredCompositionAdapter([preview, user], [preview.ref, user.ref]);
    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      ingressMessages: [user],
      trigger: { type: "reply", msgRef: user.ref },
    });
    const manifest = composed.corePrimaryLineage;
    expect(manifest.state).toBe("complete");
    if (manifest.state !== "complete") throw new Error("expected complete lineage");
    expect(manifest.segments[0]?.requestSource?.aliases.map((alias) => alias.messageId)).toEqual([
      "preview",
    ]);
    const validate = () =>
      resultValue(
        store.validateCorePrimaryLineageReferences({
          manifest,
          requestClient: "discord",
          sessionId: "channel",
          surfaceId: "discord:channel",
        }),
      );
    expect(validate()).toBeNull();
    resultValue(store.unlinkSurfaceMessage(preview.ref));
    store.linkSurfaceMessagesToRequest({
      requestId: "source",
      created: [final.ref],
      last: final.ref,
    });
    expect(validate()).toBeNull();
    resultValue(
      store.saveRequestTranscript({
        requestId: "following",
        sessionId: "channel",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "following answer" }],
        corePrimaryLineage: manifest,
      }),
    );
    expect<unknown>(
      resultValue(store.getCorePrimaryLineageManifest({ requestId: "following" })),
    ).toEqual(manifest);
    expect(store.listSurfaceMessagesForRequest({ requestId: "source" })).toEqual([final.ref]);
    store.close();
  });

  it("falls back to the surface projection when a linked request transcript is empty", async () => {
    const { store } = await createStore();
    store.saveRequestTranscript({
      requestId: "failed-request",
      sessionId: "channel",
      requestClient: "discord",
      messages: [],
      finalText: "Error: failed before producing a recoverable transcript",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: true },
    });
    const failedOutput = surfaceMessage({
      id: "failed-output",
      text: "Visible progress\n\nError: failed before producing a recoverable transcript",
      ts: 1,
      userId: "bot",
    });
    const retry = surfaceMessage({
      id: "retry",
      text: "continue",
      ts: 2,
      raw: { reference: { messageId: failedOutput.ref.messageId, channelId: "channel" } },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "failed-request",
      created: [failedOutput.ref],
      last: failedOutput.ref,
    });

    const composed = await composeRequestMessages(new MutableAdapter([failedOutput, retry]), {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      trigger: { type: "reply", msgRef: retry.ref },
    });

    expect(composed.messages).toEqual([
      { role: "assistant", content: failedOutput.text },
      expect.objectContaining({ role: "user" }),
    ]);
    if (composed.corePrimaryLineage.state !== "complete") throw new Error("expected lineage");
    expect(composed.corePrimaryLineage.segments[0]?.atoms).toEqual([
      expect.objectContaining({ kind: "surface", messageId: failedOutput.ref.messageId }),
    ]);
    expect(
      composed.corePrimaryLineage.segments.flatMap((segment) =>
        segment.atoms.filter((atom) => atom.kind === "request"),
      ),
    ).toEqual([]);
    expect(decodeCorePrimaryLineageV2(composed.corePrimaryLineage, composed.messages).status).toBe(
      "ok",
    );
    store.close();
  });

  it("restores a persisted synthetic input suffix before its request atom", async () => {
    const { store } = await createStore();
    const firstInput = surfaceMessage({ id: "input-1", text: "first", ts: 1 });
    const output = surfaceMessage({ id: "output-1", text: "response", ts: 2, userId: "bot" });
    const secondInput = surfaceMessage({ id: "input-2", text: "next", ts: 3 });
    const adapter = new MutableAdapter([firstInput, output, secondInput]);
    const first = await composeSingleMessageWithLineage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: firstInput.ref,
      transcriptStore: store,
    });
    if (!first || first.corePrimaryLineage.state !== "complete") {
      throw new Error("expected complete first input lineage");
    }
    const injected = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "auto-thread-request-1",
            toolName: "conversation_thread_search",
            input: { note: "auto-injected after long user input" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "auto-thread-request-1",
            toolName: "conversation_thread_search",
            output: { type: "json", value: { entries: [] } },
          },
        ],
      },
    ] satisfies ModelMessage[];
    const inputManifest = buildCoreLineageManifestV2(
      [
        ...first.corePrimaryLineage.segments.map((segment) => ({
          atoms: segment.atoms,
          canonicalMessages: segment.canonicalMessages,
          ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
        })),
        {
          atoms: [
            {
              kind: "synthetic" as const,
              source: "conversation-thread-auto-inject",
              messageDigest: resultValue(hashCanonicalStoredMessagesV2(injected)).hash,
            },
          ],
          canonicalMessages: injected,
        },
      ],
      { currentSegmentIndex: 0 },
    );
    const response = [{ role: "assistant", content: "complete response" }] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "request-1",
      sessionId: "channel",
      requestClient: "discord",
      messages: response,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      corePrimaryLineage: inputManifest,
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "request-1",
      created: [output.ref],
      last: output.ref,
    });

    const composed = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });

    expect(composed.messages).toEqual([
      ...first.messages,
      ...injected,
      ...response,
      expect.objectContaining({ role: "user" }),
    ]);
    if (composed.corePrimaryLineage.state !== "complete") throw new Error("expected lineage");
    expect(composed.corePrimaryLineage.segments.map((segment) => segment.atoms[0]?.kind)).toEqual([
      "surface",
      "synthetic",
      "request",
      "surface",
    ]);
    expect(composed.corePrimaryLineage.segments[1]?.canonicalMessages).toEqual(injected);
    expect(composed.corePrimaryLineage.currentCanonicalStart).toBe(
      first.messages.length + injected.length + response.length,
    );
    expect(decodeCorePrimaryLineageV2(composed.corePrimaryLineage, composed.messages).status).toBe(
      "ok",
    );
    store.close();
  });

  it("splits distinct requests merged into one bot chunk without dropping either transcript", async () => {
    const { store } = await createStore();
    const firstTranscript = [
      { role: "assistant", content: "first output" },
    ] satisfies ModelMessage[];
    const secondTranscript = [
      { role: "assistant", content: "second output" },
    ] satisfies ModelMessage[];
    for (const [requestId, messages] of [
      ["request-one", firstTranscript],
      ["request-two", secondTranscript],
    ] as const) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "channel",
        requestClient: "discord",
        messages,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      });
    }
    const botOne = surfaceMessage({ id: "bot-1", text: "first", ts: 1, userId: "bot" });
    const botTwo = surfaceMessage({ id: "bot-2", text: "second", ts: 2, userId: "bot" });
    const user = surfaceMessage({ id: "user-1", text: "next", ts: 3 });
    store.linkSurfaceMessagesToRequest({
      requestId: "request-one",
      created: [botOne.ref],
      last: botOne.ref,
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "request-two",
      created: [botTwo.ref],
      last: botTwo.ref,
    });

    const composed = await composeRecentChannelMessages(
      new MutableAdapter([botOne, botTwo, user]),
      {
        platform: "discord",
        sessionId: "channel",
        botUserId: "bot",
        botName: "lilac",
        limit: 8,
        transcriptStore: store,
      },
    );

    expect(composed.messages).toEqual([
      ...firstTranscript,
      ...secondTranscript,
      expect.objectContaining({ role: "user" }),
    ]);
    if (composed.corePrimaryLineage.state !== "complete") throw new Error("expected lineage");
    expect(
      composed.corePrimaryLineage.segments.flatMap((segment) =>
        segment.atoms.filter((atom) => atom.kind === "request").map((atom) => atom.requestId),
      ),
    ).toEqual(["request-one", "request-two"]);
    expect(
      composed.corePrimaryLineage.segments.slice(0, 2).map((segment) => segment.atoms.length),
    ).toEqual([1, 1]);
    store.close();
  });

  it("does not expand a request transcript linked from another session", async () => {
    const { store } = await createStore();
    store.saveRequestTranscript({
      requestId: "foreign-request",
      sessionId: "other-channel",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "foreign private history" }],
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
    });
    const bot = surfaceMessage({ id: "bot", text: "visible output", ts: 1, userId: "bot" });
    const user = surfaceMessage({ id: "user", text: "next", ts: 2 });
    store.linkSurfaceMessagesToRequest({
      requestId: "foreign-request",
      created: [bot.ref],
      last: bot.ref,
    });

    const composed = await composeRecentChannelMessages(new MutableAdapter([bot, user]), {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });

    expect(JSON.stringify(composed.messages)).toContain("visible output");
    expect(JSON.stringify(composed.messages)).not.toContain("foreign private history");
    expect(composed.corePrimaryLineage.state).toBe("complete");
    if (composed.corePrimaryLineage.state === "complete") {
      expect(
        composed.corePrimaryLineage.segments.flatMap((segment) =>
          segment.atoms.filter((atom) => atom.kind === "request"),
        ),
      ).toEqual([]);
    }
    store.close();
  });

  it("emits aligned complete reply, mention, active-window, divider, and checkpoint segments", async () => {
    const { store } = await createStore();
    const root = surfaceMessage({ id: "root", text: "root", ts: 1, userId: "root-user" });
    const reply = surfaceMessage({
      id: "reply",
      text: "reply",
      ts: 2,
      raw: { reference: { messageId: "root", channelId: "channel" } },
    });
    const mention = surfaceMessage({ id: "mention", text: "<@bot> mention", ts: 3 });
    const divider = surfaceMessage({
      id: "divider",
      text: "[LILAC_SESSION_DIVIDER]",
      ts: 4,
      userId: "bot",
      userName: "lilac",
    });
    const afterDivider = surfaceMessage({ id: "after", text: "after divider", ts: 5 });
    const adapter = new MutableAdapter([root, reply, mention, divider, afterDivider]);

    const replyComposition = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      trigger: { type: "reply", msgRef: reply.ref },
    });
    const mentionComposition = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore: store,
      trigger: { type: "mention", msgRef: mention.ref },
    });
    const windowComposition = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });
    for (const composition of [replyComposition, mentionComposition, windowComposition]) {
      expect(composition.corePrimaryLineage.state).toBe("complete");
      expect(
        decodeCorePrimaryLineageV2(composition.corePrimaryLineage, composition.messages).status,
      ).toBe("ok");
    }
    expect(windowComposition.chainMessageIds).toEqual(["after"]);

    const checkpointMessages = [
      { role: "user", content: "compacted summary" },
      { role: "assistant", content: "checkpoint answer" },
    ] satisfies ModelMessage[];
    store.saveRequestTranscript({
      requestId: "checkpoint-request",
      sessionId: "channel",
      requestClient: "discord",
      messages: checkpointMessages,
      contextMeta: { type: "compaction", formatVersion: 1 },
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    const checkpointOutput = surfaceMessage({
      id: "checkpoint-output",
      text: "surface checkpoint",
      ts: 6,
      userId: "bot",
      userName: "lilac",
    });
    const descendant = surfaceMessage({ id: "descendant", text: "descendant", ts: 7 });
    adapter.messages.push(checkpointOutput, descendant);
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint-request",
      created: [checkpointOutput.ref],
      last: checkpointOutput.ref,
    });
    const checkpointComposition = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId: "channel",
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore: store,
    });
    expect(checkpointComposition.corePrimaryLineage.state).toBe("complete");
    if (checkpointComposition.corePrimaryLineage.state === "complete") {
      expect(checkpointComposition.corePrimaryLineage.segments[0]?.atoms).toEqual([
        expect.objectContaining({ kind: "checkpoint", requestId: "checkpoint-request" }),
      ]);
      expect(checkpointComposition.corePrimaryLineage.segments[0]?.canonicalMessages).toEqual(
        checkpointMessages,
      );
    }
    expect(
      decodeCorePrimaryLineageV2(
        checkpointComposition.corePrimaryLineage,
        checkpointComposition.messages,
      ).status,
    ).toBe("ok");
    store.close();
  });
});
