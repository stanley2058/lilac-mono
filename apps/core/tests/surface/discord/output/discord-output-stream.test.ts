import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { Panic, Result, type Result as ResultType } from "better-result";
import type { SurfaceAttachment } from "../../../../src/surface/types";

import {
  DiscordOutputStream,
  buildDiscordProgressLines,
  buildOutputAllowedMentions,
  buildWorkingTitle,
  clampReasoningDetail,
  escapeDiscordMarkdown,
  formatReasoningAsBlockquote,
  sendDiscordStyledMessage,
  toPreviewTail,
} from "../../../../src/surface/discord/output/discord-output-stream";
import type { SurfaceToolStatusUpdate } from "../../../../src/surface/adapter";
import { buildProgressFieldValue } from "../../../../src/surface/discord/output/embed-pusher";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

describe("plain flat table images", () => {
  const table = "| Name | State |\n| --- | --- |\n| Alpha | Ready |";
  const png = new Uint8Array([137, 80, 78, 71]);
  const defaults = {
    sessionRef: { platform: "discord", channelId: "chan" } as const,
    useSmartSplitting: true,
    outputMode: "preview" as const,
    outputPreviewModeFinalStyle: "plain" as const,
    outputPreviewModeFinalText: "flat" as const,
    markdownTableRender: { style: "image" as const, maxWidth: 50 },
    reasoningDisplayMode: "none" as const,
    workingIndicators: ["Working"],
  };

  it("renders only the final answer, uploads at table boundaries, and tracks every message", async () => {
    const { client, operations } = createFakeDiscordClient();
    let renders = 0;
    const seen: string[] = [];
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      opts: {
        requestId: "table-request",
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
        onMessageCreated: (ref) => {
          seen.push(ref.messageId);
        },
      },
      rewriteText: (text) => text.replaceAll("Alpha", "Rewritten"),
      renderTableImages: async (tables, context) => {
        expect(context).toEqual({ requestId: "table-request", channelId: "chan" });
        renders++;
        expect(tables).toHaveLength(2);
        expect(tables[0]?.rows[1]?.[0]?.runs).toEqual([{ text: "Rewritten" }]);
        return [png, png];
      },
    });
    const final = `Before\n\n${table}\n\nBetween\n\n${table}\n\nAfter`;
    await out.push({ type: "text.delta", phase: "commentary", delta: table });
    await out.push({
      type: "text.set",
      phase: "final_answer",
      text: table + final,
      finalSegments: [table, final],
    });
    expect(renders).toBe(0);
    const result = resultValue(await out.finish());
    expect(renders).toBe(1);
    const ids = result.created.map((ref) => ref.messageId);
    const sent = operations.filter((op) => ids.includes(op.messageId) && op.kind === "send");
    expect(sent.map((op) => contentFromOptions(op.options)?.trim())).toEqual([
      "Before",
      "Between",
      "After",
    ]);
    expect(sent.map((op) => uploadedFileNames(op.options))).toEqual([
      ["table-1.png"],
      ["table-2.png"],
      [],
    ]);
    const first = sent[0]?.options as {
      reply: { messageReference: string };
      files: { description?: string }[];
    };
    expect(first.reply.messageReference).toBe("source");
    expect(first.files[0]?.description).toBe(table.replaceAll("Alpha", "Rewritten"));
    expect((sent[1]!.options as { reply?: unknown }).reply).toBeUndefined();
    expect(ids.every((id) => seen.includes(id))).toBe(true);
    expect(result.last.messageId).toBe(ids.at(-1)!);
  });

  it("sends table-only answers without placeholder content", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [png],
    });
    await out.push({ type: "text.delta", delta: table });
    const result = resultValue(await out.finish());
    const sent = operations.find(
      (op) => op.kind === "send" && op.messageId === result.last.messageId,
    );
    expect(contentFromOptions(sent?.options)).toBeUndefined();
    expect(uploadedFileNames(sent?.options)).toEqual(["table-1.png"]);
    expect(result.created).toHaveLength(1);
  });

  it("keeps ordinary attachments after a terminal table and respects the ten-file capacity", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [png],
    });
    await out.push({ type: "text.delta", delta: table });
    for (let i = 0; i < 11; i++)
      await out.push({ type: "attachment.add", attachment: makeAttachment(i) });
    const result = resultValue(await out.finish());
    const sent = operations.filter(
      (op) => result.created.some((ref) => ref.messageId === op.messageId) && op.kind !== "edit",
    );
    expect(sent.map((op) => filesCount(op.options))).toEqual([1, 10, 1]);
    expect(allUploadedFileNames(sent)).toEqual([
      "table-1.png",
      ...Array.from({ length: 11 }, (_, i) => `image-${i}.png`),
    ]);
    expect(operations.filter((op) => op.kind === "edit" && hasFiles(op.options))).toHaveLength(0);
  });

  it("uses the text renderer when PNG rendering fails", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      ...defaults,
      client,
      renderTableImages: async () => [null],
    });
    await out.push({ type: "text.delta", delta: `Before\n\n${table}\n\nAfter` });
    const result = resultValue(await out.finish());
    const sent = operations.find(
      (op) => op.kind === "send" && op.messageId === result.last.messageId,
    );
    expect(contentFromOptions(sent?.options)).toContain("```text");
    expect(contentFromOptions(sent?.options)).toContain("┌");
    expect(contentFromOptions(sent?.options)).toContain("After");
    expect(uploadedFileNames(sent?.options)).toEqual([]);
  });

  it.each([
    { outputMode: "inline" as const },
    { outputPreviewModeFinalStyle: "embed" as const },
    { outputPreviewModeFinalText: "reply-chain" as const },
    { markdownTableRender: undefined },
  ])("does not render images outside enabled plain flat output: %j", async (override) => {
    const { client, operations } = createFakeDiscordClient();
    let renders = 0;
    const out = new DiscordOutputStream({
      ...defaults,
      ...override,
      client,
      renderTableImages: async () => {
        renders++;
        return [png];
      },
    });
    await out.push({ type: "text.delta", delta: table });
    const result = resultValue(await out.finish());
    expect(renders).toBe(0);
    if (override.markdownTableRender !== undefined || !("markdownTableRender" in override)) {
      const output = operations
        .filter((op) => result.created.some((ref) => ref.messageId === op.messageId))
        .flatMap((op) => [
          contentFromOptions(op.options) ?? "",
          ...embedDescriptionsFromOptions(op.options),
        ])
        .join("\n");
      expect(output).toContain("┌");
    }
  });

  it.each(["unicode", "ascii", undefined] as const)(
    "keeps style %s as text in plain flat mode",
    async (style) => {
      const { client, operations } = createFakeDiscordClient();
      let renders = 0;
      const out = new DiscordOutputStream({
        ...defaults,
        client,
        markdownTableRender: { style, maxWidth: 50 },
        renderTableImages: async () => {
          renders++;
          return [png];
        },
      });
      await out.push({ type: "text.delta", delta: `Before\n\n${table}\n\nAfter` });
      const result = resultValue(await out.finish());
      expect(renders).toBe(0);
      expect(result.created).toHaveLength(1);
      const sent = operations.find(
        (op) => op.kind === "send" && op.messageId === result.last.messageId,
      );
      const content = contentFromOptions(sent?.options);
      expect(content).toContain("Before");
      expect(content).toContain(style === "ascii" ? "+" : "┌");
      expect(content).toContain("After");
      expect(uploadedFileNames(sent?.options)).toEqual([]);
    },
  );
});

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

