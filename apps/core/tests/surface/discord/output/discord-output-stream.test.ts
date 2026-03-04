import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import type { SurfaceAttachment } from "../../../../src/surface/types";

import {
  DiscordOutputStream,
  buildOutputAllowedMentions,
  buildWorkingTitle,
  clampReasoningDetail,
  escapeDiscordMarkdown,
  formatReasoningAsBlockquote,
  toPreviewTail,
} from "../../../../src/surface/discord/output/discord-output-stream";

describe("escapeDiscordMarkdown", () => {
  it("escapes emphasis markers in glob-like patterns", () => {
    expect(escapeDiscordMarkdown("**/*")).toBe("\\*\\*/\\*");
  });

  it("escapes common markdown control characters", () => {
    expect(escapeDiscordMarkdown("[x](y) _z_ `k` ~u~")).toBe(
      "\\[x\\]\\(y\\) \\_z\\_ \\`k\\` \\~u\\~",
    );
  });
});

function createFakeDiscordClient(opts?: { failEditWithFiles?: boolean }): {
  client: Client;
  createdMessageIds: string[];
  deletedMessageIds: string[];
  operations: Array<{
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  }>;
} {
  type RecordedOp = {
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  };

  type FakeMessage = {
    readonly id: string;
    readonly channelId: string;
    readonly attachments: Map<string, { id: string }>;
    edit(options: unknown): Promise<FakeMessage>;
    reply(options: unknown): Promise<FakeMessage>;
    delete(): Promise<void>;
  };

  const operations: RecordedOp[] = [];
  const deletedMessageIds: string[] = [];
  const createdMessageIds: string[] = [];
  const messages = new Map<string, FakeMessage>();
  let nextMessageId = 1;
  let nextAttachmentId = 1;
  const channelId = "chan";

  const fileCountFromOptions = (options: unknown): number => {
    if (!options || typeof options !== "object") return 0;
    const files = (options as { files?: unknown }).files;
    if (!Array.isArray(files)) return 0;
    return files.length;
  };

  const keepAttachmentIdsFromOptions = (options: unknown): Set<string> | null => {
    if (!options || typeof options !== "object") return null;
    const raw = (options as { attachments?: unknown }).attachments;
    if (!Array.isArray(raw)) return null;

    const keep = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") keep.add(id);
    }
    return keep;
  };

  const appendNewAttachments = (message: FakeMessage, count: number): void => {
    for (let i = 0; i < count; i++) {
      const id = `att_${nextAttachmentId++}`;
      message.attachments.set(id, { id });
    }
  };

  const applyEditAttachments = (message: FakeMessage, options: unknown): void => {
    const keep = keepAttachmentIdsFromOptions(options);
    if (keep) {
      const idsToDelete: string[] = [];
      for (const id of message.attachments.keys()) {
        if (!keep.has(id)) {
          idsToDelete.push(id);
        }
      }
      for (const id of idsToDelete) {
        message.attachments.delete(id);
      }
    }

    const newFileCount = fileCountFromOptions(options);
    appendNewAttachments(message, newFileCount);
  };

  const createMessage = (params?: {
    operation: "send" | "reply";
    options: unknown;
    parentId?: string;
  }): FakeMessage => {
    const id = `m_${nextMessageId++}`;
    createdMessageIds.push(id);

    const attachments = new Map<string, { id: string }>();

    const message: FakeMessage = {
      id,
      channelId,
      attachments,
      edit: async (options) => {
        operations.push({ kind: "edit", messageId: id, options });
        if (opts?.failEditWithFiles && fileCountFromOptions(options) > 0) {
          throw new Error("edit failed");
        }
        applyEditAttachments(message, options);
        return message;
      },
      reply: async (options) => {
        return createMessage({ operation: "reply", parentId: id, options });
      },
      delete: async () => {
        deletedMessageIds.push(id);
        messages.delete(id);
      },
    };

    if (params) {
      operations.push({
        kind: params.operation,
        messageId: id,
        parentId: params.parentId,
        options: params.options,
      });
      appendNewAttachments(message, fileCountFromOptions(params.options));
    }

    messages.set(id, message);
    return message;
  };

  const channel = {
    send: async (options: unknown) => createMessage({ operation: "send", options }),
    messages: {
      fetch: async (messageId: string) => messages.get(messageId) ?? null,
    },
  };

  const client = {
    channels: {
      fetch: async (id: string) => (id === channelId ? channel : null),
    },
  };

  return {
    client: client as unknown as Client,
    createdMessageIds,
    deletedMessageIds,
    operations,
  };
}

