export const DISCORD_MERGE_WINDOW_MS = 7 * 60 * 1000;

export type MergeCandidate = {
  messageId: string;
  authorId: string;
  ts: number;
  content: string;
};

export function mergeByDiscordWindow(
  candidatesDesc: readonly MergeCandidate[],
): { mergedText: string; mergedMessageIds: string[] } {
  if (candidatesDesc.length === 0) return { mergedText: "", mergedMessageIds: [] };

  const first = candidatesDesc[0]!;
  const authorId = first.authorId;

  const collected: MergeCandidate[] = [first];

  for (let i = 1; i < candidatesDesc.length; i++) {
    const cur = candidatesDesc[i]!;
    const prev = collected[collected.length - 1]!;

    if (cur.authorId !== authorId) break;

    const gap = prev.ts - cur.ts;
    if (gap > DISCORD_MERGE_WINDOW_MS) break;

    collected.push(cur);
  }

  // candidates are newest -> oldest; flip to oldest -> newest
  const ordered = collected.slice().reverse();
  const mergedText = ordered.map((m) => m.content).join("\n\n");
  const mergedMessageIds = ordered.map((m) => m.messageId);

  return { mergedText, mergedMessageIds };
}