describe("compact subagent progress", () => {
  function entry(
    toolCallId: string,
    updatedSeq: number,
    update: Omit<SurfaceToolStatusUpdate, "toolCallId">,
  ) {
    return { toolCallId, updatedSeq, update: { toolCallId, ...update } };
  }

  function visible(lines: readonly string[]): string[] {
    return lines.map((line) => line.replaceAll("\\", ""));
  }

  it("keeps detailed reasoning visible alongside all five action rows", () => {
    const value = buildProgressFieldValue({
      reasoningValue: "> **Inspecting**\n> reasoning detail",
      actionsValue: "action one\naction two\naction three\naction four\nagent one",
    });

    expect(value.split("\n")).toEqual([
      "> **Inspecting**",
      "> reasoning detail",
      "",
      "action one",
      "action two",
      "action three",
      "action four",
      "agent one",
    ]);
  });

  it("reserves three rows for one active agent and two for recent main actions", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-1", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-2", 2, { status: "end", display: "grep auth", ok: true }),
          entry("tool-3", 3, { status: "start", display: "bash bun test" }),
          entry("tool-4", 4, { status: "start", display: "read failing.test.ts" }),
        ],
        subagents: [
          entry("agent-1", 5, {
            status: "update",
            display: [
              "subagent (general; claude-fable-5 [high]; 1/2 done)",
              "|- + read package.json",
              "`- > bash bunx tsc --noEmit",
            ].join("\n"),
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "▶ bash bun test",
      "▶ read failing.test.ts",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bunx tsc --noEmit",
    ]);
  });

  it("shows one child row per active agent when two are visible", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [low]; 1/2 done)\n`- > bash bun test",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (explore; claude-fable-5 [medium]; 14/20 done)\n`- > batch (2/6)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "… explore (cl...fable-5 [md]; 14/20)",
      "`- > batch (2/6)",
      "… general (gpt-5.6-sol [lo]; 1/2)",
      "`- > bash bun test",
    ]);
  });

  it("moves completed agents into tool history while active agents stay at the bottom", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "update",
            display: "subagent (general; claude-fable-5 [high]; 12/13 done)\n`- > read src/a.ts",
          }),
          entry("agent-2", 2, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)\n`- > patch src/b.ts",
          }),
          entry("agent-3", 3, {
            status: "update",
            display: "subagent (explore; grok-4.5 [xhigh]; 8/10 done)\n`- > batch (2/6)",
          }),
          entry("agent-4", 4, {
            status: "end",
            display: "subagent (explore; 3/3 done)",
            ok: true,
          }),
          entry("agent-5", 5, {
            status: "end",
            display: "subagent (general; 4/4 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ explore (3/3)",
      "✓ general (4/4)",
      "… explore (grok-4.5 [xh]; 8/10; batch)",
      "… self (gpt-5.6-sol [md]; 1/2; patch)",
      "… general (cl...fable-5 [hi]; 12/13; read)",
    ]);
  });

  it("orders completed agents with tools by recency", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("tool-old", 1, { status: "end", display: "glob src", ok: true }),
          entry("tool-new", 3, { status: "end", display: "grep auth", ok: true }),
        ],
        subagents: [
          entry("agent-complete", 2, {
            status: "end",
            display: "subagent (general; gpt-5.6-sol [high]; 2/2 done)",
            ok: true,
          }),
          entry("agent-active", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ glob src",
      "✓ general (gpt-5.6-sol [hi]; 2/2)",
      "✓ grep auth",
      "… explore (gpt-5.6-sol [lo]; 1/2)",
    ]);
  });

  it("evicts completed agents naturally as newer tools fill the history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: Array.from({ length: 5 }, (_, index) =>
          entry(`tool-${index}`, index + 2, {
            status: "end",
            display: `bash command-${index}`,
            ok: true,
          }),
        ),
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; 2/2 done)",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ bash command-0",
      "✓ bash command-1",
      "✓ bash command-2",
      "✓ bash command-3",
      "✓ bash command-4",
    ]);
  });

  it("counts only active agents in subagent overflow", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-complete", 1, {
            status: "end",
            display: "subagent (general; resolved)",
            ok: true,
          }),
          ...Array.from({ length: 4 }, (_, index) =>
            entry(`agent-active-${index}`, index + 2, {
              status: "update",
              display: `subagent (explore; ${index + 1}/4 done)`,
            }),
          ),
        ],
      }),
    );

    expect(lines).toEqual([
      "✓ general (resolved)",
      "… explore (4/4)",
      "… explore (3/4)",
      "… explore (2/4) · +1 more",
    ]);
  });

  it("renders failed and cancelled agents as terminal tool history", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-failed", 1, {
            status: "end",
            display: "subagent (general; failed)",
            ok: false,
          }),
          entry("agent-cancelled", 2, {
            status: "end",
            display: "subagent (explore; cancelled)",
            ok: false,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✗ general (failed)", "✗ explore (cancelled)"]);
  });

  it("collapses a completed agent and omits unresolved effort", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "end",
            display:
              "subagent (explore; gpt-5.6-sol [provider-default]; 3/3 done)\n`- + bash bun test",
            ok: true,
          }),
        ],
      }),
    );

    expect(lines).toEqual(["✓ explore (gpt-5.6-sol; 3/3)"]);
  });

  it("uses the delegated profile while an agent is starting", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("agent-1", 1, {
            status: "start",
            display: "subagent_delegate (general) Investigate flaky tests",
          }),
        ],
      }),
    );

    expect(lines).toEqual(["▶ general (starting)"]);
  });

  it("counts multiline batch rows within the five-line budget", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("batch-1", 1, {
            status: "update",
            display: [
              "batch (3 tools; 2/3 done)",
              "|- ✓ read a.ts",
              "|- ✓ grep auth",
              "`- ▶ bash bun test",
            ].join("\n"),
          }),
        ],
        subagents: [
          entry("agent-1", 2, {
            status: "update",
            display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)",
          }),
          entry("agent-2", 3, {
            status: "update",
            display: "subagent (self; gpt-5.6-sol [medium]; 1/2 done)",
          }),
          entry("agent-3", 4, {
            status: "update",
            display: "subagent (explore; gpt-5.6-sol [low]; 1/2 done)",
          }),
        ],
      }),
    );

    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 2)).toEqual(["… batch (3 tools; 2/3 done)", "`- ▶ bash bun test"]);
    expect(lines.slice(2).every((line) => line.includes("gpt-5.6-sol"))).toBe(true);
  });

  it("normalizes restored builtin prefixes without rewriting plugin or batch displays", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [
          entry("read", 1, { status: "start", display: "read_file restored.ts" }),
          entry("plugin", 2, { status: "start", display: "read_file_plugin restored.ts" }),
          entry("batch", 3, {
            status: "update",
            display: "batch (1 tools)\n`- ▶ read_file restored.ts",
          }),
        ],
        subagents: [
          entry("agent", 4, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > apply_patch restored.ts",
          }),
        ],
      }),
    );

    expect(lines).toContain("▶ read_file_plugin restored.ts");
    expect(lines).toContain("… batch (1 tools)");
    expect(lines).toContain("`- ▶ read restored.ts");
    expect(lines).toContain("`- > patch restored.ts");
  });

  it("normalizes restored builtin names in compact subagent headers", () => {
    const lines = visible(
      buildDiscordProgressLines({
        tools: [],
        subagents: [
          entry("one", 1, {
            status: "update",
            display: "subagent (explore; 1/2 done)\n`- > read_file one.ts",
          }),
          entry("two", 2, {
            status: "update",
            display: "subagent (general; 1/2 done)\n`- > apply_patch two.ts",
          }),
          entry("three", 3, {
            status: "update",
            display: "subagent (self; 1/2 done)\n`- > edit_file three.ts",
          }),
        ],
      }),
    );

    expect(lines.some((line) => line.includes("; read)"))).toBe(true);
    expect(lines.some((line) => line.includes("; patch)"))).toBe(true);
    expect(lines.some((line) => line.includes("; edit)"))).toBe(true);
  });
});

