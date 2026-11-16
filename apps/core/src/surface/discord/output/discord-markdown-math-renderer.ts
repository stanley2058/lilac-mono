import { Panic, Result } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Root } from "mdast";

import { renderLatex } from "../../../vendor/opentui-math/render";
import { settleSurfaceFallback } from "../../adapter";

export type DiscordMarkdownMathFallbackMode = "source" | "passthrough";
export type DiscordMarkdownMathRenderPhase = "streaming" | "terminal";
export type DiscordMarkdownMathRenderOptions = {
  maxWidth?: number;
  fallbackMode?: DiscordMarkdownMathFallbackMode;
};

type MathKind = "inline" | "display";

type ParagraphRange = {
  start: number;
  end: number;
  directRoot: boolean;
  hasHtml: boolean;
};

type MathCandidate = {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  kind: MathKind;
  complete: boolean;
  malformed: boolean;
  wholeDirectRootParagraph: boolean;
};

type Replacement = {
  start: number;
  end: number;
  value: string;
};

const MAX_CANDIDATES = 32;
const MAX_TOTAL_CANDIDATE_CHARS = 8000;
const MAX_MARKDOWN_CHARS = 100_000;
const MAX_AST_DEPTH = 1000;

function exceedsBlockquoteDepth(markdown: string): boolean {
  let depth = 0;
  let lineStart = true;
  for (let index = 0; index < markdown.length; index++) {
    const character = markdown[index];
    if (character === "\n") {
      depth = 0;
      lineStart = true;
      continue;
    }
    if (!lineStart) continue;
    if (character === " " || character === "\t") continue;
    if (character !== ">") {
      lineStart = false;
      continue;
    }
    depth++;
    if (depth > MAX_AST_DEPTH) return true;
  }
  return false;
}

function nodeChildren(node: Nodes | Root): readonly Nodes[] {
  return "children" in node ? (node.children as readonly Nodes[]) : [];
}

function nodeRange(node: Nodes): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : null;
}

function containsHtml(node: Nodes): boolean {
  const pending: Nodes[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === "html") return true;
    for (const child of nodeChildren(current)) pending.push(child);
  }
  return false;
}

function horizontalTrimRange(markdown: string, start: number, end: number): [number, number] {
  while (start < end && (markdown[start] === " " || markdown[start] === "\t")) start++;
  while (end > start && (markdown[end - 1] === " " || markdown[end - 1] === "\t")) end--;
  return [start, end];
}

function isWholeParagraphCandidate(
  markdown: string,
  candidateStart: number,
  candidateEnd: number,
  paragraph: ParagraphRange,
): boolean {
  if (!paragraph.directRoot) return false;
  const [start, end] = horizontalTrimRange(markdown, paragraph.start, paragraph.end);
  return start === candidateStart && end === candidateEnd;
}

function slashTokenAt(
  source: string,
  position: number,
): { token: "(" | ")" | "[" | "]"; delimiterStart: number; end: number } | null {
  if (source[position] !== "\\" || source[position - 1] === "\\") return null;
  let runEnd = position;
  while (source[runEnd] === "\\") runEnd++;
  const token = source[runEnd];
  if ((runEnd - position) % 2 === 0 || !/[()[\]]/u.test(token ?? "")) return null;
  return {
    token: token as "(" | ")" | "[" | "]",
    delimiterStart: runEnd - 1,
    end: runEnd + 1,
  };
}

function scanSlashCandidate(
  markdown: string,
  openerStart: number,
  openerEnd: number,
  rangeEnd: number,
  opener: "(" | "[",
): Omit<MathCandidate, "kind" | "wholeDirectRootParagraph"> {
  const closer = opener === "(" ? ")" : "]";
  let malformed = false;
  let depth = 1;
  let position = openerEnd;

  while (position < rangeEnd) {
    const token = slashTokenAt(markdown, position);
    if (!token) {
      position++;
      continue;
    }
    if (token.token === "(" || token.token === "[") {
      malformed = true;
      if (token.token === opener) depth++;
    }
    if (token.token === closer) {
      depth--;
      if (depth > 0) {
        position = token.end;
        continue;
      }
      return {
        start: openerStart,
        end: token.end,
        bodyStart: openerEnd,
        bodyEnd: token.delimiterStart,
        complete: true,
        malformed,
      };
    }
    position = token.end;
  }

  return {
    start: openerStart,
    end: rangeEnd,
    bodyStart: openerEnd,
    bodyEnd: rangeEnd,
    complete: false,
    malformed,
  };
}

