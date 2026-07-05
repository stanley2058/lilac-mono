import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type UnsafeZoneReason = "marker" | "link" | "image" | "html" | "fence-line";

export interface UnsafeZone {
  start: number;
  end: number;
  reason: UnsafeZoneReason;
}

export interface CodeFenceRange {
  start: number;
  openerEnd: number;
  closeStart: number | null;
  end: number | null;
  marker: "`" | "~";
  markerLength: number;
  lang: string;
}

export interface BlockquoteRange {
  lineStart: number;
  contentStart: number;
  lineEnd: number;
  prefix: string;
}

export type MarkdownDelimiter = "**" | "*" | "__" | "_" | "~~";

export interface MarkdownState {
  fence: null | {
    markerLength: number;
    lang: string;
  };
  blockquote: null | {
    prefix: string;
  };
  inlineCode: null | {
    marker: string;
  };
  formatting: readonly MarkdownDelimiter[];
}

export interface MarkdownIndex {
  unsafeZones: readonly UnsafeZone[];
  codeFences: readonly CodeFenceRange[];
  blockquotes: readonly BlockquoteRange[];
  formattingRanges: readonly MarkdownFormattingRange[];
  inlineCodeRanges: readonly MarkdownInlineCodeRange[];
  getStateAt(offset: number): MarkdownState;
  isSafeOffset(offset: number): boolean;
}

export interface MarkdownFormattingRange {
  start: number;
  openerEnd: number;
  closeStart: number;
  end: number;
  marker: MarkdownDelimiter;
}

export interface MarkdownInlineCodeRange {
  start: number;
  openerEnd: number;
  closeStart: number;
  end: number;
  marker: string;
}

