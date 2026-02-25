import { Colors, EmbedBuilder, type Message, type MessageEditOptions } from "discord.js";
import { setTimeout } from "node:timers/promises";

import { chunkMarkdownForEmbeds } from "./markdown-chunker";

export type SafeEdit = (msg: Message, options: Parameters<Message["edit"]>[0]) => Promise<boolean>;

const STREAMING_INDICATOR = " ⚪";
const EDIT_DELAY_MS = 250;
const CLOSING_TAG_BUFFER = 10;
const PROGRESS_HEARTBEAT_MS = 1_000;

const EMBED_COLOR_COMPLETE = Colors.Blue;
const EMBED_COLOR_INCOMPLETE = Colors.Yellow;

const PROGRESS_FIELD_MAX_CHARS = 500;
const EMBED_TITLE_MAX_CHARS = 256;

function clampWithEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function buildActionsValue(lines: readonly string[]): string {
  const max = 4;
  const clamped = lines.slice(-max);
  return clampWithEllipsis(clamped.join("\n"), PROGRESS_FIELD_MAX_CHARS);
}

function buildStatsValue(line: string): string {
  const wrapped = line.startsWith("*") && line.endsWith("*") ? line : `*${line}*`;
  const maxLength = 1024;
  const overflow = "...*";
  if (wrapped.length <= maxLength) return wrapped;
  return wrapped.slice(0, maxLength - overflow.length) + overflow;
}

function buildEmbed(params: {
  description: string;
  color: number;
  progressTitle?: string | null;
  reasoningValue?: string | null;
  actionsValue?: string | null;
  statsLine?: string | null;
  isStreaming: boolean;
}): EmbedBuilder {
  const emb = new EmbedBuilder();
  emb.setDescription(params.description || "*<empty_string>*");
  emb.setColor(params.color);

  if (params.isStreaming && params.progressTitle) {
    emb.setTitle(clampWithEllipsis(params.progressTitle, EMBED_TITLE_MAX_CHARS));
  }

  if (params.isStreaming && params.reasoningValue) {
    emb.addFields({
      name: "\u200b",
      value: clampWithEllipsis(params.reasoningValue, PROGRESS_FIELD_MAX_CHARS),
      inline: false,
    });
  }

  if (params.isStreaming && params.actionsValue) {
    emb.addFields({
      name: "\u200b",
      value: clampWithEllipsis(params.actionsValue, PROGRESS_FIELD_MAX_CHARS),
      inline: false,
    });
  }

  if (!params.isStreaming && params.statsLine) {
    emb.addFields({
      name: " ",
      value: buildStatsValue(params.statsLine),
      inline: false,
    });
  }

  return emb;
}

function addStreamingIndicator(chunk: string): string {
  const lines = chunk.split("\n");
  for (let j = lines.length - 1; j >= 0; j--) {
    const trimmed = (lines[j] ?? "").trim();
    if (trimmed.length === 0) continue;

    if (trimmed === "```" || trimmed === "$$") {
      return chunk + "\n" + STREAMING_INDICATOR.trimStart();
    }
    break;
  }

  return chunk + STREAMING_INDICATOR;
}