function hasFiles(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) && files.length > 0;
}

function filesCount(options: unknown): number {
  if (!options || typeof options !== "object") return 0;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) ? files.length : 0;
}

function uploadedFileNames(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const files = (options as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const names: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const name = (file as { name?: unknown }).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

function allUploadedFileNames(
  operations: ReadonlyArray<{
    kind: "send" | "reply" | "edit";
    options: unknown;
  }>,
): string[] {
  return operations
    .filter((op) => hasFiles(op.options))
    .flatMap((op) => uploadedFileNames(op.options));
}

function makeAttachment(index: number): SurfaceAttachment {
  return {
    kind: "image",
    mimeType: "image/png",
    filename: `image-${index}.png`,
    bytes: new Uint8Array([index]),
  };
}

describe("preview reanchor behavior", () => {
  it("keeps frozen placeholder lane messages on reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(out.getFinalTextMode()).toBe("full");
    expect(deletedMessageIds).toEqual([]);
  });

  it("keeps frozen placeholder lane messages on interrupt reanchor", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.abort("reanchor_interrupt");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(deletedMessageIds).toEqual([]);
  });

  it("reports continuation final text mode for inline streams", () => {
    const { client } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    expect(out.getFinalTextMode()).toBe("continuation");
  });
});

describe("attachment finalization", () => {
  it("inline mode edits attachments onto the final split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "a".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = await out.finish();

    expect(res.created.length).toBeGreaterThan(1);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(editsWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(0);
  });

  it("preview mode posts attachments on the final reposted split message", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "b".repeat(9000) });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = await out.finish();

    expect(res.created.length).toBeGreaterThan(1);

    const sentWithFiles = operations.filter(
      (op) => (op.kind === "send" || op.kind === "reply") && hasFiles(op.options),
    );
    expect(sentWithFiles.length).toBe(1);
    expect(sentWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(0);
  });

  it("falls back to follow-up attachment messages when final edit fails", async () => {
    const { client, operations } = createFakeDiscordClient({ failEditWithFiles: true });

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(1) });
    const res = await out.finish();

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });

  it("keeps first 10 attachments on final message and overflows remainder", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    for (let i = 0; i < 11; i++) {
      await out.push({ type: "attachment.add", attachment: makeAttachment(i) });
    }

    const res = await out.finish();

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(filesCount(editsWithFiles[0]?.options)).toBe(10);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(1);
    expect(filesCount(replyWithFiles[0]?.options)).toBe(1);
    const replyFileMsg = replyWithFiles[0];
    if (!replyFileMsg) {
      throw new Error("expected overflow reply message with files");
    }
    expect(res.last.messageId).toBe(replyFileMsg.messageId);
  });
});

describe("attachment single-event safety", () => {
  it("does not reattach one queued attachment across reanchor and finish", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "before reanchor" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.abort("reanchor");

    await out.push({ type: "text.delta", delta: "after reanchor" });
    await out.finish();

    expect(allUploadedFileNames(operations)).toEqual(["image-9.png"]);
  });

  it("attaches one queued attachment exactly once on cancel", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(10) });
    await out.abort("cancel");

    expect(allUploadedFileNames(operations)).toEqual(["image-10.png"]);
  });

  it("attaches attachment-only cancel output once", async () => {
    const { client, operations, createdMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "attachment.add", attachment: makeAttachment(11) });
    await out.abort("cancel");

    expect(createdMessageIds.length).toBeGreaterThan(0);
    expect(allUploadedFileNames(operations)).toEqual(["image-11.png"]);
  });
});

