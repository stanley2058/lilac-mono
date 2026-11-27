import type { StoreApi } from "zustand/vanilla";
import type { ConfigDraftState } from "./draft-store";

/**
 * Keeps one draft store for the life of the Settings dialog. Settings creates the holder without
 * loading the store module, which arrives with the lazily loaded editor.
 */
export type ConfigStoreHolder = {
  readonly current: StoreApi<ConfigDraftState> | undefined;
  ensure(create: () => StoreApi<ConfigDraftState>): StoreApi<ConfigDraftState>;
};

export function createConfigStoreHolder(): ConfigStoreHolder {
  let store: StoreApi<ConfigDraftState> | undefined;
  return {
    get current() {
      return store;
    },
    ensure(create) {
      store ??= create();
      return store;
    },
  };
}
