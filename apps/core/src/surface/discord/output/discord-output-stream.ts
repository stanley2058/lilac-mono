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
import { isSubagentToolDisplay, mergeSubagentToolStatus } from "../../subagent-tool-status";
import type { MarkdownTableRenderOptions } from "../../../shared/markdown-table-renderer";

// Attachments are buffered during streaming and finalized on the terminal message.

import { getEmbedPusherConstants, startEmbedPusher } from "./embed-pusher";
import { chunkMarkdownForEmbeds } from "./markdown-chunker";
import { normalizeDiscordBlockquotes } from "./discord-markdown-normalize";
import { renderMarkdownTablesAsCodeBlocks } from "../../../shared/markdown-table-renderer";
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
const WORKING_INDICATOR_ROTATE_MIN_MS = 10_000;
const WORKING_INDICATOR_ROTATE_MAX_MS = 30_000;
const TASK_CHANGE_FORCE_ROTATE_MIN_WORD_AGE_MS = 5_000;
const THINKING_SPINNER_FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"] as const;
const THINKING_SPINNER_TICK_MS = 250;
const PREVIEW_TEXT_TAIL_CHARS = 2000;
const DISCORD_CONTENT_MAX_CHARS = 2000;
const PROGRESS_MAX_LINES = 5;
const SUBAGENT_MODEL_MAX_CHARS = 12;
const SUBAGENT_MODEL_HEAD_CHARS = 2;
const SUBAGENT_MODEL_TAIL_CHARS = 7;
const SUBAGENT_CHILD_DISPLAY_MAX_CHARS = 48;
const SUBAGENT_CURRENT_TOOL_MAX_CHARS = 16;
const PROGRESS_LINE_MAX_CHARS = 90;

type DiscordOutputMode = "inline" | "preview";
type DiscordPreviewFinalOutputStyle = "embed" | "plain";
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
  const frameIdx =
    Math.floor(elapsedMs / THINKING_SPINNER_TICK_MS) % THINKING_SPINNER_FRAMES.length;
  const spinner = THINKING_SPINNER_FRAMES[frameIdx] ?? THINKING_SPINNER_FRAMES[0];
  const indicator = input.indicator.trim().length > 0 ? input.indicator.trim() : "Working";
  return `${spinner} ${indicator}... ${elapsedSec}s`;
}

function isBatchToolDisplay(display: string): boolean {
  const trimmed = display.trimStart();
  // Back-compat: older displays used "[batch]".
  return trimmed.startsWith("batch") || trimmed.startsWith("[batch]");
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

  if (update.status === "update") {
    return `… ${escapedDisplay}`;
  }

  if (update.ok) {
    return `✓ ${escapedDisplay}`;
  }

  return `✗ ${escapedDisplay}`;
}

export type DiscordProgressEntry = {
  toolCallId: string;
  update: SurfaceToolStatusUpdate;
  updatedSeq: number;
};

type ParsedSubagentChild = {
  icon: ">" | "+" | "x";
  display: string;
};

type ParsedSubagentDisplay = {
  profile: string;
  model?: string;
  effort?: string;
  done?: number;
  total?: number;
  state?: string;
  children: ParsedSubagentChild[];
};

const SUBAGENT_STATES = new Set([
  "starting",
  "queued",
  "running",
  "blocked",
  "resolved",
  "failed",
  "cancelled",
  "timeout",
]);

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "no",
  minimal: "mi",
  low: "lo",
  medium: "md",
  high: "hi",
  xhigh: "xh",
};