export async function startEmbedPusher(params: {
  createFirst: (emb: EmbedBuilder) => Promise<Message>;
  createReply: (parent: Message, emb: EmbedBuilder) => Promise<Message>;
  getContent: () => string;
  getProgressTitle?: () => string | null;
  getReasoningValue?: () => string | null;
  shouldHeartbeatProgress?: () => boolean;
  getActionsLines: () => readonly string[];
  getStatsLine?: () => string | null;
  getMaxLength: (isStreaming: boolean) => number;
  streamDone: Promise<void>;
  useSmartSplitting: boolean;
  safeEdit: SafeEdit;
  /**
   * Optional additional edit options for the FIRST message in the chain.
   * Used for surface controls (e.g. Cancel buttons) that must persist across edits.
   */
  getFirstMessageEditExtras?: (isStreaming: boolean) => Partial<MessageEditOptions>;
}): Promise<{
  lastMsg: Message;
  responseQueue: string[];
  discordMessageCreated: string[];
}> {
  let streaming = true;
  params.streamDone.then(() => {
    streaming = false;
  });

  const chunkMessages: Message[] = [];
  const discordMessageCreated: string[] = [];

  const sentDescriptions: string[] = [];
  const sentColors: number[] = [];
  const sentProgressTitle: string[] = [];
  const sentReasoning: string[] = [];
  const sentActions: string[] = [];
  const sentStats: string[] = [];

  let responseQueue: string[] = [];
  let lastProgressHeartbeatAt = 0;

  const syncToDiscord = async (content: string): Promise<boolean> => {
    const maxChunkLength = params.getMaxLength(false);
    const maxLastChunkLength = params.getMaxLength(true);

    let displayChunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength,
      useSmartSplitting: params.useSmartSplitting,
    });

    const progressTitle = params.getProgressTitle?.() ?? null;
    const reasoningValue = params.getReasoningValue?.() ?? null;
    const shouldHeartbeatProgress = params.shouldHeartbeatProgress?.() ?? false;
    const heartbeatDue =
      streaming &&
      shouldHeartbeatProgress &&
      Date.now() - lastProgressHeartbeatAt >= PROGRESS_HEARTBEAT_MS;
    const actionsLines = params.getActionsLines();
    const statsLine = params.getStatsLine?.() ?? null;

    // Allow progress / stats to render before any text is produced.
    if (
      displayChunks.length === 0 &&
      (!!progressTitle || !!reasoningValue || actionsLines.length > 0 || !!statsLine)
    ) {
      displayChunks = [""];
    }

    responseQueue = displayChunks;

    if (displayChunks.length === 0) {
      return false;
    }

    let didUpdate = false;

    for (let i = 0; i < displayChunks.length; i++) {
      const chunk = displayChunks[i] ?? "";
      const isLast = i === displayChunks.length - 1;
      const showStreamIndicator = streaming && isLast;

      const description = showStreamIndicator ? addStreamingIndicator(chunk) : chunk;
      const color = showStreamIndicator ? EMBED_COLOR_INCOMPLETE : EMBED_COLOR_COMPLETE;
      const statsLineForChunk = !showStreamIndicator && isLast ? statsLine : null;
      const progressTitleForChunk = showStreamIndicator ? progressTitle : null;
      const reasoningValueForChunk = showStreamIndicator ? reasoningValue : null;
      const shouldForceProgressHeartbeat =
        heartbeatDue && showStreamIndicator && Boolean(progressTitleForChunk);
      const actionsValueForChunk =
        showStreamIndicator && actionsLines.length > 0 ? buildActionsValue(actionsLines) : "";

      const emb = buildEmbed({
        description,
        color,
        progressTitle: progressTitleForChunk,
        reasoningValue: reasoningValueForChunk,
        actionsValue: actionsValueForChunk,
        statsLine: statsLineForChunk,
        isStreaming: showStreamIndicator,
      });

      const firstExtras =
        i === 0 && params.getFirstMessageEditExtras
          ? params.getFirstMessageEditExtras(streaming)
          : undefined;

      if (i >= chunkMessages.length) {
        const msg =
          i === 0
            ? await params.createFirst(emb)
            : await params.createReply(chunkMessages[i - 1]!, emb);

        chunkMessages.push(msg);
        discordMessageCreated.push(msg.id);
        sentDescriptions[i] = description;
        sentColors[i] = color;
        sentProgressTitle[i] = progressTitleForChunk ?? "";
        sentReasoning[i] = reasoningValueForChunk ?? "";
        sentActions[i] = actionsValueForChunk;
        sentStats[i] = statsLineForChunk ?? "";
        if (showStreamIndicator && progressTitleForChunk) {
          lastProgressHeartbeatAt = Date.now();
        }
        didUpdate = true;
        continue;
      }

      if (
        sentDescriptions[i] !== description ||
        sentColors[i] !== color ||
        sentProgressTitle[i] !== (progressTitleForChunk ?? "") ||
        sentReasoning[i] !== (reasoningValueForChunk ?? "") ||
        sentActions[i] !== actionsValueForChunk ||
        sentStats[i] !== (statsLineForChunk ?? "") ||
        shouldForceProgressHeartbeat
      ) {
        await params.safeEdit(chunkMessages[i]!, {
          embeds: [emb],
          ...firstExtras,
        });
        sentDescriptions[i] = description;
        sentColors[i] = color;
        sentProgressTitle[i] = progressTitleForChunk ?? "";
        sentReasoning[i] = reasoningValueForChunk ?? "";
        sentActions[i] = actionsValueForChunk;
        sentStats[i] = statsLineForChunk ?? "";
        if (showStreamIndicator && progressTitleForChunk) {
          lastProgressHeartbeatAt = Date.now();
        }
        didUpdate = true;
      }
    }

    return didUpdate;
  };

  while (true) {
    const content = params.getContent();
    const didUpdate = await syncToDiscord(content);

    if (!streaming) {
      if (!didUpdate) {
        break;
      }
      continue;
    }

    await setTimeout(EDIT_DELAY_MS);
  }

  const lastMsg = chunkMessages.at(-1);
  if (!lastMsg) {
    throw new Error("startEmbedPusher produced no messages");
  }

  return {
    lastMsg,
    responseQueue,
    discordMessageCreated,
  };
}

export function getEmbedPusherConstants() {
  return {
    STREAMING_INDICATOR,
    CLOSING_TAG_BUFFER,
  };
}