describe("experimental markdown table rendering", () => {
  const markdownTable = [
    "| Name | Score |",
    "| --- | ---: |",
    "| Alice | 10 |",
    "| Bob | 200 |",
  ].join("\n");

  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream) as string;
  }

  it("rewrites markdown tables into fixed-width blocks when enabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownTableRender: {
        style: "unicode",
        maxWidth: 40,
      },
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toContain("```text");
    expect(rendered).toContain("┌");
  });

  it("leaves markdown table text untouched when disabled", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", markdownTable);

    const rendered = getRenderedText(out);
    expect(rendered).toBe(markdownTable);
  });
});

describe("reasoning display helpers", () => {
  it("clamps long reasoning output and preserves leading content", () => {
    expect(clampReasoningDetail("0123456789", 4)).toBe("012…");
  });

  it("renders reasoning text as blockquote lines", () => {
    expect(formatReasoningAsBlockquote("**Title**\nline 1\nline 2")).toBe(
      "> **Title**\n> line 1\n> line 2",
    );
  });

  it("renders working title with elapsed request seconds", () => {
    expect(
      buildWorkingTitle({
        nowMs: 21_500,
        startedAtMs: 20_000,
        indicator: "Working",
      }),
    ).toBe("⣽ Working... 1s");
  });

  it("clamps reasoning detail body to 500 chars by default", () => {
    const detail = `${"a".repeat(520)}\n${"b".repeat(10)}`;
    const output = clampReasoningDetail(detail);
    expect(output.includes("…")).toBe(true);
    expect(output.length).toBe(500);
  });
});

describe("working indicator picker", () => {
  function getPicker(stream: DiscordOutputStream): (previous?: string) => string {
    const picker = Reflect.get(stream as object, "pickRandomWorkingIndicator");
    if (typeof picker !== "function") {
      throw new Error("pickRandomWorkingIndicator is unavailable");
    }
    return (previous?: string) => picker.call(stream, previous) as string;
  }

  it("cycles without immediate repeats for unique indicators", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    let previous: string | undefined;

    for (let i = 0; i < 30; i++) {
      const next = pick(previous);
      if (previous) {
        expect(next).not.toBe(previous);
      }
      previous = next;
    }
  });

  it("reuses shuffled queue order across full cycles", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Planning", "Reading", "Tooling"],
    });

    const pick = getPicker(out);
    const cycleOne: string[] = [];
    const cycleTwo: string[] = [];

    let previous: string | undefined;
    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleOne.push(next);
      previous = next;
    }

    for (let i = 0; i < 3; i++) {
      const next = pick(previous);
      cycleTwo.push(next);
      previous = next;
    }

    expect(new Set(cycleOne).size).toBe(3);
    expect(cycleTwo).toEqual(cycleOne);
  });
});

describe("preview tail helper", () => {
  it("returns input unchanged when already within limit", () => {
    expect(toPreviewTail("hello", 10)).toBe("hello");
  });

  it("tails to exact max length with ellipsis prefix", () => {
    const out = toPreviewTail("0123456789", 6);
    expect(out).toBe("...789");
    expect(out.length).toBe(6);
  });
});

describe("output mention policy", () => {
  it("disables reply and mentions when notifications are off", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: false,
        previewMode: false,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("suppresses notifications on preview transient lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: false,
      }),
    ).toEqual({ parse: [], repliedUser: false });
  });

  it("enables user mentions and reply ping on preview final lane", () => {
    expect(
      buildOutputAllowedMentions({
        notificationsEnabled: true,
        previewMode: true,
        isReply: true,
        isFinalLane: true,
      }),
    ).toEqual({ parse: ["users"], repliedUser: true });
  });
});
