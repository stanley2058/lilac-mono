import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
  composeRecentChannelMessages as composeRecentChannelMessagesResult,
  composeRequestMessages as composeRequestMessagesResult,
  composeSingleMessage as composeSingleMessageResult,
} from "../../../src/surface/bridge/request-composition";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type {
  BlobHandleV1,
  BlobRefV1,
  BlobStore,
  BlobUpload,
} from "@stanley2058/lilac-blob-storage";
import { Panic, Result } from "better-result";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceOperationResult,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import {
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfaceRateLimited,
  SurfaceUnavailable,
} from "../../../src/surface/adapter";
import type {
  AdmitCoreSurfaceProjection,
  TranscriptSnapshot,
  TranscriptStore,
} from "../../../src/transcript/transcript-store";
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
import { getTestBlobStore } from "../../helpers/blob-store";
import type { DiscordAttachmentCacheAccess } from "../../../src/surface/discord/discord-attachment";
import type { RegisterResourceInput, ResourceDescriptor } from "../../../src/resource/contracts";
import { ResourceStoreFailure } from "../../../src/resource/errors";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";

async function composeRecentChannelMessages(
  ...args: Parameters<typeof composeRecentChannelMessagesResult>
) {
  const composed = await composeRecentChannelMessagesResult(...args);
  if (composed.status === "error") throw composed.error;
  return composed.value;
}

async function composeRequestMessages(...args: Parameters<typeof composeRequestMessagesResult>) {
  const composed = await composeRequestMessagesResult(...args);
  if (composed.status === "error") throw composed.error;
  return composed.value;
}

async function composeSingleMessage(...args: Parameters<typeof composeSingleMessageResult>) {
  const composed = await composeSingleMessageResult(...args);
  if (composed.status === "error") throw composed.error;
  return composed.value;
}

function transcriptStoreFor(
  resolve: (
    input: Parameters<TranscriptStore["getTranscriptBySurfaceMessage"]>[0],
  ) => TranscriptSnapshot | null,
): TranscriptStore {
  return {
    saveRequestTranscript() {
      return Result.ok(undefined);
    },
    linkSurfaceMessagesToRequest() {},
    getTranscriptBySurfaceMessage(input) {
      return Result.ok(resolve(input));
    },
    close() {},
  };
}

class FakeAdapter extends SurfaceAdapterTestBase {
  constructor(
    private readonly message: SurfaceMessage,
    private readonly reactions: readonly string[] = [],
  ) {
    super();
  }

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }
  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }

  async getSelf(): Promise<SurfaceSelf> {
    throw new Error("not implemented");
  }
  async listSessions() {
    return Result.ok([]);
  }

  async startOutput(_sessionRef: SessionRef, _opts?: StartOutputOpts) {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () => {
        const ref = {
          platform: "discord" as const,
          channelId: "unused",
          messageId: "unused",
        };
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async () => Result.ok(undefined),
    });
  }

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts) {
    return Result.ok({
      platform: "discord",
      channelId: "unused",
      messageId: "unused",
    } as const);
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    return Result.ok(this.message);
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts) {
    return Result.ok(undefined);
  }

  async deleteMsg(_msgRef: MsgRef) {
    return Result.ok(undefined);
  }

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts) {
    return Result.ok([]);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    return Result.ok([...this.reactions]);
  }

  async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
    throw new Error("not implemented");
  }

  async getUnRead(_sessionRef: SessionRef) {
    return Result.ok([]);
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef) {
    return Result.ok(undefined);
  }
}