function truncateMiddle(
  input: string,
  maxChars: number,
  headChars: number,
  tailChars: number,
): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, headChars)}...${input.slice(-tailChars)}`;
}

function parseSubagentDisplay(display: string): ParsedSubagentDisplay | null {
  const [rawHeader = "", ...rawChildren] = display.trim().split("\n");
  const header = rawHeader.trim();
  const delegateMatch = /^subagent_delegate\s+\((explore|general|self)\)/u.exec(header);
  if (delegateMatch?.[1]) {
    return { profile: delegateMatch[1], state: "starting", children: [] };
  }
  const match = /^(?:subagent|\[subagent\])\s*\((.*)\)$/u.exec(header);
  if (!match) return null;

  const segments = (match[1] ?? "")
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const profile = segments.shift() ?? "agent";
  let model: string | undefined;
  let effort: string | undefined;
  let done: number | undefined;
  let total: number | undefined;
  let state: string | undefined;

  for (const segment of segments) {
    const countMatch = /^(\d+)\/(\d+)(?:\s+done)?$/u.exec(segment);
    if (countMatch) {
      done = Number(countMatch[1]);
      total = Number(countMatch[2]);
      continue;
    }
    if (SUBAGENT_STATES.has(segment)) {
      state = segment;
      continue;
    }
    if (!model && !state) {
      const modelMatch = /^(.*?)(?:\s+\[([^\]]+)\])?$/u.exec(segment);
      const candidate = modelMatch?.[1]?.trim();
      if (candidate) {
        model = candidate;
        effort = modelMatch?.[2]?.trim() || undefined;
      }
    }
  }

  const children = rawChildren.flatMap((line): ParsedSubagentChild[] => {
    const childMatch = /^(?:\|-|`-)\s+([>+x])\s+(.+)$/u.exec(line.trim());
    if (!childMatch) return [];
    const icon = childMatch[1];
    const childDisplay = childMatch[2]?.trim();
    if ((icon !== ">" && icon !== "+" && icon !== "x") || !childDisplay) return [];
    return [{ icon, display: childDisplay }];
  });

  return {
    profile,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(done !== undefined ? { done } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(state ? { state } : {}),
    children,
  };
}

function statusIcon(update: SurfaceToolStatusUpdate): "▶" | "…" | "✓" | "✗" {
  if (update.status === "start") return "▶";
  if (update.status === "update") return "…";
  return update.ok ? "✓" : "✗";
}

function currentToolName(parsed: ParsedSubagentDisplay): string | null {
  const child = [...parsed.children].reverse().find((candidate) => candidate.icon === ">") ?? null;
  if (!child) return null;
  const bracketed = /^\[([^\]]+)\]/u.exec(child.display)?.[1];
  const tool = bracketed ?? child.display.split(/[\s(]/u, 1)[0];
  if (!tool) return null;
  return clampWithEllipsis(tool, SUBAGENT_CURRENT_TOOL_MAX_CHARS);
}

function buildSubagentHeader(
  entry: DiscordProgressEntry,
  parsed: ParsedSubagentDisplay | null,
  includeCurrentTool: boolean,
): string {
  if (!parsed) return `${statusIcon(entry.update)} agent (starting)`;

  const details: string[] = [];
  if (parsed.model) {
    const model = truncateMiddle(
      parsed.model,
      SUBAGENT_MODEL_MAX_CHARS,
      SUBAGENT_MODEL_HEAD_CHARS,
      SUBAGENT_MODEL_TAIL_CHARS,
    );
    const effort = parsed.effort ? EFFORT_LABELS[parsed.effort] : undefined;
    details.push(`${model}${effort ? ` [${effort}]` : ""}`);
  }
  if (parsed.done !== undefined && parsed.total !== undefined) {
    details.push(`${parsed.done}/${parsed.total}`);
  } else if (parsed.state) {
    details.push(
      parsed.state === "running" || parsed.state === "queued" ? "starting" : parsed.state,
    );
  }
  if (includeCurrentTool) {
    const currentTool = currentToolName(parsed);
    if (currentTool) details.push(currentTool);
  }
  if (details.length === 0) details.push("starting");

  return `${statusIcon(entry.update)} ${escapeDiscordMarkdown(
    `${parsed.profile} (${details.join("; ")})`,
  )}`;
}

function buildSubagentChildLines(parsed: ParsedSubagentDisplay, maxChildren: number): string[] {
  const children = parsed.children.slice(-maxChildren);
  return children.map((child, index) => {
    const branch = index === children.length - 1 ? "`-" : "|-";
    const display = clampWithEllipsis(
      child.display.replace(/\s+/gu, " ").trim(),
      SUBAGENT_CHILD_DISPLAY_MAX_CHARS,
    );
    return escapeDiscordMarkdown(`${branch} ${child.icon} ${display}`);
  });
}

