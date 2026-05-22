import { findLexicalSafeSplitPoint } from "./markdown-splitter";
import { buildMarkdownContinuationPrefix, getMarkdownContinuationState } from "./markdown-state";
import { completeMarkdown } from "./token-complete";

export interface ChunkMarkdownOptions {
  maxChunkLength: number;
  maxLastChunkLength: number;
  useSmartSplitting: boolean;
  hardMaxChunkLength?: number;
}

interface ChunkResult {
  rawChunks: string[];
  displayChunks: string[];
  rawOffsets: number[];
}

interface ChunkCandidate {
  display: string;
  rawEnd: number;
  nextOffset: number;
}

function hardCapDisplayChunks(chunks: string[], maxChunkLength: number): string[] {
  if (maxChunkLength <= 0) return chunks;

  const capped: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunkLength) {
      capped.push(chunk);
      continue;
    }

    for (let i = 0; i < chunk.length; i += maxChunkLength) {
      capped.push(chunk.slice(i, i + maxChunkLength));
    }
  }
  return capped;
}

function chunkRaw(
  content: string,
  maxChunkLength: number,
  useSmartSplitting: boolean,
  hardMaxChunkLength: number | null = null,
  sourcePrefix: string = "",
): ChunkResult {
  if (!content) return { rawChunks: [], displayChunks: [], rawOffsets: [] };
  if (maxChunkLength <= 0) {
    return { rawChunks: [content], displayChunks: [completeMarkdown(content)], rawOffsets: [0] };
  }

  if (!useSmartSplitting) {
    const rawChunks: string[] = [];
    const displayChunks: string[] = [];
    const rawOffsets: number[] = [];
    for (let i = 0; i < content.length; i += maxChunkLength) {
      const chunk = content.slice(i, i + maxChunkLength);
      rawChunks.push(chunk);
      displayChunks.push(chunk);
      rawOffsets.push(i);
    }
    return { rawChunks, displayChunks, rawOffsets };
  }

  const rawChunks: string[] = [];
  const displayChunks: string[] = [];
  const rawOffsets: number[] = [];

  const buildCandidate = (offset: number, rawLength: number): ChunkCandidate => {
    const rawEnd = Math.min(content.length, offset + rawLength);
    const rawSegment = content.slice(offset, rawEnd);
    const prefix = buildMarkdownContinuationPrefix(
      getMarkdownContinuationState(sourcePrefix + content.slice(0, offset)),
    );
    const completed = completeMarkdown(prefix + rawSegment);
    const isFencedCodeChunk = /^```/m.test(completed);
    const display = isFencedCodeChunk ? completed : completed.replace(/[\s\n]+$/u, "");

    let nextOffset = rawEnd;
    if (!isFencedCodeChunk) {
      while (nextOffset < content.length && /[\s\n]/u.test(content[nextOffset] ?? "")) {
        nextOffset++;
      }
    }

    return { display, rawEnd, nextOffset };
  };

  let offset = 0;

  while (offset < content.length) {
    const remainingLength = content.length - offset;

    if (remainingLength <= maxChunkLength) {
      const completedRemaining = buildCandidate(offset, remainingLength).display;
      if (hardMaxChunkLength === null || completedRemaining.length <= hardMaxChunkLength) {
        rawChunks.push(content.slice(offset));
        displayChunks.push(completedRemaining);
        rawOffsets.push(offset);
        break;
      }
    }

    const prefix = buildMarkdownContinuationPrefix(
      getMarkdownContinuationState(sourcePrefix + content.slice(0, offset)),
    );
    const windowRaw = content.slice(offset, offset + maxChunkLength);
    const completedWindow = completeMarkdown(prefix + windowRaw);
    let splitPos = findLexicalSafeSplitPoint(completedWindow, prefix.length + windowRaw.length, {
      maxBacktrack: 100,
      newlineBacktrack: 100,
      locale: "en-US",
    });

    splitPos = Math.max(1, Math.min(splitPos - prefix.length, maxChunkLength));

    let attemptSplitPos = splitPos;
    let candidate = buildCandidate(offset, attemptSplitPos);

    for (let attempt = 0; attempt < 10; attempt++) {
      candidate = buildCandidate(offset, attemptSplitPos);

      if (candidate.nextOffset > offset) {
        break;
      }

      if (attemptSplitPos >= maxChunkLength) {
        break;
      }

      attemptSplitPos = Math.min(maxChunkLength, attemptSplitPos + 1);
    }

    while (
      hardMaxChunkLength !== null &&
      candidate.display.length > hardMaxChunkLength &&
      attemptSplitPos > 1
    ) {
      const candidateSplitPos = attemptSplitPos - 1;
      const nextCandidate = buildCandidate(offset, candidateSplitPos);

      if (nextCandidate.nextOffset <= offset) {
        break;
      }

      attemptSplitPos = candidateSplitPos;
      candidate = nextCandidate;
    }

    if (hardMaxChunkLength !== null && candidate.display.length > hardMaxChunkLength) {
      const fallbackLength = Math.max(1, Math.min(maxChunkLength, hardMaxChunkLength));
      const rawEnd = Math.min(content.length, offset + fallbackLength);
      rawChunks.push(content.slice(offset, rawEnd));
      displayChunks.push(content.slice(offset, rawEnd));
      rawOffsets.push(offset);
      offset = rawEnd;
      continue;
    }

    rawChunks.push(content.slice(offset, candidate.rawEnd));
    displayChunks.push(candidate.display);
    rawOffsets.push(offset);

    offset = candidate.nextOffset;
  }

  return { rawChunks, displayChunks, rawOffsets };
}

export function chunkMarkdownForEmbeds(
  content: string,
  {
    maxChunkLength,
    maxLastChunkLength,
    useSmartSplitting,
    hardMaxChunkLength,
  }: ChunkMarkdownOptions,
): string[] {
  if (!content) return [];

  const safeMaxChunkLength = Math.max(1, maxChunkLength);
  const safeMaxLastChunkLength = Math.max(1, Math.min(maxLastChunkLength, safeMaxChunkLength));
  const safeHardMaxChunkLength =
    hardMaxChunkLength === undefined ? null : Math.max(1, hardMaxChunkLength);
  const finalize = (chunks: string[]) =>
    safeHardMaxChunkLength === null ? chunks : hardCapDisplayChunks(chunks, safeHardMaxChunkLength);

  const initial = chunkRaw(content, safeMaxChunkLength, useSmartSplitting, safeHardMaxChunkLength);

  if (initial.rawChunks.length === 0 || safeMaxLastChunkLength === safeMaxChunkLength) {
    return finalize(initial.displayChunks);
  }

  const lastRaw = initial.rawChunks.at(-1) ?? "";
  if (lastRaw.length <= safeMaxLastChunkLength) {
    return finalize(initial.displayChunks);
  }

  const rechunkedLast = chunkRaw(
    lastRaw,
    safeMaxLastChunkLength,
    useSmartSplitting,
    safeHardMaxChunkLength,
    content.slice(0, initial.rawOffsets.at(-1) ?? 0),
  );

  const prefix = initial.displayChunks.slice(0, -1);
  return finalize(prefix.concat(rechunkedLast.displayChunks));
}
