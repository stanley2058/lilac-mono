import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useStore } from "zustand";
import type { NativeClient, NativeThreadStore } from "@stanley2058/lilac-client";
import { parseCitationHref } from "@stanley2058/lilac-client-protocol";
import type { Virtualizer } from "@tanstack/react-virtual";
import { citationStore, dismissCitation, revealCitation } from "../citation-store";
import { resolveCitationRange, highlightCitation } from "../assistant-selection";
import { attempt } from "./ui";
import { toast } from "./ui/toast";
import { aroundTurnGap, isTurnLeadIn } from "../turn-gap";

export async function loadCitationSource({
  threadId,
  messageId,
  store,
  client,
  current,
}: {
  threadId: string;
  messageId: string;
  store: NativeThreadStore;
  client: Pick<NativeClient, "hydrate" | "loadTurnPage">;
  current: () => boolean;
}): Promise<string | undefined> {
  const attempted = new Set<string>();
  const cited = (messages: readonly { id: string; role: string }[]) =>
    messages.some((message) => message.id === messageId && message.role === "assistant");
  while (current()) {
    const source = store.slotIds.find((id) => {
      const slot = store.get(id);
      return slot?.kind === "ready" && cited(aroundTurnGap(slot.messages, isTurnLeadIn));
    });
    if (source) {
      return source;
    }
    // A turn renders a message a page loaded into its gap only once the gap closes.
    const held = store.slotIds.find((id) => {
      const slot = store.get(id);
      return slot?.kind === "ready" && cited(slot.messages);
    });
    const candidate = [...(held ? [held] : []), ...[...store.slotIds].reverse()].find((id) => {
      const slot = store.get(id);
      const cursor = slot?.kind === "ready" ? slot.partsCursor : slot?.kind;
      return cursor && !attempted.has(`${id}:${cursor}`);
    });
    if (!candidate) {
      return;
    }
    const slot = store.get(candidate);
    if (!slot) {
      return;
    }
    if (slot.kind === "ready") {
      attempted.add(`${candidate}:${slot.partsCursor}`);
      await client.loadTurnPage(threadId, candidate);
      continue;
    }
    attempted.add(`${candidate}:${slot.kind}`);
    await client.hydrate(threadId, candidate);
  }
}

export function useCitationNavigation({
  threadId,
  store,
  client,
  viewport,
  virtual,
  ready,
  onPosition,
}: {
  threadId: string;
  store: NativeThreadStore;
  client: Pick<NativeClient, "hydrate" | "loadTurnPage">;
  viewport: RefObject<HTMLDivElement | null>;
  virtual: Virtualizer<HTMLDivElement, HTMLDivElement>;
  ready: boolean;
  onPosition: () => void;
}) {
  const request = useStore(citationStore, (state) =>
    state.navigation?.citation.threadId === threadId ? state.navigation : undefined,
  );
  const [target, setTarget] = useState<{ key: string; slotId: string }>();
  const index =
    request && target?.key === request.key ? store.slotIds.indexOf(target.slotId) + 1 : undefined;
  useEffect(() => {
    const citation = parseCitationHref(
      new URLSearchParams(location.hash.slice(1)).get("citation") ?? "",
    );
    if (citation?.threadId === threadId) revealCitation(citation);
  }, [threadId]);
  useEffect(() => {
    if (!request || !ready) return;
    let canceled = false;
    const current = () => !canceled && citationStore.getState().navigation?.key === request.key;
    const fail = () => {
      if (!current()) return;
      toast.add({
        title: "The cited response is unavailable. The saved quote is unchanged.",
        type: "error",
      });
      dismissCitation(request.key);
    };
    async function load() {
      onPosition();
      const slotId = await loadCitationSource({
        threadId,
        messageId: request!.citation.messageId,
        store,
        client,
        current,
      });
      if (!current()) return;
      if (!slotId) {
        fail();
        return;
      }
      setTarget({ key: request!.key, slotId });
    }
    void attempt(load, fail);
    return () => {
      canceled = true;
    };
  }, [request, ready, threadId, store, client, onPosition]);
  useLayoutEffect(() => {
    if (
      !request ||
      !target ||
      target.key !== request.key ||
      !ready ||
      index === undefined ||
      index < 1
    )
      return;
    const parent = viewport.current;
    if (!parent) return;
    let disposed = false;
    let release: (() => void) | undefined;
    let positioned = false;
    let frame = 0;
    const position = () => {
      if (disposed) return;
      const source = [...parent.querySelectorAll<HTMLElement>("[data-citation-source]")].find(
        (element) => element.dataset.citationSource === request.citation.messageId,
      );
      if (!source) {
        virtual.scrollToIndex(index, { align: "center" });
        return;
      }
      const range = resolveCitationRange(source, request.citation);
      if (!positioned) {
        const rect = (range ?? source).getBoundingClientRect();
        if (!rect.height) return;
        positioned = true;
        parent.scrollTop +=
          rect.top - parent.getBoundingClientRect().top - Math.min(120, parent.clientHeight / 3);
        if (!range)
          toast.add({
            title: "The quoted text changed. Showing its source response.",
            type: "info",
          });
      }
      release?.();
      if (range) release = highlightCitation(range, "lilac-citation-source");
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    const observer = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    observer.observe(parent, { childList: true, subtree: true, characterData: true });
    resize.observe(parent);
    virtual.scrollToIndex(index, { align: "center" });
    schedule();
    const cancel = () => dismissCitation(request.key);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    parent.addEventListener("wheel", cancel, { passive: true });
    parent.addEventListener("touchmove", cancel, { passive: true });
    document.addEventListener("keydown", key);
    const timer = setTimeout(cancel, 5_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      release?.();
      parent.removeEventListener("wheel", cancel);
      parent.removeEventListener("touchmove", cancel);
      document.removeEventListener("keydown", key);
    };
  }, [request, target, ready, index, virtual, viewport]);
  return index;
}
