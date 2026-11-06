import { createStore } from "zustand/vanilla";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
export type FileDocument = NativeRpcOutputs["files"]["document"];
export type FileDraft = FileDocument & { savedText: string };
export function fileDraftKey(threadId: string, path: string) {
  return `${threadId}\u0000${path}`;
}
export function createFileEditors() {
  return createStore<{
    drafts: Map<string, FileDraft>;
    dirty: Set<string>;
    load: (key: string, doc: FileDocument) => void;
    edit: (key: string, text: string) => void;
    saved: (key: string, doc: FileDocument) => void;
    discard: (key: string) => void;
  }>((set, get) => {
    function put(key: string, draft: FileDraft) {
      const drafts = new Map(get().drafts).set(key, draft);
      const changed = draft.text !== draft.savedText;
      let dirty = get().dirty;
      if (dirty.has(key) !== changed) {
        dirty = new Set(dirty);
        if (changed) dirty.add(key);
        else dirty.delete(key);
      }
      set({ drafts, dirty });
    }
    return {
      drafts: new Map(),
      dirty: new Set(),
      load: (key, doc) => {
        if (!get().drafts.has(key)) put(key, { ...doc, savedText: doc.text });
      },
      edit: (key, text) => {
        const draft = get().drafts.get(key);
        if (draft) put(key, { ...draft, text });
      },
      saved: (key, doc) => {
        const draft = get().drafts.get(key);
        if (draft) put(key, { ...doc, text: draft.text, savedText: doc.text });
      },
      discard: (key) => {
        const drafts = new Map(get().drafts);
        const dirty = new Set(get().dirty);
        drafts.delete(key);
        dirty.delete(key);
        set({ drafts, dirty });
      },
    };
  });
}
