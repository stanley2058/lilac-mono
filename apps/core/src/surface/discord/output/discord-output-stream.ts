import { Buffer } from "node:buffer";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  type Client,
  EmbedBuilder,
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
import type { ContentOpts, MsgRef, SessionRef, SurfaceAttachment } from "../../types";

// NOTE: We currently only guarantee "images on same message" when the attachments are
// known before the first outbound send. Attaching files to an existing Discord message
// via edit is not consistently supported across environments.

import { getEmbedPusherConstants, startEmbedPusher } from "./embed-pusher";
import { chunkMarkdownForEmbeds } from "./markdown-chunker";
import { buildCancelCustomId } from "../discord-cancel";

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

function isDiscordSessionRef(sessionRef: SessionRef): sessionRef is SessionRef & {
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
  return text.replace(/([\\*_`~|>[\]()])/g, "\\$1");
}

const PROGRESS_REASONING_MAX_CHARS = 500;
const WORKING_INDICATOR_ROTATE_MIN_MS = 4_000;
const WORKING_INDICATOR_ROTATE_MAX_MS = 9_000;
const PREVIEW_TEXT_TAIL_CHARS = 2000;

type DiscordOutputMode = "inline" | "preview";
const NOTIFY_PARSE_USERS = ["users"] as const;

function clampWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

export function clampReasoningDetail(
  text: string,
  maxChars = PROGRESS_REASONING_MAX_CHARS,
): string {
  if (maxChars <= 0) return "";

  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return clampWithEllipsis(normalized, maxChars);
}

export function formatReasoningAsBlockquote(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildWorkingTitle(input: {
  nowMs: number;
  startedAtMs: number;
  indicator: string;
}): string {
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const indicator = input.indicator.trim().length > 0 ? input.indicator.trim() : "Working";
  return `${indicator}... ${elapsedSec}s`;
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

export function toPreviewTail(text: string, maxChars = PREVIEW_TEXT_TAIL_CHARS): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return "...".slice(0, maxChars);
  return `...${text.slice(text.length - (maxChars - 3))}`;
}

export function buildOutputAllowedMentions(input: {
  notificationsEnabled: boolean;
  previewMode: boolean;
  isReply: boolean;
  isFinalLane: boolean;
}): MessageCreateOptions["allowedMentions"] {
  if (!input.notificationsEnabled) {
    return { parse: [], repliedUser: false };
  }

  // In preview mode, transient messages are deleted; avoid notifying from them.
  if (input.previewMode && !input.isFinalLane) {
    return { parse: [], repliedUser: false };
  }

  return {
    parse: [...NOTIFY_PARSE_USERS],
    repliedUser: input.isReply,
  };
}

function msgRefKey(ref: MsgRef): string {
  return `${ref.platform}:${ref.channelId}:${ref.messageId}`;
}

function buildFinalStatsFieldValue(line: string): string {
  const wrapped = line.startsWith("*") && line.endsWith("*") ? line : `*${line}*`;
  const maxLength = 1024;
  const overflow = "...*";
  if (wrapped.length <= maxLength) return wrapped;
  return wrapped.slice(0, maxLength - overflow.length) + overflow;
}

async function fetchTextChannel(client: Client, channelId: string): Promise<TextBasedChannel> {
  const ch = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
  if (!ch || !("send" in ch)) {
    throw new Error(`Discord channel not found or not text-based: ${channelId}`);
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

  const messagesApi = (
    channel as unknown as {
      messages?: { fetch: (messageId: string) => Promise<Message> };
    }
  ).messages;

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

function toDiscordFiles(attachments: readonly SurfaceAttachment[]): MessageCreateOptions["files"] {
  if (attachments.length === 0) return undefined;

  // discord.js `AttachmentPayload` supports `attachment` + `name`. Discord infers the
  // mime-type from the filename; passing `contentType` is not part of the public type.
  return attachments.map((a) => ({
    attachment: Buffer.from(a.bytes),
    name: a.filename,
  }));
}

async function safeEdit(msg: Message, options: Parameters<Message["edit"]>[0]): Promise<boolean> {
  try {
    await msg.edit(options);
    return true;
  } catch {
    return false;
  }
}

export class DiscordOutputStream implements SurfaceOutputStream {
  private readonly created: MsgRef[] = [];
  private readonly transientPreviewRefs: MsgRef[] = [];
  private readonly transientPreviewRefKeys = new Set<string>();
  private readonly toolLines: Array<{ toolCallId: string; line: string }> = [];
  private readonly requestStartedAtMs: number;
  private readonly workingIndicators: readonly string[];
  private statsForNerdsLine: string | null = null;
  private hasReasoningStatus = false;
  private reasoningDetailText = "";
  private activeWorkingIndicator = "";
  private nextWorkingIndicatorRotateAtMs = 0;

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
      outputMode: DiscordOutputMode;
      outputNotification?: boolean;
      reasoningDisplayMode: "none" | "simple" | "detailed";
      workingIndicators: readonly string[];
    },
  ) {
    const startTs = this.deps.opts?.requestStartedAtMs;
    this.requestStartedAtMs =
      typeof startTs === "number" && Number.isFinite(startTs) ? Math.max(0, startTs) : Date.now();

    const normalizedIndicators = this.deps.workingIndicators
      .map((word) => word.trim())
      .filter((word) => word.length > 0);

    this.workingIndicators = normalizedIndicators.length > 0 ? normalizedIndicators : ["Working"];

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

  private isPreviewMode(): boolean {
    return this.deps.outputMode === "preview";
  }

  private trackTransientPreviewRef(ref: MsgRef): void {
    if (!this.isPreviewMode()) return;

    const key = msgRefKey(ref);
    if (this.transientPreviewRefKeys.has(key)) return;
    this.transientPreviewRefKeys.add(key);
    this.transientPreviewRefs.push(ref);
  }

  private getRenderedText(): string {
    const rewrite = this.deps.rewriteText;
    return rewrite ? rewrite(this.textAcc) : this.textAcc;
  }

  private getStreamingDisplayText(): string {
    const rendered = this.getRenderedText();
    if (!this.isPreviewMode()) return rendered;
    return toPreviewTail(rendered);
  }

  private getAllowedMentions(input: {
    isReply: boolean;
    isFinalLane: boolean;
  }): MessageCreateOptions["allowedMentions"] {
    return buildOutputAllowedMentions({
      notificationsEnabled: this.deps.outputNotification === true,
      previewMode: this.isPreviewMode(),
      isReply: input.isReply,
      isFinalLane: input.isFinalLane,
    });
  }

  private async deleteTransientPreviewMessages(): Promise<void> {
    if (!this.isPreviewMode()) return;
    if (this.transientPreviewRefs.length === 0) return;

    const refs = [...this.transientPreviewRefs];
    this.transientPreviewRefs.length = 0;
    this.transientPreviewRefKeys.clear();

    for (let i = refs.length - 1; i >= 0; i--) {
      const ref = refs[i];
      if (!ref) continue;
      await this.deleteMessageRef(ref).catch(() => undefined);
    }
  }

  private async deleteMessageRef(ref: MsgRef): Promise<void> {
    const { client } = this.deps;
    if (ref.platform !== "discord") return;

    const channel = await client.channels.fetch(ref.channelId).catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return;
    }

    const msg = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!msg) return;
    await msg.delete().catch(() => undefined);
  }

  private shouldShowProgressTitle(): boolean {
    if (this.toolLines.length > 0) return true;
    return this.deps.reasoningDisplayMode !== "none" && this.hasReasoningStatus;
  }

  private scheduleNextWorkingIndicatorRotation(nowMs: number): void {
    const spread = WORKING_INDICATOR_ROTATE_MAX_MS - WORKING_INDICATOR_ROTATE_MIN_MS;
    const randomOffset = Math.floor(Math.random() * (spread + 1));
    this.nextWorkingIndicatorRotateAtMs = nowMs + WORKING_INDICATOR_ROTATE_MIN_MS + randomOffset;
  }

  private pickRandomWorkingIndicator(previous?: string): string {
    if (this.workingIndicators.length === 0) return "Working";
    if (this.workingIndicators.length === 1) return this.workingIndicators[0] ?? "Working";

    const choices = this.workingIndicators.filter((value) => value !== previous);
    const pool = choices.length > 0 ? choices : this.workingIndicators;
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx] ?? this.workingIndicators[0] ?? "Working";
  }

  private getWorkingIndicator(nowMs: number): string {
    if (this.activeWorkingIndicator.length === 0) {
      this.activeWorkingIndicator = this.pickRandomWorkingIndicator();
      this.scheduleNextWorkingIndicatorRotation(nowMs);
      return this.activeWorkingIndicator;
    }

    if (
      this.workingIndicators.length > 1 &&
      this.nextWorkingIndicatorRotateAtMs > 0 &&
      nowMs >= this.nextWorkingIndicatorRotateAtMs
    ) {
      this.activeWorkingIndicator = this.pickRandomWorkingIndicator(this.activeWorkingIndicator);
      this.scheduleNextWorkingIndicatorRotation(nowMs);
    }

    return this.activeWorkingIndicator;
  }

  private getProgressTitle(): string | null {
    if (!this.shouldShowProgressTitle()) return null;

    const nowMs = Date.now();
    const indicator = this.getWorkingIndicator(nowMs);
    return buildWorkingTitle({
      nowMs,
      startedAtMs: this.requestStartedAtMs,
      indicator,
    });
  }

  private getReasoningValue(): string | null {
    if (this.deps.reasoningDisplayMode !== "detailed") return null;

    const clamped = clampReasoningDetail(this.reasoningDetailText, PROGRESS_REASONING_MAX_CHARS);
    if (!clamped) return null;

    return clampWithEllipsis(formatReasoningAsBlockquote(clamped), PROGRESS_REASONING_MAX_CHARS);
  }

  private isProgressTimerLive(): boolean {
    return this.shouldShowProgressTitle();
  }

  private async ensureStarted(): Promise<void> {
    if (this.running) return;

    const { client, sessionRef } = this.deps;
    if (!isDiscordSessionRef(sessionRef)) throw new Error("Unsupported platform");

    const channel = await fetchTextChannel(client, sessionRef.channelId);
    if (!("send" in channel)) throw new Error("Discord channel not found");

    // Delay creating the first message until either:
    // - we have something to display (text/action), or
    // - finish() is called.
    //
    // In preview mode, attachments are intentionally sent *after* the final reply.
    // In inline mode, we keep the old behavior of attaching files to the first message.
    const MAX_FILES = 10;

    this.cancelCustomId = (() => {
      const requestId = this.deps.opts?.requestId;
      return requestId ? buildCancelCustomId({ sessionId: sessionRef.channelId, requestId }) : null;
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

    const includeInitialAttachments = !this.isPreviewMode();
    const initialAttachments =
      resumed || !includeInitialAttachments ? [] : this.pendingAttachments.slice(0, MAX_FILES);
    const remainingAttachments =
      resumed || !includeInitialAttachments
        ? this.pendingAttachments.slice()
        : this.pendingAttachments.slice(MAX_FILES);

    const first =
      resumedMessages[0] ??
      (await channel.send({
        // content must be non-empty to avoid Discord errors when sending only embeds.
        content: "*Replying...*",
        reply:
          this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
            ? { messageReference: this.deps.opts.replyTo.messageId }
            : undefined,
        files: toDiscordFiles(initialAttachments),
        components: buildCancelComponents(true),
        allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: false }),
      }));

    this.firstMsg = first;
    if (resumed) {
      const seen = new Set<string>();
      for (const m of resumedMessages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const ref = asDiscordMsgRef(sessionRef.channelId, m.id);
        this.created.push(ref);
        this.trackTransientPreviewRef(ref);
      }
      this.lastMsg = resumedMessages[resumedMessages.length - 1] ?? first;
    } else {
      const ref = asDiscordMsgRef(sessionRef.channelId, first.id);
      this.created.push(ref);
      this.trackTransientPreviewRef(ref);
      this.notifyCreated(ref);
    }

    // Keep overflow/new attachments for follow-up messages.
    this.pendingAttachments = remainingAttachments;

    // Special case: attachments-only output (no text and no tool lines).
    // In this case we don't start the embed pusher at all.
    if (
      this.textAcc.length === 0 &&
      this.toolLines.length === 0 &&
      !this.hasReasoningStatus &&
      this.statsForNerdsLine === null
    ) {
      this.lastMsg = first;
      this.running = Promise.resolve();
      return;
    }

    const { STREAMING_INDICATOR, CLOSING_TAG_BUFFER } = getEmbedPusherConstants();

    const getMaxLength = (isStreaming: boolean) => {
      const max = 4096;
      if (!isStreaming) {
        return max - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
      }
      return (
        max - STREAMING_INDICATOR.length - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0)
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
            allowedMentions: this.getAllowedMentions({ isReply: false, isFinalLane: false }),
          });

          // Notify immediately so the router can treat replies-to-this message as "active".
          const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
          this.created.push(ref);
          this.trackTransientPreviewRef(ref);
          this.notifyCreated(ref);
          return msg;
        },
        getContent: () => this.getStreamingDisplayText(),
        getProgressTitle: () => this.getProgressTitle(),
        getReasoningValue: () => this.getReasoningValue(),
        shouldHeartbeatProgress: () => this.isProgressTimerLive(),
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
        const ref = asDiscordMsgRef(sessionRef.channelId, messageId);
        this.created.push(ref);
        this.trackTransientPreviewRef(ref);
        seen.add(messageId);
      }

      this.lastMsg = res.lastMsg;

      // IMPORTANT: never delete the message that carries files.
      // We keep `first` as the stable anchor and rely on embed replies for the visible response.
      // If no embeds were created, turn `first` into the final plain message.
      if (res.discordMessageCreated.length === 0) {
        const content = this.getStreamingDisplayText();
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
      case "reasoning.status": {
        if (this.deps.reasoningDisplayMode === "none") {
          return;
        }
        this.hasReasoningStatus = true;
        this.reasoningDetailText = part.update.detailText ?? "";
        await this.ensureStarted();
        return;
      }
      case "tool.status": {
        const line = buildToolLine(part.update);
        const idx = this.toolLines.findIndex((t) => t.toolCallId === part.update.toolCallId);
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

  private async flushPendingAttachments(replyTo: Message): Promise<MsgRef[]> {
    const { sessionRef } = this.deps;
    if (!isDiscordSessionRef(sessionRef)) return [];
    if (this.pendingAttachments.length === 0) return [];

    const MAX_FILES = 10;
    const created: MsgRef[] = [];

    for (let i = 0; i < this.pendingAttachments.length; i += MAX_FILES) {
      const chunk = this.pendingAttachments.slice(i, i + MAX_FILES);
      const msg = await replyTo.reply({
        files: toDiscordFiles(chunk),
        allowedMentions: { parse: [], repliedUser: false },
      });

      const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
      created.push(ref);
      this.created.push(ref);
      this.notifyCreated(ref);
      this.lastMsg = msg;
    }

    this.pendingAttachments = [];
    return created;
  }

  private async postFinalReplyEmbeds(): Promise<{ created: MsgRef[]; lastMsg: Message }> {
    const { client, sessionRef } = this.deps;
    if (!isDiscordSessionRef(sessionRef)) {
      throw new Error("Unsupported platform");
    }

    const channel = await fetchTextChannel(client, sessionRef.channelId);
    if (!("send" in channel)) {
      throw new Error("Discord channel not found");
    }
    const sendChannel = channel as TextBasedChannel & {
      send: (options: MessageCreateOptions) => Promise<Message>;
    };
    const { CLOSING_TAG_BUFFER } = getEmbedPusherConstants();
    const fullText = this.getRenderedText();
    const content = fullText.length > 0 ? fullText : "*<empty_string>*";

    const maxChunkLength = 4096 - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
    const chunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength: maxChunkLength,
      useSmartSplitting: this.deps.useSmartSplitting,
    });

    const displayChunks = chunks.length > 0 ? chunks : ["*<empty_string>*"];
    const createdMsgs: Message[] = [];
    let parent: Message | null = null;

    for (let i = 0; i < displayChunks.length; i++) {
      const chunk = displayChunks[i] ?? "";
      const isLast = i === displayChunks.length - 1;

      const emb = new EmbedBuilder()
        .setDescription(chunk || "*<empty_string>*")
        .setColor(Colors.Blue);

      if (isLast && this.statsForNerdsLine) {
        emb.addFields({
          name: " ",
          value: buildFinalStatsFieldValue(this.statsForNerdsLine),
          inline: false,
        });
      }

      const msg: Message =
        parent === null
          ? await sendChannel.send({
              embeds: [emb],
              reply:
                this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
                  ? { messageReference: this.deps.opts.replyTo.messageId }
                  : undefined,
              allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: true }),
            })
          : await parent.reply({
              embeds: [emb],
              allowedMentions: this.getAllowedMentions({ isReply: false, isFinalLane: true }),
            });

      createdMsgs.push(msg);
      parent = msg;
    }

    const created: MsgRef[] = [];
    for (const msg of createdMsgs) {
      const ref = asDiscordMsgRef(sessionRef.channelId, msg.id);
      created.push(ref);
      this.created.push(ref);
      this.notifyCreated(ref);
    }

    const lastMsg = createdMsgs[createdMsgs.length - 1];
    if (!lastMsg) {
      throw new Error("DiscordOutputStream produced no final messages");
    }

    this.lastMsg = lastMsg;
    return {
      created,
      lastMsg,
    };
  }

  async finish(): Promise<SurfaceOutputResult> {
    await this.ensureStarted();

    this.done.resolve();
    await this.running;

    if (this.isPreviewMode()) {
      const finalReplyPromise = this.postFinalReplyEmbeds();
      const deletePreviewPromise = this.deleteTransientPreviewMessages().catch(() => undefined);

      const finalReply = await finalReplyPromise;
      await deletePreviewPromise;

      const attachmentCreated = await this.flushPendingAttachments(finalReply.lastMsg);
      const created = [...finalReply.created, ...attachmentCreated];
      const last = created.at(-1);

      if (!last) {
        throw new Error("DiscordOutputStream produced no final messages");
      }

      return {
        created,
        last,
      };
    }

    // If we never started the embed pusher (attachments-only), remove the cancel control.
    if (this.firstMsg && this.cancelCustomId) {
      await safeEdit(this.firstMsg, { components: [] });
    }

    const { sessionRef } = this.deps;
    if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
      const replyTo = this.lastMsg ?? this.firstMsg;
      if (!replyTo) {
        throw new Error("DiscordOutputStream missing reply anchor");
      }
      await this.flushPendingAttachments(replyTo);
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
    const isReanchor = reason === "reanchor" || reason === "reanchor_interrupt";
    const isInterruptReanchor = reason === "reanchor_interrupt";
    const isCancel = reason === "cancel";

    if (isCancel && this.textAcc.trim().length === 0) {
      this.textAcc = "Cancelled.";
    }

    if (isReanchor) {
      // Freeze the current message chain in a coherent state.
      // If we have not produced any text yet, replace emptiness with a placeholder.
      if (this.textAcc.trim().length === 0) {
        this.textAcc = isInterruptReanchor ? "*Interrupted...*" : "*Steering...*";
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

      // Keep frozen preview lane messages after reanchor so reply-thread
      // lineage remains intact for follow-up steering turns.
    }
  }

  getFinalTextMode(): "continuation" | "full" {
    return this.isPreviewMode() ? "full" : "continuation";
  }
}

export async function sendDiscordStyledMessage(params: {
  client: Client;
  sessionRef: SessionRef;
  content: ContentOpts;
  opts?: StartOutputOpts;
  useSmartSplitting: boolean;
  rewriteText?: (text: string) => string;
  outputNotification?: boolean;
}): Promise<MsgRef> {
  const { text, attachments } = normalizeContent(params.content);
  const out = new DiscordOutputStream({
    client: params.client,
    sessionRef: params.sessionRef,
    opts: params.opts,
    useSmartSplitting: params.useSmartSplitting,
    rewriteText: params.rewriteText,
    outputMode: "inline",
    outputNotification: params.outputNotification,
    reasoningDisplayMode: "none",
    workingIndicators: ["Working"],
  });

  for (const a of attachments) {
    await out.push({ type: "attachment.add", attachment: a });
  }
  await out.push({ type: "text.set", text });

  const res = await out.finish();
  return res.last;
}