const originalFetch = globalThis.fetch;
function formatExpectedSurfaceMetadataLine(meta: Record<string, unknown>): string {
  return `<LILAC_META:v1>${JSON.stringify(meta)}</LILAC_META:v1>`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function controlledReservationBlobStore(): {
  store: BlobStore;
  uploads: Array<{
    upload: BlobUpload;
    complete: () => void;
  }>;
} {
  const uploads: Array<{ upload: BlobUpload; complete: () => void }> = [];
  let nextObject = 1;
  const store: BlobStore = {
    async startStagedUpload() {
      throw new Error("Staged uploads are not supported by this test store");
    },
    async adopt() {
      throw new Error("Blob adoption is not supported by this test store");
    },
    async startUpload() {
      const index = nextObject++;
      const objectId = `b1_${index.toString(16).padStart(32, "0")}`;
      let complete!: () => void;
      const completion = new Promise<ReturnType<typeof Result.ok<BlobRefV1>>>((resolve) => {
        complete = () =>
          resolve(
            Result.ok({
              version: 1,
              objectId,
              sha256: index.toString(16).padStart(64, "0"),
              byteLength: 4,
            }),
          );
      });
      const upload = {
        handle: { version: 1, objectId } satisfies BlobHandleV1,
        completion,
      };
      uploads.push({ upload, complete });
      return Result.ok(upload);
    },
    async resolve() {
      return Result.err(new Error("not used") as never);
    },
    async open() {
      return Result.err(new Error("not used") as never);
    },
    async delete() {
      return Result.ok("deleted" as const);
    },
    async maintain() {
      return Result.ok({ inspected: 0, deleted: 0, remaining: false });
    },
    async close() {
      return Result.ok({ completedUploads: 0, interruptedUploads: 0 });
    },
  };
  return { store, uploads };
}

const noOpAttachmentCache: DiscordAttachmentCacheAccess = {
  get: () => null,
  put: () => undefined,
  clear: () => null,
};

function createRecordingResourceRegistry() {
  const registrations: RegisterResourceInput[] = [];
  return {
    registrations,
    registry: {
      async register(input: RegisterResourceInput) {
        registrations.push(input);
        const descriptor: ResourceDescriptor = {
          uri: `resource://r1_${registrations.length.toString(16).padStart(32, "0")}`,
          ...(input.filename ? { filename: input.filename } : {}),
          ...(input.declaredMediaType ? { declaredMediaType: input.declaredMediaType } : {}),
          ...(input.reportedByteLength === undefined
            ? {}
            : { reportedByteLength: input.reportedByteLength }),
        };
        return Result.ok(descriptor);
      },
    },
  };
}

function createProjectionCapturingStore(admitted: AdmitCoreSurfaceProjection[]): TranscriptStore {
  return {
    saveRequestTranscript: () => Result.ok(undefined),
    linkSurfaceMessagesToRequest: () => undefined,
    getTranscriptBySurfaceMessage: () => Result.ok(null),
    putCoreOwnedBlob: () => {
      throw new Error("unexpected blob ownership write");
    },
    getCoreOwnedBlob: () => {
      throw new Error("unexpected blob ownership read");
    },
    deleteCoreOwnedBlobIfUnreferenced: () => null,
    admitCoreSurfaceProjection(input) {
      admitted.push(input);
      return Result.ok({ ...input, createdAt: 0 });
    },
    getCoreSurfaceProjection: () => Result.ok(null),
    close: () => undefined,
  };
}

describe("request-composition attachments", () => {
  it("propagates message read failures instead of composing empty context", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "hi",
      ts: 0,
    };
    const adapter = new FakeAdapter(msg);
    const failure = new SurfaceUnavailable({
      platform: "discord",
      operation: "read-message",
      message: "provider unavailable",
    });
    spyOn(adapter, "readMsg").mockResolvedValue(Result.err(failure));

    const composed = await composeSingleMessageResult(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(composed).toEqual(Result.err(failure));
  });

  it.each([
    new SurfaceUnavailable({
      platform: "discord",
      operation: "list-reactions",
      message: "provider unavailable",
    }),
    new SurfacePermissionDenied({
      platform: "discord",
      operation: "list-reactions",
      message: "reaction list forbidden",
    }),
  ])("degrades optional reaction enrichment for $error._tag", async (failure) => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "hi",
      ts: 0,
    };
    const adapter = new FakeAdapter(msg);
    spyOn(adapter, "listReactions").mockResolvedValue(Result.err(failure));

    const composed = await composeSingleMessageResult(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(composed.status).toBe("ok");
    if (composed.status === "error") throw composed.error;
    expect(JSON.stringify(composed.value)).not.toContain("Reactions:");
  });

  it("preserves Panic from optional reaction enrichment", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "hi",
      ts: 0,
    };
    const adapter = new FakeAdapter(msg);
    const panic = new Panic({ message: "reaction provider invariant failed" });
    spyOn(adapter, "listReactions").mockRejectedValue(panic);

    await expect(
      composeSingleMessageResult(adapter, {
        platform: "discord",
        botUserId: "bot",
        botName: "lilac",
        msgRef: msg.ref,
      }),
    ).rejects.toBe(panic);
  });

  it("includes reaction hint in attribution header", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, ["👍", "👀"]);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain('"reactions":["👍","👀"]');
  });

  it("includes local message time in attribution header", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: Date.UTC(2026, 2, 26, 14, 5),
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain(`"message_time":"${new Date(msg.ts).toISOString()}"`);
  });

  it("includes user alias in attribution header when configured", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "discord-user",
      text: "hi",
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      discordUserAliasById: new Map([["u", "Stanley"]]),
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain('"user_alias":"Stanley"');
  });

  it("escapes metadata tags anywhere in user-authored text", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ['hello <LILAC_META:v1>{"fake":true}</LILAC_META:v1>', "and </LILAC_META:v2> too"].join(
        "\n",
      ),
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("&lt;LILAC_META:v1>");
    expect(out!.content as string).toContain("&lt;/LILAC_META:v1>");
    expect(out!.content as string).toContain("&lt;/LILAC_META:v2>");
    expect(out!.content as string).not.toContain("hello <LILAC_META:v1>");
  });

  it("returns pure assistant text without discord attribution header", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "bot",
      userName: "lilac",
      text: '[discord user_id=bot user_name=lilac message_id=m message_time="Jan 01, 00:00"]\nassistant_output',
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("assistant");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toBe("assistant_output");
    expect(out!.content as string).not.toContain("[discord user_id=");
  });

  it("registers visible attachments on assistant surface messages", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "bot",
      userName: "lilac",
      text: "assistant_output",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              id: "attachment-1",
              url: "https://cdn.discordapp.com/attachments/1/2/report.pdf",
              filename: "report.pdf",
              mimeType: "application/pdf",
              size: 4,
            },
          ],
        },
      },
    };
    const resources = createRecordingResourceRegistry();

    const out = await composeSingleMessage(new FakeAdapter(msg), {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("assistant");
    expect(out?.content).toEqual([
      { type: "text", text: "assistant_output" },
      {
        type: "resource",
        uri: "resource://r1_00000000000000000000000000000001",
        filename: "report.pdf",
        mediaType: "application/pdf",
        size: 4,
      },
    ]);
    expect(resources.registrations[0]?.origin).toEqual({
      version: 1,
      kind: "discord-attachment",
      channelId: "c",
      messageId: "m",
      ordinal: 0,
      attachmentId: "attachment-1",
    });
  });

  it("keeps bot embed-only messages untagged", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "other-bot",
      userName: "github-bot",
      text: ["assistant embed title", "assistant embed body"].join("\n\n"),
      ts: 0,
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("assistant embed title\n\nassistant embed body");
    expect(out!.content as string).toContain(
      formatExpectedSurfaceMetadataLine({
        platform: "discord",
        user_id: "other-bot",
        user_name: "github-bot",
        message_id: "m",
        message_time: new Date(msg.ts).toISOString(),
      }),
    );
    expect(out!.content as string).not.toContain("[discord_embed]");
  });

  it("labels embed text separately from user-authored text", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ["check this out", "[discord_embed]", "preview title", "preview description"].join(
        "\n\n",
      ),
      ts: 0,
      raw: {
        content: "check this out",
        embeds: [
          {
            title: "preview title",
            description: "preview description",
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("check this out");
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("preview title");
    expect(content).toContain("preview description");
    expect(content.indexOf("check this out")).toBeLessThan(content.indexOf("[discord_embed]"));
  });

  it("uses stored tagged text directly", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "@alice shared this\n\n[discord_embed]\n\npreview title",
      ts: 0,
      raw: {
        content: "<@123> shared this",
        embeds: [{ title: "preview title" }],
      },
    };

    const adapter = new FakeAdapter(msg, []);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("@alice shared this");
    expect(content).not.toContain("<@123>");
    expect(content).toContain("[discord_embed]");
  });

  it("registers an unknown-size Discord attachment without fetching its bytes", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("hello", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    expect(Array.isArray(out?.content)).toBe(true);
    const content = out!.content as any[];

    expect(content.length).toBe(2);
    expect(content[1]).toEqual({
      type: "resource",
      uri: "resource://r1_00000000000000000000000000000001",
      filename: "file.txt",
    });
    expect(resources.registrations).toEqual([
      {
        origin: {
          version: 1,
          kind: "discord-attachment",
          channelId: "c",
          messageId: "m",
          ordinal: 0,
        },
        filename: "file.txt",
      },
    ]);
    expect(calls).toBe(0);
  });

  it("returns a closed registration failure when attachments have no registry", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
            },
          ],
        },
      },
    };

    const composed = await composeSingleMessageResult(new FakeAdapter(msg), {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(composed.status).toBe("error");
    if (composed.status === "error") {
      expect(composed.error).toBeInstanceOf(ResourceStoreFailure);
    }
  });

  it("persists resource identity without signed URLs or attachment IDs in source facts", async () => {
    const signedUrl = "https://cdn.discordapp.com/attachments/1/2/file.txt?sig=secret";
    const attachmentId = "discord-attachment-id";
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              id: attachmentId,
              url: signedUrl,
              filename: "file.txt",
              mimeType: "text/plain",
              size: 12,
            },
          ],
        },
      },
    };
    const admitted: AdmitCoreSurfaceProjection[] = [];
    const resources = createRecordingResourceRegistry();

    await composeSingleMessage(new FakeAdapter(msg), {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
      transcriptStore: createProjectionCapturingStore(admitted),
    });

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.canonicalMessages[0]?.content).toEqual([
      expect.objectContaining({ type: "text" }),
      {
        type: "resource",
        uri: "resource://r1_00000000000000000000000000000001",
        filename: "file.txt",
        mediaType: "text/plain",
        size: 12,
      },
    ]);
    const serializedFacts = JSON.stringify(admitted[0]?.sourceFacts);
    expect(admitted[0]?.sourceFacts).not.toHaveProperty("attachments");
    expect(serializedFacts).not.toContain(signedUrl);
    expect(serializedFacts).not.toContain(attachmentId);
  });

  it("keeps labeled embed text before attachment-derived parts", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("hello", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ["look", "[discord_embed]", "preview title"].join("\n\n"),
      ts: 0,
      raw: {
        content: "look",
        embeds: [{ title: "preview title" }],
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    expect(Array.isArray(out?.content)).toBe(true);

    const content = out!.content as Array<{ type: string; text?: string; filename?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("look");
    expect(content[0]?.text).toContain("[discord_embed]");
    expect(content[1]?.type).toBe("resource");
    expect(content[1]?.filename).toBe("file.txt");
    expect(calls).toBe(0);
  });

  it("emits PDF metadata as a structured resource part", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { "content-type": "application/pdf" },
      });
    }) as unknown as typeof fetch;

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.pdf",
              filename: "doc.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      blobStore: await getTestBlobStore(),
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("resource");
    expect(content[1].uri).toStartWith("resource://r1_");
    expect(content[1].mediaType).toBe("application/pdf");
    expect(content[1].filename).toBe("doc.pdf");
    expect(calls).toBe(0);
  });

  it("does not reserve request blobs for current Discord attachments", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]))) as unknown as typeof fetch;
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.pdf",
              filename: "doc.pdf",
              mimeType: "application/pdf",
              size: 4,
            },
          ],
        },
      },
    };
    const blobs = controlledReservationBlobStore();
    const resources = createRecordingResourceRegistry();
    const composition = composeSingleMessageResult(new FakeAdapter(msg), {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      blobStore: blobs.store,
      attachmentCache: noOpAttachmentCache,
      resourceRegistry: resources.registry,
    });

    const composed = await composition;
    expect(blobs.uploads).toHaveLength(0);
    expect(composed.status).toBe("ok");
    if (composed.status === "ok") {
      const content = composed.value?.content;
      expect(Array.isArray(content) ? content[1]?.type : null).toBe("resource");
      expect(composed.value && "inputHandles" in composed.value).toBe(false);
    }
  });

  it("keeps text/plain attachments resource-only", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("hello", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/file.txt",
              filename: "file.txt",
              mimeType: "text/plain",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("resource");
    expect(JSON.stringify(content)).not.toContain("hello");
    expect(calls).toBe(0);
  });

  it("keeps YAML attachments resource-only", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response("name: lilac\nmode: active\n", {
        headers: { "content-type": "application/x-yaml" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/config.yaml",
              filename: "config.yaml",
              mimeType: "application/x-yaml",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("resource");
    expect(JSON.stringify(content)).not.toContain("name: lilac");
    expect(calls).toBe(0);
  });

  it("keeps vendor JSON attachments resource-only", async () => {
    let calls = 0;
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"status":"ok"}', {
        headers: { "content-type": "application/vnd.api+json" },
      });
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.api.json",
              filename: "doc.api.json",
              mimeType: "application/vnd.api+json",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("resource");
    expect(JSON.stringify(content)).not.toContain('{"status":"ok"}');
    expect(calls).toBe(0);
  });

  it("keeps signed URLs out of binary resource parts", async () => {
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      throw new Error("should not fetch");
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/doc.rtf",
              filename: "doc.rtf",
              mimeType: "application/rtf",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    const content = out!.content as any[];
    expect(content[1].type).toBe("resource");
    expect(content[1].filename).toBe("doc.rtf");
    expect(JSON.stringify(content)).not.toContain("cdn.discordapp.com");
  });

  it("does not download attachment bytes during composition", async () => {
    // @ts-expect-error stub fetch
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "hi",
      ts: 0,
      raw: {
        discord: {
          attachments: [
            {
              url: "https://cdn.discordapp.com/attachments/1/2/note.txt",
              filename: "note.txt",
            },
          ],
        },
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessageResult(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      blobStore: await getTestBlobStore(),
      resourceRegistry: resources.registry,
    });

    expect(out.status).toBe("ok");
    const content = out.match({ ok: (value) => value?.content, err: () => null });
    expect(Array.isArray(content) ? content[1]?.type : null).toBe("resource");
  });

  it("uses forward snapshot content and visible attachments only", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof fetch;
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "Forwarded snapshot text",
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/orig/1/IMG_1.png",
            filename: "IMG_1.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/2/IMG_2.png",
            filename: "IMG_2.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/3/IMG_3.png",
            filename: "IMG_3.png",
            mimeType: "image/jpeg",
            size: 10,
          },
        ],
        messageSnapshots: [
          {
            message: {
              content: "Forwarded snapshot text",
              attachments: [
                {
                  id: "visible-id",
                  url: "https://cdn.discordapp.com/attachments/fwd/1/IMG_VISIBLE.png",
                  filename: "IMG_VISIBLE.png",
                  mimeType: "image/jpeg",
                  size: 10,
                },
              ],
            },
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      blobStore: await getTestBlobStore(),
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    expect(Array.isArray(out?.content)).toBe(true);

    const parts = out!.content as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Forwarded snapshot text");

    const resourceParts = parts.filter((part) => part?.type === "resource");
    expect(resourceParts).toHaveLength(1);
    expect(resourceParts[0].filename).toBe("IMG_VISIBLE.png");
    expect(resources.registrations).toEqual([
      {
        origin: {
          version: 1,
          kind: "discord-attachment",
          channelId: "c",
          messageId: "m",
          ordinal: 0,
          attachmentId: "visible-id",
        },
        filename: "IMG_VISIBLE.png",
        declaredMediaType: "image/jpeg",
        reportedByteLength: 10,
      },
    ]);
  });

  it("falls back to top-level attachments when forward snapshot attachments are empty", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "Forwarded snapshot text",
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/orig/1/IMG_TOP.png",
            filename: "IMG_TOP.png",
            mimeType: "image/png",
            size: 10,
          },
        ],
        messageSnapshots: [
          {
            message: {
              content: "Forwarded snapshot text",
              attachments: [],
            },
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg);
    const resources = createRecordingResourceRegistry();
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
      blobStore: await getTestBlobStore(),
      resourceRegistry: resources.registry,
    });

    expect(out?.role).toBe("user");
    expect(Array.isArray(out?.content)).toBe(true);

    const parts = out!.content as any[];
    const resourceParts = parts.filter((part) => part?.type === "resource");
    expect(resourceParts).toHaveLength(1);
    expect(resourceParts[0].filename).toBe("IMG_TOP.png");
    expect(resources.registrations[0]?.origin).toEqual({
      version: 1,
      kind: "discord-attachment",
      channelId: "c",
      messageId: "m",
      ordinal: 0,
    });
  });

  it("uses forward snapshot embed string description when content is empty", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: ["[discord_embed]", "forwarded embed text"].join("\n\n"),
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "",
              embeds: ["forwarded embed text"],
              attachments: [],
            },
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");
    expect(out!.content as string).toContain("[discord_embed]");
    expect(out!.content as string).toContain("forwarded embed text");
  });

  it("uses forward snapshot embed title/description/image when content is empty", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: [
        "[discord_embed]",
        "forwarded title",
        "forwarded description",
        "https://example.com/snapshot-image.png",
      ].join("\n\n"),
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "",
              embeds: [
                {
                  title: "forwarded title",
                  description: "forwarded description",
                  fields: [{ name: "internal", value: "skip-for-inbound" }],
                  image: { url: "https://example.com/snapshot-image.png" },
                  footer: { text: "skip-footer-for-inbound" },
                },
              ],
              attachments: [],
            },
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("forwarded title");
    expect(content).toContain("forwarded description");
    expect(content).toContain("https://example.com/snapshot-image.png");
    expect(content).not.toContain("skip-for-inbound");
    expect(content).not.toContain("skip-footer-for-inbound");
  });

  it("uses stored tagged forwarded snapshot text directly", async () => {
    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "m" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      userName: "user",
      text: "@alice forwarded this\n\n[discord_embed]\n\nforwarded title",
      ts: 0,
      raw: {
        reference: {
          type: 1,
          messageId: "orig",
          channelId: "other",
        },
        messageSnapshots: [
          {
            message: {
              content: "<@123> forwarded this",
              embeds: [{ title: "forwarded title" }],
              attachments: [],
            },
          },
        ],
      },
    };

    const adapter = new FakeAdapter(msg);
    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out?.role).toBe("user");
    expect(typeof out?.content).toBe("string");

    const content = out!.content as string;
    expect(content).toContain("@alice forwarded this");
    expect(content).not.toContain("<@123>");
    expect(content).toContain("[discord_embed]");
  });
});

