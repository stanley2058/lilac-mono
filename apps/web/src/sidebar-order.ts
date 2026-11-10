import { newerThread } from "./thread-metadata-store";
import type {
  NativeRpcInputs,
  NativeThread,
  SidebarSection,
} from "@stanley2058/lilac-client-protocol";
export const sidebarSections = ["pinned", "active", "settled"] as const;
export const sidebarLabels = { pinned: "Pinned", active: "Active", settled: "Settled" };
export type QueueThread = { id: string; source?: NativeThread };
export type ThreadQueues = Record<SidebarSection, QueueThread[]>;
export type ThreadMove = NativeRpcInputs["sidebar"]["move"];
export function moveInQueues(queues: ThreadQueues, move: ThreadMove): ThreadQueues {
  const thread = sidebarSections
    .flatMap((section) => queues[section])
    .find((item) => item.id === move.threadId);
  if (!thread) return queues;
  const next = {
    pinned: queues.pinned.filter((item) => item.id !== thread.id),
    active: queues.active.filter((item) => item.id !== thread.id),
    settled: queues.settled.filter((item) => item.id !== thread.id),
  };
  const destination = next[move.section];
  let index = destination.length;
  if (move.beforeId) {
    const before = destination.findIndex((item) => item.id === move.beforeId);
    if (before >= 0) index = before;
  } else if (move.afterId) {
    const after = destination.findIndex((item) => item.id === move.afterId);
    if (after >= 0) index = after + 1;
  } else if (move.atStart) index = 0;
  destination.splice(index, 0, thread);
  return next;
}
export function queueSection(queues: ThreadQueues, id: string): SidebarSection | undefined {
  return sidebarSections.find((section) => queues[section].some((thread) => thread.id === id));
}
export function dropAction(
  from: SidebarSection,
  to: SidebarSection,
): "Pin" | "Unpin" | "Settle" | "Unsettle" | undefined {
  if (from === to) return undefined;
  if (to === "pinned") return "Pin";
  if (to === "settled") return "Settle";
  return from === "pinned" ? "Unpin" : "Unsettle";
}

export function sidebarSnapshot(
  snapshots: { section: SidebarSection; items: NativeThread[]; updatedAt: number }[],
  fallback: NativeThread[] = [],
  /** The newest metadata known for a conversation, which may be newer than its page. */
  latest?: (id: string) => NativeThread | undefined,
): ThreadQueues {
  const queues: ThreadQueues = { pinned: [], active: [], settled: [] };
  const seen = new Set<string>();
  for (const snapshot of [...snapshots].sort((a, b) => b.updatedAt - a.updatedAt)) {
    for (const item of snapshot.items) {
      const source = newerThread(latest?.(item.id), item);
      if (source.archived || seen.has(source.id)) continue;
      seen.add(source.id);
      queues[snapshot.section].push({ id: source.id, source });
    }
  }
  if (!snapshots.some((snapshot) => snapshot.updatedAt > 0))
    queues.active = fallback
      .filter((thread) => !thread.archived)
      .map((source) => ({ id: source.id, source }));
  return queues;
}
