/* oxlint-disable eslint/no-control-regex */

import remend from "remend";

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

function longestCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (; i < max; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) break;
  }
  return i;
}

function getCloseSuffix(original: string, completed: string): string {
  const lcp = longestCommonPrefixLength(original, completed);
  return completed.slice(lcp);
}

function detectClosedTagsFromSuffix(addedSuffix: string): string[] {
  const openingTags: string[] = [];

  if (!addedSuffix) return openingTags;

  let remaining = addedSuffix;

  while (remaining.length > 0) {
    const fenceMatch = /^`{3,}/u.exec(remaining);
    if (fenceMatch?.[0]) {
      openingTags.unshift(fenceMatch[0]);
      remaining = remaining.slice(fenceMatch[0].length);
    } else if (remaining.startsWith("***")) {
      openingTags.unshift("***");
      remaining = remaining.slice(3);
    } else if (remaining.startsWith("**")) {
      openingTags.unshift("**");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("__")) {
      openingTags.unshift("__");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("~~")) {
      openingTags.unshift("~~");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("$$")) {
      openingTags.unshift("$$");
      remaining = remaining.slice(2);
    } else if (remaining.startsWith("`")) {
      openingTags.unshift("`");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("*")) {
      openingTags.unshift("*");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("_")) {
      openingTags.unshift("_");
      remaining = remaining.slice(1);
    } else if (remaining.startsWith("\n$$")) {
      openingTags.unshift("$$");
      remaining = remaining.slice(3);
    } else {
      remaining = remaining.slice(1);
    }
  }

  return openingTags;
}

function detectClosedTags(original: string, completed: string): string[] {
  return detectClosedTagsFromSuffix(getCloseSuffix(original, completed));
}

function findCodeBlockLanguage(text: string): string {
  const matches = [...text.matchAll(/^(?: {0,3})(`{3,})([^`\n]*)\n/gmu)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) return "";

  return (lastMatch[2] || "").trim();
}

function buildOpeningPrefix(closedTags: string[], originalText: string): string {
  return closedTags
    .map((tag) => {
      if (tag.startsWith("```")) {
        const lang = findCodeBlockLanguage(originalText);
        return tag + lang + "\n";
      }
      if (tag === "$$") {
        const isBlockMath = /\$\$\n/.test(originalText);
        return isBlockMath ? "$$\n" : "$$";
      }
      return tag;
    })
    .join("");
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
  const closedTags = detectClosedTags(firstPart, completedFirst);
  const openingPrefix = buildOpeningPrefix(closedTags, firstPart);

  return {
    completed: completedFirst,
    overflow: remainingPart.length > 0 ? openingPrefix + remainingPart : "",
  };
}

export function completeMarkdown(input: string): string {
  return safeRemend(input);
}
