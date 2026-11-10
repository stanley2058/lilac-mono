import {
  isWorkflowPost,
  joinMessageTurns,
  lastTurnMessageTime,
  workflowPostsDuring,
} from "../message-grouping";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NativeThreadStore } from "@stanley2058/lilac-client";
import { type ReadyTurnSlot, type TurnSlot } from "@stanley2058/lilac-client-protocol";

export function useSlot(store: NativeThreadStore, slotId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (slotId ? store.subscribeSlot(slotId, listener) : () => {}),
    [store, slotId],
  );
  const snapshot = useCallback(() => (slotId ? store.get(slotId) : undefined), [store, slotId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function turnTime(slot: TurnSlot | undefined): number | undefined {
  if (slot?.kind !== "ready") return undefined;
  return (
    slot.messages.find((message) => message.role === "user")?.metadata?.createdAt ??
    slot.messages[0]?.metadata?.createdAt ??
    slot.startedAt
  );
}
export function useSlotTime(store: NativeThreadStore, slotId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (slotId ? store.subscribeSlot(slotId, listener) : () => {}),
    [store, slotId],
  );
  const snapshot = useCallback(
    () => (slotId ? lastTurnMessageTime(store.get(slotId)) : undefined),
    [store, slotId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function useJoinedTurns(
  store: NativeThreadStore,
  leftId: string | undefined,
  rightId: string | undefined,
  contextStart: number | null | undefined,
  gapMs: number | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const left = leftId ? store.subscribeSlot(leftId, listener) : () => {};
      const right = rightId ? store.subscribeSlot(rightId, listener) : () => {};
      return () => {
        left();
        right();
      };
    },
    [store, leftId, rightId],
  );
  const snapshot = useCallback(
    () =>
      joinMessageTurns(
        leftId ? store.get(leftId) : undefined,
        rightId ? store.get(rightId) : undefined,
        contextStart,
        gapMs,
      ),
    [store, leftId, rightId, contextStart, gapMs],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export type TurnPosts = {
  posts: readonly ReadyTurnSlot[];
  folded: boolean;
  /** The nearest visible neighbors once folded cards are skipped. */
  previous?: string;
  next?: string;
};
export const noPosts: TurnPosts = { posts: [], folded: false };
export const foldedPost: TurnPosts = { posts: [], folded: true };

/** Workflow cards fold into the turn that posted them, so their own rows render nothing. */
export function useTurnPosts(
  store: NativeThreadStore,
  slotId: string,
  previousId: string | undefined,
  nextId: string | undefined,
): TurnPosts {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(() => listener()),
    [store],
  );
  const key = useCallback(
    () => turnPostsKey(store, slotId, previousId, nextId),
    [store, slotId, previousId, nextId],
  );
  const snapshot = useSyncExternalStore(subscribe, key, key);
  return useMemo(() => {
    if (!snapshot) return noPosts;
    if (snapshot === "folded") return foldedPost;
    const { ids, previous, next } = JSON.parse(snapshot) as {
      ids: string[];
      previous: string | null;
      next: string | null;
    };
    const posts = ids.flatMap((id) => {
      const slot = store.get(id);
      return slot?.kind === "ready" ? [slot] : [];
    });
    return { posts, folded: false, previous: previous ?? undefined, next: next ?? undefined };
  }, [snapshot, store]);
}

/** A card folded into its turn renders in that turn's row, so jumps have to aim there. */
export function renderedRowIndex(store: NativeThreadStore, slotId: string): number {
  const ids = store.slotIds;
  let index = ids.indexOf(slotId);
  while (index > 0 && turnPostsKey(store, ids[index]!, ids[index - 1], ids[index + 1]) === "folded")
    index -= 1;
  return index;
}

// The key carries revisions so a card's progress updates still rerender the turn that shows it.
export function turnPostsKey(
  store: NativeThreadStore,
  slotId: string,
  previousId: string | undefined,
  nextId: string | undefined,
): string {
  const post = isWorkflowPost(store.get(slotId));
  const afterPost = isWorkflowPost(previousId ? store.get(previousId) : undefined);
  // Most rows have no workflow card beside them; skip the scan of the whole thread.
  if (!post && !afterPost && !isWorkflowPost(nextId ? store.get(nextId) : undefined)) return "";
  const ids = store.slotIds;
  const index = ids.indexOf(slotId);
  if (index < 0) return "";
  const postsAfter = (from: number) => {
    const slots: TurnSlot[] = [];
    for (let at = from; at < ids.length; at++) {
      const slot = store.get(ids[at]!);
      if (!isWorkflowPost(slot)) break;
      slots.push(slot!);
    }
    return slots;
  };
  // The turn before a run of cards, and the cards in that run it shows itself.
  const ownerBefore = (at: number) => {
    let owner = at - 1;
    while (owner >= 0 && isWorkflowPost(store.get(ids[owner]!))) owner--;
    if (owner < 0) return undefined;
    return { owner, folded: workflowPostsDuring(store.get(ids[owner]!), postsAfter(owner + 1)) };
  };
  const before = post || afterPost ? ownerBefore(index) : undefined;
  if (post && before?.folded.includes(slotId)) return "folded";
  // Only when every card between them folded does this row sit directly after the owner.
  const previous =
    before && before.folded.length === index - 1 - before.owner ? ids[before.owner]! : null;
  const posts = post ? [] : workflowPostsDuring(store.get(slotId), postsAfter(index + 1));
  if (!posts.length && !previous) return "";
  return JSON.stringify({
    ids: posts,
    revisions: posts.map((id) => store.getVersioned(id)?.revision),
    previous,
    next: posts.length ? (ids[index + 1 + posts.length] ?? null) : (nextId ?? null),
  });
}

export function startsNewDay(previous: number, next: number): boolean {
  return new Date(previous).toDateString() !== new Date(next).toDateString();
}
export function useSlotIds(store: NativeThreadStore) {
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe((change) => {
        if (change.structure) listener();
      }),
    [store],
  );
  const snapshot = useCallback(() => store.slotIds, [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