interface MarkdownNode {
  type?: unknown;
  value?: unknown;
  lang?: unknown;
  children?: unknown;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function lineEndIndex(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline + 1;
}

function parseFenceOpener(
  line: string,
): { marker: "`" | "~"; markerLength: number; lang: string } | null {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = /^(?: {0,3})((`{3,})|(~{3,}))(.*)$/u.exec(withoutNewline);
  if (!match) return null;

  const markerRun = match[1] ?? "```";
  const marker = markerRun[0] === "~" ? "~" : "`";
  const info = match[4] ?? "";
  if (marker === "`" && info.includes("`")) return null;

  return {
    marker,
    markerLength: markerRun.length,
    lang: info.trim(),
  };
}

function parseFenceCloser(line: string, marker: "`" | "~", markerLength: number): boolean {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = /^(?: {0,3})((`{3,})|(~{3,}))\s*$/u.exec(withoutNewline);
  if ((match?.[1]?.[0] ?? "") !== marker) return false;
  return (match?.[1]?.length ?? 0) >= markerLength;
}

function isMarkdownFenceLanguage(lang: string): boolean {
  const normalized = lang.toLowerCase();
  return normalized === "md" || normalized === "markdown";
}

function addZone(zones: UnsafeZone[], start: number, end: number, reason: UnsafeZoneReason): void {
  if (end <= start) return;
  zones.push({ start, end, reason });
}

function inlineCodeMarkerLength(raw: string, start: number): number {
  let end = start;
  while (raw[end] === "`") end++;
  return Math.max(1, end - start);
}

function addFormattingRange(
  ranges: MarkdownFormattingRange[],
  start: number,
  end: number,
  marker: MarkdownDelimiter,
): void {
  const openerEnd = start + marker.length;
  const closeStart = end - marker.length;
  if (closeStart < openerEnd) return;
  ranges.push({ start, openerEnd, closeStart, end, marker });
}

function addInlineCodeRange(
  ranges: MarkdownInlineCodeRange[],
  start: number,
  end: number,
  marker: string,
): void {
  const openerEnd = start + marker.length;
  const closeStart = end - marker.length;
  if (closeStart < openerEnd) return;
  ranges.push({ start, openerEnd, closeStart, end, marker });
}

function collectAstUnsafeZones(
  raw: string,
  zones: UnsafeZone[],
  formattingRanges: MarkdownFormattingRange[],
  inlineCodeRanges: MarkdownInlineCodeRange[],
  node: unknown,
): void {
  if (typeof node !== "object" || node === null) return;
  const current = node as MarkdownNode;
  const type = typeof current.type === "string" ? current.type : "";
  const start = current.position?.start?.offset;
  const end = current.position?.end?.offset;

  if (typeof start === "number" && typeof end === "number" && end > start) {
    switch (type) {
      case "strong": {
        const marker = raw.startsWith("__", start) ? "__" : "**";
        addZone(zones, start, Math.min(end, start + marker.length), "marker");
        addZone(zones, Math.max(start, end - marker.length), end, "marker");
        addFormattingRange(formattingRanges, start, end, marker);
        break;
      }
      case "emphasis": {
        const marker = raw.startsWith("_", start) ? "_" : "*";
        addZone(zones, start, Math.min(end, start + marker.length), "marker");
        addZone(zones, Math.max(start, end - marker.length), end, "marker");
        addFormattingRange(formattingRanges, start, end, marker);
        break;
      }
      case "delete":
        addZone(zones, start, Math.min(end, start + 2), "marker");
        addZone(zones, Math.max(start, end - 2), end, "marker");
        addFormattingRange(formattingRanges, start, end, "~~");
        break;
      case "inlineCode": {
        const len = inlineCodeMarkerLength(raw, start);
        const marker = "`".repeat(len);
        addZone(zones, start, Math.min(end, start + len), "marker");
        addZone(zones, Math.max(start, end - len), end, "marker");
        addInlineCodeRange(inlineCodeRanges, start, end, marker);
        break;
      }
      case "link":
        addZone(zones, start, end, "link");
        break;
      case "image":
        addZone(zones, start, end, "image");
        break;
      case "html":
        addZone(zones, start, end, "html");
        break;
    }
  }

  if (Array.isArray(current.children)) {
    for (const child of current.children) {
      collectAstUnsafeZones(raw, zones, formattingRanges, inlineCodeRanges, child);
    }
  }
}

function scanCodeFences(raw: string, zones: UnsafeZone[]): CodeFenceRange[] {
  const fences: CodeFenceRange[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const openerEnd = lineEndIndex(raw, pos);
    const openerLine = raw.slice(pos, openerEnd);
    const opener = parseFenceOpener(openerLine);

    if (!opener) {
      pos = openerEnd;
      continue;
    }

    let scan = openerEnd;
    let closeStart: number | null = null;
    let closeEnd: number | null = null;
    let nestedFence: { marker: "`" | "~"; markerLength: number } | null = null;

    while (scan < raw.length) {
      const end = lineEndIndex(raw, scan);
      const line = raw.slice(scan, end);

      if (isMarkdownFenceLanguage(opener.lang)) {
        if (nestedFence !== null) {
          if (
            opener.markerLength > nestedFence.markerLength &&
            parseFenceCloser(line, opener.marker, opener.markerLength)
          ) {
            closeStart = scan;
            closeEnd = end;
            break;
          }

          if (parseFenceCloser(line, nestedFence.marker, nestedFence.markerLength)) {
            nestedFence = null;
          }
          scan = end;
          continue;
        }

        const nestedOpener = parseFenceOpener(line);
        if (
          nestedOpener &&
          nestedOpener.markerLength < opener.markerLength &&
          line.trim() !== opener.marker.repeat(opener.markerLength)
        ) {
          nestedFence = {
            marker: nestedOpener.marker,
            markerLength: nestedOpener.markerLength,
          };
          scan = end;
          continue;
        }
      }

      if (parseFenceCloser(line, opener.marker, opener.markerLength)) {
        closeStart = scan;
        closeEnd = end;
        break;
      }
      scan = end;
    }

    addZone(zones, pos, openerEnd, "fence-line");
    if (closeStart !== null && closeEnd !== null) {
      addZone(zones, closeStart, closeEnd, "fence-line");
    }

    fences.push({
      start: pos,
      openerEnd,
      closeStart,
      end: closeEnd,
      marker: opener.marker,
      markerLength: opener.markerLength,
      lang: opener.lang,
    });

    pos = closeEnd ?? raw.length;
  }

  return fences;
}

function getActiveFence(
  offset: number,
  codeFences: readonly CodeFenceRange[],
): CodeFenceRange | null {
  for (const fence of codeFences) {
    if (offset >= fence.openerEnd && (fence.closeStart === null || offset < fence.closeStart)) {
      return fence;
    }
  }
  return null;
}

function getActiveBlockquote(
  offset: number,
  blockquotes: readonly BlockquoteRange[],
): BlockquoteRange | null {
  return (
    blockquotes.find(
      (blockquote) => offset >= blockquote.contentStart && offset < blockquote.lineEnd,
    ) ?? null
  );
}

function scanBlockquotes(
  raw: string,
  codeFences: readonly CodeFenceRange[],
  zones: UnsafeZone[],
): BlockquoteRange[] {
  const blockquotes: BlockquoteRange[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const end = lineEndIndex(raw, pos);
    const activeFence = getActiveFence(pos, codeFences);

    if (activeFence === null) {
      const line = raw.slice(pos, end);
      const match = /^( {0,3}(?:>>>|>)[ \t])/u.exec(line);
      if (match?.[1]) {
        const isMultiline = match[1].trimStart().startsWith(">>>");
        const contentStart = pos + match[1].length;
        addZone(zones, pos, contentStart, "marker");
        blockquotes.push({
          lineStart: pos,
          contentStart,
          lineEnd: isMultiline ? raw.length : line.endsWith("\n") ? end - 1 : end,
          prefix: match[1],
        });
        if (isMultiline) break;
      }
    }

    pos = end;
  }

  return blockquotes;
}

function findFormattingMarkerRangeAt(
  offset: number,
  formattingRanges: readonly MarkdownFormattingRange[],
): MarkdownFormattingRange | null {
  return (
    formattingRanges.find(
      (range) =>
        (offset >= range.start && offset < range.openerEnd) ||
        (offset >= range.closeStart && offset < range.end),
    ) ?? null
  );
}

function delimiterAt(raw: string, pos: number): MarkdownDelimiter | null {
  if (raw.startsWith("**", pos)) return "**";
  if (raw.startsWith("__", pos)) return "__";
  if (raw.startsWith("~~", pos)) return "~~";
  const ch = raw[pos];
  if (ch === "*") return "*";
  if (ch === "_") return "_";
  return null;
}

function isEscaped(raw: string, pos: number): boolean {
  let count = 0;
  for (let i = pos - 1; i >= 0 && raw[i] === "\\"; i--) {
    count++;
  }
  return count % 2 === 1;
}

function canOpenDelimiter(raw: string, pos: number, delimiter: MarkdownDelimiter): boolean {
  if (isEscaped(raw, pos)) return false;

  const before = raw[pos - 1] ?? "";
  const after = raw[pos + delimiter.length] ?? "";
  if (!after || /\s/u.test(after)) return false;
  if (/\w/u.test(before)) return false;

  if ((delimiter === "_" || delimiter === "__") && /\w/u.test(before) && /\w/u.test(after)) {
    return false;
  }

  return true;
}

function toggleDelimiter(stack: MarkdownDelimiter[], delimiter: MarkdownDelimiter): void {
  const index = stack.lastIndexOf(delimiter);
  if (index === -1) {
    stack.push(delimiter);
    return;
  }
  stack.splice(index, 1);
}

function scanInlineState(
  raw: string,
  offset: number,
  codeFences: readonly CodeFenceRange[],
  blockquotes: readonly BlockquoteRange[],
  formattingRanges: readonly MarkdownFormattingRange[],
  inlineCodeRanges: readonly MarkdownInlineCodeRange[],
): MarkdownState {
  const end = Math.max(0, Math.min(offset, raw.length));
  const openFormatting: MarkdownDelimiter[] = [];
  let openInlineMarker: string | null = null;
  let pos = 0;

  while (pos < end) {
    const formattingMarkerRange = findFormattingMarkerRangeAt(pos, formattingRanges);
    if (formattingMarkerRange) {
      pos = Math.min(
        end,
        pos < formattingMarkerRange.openerEnd
          ? formattingMarkerRange.openerEnd
          : formattingMarkerRange.end,
      );
      continue;
    }

    const inlineRange = inlineCodeRanges.find((range) => range.start === pos);
    if (inlineRange) {
      pos = Math.min(end, inlineRange.end);
      continue;
    }

    const fenceLine = codeFences.find((fence) => fence.start === pos || fence.closeStart === pos);
    if (fenceLine) {
      pos = Math.min(end, fenceLine.start === pos ? fenceLine.openerEnd : (fenceLine.end ?? end));
      continue;
    }

    const activeFence = getActiveFence(pos, codeFences);
    if (activeFence) {
      pos = Math.min(end, activeFence.closeStart ?? raw.length);
      continue;
    }

    const ch = raw[pos];
    if (ch === "`" && !isEscaped(raw, pos)) {
      let runEnd = pos;
      while (raw[runEnd] === "`") runEnd++;
      const marker = raw.slice(pos, runEnd);
      openInlineMarker = openInlineMarker === marker ? null : marker;
      pos = runEnd;
      continue;
    }

    if (openInlineMarker !== null) {
      pos += 1;
      continue;
    }

    const delimiter = delimiterAt(raw, pos);
    if (delimiter && canOpenDelimiter(raw, pos, delimiter)) {
      toggleDelimiter(openFormatting, delimiter);
      pos += delimiter.length;
      continue;
    }

    pos += 1;
  }

  const fence = getActiveFence(end, codeFences);
  const blockquote = getActiveBlockquote(end, blockquotes);
  const formatting = formattingRanges
    .filter((range) => end >= range.openerEnd && end <= range.closeStart)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((range) => range.marker);
  const inlineCode = inlineCodeRanges.find(
    (range) => end >= range.openerEnd && end <= range.closeStart,
  );
  const closedFormatting = new Set(formatting);
  const extraFormatting = openFormatting.filter((marker) => !closedFormatting.has(marker));

  return {
    fence: fence ? { markerLength: fence.markerLength, lang: fence.lang } : null,
    blockquote: blockquote ? { prefix: blockquote.prefix } : null,
    inlineCode: inlineCode
      ? { marker: inlineCode.marker }
      : openInlineMarker
        ? { marker: openInlineMarker }
        : null,
    formatting: formatting.concat(extraFormatting),
  };
}

function isSafeOffset(offset: number, zones: readonly UnsafeZone[]): boolean {
  for (const zone of zones) {
    if (offset > zone.start && offset < zone.end) return false;
  }
  return true;
}

export function buildMarkdownIndex(raw: string): MarkdownIndex {
  const unsafeZones: UnsafeZone[] = [];
  const formattingRanges: MarkdownFormattingRange[] = [];
  const inlineCodeRanges: MarkdownInlineCodeRange[] = [];
  const tree = fromMarkdown(raw, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  collectAstUnsafeZones(raw, unsafeZones, formattingRanges, inlineCodeRanges, tree);
  const codeFences = scanCodeFences(raw, unsafeZones);
  const blockquotes = scanBlockquotes(raw, codeFences, unsafeZones);

  unsafeZones.sort((a, b) => a.start - b.start || a.end - b.end);
  codeFences.sort((a, b) => a.start - b.start || a.openerEnd - b.openerEnd);
  blockquotes.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  formattingRanges.sort((a, b) => a.start - b.start || b.end - a.end);
  inlineCodeRanges.sort((a, b) => a.start - b.start || b.end - a.end);

  return {
    unsafeZones,
    codeFences,
    blockquotes,
    formattingRanges,
    inlineCodeRanges,
    getStateAt: (offset) =>
      scanInlineState(raw, offset, codeFences, blockquotes, formattingRanges, inlineCodeRanges),
    isSafeOffset: (offset) => isSafeOffset(offset, unsafeZones),
  };
}
