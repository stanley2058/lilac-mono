import { Buffer } from "node:buffer";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Message,
  type MessageCreateOptions,
  type TextBasedChannel,
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
import { buildCancelCustomId } from "../discord-cancel";

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

export function escapeDiscordMarkdown(text: string): string {
  // Escape markdown-significant characters so tool status lines render literally.
  // This avoids cases like "**/*" being interpreted as emphasis.
  return text.replace(/([\\*_`~|>\[\]()])/g, "\\$1");
}

function isBatchToolDisplay(display: string): boolean {
  const trimmed = display.trimStart();
  // Back-compat: older displays used "[batch]".
  return trimmed.startsWith("batch") || trimmed.startsWith("[batch]");
}

function isSubagentToolDisplay(display: string): boolean {
  const trimmed = display.trimStart();
  // Back-compat: older displays may include a bracketed prefix.
  return trimmed.startsWith("subagent") || trimmed.startsWith("[subagent]");
}

function normalizeToolDisplayForDiscord(display: string): string {
  if (isBatchToolDisplay(display) || isSubagentToolDisplay(display)) return display;
  return display
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildToolLine(update: SurfaceToolStatusUpdate): string {
  const normalized = normalizeToolDisplayForDiscord(update.display);
  const escapedDisplay = escapeDiscordMarkdown(normalized);

  if (update.status === "start") {
    return `▶ ${escapedDisplay}`;
  }

  if (update.ok) {
    return `✓ ${escapedDisplay}`;
  }

  return `✗ ${escapedDisplay}`;
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

async function fetchExistingMessagesForResume(params: {
  channel: TextBasedChannel;
  channelId: string;
  refs: readonly MsgRef[];
}): Promise<Message[]> {
  const { channel, channelId, refs } = params;
  if (refs.length === 0) return [];

  const messagesApi = (channel as unknown as {
    messages?: { fetch: (messageId: string) => Promise<Message> };
  }).messages;

  if (!messagesApi || typeof messagesApi.fetch !== "function") {
    return [];
  }

  const out: Message[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (ref.platform !== "discord") continue;
    if (ref.channelId !== channelId) continue;
    if (seen.has(ref.messageId)) continue;

    const msg = await messagesApi.fetch(ref.messageId).catch(() => null);
    if (!msg) continue;

    seen.add(ref.messageId);
    out.push(msg);
  }

  return out;
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
  private statsForNerdsLine: string | null = null;

  private textAcc = "";
  private pendingAttachments: SurfaceAttachment[] = [];

  private firstMsg: Message | null = null;
  private lastMsg: Message | null = null;
  private readonly done: { promise: Promise<void>; resolve(): void };

  private cancelCustomId: string | null = null;

  private running: Promise<void> | null = null;
  private usedEmbedPusher = false;

  constructor(
    private readonly deps: {
      client: Client;
      sessionRef: SessionRef;
      opts?: StartOutputOpts;
      useSmartSplitting: boolean;
      rewriteText?: (text: string) => string;

      /** Optional: send a mention-only ping message at end of stream. */
      mentionPing?: {
        enabled: boolean;
        maxUsers: number;
        extractUserIds?: (text: string) => string[];
      };
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

  private notifyCreated(msgRef: MsgRef) {
    try {
      this.deps.opts?.onMessageCreated?.(msgRef);
    } catch {
      // ignore
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.running) return;

    const { client, sessionRef } = this.deps;
    if (!isDiscordSessionRef(sessionRef))
      throw new Error("Unsupported platform");

    const channel = await fetchTextChannel(client, sessionRef.channelId);
    if (!("send" in channel)) throw new Error("Discord channel not found");

    // We want to attach images to the same message whenever possible.
    // So we delay creating the first message until either:
    // - we have something to display (text or action), or
    // - finish() is called.

    // Discord supports up to 10 attachments per message.
    const MAX_FILES = 10;

    this.cancelCustomId = (() => {
      const requestId = this.deps.opts?.requestId;
      return requestId
        ? buildCancelCustomId({ sessionId: sessionRef.channelId, requestId })
        : null;
    })();

    const buildCancelComponents = (
      enabled: boolean,
    ): MessageCreateOptions["components"] | undefined => {
      if (!this.cancelCustomId) return undefined;
      const btn = new ButtonBuilder()
        .setCustomId(this.cancelCustomId)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!enabled);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btn);
      return [row];
    };

    const resumedMessages = await fetchExistingMessagesForResume({
      channel,
      channelId: sessionRef.channelId,
      refs: this.deps.opts?.resume?.created ?? [],
    });
    const resumed = resumedMessages.length > 0;

    const initialAttachments = resumed
      ? []
      : this.pendingAttachments.slice(0, MAX_FILES);
    const remainingAttachments = resumed
      ? this.pendingAttachments.slice()
      : this.pendingAttachments.slice(MAX_FILES);

    const first = resumedMessages[0] ??
      (await channel.send({
        // content must be non-empty to avoid Discord errors when sending only embeds.
        content: "*Replying...*",
        reply:
          this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
            ? { messageReference: this.deps.opts.replyTo.messageId }
            : undefined,
        files: toDiscordFiles(initialAttachments),
        components: buildCancelComponents(true),
        allowedMentions: { parse: [], repliedUser: false },
      }));

    this.firstMsg = first;
    if (resumed) {
      const seen = new Set<string>();
      for (const m of resumedMessages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        this.created.push(asDiscordMsgRef(sessionRef.channelId, m.id));
      }
      this.lastMsg = resumedMessages[resumedMessages.length - 1] ?? first;
    } else {
      const ref = asDiscordMsgRef(sessionRef.channelId, first.id);
      this.created.push(ref);
      this.notifyCreated(ref);
    }

    // Keep overflow/new attachments for follow-up messages.
    this.pendingAttachments = remainingAttachments;

    // Special case: attachments-only output (no text and no tool lines).
    // In this case we don't start the embed pusher at all.
    if (
      this.textAcc.length === 0 &&
      this.toolLines.length === 0 &&
      this.statsForNerdsLine === null
    ) {
      this.lastMsg = first;
      this.running = Promise.resolve();
      return;
    }

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

    this.usedEmbedPusher = true;
    this.running = (async () => {
      const res = await startEmbedPusher({
        createFirst: async (emb) => {
          // Replace the placeholder "Replying..." message with the first embed.
          // This keeps the reply target as the *user's* original message (instead of
          // creating a nested reply chain that replies to the placeholder).
          await safeEdit(first, {
            content: "",
            embeds: [emb],
            components: buildCancelComponents(true),
          });
          return first;
        },
        createReply: async (parent, emb) => {
          const msg = await parent.reply({
            embeds: [emb],
            allowedMentions: { parse: [], repliedUser: false },
          });

          // Notify immediately so the router can treat replies-to-this message as "active".
          const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
          this.created.push(ref);
          this.notifyCreated(ref);
          return msg;
        },
        getContent: () => {
          const rewrite = this.deps.rewriteText;
          return rewrite ? rewrite(this.textAcc) : this.textAcc;
        },
        getActionsLines: () =>
          clampLast(
            this.toolLines.map((t) => t.line),
            4,
          ),
        getStatsLine: () => this.statsForNerdsLine,
        getMaxLength,
        streamDone: this.done.promise,
        useSmartSplitting: this.deps.useSmartSplitting,
        safeEdit,
        getFirstMessageEditExtras: (isStreaming) => ({
          components: isStreaming ? buildCancelComponents(true) : [],
        }),
      });

      // track created reply messages
      const seen = new Set(this.created.map((m) => m.messageId));
      for (const messageId of res.discordMessageCreated) {
        if (seen.has(messageId)) continue;
        this.created.push(asDiscordMsgRef(sessionRef.channelId, messageId));
        seen.add(messageId);
      }

      this.lastMsg = res.lastMsg;

      // IMPORTANT: never delete the message that carries files.
      // We keep `first` as the stable anchor and rely on embed replies for the visible response.
      // If no embeds were created, turn `first` into the final plain message.
      if (res.discordMessageCreated.length === 0) {
        const rewrite = this.deps.rewriteText;
        const content = rewrite ? rewrite(this.textAcc) : this.textAcc;
        await safeEdit(first, {
          content: content || "*<empty_string>*",
          components: [],
        });
        this.lastMsg = first;
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
      case "meta.stats":
        this.statsForNerdsLine = part.line.trim().length > 0 ? part.line : null;
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
        // If we already started, we do not try to mutate files on an existing message
        // (Discord edit-with-files is tricky); instead we buffer and will send as follow-up
        // messages when we finish.
        if (!this.firstMsg) {
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

    // If we never started the embed pusher (attachments-only), remove the cancel control.
    if (this.firstMsg && this.cancelCustomId) {
      await safeEdit(this.firstMsg, { components: [] });
    }

    // If we received attachments after first send, emit them as follow-up messages.
    // Discord supports up to 10 attachments per message.
    const { sessionRef } = this.deps;
    if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
      const replyTo = this.lastMsg ?? this.firstMsg;
      if (!replyTo) {
        throw new Error("DiscordOutputStream missing reply anchor");
      }

      const MAX_FILES = 10;

      for (let i = 0; i < this.pendingAttachments.length; i += MAX_FILES) {
        const chunk = this.pendingAttachments.slice(i, i + MAX_FILES);
        const msg = await replyTo.reply({
          files: toDiscordFiles(chunk),
          allowedMentions: { parse: [], repliedUser: false },
        });
        {
          const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
          this.created.push(ref);
          this.notifyCreated(ref);
        }
        this.lastMsg = msg;
      }

      this.pendingAttachments = [];
    }

    // Optional: after the full response is visible, send a dedicated mention-only message.
    // This is primarily for active-mode channels where the main response is streamed via edits.
    const mentionPing = this.deps.mentionPing;
    if (mentionPing?.enabled) {
      const extractor = mentionPing.extractUserIds;
      const ids = extractor ? extractor(this.textAcc) : [];
      const deduped = [...new Set(ids)].slice(0, mentionPing.maxUsers);

      if (deduped.length > 0) {
        const { sessionRef } = this.deps;
        const anchor = this.lastMsg ?? this.firstMsg;
        if (!anchor) {
          throw new Error("DiscordOutputStream missing reply anchor");
        }

        const content = deduped.map((id) => `<@${id}>`).join(" ");

        const pingMsg = await anchor.reply({
          content,
          allowedMentions: {
            users: deduped,
            parse: [],
            repliedUser: false,
          },
        });

        if (isDiscordSessionRef(sessionRef)) {
          const ref = asDiscordMsgRef(sessionRef.channelId, pingMsg.id);
          this.created.push(ref);
          this.notifyCreated(ref);
        }
        this.lastMsg = pingMsg;
      }
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
    const reason = _reason;
    const isReanchor = reason === "reanchor";
    const isCancel = reason === "cancel";

    if (isCancel && this.textAcc.trim().length === 0) {
      this.textAcc = "Cancelled.";
    }

    if (isReanchor) {
      // Freeze the current message chain in a coherent state.
      // If we have not produced any text yet, replace emptiness with a placeholder.
      if (this.textAcc.trim().length === 0) {
        this.textAcc = "*Steering...*";
      }

      // Ensure the placeholder message exists so we can "freeze" it.
      await this.ensureStarted();
    }

    this.done.resolve();
    await this.running;

    // Best-effort: if we never started the embed pusher, the first message is still
    // the placeholder "Replying...". For cancels, rewrite it so the thread isn't left
    // in a confusing state.
    if (isCancel && this.firstMsg && !this.usedEmbedPusher) {
      await safeEdit(this.firstMsg, {
        content: this.textAcc || "Cancelled.",
      });
    }

    // Best-effort: remove controls when aborting.
    if (this.firstMsg && this.cancelCustomId) {
      await safeEdit(this.firstMsg, { components: [] });
    }

    // On reanchor, flush any buffered attachments so they aren't dropped.
    if (isReanchor) {
      const { sessionRef } = this.deps;
      if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
        const replyTo = this.lastMsg ?? this.firstMsg;
        if (replyTo) {
          const MAX_FILES = 10;
          for (let i = 0; i < this.pendingAttachments.length; i += MAX_FILES) {
            const chunk = this.pendingAttachments.slice(i, i + MAX_FILES);
            const msg = await replyTo.reply({
              files: toDiscordFiles(chunk),
              allowedMentions: { parse: [], repliedUser: false },
            });
            const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
            this.created.push(ref);
            this.notifyCreated(ref);
            this.lastMsg = msg;
          }
          this.pendingAttachments = [];
        }
      }
    }
  }
}

export async function sendDiscordStyledMessage(params: {
  client: Client;
  sessionRef: SessionRef;
  content: ContentOpts;
  opts?: StartOutputOpts;
  useSmartSplitting: boolean;
  rewriteText?: (text: string) => string;
}): Promise<MsgRef> {
  const { text, attachments } = normalizeContent(params.content);
  const out = new DiscordOutputStream({
    client: params.client,
    sessionRef: params.sessionRef,
    opts: params.opts,
    useSmartSplitting: params.useSmartSplitting,
    rewriteText: params.rewriteText,
  });

  for (const a of attachments) {
    await out.push({ type: "attachment.add", attachment: a });
  }
  await out.push({ type: "text.set", text });

  const res = await out.finish();
  return res.last;
}
