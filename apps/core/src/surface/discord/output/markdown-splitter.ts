import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Root, RootContent, PhrasingContent } from "mdast";

interface UnsafeZone {
  start: number;
  end: number;
}

interface CodeFenceRange {
  start: number;
  end: number;
  contentStart: number;
}

function getUnsafeZones(
  node: Root | RootContent | PhrasingContent,
  zones: UnsafeZone[] = [],
  codeFences: CodeFenceRange[] = [],
): { zones: UnsafeZone[]; codeFences: CodeFenceRange[] } {
  if (!("position" in node) || !node.position) {
    return { zones, codeFences };
  }

  const start = node.position.start.offset ?? 0;
  const end = node.position.end.offset ?? 0;

  switch (node.type) {
    case "strong":
      zones.push({ start, end: start + 2 });
      zones.push({ start: end - 2, end });
      break;
    case "emphasis":
      zones.push({ start, end: start + 1 });
      zones.push({ start: end - 1, end });
      break;
    case "delete":
      zones.push({ start, end: start + 2 });
      zones.push({ start: end - 2, end });
      break;
    case "inlineCode":
      zones.push({ start, end: start + 1 });
      zones.push({ start: end - 1, end });
      break;
    case "code": {
      const fenceSize = 3;
      zones.push({ start, end: Math.min(end, start + fenceSize) });
      zones.push({ start: Math.max(start, end - fenceSize), end });

      const lang = (node.lang || "").trim();
      const openerLength = 3 + lang.length; // ``` + lang
      const contentStart = Math.min(end, start + openerLength + 1); // plus newline
      codeFences.push({ start, end, contentStart });
      break;
    }
    case "link":
    case "image":
      zones.push({ start, end });
      break;
    case "html":
      zones.push({ start, end });
      break;
  }

  if ("children" in node && node.children) {
    for (const child of node.children) {
      getUnsafeZones(child as RootContent | PhrasingContent, zones, codeFences);
    }
  }

  return { zones, codeFences };
}

function isPositionSafe(pos: number, zones: UnsafeZone[]): boolean {
  for (const zone of zones) {
    if (pos > zone.start && pos < zone.end) {
      return false;
    }
  }
  return true;
}

export interface LexicalSplitOptions {
  maxBacktrack?: number;
  newlineBacktrack?: number;
  locale?: string;
}

function findPreferredBoundaryInWindow(
  source: string,
  target: number,
  zones: UnsafeZone[],
  codeFences: CodeFenceRange[],
  { maxBacktrack, newlineBacktrack, locale }: Required<LexicalSplitOptions>,
): number | null {
  const safeTarget = Math.min(target, source.length);
  const start = Math.max(0, safeTarget - maxBacktrack);

  const activeFence = codeFences.find(
    (f) => safeTarget > f.contentStart && safeTarget < f.end,
  );

  if (activeFence) {
    const minPos = Math.max(activeFence.contentStart + 1, start);

    for (let i = safeTarget; i >= minPos; i--) {
      if (!isPositionSafe(i, zones)) continue;
      if (source[i - 1] === "\n") return i;
    }

    return null;
  }

  const newlineStart = Math.max(0, safeTarget - newlineBacktrack);
  for (let i = safeTarget; i >= newlineStart; i--) {
    if (i <= 0) continue;
    if (!isPositionSafe(i, zones)) continue;

    if (source[i - 1] === "\n") {
      return i;
    }
  }

  for (let i = safeTarget; i >= start; i--) {
    if (i <= 0) continue;
    if (!isPositionSafe(i, zones)) continue;

    if (/\s/u.test(source[i - 1] ?? "")) {
      return i;
    }
  }

  const window = source.slice(start, safeTarget);
  if (window.length > 0 && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });

    let best: number | null = null;
    for (const seg of segmenter.segment(window)) {
      const boundary = start + seg.index + seg.segment.length;
      if (boundary <= start || boundary > safeTarget) continue;
      if (!isPositionSafe(boundary, zones)) continue;

      if (seg.isWordLike) {
        best = boundary;
      }
    }
    if (best !== null) return best;
  }

  return null;
}

export function findLexicalSafeSplitPoint(
  source: string,
  target: number,
  options: LexicalSplitOptions = {},
): number {
  const maxBacktrack = options.maxBacktrack ?? 100;
  const newlineBacktrack = options.newlineBacktrack ?? 100;
  const locale = options.locale ?? "en-US";

  target = Math.min(target, source.length);

  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const { zones, codeFences } = getUnsafeZones(tree);

  const baseSafe = (() => {
    for (let i = target; i >= Math.max(0, target - maxBacktrack); i--) {
      if (isPositionSafe(i, zones)) return i;
    }
    for (let i = target + 1; i < Math.min(source.length, target + maxBacktrack); i++) {
      if (isPositionSafe(i, zones)) return i;
    }
    return target;
  })();

  const preferred = findPreferredBoundaryInWindow(source, baseSafe, zones, codeFences, {
    maxBacktrack,
    newlineBacktrack,
    locale,
  });

  return preferred ?? baseSafe;
}