function exactDollarRunLength(source: string, position: number): number {
  let end = position;
  while (source[end] === "$") end++;
  return end - position;
}

function parseDisplayCandidate(markdown: string, paragraph: ParagraphRange): MathCandidate | null {
  const [start, end] = horizontalTrimRange(markdown, paragraph.start, paragraph.end);
  if (start === end) return null;

  if (markdown.startsWith("$$", start)) {
    if (exactDollarRunLength(markdown, start) !== 2) return null;
    let position = start + 2;
    let closerStart = -1;
    while (position < end) {
      if (markdown[position] !== "$") {
        position++;
        continue;
      }
      const runLength = exactDollarRunLength(markdown, position);
      if (runLength > 1 && runLength !== 2) return null;
      if (runLength === 2) {
        closerStart = position;
        break;
      }
      position++;
    }
    if (closerStart === -1) {
      return {
        start,
        end,
        bodyStart: start + 2,
        bodyEnd: end,
        kind: "display",
        complete: false,
        malformed: false,
        wholeDirectRootParagraph: true,
      };
    }
    if (closerStart + 2 !== end) return null;
    return {
      start,
      end,
      bodyStart: start + 2,
      bodyEnd: closerStart,
      kind: "display",
      complete: true,
      malformed: false,
      wholeDirectRootParagraph: true,
    };
  }

  const opener = slashTokenAt(markdown, start);
  if (!opener || opener.delimiterStart !== start || opener.token !== "[") return null;
  const scanned = scanSlashCandidate(markdown, start, opener.end, end, "[");
  if (scanned.complete && scanned.end !== end) return null;
  return {
    ...scanned,
    kind: "display",
    wholeDirectRootParagraph: true,
  };
}

function displayCloserExistsAfterParagraph(
  markdown: string,
  paragraph: ParagraphRange,
  candidate: MathCandidate,
): boolean {
  if (candidate.complete) return false;
  if (markdown.startsWith("$$", candidate.start)) {
    let position = paragraph.end;
    while (position < markdown.length) {
      if (markdown[position] !== "$") {
        position++;
        continue;
      }
      const runLength = exactDollarRunLength(markdown, position);
      if (runLength === 2) return true;
      position += runLength;
    }
    return false;
  }

  const opener = slashTokenAt(markdown, candidate.start);
  if (!opener || opener.token !== "[") return false;
  return scanSlashCandidate(markdown, candidate.start, opener.end, markdown.length, "[").complete;
}

function firstUnclosedBacktick(markdown: string, start: number, end: number): number | null {
  let position = start;
  while (position < end) {
    if (markdown[position] !== "`" || slashRunBefore(markdown, position) % 2 === 1) {
      position++;
      continue;
    }
    return position;
  }
  return null;
}

function slashRunBefore(source: string, position: number): number {
  let start = position;
  while (start > 0 && source[start - 1] === "\\") start--;
  return position - start;
}

function renderedCandidateValue(
  markdown: string,
  candidate: MathCandidate,
  rendered: string,
): string | undefined {
  if (candidate.kind !== "display" && !rendered.includes("\n")) return inlineCode(rendered);
  if (candidate.kind !== "display" && !candidate.wholeDirectRootParagraph) return undefined;
  const eol = candidateEol(markdown, candidate);
  return fencedCode(rendered.replaceAll("\n", eol), "text", eol);
}

function eligibleTextContains(
  paragraph: Nodes,
  display: { readonly start: number; readonly end: number },
): boolean {
  const textPending: Array<{ node: Nodes; protected: boolean }> = [
    { node: paragraph, protected: false },
  ];
  while (textPending.length > 0) {
    const item = textPending.pop()!;
    const protectedNode =
      item.protected || item.node.type === "link" || item.node.type === "linkReference";
    const textRange = item.node.type === "text" && !protectedNode ? nodeRange(item.node) : null;
    if (textRange && textRange.start <= display.start && textRange.end >= display.end) return true;
    for (const child of nodeChildren(item.node)) {
      textPending.push({ node: child, protected: protectedNode });
    }
  }
  return false;
}

