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
  const withoutNewline = line.replace(/\n$/u, "");
  const match = FENCE_CLOSE_RE.exec(withoutNewline);
  return (match?.[1]?.length ?? 0) >= markerLength;
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
  let closer: { start: number; end: number } | null = null;

  while (scan < text.length) {
    const end = lineEndIndex(text, scan);
    const line = text.slice(scan, end);

    if (isFenceCloser(line, opener.marker.length)) {
      closer = { start: scan, end };
      if (!isMarkdownFenceLanguage(opener.lang)) return closer;
    }

    scan = end;
  }

  return closer;
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

function stripCodeSpansAndFences(text: string): string {
  return stripCodeFences(text).replace(/`+[^`]*`*/gu, "");
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

    if (isEscaped(source, i)) {
      i++;
      continue;
    }

    let end = i + 1;
    while (source[end] === "`") end++;

    const marker = source.slice(i, end);
    if (marker.length >= 3) {
      i = end;
      continue;
    }

    if (openMarker === marker) openMarker = null;
    else if (openMarker === null) openMarker = marker;

    i = end;
  }

  return openMarker;
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
  return char !== "" && /[!"#$%&'()+,\-./:;<=>?@[\\\]^`{|}~]/u.test(char);
}

function isAsciiAlphanumeric(char: string): boolean {
  return /^[A-Za-z0-9]$/u.test(char);
}

function canOpenDelimiter(source: string, start: number, length: number, marker: string): boolean {
  const before = source[start - 1] ?? "";
  const after = source[start + length] ?? "";

  if (isWhitespace(after)) return before === "" && marker.length > 1;

  const leftFlanking =
    !isWhitespace(after) &&
    (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  if (!leftFlanking) return false;

  if (marker === "_" || marker === "__") {
    return !isAsciiAlphanumeric(before);
  }

  return true;
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
    return !isAsciiAlphanumeric(after);
  }

  return true;
}

function toggleDelimitedInlineTag(
  source: string,
  start: number,
  tag: string,
  openInlineTags: string[],
): boolean {
  if (isEscaped(source, start)) return false;

  if (openInlineTags[0] === tag && canCloseDelimiter(source, start, tag)) {
    openInlineTags.shift();
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

function detectOpenInlineTags(text: string): readonly string[] {
  const source = stripCodeSpansAndFences(text);
  const openInlineTags: string[] = [];

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    if (rest.startsWith("***") && toggleDelimitedInlineTag(source, i, "***", openInlineTags)) {
      i += 3;
    } else if (rest.startsWith("**") && toggleDelimitedInlineTag(source, i, "**", openInlineTags)) {
      i += 2;
    } else if (rest.startsWith("__") && toggleDelimitedInlineTag(source, i, "__", openInlineTags)) {
      i += 2;
    } else if (rest.startsWith("~~")) {
      toggleInlineTag(openInlineTags, "~~");
      i += 2;
    } else if (rest.startsWith("$$")) {
      const isLineStart = i === 0 || source[i - 1] === "\n";
      toggleInlineTag(openInlineTags, isLineStart ? "$$\n" : "$$");
      i += 2;
    } else if (rest.startsWith("*") && toggleDelimitedInlineTag(source, i, "*", openInlineTags)) {
      i += 1;
    } else if (rest.startsWith("_") && toggleDelimitedInlineTag(source, i, "_", openInlineTags)) {
      i += 1;
    } else {
      i += 1;
    }
  }

  return openInlineTags;
}

export function getMarkdownContinuationState(text: string): MarkdownContinuationState {
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
      openInlineTags: [openInlineCodeMarker, ...detectOpenInlineTags(text)],
    };
  }

  return {
    openFence: null,
    openInlineTags: detectOpenInlineTags(text),
  };
}

export function buildMarkdownContinuationPrefix(state: MarkdownContinuationState): string {
  if (state.openFence) {
    const langPart = state.openFence.lang ? state.openFence.lang : "";
    return state.openFence.marker + langPart + "\n";
  }

  return [...state.openInlineTags].reverse().join("");
}