function createFakeDiscordClient(opts?: {
  failEdit?: boolean;
  editFailure?: unknown;
  failEditWithFiles?: boolean;
  sendFailure?: unknown;
  failSendAt?: number;
  failReplyAt?: number;
  replyFailure?: unknown;
  failResumeFetch?: boolean;
  resumeFetchFailure?: unknown;
  onEdit?: (options: unknown) => void;
  guildPremiumTier?: number;
}): {
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
  let replyAttempts = 0;
  let sendAttempts = 0;
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
        opts?.onEdit?.(options);
        if (opts?.editFailure) throw opts.editFailure;
        if (opts?.failEdit) throw new Error("edit failed");
        if (opts?.failEditWithFiles && fileCountFromOptions(options) > 0) {
          throw new Error("edit failed");
        }
        applyEditAttachments(message, options);
        return message;
      },
      reply: async (options) => {
        replyAttempts += 1;
        if (replyAttempts === opts?.failReplyAt) {
          throw opts.replyFailure ?? new Error("reply failed");
        }
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
    ...(opts?.guildPremiumTier === undefined
      ? {}
      : { guild: { premiumTier: opts.guildPremiumTier } }),
    send: async (options: unknown) => {
      if (opts?.sendFailure) throw opts.sendFailure;
      sendAttempts += 1;
      if (sendAttempts === opts?.failSendAt) {
        throw Object.assign(new Error("send unavailable"), { status: 503 });
      }
      return createMessage({ operation: "send", options });
    },
    messages: {
      fetch: async (messageId: string) => {
        if (opts?.resumeFetchFailure) throw opts.resumeFetchFailure;
        if (opts?.failResumeFetch) throw new Error("resume fetch failed");
        return messages.get(messageId) ?? null;
      },
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

function contentFromOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const content = (options as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function hasEmbeds(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const embeds = (options as { embeds?: unknown }).embeds;
  return Array.isArray(embeds) && embeds.length > 0;
}

function embedDescriptionsFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  return embeds.flatMap((embed) => {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") serialized = toJSON.call(embed);
    }
    if (!serialized || typeof serialized !== "object") return [];
    const description = (serialized as { description?: unknown }).description;
    return typeof description === "string" ? [description] : [];
  });
}

function embedFieldValuesFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  const values: string[] = [];
  for (const embed of embeds) {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        serialized = toJSON.call(embed);
      }
    }

    if (!serialized || typeof serialized !== "object") continue;
    const fields = (serialized as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      if (!field || typeof field !== "object") continue;
      const value = (field as { value?: unknown }).value;
      if (typeof value === "string") values.push(value);
    }
  }

  return values;
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

