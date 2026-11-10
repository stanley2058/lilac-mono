import { Buffer } from "node:buffer";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  type Client,
  type Channel,
  EmbedBuilder,
  GuildPremiumTier,
  type Message,
  type MessageCreateOptions,
} from "discord.js";

import {
  createLogger,
  createWorkingIndicatorQueue,
  formatWorkingStatus,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type {
  StartOutputOpts,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  SurfaceOutputStream,
  SurfaceToolStatusUpdate,
} from "../../adapter";
import {
  SurfaceMessageNotFound,
  SurfacePlatformMismatch,
  SurfaceOperationPartiallyCompleted,
  SurfaceUnavailable,
  settleSurfaceFallback,
  type SurfaceOperation,
  type SurfaceOperationResult,
} from "../../adapter";
import type {
  ContentOpts,
  DiscordSessionRef,
  MsgRef,
  SessionRef,
  SurfaceAttachment,
} from "../../types";
import { isSubagentToolDisplay, mergeSubagentToolStatus } from "../../subagent-tool-status";
import type { MarkdownTableRenderOptions } from "../../../shared/markdown-table-renderer";

// Attachments are buffered during streaming and finalized on the terminal message.

import {
  DiscordEmbedEditFailed,
  getEmbedPusherConstants,
  startEmbedPusher,
  type EmbedEditOutcome,
} from "./embed-pusher";
import { chunkMarkdownForEmbeds } from "./markdown-chunker";
import { normalizeDiscordBlockquotes } from "./discord-markdown-normalize";
import {
  renderDiscordMarkdownMath,
  type DiscordMarkdownMathRenderOptions,
  type DiscordMarkdownMathRenderPhase,
} from "./discord-markdown-math-renderer";
import { renderMarkdownTablesAsCodeBlocks } from "../../../shared/markdown-table-renderer";
import { buildCancelCustomId } from "../discord-cancel";
import { renderDiscordTableImages } from "./discord-table-image-renderer";
import { buildDiscordTableChunks, type DiscordPlainChunk } from "./discord-table-chunks";
import { isTextSendableChannel, type SendableDiscordChannel } from "../discord-channel-guards";
import { captureDiscordSurfaceError, classifyDiscordSurfaceError } from "../discord-adapter";

const tableOutputLogger = createLogger({ module: "surface:discord:output" });

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
const PREVIEW_TEXT_TAIL_CHARS = 2000;
const DISCORD_CONTENT_MAX_CHARS = 2000;
const PROGRESS_MAX_LINES = 5;
const SUBAGENT_MODEL_MAX_CHARS = 12;
const SUBAGENT_MODEL_HEAD_CHARS = 2;
const SUBAGENT_MODEL_TAIL_CHARS = 7;
const SUBAGENT_CHILD_DISPLAY_MAX_CHARS = 48;
const SUBAGENT_CURRENT_TOOL_MAX_CHARS = 16;
const PROGRESS_LINE_MAX_CHARS = 90;

class DiscordOutputPlatformUnsupported extends TaggedError("DiscordOutputPlatformUnsupported")<{
  readonly platform: AdapterPlatform;
  readonly message: string;
}> {}

class DiscordOutputChannelUnavailable extends TaggedError("DiscordOutputChannelUnavailable")<{
  readonly channelId: string;
  readonly message: string;
}> {}

class DiscordOutputInvariantViolation extends TaggedError("DiscordOutputInvariantViolation")<{
  readonly message: string;
}> {}

async function captureDiscordOutputOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: captureDiscordSurfaceError,
  });
  const outcome = captured.match<
    | { readonly kind: "result"; readonly result: SurfaceOperationResult<T> }
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure"; readonly cause: Error }
  >({
    ok: (value) => ({ kind: "result", result: Result.ok(value) }),
    err: (cause) => {
      if (Panic.is(cause)) return { kind: "panic", panic: cause };
      if (cause instanceof DiscordOutputPlatformUnsupported) {
        return {
          kind: "result",
          result: Result.err(
            new SurfacePlatformMismatch({
              operation,
              refRole: "sessionRef",
              expectedPlatform: "discord",
              receivedPlatform: cause.platform,
              message: cause.message,
            }),
          ),
        };
      }
      if (cause instanceof DiscordOutputChannelUnavailable) {
        return {
          kind: "result",
          result: Result.err(
            new SurfaceUnavailable({ platform: "discord", operation, message: cause.message }),
          ),
        };
      }
      if (cause instanceof DiscordEmbedEditFailed) {
        const classified = classifyDiscordSurfaceError(operation, cause.cause);
        if (classified) return { kind: "result", result: Result.err(classified) };
        return { kind: "failure", cause };
      }
      if (cause instanceof DiscordOutputInvariantViolation) {
        return {
          kind: "panic",
          panic: new Panic({ message: "Discord output invariant violated", cause }),
        };
      }
      const classified = classifyDiscordSurfaceError(operation, cause);
      if (classified) return { kind: "result", result: Result.err(classified) };
      return { kind: "failure", cause };
    },
  });
  if (outcome.kind === "panic") return adaptDiscordOutputResultToHost(Result.err(outcome.panic));
  if (outcome.kind === "failure") return adaptDiscordOutputResultToHost(Result.err(outcome.cause));
  return outcome.result;
}

