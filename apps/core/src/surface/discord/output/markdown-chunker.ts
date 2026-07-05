import { buildMarkdownIndex, type CodeFenceRange, type MarkdownIndex } from "./markdown-index";
import { findRawSplitPoint } from "./markdown-splitter";
import { completeMarkdown } from "./token-complete";

export interface ChunkMarkdownOptions {
  maxChunkLength: number;
  maxLastChunkLength: number;
  useSmartSplitting: boolean;
  hardMaxChunkLength?: number;
  completeLastChunk?: boolean;
}

interface RawChunk {
  start: number;
  end: number;
}

const ZERO_WIDTH_SPACE = "\u200b";

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function avoidSurrogateSplit(source: string, offset: number): number {
  if (offset <= 0 || offset >= source.length) return offset;
  return isLowSurrogate(source.charCodeAt(offset)) ? offset - 1 : offset;
}

function advanceOneCodePoint(source: string, start: number): number {
  if (start >= source.length) return start;
  const code = source.charCodeAt(start);
  return isHighSurrogate(code) && isLowSurrogate(source.charCodeAt(start + 1))
    ? start + 2
    : start + 1;
}

function ensureProgressByCodePoint(source: string, start: number, end: number): number {
  if (end > start) return end;
  return advanceOneCodePoint(source, start);
}

