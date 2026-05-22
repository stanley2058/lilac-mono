/* oxlint-disable eslint/no-control-regex */

import remend from "remend";

import { buildMarkdownContinuationPrefix, getMarkdownContinuationState } from "./markdown-state";

// Null character used as placeholder delimiter (won't appear in normal text)
const CODE_PLACEHOLDER = "\x00";
const ZERO_WIDTH_SPACE = "\u200b";

interface CodeBlock {
  type: "fence" | "inline";
  content: string;
  lang: string;
  closed: boolean;
  markerLength?: number;
  closeTrailingNewline?: string;
}

function lineEndIndex(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline + 1;
}

function parseFenceOpener(line: string): { markerLength: number; lang: string } | null {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = /^(?: {0,3})(`{3,})([^`]*)$/u.exec(withoutNewline);
  if (!match) return null;

  return {
    markerLength: match[1]?.length ?? 3,
    lang: (match[2] ?? "").trim(),
  };
}

function parseFenceCloser(line: string, markerLength: number): boolean {
  const withoutNewline = line.replace(/\n$/u, "");
  const match = /^(?: {0,3})(`{3,})\s*$/u.exec(withoutNewline);
  return (match?.[1]?.length ?? 0) >= markerLength;
}

function escapeNestedFenceMarkers(text: string): string {
  return text.replace(/^( {0,3})(`{3,})/gmu, (_match, indent: string, marker: string) => {
    return indent + marker[0] + ZERO_WIDTH_SPACE + marker.slice(1);
  });
}

function isMarkdownFenceLanguage(lang: string): boolean {
  const normalized = lang.toLowerCase();
  return normalized === "md" || normalized === "markdown";
}

function escapeCodeBlocks(text: string): {
  escaped: string;
  codeBlocks: CodeBlock[];
} {
  const codeBlocks: CodeBlock[] = [];

  let result = "";
  let pos = 0;

  while (pos < text.length) {
    const openerLineEnd = lineEndIndex(text, pos);
    const openerLine = text.slice(pos, openerLineEnd);
    const opener = parseFenceOpener(openerLine);

    if (!opener) {
      result += openerLine;
      pos = openerLineEnd;
      continue;
    }

    let scan = openerLineEnd;
    let closerStart = -1;
    let closerEnd = -1;

    while (scan < text.length) {
      const end = lineEndIndex(text, scan);
      const line = text.slice(scan, end);
      if (parseFenceCloser(line, opener.markerLength)) {
        closerStart = scan;
        closerEnd = end;
        if (!isMarkdownFenceLanguage(opener.lang)) break;
      }
      scan = end;
    }

    const idx = codeBlocks.length;
    const isClosed = closerStart !== -1;
    const contentEnd = isClosed ? closerStart : text.length;
    const content = text.slice(openerLineEnd, contentEnd);
    codeBlocks.push({
      type: "fence",
      content,
      lang: opener.lang,
      closed: isClosed,
      markerLength: opener.markerLength,
      closeTrailingNewline:
        isClosed && text.slice(closerStart, closerEnd).endsWith("\n") ? "\n" : "",
    });

    if (isClosed) {
      result += `${CODE_PLACEHOLDER}FENCE${idx}${CODE_PLACEHOLDER}`;
      pos = closerEnd;
      continue;
    }

    // Unclosed: keep a Discord-supported opener visible so remend can still
    // repair nearby formatting, but hide fence content from emphasis/link repair.
    const newline = openerLine.endsWith("\n") ? "\n" : "";
    result += `\`\`\`${opener.lang}${newline}${CODE_PLACEHOLDER}FENCECONTENT${idx}${CODE_PLACEHOLDER}`;
    pos = text.length;
  }

  // Then handle inline code (single backticks) - both closed and unclosed
  // Now safe because all ``` are replaced with placeholders
  result = result.replace(/`([^`\x00]+)(`|$)/g, (_match, content: string, closing: string) => {
    const idx = codeBlocks.length;
    const isClosed = closing === "`";
    codeBlocks.push({ type: "inline", content, lang: "", closed: isClosed });

    if (isClosed) {
      // Closed: completely replace with placeholder
      return `${CODE_PLACEHOLDER}INLINE${idx}${CODE_PLACEHOLDER}`;
    }

    // Unclosed: keep ` visible so remend can close it, hide content
    return `\`${CODE_PLACEHOLDER}INLINECONTENT${idx}${CODE_PLACEHOLDER}`;
  });

  return { escaped: result, codeBlocks };
}

