import { Buffer } from "node:buffer";

import type {
  Client,
  Message,
  MessageCreateOptions,
  TextBasedChannel,
} from "discord.js";

import type {
  StartOutputOpts,
  SurfaceOutputPart,
  SurfaceOutputResult,
  SurfaceOutputStream,
  SurfaceToolStatusUpdate,
} from "../../adapter";
import type {
  ContentOpts,
  MsgRef,
  SessionRef,
  SurfaceAttachment,
} from "../../types";

// NOTE: We currently only guarantee "images on same message" when the attachments are
// known before the first outbound send. Attaching files to an existing Discord message
// via edit is not consistently supported across environments.

import { getEmbedPusherConstants, startEmbedPusher } from "./embed-pusher";

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

function isDiscordSessionRef(
  sessionRef: SessionRef,
): sessionRef is SessionRef & {
  platform: "discord";
  channelId: string;
} {
  return sessionRef.platform === "discord";
}

function normalizeContent(content: ContentOpts): {
  text: string;
  attachments: SurfaceAttachment[];
} {
  return {
    text: content.text ?? "",
    attachments: content.attachments ?? [],
  };
}

function buildToolLine(update: SurfaceToolStatusUpdate): string {
  if (update.status === "start") {
    return `▶ ${update.display}`;
  }

  if (update.ok) {
    return `✓ ${update.display}`;
  }

  return `✗ ${update.display}`;
}

function clampLast<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  return arr.slice(arr.length - n);
}

async function fetchTextChannel(
  client: Client,
  channelId: string,
): Promise<TextBasedChannel> {
  const ch = (await client.channels
    .fetch(channelId)
    .catch(() => null)) as TextBasedChannel | null;
  if (!ch || !("send" in ch)) {
    throw new Error(
      `Discord channel not found or not text-based: ${channelId}`,
    );
  }
  return ch;
}

function toDiscordFiles(
  attachments: readonly SurfaceAttachment[],
): MessageCreateOptions["files"] {
  if (attachments.length === 0) return undefined;

  // discord.js `AttachmentPayload` supports `attachment` + `name`. Discord infers the
  // mime-type from the filename; passing `contentType` is not part of the public type.
  return attachments.map((a) => ({
    attachment: Buffer.from(a.bytes),
    name: a.filename,
  }));
}

async function safeEdit(
  msg: Message,
  options: Parameters<Message["edit"]>[0],
): Promise<boolean> {
  try {
    await msg.edit(options);
    return true;
  } catch {
    return false;
  }
}

export class DiscordOutputStream implements SurfaceOutputStream {
  private readonly created: MsgRef[] = [];
  private readonly toolLines: Array<{ toolCallId: string; line: string }> = [];

  private textAcc = "";
  private pendingAttachments: SurfaceAttachment[] = [];