function escapeNestedFenceMarkers(text: string): string {
  return text.replace(/(`{3,})/gu, (marker: string) => {
    return marker[0] + ZERO_WIDTH_SPACE + marker.slice(1);
  });
}

function normalizedFenceOpener(lang: string): string {
  if (lang.includes("`")) return "```\n";
  return lang ? `\`\`\`${lang}\n` : "```\n";
}

function normalizedFenceCloser(originalLine: string): string {
  return originalLine.endsWith("\n") ? "```\n" : "```";
}

function findActiveFence(offset: number, index: MarkdownIndex): CodeFenceRange | null {
  return (
    index.codeFences.find(
      (fence) =>
        offset >= fence.openerEnd && (fence.closeStart === null || offset < fence.closeStart),
    ) ?? null
  );
}

function findFenceEndingAt(offset: number, index: MarkdownIndex): CodeFenceRange | null {
  return (
    index.codeFences.find(
      (fence) =>
        (offset === fence.openerEnd && fence.closeStart === fence.openerEnd) ||
        (offset > fence.openerEnd &&
          (fence.closeStart === null
            ? offset <= (fence.end ?? offset)
            : offset <= fence.closeStart)),
    ) ?? null
  );
}

function findNextFence(start: number, end: number, index: MarkdownIndex): CodeFenceRange | null {
  return index.codeFences.find((fence) => fence.start >= start && fence.start < end) ?? null;
}

function findCloserAt(offset: number, index: MarkdownIndex): CodeFenceRange | null {
  return index.codeFences.find((fence) => fence.closeStart === offset) ?? null;
}

function isSuppressibleOpenerOnlyFence(fence: CodeFenceRange): boolean {
  return fence.closeStart !== fence.openerEnd;
}

function findTrailingOpenerOnlyFence(range: RawChunk, index: MarkdownIndex): CodeFenceRange | null {
  return (
    index.codeFences.find(
      (fence) =>
        range.start < fence.start &&
        range.end === fence.openerEnd &&
        isSuppressibleOpenerOnlyFence(fence),
    ) ?? null
  );
}

function isFenceOpenerOnlyRange(range: RawChunk, index: MarkdownIndex): boolean {
  return index.codeFences.some(
    (fence) =>
      range.start === fence.start &&
      range.end === fence.openerEnd &&
      isSuppressibleOpenerOnlyFence(fence),
  );
}

function startFormattingAt(range: RawChunk, index: MarkdownIndex): string[] {
  const closingMarkers = index.formattingRanges
    .filter((formattingRange) => formattingRange.closeStart === range.start)
    .map((formattingRange) => formattingRange.marker);
  const formatting = [...index.getStateAt(range.start).formatting];

  for (const marker of closingMarkers) {
    const markerIndex = formatting.indexOf(marker);
    if (markerIndex !== -1) formatting.splice(markerIndex, 1);
  }

  return formatting;
}

function startInlineCodeMarkerAt(range: RawChunk, index: MarkdownIndex): string {
  const stateMarker = index.getStateAt(range.start).inlineCode?.marker ?? "";
  if (!stateMarker) return "";

  const startsAtCloser = index.inlineCodeRanges.some(
    (inlineRange) => inlineRange.closeStart === range.start,
  );
  return startsAtCloser ? "" : stateMarker;
}

function renderRawSlice(raw: string, range: RawChunk, index: MarkdownIndex): string {
  let pos = range.start;
  let out = "";

  while (pos < range.end) {
    const closer = findCloserAt(pos, index);
    if (closer !== null && closer.end !== null) {
      if (closer.closeStart === closer.openerEnd && range.start <= closer.start) {
        out += normalizedFenceCloser(raw.slice(closer.closeStart, closer.end));
      }
      pos = Math.min(range.end, closer.end);
      continue;
    }

    const activeFence = findActiveFence(pos, index);
    if (activeFence) {
      const contentEnd = Math.min(range.end, activeFence.closeStart ?? range.end);
      out += escapeNestedFenceMarkers(raw.slice(pos, contentEnd));
      pos = contentEnd;

      if (
        activeFence.closeStart !== null &&
        activeFence.end !== null &&
        pos === activeFence.closeStart &&
        pos < range.end
      ) {
        out += normalizedFenceCloser(raw.slice(activeFence.closeStart, activeFence.end));
        pos = Math.min(range.end, activeFence.end);
      }
      continue;
    }

    const nextFence = findNextFence(pos, range.end, index);
    if (!nextFence) {
      out += raw.slice(pos, range.end);
      break;
    }

    out += raw.slice(pos, nextFence.start);
    if (nextFence.openerEnd <= range.end) {
      out += normalizedFenceOpener(nextFence.lang);
      pos = nextFence.openerEnd;
      continue;
    }

    out += raw.slice(nextFence.start, range.end);
    break;
  }

  return out;
}

function completeDisplayOnly(input: string): string {
  const completed = completeMarkdown(input);
  if (completed.length < input.length) return input;
  if (!completed.startsWith(input)) return input;
  return completed;
}

function renderDiscordChunk(
  raw: string,
  range: RawChunk,
  index: MarkdownIndex,
  options: { isLast: boolean; completeLastChunk: boolean },
): string {
  const trailingOpenerOnlyFence = findTrailingOpenerOnlyFence(range, index);
  const renderRange = trailingOpenerOnlyFence
    ? { start: range.start, end: trailingOpenerOnlyFence.start }
    : range;

  const startState = index.getStateAt(renderRange.start);
  const endState = index.getStateAt(renderRange.end);
  const endFence = trailingOpenerOnlyFence
    ? null
    : (endState.fence ?? findFenceEndingAt(renderRange.end, index));

  let prefix = "";
  let suffix = "";
  const blockquotePrefix = startState.blockquote?.prefix ?? "";

  if (startState.fence !== null) {
    prefix = blockquotePrefix + normalizedFenceOpener(startState.fence.lang);
  } else {
    prefix =
      blockquotePrefix +
      startFormattingAt(renderRange, index).join("") +
      startInlineCodeMarkerAt(renderRange, index);
  }

  if (endFence !== null) {
    suffix = "```";
  } else {
    suffix = (endState.inlineCode?.marker ?? "") + [...endState.formatting].reverse().join("");
  }

  const body = renderRawSlice(raw, renderRange, index);
  const separator = endFence !== null && body.length > 0 && !body.endsWith("\n") ? "\n" : "";
  const rendered = prefix + body + separator + suffix;

  if (!options.isLast || !options.completeLastChunk) return rendered;
  return completeDisplayOnly(rendered);
}

function fallbackRawSlice(raw: string, start: number, budget: number): RawChunk {
  const end = avoidSurrogateSplit(raw, Math.min(raw.length, start + Math.max(1, budget)));
  return { start, end: Math.min(raw.length, ensureProgressByCodePoint(raw, start, end)) };
}

function retreatToSafeOffset(
  raw: string,
  start: number,
  offset: number,
  index: MarkdownIndex,
): number {
  let next = avoidSurrogateSplit(raw, offset);

  while (next > start + 1) {
    const zone = index.unsafeZones.find(
      (unsafeZone) => next > unsafeZone.start && next < unsafeZone.end,
    );
    if (!zone) return next;

    const beforeZone = avoidSurrogateSplit(raw, zone.start);
    if (beforeZone <= start) return next;
    next = beforeZone;
  }

  return next;
}

function findNextRawChunk(
  raw: string,
  start: number,
  budget: number,
  useSmartSplitting: boolean,
  index: MarkdownIndex,
): RawChunk {
  if (raw.length - start <= budget) return { start, end: raw.length };

  const targetEnd = Math.min(raw.length, start + budget);
  const minEnd = Math.min(targetEnd, start + Math.max(1, budget - 100));
  const end = useSmartSplitting
    ? findRawSplitPoint(raw, start, targetEnd, minEnd, index, {
        maxBacktrack: 100,
        newlineBacktrack: 100,
        locale: "en-US",
      })
    : avoidSurrogateSplit(raw, targetEnd);

  return { start, end: Math.min(raw.length, ensureProgressByCodePoint(raw, start, end)) };
}

function buildRawChunks(
  raw: string,
  startOffset: number,
  endOffset: number,
  budget: number,
  useSmartSplitting: boolean,
  index: MarkdownIndex,
): RawChunk[] {
  const chunks: RawChunk[] = [];
  let start = startOffset;

  while (start < endOffset) {
    const chunk = findNextRawChunk(raw, start, budget, useSmartSplitting, index);
    const end = Math.min(chunk.end, endOffset);
    chunks.push({ start, end });
    start = end;
  }

  return chunks;
}

function shrinkToRenderedBudget(
  raw: string,
  range: RawChunk,
  index: MarkdownIndex,
  budget: number,
  isLast: boolean,
  completeLastChunk: boolean,
): { range: RawChunk; display: string } {
  let current = range;

  while (current.end > current.start) {
    const display = renderDiscordChunk(raw, current, index, { isLast, completeLastChunk });
    if (display.length <= budget) return { range: current, display };

    const overflow = display.length - budget;
    let nextEnd = retreatToSafeOffset(
      raw,
      current.start,
      Math.max(current.start + 1, current.end - overflow),
      index,
    );
    const nextState = index.getStateAt(nextEnd);
    for (const delimiter of nextState.formatting) {
      if (raw.slice(current.start, nextEnd).endsWith(delimiter)) {
        nextEnd = Math.max(current.start + 1, nextEnd - delimiter.length);
        break;
      }
    }
    nextEnd = retreatToSafeOffset(raw, current.start, nextEnd, index);
    if (nextEnd >= current.end) break;
    current = { start: current.start, end: nextEnd };
  }

  const fallback = fallbackRawSlice(raw, range.start, budget);
  return { range: fallback, display: raw.slice(fallback.start, fallback.end) };
}

function renderChunks(
  raw: string,
  inputRanges: readonly RawChunk[],
  index: MarkdownIndex,
  budget: number,
  lastBudget: number,
  completeLastChunk: boolean,
): string[] {
  const displays: string[] = [];
  const ranges = [...inputRanges];

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) continue;
    const nextRange = ranges[i + 1];
    if (isFenceOpenerOnlyRange(range, index)) {
      if (nextRange) ranges[i + 1] = { start: range.start, end: nextRange.end };
      continue;
    }

    const isLast = i === ranges.length - 1;
    const activeBudget = isLast ? lastBudget : budget;
    let result = shrinkToRenderedBudget(raw, range, index, activeBudget, isLast, completeLastChunk);

    if (result.range.end < range.end) {
      const followingRange = ranges[i + 1];
      if (followingRange && followingRange.start === range.end) {
        ranges[i + 1] = { start: result.range.end, end: followingRange.end };
      } else {
        ranges.splice(i + 1, 0, { start: result.range.end, end: range.end });
      }
      result = shrinkToRenderedBudget(raw, result.range, index, budget, false, false);
    }

    if (result.display.length > 0) displays.push(result.display);
  }

  return displays;
}