export function buildDiscordProgressLines(input: {
  tools: readonly DiscordProgressEntry[];
  subagents: readonly DiscordProgressEntry[];
}): string[] {
  const rankedSubagents = [...input.subagents].sort((a, b) => {
    const activeDelta = Number(b.update.status !== "end") - Number(a.update.status !== "end");
    return activeDelta || b.updatedSeq - a.updatedSeq;
  });
  const visibleSubagents = rankedSubagents.slice(0, 3);
  const overflow = Math.max(0, rankedSubagents.length - visibleSubagents.length);
  const agentLines: string[] = [];

  if (rankedSubagents.length === 1) {
    const entry = visibleSubagents[0];
    if (entry) {
      const parsed = parseSubagentDisplay(entry.update.display);
      agentLines.push(buildSubagentHeader(entry, parsed, false));
      if (entry.update.status !== "end" && parsed) {
        agentLines.push(...buildSubagentChildLines(parsed, 2));
      }
    }
  } else if (rankedSubagents.length === 2) {
    for (const entry of visibleSubagents) {
      const parsed = parseSubagentDisplay(entry.update.display);
      agentLines.push(buildSubagentHeader(entry, parsed, false));
      if (entry.update.status !== "end" && parsed) {
        agentLines.push(...buildSubagentChildLines(parsed, 1));
      }
    }
  } else {
    for (const entry of visibleSubagents) {
      const parsed = parseSubagentDisplay(entry.update.display);
      agentLines.push(buildSubagentHeader(entry, parsed, true));
    }
  }

  if (overflow > 0 && agentLines.length > 0) {
    const lastIndex = agentLines.length - 1;
    agentLines[lastIndex] = `${agentLines[lastIndex]} · +${overflow} more`;
  }

  let remainingToolLines = Math.max(0, PROGRESS_MAX_LINES - agentLines.length);
  const toolChunks: string[][] = [];
  const toolsByRecency = [...input.tools].sort((a, b) => b.updatedSeq - a.updatedSeq);
  for (const entry of toolsByRecency) {
    if (remainingToolLines === 0) break;
    const rows = buildToolLine(entry.update).split("\n");
    const selectedRows =
      rows.length <= remainingToolLines
        ? rows
        : remainingToolLines === 1
          ? rows.slice(0, 1)
          : [rows[0]!, ...rows.slice(-(remainingToolLines - 1))];
    toolChunks.unshift(selectedRows);
    remainingToolLines -= selectedRows.length;
  }

  return [...toolChunks.flat(), ...agentLines]
    .slice(-PROGRESS_MAX_LINES)
    .map((line) => clampWithEllipsis(line, PROGRESS_LINE_MAX_CHARS));
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

function createWorkingIndicatorQueue(indicators: readonly string[]): string[] {
  if (indicators.length <= 1) return [...indicators];

  const queue = [...indicators];

  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const atI = queue[i];
    const atJ = queue[j];
    if (atI === undefined || atJ === undefined) continue;
    queue[i] = atJ;
    queue[j] = atI;
  }

  return queue;
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
  private readonly toolLines: DiscordProgressEntry[] = [];
  private readonly subagentLines: DiscordProgressEntry[] = [];
  private progressUpdateSeq = 0;
  private readonly requestStartedAtMs: number;
  private readonly workingIndicators: readonly string[];
  private readonly workingIndicatorQueue: string[];
  private statsForNerdsLine: string | null = null;
  private hasReasoningStatus = false;
  private reasoningDetailText = "";
  private activeWorkingIndicator = "";
  private activeWorkingIndicatorSetAtMs = 0;
  private nextWorkingIndicatorRotateAtMs = 0;
  private latestTaskProgressKey: string | null = null;
  private pendingTaskDrivenIndicatorChange = false;

  private textAcc = "";
  private pendingAttachments: SurfaceAttachment[] = [];

  private firstMsg: Message | null = null;
  private lastMsg: Message | null = null;
  private readonly done: { promise: Promise<void>; resolve(): void };

  private cancelCustomId: string | null = null;

  private running: Promise<void> | null = null;
  private usedEmbedPusher = false;
  private renderedTextCacheInput: string | null = null;
  private renderedTextCacheOutput = "";

  constructor(
    private readonly deps: {
      client: Client;
      sessionRef: SessionRef;
      opts?: StartOutputOpts;
      useSmartSplitting: boolean;
      rewriteText?: (text: string) => string;
      markdownTableRender?: MarkdownTableRenderOptions;
      outputMode: DiscordOutputMode;
      outputPreviewModeFinalStyle?: DiscordPreviewFinalOutputStyle;
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
    this.workingIndicatorQueue = createWorkingIndicatorQueue(this.workingIndicators);

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
    if (this.renderedTextCacheInput === this.textAcc) {
      return this.renderedTextCacheOutput;
    }

    const rewrite = this.deps.rewriteText;
    let rendered = rewrite ? rewrite(this.textAcc) : this.textAcc;
    rendered = normalizeDiscordBlockquotes(rendered);

    const tableRender = this.deps.markdownTableRender;
    if (tableRender) {
      rendered = renderMarkdownTablesAsCodeBlocks(rendered, tableRender);
    }

    this.renderedTextCacheInput = this.textAcc;
    this.renderedTextCacheOutput = rendered;
    return rendered;
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
    if (this.toolLines.length > 0 || this.subagentLines.length > 0) return true;
    return this.deps.reasoningDisplayMode !== "none" && this.hasReasoningStatus;
  }

  private scheduleNextWorkingIndicatorRotation(nowMs: number): void {
    const spread = WORKING_INDICATOR_ROTATE_MAX_MS - WORKING_INDICATOR_ROTATE_MIN_MS;
    const randomOffset = Math.floor(Math.random() * (spread + 1));
    this.nextWorkingIndicatorRotateAtMs = nowMs + WORKING_INDICATOR_ROTATE_MIN_MS + randomOffset;
  }

  private markTaskProgress(nextTaskKey: string): void {
    if (this.latestTaskProgressKey === nextTaskKey) return;
    this.latestTaskProgressKey = nextTaskKey;
    this.pendingTaskDrivenIndicatorChange = true;
  }

  private rotateWorkingIndicator(nowMs: number): void {
    this.activeWorkingIndicator = this.pickRandomWorkingIndicator(this.activeWorkingIndicator);
    this.activeWorkingIndicatorSetAtMs = nowMs;
    this.pendingTaskDrivenIndicatorChange = false;
    this.scheduleNextWorkingIndicatorRotation(nowMs);
  }

  private pickRandomWorkingIndicator(previous?: string): string {
    if (this.workingIndicatorQueue.length === 0) return "Working";
    if (this.workingIndicatorQueue.length === 1) {
      return this.workingIndicatorQueue[0] ?? "Working";
    }

    const next = this.workingIndicatorQueue.shift();
    if (!next) return this.workingIndicators[0] ?? "Working";

    if (previous && next === previous) {
      const alternate = this.workingIndicatorQueue.shift();
      if (alternate) {
        this.workingIndicatorQueue.push(next);
        this.workingIndicatorQueue.push(alternate);
        return alternate;
      }
    }

    this.workingIndicatorQueue.push(next);
    return next;
  }

  private getWorkingIndicator(nowMs: number): string {
    if (this.activeWorkingIndicator.length === 0) {
      this.activeWorkingIndicator = this.pickRandomWorkingIndicator();
      this.activeWorkingIndicatorSetAtMs = nowMs;
      this.pendingTaskDrivenIndicatorChange = false;
      this.scheduleNextWorkingIndicatorRotation(nowMs);
      return this.activeWorkingIndicator;
    }

    if (this.workingIndicators.length < 2) {
      this.pendingTaskDrivenIndicatorChange = false;
      return this.activeWorkingIndicator;
    }

    const workingIndicatorAgeMs = Math.max(0, nowMs - this.activeWorkingIndicatorSetAtMs);
    const shouldForceRotateForTaskProgress =
      this.pendingTaskDrivenIndicatorChange &&
      workingIndicatorAgeMs >= TASK_CHANGE_FORCE_ROTATE_MIN_WORD_AGE_MS;

    if (shouldForceRotateForTaskProgress) {
      this.rotateWorkingIndicator(nowMs);
      return this.activeWorkingIndicator;
    }

    if (this.nextWorkingIndicatorRotateAtMs > 0 && nowMs >= this.nextWorkingIndicatorRotateAtMs) {
      this.rotateWorkingIndicator(nowMs);
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
    // Attachments are finalized later (finish/abort) so they land on the terminal message.

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

    const first =
      resumedMessages[0] ??
      (await channel.send({
        // content must be non-empty to avoid Discord errors when sending only embeds.
        content: "*Replying...*",
        reply:
          this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
            ? { messageReference: this.deps.opts.replyTo.messageId }
            : undefined,
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

    // Special case: attachments-only output (no text and no tool lines).
    // In this case we don't start the embed pusher at all.
    if (
      this.textAcc.length === 0 &&
      this.toolLines.length === 0 &&
      this.subagentLines.length === 0 &&
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
          buildDiscordProgressLines({ tools: this.toolLines, subagents: this.subagentLines }),
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
        if (!this.hasReasoningStatus) {
          this.markTaskProgress("reasoning");
        }
        this.hasReasoningStatus = true;
        this.reasoningDetailText = part.update.detailText ?? "";
        await this.ensureStarted();
        return;
      }
      case "tool.status": {
        if (part.update.status === "start" || part.update.status === "update") {
          this.markTaskProgress(`tool:${part.update.toolCallId}`);
        }
        const subagentIdx = this.subagentLines.findIndex(
          (entry) => entry.toolCallId === part.update.toolCallId,
        );
        const isSubagent = subagentIdx >= 0 || isSubagentToolDisplay(part.update.display);
        const entries = isSubagent ? this.subagentLines : this.toolLines;
        const idx = entries.findIndex((entry) => entry.toolCallId === part.update.toolCallId);
        const previous = idx >= 0 ? entries[idx]?.update : undefined;
        const update = isSubagent ? mergeSubagentToolStatus(previous, part.update) : part.update;
        const entry = {
          toolCallId: update.toolCallId,
          update,
          updatedSeq: ++this.progressUpdateSeq,
        } satisfies DiscordProgressEntry;
        if (idx >= 0) {
          entries[idx] = entry;
        } else {
          entries.push(entry);
        }
        if (isSubagent) {
          const ordinaryIdx = this.toolLines.findIndex(
            (candidate) => candidate.toolCallId === update.toolCallId,
          );
          if (ordinaryIdx >= 0) this.toolLines.splice(ordinaryIdx, 1);
        }
        // Only start once we have something to show.
        await this.ensureStarted();
        return;
      }
      case "attachment.add": {
        // Buffer during stream; attach at terminal phase so files land on final message.
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

  private async attachPendingAttachmentsToFinalMessage(target: Message): Promise<MsgRef[]> {
    if (this.pendingAttachments.length === 0) return [];

    const MAX_FILES = 10;
    const filesForFinal = this.pendingAttachments.slice(0, MAX_FILES);
    const overflow = this.pendingAttachments.slice(MAX_FILES);

    if (filesForFinal.length === 0) return [];

    const keepAttachmentIds = [...target.attachments.keys()].map((id) => ({ id }));
    const edited = await safeEdit(target, {
      files: toDiscordFiles(filesForFinal),
      attachments: keepAttachmentIds.length > 0 ? keepAttachmentIds : undefined,
    });

    if (!edited) {
      // Fallback: if edit-with-files fails, preserve delivery via follow-up attachment replies.
      return this.flushPendingAttachments(target);
    }

    this.lastMsg = target;
    this.pendingAttachments = overflow;

    if (this.pendingAttachments.length === 0) {
      return [];
    }

    return this.flushPendingAttachments(target);
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
      hardMaxChunkLength: 4096,
      completeLastChunk: true,
    });

    const MAX_FILES = 10;
    const filesForLastMessage = this.pendingAttachments.slice(0, MAX_FILES);
    const overflowAttachments = this.pendingAttachments.slice(MAX_FILES);

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
              files: isLast ? toDiscordFiles(filesForLastMessage) : undefined,
              reply:
                this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
                  ? { messageReference: this.deps.opts.replyTo.messageId }
                  : undefined,
              allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: true }),
            })
          : await parent.reply({
              embeds: [emb],
              files: isLast ? toDiscordFiles(filesForLastMessage) : undefined,
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

    this.pendingAttachments = overflowAttachments;
    this.lastMsg = lastMsg;
    return {
      created,
      lastMsg,
    };
  }

  private async postFinalReplyPlain(): Promise<{ created: MsgRef[]; lastMsg: Message }> {
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

    const maxChunkLength =
      DISCORD_CONTENT_MAX_CHARS - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
    const chunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength: maxChunkLength,
      useSmartSplitting: this.deps.useSmartSplitting,
      hardMaxChunkLength: DISCORD_CONTENT_MAX_CHARS,
      completeLastChunk: true,
    });

    const MAX_FILES = 10;
    const filesForLastMessage = this.pendingAttachments.slice(0, MAX_FILES);
    const overflowAttachments = this.pendingAttachments.slice(MAX_FILES);

    const displayChunks = chunks.length > 0 ? chunks : ["*<empty_string>*"];
    const createdMsgs: Message[] = [];
    let parent: Message | null = null;

    for (let i = 0; i < displayChunks.length; i++) {
      const chunk = displayChunks[i] ?? "";
      const isLast = i === displayChunks.length - 1;
      const contentChunk = chunk || "*<empty_string>*";
      const embeds =
        isLast && this.statsForNerdsLine
          ? [
              new EmbedBuilder().setColor(Colors.Blue).addFields({
                name: " ",
                value: buildFinalStatsFieldValue(this.statsForNerdsLine),
                inline: false,
              }),
            ]
          : undefined;

      const msg: Message =
        parent === null
          ? await sendChannel.send({
              content: contentChunk,
              embeds,
              files: isLast ? toDiscordFiles(filesForLastMessage) : undefined,
              reply:
                this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
                  ? { messageReference: this.deps.opts.replyTo.messageId }
                  : undefined,
              allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: true }),
            })
          : await parent.reply({
              content: contentChunk,
              embeds,
              files: isLast ? toDiscordFiles(filesForLastMessage) : undefined,
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

    this.pendingAttachments = overflowAttachments;
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
      const finalReplyPromise =
        this.deps.outputPreviewModeFinalStyle === "plain"
          ? this.postFinalReplyPlain()
          : this.postFinalReplyEmbeds();
      const deletePreviewPromise = this.deleteTransientPreviewMessages().catch(() => undefined);

      const finalReply = await finalReplyPromise;
      await deletePreviewPromise;

      const attachmentCreated = await this.attachPendingAttachmentsToFinalMessage(
        finalReply.lastMsg,
      );
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
      await this.attachPendingAttachmentsToFinalMessage(replyTo);
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

    if (isCancel && this.pendingAttachments.length > 0 && !this.firstMsg) {
      // Ensure we have a message anchor so buffered attachments can be finalized on cancel.
      await this.ensureStarted();
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

    // On reanchor/cancel, flush any buffered attachments so they aren't dropped.
    if (isReanchor || isCancel) {
      const { sessionRef } = this.deps;
      if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
        const replyTo = this.lastMsg ?? this.firstMsg;
        if (replyTo) {
          await this.attachPendingAttachmentsToFinalMessage(replyTo);
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
  markdownTableRender?: MarkdownTableRenderOptions;
  outputNotification?: boolean;
}): Promise<MsgRef> {
  const { text, attachments } = normalizeContent(params.content);
  const out = new DiscordOutputStream({
    client: params.client,
    sessionRef: params.sessionRef,
    opts: params.opts,
    useSmartSplitting: params.useSmartSplitting,
    rewriteText: params.rewriteText,
    markdownTableRender: params.markdownTableRender,
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