  private baseMsg: Message | null = null;
  private readonly done: { promise: Promise<void>; resolve(): void };

  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      client: Client;
      sessionRef: SessionRef;
      opts?: StartOutputOpts;
      useSmartSplitting: boolean;
    },
  ) {
    let resolveFn: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.done = {
      promise,
      resolve: () => {
        resolveFn?.();
      },
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.running) return;

    const { client, sessionRef } = this.deps;
    if (!isDiscordSessionRef(sessionRef))
      throw new Error("Unsupported platform");

    const channel = await fetchTextChannel(client, sessionRef.channelId);
    if (!("send" in channel)) throw new Error("Discord channel not found");

    // We want to attach images to the same message whenever possible.
    // So we delay creating the base message until either:
    // - we have something to display (text or action), or
    // - finish() is called.
    const base = await channel.send({
      // content must be non-empty to avoid Discord errors when sending only embeds.
      content: "*Replying...*",
      reply:
        this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
          ? { messageReference: this.deps.opts.replyTo.messageId }
          : undefined,
      files: toDiscordFiles(this.pendingAttachments),
      allowedMentions: { parse: [], repliedUser: false },
    });

    this.baseMsg = base;
    this.created.push(asDiscordMsgRef(sessionRef.channelId, base.id));

    // Now run the embed pusher, which will reply to baseMsg with embed messages.
    // Those reply messages are the actual visible output; baseMsg is a stable anchor.
    // We also clear the attachment buffer since they were included on the initial send.
    this.pendingAttachments = [];

    const { STREAMING_INDICATOR, CLOSING_TAG_BUFFER } =
      getEmbedPusherConstants();

    const getMaxLength = (isStreaming: boolean) => {
      const max = 4096;
      if (!isStreaming) {
        return max - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
      }
      return (
        max -
        STREAMING_INDICATOR.length -
        (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0)
      );
    };

    this.running = (async () => {
      const res = await startEmbedPusher({
        createFirst: async (emb) => {
          const msg = await base.reply({
            embeds: [emb],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return msg;
        },
        createReply: async (parent, emb) => {
          const msg = await parent.reply({
            embeds: [emb],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return msg;
        },
        getContent: () => this.textAcc,
        getActionsLines: () =>
          clampLast(
            this.toolLines.map((t) => t.line),
            4,
          ),
        getMaxLength,
        streamDone: this.done.promise,
        useSmartSplitting: this.deps.useSmartSplitting,
        safeEdit,
      });

      // track created reply messages
      for (const messageId of res.discordMessageCreated) {
        this.created.push(asDiscordMsgRef(sessionRef.channelId, messageId));
      }

      // Remove the placeholder base message once we have at least one visible embed reply.
      // We keep it if nothing was created.
      if (res.discordMessageCreated.length > 0) {
        await base.delete().catch(() => {});
      } else {
        // If we never created embeds, just edit base into a final embed-ish plain message.
        await safeEdit(base, { content: this.textAcc || "*<empty_string>*" });
      }
    })();
  }

  async push(part: SurfaceOutputPart): Promise<void> {
    // Ensure started on first push so attachments can be part of the first send.
    // If the first push is a delta, we start immediately.
    // If the first push is an attachment, we buffer it until we start.

    switch (part.type) {
      case "text.delta":
        this.textAcc += part.delta;
        await this.ensureStarted();
        return;
      case "text.set":
        this.textAcc = part.text;
        await this.ensureStarted();
        return;
      case "tool.status": {
        const line = buildToolLine(part.update);
        const idx = this.toolLines.findIndex(
          (t) => t.toolCallId === part.update.toolCallId,
        );
        if (idx >= 0) {
          this.toolLines[idx] = { toolCallId: part.update.toolCallId, line };
        } else {
          this.toolLines.push({ toolCallId: part.update.toolCallId, line });
        }
        // Only start once we have something to show.
        await this.ensureStarted();
        return;
      }
      case "attachment.add": {
        // Best-effort: attach on the initial send.
        // If we already started, we currently do not try to mutate files on an existing
        // message (Discord edit-with-files is tricky); instead we buffer and will send
        // as follow-up messages when we finish.
        if (!this.baseMsg) {
          this.pendingAttachments.push(part.attachment);
          return;
        }

        // Already started: buffer for post-stream followup.
        this.pendingAttachments.push(part.attachment);
        return;
      }
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  async finish(): Promise<SurfaceOutputResult> {
    await this.ensureStarted();

    this.done.resolve();
    await this.running;

    // If we received attachments after first send, emit them as follow-up messages.
    // Still embed-styled is TODO; for now, just send as files.
    const { client, sessionRef } = this.deps;
    if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
      // If we started with attachments, they were already sent; remaining buffer includes those too.
      // We can’t easily know which made it into the initial send, so we only send extras if
      // baseMsg existed without files.
      // For now: if baseMsg exists, do nothing (assume included). If baseMsg got deleted,
      // we also assume included.
      // (We’ll tighten this once we have real binary output wiring.)
      void client;
    }

    const last = this.created.at(-1);
    if (!last) {
      throw new Error("DiscordOutputStream produced no messages");
    }

    return {
      created: [...this.created],
      last,
    };
  }

  async abort(_reason?: string): Promise<void> {
    this.done.resolve();
    await this.running;
  }
}

export async function sendDiscordStyledMessage(params: {
  client: Client;
  sessionRef: SessionRef;
  content: ContentOpts;
  opts?: StartOutputOpts;
  useSmartSplitting: boolean;
}): Promise<MsgRef> {
  const { text, attachments } = normalizeContent(params.content);
  const out = new DiscordOutputStream({
    client: params.client,
    sessionRef: params.sessionRef,
    opts: params.opts,
    useSmartSplitting: params.useSmartSplitting,
  });

  for (const a of attachments) {
    await out.push({ type: "attachment.add", attachment: a });
  }
  await out.push({ type: "text.set", text });

  const res = await out.finish();
  return res.last;
}