describe("Discord initial output", () => {
  it("sends substantive content directly with reply, cancel, and creation correlation", async () => {
    const { client, operations } = createFakeDiscordClient();
    let createdMessageId: string | undefined;
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        requestId: "discord:chan:request",
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
        onMessageCreated: (ref) => {
          createdMessageId = ref.messageId;
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(out.push({ type: "text.delta", delta: "hello" })).resolves.toEqual(
      Result.ok("visible"),
    );

    expect(operations).toHaveLength(1);
    const first = operations[0]?.options as {
      content?: string;
      embeds?: unknown[];
      reply?: { messageReference?: string };
      components?: unknown[];
    };
    expect(first.content).toBeUndefined();
    expect(first.embeds).toHaveLength(1);
    expect(first.reply).toEqual({ messageReference: "source" });
    expect(first.components).toHaveLength(1);
    expect(createdMessageId).toBe("m_1");
    await out.finish();
  });

  it("edits a recovered output message instead of posting another reply", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient();
    const original = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });
    await original.push({ type: "text.delta", delta: "before crash" });
    const originalResult = resultValue(await original.finish());
    const operationsBeforeRecovery = operations.length;
    let recoveredMessageId: string | undefined;
    const recovered = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        requestId: "discord:chan:request",
        resumeAt: originalResult.last,
        onMessageCreated: (ref) => {
          recoveredMessageId = ref.messageId;
        },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await recovered.push({ type: "text.delta", delta: "after recovery" });

    expect(createdMessageIds).toEqual(["m_1"]);
    expect(operations.slice(operationsBeforeRecovery)).toEqual([
      expect.objectContaining({ kind: "edit", messageId: "m_1" }),
    ]);
    expect(recoveredMessageId).toBe("m_1");
    expect(resultValue(await recovered.finish()).last).toEqual(originalResult.last);
  });

  it("posts a fresh message when the recovered output message is unavailable", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient({
      failResumeFetch: true,
    });
    const recovered = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        resumeAt: { platform: "discord", channelId: "chan", messageId: "missing" },
      },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await recovered.push({ type: "text.delta", delta: "after recovery" });

    expect(createdMessageIds).toEqual(["m_1"]);
    expect(operations[0]).toEqual(expect.objectContaining({ kind: "send", messageId: "m_1" }));
    await recovered.finish();
  });
});

describe("Discord compact progress integration", () => {
  it("moves a completed agent into history before newer tool activity", async () => {
    let resolveCompletedEdit: (options: unknown) => void = () => {};
    let resolveShiftedEdit: (options: unknown) => void = () => {};
    const completedEdit = new Promise<unknown>((resolve) => {
      resolveCompletedEdit = resolve;
    });
    const shiftedEdit = new Promise<unknown>((resolve) => {
      resolveShiftedEdit = resolve;
    });
    const { client, operations } = createFakeDiscordClient({
      onEdit: (options) => {
        const lines = embedFieldValuesFromOptions(options)
          .flatMap((value) => value.replaceAll("\\", "").split("\n"))
          .filter(Boolean);
        if (lines.some((line) => line.includes("✓ general")) && lines.length === 1) {
          resolveCompletedEdit(options);
        }
        const completedIndex = lines.findIndex((line) => line.includes("✓ general"));
        const newerToolIndex = lines.findIndex((line) => line.includes("▶ bash parent-check"));
        if (completedIndex >= 0 && newerToolIndex > completedIndex) {
          resolveShiftedEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: "subagent (general; gpt-5.6-sol [high]; 1/2 done)\n`- > bash child-check",
      },
    });
    const activeLines = embedFieldValuesFromOptions(operations[0]?.options).join("\n");
    expect(operations[0]?.kind).toBe("send");
    expect(activeLines).toContain("general");
    expect(activeLines).toContain("1/2");

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "end",
        display: "subagent (general; resolved)",
        ok: true,
      },
    });
    const completedEditOptions = await completedEdit;
    expect(
      embedFieldValuesFromOptions(completedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)"]);

    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "tool-1",
        status: "start",
        display: "bash parent-check",
      },
    });
    const shiftedEditOptions = await shiftedEdit;
    expect(
      embedFieldValuesFromOptions(shiftedEditOptions).map((value) => value.replaceAll("\\", "")),
    ).toEqual(["✓ general (gpt-5.6-sol [hi]; 1/2)\n▶ bash parent-check"]);
    await out.finish();
  });

  it("keeps agents in the Working field and removes progress on completion", async () => {
    let resolveStreamingEdit: (options: unknown) => void = () => {};
    const streamingEdit = new Promise<unknown>((resolve) => {
      resolveStreamingEdit = resolve;
    });
    const { client, operations } = createFakeDiscordClient({
      onEdit: (options) => {
        if (embedFieldValuesFromOptions(options).some((value) => value.includes("bash bun test"))) {
          resolveStreamingEdit(options);
        }
      },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    for (let index = 1; index <= 4; index++) {
      await out.push({
        type: "tool.status",
        update: {
          toolCallId: `tool-${index}`,
          status: "start",
          display: `bash command-${index}`,
        },
      });
    }
    await out.push({
      type: "tool.status",
      update: {
        toolCallId: "agent-1",
        status: "update",
        display: [
          "subagent (general; claude-fable-5 [high]; 1/2 done)",
          "|- + read package.json",
          "`- > bash bun test",
        ].join("\n"),
      },
    });

    const streamingEditOptions = await streamingEdit;
    const streamingValues = embedFieldValuesFromOptions(streamingEditOptions).map((value) =>
      value.replaceAll("\\", ""),
    );
    expect(streamingValues).toHaveLength(1);
    expect(streamingValues[0]?.split("\n")).toEqual([
      "▶ bash command-3",
      "▶ bash command-4",
      "… general (cl...fable-5 [hi]; 1/2)",
      "|- + read package.json",
      "`- > bash bun test",
    ]);

    await out.finish();
    const finalEdit = operations.filter((operation) => operation.kind === "edit").at(-1);
    expect(embedFieldValuesFromOptions(finalEdit?.options)).toEqual([]);
  });
});