export function chunkMarkdownForEmbeds(
  content: string,
  {
    maxChunkLength,
    maxLastChunkLength,
    useSmartSplitting,
    hardMaxChunkLength,
    completeLastChunk = false,
  }: ChunkMarkdownOptions,
): string[] {
  if (!content) return [];

  const safeMaxChunkLength = Math.max(1, maxChunkLength);
  const safeMaxLastChunkLength = Math.max(1, Math.min(maxLastChunkLength, safeMaxChunkLength));
  const displayBudget = Math.max(
    1,
    Math.min(safeMaxChunkLength, hardMaxChunkLength ?? safeMaxChunkLength),
  );
  const index = buildMarkdownIndex(content);

  let ranges = buildRawChunks(content, 0, content.length, displayBudget, useSmartSplitting, index);
  const lastRange = ranges.at(-1);
  if (lastRange && lastRange.end - lastRange.start > safeMaxLastChunkLength) {
    const prefix = ranges.slice(0, -1);
    const tailRanges = buildRawChunks(
      content,
      lastRange.start,
      lastRange.end,
      safeMaxLastChunkLength,
      useSmartSplitting,
      index,
    );
    ranges = prefix.concat(tailRanges);
  }

  return renderChunks(
    content,
    ranges,
    index,
    displayBudget,
    Math.min(displayBudget, safeMaxLastChunkLength),
    completeLastChunk,
  );
}