describe("request-composition mention thread context", () => {
  class MultiFakeAdapter extends SurfaceAdapterTestBase {
    constructor(private readonly messages: Record<string, SurfaceMessage>) {
      super();
    }

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<SurfaceOperationResult<MsgRef>> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
      const key = `${msgRef.channelId}:${msgRef.messageId}`;
      return Result.ok(this.messages[key] ?? null);
    }

    async listMsg(
      _sessionRef: SessionRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      throw new Error("not implemented");
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      msgRef: MsgRef,
      opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      const key = `${msgRef.channelId}:${msgRef.messageId}`;
      const base = this.messages[key];
      if (!base) return Result.ok([]);

      const limit = opts?.limit ?? 20;
      const half = Math.max(1, Math.floor(limit / 2));

      const all = Object.values(this.messages)
        .filter((m) => m.session.channelId === msgRef.channelId)
        .slice()
        .sort((a, b) => a.ts - b.ts);

      const beforeAll = all.filter((m) => m.ts <= base.ts);
      const before = beforeAll.slice(Math.max(0, beforeAll.length - half));

      const after = all.filter((m) => m.ts > base.ts).slice(0, half);
      return Result.ok(before.concat(after));
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async removeReaction(
      _msgRef: MsgRef,
      _reaction: string,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
      return Result.ok([]);
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      throw new Error("not implemented");
    }

    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
  }

  it("includes replied-to root and merges the user burst ending in a mention", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 0,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 1000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 1100,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: 1200,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:m1`]: m1,
      [`${sessionId}:m2`]: m2,
      [`${sessionId}:m3`]: m3,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m3.ref },
    });

    expect(out.chainMessageIds).toEqual(["root", "m1", "m2", "m3"]);
    expect(out.mergedGroups.length).toBe(3);
    expect(out.mergedGroups[0]?.messageIds).toEqual(["root"]);
    expect(out.mergedGroups[1]?.messageIds).toEqual(["m1", "m2"]);
    expect(out.mergedGroups[2]?.messageIds).toEqual(["m3"]);

    expect(out.messages.length).toBe(3);

    const merged = out.messages[1]?.content;
    const current = out.messages[2]?.content;
    expect(typeof merged).toBe("string");
    expect(typeof current).toBe("string");
    expect(merged as string).toContain("user msg 1");
    expect(merged as string).toContain("user msg 2");
    expect(current as string).toContain("user msg 3");
    expect(current as string).toContain("<@bot>");
  });

  it("walks mention context via merged-group heads", async () => {
    const sessionId = "c";

    const b0: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b0" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "user B - 0",
      ts: 0,
      raw: { reference: {} },
    };

    const a1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "user A - 1",
      ts: 120_000,
      raw: { reference: { messageId: "b0", channelId: sessionId } },
    };

    const a2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "user A - 2",
      ts: 122_000,
      raw: { reference: {} },
    };

    const b1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "user B - 1",
      ts: 240_000,
      raw: { reference: { messageId: "a2", channelId: sessionId } },
    };

    const b2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "<@bot> user B - 2",
      ts: 300_000,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:b0`]: b0,
      [`${sessionId}:a1`]: a1,
      [`${sessionId}:a2`]: a2,
      [`${sessionId}:b1`]: b1,
      [`${sessionId}:b2`]: b2,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: b2.ref },
    });

    expect(out.chainMessageIds).toEqual(["b0", "a1", "a2", "b1", "b2"]);
    expect(out.mergedGroups).toEqual([
      { authorId: "uB", messageIds: ["b0"] },
      { authorId: "uA", messageIds: ["a1", "a2"] },
      { authorId: "uB", messageIds: ["b1"] },
      { authorId: "uB", messageIds: ["b2"] },
    ]);

    expect(out.messages.length).toBe(4);
  });

  it("treats maxDepth as merged-group count when walking reply chains", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 0,
      raw: { reference: {} },
    };

    const a1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "A1",
      ts: 1_000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const a2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "a2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uA",
      userName: "userA",
      text: "A2",
      ts: 1_100,
      raw: { reference: {} },
    };

    const b1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "B1",
      ts: 2_000,
      raw: { reference: { messageId: "a2", channelId: sessionId } },
    };

    const b2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "uB",
      userName: "userB",
      text: "B2",
      ts: 2_100,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:a1`]: a1,
      [`${sessionId}:a2`]: a2,
      [`${sessionId}:b1`]: b1,
      [`${sessionId}:b2`]: b2,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: b2.ref },
      maxDepth: 2,
    });

    expect(out.chainMessageIds).toEqual(["a1", "a2", "b1", "b2"]);
    expect(out.mergedGroups).toEqual([
      { authorId: "uA", messageIds: ["a1", "a2"] },
      { authorId: "uB", messageIds: ["b1"] },
      { authorId: "uB", messageIds: ["b2"] },
    ]);
  });

  it("uses only the trigger group for mention-time context", async () => {
    const sessionId = "c";
    const minuteMs = 60_000;

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "A",
      ts: 47 * minuteMs,
      raw: { reference: {} },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "B",
      ts: 50 * minuteMs,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> C",
      ts: 55 * minuteMs,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:m1`]: m1,
      [`${sessionId}:m2`]: m2,
      [`${sessionId}:m3`]: m3,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m3.ref },
    });

    expect(out.chainMessageIds).toEqual(["m3"]);
    expect(out.mergedGroups).toEqual([{ authorId: "u1", messageIds: ["m3"] }]);

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    const [, body = ""] = String(out.messages[0]!.content).split("\n", 2);
    expect(body).toContain("C");
    expect(body).not.toContain("A");
    expect(body).not.toContain("B");
  });

  it("keeps embed previews labeled in composed request messages", async () => {
    const sessionId = "c";

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: ["<@bot> check this", "[discord_embed]", "preview title", "preview description"].join(
        "\n\n",
      ),
      ts: 0,
      raw: {
        content: "<@bot> check this",
        embeds: [
          {
            title: "preview title",
            description: "preview description",
          },
        ],
        reference: {},
      },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:m1`]: m1,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m1.ref },
    });

    expect(out.messages).toHaveLength(1);
    expect(typeof out.messages[0]?.content).toBe("string");

    const content = out.messages[0]!.content as string;
    expect(content).toContain("check this");
    expect(content).toContain("[discord_embed]");
    expect(content).toContain("preview title");
    expect(content).toContain("preview description");
  });

  it("does not anchor mention context to an older reply outside trigger group", async () => {
    const sessionId = "c";
    const minuteMs = 60_000;

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 0,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "old reply",
      ts: 47 * minuteMs,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "follow-up",
      ts: 50 * minuteMs,
      raw: { reference: {} },
    };

    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> new ask",
      ts: 55 * minuteMs,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:m1`]: m1,
      [`${sessionId}:m2`]: m2,
      [`${sessionId}:m3`]: m3,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: m3.ref },
    });

    expect(out.chainMessageIds).toEqual(["m3"]);
    expect(out.mergedGroups).toEqual([{ authorId: "u1", messageIds: ["m3"] }]);

    expect(out.messages.length).toBe(1);
    const merged = out.messages[0]?.content;
    expect(typeof merged).toBe("string");
    expect(merged as string).toContain("new ask");
    expect(merged as string).not.toContain("old reply");
    expect(merged as string).not.toContain("Root");
  });

  it("treats forwarded references as root and uses forwarded snapshot payload", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof fetch;
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root should not be expanded",
      ts: 0,
      raw: { reference: {} },
    };

    const forwardMention: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "fwd1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "",
      ts: 1_000,
      raw: {
        reference: {
          type: 1,
          messageId: "root",
          channelId: sessionId,
        },
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/orig/1/IMG_1.png",
            filename: "IMG_1.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/2/IMG_2.png",
            filename: "IMG_2.png",
            mimeType: "image/jpeg",
            size: 10,
          },
          {
            url: "https://cdn.discordapp.com/attachments/orig/3/IMG_3.png",
            filename: "IMG_3.png",
            mimeType: "image/jpeg",
            size: 10,
          },
        ],
        messageSnapshots: [
          {
            message: {
              content: "Forwarded snapshot text",
              attachments: [
                {
                  url: "https://cdn.discordapp.com/attachments/fwd/1/IMG_VISIBLE.png",
                  filename: "IMG_VISIBLE.png",
                  mimeType: "image/jpeg",
                  size: 10,
                },
              ],
            },
          },
        ],
      },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:fwd1`]: forwardMention,
    });
    const resources = createRecordingResourceRegistry();

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "mention", msgRef: forwardMention.ref },
      blobStore: await getTestBlobStore(),
      resourceRegistry: resources.registry,
    });

    expect(out.chainMessageIds).toEqual(["fwd1"]);
    expect(out.messages.length).toBe(1);

    const content = out.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);

    const parts = content as any[];
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("Forwarded snapshot text");

    const resourceParts = parts.filter((part) => part?.type === "resource");
    expect(resourceParts).toHaveLength(1);
    expect(resourceParts[0].filename).toBe("IMG_VISIBLE.png");
    expect(resources.registrations[0]?.origin).toEqual({
      version: 1,
      kind: "discord-attachment",
      channelId: "c",
      messageId: "fwd1",
      ordinal: 0,
    });
  });

  it("includes user alias in mention-thread attribution header when configured", async () => {
    const sessionId = "c";

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "discord-user",
      text: "<@bot> hi",
      ts: 1000,
      raw: { reference: {} },
    };

    const adapter = new MultiFakeAdapter({
      [`${sessionId}:m1`]: m1,
    });

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      discordUserAliasById: new Map([["u1", "Stanley"]]),
      trigger: { type: "mention", msgRef: m1.ref },
    });

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain('"user_alias":"Stanley"');
  });
});

describe("request-composition active channel burst rules", () => {
  class ListFakeAdapter extends SurfaceAdapterTestBase {
    readonly listMsgCalls: Array<{ limit: number; beforeMessageId?: string }> = [];

    constructor(private readonly messages: SurfaceMessage[]) {
      super();
    }

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<SurfaceOperationResult<MsgRef>> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
      const m = this.messages.find(
        (x) => x.session.channelId === msgRef.channelId && x.ref.messageId === msgRef.messageId,
      );
      return Result.ok(m ?? null);
    }

    async listMsg(
      sessionRef: SessionRef,
      opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      const limit = Math.max(1, opts?.limit ?? 50);
      this.listMsgCalls.push({ limit, beforeMessageId: opts?.beforeMessageId });
      const before = opts?.beforeMessageId;
      const beforeMessage = before
        ? this.messages.find(
            (m) => m.session.channelId === sessionRef.channelId && m.ref.messageId === before,
          )
        : null;
      const inChannel = this.messages.filter((m) => {
        if (m.session.channelId !== sessionRef.channelId) return false;
        if (!beforeMessage) return true;
        if (m.ts < beforeMessage.ts) return true;
        if (m.ts > beforeMessage.ts) return false;
        return m.ref.messageId < beforeMessage.ref.messageId;
      });
      // Return a recent-ish slice (ordering doesn't matter; composeRecentChannelMessages sorts).
      return Result.ok(inChannel.slice(Math.max(0, inChannel.length - limit)));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      return Result.ok([]);
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async removeReaction(
      _msgRef: MsgRef,
      _reaction: string,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
      return Result.ok([]);
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      throw new Error("not implemented");
    }

    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
  }

  function makeSequentialActiveMessages(input: {
    sessionId: string;
    count: number;
    latestText?: string;
    gapAfterId?: number;
  }): SurfaceMessage[] {
    const anchorTs = 10_000_000;

    return Array.from({ length: input.count }, (_, index) => {
      const id = index + 1;
      const ts =
        input.gapAfterId && id <= input.gapAfterId
          ? anchorTs - 3 * 60 * 60 * 1000 - (input.gapAfterId - id) * 1_000
          : anchorTs - (input.count - id) * 1_000;

      return {
        ref: {
          platform: "discord",
          channelId: input.sessionId,
          messageId: String(id),
        },
        session: { platform: "discord", channelId: input.sessionId },
        userId: id % 3 === 0 ? "bot" : "u",
        userName: id % 3 === 0 ? "lilac" : "user",
        text: id === input.count ? (input.latestText ?? `msg_${id}`) : `msg_${id}`,
        ts,
        raw: { reference: {} },
      } satisfies SurfaceMessage;
    });
  }

  it("stops active history fetch at the first 16-message rung when prompt limit is filled", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 40 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "40",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["33", "34", "35", "36", "37", "38", "39", "40"]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "40" }]);
  });

  it("stops active history fetch at the first 16-message rung when a gap cutoff is already visible", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 40,
      gapAfterId: 24,
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "40",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual([
      "25",
      "26",
      "27",
      "28",
      "29",
      "30",
      "31",
      "32",
      "33",
      "34",
      "35",
      "36",
      "37",
      "38",
      "39",
      "40",
    ]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "40" }]);
  });

  it("ramps active history fetch from 16 to 48 when more live context is needed", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 80 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 40,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "80",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 40 }, (_, index) => String(index + 41)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "80" },
      { limit: 32, beforeMessageId: "64" },
    ]);
  });

  it("ramps active history fetch from 16 to 48 to 112 when needed", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({ sessionId, count: 160 });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 100,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "160",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index + 61)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "160" },
      { limit: 32, beforeMessageId: "144" },
      { limit: 64, beforeMessageId: "112" },
    ]);
  });

  it("ramps active history fetch to the 200-message cap for large continue expansions", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 220,
      latestText: "!cont=200 current request",
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "220",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 201 }, (_, index) => String(index + 20)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "220" },
      { limit: 32, beforeMessageId: "204" },
      { limit: 64, beforeMessageId: "172" },
      { limit: 88, beforeMessageId: "108" },
    ]);
  });

  it("stops at the first rung when a visible continue is already fully satisfied", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 80,
      latestText: "!cont=2 current request",
    });
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 40,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "80",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["78", "79", "80"]);
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "80" }]);
  });

  it("ramps active history fetch to the cap for recursive continue expansions", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 220,
      latestText: "!cont=2 current request",
    });
    msgs[217] = {
      ...msgs[217]!,
      text: "!cont=200 earlier reopen",
    };
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "220",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 201 }, (_, index) => String(index + 20)),
    );
    expect(adapter.listMsgCalls).toEqual([
      { limit: 16, beforeMessageId: "220" },
      { limit: 32, beforeMessageId: "204" },
      { limit: 64, beforeMessageId: "172" },
      { limit: 88, beforeMessageId: "108" },
    ]);
  });

  it("stops at the first rung when a divider already bounds a large continue", async () => {
    const sessionId = "c";
    const msgs = makeSequentialActiveMessages({
      sessionId,
      count: 220,
      latestText: "!cont=200 current request",
    });
    msgs[209] = {
      ...msgs[209]!,
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
    };
    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "220",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 211)),
    );
    expect(adapter.listMsgCalls).toEqual([{ limit: 16, beforeMessageId: "220" }]);
  });

  it("stops at >3h age cutoff (active mode, non-trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `msg_${id}`,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("7", anchorTs - (3 * 60 * 60 * 1000 + 1)), // too old
      mk("8", anchorTs - 90 * 60 * 1000),
      mk("9", anchorTs - 30 * 60 * 1000),
      mk("10", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["8", "9", "10"]);
  });

  it("includes user alias in recent-channel attribution header when configured", async () => {
    const sessionId = "c";

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "discord-user",
      text: "hello",
      ts: 1000,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([msg]);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      discordUserAliasById: new Map([["u1", "Stanley"]]),
    });

    expect(out.messages.length).toBe(1);
    expect(typeof out.messages[0]?.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain('"user_alias":"Stanley"');
  });

  it("uses pure assistant surface text without discord attribution header", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const bot: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: `${formatExpectedSurfaceMetadataLine({
        platform: "discord",
        user_id: "bot",
        user_name: "lilac",
        message_id: "b1",
        message_time: new Date(anchorTs - 1_000).toISOString(),
      })}\nassistant_surface`,
      ts: anchorTs - 1_000,
      raw: { reference: {} },
    };

    const user: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "u1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "latest",
      ts: anchorTs,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([bot, user]);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: user.ref,
      triggerType: undefined,
    });

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(typeof assistant!.content).toBe("string");
    expect(assistant!.content as string).toBe("assistant_surface");
    expect(assistant!.content as string).not.toContain("[discord user_id=");
    expect(assistant!.content as string).not.toContain("<LILAC_META:v1>");
  });

  it("strips echoed surface metadata headers from merged assistant chunks", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const bot1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: `${formatExpectedSurfaceMetadataLine({
        platform: "discord",
        user_id: "bot",
        user_name: "lilac",
        message_id: "b1",
        message_time: new Date(anchorTs - 2_000).toISOString(),
      })}\nassistant_one`,
      ts: anchorTs - 2_000,
      raw: { reference: {} },
    };

    const bot2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "b2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: `${formatExpectedSurfaceMetadataLine({
        platform: "discord",
        user_id: "bot",
        user_name: "lilac",
        message_id: "b2",
        message_time: new Date(anchorTs - 1_000).toISOString(),
      })}\nassistant_two`,
      ts: anchorTs - 1_000,
      raw: { reference: {} },
    };

    const user: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "u1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "latest",
      ts: anchorTs,
      raw: { reference: {} },
    };

    const adapter = new ListFakeAdapter([bot1, bot2, user]);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: user.ref,
      triggerType: undefined,
    });

    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(typeof assistant!.content).toBe("string");
    expect(assistant!.content as string).toContain("assistant_one");
    expect(assistant!.content as string).toContain("assistant_two");
    expect(assistant!.content as string).not.toContain("[discord user_id=");
    expect(assistant!.content as string).not.toContain("<LILAC_META:v1>");
  });

  it("stops at >3h age cutoff (active mode, mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("7", anchorTs - (3 * 60 * 60 * 1000 + 1), "too_old"),
      mk("8", anchorTs - 90 * 60 * 1000, "ok_8"),
      mk("9", anchorTs - 30 * 60 * 1000, "ok_9"),
      mk("10", anchorTs, "<@bot> ok_10"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["8", "9", "10"]);
  });

  it("stops at >2h silence gap cutoff (active mode, non-trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `msg_${id}`,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("8", anchorTs - 3 * 60 * 60 * 1000), // age ok, but gap too large
      mk("9", anchorTs - 30 * 60 * 1000),
      mk("10", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["9", "10"]);
  });

  it("stops at >2h silence gap cutoff (active mode, mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("8", anchorTs - 3 * 60 * 60 * 1000, "gap_too_large"),
      mk("9", anchorTs - 30 * 60 * 1000, "ok_9"),
      mk("10", anchorTs, "<@bot> ok_10"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["9", "10"]);
  });

  it("keeps the normal active window at exactly the requested limit without !cont", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `msg_${id}`,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("1", anchorTs - 3_000),
      mk("2", anchorTs - 2_000),
      mk("3", anchorTs - 1_000),
      mk("4", anchorTs),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 2,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "4",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["3", "4"]);
  });

  it("expands active context when current message uses bare !continue", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mk = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: id === "3" ? "bot" : "u",
      userName: id === "3" ? "lilac" : "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mk("1", anchorTs - 4 * 60 * 60 * 1000, "old_1"),
      mk("2", anchorTs - (3 * 60 * 60 * 1000 + 1), "old_2"),
      mk("3", anchorTs - 2 * 60 * 60 * 1000, "bot_old"),
      mk("4", anchorTs - 30 * 60 * 1000, "recent_4"),
      mk("5", anchorTs, "!continue current request"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "5",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3", "4", "5"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).not.toContain("!cont=");
    expect(combined).toContain("current request");
  });

  it("keeps visible !cont directives sticky and expands them recursively for later plain active messages", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, userId = "u", userName = "user") =>
      ({
        ref: { platform: "discord", channelId: sessionId, messageId: id },
        session: { platform: "discord", channelId: sessionId },
        userId,
        userName,
        text,
        ts,
        raw: { reference: {} },
      }) satisfies SurfaceMessage;

    const msgs = [
      mk("1", 1, "start"),
      mk("2", 2, "assistant one", "bot", "lilac"),
      mk("3", 3, "!cont=2 reopen deeper"),
      mk("4", 4, "assistant two", "bot", "lilac"),
      mk("5", 5, "!cont=2 reopen"),
      mk("6", 6, "assistant three", "bot", "lilac"),
      mk("7", 7, "plain follow-up"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 3,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "7",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("ignores sticky !cont on reply-thread messages while still stripping it", async () => {
    const sessionId = "c";

    const mk = (
      id: string,
      ts: number,
      text: string,
      raw: SurfaceMessage["raw"] = { reference: {} },
      userId = "u",
      userName = "user",
    ) =>
      ({
        ref: { platform: "discord", channelId: sessionId, messageId: id },
        session: { platform: "discord", channelId: sessionId },
        userId,
        userName,
        text,
        ts,
        raw,
      }) satisfies SurfaceMessage;

    const msgs = [
      mk("1", 1, "before"),
      mk("2", 2, "!cont=2 reopen", {
        reference: { messageId: "1", channelId: sessionId },
      }),
      mk("3", 3, "assistant", { reference: {} }, "bot", "lilac"),
      mk("4", 4, "plain follow-up"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 3,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "4",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["2", "3", "4"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("reopen");
    expect(combined).not.toContain("!cont=");
  });

  it("expands all visible !cont directives when multiple directives are present", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, userId = "u", userName = "user") =>
      ({
        ref: { platform: "discord", channelId: sessionId, messageId: id },
        session: { platform: "discord", channelId: sessionId },
        userId,
        userName,
        text,
        ts,
        raw: { reference: {} },
      }) satisfies SurfaceMessage;

    const msgs = [
      mk("1", 1, "!cont=5 wide"),
      mk("2", 2, "assistant one", "bot", "lilac"),
      mk("3", 3, "middle user"),
      mk("4", 4, "assistant two", "bot", "lilac"),
      mk("5", 5, "!cont=2 narrow"),
      mk("6", 6, "current"),
    ];

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "6",
      },
      triggerType: undefined,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("uses assistant-only transcript fallback for bot messages older than 1h", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mkUser = (id: string, ts: number): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: `user_${id}`,
      ts,
      raw: { reference: {} },
    });

    const mkBot = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mkBot("8", anchorTs - 2 * 60 * 60 * 1000, "old bot text"),
      mkBot("9", anchorTs - 30 * 60 * 1000, "recent bot text"),
      mkUser("10", anchorTs),
    ];

    const lookupCounts = new Map<string, number>();
    const transcriptStore = transcriptStoreFor((input) => {
      lookupCounts.set(input.messageId, (lookupCounts.get(input.messageId) ?? 0) + 1);
      const expanded = (content: string): StoredMessageV1[] => [{ role: "assistant", content }];
      if (input.messageId === "8") {
        return {
          requestId: "r8",
          sessionId,
          requestClient: "discord",
          createdTs: 0,
          updatedTs: 0,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-old",
                  toolName: "bash",
                  input: { command: "pwd" },
                },
                {
                  type: "text",
                  text: '[discord user_id=bot user_name=lilac message_id=old message_time="Jan 01, 00:00"]\nFALLBACK_OLD',
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-old",
                  toolName: "bash",
                  output: { type: "text", value: "/tmp" },
                },
              ],
            },
          ],
        };
      }
      if (input.messageId === "9") {
        return {
          requestId: "r9",
          sessionId,
          requestClient: "discord",
          createdTs: 0,
          updatedTs: 0,
          messages: expanded("EXPANDED_RECENT"),
        };
      }
      return null;
    });

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: undefined,
    });

    const text = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const assistantText = out.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).toContain("FALLBACK_OLD");
    expect(text).not.toContain("old bot text");
    expect(assistantText).not.toContain("tool-call");
    expect(assistantText).not.toContain("[discord user_id=");
    expect(lookupCounts).toEqual(
      new Map([
        ["8", 1],
        ["9", 1],
      ]),
    );
  });

  it("applies an old reachable checkpoint before transcript-age fallback", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;
    const messages: SurfaceMessage[] = [
      {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: "old-user",
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "RAW_ANCESTOR",
        ts: anchorTs - 2.5 * 60 * 60 * 1000,
        raw: { reference: {} },
      },
      {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: "checkpoint",
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "RAW_CHECKPOINT_OUTPUT",
        ts: anchorTs - 2 * 60 * 60 * 1000,
        raw: { reference: {} },
      },
      {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: "descendant",
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "EXACT_DESCENDANT",
        ts: anchorTs - 60 * 60 * 1000,
        raw: { reference: {} },
      },
      {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: "trigger",
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "CURRENT_REQUEST",
        ts: anchorTs,
        raw: { reference: {} },
      },
    ];
    const transcriptStore = transcriptStoreFor((input) => {
      if (input.messageId !== "checkpoint") return null;
      return {
        requestId: "checkpoint-request",
        sessionId,
        requestClient: "discord",
        createdTs: 0,
        updatedTs: 0,
        messages: [{ role: "user", content: "PERSISTED_CHECKPOINT" }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      };
    });

    const out = await composeRecentChannelMessages(new ListFakeAdapter(messages), {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 8,
      transcriptStore,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "trigger",
      },
    });
    const text = JSON.stringify(out.messages);
    expect(text).toContain("PERSISTED_CHECKPOINT");
    expect(text).toContain("EXACT_DESCENDANT");
    expect(text).toContain("CURRENT_REQUEST");
    expect(text).not.toContain("RAW_ANCESTOR");
    expect(text).not.toContain("RAW_CHECKPOINT_OUTPUT");
    expect(text).not.toContain("formatVersion");
  });

  it("uses assistant-only transcript fallback for bot messages older than 1h (mention trigger)", async () => {
    const sessionId = "c";
    const anchorTs = 10_000_000;

    const mkUser = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { reference: {} },
    });

    const mkBot = (id: string, ts: number, text: string): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text,
      ts,
      raw: { reference: {} },
    });

    const msgs = [
      mkBot("8", anchorTs - 2 * 60 * 60 * 1000, "old bot text"),
      mkBot("9", anchorTs - 30 * 60 * 1000, "recent bot text"),
      mkUser("10", anchorTs, "<@bot> trigger"),
    ];

    const transcriptStore = transcriptStoreFor((input) => {
      const expanded = (content: string): StoredMessageV1[] => [{ role: "assistant", content }];
      if (input.messageId === "8") {
        return {
          requestId: "r8",
          sessionId,
          requestClient: "discord",
          createdTs: 0,
          updatedTs: 0,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-old",
                  toolName: "bash",
                  input: { command: "pwd" },
                },
                {
                  type: "text",
                  text: '[discord user_id=bot user_name=lilac message_id=old message_time="Jan 01, 00:00"]\nFALLBACK_OLD',
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-old",
                  toolName: "bash",
                  output: { type: "text", value: "/tmp" },
                },
              ],
            },
          ],
        };
      }
      if (input.messageId === "9") {
        return {
          requestId: "r9",
          sessionId,
          requestClient: "discord",
          createdTs: 0,
          updatedTs: 0,
          messages: expanded("EXPANDED_RECENT"),
        };
      }
      return null;
    });

    const adapter = new ListFakeAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: {
        platform: "discord",
        channelId: sessionId,
        messageId: "10",
      },
      triggerType: "mention",
    });

    const text = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const assistantText = out.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n");

    expect(text).toContain("EXPANDED_RECENT");
    expect(text).toContain("FALLBACK_OLD");
    expect(text).not.toContain("old bot text");
    expect(assistantText).not.toContain("tool-call");
    expect(assistantText).not.toContain("[discord user_id=");
  });

  it("treats mention that is a reply as an explicit reply chain", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "old bot text",
      ts: 0,
      raw: { reference: {} },
    };

    const replyMention: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "<@bot> continuing",
      // Make it "too old" for active-burst cutoffs if they applied.
      ts: 10_000_000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    class ReplyChainAdapter extends SurfaceAdapterTestBase {
      constructor(private readonly messages: Record<string, SurfaceMessage>) {
        super();
      }

      async connect(): Promise<void> {
        throw new Error("not implemented");
      }
      async disconnect(): Promise<void> {
        throw new Error("not implemented");
      }

      async getSelf(): Promise<SurfaceSelf> {
        throw new Error("not implemented");
      }
      async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
        throw new Error("not implemented");
      }

      async startOutput(
        _sessionRef: SessionRef,
        _opts?: StartOutputOpts,
      ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
        throw new Error("not implemented");
      }

      async sendMsg(
        _sessionRef: SessionRef,
        _content: ContentOpts,
        _opts?: SendOpts,
      ): Promise<SurfaceOperationResult<MsgRef>> {
        throw new Error("not implemented");
      }

      async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
        const key = `${msgRef.channelId}:${msgRef.messageId}`;
        return Result.ok(this.messages[key] ?? null);
      }

      async listMsg(
        _sessionRef: SessionRef,
        _opts?: LimitOpts,
      ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
        return Result.ok([]);
      }

      async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
        throw new Error("not implemented");
      }

      async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
        throw new Error("not implemented");
      }

      async getReplyContext(
        _msgRef: MsgRef,
        _opts?: LimitOpts,
      ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
        return Result.ok([]);
      }

      async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
        throw new Error("not implemented");
      }

      async removeReaction(
        _msgRef: MsgRef,
        _reaction: string,
      ): Promise<SurfaceOperationResult<void>> {
        throw new Error("not implemented");
      }

      async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
        return Result.ok([]);
      }

      async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
        throw new Error("not implemented");
      }

      async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
        throw new Error("not implemented");
      }

      async markRead(
        _sessionRef: SessionRef,
        _upToMsgRef?: MsgRef,
      ): Promise<SurfaceOperationResult<void>> {
        throw new Error("not implemented");
      }
    }

    const transcriptStore = transcriptStoreFor((input) => {
      if (input.messageId !== "root") return null;
      return {
        requestId: "rroot",
        sessionId,
        requestClient: "discord",
        createdTs: 0,
        updatedTs: 0,
        messages: [{ role: "assistant", content: "EXPANDED_ROOT" }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      };
    });

    const adapter = new ReplyChainAdapter({
      [`${sessionId}:root`]: root,
      [`${sessionId}:m1`]: replyMention,
    });

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
      transcriptStore,
      triggerMsgRef: replyMention.ref,
      triggerType: "mention",
    });

    expect(out.chainMessageIds).toEqual(["root", "m1"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("EXPANDED_ROOT");
    expect(combined).not.toContain("old bot text");

    const explicit = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      transcriptStore,
      trigger: { type: "reply", msgRef: replyMention.ref },
    });
    const explicitCombined = JSON.stringify(explicit.messages);
    expect(explicitCombined).toContain("EXPANDED_ROOT");
    expect(explicitCombined).toContain("continuing");
    expect(explicitCombined).not.toContain("old bot text");
  });
});

describe("request-composition system message filtering", () => {
  class RawListAdapter extends SurfaceAdapterTestBase {
    constructor(private readonly messages: SurfaceMessage[]) {
      super();
    }

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }
    async getSelf(): Promise<SurfaceSelf> {
      throw new Error("not implemented");
    }
    async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
      throw new Error("not implemented");
    }
    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
      throw new Error("not implemented");
    }
    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<SurfaceOperationResult<MsgRef>> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
      const m = this.messages.find(
        (x) => x.session.channelId === msgRef.channelId && x.ref.messageId === msgRef.messageId,
      );
      return Result.ok(m ?? null);
    }

    async listMsg(
      sessionRef: SessionRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      return Result.ok(this.messages.filter((m) => m.session.channelId === sessionRef.channelId));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      return Result.ok([]);
    }
    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async removeReaction(
      _msgRef: MsgRef,
      _reaction: string,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
      return Result.ok([]);
    }
    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }
    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      throw new Error("not implemented");
    }
    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
  }

  it("excludes non-chat/system surface messages from default model context", async () => {
    const sessionId = "c";

    const mk = (id: string, ts: number, text: string, isChat: boolean): SurfaceMessage => ({
      ref: { platform: "discord", channelId: sessionId, messageId: id },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text,
      ts,
      raw: { discord: { isChat } },
    });

    const msgs = [
      mk("1", 1, "hello", true),
      mk("sys", 2, "created a thread", false),
      mk("2", 3, "world", true),
    ];

    const adapter = new RawListAdapter(msgs);

    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 20,
    });

    expect(out.chainMessageIds).toEqual(["1", "2"]);

    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    expect(combined).toContain("hello");
    expect(combined).toContain("world");
    expect(combined).not.toContain("created a thread");
  });

  it("returns null for composeSingleMessage when message is not chat", async () => {
    const sessionId = "c";

    const msg: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "sys" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u",
      userName: "user",
      text: "created a thread",
      ts: 0,
      raw: { discord: { isChat: false } },
    };

    const adapter = new RawListAdapter([msg]);

    const out = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      msgRef: msg.ref,
    });

    expect(out).toBe(null);
  });
});

describe("request-composition session divider", () => {
  class DividerAdapter extends SurfaceAdapterTestBase {
    constructor(private readonly messages: SurfaceMessage[]) {
      super();
    }

    async connect(): Promise<void> {
      throw new Error("not implemented");
    }
    async disconnect(): Promise<void> {
      throw new Error("not implemented");
    }

    async getSelf(): Promise<SurfaceSelf> {
      return { platform: "discord", userId: "bot", userName: "lilac" };
    }
    async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
      throw new Error("not implemented");
    }

    async startOutput(
      _sessionRef: SessionRef,
      _opts?: StartOutputOpts,
    ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
      throw new Error("not implemented");
    }

    async sendMsg(
      _sessionRef: SessionRef,
      _content: ContentOpts,
      _opts?: SendOpts,
    ): Promise<SurfaceOperationResult<MsgRef>> {
      throw new Error("not implemented");
    }

    async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
      return Result.ok(
        this.messages.find(
          (m) => m.session.channelId === msgRef.channelId && m.ref.messageId === msgRef.messageId,
        ) ?? null,
      );
    }

    async listMsg(
      sessionRef: SessionRef,
      opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      const inChannel = this.messages
        .filter((m) => m.session.channelId === sessionRef.channelId)
        .slice()
        .sort((a, b) => a.ts - b.ts);

      let filtered = inChannel;
      if (opts?.beforeMessageId) {
        const before = inChannel.find((m) => m.ref.messageId === opts.beforeMessageId);
        if (before) {
          filtered = filtered.filter((m) => m.ts < before.ts);
        }
      }

      if (opts?.afterMessageId) {
        const after = inChannel.find((m) => m.ref.messageId === opts.afterMessageId);
        if (after) {
          filtered = filtered.filter((m) => m.ts > after.ts);
        }
      }

      const limit = Math.max(1, opts?.limit ?? 50);
      return Result.ok(filtered.slice(Math.max(0, filtered.length - limit)));
    }

    async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async deleteMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async getReplyContext(
      _msgRef: MsgRef,
      _opts?: LimitOpts,
    ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      return Result.ok([]);
    }

    async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
    async removeReaction(
      _msgRef: MsgRef,
      _reaction: string,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }

    async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
      return Result.ok([]);
    }

    async subscribe(_handler: AdapterEventHandler): Promise<AdapterSubscription> {
      throw new Error("not implemented");
    }

    async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
      throw new Error("not implemented");
    }

    async markRead(
      _sessionRef: SessionRef,
      _upToMsgRef?: MsgRef,
    ): Promise<SurfaceOperationResult<void>> {
      throw new Error("not implemented");
    }
  }

  it("uses only the current trigger when optional reply context is unavailable", async () => {
    const failure = new SurfaceUnavailable({
      platform: "discord",
      operation: "get-reply-context",
      message: "reply context unavailable",
    });
    const trigger: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "trigger" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "current trigger",
      ts: 1,
      raw: { reference: {} },
    };
    class TransientContextAdapter extends DividerAdapter {
      override async getReplyContext(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
        return Result.err(failure);
      }
    }
    const adapter = new TransientContextAdapter([trigger]);

    const reply = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: trigger.ref },
    });

    expect(reply.chainMessageIds).toEqual(["trigger"]);
    expect(JSON.stringify(reply.messages)).toContain("current trigger");
  });

  it("falls back through optional reply planners without hiding later reads", async () => {
    const trigger: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "trigger" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "current trigger",
      ts: 1,
      raw: { reference: {} },
    };
    const plannerFailure = new SurfacePermissionDenied({
      platform: "discord",
      operation: "plan-reply-chain",
      message: "planner unavailable",
    });
    class PlannerFallbackAdapter extends DividerAdapter {
      replyPlannerCalls = 0;
      mergePlannerCalls = 0;

      override async planReplyChain(): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
        this.replyPlannerCalls += 1;
        return Result.err(plannerFailure);
      }

      override async planMergeBlockEndingAt(): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
        this.mergePlannerCalls += 1;
        return Result.err(plannerFailure);
      }
    }
    const adapter = new PlannerFallbackAdapter([trigger]);

    const reply = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: trigger.ref },
    });

    expect(reply.chainMessageIds).toEqual(["trigger"]);
    expect(adapter.replyPlannerCalls).toBe(1);
    expect(adapter.mergePlannerCalls).toBe(1);
  });

  it("propagates failures while reading a successful reply-chain plan", async () => {
    const trigger: SurfaceMessage = {
      ref: { platform: "discord", channelId: "c", messageId: "trigger" },
      session: { platform: "discord", channelId: "c" },
      userId: "u",
      text: "current trigger",
      ts: 2,
      raw: { reference: { messageId: "parent", channelId: "c" } },
    };
    const readFailure = new SurfaceUnavailable({
      platform: "discord",
      operation: "read-message",
      message: "planned history unavailable",
    });
    class PlannedReadFailureAdapter extends DividerAdapter {
      override async planReplyChain(): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
        return Result.ok([
          { platform: "discord", channelId: "c", messageId: "parent" },
          trigger.ref,
        ]);
      }

      override async readMsg(
        msgRef: MsgRef,
      ): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
        if (msgRef.messageId === "parent") return Result.err(readFailure);
        return await super.readMsg(msgRef);
      }
    }
    const adapter = new PlannedReadFailureAdapter([trigger]);

    const reply = await composeRequestMessagesResult(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: trigger.ref },
    });

    expect(reply).toEqual(Result.err(readFailure));
  });

  it("cuts off recent context at the most recent divider", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "d" },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "3" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_2",
        ts: 4,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["2", "3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("after_1");
    expect(combined).toContain("after_2");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
    expect(combined).not.toContain("before");
  });

  it("does not cut off context at divider from a different bot id", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: "d_other",
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot_other",
        userName: "lilac-other",
        text: "[LILAC_SESSION_DIVIDER] (by user)",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "3" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_2",
        ts: 4,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["1", "2", "3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("before");
    expect(combined).toContain("after_1");
    expect(combined).toContain("after_2");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it("still recognizes legacy divider format for cutoff", async () => {
    const sessionId = "c";

    const msgs: SurfaceMessage[] = [
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "1" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "before",
        ts: 1,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "d" },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "--- Session Divider ---\n[LILAC_SESSION_DIVIDER]",
        ts: 2,
        raw: { discord: { isChat: true } },
      },
      {
        ref: { platform: "discord", channelId: sessionId, messageId: "2" },
        session: { platform: "discord", channelId: sessionId },
        userId: "u",
        userName: "user",
        text: "after_1",
        ts: 3,
        raw: { discord: { isChat: true } },
      },
    ];

    const adapter = new DividerAdapter(msgs);
    const out = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: "bot",
      botName: "lilac",
      limit: 50,
    });

    expect(out.chainMessageIds).toEqual(["2"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("after_1");
    expect(combined).not.toContain("before");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it("cuts off reply-chain context at the most recent divider", async () => {
    const sessionId = "c";

    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 1,
      raw: { reference: {} },
    };

    const divider: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "div" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
      ts: 50,
      raw: { reference: {} },
    };

    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 100,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };

    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 110,
      raw: { reference: { messageId: "m1", channelId: sessionId } },
    };

    const adapter = new DividerAdapter([root, divider, m1, m2]);

    const out = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: "bot",
      botName: "lilac",
      trigger: { type: "reply", msgRef: m2.ref },
      maxDepth: 10,
    });

    // Reply chains intentionally ignore the divider.
    expect(out.chainMessageIds).toEqual(["root", "m1", "m2"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("user msg 1");
    expect(combined).toContain("user msg 2");
    expect(combined).toContain("Root");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  function createAnchoredDividerFixture() {
    const sessionId = "c";
    const root: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 1,
      raw: { reference: {} },
    };
    const divider: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "div" },
      session: { platform: "discord", channelId: sessionId },
      userId: "bot",
      userName: "lilac",
      text: "[LILAC_SESSION_DIVIDER] (by user)",
      ts: 50,
      raw: { reference: {} },
    };
    const m1: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 100,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    };
    const m2: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 110,
      raw: { reference: {} },
    };
    const m3: SurfaceMessage = {
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: 120,
      raw: { reference: { messageId: "m2", channelId: sessionId } },
    };
    class MentionDividerAdapter extends DividerAdapter {
      override async getReplyContext(
        msgRef: MsgRef,
        opts?: LimitOpts,
      ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
        const baseResult = await this.readMsg(msgRef);
        if (baseResult.status === "error") return Result.err(baseResult.error);
        const base = baseResult.value;
        if (!base) return Result.ok([]);

        const limit = opts?.limit ?? 50;
        const all = [root, divider, m1, m2, m3].slice().sort((a, b) => a.ts - b.ts);
        const half = Math.max(1, Math.floor(limit / 2));
        const beforeAll = all.filter((m) => m.ts <= base.ts);
        const before = beforeAll.slice(Math.max(0, beforeAll.length - half));
        const after = all.filter((m) => m.ts > base.ts).slice(0, half);
        return Result.ok(before.concat(after));
      }
    }
    const adapter = new MentionDividerAdapter([root, divider, m1, m2, m3]);

    return {
      adapter,
      compose: () =>
        composeRecentChannelMessages(adapter, {
          platform: "discord",
          sessionId,
          botUserId: "bot",
          botName: "lilac",
          limit: 50,
          triggerMsgRef: m3.ref,
          triggerType: "mention",
        }),
    };
  }

  it("cuts off anchored mention-thread context at the most recent divider", async () => {
    const { compose } = createAnchoredDividerFixture();
    const out = await compose();

    expect(out.chainMessageIds).toEqual(["m1", "m2", "m3"]);
    const combined = out.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(combined).toContain("user msg 1");
    expect(combined).toContain("user msg 2");
    expect(combined).toContain("user msg 3");
    expect(combined).not.toContain("Root");
    expect(combined).not.toContain("LILAC_SESSION_DIVIDER");
  });

  it.each([
    new SurfaceRateLimited({
      platform: "discord",
      operation: "list-messages",
      message: "divider lookup rate limited",
    }),
    new SurfaceUnavailable({
      platform: "discord",
      operation: "list-messages",
      message: "divider lookup unavailable",
    }),
    new SurfacePermissionDenied({
      platform: "discord",
      operation: "list-messages",
      message: "divider lookup denied",
    }),
    new SurfaceOperationUnsupported({
      platform: "discord",
      operation: "list-messages",
      message: "divider lookup unsupported",
    }),
  ])("continues an anchored chain without a divider for $error._tag", async (failure) => {
    const { adapter, compose } = createAnchoredDividerFixture();
    spyOn(adapter, "listMsg").mockResolvedValue(Result.err(failure));

    const out = await compose();

    expect(out.chainMessageIds).toEqual(["root", "m1", "m2", "m3"]);
  });

  it("preserves Panic from anchored divider discovery", async () => {
    const { adapter, compose } = createAnchoredDividerFixture();
    const panic = new Panic({ message: "divider lookup invariant failed" });
    spyOn(adapter, "listMsg").mockRejectedValue(panic);

    await expect(compose()).rejects.toBe(panic);
  });
});
