import type { RewindAttempt } from "./rewind-draft";
import { createStore } from "zustand/vanilla";
import {
  draftThreadTitle,
  hasDraftContent,
  newDraftThread,
  type DraftThread,
} from "./draft-thread";

type DraftSummary = { id: string; title: string; editable: boolean };
type DraftState = {
  rewinds: Map<string, RewindAttempt>;
  claimRewind: (threadId: string, target: string, draftKey?: string) => RewindAttempt | undefined;
  setRewind: (threadId: string, owner: symbol, attempt?: RewindAttempt) => void;
  localDrafts: Map<string, DraftThread>;
  summaries: DraftSummary[];
  ids: string[];
  setLocalDrafts: (drafts: Map<string, DraftThread>) => void;
};

export function createDraftStore() {
  const first = newDraftThread();
  return createStore<DraftState>((set, get) => ({
    rewinds: new Map(),
    claimRewind(threadId, target, draftKey) {
      const previous = get().rewinds.get(threadId);
      if (previous?.running || previous?.completed) return;
      const claimed = {
        ...(previous ?? { target, draftKey, owner: Symbol(threadId) }),
        running: true,
      };
      const rewinds = new Map(get().rewinds);
      rewinds.set(threadId, claimed);
      set({ rewinds });
      return claimed;
    },
    setRewind(threadId, owner, attempt) {
      if (get().rewinds.get(threadId)?.owner !== owner) return;
      const rewinds = new Map(get().rewinds);
      if (attempt) rewinds.set(threadId, attempt);
      else rewinds.delete(threadId);
      set({ rewinds });
    },
    localDrafts: new Map([[first.id, first]]),
    summaries: [],
    ids: [],
    setLocalDrafts(localDrafts) {
      const previous = get();
      const byId = new Map(previous.summaries.map((item) => [item.id, item]));
      const summaries: DraftSummary[] = [];
      for (const draft of localDrafts.values()) {
        const cached = byId.get(draft.id);
        if (cached && previous.localDrafts.get(draft.id) === draft) {
          summaries.push(cached);
          continue;
        }
        if (!hasDraftContent(draft)) continue;
        const title = draftThreadTitle(draft);
        const editable = !draft.creation;
        summaries.push(
          cached?.title === title && cached.editable === editable
            ? cached
            : { id: draft.id, title, editable },
        );
      }
      const unchanged =
        summaries.length === previous.summaries.length &&
        summaries.every((item, index) => item === previous.summaries[index]);
      const idsUnchanged =
        summaries.length === previous.ids.length &&
        summaries.every((item, index) => item.id === previous.ids[index]);
      set({
        localDrafts,
        summaries: unchanged ? previous.summaries : summaries,
        ids: idsUnchanged ? previous.ids : summaries.map((item) => item.id),
      });
    },
  }));
}
