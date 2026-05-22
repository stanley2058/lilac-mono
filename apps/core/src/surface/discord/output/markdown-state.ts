const FENCE_LINE_RE = /^(?: {0,3})(`{3,})([^`]*)$/u;
const FENCE_CLOSE_RE = /^(?: {0,3})(`{3,})\s*$/u;

export interface OpenCodeFence {
  marker: string;
  lang: string;
}

export interface MarkdownContinuationState {
  openFence: OpenCodeFence | null;
  openInlineTags: readonly string[];
}

function lineEndIndex(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline + 1;
}

function parseFenceOpener(line: string): OpenCodeFence | null {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = FENCE_LINE_RE.exec(withoutNewline);
  if (!match) return null;

  const marker = match[1] ?? "```";
  return {
    marker,
    lang: (match[2] ?? "").trim(),
  };
}

function isFenceCloser(line: string, markerLength: number): boolean {
  return getFenceCloserLength(line) >= markerLength;
}

function getFenceCloserLength(line: string): number {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = FENCE_CLOSE_RE.exec(withoutNewline);
  return match?.[1]?.length ?? 0;
}

function hasLaterFenceCloser(text: string, start: number, markerLength: number): boolean {
  let scan = start;

  while (scan < text.length) {
    const end = lineEndIndex(text, scan);
    const line = text.slice(scan, end);

    if (isFenceCloser(line, markerLength)) return true;

    scan = end;
  }

  return false;
}

function isMarkdownFenceLanguage(lang: string): boolean {
  const normalized = lang.toLowerCase();
  return normalized === "md" || normalized === "markdown";
}

function findFenceCloser(
  text: string,
  start: number,
  opener: OpenCodeFence,
): { start: number; end: number } | null {
  let scan = start;
  const nestedMarkdownFenceMarkerLengths: number[] = [];
  const tracksNestedMarkdownFences = isMarkdownFenceLanguage(opener.lang);

  while (scan < text.length) {
    const end = lineEndIndex(text, scan);
    const line = text.slice(scan, end);
    const nestedMarkerLength = nestedMarkdownFenceMarkerLengths.at(-1);
    const closerLength = getFenceCloserLength(line);

    if (
      nestedMarkerLength !== undefined &&
      closerLength >= opener.marker.length &&
      (closerLength > nestedMarkerLength || !hasLaterFenceCloser(text, end, opener.marker.length))
    ) {
      return { start: scan, end };
    }

    if (nestedMarkerLength !== undefined && closerLength >= nestedMarkerLength) {
      nestedMarkdownFenceMarkerLengths.pop();
      scan = end;
      continue;
    }

    if (
      nestedMarkdownFenceMarkerLengths.length === 0 &&
      isFenceCloser(line, opener.marker.length)
    ) {
      return { start: scan, end };
    }

    if (tracksNestedMarkdownFences) {
      const nestedOpener = parseFenceOpener(line);
      if (nestedOpener) {
        nestedMarkdownFenceMarkerLengths.push(nestedOpener.marker.length);
        scan = end;
        continue;
      }
    }

    scan = end;
  }

  return null;
}

function findOpenCodeFence(text: string): OpenCodeFence | null {
  let pos = 0;

  while (pos < text.length) {
    const end = lineEndIndex(text, pos);
    const line = text.slice(pos, end);
    const opener = parseFenceOpener(line);

    if (!opener) {
      pos = end;
      continue;
    }

    const closer = findFenceCloser(text, end, opener);
    if (!closer) return opener;

    pos = closer.end;
  }

  return null;
}

function stripCodeFences(text: string): string {
  let result = "";
  let pos = 0;

  while (pos < text.length) {
    const end = lineEndIndex(text, pos);
    const line = text.slice(pos, end);
    const opener = parseFenceOpener(line);

    if (!opener) {
      result += line;
      pos = end;
      continue;
    }

    const closer = findFenceCloser(text, end, opener);
    const blockEnd = closer?.end ?? text.length;
    const newlineCount = text.slice(pos, blockEnd).split("\n").length - 1;
    result += "\n".repeat(Math.max(1, newlineCount));
    pos = blockEnd;
  }

  return result;
}

function getOpenInlineCodeMarker(text: string): string | null {
  const source = stripCodeFences(text);
  let openMarker: string | null = null;
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "`") {
      i++;
      continue;
    }

    const end = backtickRunEnd(source, i);

    const marker = source.slice(i, end);
    if (isIndentedCodeBacktickRun(source, i, marker.length)) {
      i = end;
      continue;
    }

    if (openMarker === marker) openMarker = null;
    else if (openMarker === null && !isEscaped(source, i)) openMarker = marker;

    i = end;
  }

  return openMarker;
}

function backtickRunEnd(source: string, start: number): number {
  let end = start + 1;
  while (source[end] === "`") end++;
  return end;
}

function isIndentedCodeBacktickRun(source: string, start: number, markerLength: number): boolean {
  if (markerLength < 3) return false;

  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indent = source.slice(lineStart, start);
  return indent.length >= 4 && /^ +$/u.test(indent);
}

function stripCodeSpansAndFences(text: string): string {
  const source = stripCodeFences(text);
  let result = "";
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "`" || isEscaped(source, i)) {
      result += source[i];
      i++;
      continue;
    }

    const markerEnd = backtickRunEnd(source, i);
    const marker = source.slice(i, markerEnd);
    if (isIndentedCodeBacktickRun(source, i, marker.length)) {
      result += marker;
      i = markerEnd;
      continue;
    }

    const closerStart = source.indexOf(marker, markerEnd);
    if (closerStart === -1) {
      i = source.length;
      continue;
    }

    result += "x";
    i = closerStart + marker.length;
  }

  return result;
}