function collectCandidates(markdown: string): MathCandidate[] | null {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const candidates: MathCandidate[] = [];
  let candidateChars = 0;
  let exhausted = false;

  const addCandidate = (candidate: MathCandidate): void => {
    const sourceLength = candidate.end - candidate.start;
    const bodyLength = candidate.bodyEnd - candidate.bodyStart;
    const nextCandidateChars = candidateChars + sourceLength + bodyLength;
    if (candidates.length >= MAX_CANDIDATES || nextCandidateChars > MAX_TOTAL_CANDIDATE_CHARS) {
      exhausted = true;
      return;
    }
    candidates.push(candidate);
    candidateChars = nextCandidateChars;
    exhausted = candidates.length >= MAX_CANDIDATES || candidateChars >= MAX_TOTAL_CANDIDATE_CHARS;
  };

  /** Adds inline candidates from one text node; returns the offset that later text must skip. */
  const scanInlineText = (
    text: NonNullable<ReturnType<typeof nodeRange>>,
    paragraph: ParagraphRange,
    skipUntil: number,
  ): number => {
    const unclosedBacktick = firstUnclosedBacktick(markdown, text.start, text.end);
    const scanEnd = unclosedBacktick ?? text.end;
    let position = Math.max(text.start, skipUntil);
    while (position < scanEnd && !exhausted) {
      const token = slashTokenAt(markdown, position);
      if (!token || token.token !== "(") {
        position++;
        continue;
      }
      const scanned = scanSlashCandidate(markdown, token.delimiterStart, token.end, scanEnd, "(");
      if (!scanned.complete) {
        const paragraphScan = scanSlashCandidate(
          markdown,
          token.delimiterStart,
          token.end,
          paragraph.end,
          "(",
        );
        if (paragraphScan.complete) return paragraphScan.end;
      }
      addCandidate({
        ...scanned,
        kind: "inline",
        wholeDirectRootParagraph: isWholeParagraphCandidate(
          markdown,
          scanned.start,
          scanned.end,
          paragraph,
        ),
      });
      position = scanned.end;
    }
    return skipUntil;
  };

  const pending: Array<{ node: Root | Nodes; parentType: string | null; depth: number }> = [
    { node: tree, parentType: null, depth: 0 },
  ];
  while (pending.length > 0 && !exhausted) {
    const current = pending.pop()!;
    if (current.depth > MAX_AST_DEPTH) return null;
    if (current.node.type === "paragraph") {
      const range = nodeRange(current.node);
      if (!range || containsHtml(current.node)) continue;
      const paragraph: ParagraphRange = {
        ...range,
        directRoot: current.parentType === "root",
        hasHtml: false,
      };
      const display = paragraph.directRoot ? parseDisplayCandidate(markdown, paragraph) : null;
      if (display) {
        if (displayCloserExistsAfterParagraph(markdown, paragraph, display)) continue;
        if (eligibleTextContains(current.node, display)) addCandidate(display);
        continue;
      }

      const textPending: Array<{ node: Nodes; protected: boolean }> = [
        { node: current.node, protected: false },
      ];
      let skipUntil = -1;
      while (textPending.length > 0 && !exhausted) {
        const item = textPending.pop()!;
        const protectedNode =
          item.protected || item.node.type === "link" || item.node.type === "linkReference";
        const text = item.node.type === "text" && !protectedNode ? nodeRange(item.node) : null;
        if (text && text.end > skipUntil) skipUntil = scanInlineText(text, paragraph, skipUntil);
        const children = nodeChildren(item.node);
        for (let index = children.length - 1; index >= 0; index--) {
          textPending.push({ node: children[index]!, protected: protectedNode });
        }
      }
      continue;
    }

    const children = nodeChildren(current.node);
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({
        node: children[index]!,
        parentType: current.node.type,
        depth: current.depth + 1,
      });
    }
  }

  return candidates;
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (const character of content) {
    if (character === "`") {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function inlineCode(content: string): string {
  const marker = "`".repeat(Math.max(1, longestBacktickRun(content) + 1));
  const edge = content[0] ?? "";
  const last = content.at(-1) ?? "";
  const needsPadding = /[ `\t]/u.test(edge) || /[ `\t]/u.test(last);
  return needsPadding ? `${marker} ${content} ${marker}` : `${marker}${content}${marker}`;
}

function candidateEol(markdown: string, candidate: MathCandidate): string {
  const source = markdown.slice(candidate.start, candidate.end);
  const candidateNewline = source.indexOf("\n");
  if (candidateNewline !== -1) return source[candidateNewline - 1] === "\r" ? "\r\n" : "\n";
  const documentNewline = markdown.indexOf("\n");
  return documentNewline !== -1 && markdown[documentNewline - 1] === "\r" ? "\r\n" : "\n";
}

function fencedCode(content: string, language: "text" | "latex", eol: string): string {
  const marker = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  const beforeCloser = content.endsWith("\n") ? "" : eol;
  return `${marker}${language}${eol}${content}${beforeCloser}${marker}`;
}

function renderCandidate(body: string, kind: MathKind, maxWidth: number): string | null {
  if (body.trim().length === 0) return null;
  const renderAttempt = settleSurfaceFallback(
    Result.try({
      try: () => {
        const layout = renderLatex(body, {
          strict: true,
          compactScripts: true,
          displayMode: kind === "display",
          maxSourceLength: 2000,
          maxExpandedLength: 2000,
          maxDepth: 32,
          macros: {},
        });
        return { layout, output: layout.toString() };
      },
      catch: (cause) =>
        Panic.is(cause)
          ? { kind: "panic", panic: cause, fallback: null }
          : { kind: "fallback", fallback: null },
    }),
  );
  const rendered = renderAttempt.match({
    err: () => null,
    ok: (value) => value,
  });
  if (!rendered) return null;
  const { layout, output } = rendered;
  if (
    output.length === 0 ||
    output.length > 8000 ||
    layout.width > maxWidth ||
    layout.height > 100
  ) {
    return null;
  }
  return output;
}

function sourceFallback(markdown: string, candidate: MathCandidate): string {
  const source = markdown.slice(candidate.start, candidate.end);
  const eol = candidateEol(markdown, candidate);
  if (candidate.kind === "display") return fencedCode(source, "latex", eol);
  if (!source.includes("\n")) return inlineCode(source);
  return candidate.wholeDirectRootParagraph ? fencedCode(source, "latex", eol) : source;
}

function resolvedMaxWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.floor(value));
}

