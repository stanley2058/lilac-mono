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

function hasOpenInlineCode(text: string): boolean {
  const source = stripCodeFences(text);
  let openMarker: string | null = null;
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "`") {
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

  return openMarker !== null;
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

    if (rest.startsWith("***")) {
      toggleInlineTag(openInlineTags, "***");
      i += 3;
    } else if (rest.startsWith("**")) {
      toggleInlineTag(openInlineTags, "**");
      i += 2;
    } else if (rest.startsWith("__")) {
      toggleInlineTag(openInlineTags, "__");
      i += 2;
    } else if (rest.startsWith("~~")) {
      toggleInlineTag(openInlineTags, "~~");
      i += 2;
    } else if (rest.startsWith("$$")) {
      const isLineStart = i === 0 || source[i - 1] === "\n";
      toggleInlineTag(openInlineTags, isLineStart ? "$$\n" : "$$");
      i += 2;
    } else if (rest.startsWith("*")) {
      toggleInlineTag(openInlineTags, "*");
      i += 1;
    } else if (rest.startsWith("_")) {
      toggleInlineTag(openInlineTags, "_");
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

  if (hasOpenInlineCode(text)) {
    return {
      openFence: null,
      openInlineTags: ["`"],
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
    return "```" + langPart + "\n";
  }

  return state.openInlineTags.join("");
}
