export const DISCORD_MERGE_WINDOW_MS = 7 * 60 * 1000;

type DiscordWindowCandidate = {
  authorId: string;
  ts: number;
};

export function splitByDiscordWindowOldestToNewest<T extends DiscordWindowCandidate>(
  candidates: readonly T[],
): T[][] {
  if (candidates.length === 0) return [];

  const groups: T[][] = [];

  let current: T[] = [candidates[0]!];
  let currentStartTs = candidates[0]!.ts;
  let currentAuthorId = candidates[0]!.authorId;

  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i]!;

    const withinWindow = next.ts - currentStartTs <= DISCORD_MERGE_WINDOW_MS;
    const sameAuthor = next.authorId === currentAuthorId;

    if (sameAuthor && withinWindow) {
      current.push(next);
      continue;
    }

    groups.push(current);
    current = [next];
    currentStartTs = next.ts;
    currentAuthorId = next.authorId;
  }

  groups.push(current);
  return groups;
}

export type MergeCandidate = {
  messageId: string;
  authorId: string;
  ts: number;
  content: string;
};

export function mergeByDiscordWindow(candidatesDesc: readonly MergeCandidate[]): {
  mergedText: string;
  mergedMessageIds: string[];
} {
  if (candidatesDesc.length === 0) return { mergedText: "", mergedMessageIds: [] };

  // candidates are newest -> oldest; flip so split logic can follow
  // Discord's UI-style grouping from earliest to latest.
  const ordered = candidatesDesc.slice().reverse();
  const groups = splitByDiscordWindowOldestToNewest(ordered);
  const group = groups[groups.length - 1] ?? [];

  const mergedText = group.map((m) => m.content).join("\n\n");
  const mergedMessageIds = group.map((m) => m.messageId);

  return { mergedText, mergedMessageIds };
}