export function renderDiscordMarkdownMath(
  markdown: string,
  options: DiscordMarkdownMathRenderOptions = {},
  phase: DiscordMarkdownMathRenderPhase = "terminal",
): string {
  if (markdown.length > MAX_MARKDOWN_CHARS) return markdown;
  if (exceedsBlockquoteDepth(markdown)) return markdown;
  if (!markdown.includes("\\(") && !markdown.includes("\\[") && !markdown.includes("$$")) {
    return markdown;
  }

  const fallbackMode = options.fallbackMode ?? "source";
  const maxWidth = resolvedMaxWidth(options.maxWidth);
  const collectionAttempt = settleSurfaceFallback(
    Result.try({
      try: () => collectCandidates(markdown),
      catch: (cause) =>
        Panic.is(cause)
          ? { kind: "panic", panic: cause, fallback: null }
          : { kind: "fallback", fallback: null },
    }),
  );
  const candidates = collectionAttempt.match({
    err: () => null,
    ok: (value) => value,
  });
  if (candidates === null) return markdown;
  const replacements: Replacement[] = [];

  for (const candidate of candidates) {
    const source = markdown.slice(candidate.start, candidate.end);
    const body = markdown.slice(candidate.bodyStart, candidate.bodyEnd);

    let value = source;
    if (!candidate.complete && phase === "streaming") {
      value = "";
    } else if (fallbackMode === "source") {
      value = sourceFallback(markdown, candidate);
    }

    const rendered =
      candidate.complete && !candidate.malformed
        ? renderCandidate(body, candidate.kind, maxWidth)
        : null;
    if (rendered !== null) value = renderedCandidateValue(markdown, candidate, rendered) ?? value;

    if (value !== source) {
      const previous = replacements.at(-1);
      if (
        previous?.end === candidate.start &&
        previous.value.endsWith("`") &&
        value.startsWith("`")
      ) {
        value = `\u200b${value}`;
      }
      replacements.push({ start: candidate.start, end: candidate.end, value });
    }
  }

  if (replacements.length === 0) return markdown;
  let output = "";
  let position = 0;
  for (const replacement of replacements) {
    output += markdown.slice(position, replacement.start) + replacement.value;
    position = replacement.end;
  }
  return output + markdown.slice(position);
}