function discordOutputSessionResult(
  sessionRef: SessionRef,
): ResultType<DiscordSessionRef, DiscordOutputPlatformUnsupported> {
  if (sessionRef.platform === "discord") return Result.ok(sessionRef);
  return Result.err(
    new DiscordOutputPlatformUnsupported({
      platform: sessionRef.platform,
      message: `Unsupported surface platform: ${sessionRef.platform}`,
    }),
  );
}

function finalDiscordMessageResult(
  message: Message | undefined,
): ResultType<Message, DiscordOutputInvariantViolation> {
  if (message) return Result.ok(message);
  return Result.err(
    new DiscordOutputInvariantViolation({
      message: "DiscordOutputStream produced no final messages",
    }),
  );
}

type DiscordOutputMode = "inline" | "preview";
type DiscordPreviewFinalOutputStyle = "embed" | "plain";
type DiscordPreviewFinalText = "flat" | "reply-chain";
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
  return formatWorkingStatus(input);
}

function isBatchToolDisplay(display: string): boolean {
  const trimmed = display.trimStart();
  // Back-compat: older displays used "[batch]".
  return trimmed.startsWith("batch") || trimmed.startsWith("[batch]");
}

function normalizeRestoredBuiltinToolDisplay(display: string): string {
  return display.replace(
    /^(?<prefix>(?:[|`]-\s+(?:[▶…✓✗]\s+)?)?)(?<name>read_file|edit_file|apply_patch)(?=$|\s|\()/u,
    (_match, prefix: string, name: string) => {
      switch (name) {
        case "read_file":
          return `${prefix}read`;
        case "edit_file":
          return `${prefix}edit`;
        case "apply_patch":
          return `${prefix}patch`;
        default:
          return `${prefix}${name}`;
      }
    },
  );
}

function normalizeToolDisplayForDiscord(display: string): string {
  if (isSubagentToolDisplay(display)) return display;
  if (isBatchToolDisplay(display)) {
    return display.split("\n").map(normalizeRestoredBuiltinToolDisplay).join("\n");
  }
  return normalizeRestoredBuiltinToolDisplay(display)
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
  const display = normalizeRestoredBuiltinToolDisplay(child.display);
  const bracketed = /^\[([^\]]+)\]/u.exec(display)?.[1];
  const tool = bracketed ?? display.split(/[\s(]/u, 1)[0];
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
      normalizeRestoredBuiltinToolDisplay(child.display).replace(/\s+/gu, " ").trim(),
      SUBAGENT_CHILD_DISPLAY_MAX_CHARS,
    );
    return escapeDiscordMarkdown(`${branch} ${child.icon} ${display}`);
  });
}

export function buildDiscordProgressLines(input: {
  tools: readonly DiscordProgressEntry[];
  subagents: readonly DiscordProgressEntry[];
}): string[] {
  const rankedSubagents = input.subagents
    .filter((entry) => entry.update.status !== "end")
    .sort((a, b) => b.updatedSeq - a.updatedSeq);
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
  const historyByRecency = [
    ...input.tools.map((entry) => ({
      entry,
      rows: buildToolLine(entry.update).split("\n"),
    })),
    ...input.subagents
      .filter((entry) => entry.update.status === "end")
      .map((entry) => ({
        entry,
        rows: [buildSubagentHeader(entry, parseSubagentDisplay(entry.update.display), false)],
      })),
  ].sort((a, b) => b.entry.updatedSeq - a.entry.updatedSeq);
  for (const { rows } of historyByRecency) {
    if (remainingToolLines === 0) break;
    let selectedRows = rows;
    if (rows.length > remainingToolLines) {
      selectedRows =
        remainingToolLines === 1
          ? rows.slice(0, 1)
          : [rows[0]!, ...rows.slice(-(remainingToolLines - 1))];
    }
    toolChunks.unshift(selectedRows);
    remainingToolLines -= selectedRows.length;
  }

  return [...toolChunks.flat(), ...agentLines]
    .slice(-PROGRESS_MAX_LINES)
    .map((line) => clampWithEllipsis(line, PROGRESS_LINE_MAX_CHARS));
}

export function toPreviewTail(
  text: string,
  maxChars = PREVIEW_TEXT_TAIL_CHARS,
  preferCompleteBlock = false,
): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return "...".slice(0, maxChars);

  const tailLength = maxChars - 3;
  const rawStart = text.length - tailLength;
  if (!preferCompleteBlock) return `...${text.slice(rawStart)}`;

  const completeBlockStart = text.indexOf("\n\n", rawStart);
  if (completeBlockStart >= 0) {
    const completeBlocks = text.slice(completeBlockStart + 2);
    if (completeBlocks.length > 0 && completeBlocks.length <= tailLength) {
      return `...${completeBlocks}`;
    }
  }

  return `...${text.slice(rawStart)}`;
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

const DISCORD_MAX_FILES_PER_MESSAGE = 10;
const MIB = 1024 * 1024;
const DISCORD_DEFAULT_UPLOAD_LIMIT_BYTES = 10 * MIB;

/** Discord raises the per-message upload limit for boosted guilds. */
function discordUploadLimitBytes(channel: Channel): number {
  const tier = "guild" in channel ? channel.guild?.premiumTier : undefined;
  switch (tier) {
    case GuildPremiumTier.Tier2:
      return 50 * MIB;
    case GuildPremiumTier.Tier3:
      return 100 * MIB;
    default:
      return DISCORD_DEFAULT_UPLOAD_LIMIT_BYTES;
  }
}

/**
 * Splits off the next upload batch within the file-count and byte limits. A single file over the
 * byte limit still goes alone, so Discord reports the failure instead of the file disappearing.
 */
function takeAttachmentBatch(
  attachments: readonly SurfaceAttachment[],
  maxFiles: number,
  maxBytes: number,
): [SurfaceAttachment[], SurfaceAttachment[]] {
  let bytes = 0;
  let count = 0;
  for (const attachment of attachments) {
    if (count >= maxFiles) break;
    const size = attachment.bytes.byteLength;
    if (count > 0 && bytes + size > maxBytes) break;
    bytes += size;
    count += 1;
  }
  return [attachments.slice(0, count), attachments.slice(count)];
}

async function fetchTextChannelResult(
  client: Client,
  channelId: string,
): Promise<ResultType<Channel & SendableDiscordChannel, DiscordOutputChannelUnavailable>> {
  const ch = await client.channels.fetch(channelId);
  if (!isTextSendableChannel(ch)) {
    return Result.err(
      new DiscordOutputChannelUnavailable({
        channelId,
        message: `Discord channel not found or not text-based: ${channelId}`,
      }),
    );
  }
  return Result.ok(ch);
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

async function editMessage(
  msg: Message,
  options: Parameters<Message["edit"]>[0],
): Promise<EmbedEditOutcome> {
  const edited = await Result.tryPromise({
    try: () => msg.edit(options),
    catch: captureDiscordSurfaceError,
  });
  return edited.match<EmbedEditOutcome>({
    ok: () => ({ kind: "edited" }),
    err: (cause) => {
      if (Panic.is(cause)) return adaptDiscordOutputResultToHost(Result.err(cause));
      if (classifyDiscordSurfaceError("edit-message", cause) instanceof SurfaceMessageNotFound) {
        return { kind: "not-found" };
      }
      return { kind: "failed", cause };
    },
  });
}

async function safeEdit(msg: Message, options: Parameters<Message["edit"]>[0]): Promise<boolean> {
  return (await editMessage(msg, options)).kind === "edited";
}

function adaptDiscordOutputResultToHost<T, E>(result: ResultType<T, E>): T {
  return result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
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
  private previewTextAcc = "";
  private pendingAttachments: SurfaceAttachment[] = [];
  private uploadLimitBytes = DISCORD_DEFAULT_UPLOAD_LIMIT_BYTES;

  private firstMsg: Message | null = null;
  private lastMsg: Message | null = null;
  private readonly done: { promise: Promise<void>; resolve(): void };

  private cancelCustomId: string | null = null;

  private running: Promise<void> | null = null;
  private usedEmbedPusher = false;
  private finalTextSegments: readonly string[] | null = null;
  private renderedTextCacheInput: string | null = null;
  private renderedTextCachePhase: DiscordMarkdownMathRenderPhase | null = null;
  private renderedTextCacheOutput = "";

  constructor(
    private readonly deps: {
      client: Client;
      sessionRef: SessionRef;
      opts?: StartOutputOpts;
      useSmartSplitting: boolean;
      rewriteText?: (text: string) => string;
      markdownTableRender?: MarkdownTableRenderOptions;
      renderTableImages?: typeof renderDiscordTableImages;
      markdownMathRender?: DiscordMarkdownMathRenderOptions;
      outputMode: DiscordOutputMode;
      outputPreviewModeFinalStyle?: DiscordPreviewFinalOutputStyle;
      outputPreviewModeFinalText?: DiscordPreviewFinalText;
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
    settleSurfaceFallback(
      Result.try({
        try: () => this.deps.opts?.onMessageCreated?.(msgRef),
        catch: (cause) =>
          Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback: undefined }
            : { kind: "fallback", fallback: undefined },
      }),
    );
  }

  private isPreviewMode(): boolean {
    return this.deps.outputMode === "preview";
  }

  private usesFlatPreviewFinalText(): boolean {
    return (
      this.isPreviewMode() &&
      this.deps.outputPreviewModeFinalStyle === "plain" &&
      this.deps.outputPreviewModeFinalText === "flat"
    );
  }

  private trackTransientPreviewRef(ref: MsgRef): void {
    if (!this.isPreviewMode()) return;

    const key = msgRefKey(ref);
    if (this.transientPreviewRefKeys.has(key)) return;
    this.transientPreviewRefKeys.add(key);
    this.transientPreviewRefs.push(ref);
  }

  private getRenderedText(phase: DiscordMarkdownMathRenderPhase): string {
    if (this.renderedTextCacheInput === this.textAcc && this.renderedTextCachePhase === phase) {
      return this.renderedTextCacheOutput;
    }

    const rendered = this.renderText(this.textAcc, phase);

    this.renderedTextCacheInput = this.textAcc;
    this.renderedTextCachePhase = phase;
    this.renderedTextCacheOutput = rendered;
    return rendered;
  }

  private renderText(text: string, phase: DiscordMarkdownMathRenderPhase): string {
    return this.renderPreparedText(this.prepareText(text), phase);
  }

  private prepareText(text: string): string {
    const rewrite = this.deps.rewriteText;
    return normalizeDiscordBlockquotes(rewrite ? rewrite(text) : text);
  }

  private renderPreparedText(text: string, phase: DiscordMarkdownMathRenderPhase): string {
    let rendered = text;

    const tableRender = this.deps.markdownTableRender;
    if (tableRender) {
      rendered = renderMarkdownTablesAsCodeBlocks(rendered, tableRender);
    }

    const mathRender = this.deps.markdownMathRender;
    if (mathRender) {
      rendered = renderDiscordMarkdownMath(rendered, mathRender, phase);
    }

    return rendered;
  }

  private getStreamingDisplayText(isStreaming: boolean): string {
    const phase = isStreaming ? "streaming" : "terminal";
    const rendered = this.usesFlatPreviewFinalText()
      ? this.renderText(this.previewTextAcc, phase)
      : this.getRenderedText(phase);
    if (!this.isPreviewMode()) return rendered;
    return toPreviewTail(rendered, PREVIEW_TEXT_TAIL_CHARS, this.usesFlatPreviewFinalText());
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
      await this.deleteMessageRef(ref);
    }
  }

  private async deleteMessageRef(ref: MsgRef): Promise<void> {
    const { client } = this.deps;
    if (ref.platform !== "discord") return;

    const fetchedChannel = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => client.channels.fetch(ref.channelId),
        catch: (cause) =>
          Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback: null }
            : { kind: "fallback", fallback: null },
      }),
    );
    const channel = fetchedChannel.match({ ok: (value) => value, err: () => null });
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return;
    }

    const fetchedMessage = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => channel.messages.fetch(ref.messageId),
        catch: (cause) =>
          Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback: null }
            : { kind: "fallback", fallback: null },
      }),
    );
    const msg = fetchedMessage.match({ ok: (value) => value, err: () => null });
    if (!msg) return;
    settleSurfaceFallback(
      await Result.tryPromise({
        try: () => msg.delete(),
        catch: (cause) =>
          Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback: undefined }
            : { kind: "fallback", fallback: undefined },
      }),
    );
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
    // Discord's progress title is intentionally a rotating product indicator.
    // Provider reasoning summaries belong in the detailed block below, not here.
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
    const sessionResult = discordOutputSessionResult(sessionRef);
    const discordSessionRef = adaptDiscordOutputResultToHost(sessionResult);

    const channelResult = await fetchTextChannelResult(client, discordSessionRef.channelId);
    const channel = adaptDiscordOutputResultToHost(channelResult);
    this.uploadLimitBytes = discordUploadLimitBytes(channel);
    let recoveredMessage: Message | null = null;
    const resumeAt = this.deps.opts?.resumeAt;
    if (
      resumeAt?.platform === "discord" &&
      resumeAt.channelId === discordSessionRef.channelId &&
      "messages" in channel &&
      channel.messages?.fetch
    ) {
      const fetched = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => channel.messages.fetch(resumeAt.messageId),
          catch: (cause) =>
            Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback: null }
              : { kind: "fallback", fallback: null },
        }),
      );
      recoveredMessage = fetched.match({ ok: (message) => message, err: () => null });
    }

    // Delay creating the first message until either:
    // - we have something to display (text/action), or
    // - finish() is called.
    //
    // Attachments are finalized later (finish/abort) so they land on the terminal message.

    this.cancelCustomId = (() => {
      const requestId = this.deps.opts?.requestId;
      return requestId
        ? buildCancelCustomId({ sessionId: discordSessionRef.channelId, requestId })
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

    const registerFirstMessage = (message: Message): void => {
      const ref = asDiscordMsgRef(discordSessionRef.channelId, message.id);
      this.created.push(ref);
      this.trackTransientPreviewRef(ref);
      this.notifyCreated(ref);
      this.firstMsg = message;
      this.lastMsg = message;
    };

    const claimRecoveredMessage = async (
      options: Parameters<Message["edit"]>[0],
    ): Promise<Message | null> => {
      const message = recoveredMessage;
      recoveredMessage = null;
      if (!message) return null;
      const edited = await safeEdit(message, options);
      if (!edited) return null;
      registerFirstMessage(message);
      return message;
    };

    // When the preview has no displayable text or progress, use one placeholder instead of
    // starting an embed pusher that has nothing to create yet.
    const hasInitialDisplayText = this.usesFlatPreviewFinalText()
      ? this.getStreamingDisplayText(true).length > 0
      : this.textAcc.length > 0;
    if (
      !hasInitialDisplayText &&
      this.toolLines.length === 0 &&
      this.subagentLines.length === 0 &&
      !this.hasReasoningStatus &&
      this.statsForNerdsLine === null
    ) {
      const first =
        (await claimRecoveredMessage({
          content: "*Replying...*",
          embeds: [],
          components: buildCancelComponents(true),
        })) ??
        (await channel.send({
          content: "*Replying...*",
          reply:
            this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
              ? { messageReference: this.deps.opts.replyTo.messageId }
              : undefined,
          components: buildCancelComponents(true),
          allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: false }),
        }));
      if (!this.firstMsg) registerFirstMessage(first);
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
    const firstMessageReady = Promise.withResolvers<void>();
    this.running = (async () => {
      const pushed = await startEmbedPusher({
        createFirst: async (emb) => {
          const recovered = await claimRecoveredMessage({
            content: null,
            embeds: [emb],
            components: buildCancelComponents(true),
          });
          if (recovered) {
            firstMessageReady.resolve();
            return recovered;
          }
          const first = await channel.send({
            embeds: [emb],
            reply:
              this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
                ? { messageReference: this.deps.opts.replyTo.messageId }
                : undefined,
            components: buildCancelComponents(true),
            allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: false }),
          });
          registerFirstMessage(first);
          firstMessageReady.resolve();
          return first;
        },
        createReply: async (parent, emb) => {
          const msg = await parent.reply({
            embeds: [emb],
            allowedMentions: this.getAllowedMentions({ isReply: false, isFinalLane: false }),
          });

          // Notify immediately so the router can treat replies-to-this message as "active".
          const ref = asDiscordMsgRef(discordSessionRef.channelId, msg.id);
          this.created.push(ref);
          this.trackTransientPreviewRef(ref);
          this.notifyCreated(ref);
          return msg;
        },
        getContent: (isStreaming) => this.getStreamingDisplayText(isStreaming),
        getProgressTitle: () => this.getProgressTitle(),
        getReasoningValue: () => this.getReasoningValue(),
        shouldHeartbeatProgress: () => this.isProgressTimerLive(),
        getActionsLines: () =>
          buildDiscordProgressLines({ tools: this.toolLines, subagents: this.subagentLines }),
        getStatsLine: () => this.statsForNerdsLine,
        getMaxLength,
        streamDone: this.done.promise,
        useSmartSplitting: this.deps.useSmartSplitting,
        editMessage,
        getFirstMessageEditExtras: (isStreaming) => ({
          components: isStreaming ? buildCancelComponents(true) : [],
        }),
      });
      const res = adaptDiscordOutputResultToHost(pushed);

      // track created reply messages
      const seen = new Set(this.created.map((m) => m.messageId));
      for (const messageId of res.discordMessageCreated) {
        if (seen.has(messageId)) continue;
        const ref = asDiscordMsgRef(discordSessionRef.channelId, messageId);
        this.created.push(ref);
        this.trackTransientPreviewRef(ref);
        seen.add(messageId);
      }

      this.lastMsg = res.lastMsg;
    })();
    const runningSettlement = Promise.allSettled([this.running]);
    void runningSettlement.then(([settled]) => {
      if (!settled || settled.status === "fulfilled") return;
      firstMessageReady.reject(settled.reason);
    });
    await firstMessageReady.promise;
  }

  async push(
    part: SurfaceOutputPart,
  ): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    return await captureDiscordOutputOperation("push-output", () => this.pushOutput(part));
  }

  private async pushOutput(part: SurfaceOutputPart): Promise<SurfaceOutputPartDisposition> {
    // Ensure started on first push so attachments can be part of the first send.
    // If the first push is a delta, we start immediately.
    // If the first push is an attachment, we buffer it until we start.

    const disposition = this.applyOutputPartLocally(part);
    if (
      part.type !== "attachment.add" &&
      !(part.type === "reasoning.status" && this.deps.reasoningDisplayMode === "none")
    ) {
      await this.ensureStarted();
    }
    return disposition;
  }

  private applyOutputPartLocally(part: SurfaceOutputPart): SurfaceOutputPartDisposition {
    switch (part.type) {
      case "text.delta":
        this.finalTextSegments = null;
        this.textAcc += part.delta;
        if (!this.usesFlatPreviewFinalText() || part.phase !== "final_answer") {
          this.previewTextAcc += part.delta;
        }
        return "visible";
      case "text.set":
        this.textAcc = part.text;
        this.finalTextSegments = part.finalSegments?.slice() ?? null;
        if (
          this.usesFlatPreviewFinalText() &&
          part.phase === "final_answer" &&
          part.finalSegments &&
          part.finalSegments.length > 1
        ) {
          this.previewTextAcc = part.finalSegments[0] ?? this.previewTextAcc;
        } else if (!this.usesFlatPreviewFinalText() || part.phase !== "final_answer") {
          this.previewTextAcc = part.text;
        }
        return "visible";
      case "meta.stats":
        this.statsForNerdsLine = part.line.trim().length > 0 ? part.line : null;
        return "visible";
      case "reasoning.status": {
        if (this.deps.reasoningDisplayMode === "none") {
          return "terminal";
        }
        if (!this.hasReasoningStatus) {
          this.markTaskProgress("reasoning");
        }
        this.hasReasoningStatus = true;
        this.reasoningDetailText = part.update.detailText ?? "";
        return "visible";
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
        return "visible";
      }
      case "attachment.add": {
        // Buffer during stream; attach at terminal phase so files land on final message.
        this.pendingAttachments.push(part.attachment);
        return "visible";
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

    const created: MsgRef[] = [];

    let remaining = this.pendingAttachments;
    while (remaining.length > 0) {
      const [chunk, rest] = takeAttachmentBatch(
        remaining,
        DISCORD_MAX_FILES_PER_MESSAGE,
        this.uploadLimitBytes,
      );
      remaining = rest;
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

    const available = DISCORD_MAX_FILES_PER_MESSAGE - target.attachments.size;
    if (available <= 0) return this.flushPendingAttachments(target);
    const [filesForFinal, overflow] = takeAttachmentBatch(
      this.pendingAttachments,
      available,
      this.uploadLimitBytes,
    );

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
    const sessionResult = discordOutputSessionResult(sessionRef);
    const discordSessionRef = adaptDiscordOutputResultToHost(sessionResult);

    const channelResult = await fetchTextChannelResult(client, discordSessionRef.channelId);
    const channel = adaptDiscordOutputResultToHost(channelResult);
    this.uploadLimitBytes = discordUploadLimitBytes(channel);
    const { CLOSING_TAG_BUFFER } = getEmbedPusherConstants();
    const fullText = this.getRenderedText("terminal");
    const content = fullText.length > 0 ? fullText : "*<empty_string>*";

    const maxChunkLength = 4096 - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
    const chunks = chunkMarkdownForEmbeds(content, {
      maxChunkLength,
      maxLastChunkLength: maxChunkLength,
      useSmartSplitting: this.deps.useSmartSplitting,
      hardMaxChunkLength: 4096,
      completeLastChunk: true,
    });

    const [filesForLastMessage, overflowAttachments] = takeAttachmentBatch(
      this.pendingAttachments,
      DISCORD_MAX_FILES_PER_MESSAGE,
      this.uploadLimitBytes,
    );

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
          ? await channel.send({
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
      const ref = asDiscordMsgRef(discordSessionRef.channelId, msg.id);
      this.created.push(ref);
      this.notifyCreated(ref);
      parent = msg;
    }

    const created = createdMsgs.map((msg) => asDiscordMsgRef(discordSessionRef.channelId, msg.id));

    const lastMessageResult = finalDiscordMessageResult(createdMsgs[createdMsgs.length - 1]);
    const lastMsg = adaptDiscordOutputResultToHost(lastMessageResult);

    this.pendingAttachments = overflowAttachments;
    this.lastMsg = lastMsg;
    return {
      created,
      lastMsg,
    };
  }

  private async buildFinalPlainChunks(): Promise<DiscordPlainChunk[]> {
    const { CLOSING_TAG_BUFFER } = getEmbedPusherConstants();
    const maxChunkLength =
      DISCORD_CONTENT_MAX_CHARS - (this.deps.useSmartSplitting ? CLOSING_TAG_BUFFER : 0);
    const selectedFinalTexts =
      this.usesFlatPreviewFinalText() && this.finalTextSegments
        ? this.finalTextSegments.slice(-1)
        : this.finalTextSegments;
    const finalTexts =
      selectedFinalTexts && selectedFinalTexts.length > 0 ? selectedFinalTexts : [this.textAcc];
    const chunkText = (text: string): string[] =>
      chunkMarkdownForEmbeds(text, {
        maxChunkLength,
        maxLastChunkLength: maxChunkLength,
        useSmartSplitting: this.deps.useSmartSplitting,
        hardMaxChunkLength: DISCORD_CONTENT_MAX_CHARS,
        completeLastChunk: true,
      });
    const chunks: DiscordPlainChunk[] = [];
    for (const text of finalTexts) {
      if (this.usesFlatPreviewFinalText() && this.deps.markdownTableRender?.style === "image") {
        chunks.push(
          ...(await buildDiscordTableChunks(this.prepareText(text), {
            renderText: (segment) => this.renderPreparedText(segment, "terminal"),
            chunkText,
            renderImages: (tables) =>
              (this.deps.renderTableImages ?? renderDiscordTableImages)(tables, {
                requestId: this.deps.opts?.requestId,
                channelId: this.deps.sessionRef.channelId,
              }),
          })),
        );
        continue;
      }
      const rendered = this.renderText(text, "terminal");
      chunks.push(...chunkText(rendered || "*<empty_string>*").map((chunk) => ({ text: chunk })));
    }
    if (chunks.length === 0) chunks.push({ text: "*<empty_string>*" });
    if (chunks.at(-1)?.tableImage && this.pendingAttachments.length > 0) chunks.push({ text: "" });
    return chunks;
  }

  private async postFinalReplyPlain(): Promise<{ created: MsgRef[]; lastMsg: Message }> {
    const { client, sessionRef } = this.deps;
    const sessionResult = discordOutputSessionResult(sessionRef);
    const discordSessionRef = adaptDiscordOutputResultToHost(sessionResult);
    const imageOutput = this.deps.markdownTableRender?.style === "image";
    const logContext = {
      requestId: this.deps.opts?.requestId,
      channelId: discordSessionRef.channelId,
    };
    const preparationStartedAt = performance.now();
    const channelResult = await fetchTextChannelResult(client, discordSessionRef.channelId);
    const channel = adaptDiscordOutputResultToHost(channelResult);
    this.uploadLimitBytes = discordUploadLimitBytes(channel);
    const channelFetchedAt = performance.now();
    const displayChunks = await this.buildFinalPlainChunks();
    if (imageOutput) {
      tableOutputLogger.debug("table_image.output.prepared", {
        ...logContext,
        channelFetchMs: channelFetchedAt - preparationStartedAt,
        buildChunksMs: performance.now() - channelFetchedAt,
        chunkCount: displayChunks.length,
      });
    }

    const [filesForLastMessage, overflowAttachments] = takeAttachmentBatch(
      this.pendingAttachments,
      DISCORD_MAX_FILES_PER_MESSAGE,
      this.uploadLimitBytes,
    );

    const createdMsgs: Message[] = [];
    let parent: Message | null = null;

    const sendChunk = async (options: MessageCreateOptions): Promise<Message> => {
      if (parent === null) {
        return await channel.send({
          ...options,
          reply:
            this.deps.opts?.replyTo && this.deps.opts.replyTo.platform === "discord"
              ? { messageReference: this.deps.opts.replyTo.messageId }
              : undefined,
          allowedMentions: this.getAllowedMentions({ isReply: true, isFinalLane: true }),
        });
      }
      if (this.usesFlatPreviewFinalText()) {
        return await channel.send({
          ...options,
          allowedMentions: this.getAllowedMentions({ isReply: false, isFinalLane: true }),
        });
      }
      return await parent.reply({
        ...options,
        allowedMentions: this.getAllowedMentions({ isReply: false, isFinalLane: true }),
      });
    };

    for (let i = 0; i < displayChunks.length; i++) {
      const chunk = displayChunks[i]!;
      const isLast = i === displayChunks.length - 1;
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

      let files = isLast ? toDiscordFiles(filesForLastMessage) : undefined;
      if (chunk.tableImage) {
        files = [
          {
            attachment: Buffer.from(chunk.tableImage.bytes),
            name: chunk.tableImage.filename,
            description: chunk.tableImage.description,
          },
        ];
      }
      const sendStartedAt = performance.now();
      if (imageOutput) {
        tableOutputLogger.debug("table_image.output.send.start", {
          ...logContext,
          chunkIndex: i,
          tableImageBytes: chunk.tableImage?.bytes.byteLength ?? 0,
        });
      }
      const msg = await sendChunk({
        content: chunk.text.trim() ? chunk.text : undefined,
        embeds,
        files,
      });

      if (imageOutput) {
        tableOutputLogger.debug("table_image.output.send.complete", {
          ...logContext,
          chunkIndex: i,
          messageId: msg.id,
          durationMs: performance.now() - sendStartedAt,
        });
      }
      createdMsgs.push(msg);
      const ref = asDiscordMsgRef(discordSessionRef.channelId, msg.id);
      this.created.push(ref);
      this.notifyCreated(ref);
      parent = msg;
    }

    const created = createdMsgs.map((msg) => asDiscordMsgRef(discordSessionRef.channelId, msg.id));

    const lastMessageResult = finalDiscordMessageResult(createdMsgs[createdMsgs.length - 1]);
    const lastMsg = adaptDiscordOutputResultToHost(lastMessageResult);

    this.pendingAttachments = overflowAttachments;
    this.lastMsg = lastMsg;
    return {
      created,
      lastMsg,
    };
  }

  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    return await this.captureFinishOutput(() => this.finishOutput());
  }

  /** Posts complete text as plain content without creating a streaming preview first. */
  async sendPlain(
    text: string,
    attachments: readonly SurfaceAttachment[],
  ): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    this.textAcc = text;
    this.pendingAttachments = [...attachments];
    return await this.captureFinishOutput(async () =>
      this.completeFinalReply(await this.postFinalReplyPlain()),
    );
  }

  /** Posts complete text as final embeds without streaming edits. */
  async sendEmbeds(
    text: string,
    attachments: readonly SurfaceAttachment[],
  ): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    this.textAcc = text;
    this.pendingAttachments = [...attachments];
    return await this.captureFinishOutput(async () =>
      this.completeFinalReply(await this.postFinalReplyEmbeds()),
    );
  }

  private async captureFinishOutput(
    effect: () => Promise<SurfaceOutputResult>,
  ): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    const finished = await captureDiscordOutputOperation("finish-output", effect);
    if (this.created.length === 0) return finished;
    return finished.mapError(
      (error) =>
        new SurfaceOperationPartiallyCompleted({
          platform: "discord",
          operation: "finish-output",
          created: this.created[this.created.length - 1]!,
          message: `Discord output partially completed: ${error.message}`,
        }),
    );
  }

  private async completeFinalReply(finalReply: {
    created: MsgRef[];
    lastMsg: Message;
  }): Promise<SurfaceOutputResult> {
    const attachmentCreated = await this.attachPendingAttachmentsToFinalMessage(finalReply.lastMsg);
    return {
      created: [...finalReply.created, ...attachmentCreated],
      last:
        attachmentCreated.at(-1) ??
        asDiscordMsgRef(finalReply.lastMsg.channelId, finalReply.lastMsg.id),
    };
  }

  private async finishOutput(): Promise<SurfaceOutputResult> {
    await this.ensureStarted();

    const previewStartedAt = performance.now();
    this.done.resolve();
    await this.running;
    if (this.deps.markdownTableRender?.style === "image") {
      tableOutputLogger.debug("table_image.output.preview.settled", {
        requestId: this.deps.opts?.requestId,
        durationMs: performance.now() - previewStartedAt,
      });
    }

    if (this.isPreviewMode()) {
      // The preview stays until the final reply lands, so a failed reply never leaves the
      // channel without any visible output.
      const [finalReplySettled] = await Promise.allSettled([
        this.deps.outputPreviewModeFinalStyle === "plain"
          ? this.postFinalReplyPlain()
          : this.postFinalReplyEmbeds(),
      ]);
      if (finalReplySettled.status === "rejected") {
        if (finalReplySettled.reason instanceof Error) throw finalReplySettled.reason;
        throw new DiscordOutputInvariantViolation({
          message: "Discord final reply rejected with a non-Error value",
        });
      }
      await this.deleteTransientPreviewMessages();
      return await this.completeFinalReply(finalReplySettled.value);
    }

    // If we never started the embed pusher (attachments-only), remove the cancel control.
    if (this.firstMsg && this.cancelCustomId) {
      await safeEdit(this.firstMsg, { components: [] });
    }

    const { sessionRef } = this.deps;
    if (isDiscordSessionRef(sessionRef) && this.pendingAttachments.length > 0) {
      const replyTo = this.lastMsg ?? this.firstMsg;
      if (!replyTo) {
        throw new DiscordOutputInvariantViolation({
          message: "DiscordOutputStream missing reply anchor",
        });
      }
      await this.attachPendingAttachmentsToFinalMessage(replyTo);
    }

    const last = this.created.at(-1);
    if (!last) {
      throw new DiscordOutputInvariantViolation({
        message: "DiscordOutputStream produced no messages",
      });
    }

    return {
      created: [...this.created],
      last,
    };
  }

  async abort(_reason?: string): Promise<SurfaceOperationResult<void>> {
    return await captureDiscordOutputOperation("abort-output", () => this.abortOutput(_reason));
  }

  private async abortOutput(_reason?: string): Promise<void> {
    const reason = _reason;
    const isReanchor = reason === "reanchor" || reason === "reanchor_interrupt";
    const isInterruptReanchor = reason === "reanchor_interrupt";
    const isCancel = reason === "cancel";
    const reanchorPlaceholder = isInterruptReanchor ? "*Interrupted...*" : "*Steering...*";

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
        this.textAcc = reanchorPlaceholder;
      }
      if (this.usesFlatPreviewFinalText() && this.previewTextAcc.trim().length === 0) {
        this.previewTextAcc = reanchorPlaceholder;
      }

      // Ensure the placeholder message exists so we can "freeze" it.
      await this.ensureStarted();
    }

    this.done.resolve();
    await this.running;

    // Best-effort: if we never started the embed pusher, rewrite the initial
    // "Replying..." placeholder to the terminal abort state.
    if ((isReanchor || isCancel) && this.firstMsg && !this.usedEmbedPusher) {
      await safeEdit(this.firstMsg, {
        content: isReanchor
          ? this.getStreamingDisplayText(false) || reanchorPlaceholder
          : this.textAcc || "Cancelled.",
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
  markdownMathRender?: DiscordMarkdownMathRenderOptions;
  outputNotification?: boolean;
}): Promise<SurfaceOperationResult<MsgRef>> {
  const { text, attachments } = normalizeContent(params.content);
  const out = new DiscordOutputStream({
    client: params.client,
    sessionRef: params.sessionRef,
    opts: params.opts,
    useSmartSplitting: params.useSmartSplitting,
    rewriteText: params.rewriteText,
    markdownTableRender: params.markdownTableRender,
    markdownMathRender: params.markdownMathRender,
    outputMode: "inline",
    outputNotification: params.outputNotification,
    reasoningDisplayMode: "none",
    workingIndicators: ["Working"],
  });

  const sent =
    params.content.style === "plain"
      ? await out.sendPlain(text, attachments)
      : await out.sendEmbeds(text, attachments);
  return sent.map((value) => value.last);
}