describe("preview reanchor behavior", () => {
  it("reports hidden reasoning as terminal without rendering it", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await expect(
      out.push({
        type: "reasoning.status",
        update: { startedAtMs: 1, detailText: "hidden" },
      }),
    ).resolves.toEqual(Result.ok("terminal"));
    expect(operations).toEqual([]);
  });

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

  it.each([
    ["reanchor", "*Steering...*"],
    ["reanchor_interrupt", "*Interrupted...*"],
  ] as const)("replaces the flat-mode placeholder on %s", async (reason, placeholder) => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "flat",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hidden final", phase: "final_answer" });
    await out.abort(reason);

    const finalEdit = operations.filter((operation) => operation.kind === "edit").at(-1);
    expect(contentFromOptions(finalEdit?.options)).toBe(placeholder);
    expect(contentFromOptions(finalEdit?.options)).not.toBe("*Replying...*");
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

describe("output operation failures", () => {
  it("returns a classified failure when the first substantive send fails", async () => {
    const { client, createdMessageIds } = createFakeDiscordClient({ sendFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    const result = await out.push({ type: "text.delta", delta: "hello" });

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected first-send failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceUnavailable",
      operation: "push-output",
    });
    expect(createdMessageIds).toEqual([]);
  });

  it("raises a Panic when final output rejects with an impossible non-Error value", async () => {
    const { client } = createFakeDiscordClient({
      failReplyAt: 1,
      replyFailure: "invalid non-Error rejection",
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });

    try {
      await out.finish();
      throw new Error("expected Discord output invariant Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
      if (!Panic.is(cause)) throw cause;
      expect(cause.message).toBe("Discord output invariant violated");
    }
  });

  it("does not finish successfully when embed synchronization fails", async () => {
    const { client } = createFakeDiscordClient({ editFailure: { status: 503 } });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = await out.finish();
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected finish failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      operation: "finish-output",
    });
  });

  it("continues streaming in a fresh message when the edited message was deleted", async () => {
    const { client, createdMessageIds, operations } = createFakeDiscordClient({
      editFailure: { code: 10_008, status: 404 },
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = resultValue(await out.finish());

    expect(createdMessageIds.length).toBeGreaterThan(1);
    expect(result.last.messageId).toBe(createdMessageIds.at(-1)!);
    const last = operations.filter((op) => op.messageId === result.last.messageId).at(-1);
    expect(embedDescriptionsFromOptions(last?.options)).toEqual(["hello"]);
  });

  it("keeps the preview when the final reply fails", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient({
      failSendAt: 2,
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    const result = await out.finish();

    expect(result.status).toBe("error");
    expect(createdMessageIds).toHaveLength(1);
    expect(deletedMessageIds).toEqual([]);
  });

  it("deletes the preview after the final reply succeeds", async () => {
    const { client, createdMessageIds, deletedMessageIds } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "hello" });
    resultValue(await out.finish());

    expect(createdMessageIds).toHaveLength(2);
    expect(deletedMessageIds).toEqual([createdMessageIds[0]!]);
  });

  it("returns partial completion when a later final chunk fails", async () => {
    const replyFailure = Object.assign(new Error("reply unavailable"), { status: 503 });
    const { client } = createFakeDiscordClient({
      failReplyAt: 1,
      replyFailure,
    });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    const result = await out.finish();

    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected finish failure");
    expect(result.error).toMatchObject({
      _tag: "SurfaceOperationPartiallyCompleted",
      operation: "finish-output",
      created: { platform: "discord", channelId: "chan" },
    });
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
    const res = resultValue(await out.finish());

    expect(res.created.length).toBeGreaterThan(1);

    const editsWithFiles = operations.filter((op) => op.kind === "edit" && hasFiles(op.options));
    expect(editsWithFiles.length).toBe(1);
    expect(editsWithFiles[0]?.messageId).toBe(res.last.messageId);
    expect(allUploadedFileNames(operations)).toEqual(["image-1.png"]);

    const replyWithFiles = operations.filter((op) => op.kind === "reply" && hasFiles(op.options));
    expect(replyWithFiles.length).toBe(0);
  });

  const MIB = 1024 * 1024;
  const sizedAttachment = (index: number, mib: number): SurfaceAttachment => ({
    ...makeAttachment(index),
    bytes: new Uint8Array(mib * MIB),
  });
  const finishWithAttachments = async (tier: number | undefined, sizesMib: readonly number[]) => {
    const { client, operations } = createFakeDiscordClient({ guildPremiumTier: tier });
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "files" });
    for (const [index, mib] of sizesMib.entries()) {
      await out.push({ type: "attachment.add", attachment: sizedAttachment(index, mib) });
    }
    const result = resultValue(await out.finish());
    const finalOps = operations.filter((op) =>
      result.created.some((ref) => ref.messageId === op.messageId),
    );
    return {
      uploads: finalOps.filter((op) => hasFiles(op.options)).map((op) => filesCount(op.options)),
      contents: finalOps.flatMap((op) => contentFromOptions(op.options) ?? []),
    };
  };

  it.each([
    ["a DM", undefined],
    ["a tier 2 guild", 2],
    ["a tier 3 guild", 3],
  ] as const)("keeps each upload request within the request byte budget in %s", async (_, tier) => {
    const { uploads } = await finishWithAttachments(tier, [12, 12, 12]);
    expect(uploads).toEqual([2, 1]);
  });

  it.each([
    ["a tier 2 guild", 2, [40, 12]],
    ["a tier 3 guild", 3, [90, 12]],
  ] as const)(
    "sends a file over the request budget alone when %s allows its size",
    async (_, tier, sizesMib) => {
      const { uploads, contents } = await finishWithAttachments(tier, sizesMib);
      expect(uploads).toEqual([1, 1]);
      expect(contents.some((content) => content.includes("Skipped attachment"))).toBe(false);
    },
  );

  it.each([
    ["a DM", undefined, 21, "20 MiB"],
    ["a tier 2 guild", 2, 51, "50 MiB"],
  ] as const)(
    "skips a file over the per-file limit in %s with a notice",
    async (_, tier, mib, limit) => {
      const { uploads, contents } = await finishWithAttachments(tier, [mib, 1]);
      expect(uploads).toEqual([1]);
      expect(contents).toContain(
        `Skipped attachment \`image-0.png\` (${mib} MiB): over the ${limit} Discord upload limit for this channel.`,
      );
    },
  );

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
    const res = resultValue(await out.finish());

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
    const res = resultValue(await out.finish());

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

    const res = resultValue(await out.finish());

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

describe("styled message send", () => {
  const sessionRef = { platform: "discord" as const, channelId: "chan" };

  it("sends plain style as a content reply chain without a preview", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();

    const result = await sendDiscordStyledMessage({
      client,
      sessionRef,
      content: { text: "x".repeat(4500), style: "plain", attachments: [makeAttachment(1)] },
      opts: { replyTo: { platform: "discord", channelId: "chan", messageId: "origin" } },
      useSmartSplitting: false,
    });
    const last = resultValue(result);

    const created = operations.filter((op) => op.kind === "send" || op.kind === "reply");
    expect(created.map((op) => contentFromOptions(op.options)?.length)).toEqual([2000, 2000, 500]);
    expect(created.some((op) => hasEmbeds(op.options))).toBe(false);
    expect(created[0]?.options).toMatchObject({ reply: { messageReference: "origin" } });
    expect(created[1]?.parentId).toBe(created[0]?.messageId);
    expect(created[2]?.parentId).toBe(created[1]?.messageId);
    expect(uploadedFileNames(created[2]?.options)).toEqual(["image-1.png"]);
    expect(deletedMessageIds).toEqual([]);
    expect(created[2]?.messageId).toBe(last.messageId);
  });

  it("keeps embed style as the default", async () => {
    const { client, operations } = createFakeDiscordClient();

    resultValue(
      await sendDiscordStyledMessage({
        client,
        sessionRef,
        content: { text: "hello" },
        useSmartSplitting: false,
      }),
    );

    expect(operations.map((op) => embedDescriptionsFromOptions(op.options))).toContainEqual([
      "hello",
    ]);
    expect(operations.some((op) => contentFromOptions(op.options) === "hello")).toBe(false);
  });

  it("sends embed style directly without a streaming edit", async () => {
    const { client, operations } = createFakeDiscordClient();

    const last = resultValue(
      await sendDiscordStyledMessage({
        client,
        sessionRef,
        content: { text: "x".repeat(5000), attachments: [makeAttachment(1)] },
        opts: { replyTo: { platform: "discord", channelId: "chan", messageId: "origin" } },
        useSmartSplitting: false,
      }),
    );

    expect(operations.map((op) => op.kind)).toEqual(["send", "reply"]);
    expect(operations[0]?.options).toMatchObject({ reply: { messageReference: "origin" } });
    expect(operations.flatMap((op) => embedDescriptionsFromOptions(op.options)).join("")).toBe(
      "x".repeat(5000),
    );
    expect(uploadedFileNames(operations[1]?.options)).toEqual(["image-1.png"]);
    expect(last.messageId).toBe(operations[1]!.messageId);
  });
});

describe("preview final output style", () => {
  it("reposts phased final segments as a plain reply chain", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "Commentary.\n\nFinal answer." });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.push({
      type: "text.set",
      text: "Commentary.\n\nFinal answer.",
      finalSegments: ["Commentary.", "Final answer."],
    });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (operation) =>
        (operation.kind === "send" || operation.kind === "reply") &&
        !hasEmbeds(operation.options) &&
        ["Commentary.", "Final answer."].includes(contentFromOptions(operation.options) ?? ""),
    );
    expect(plainFinalOps.map((operation) => contentFromOptions(operation.options))).toEqual([
      "Commentary.",
      "Final answer.",
    ]);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(filesCount(plainFinalOps[0]?.options)).toBe(0);
    expect(filesCount(plainFinalOps[1]?.options)).toBe(1);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    const finalPlainOperation = plainFinalOps[1];
    if (!finalPlainOperation) throw new Error("expected final plain segment");
    expect(res.last.messageId).toBe(finalPlainOperation.messageId);
  });

  it("renders each final segment in the terminal phase", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({
      type: "text.set",
      text: "combined",
      finalSegments: ["first \\(partial", "second \\(x+1\\)"],
    });
    await out.finish();

    const finalContents = operations
      .filter((operation) => operation.kind === "send" || operation.kind === "reply")
      .map((operation) => contentFromOptions(operation.options))
      .filter((content): content is string => content !== undefined);
    expect(finalContents).toContain("first \\(partial");
    expect(finalContents).toContain("second `x + 1`");
  });

  it("posts preview final output as content and stats as metadata when configured", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "preview text" });
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const finalSend = operations.find(
      (op) =>
        op.kind === "send" &&
        contentFromOptions(op.options) === "preview text" &&
        hasEmbeds(op.options),
    );

    expect(finalSend).toBeDefined();
    if (!finalSend) {
      throw new Error("expected plain final send");
    }
    expect(contentFromOptions(finalSend.options)).not.toContain("nerd stats");
    expect(embedFieldValuesFromOptions(finalSend.options)).toEqual(["*nerd stats*"]);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    expect(res.last.messageId).toBe(finalSend.messageId);
  });

  it("attaches stats metadata only to the final plain preview chunk", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    await out.push({ type: "meta.stats", line: "nerd stats" });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(hasEmbeds(plainFinalOps[0]?.options)).toBe(false);
    expect(hasEmbeds(plainFinalOps[1]?.options)).toBe(false);
    expect(embedFieldValuesFromOptions(lastPlainFinal.options)).toEqual(["*nerd stats*"]);
    expect(contentFromOptions(lastPlainFinal.options)).not.toContain("nerd stats");
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });

  it("splits plain preview final output into a normal reply chain", async () => {
    const { client, operations } = createFakeDiscordClient();

    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "reply-chain",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: "x".repeat(4500) });
    const res = resultValue(await out.finish());

    const plainFinalOps = operations.filter(
      (op) =>
        (op.kind === "send" || op.kind === "reply") &&
        !hasEmbeds(op.options) &&
        (contentFromOptions(op.options)?.startsWith("x") ?? false),
    );

    expect(plainFinalOps.length).toBe(3);
    const lastPlainFinal = plainFinalOps[2];
    if (!lastPlainFinal) {
      throw new Error("expected third plain final chunk");
    }
    expect(contentFromOptions(plainFinalOps[0]?.options)?.length).toBe(2000);
    expect(contentFromOptions(plainFinalOps[1]?.options)?.length).toBe(2000);
    expect(contentFromOptions(lastPlainFinal.options)?.length).toBe(500);
    expect(plainFinalOps[1]?.parentId).toBe(plainFinalOps[0]?.messageId);
    expect(plainFinalOps[2]?.parentId).toBe(plainFinalOps[1]?.messageId);
    expect(res.last.messageId).toBe(lastPlainFinal.messageId);
  });

  it("posts only the final answer as visually grouped plain messages", async () => {
    const { client, operations, deletedMessageIds } = createFakeDiscordClient();
    const commentary = "Commentary stays in the preview.";
    const finalAnswer = "F".repeat(4500);
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      opts: {
        replyTo: { platform: "discord", channelId: "chan", messageId: "source" },
      },
      useSmartSplitting: false,
      outputMode: "preview",
      outputPreviewModeFinalStyle: "plain",
      outputPreviewModeFinalText: "flat",
      outputNotification: true,
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    await out.push({ type: "text.delta", delta: commentary, phase: "commentary" });
    await out.push({ type: "text.delta", delta: finalAnswer, phase: "final_answer" });
    await out.push({ type: "attachment.add", attachment: makeAttachment(9) });
    await out.push({
      type: "text.set",
      text: commentary + finalAnswer,
      phase: "final_answer",
      finalSegments: [commentary, finalAnswer],
    });
    const res = resultValue(await out.finish());

    const previewDescriptions = operations.flatMap((operation) =>
      embedDescriptionsFromOptions(operation.options),
    );
    expect(previewDescriptions.some((description) => description.includes(commentary))).toBe(true);
    expect(previewDescriptions.some((description) => description.includes("F".repeat(100)))).toBe(
      false,
    );

    const finalOps = operations.filter(
      (operation) => contentFromOptions(operation.options)?.startsWith("F") ?? false,
    );
    expect(finalOps.map((operation) => operation.kind)).toEqual(["send", "send", "send"]);
    expect(finalOps.map((operation) => contentFromOptions(operation.options)?.length)).toEqual([
      2000, 2000, 500,
    ]);
    expect(
      (finalOps[0]?.options as { reply?: { messageReference?: string } } | undefined)?.reply,
    ).toEqual({ messageReference: "source" });
    expect((finalOps[1]?.options as { reply?: unknown } | undefined)?.reply).toBeUndefined();
    expect((finalOps[2]?.options as { reply?: unknown } | undefined)?.reply).toBeUndefined();
    expect(
      (finalOps[0]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: true });
    expect(
      (finalOps[1]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: false });
    expect(
      (finalOps[2]?.options as { allowedMentions?: unknown } | undefined)?.allowedMentions,
    ).toEqual({ parse: ["users"], repliedUser: false });
    expect(filesCount(finalOps[0]?.options)).toBe(0);
    expect(filesCount(finalOps[1]?.options)).toBe(0);
    expect(filesCount(finalOps[2]?.options)).toBe(1);
    expect(
      operations.some(
        (operation) => contentFromOptions(operation.options)?.includes(commentary) ?? false,
      ),
    ).toBe(false);
    expect(deletedMessageIds.length).toBeGreaterThan(0);
    const lastFinalOp = finalOps[2];
    if (!lastFinalOp) throw new Error("expected third final plain message");
    expect(res.last.messageId).toBe(lastFinalOp.messageId);
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

describe("discord blockquote normalization", () => {
  function getRenderedText(stream: DiscordOutputStream): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") {
      throw new Error("getRenderedText is unavailable");
    }
    return method.call(stream, "terminal") as string;
  }

  it("normalizes bare blockquote continuation lines before rendering", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });

    Reflect.set(out as object, "textAcc", "> first\n>\n> second");

    expect(getRenderedText(out)).toBe("> first\n> \n> second");
  });

  it("does not normalize bare markers inside fenced code in rendered text", () => {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
    });
    const input = ["```md", ">", "```", ">"].join("\n");

    Reflect.set(out as object, "textAcc", input);

    expect(getRenderedText(out)).toBe(["```md", ">", "```", "> "].join("\n"));
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
    return method.call(stream, "terminal") as string;
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

