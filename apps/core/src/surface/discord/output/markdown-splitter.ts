import { buildMarkdownIndex, type MarkdownIndex } from "./markdown-index";

export interface LexicalSplitOptions {
  maxBacktrack?: number;
  newlineBacktrack?: number;
  locale?: string;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function avoidSurrogateSplit(source: string, offset: number): number {
  if (offset <= 0 || offset >= source.length) return offset;
  return isLowSurrogate(source.charCodeAt(offset)) ? offset - 1 : offset;
}

function isPreferredSafe(
  raw: string,
  offset: number,
  minEnd: number,
  index: MarkdownIndex,
): boolean {
  if (offset < minEnd) return false;
  return index.isSafeOffset(avoidSurrogateSplit(raw, offset));
}

function findWordBoundary(
  raw: string,
  start: number,
  targetEnd: number,
  minEnd: number,
  index: MarkdownIndex,
  locale: string,
): number | null {
  if (typeof Intl.Segmenter !== "function") return null;

  const window = raw.slice(start, targetEnd);
  if (window.length === 0) return null;

  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  let best: number | null = null;

  for (const seg of segmenter.segment(window)) {
    if (!seg.isWordLike) continue;
    const boundary = start + seg.index + seg.segment.length;
    if (boundary <= start || boundary > targetEnd) continue;
    if (!isPreferredSafe(raw, boundary, minEnd, index)) continue;
    best = avoidSurrogateSplit(raw, boundary);
  }

  return best;
}

export function findRawSplitPoint(
  raw: string,
  start: number,
  targetEnd: number,
  minEnd: number,
  index: MarkdownIndex,
  options: LexicalSplitOptions = {},
): number {
  const maxBacktrack = options.maxBacktrack ?? 100;
  const newlineBacktrack = options.newlineBacktrack ?? 100;
  const locale = options.locale ?? "en-US";

  const hardTarget = avoidSurrogateSplit(raw, Math.max(start + 1, Math.min(targetEnd, raw.length)));
  const safeMinEnd = Math.max(start + 1, Math.min(minEnd, hardTarget));
  const stateAtTarget = index.getStateAt(hardTarget);

  if (stateAtTarget.fence !== null) {
    const newlineStart = Math.max(safeMinEnd, hardTarget - maxBacktrack);
    for (let pos = hardTarget; pos >= newlineStart; pos--) {
      if (!isPreferredSafe(raw, pos, safeMinEnd, index)) continue;
      if (raw[pos - 1] === "\n") return avoidSurrogateSplit(raw, pos);
    }
  }

  const newlineStart = Math.max(safeMinEnd, hardTarget - newlineBacktrack);
  for (let pos = hardTarget; pos >= newlineStart; pos--) {
    if (!isPreferredSafe(raw, pos, safeMinEnd, index)) continue;
    if (raw[pos - 1] === "\n") return avoidSurrogateSplit(raw, pos);
  }

  const boundaryStart = Math.max(safeMinEnd, hardTarget - maxBacktrack);
  for (let pos = hardTarget; pos >= boundaryStart; pos--) {
    if (!isPreferredSafe(raw, pos, safeMinEnd, index)) continue;
    if (/\s/u.test(raw[pos - 1] ?? "")) return avoidSurrogateSplit(raw, pos);
  }

  const wordBoundary = findWordBoundary(raw, boundaryStart, hardTarget, safeMinEnd, index, locale);
  if (wordBoundary !== null) return wordBoundary;

  for (let pos = hardTarget; pos >= boundaryStart; pos--) {
    if (isPreferredSafe(raw, pos, safeMinEnd, index)) return avoidSurrogateSplit(raw, pos);
  }

  return hardTarget;
}

export function findLexicalSafeSplitPoint(
  source: string,
  target: number,
  options: LexicalSplitOptions = {},
): number {
  const index = buildMarkdownIndex(source);
  return findRawSplitPoint(source, 0, target, 1, index, options);
}