function restoreCodeBlocks(text: string, codeBlocks: CodeBlock[]): string {
  let result = text;
  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    if (!block) continue;

    if (block.type === "fence") {
      if (block.closed) {
        const placeholder = `${CODE_PLACEHOLDER}FENCE${i}${CODE_PLACEHOLDER}`;
        const langPart = block.lang ? block.lang + "\n" : "";
        const restored =
          "```" +
          langPart +
          escapeNestedFenceMarkers(block.content) +
          "```" +
          (block.closeTrailingNewline ?? "");
        result = result.replace(placeholder, restored);
      } else {
        const placeholder = `${CODE_PLACEHOLDER}FENCECONTENT${i}${CODE_PLACEHOLDER}`;
        result = result.replace(placeholder, escapeNestedFenceMarkers(block.content));
      }
      continue;
    }

    if (block.closed) {
      const placeholder = `${CODE_PLACEHOLDER}INLINE${i}${CODE_PLACEHOLDER}`;
      const restored = "`" + block.content + "`";
      result = result.replace(placeholder, restored);
    } else {
      const placeholder = `${CODE_PLACEHOLDER}INLINECONTENT${i}${CODE_PLACEHOLDER}`;
      result = result.replace(placeholder, block.content);
    }
  }
  return result;
}

function closeUnclosedCodeFences(text: string): string {
  // Discord requires fenced code blocks to be explicitly closed to render.
  // `remend` doesn't reliably close fences, so we do a minimal line-based pass.
  let pos = 0;
  let openFenceLength: number | null = null;

  while (pos < text.length) {
    const end = lineEndIndex(text, pos);
    const line = text.slice(pos, end);

    if (openFenceLength === null) {
      const opener = parseFenceOpener(line);
      if (opener) openFenceLength = opener.markerLength;
    } else if (parseFenceCloser(line, openFenceLength)) {
      openFenceLength = null;
    }

    pos = end;
  }

  if (openFenceLength === null) return text;

  let out = text;
  if (!out.endsWith("\n")) out += "\n";
  out += "```";
  return out;
}

function safeRemend(text: string): string {
  const { escaped, codeBlocks } = escapeCodeBlocks(text);
  const completed = remend(escaped);
  const restored = restoreCodeBlocks(completed, codeBlocks);
  return closeUnclosedCodeFences(restored);
}

export function tokenComplete(
  input: string,
  maxOutput: number,
): { completed: string; overflow: string } {
  const completed = safeRemend(input);

  if (completed.length <= maxOutput) {
    return {
      completed,
      overflow: "",
    };
  }

  return tokenCompleteAt(input, maxOutput);
}

export function tokenCompleteAt(
  input: string,
  splitAt: number,
): { completed: string; overflow: string } {
  const clampedSplitAt = Math.max(0, Math.min(splitAt, input.length));
  const firstPart = input.slice(0, clampedSplitAt);
  const remainingPart = input.slice(clampedSplitAt);

  const completedFirst = safeRemend(firstPart);
  const openingPrefix = buildMarkdownContinuationPrefix(getMarkdownContinuationState(firstPart));

  return {
    completed: completedFirst,
    overflow: remainingPart.length > 0 ? openingPrefix + remainingPart : "",
  };
}

export function completeMarkdown(input: string): string {
  return safeRemend(input);
}