describe("Discord markdown math integration", () => {
  function getRenderedText(stream: DiscordOutputStream, phase: "streaming" | "terminal"): string {
    const method = Reflect.get(stream as object, "getRenderedText");
    if (typeof method !== "function") throw new Error("getRenderedText is unavailable");
    return method.call(stream, phase) as string;
  }

  function createMathStream(options?: {
    markdownMathRender?: { maxWidth?: number; fallbackMode?: "source" | "passthrough" };
    rewriteText?: (text: string) => string;
    markdownTableRender?: { style?: "unicode" | "ascii"; maxWidth?: number };
  }): DiscordOutputStream {
    const { client } = createFakeDiscordClient();
    return new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      ...options,
    });
  }

  it("renders inline and display math when enabled", () => {
    const out = createMathStream({ markdownMathRender: { maxWidth: 50 } });
    Reflect.set(out as object, "textAcc", "inline \\(x+1\\)\n\n$$y^2$$");

    expect(getRenderedText(out, "terminal")).toBe("inline `x + 1`\n\n```text\ny²\n```");
  });

  it("leaves math source byte-for-byte unchanged when options are omitted", () => {
    const out = createMathStream();
    const source = "inline \\(x+1\\)\r\n\r\n$$y^2$$";
    Reflect.set(out as object, "textAcc", source);

    expect(getRenderedText(out, "streaming")).toBe(source);
    expect(getRenderedText(out, "terminal")).toBe(source);
  });

  it("runs rewrite, blockquote normalization, tables, then math", () => {
    const out = createMathStream({
      rewriteText: () =>
        [">", "", "| Formula |", "| --- |", "| $$x+1$$ |", "", "outside \\(y+1\\)"].join("\n"),
      markdownTableRender: { style: "ascii", maxWidth: 40 },
      markdownMathRender: { maxWidth: 50 },
    });
    Reflect.set(out as object, "textAcc", "unrewritten \\(z\\)");

    const rendered = getRenderedText(out, "terminal");
    expect(rendered).toStartWith("> \n\n```text\n");
    expect(rendered).toContain("| $$x+1$$ |");
    expect(rendered).not.toContain("```text\nx + 1\n```");
    expect(rendered).toEndWith("outside `y + 1`");
    expect(rendered).not.toContain("unrewritten");
  });

  it("withholds incomplete math while streaming and restores it at terminal", () => {
    const out = createMathStream({ markdownMathRender: { fallbackMode: "passthrough" } });
    Reflect.set(out as object, "textAcc", "before \\(partial");

    expect(getRenderedText(out, "streaming")).toBe("before ");
    expect(getRenderedText(out, "terminal")).toBe("before \\(partial");
  });

  it("uses terminal rendering for the final embed-pusher sync", async () => {
    const { client, operations } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: "none",
      workingIndicators: ["Working"],
      markdownMathRender: { fallbackMode: "passthrough" },
    });

    await out.push({ type: "text.delta", delta: "before \\(partial" });
    await out.finish();

    const descriptions = operations.flatMap((operation) =>
      embedDescriptionsFromOptions(operation.options),
    );
    expect(descriptions.some((description) => description.includes("\\(partial"))).toBe(true);
    expect(descriptions.at(-1)).toBe("before \\(partial");
  });
});