function isEscaped(source: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isWhitespace(char: string): boolean {
  return char === "" || /\s/u.test(char);
}

function isPunctuation(char: string): boolean {
  return (
    char !== "" &&
    (/[!"#$%&'()+,\-./:;<=>?@[\\\]^`{|}~]/u.test(char) ||
      (char.charCodeAt(0) > 0x7f && /\p{P}/u.test(char)))
  );
}

function isAlphanumeric(char: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(char);
}

function canOpenDelimiter(source: string, start: number, length: number, marker: string): boolean {
  const before = source[start - 1] ?? "";
  const after = source[start + length] ?? "";

  if (isWhitespace(after)) return false;

  const leftFlanking =
    !isWhitespace(after) &&
    (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  if (!leftFlanking) return false;

  if (marker === "_" || marker === "__") {
    return !isAlphanumeric(before);
  }

  return true;
}

function hasClosingDelimiter(source: string, start: number, marker: string): boolean {
  let scan = start + marker.length;

  while (scan < source.length) {
    const next = source.indexOf(marker, scan);
    if (next === -1) return false;
    if (!isEscaped(source, next) && canCloseDelimiter(source, next, marker)) return true;
    scan = next + marker.length;
  }

  return false;
}

function canCloseDelimiter(source: string, start: number, marker: string): boolean {
  const before = source[start - 1] ?? "";
  const after = source[start + marker.length] ?? "";

  if (isWhitespace(before)) return false;

  const rightFlanking =
    !isWhitespace(before) &&
    (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  if (!rightFlanking) return false;

  if (marker === "_" || marker === "__") {
    return !isAlphanumeric(after);
  }

  return true;
}

function toggleDelimitedInlineTag(
  source: string,
  start: number,
  tag: string,
  openInlineTags: string[],
  lookahead: string,
): boolean {
  if (isEscaped(source, start)) return false;

  if (openInlineTags[0] === tag && canCloseDelimiter(source, start, tag)) {
    openInlineTags.shift();
    return true;
  }

  const before = source[start - 1] ?? "";
  const after = source[start + tag.length] ?? "";
  if (
    before === "" &&
    (tag === "**" || tag === "__" || tag === "***") &&
    isWhitespace(after) &&
    hasClosingDelimiter(source + lookahead, start, tag)
  ) {
    openInlineTags.unshift(tag);
    return true;
  }

  if (canOpenDelimiter(source, start, tag.length, tag)) {
    openInlineTags.unshift(tag);
    return true;
  }

  return false;
}

function toggleInlineTag(openInlineTags: string[], tag: string): void {
  if (openInlineTags[0] === tag) {
    openInlineTags.shift();
    return;
  }

  openInlineTags.unshift(tag);
}

function isMathDelimiter(
  source: string,
  start: number,
  lookahead: string,
  openInlineTags: readonly string[],
): boolean {
  if (isEscaped(source, start)) return false;

  const before = source[start - 1] ?? "";
  const after = source[start + 2] ?? lookahead[0] ?? "";
  const isLineStart = start === 0 || before === "\n";

  if (openInlineTags[0] === "$$") return !isWhitespace(before);
  if (openInlineTags[0] === "$$\n") return isLineStart && (after === "" || after === "\n");

  return isLineStart ? after === "\n" : !isWhitespace(after);
}

function delimiterRunEnd(source: string, start: number, delimiter: string): number {
  let end = start + 1;
  while (source[end] === delimiter) end++;
  return end;
}

function detectOpenInlineTags(text: string, lookahead: string): readonly string[] {
  const source = stripCodeSpansAndFences(text);
  const openInlineTags: string[] = [];

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    if (rest.startsWith("*")) {
      const end = delimiterRunEnd(source, i, "*");
      const marker = source.slice(i, end);

      toggleDelimitedInlineTag(source, i, marker, openInlineTags, lookahead);
      i = end;
    } else if (
      rest.startsWith("__") &&
      toggleDelimitedInlineTag(source, i, "__", openInlineTags, lookahead)
    ) {
      i += 2;
    } else if (
      rest.startsWith("~~") &&
      toggleDelimitedInlineTag(source, i, "~~", openInlineTags, lookahead)
    ) {
      i += 2;
    } else if (rest.startsWith("$$") && isMathDelimiter(source, i, lookahead, openInlineTags)) {
      const isLineStart = i === 0 || source[i - 1] === "\n";
      toggleInlineTag(openInlineTags, isLineStart ? "$$\n" : "$$");
      i += 2;
    } else if (
      rest.startsWith("_") &&
      toggleDelimitedInlineTag(source, i, "_", openInlineTags, lookahead)
    ) {
      i += 1;
    } else {
      i += 1;
    }
  }

  return openInlineTags;
}

export function getMarkdownContinuationState(
  text: string,
  lookahead: string = "",
): MarkdownContinuationState {
  const openFence = findOpenCodeFence(text);
  if (openFence) {
    return {
      openFence,
      openInlineTags: [],
    };
  }

  const openInlineCodeMarker = getOpenInlineCodeMarker(text);
  if (openInlineCodeMarker) {
    return {
      openFence: null,
      openInlineTags: [openInlineCodeMarker, ...detectOpenInlineTags(text, lookahead)],
    };
  }

  return {
    openFence: null,
    openInlineTags: detectOpenInlineTags(text, lookahead),
  };
}

export function buildMarkdownContinuationPrefix(state: MarkdownContinuationState): string {
  if (state.openFence) {
    const langPart = state.openFence.lang ? state.openFence.lang : "";
    return state.openFence.marker + langPart + "\n";
  }

  return [...state.openInlineTags].reverse().join("");
}
