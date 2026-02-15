import { Colors, EmbedBuilder, type Message, type MessageEditOptions } from "discord.js";
import { setTimeout } from "node:timers/promises";

import { chunkMarkdownForEmbeds } from "./markdown-chunker";

export type SafeEdit = (msg: Message, options: Parameters<Message["edit"]>[0]) => Promise<boolean>;

const STREAMING_INDICATOR = " ⚪";
const EDIT_DELAY_MS = 250;
const CLOSING_TAG_BUFFER = 10;

const EMBED_COLOR_COMPLETE = Colors.Blue;
const EMBED_COLOR_INCOMPLETE = Colors.Yellow;

function buildActionsValue(lines: readonly string[]): string {
  const max = 4;
  const clamped = lines.slice(-max);
  return clamped.join("\n");
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
  thinkingValue?: string | null;
  actionsLines: readonly string[];
  statsLine?: string | null;
  isStreaming: boolean;
}): EmbedBuilder {
  const emb = new EmbedBuilder();
  emb.setDescription(params.description || "*<empty_string>*");
  emb.setColor(params.color);

  if (params.isStreaming && params.thinkingValue) {
    emb.addFields({
      name: "Thinking",
      value: params.thinkingValue,
      inline: false,
    });
  }

  if (params.isStreaming && params.actionsLines.length > 0) {
    emb.addFields({
      name: "Actions",
      value: buildActionsValue(params.actionsLines),
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
  getThinkingValue?: () => string | null;
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
  const sentThinking: string[] = [];
  const sentActions: string[] = [];
  const sentStats: string[] = [];

  let responseQueue: string[] = [];

  const syncToDiscord = async (content: string): Promise<boolean> => {
    const maxChunkLength = params.getMaxLength(false);
    const maxLastChunkLength = params.getMaxLength(true);

    let displayChunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength,
      useSmartSplitting: params.useSmartSplitting,
    });

    const thinkingValue = params.getThinkingValue?.() ?? null;
    const actionsLines = params.getActionsLines();
    const statsLine = params.getStatsLine?.() ?? null;

    // Allow tool progress (Actions) / stats to render before any text is produced.
    if (displayChunks.length === 0 && (!!thinkingValue || actionsLines.length > 0 || !!statsLine)) {
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
      const thinkingValueForChunk = showStreamIndicator ? thinkingValue : null;

      // Only show actions while streaming. Once done, actions disappear.
      const actionsValue =
        showStreamIndicator && actionsLines.length > 0 ? buildActionsValue(actionsLines) : "";

      const emb = buildEmbed({
        description,
        color,
        thinkingValue: thinkingValueForChunk,
        actionsLines,
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
        sentThinking[i] = thinkingValueForChunk ?? "";
        sentActions[i] = actionsValue;
        sentStats[i] = statsLineForChunk ?? "";
        didUpdate = true;
        continue;
      }

      if (
        sentDescriptions[i] !== description ||
        sentColors[i] !== color ||
        sentThinking[i] !== (thinkingValueForChunk ?? "") ||
        sentActions[i] !== actionsValue ||
        sentStats[i] !== (statsLineForChunk ?? "")
      ) {
        await params.safeEdit(chunkMessages[i]!, {
          embeds: [emb],
          ...firstExtras,
        });
        sentDescriptions[i] = description;
        sentColors[i] = color;
        sentThinking[i] = thinkingValueForChunk ?? "";
        sentActions[i] = actionsValue;
        sentStats[i] = statsLineForChunk ?? "";
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