describe("reasoning display helpers", () => {
  function getReasoningPresentation(
    mode: "simple" | "detailed",
    detailText: string,
  ): { title: string; detail: string | null } {
    const { client } = createFakeDiscordClient();
    const out = new DiscordOutputStream({
      client,
      sessionRef: { platform: "discord", channelId: "chan" },
      useSmartSplitting: false,
      outputMode: "inline",
      reasoningDisplayMode: mode,
      workingIndicators: ["Working"],
    });
    Reflect.set(out as object, "hasReasoningStatus", true);
    Reflect.set(out as object, "reasoningDetailText", detailText);

    const getProgressTitle = Reflect.get(out as object, "getProgressTitle");
    const getReasoningValue = Reflect.get(out as object, "getReasoningValue");
    if (typeof getProgressTitle !== "function" || typeof getReasoningValue !== "function") {
      throw new Error("reasoning presentation methods are unavailable");
    }
    return {
      title: getProgressTitle.call(out) as string,
      detail: getReasoningValue.call(out) as string | null,
    };
  }

  it("keeps the working indicator and shows a detailed title-only summary", () => {
    const presentation = getReasoningPresentation("detailed", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**");
  });

  it("keeps the working indicator and blockquotes the full detailed summary", () => {
    const presentation = getReasoningPresentation(
      "detailed",
      "**Inspecting the stream**\n\nChecking event ordering.",
    );

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBe("> **Inspecting the stream**\n> \n> Checking event ordering.");
  });

  it("keeps the working indicator and hides the detail body in simple mode", () => {
    const presentation = getReasoningPresentation("simple", "**Inspecting the stream**");

    expect(presentation.title).toContain("Working");
    expect(presentation.detail).toBeNull();
  });

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

  it("prefers a complete trailing block over a partial text tail", () => {
    expect(toPreviewTail("discarded text that is long\n\ncomplete block", 20, true)).toBe(
      "...complete block",
    );
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
