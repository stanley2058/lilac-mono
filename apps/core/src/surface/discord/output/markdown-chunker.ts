import { findLexicalSafeSplitPoint } from "./markdown-splitter";
import { completeMarkdown, tokenCompleteAt } from "./token-complete";

export interface ChunkMarkdownOptions {
  maxChunkLength: number;
  maxLastChunkLength: number;
  useSmartSplitting: boolean;
}

interface ChunkResult {
  rawChunks: string[];
  displayChunks: string[];
}

function chunkRaw(
  content: string,
  maxChunkLength: number,
  useSmartSplitting: boolean,
): ChunkResult {
  if (!content) return { rawChunks: [], displayChunks: [] };
  if (maxChunkLength <= 0) {
    return { rawChunks: [content], displayChunks: [completeMarkdown(content)] };
  }

  if (!useSmartSplitting) {
    const rawChunks: string[] = [];
    const displayChunks: string[] = [];
    for (let i = 0; i < content.length; i += maxChunkLength) {
      const chunk = content.slice(i, i + maxChunkLength);
      rawChunks.push(chunk);
      displayChunks.push(chunk);
    }
    return { rawChunks, displayChunks };
  }

  let remaining = content;
  const rawChunks: string[] = [];
  const displayChunks: string[] = [];

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkLength) {
      rawChunks.push(remaining);
      displayChunks.push(completeMarkdown(remaining));
      break;
    }

    const completedWindow = tokenCompleteAt(remaining, maxChunkLength).completed;
    let splitPos = findLexicalSafeSplitPoint(completedWindow, maxChunkLength, {
      maxBacktrack: 100,
      newlineBacktrack: 100,
      locale: "en-US",
    });

    splitPos = Math.max(1, Math.min(splitPos, maxChunkLength));

    let attemptSplitPos = splitPos;
    let completed = "";
    let overflow = "";
    let nextRemaining = "";

    for (let attempt = 0; attempt < 10; attempt++) {
      ({ completed, overflow } = tokenCompleteAt(remaining, attemptSplitPos));

      const isFencedCodeChunk = /^```/m.test(completed);
      nextRemaining = isFencedCodeChunk ? overflow : overflow.replace(/^[\s\n]+/u, "");

      if (nextRemaining.length < remaining.length) {
        break;
      }

      if (attemptSplitPos >= maxChunkLength) {
        break;
      }

      attemptSplitPos = Math.min(maxChunkLength, attemptSplitPos + 1);
    }

    const isFencedCodeChunk = /^```/m.test(completed);
    const trimmedCompleted = isFencedCodeChunk ? completed : completed.replace(/[\s\n]+$/u, "");

    rawChunks.push(remaining.slice(0, attemptSplitPos));
    displayChunks.push(trimmedCompleted);

    remaining = nextRemaining;
  }

  return { rawChunks, displayChunks };
}

export function chunkMarkdownForEmbeds(
  content: string,
  { maxChunkLength, maxLastChunkLength, useSmartSplitting }: ChunkMarkdownOptions,
): string[] {
  if (!content) return [];

  const safeMaxChunkLength = Math.max(1, maxChunkLength);
  const safeMaxLastChunkLength = Math.max(1, Math.min(maxLastChunkLength, safeMaxChunkLength));

  const initial = chunkRaw(content, safeMaxChunkLength, useSmartSplitting);

  if (initial.rawChunks.length === 0 || safeMaxLastChunkLength === safeMaxChunkLength) {
    return initial.displayChunks;
  }

  const lastRaw = initial.rawChunks.at(-1) ?? "";
  if (lastRaw.length <= safeMaxLastChunkLength) {
    return initial.displayChunks;
  }

  const rechunkedLast = chunkRaw(lastRaw, safeMaxLastChunkLength, useSmartSplitting);

  const prefix = initial.displayChunks.slice(0, -1);
  return prefix.concat(rechunkedLast.displayChunks);
}
