import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ConfigKind } from "./schemas";

type SaveAttempt = { readonly attempt: number; readonly pending: boolean };

type SaveLockState = {
  readonly saves: Partial<Record<ConfigKind, SaveAttempt>>;
  /** Starts a save and returns its attempt number, or `undefined` while one is pending. */
  begin(kind: ConfigKind): number | undefined;
  end(kind: ConfigKind, attempt: number): void;
};

export function createConfigSaveLock() {
  return createStore<SaveLockState>()((set, get) => ({
    saves: {},
    begin: (kind) => {
      const current = get().saves[kind];
      if (current?.pending) return undefined;
      const attempt = (current?.attempt ?? 0) + 1;
      set((state) => ({ saves: { ...state.saves, [kind]: { attempt, pending: true } } }));
      return attempt;
    },
    end: (kind, attempt) =>
      set((state) =>
        state.saves[kind]?.attempt === attempt
          ? { saves: { ...state.saves, [kind]: { attempt, pending: false } } }
          : state,
      ),
  }));
}

/**
 * One save per file at a time. It lives at module scope because an MCP save keeps running its
 * reload after the Settings dialog closes, and a reopened dialog must not start another.
 */
export const configSaveLock = createConfigSaveLock();

export function useConfigSaving(kind: ConfigKind): boolean {
  return useStore(configSaveLock, (state) => state.saves[kind]?.pending === true);
}
