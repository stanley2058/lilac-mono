import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyConfigPatch,
  configValuesEqual,
  parseConfigYaml,
  readConfigValue,
  type ConfigPatchOperation,
  type ConfigPath,
  type ConfigValue,
} from "@stanley2058/lilac-utils/config-document";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import type { ConfigKind } from "./schemas";

export type ConfigDocument = NativeRpcOutputs["config"]["read"];

export type ConfigDraft = {
  /** Last document read from or written to Core. */
  readonly saved: ConfigDocument;
  readonly savedValue: ConfigValue | undefined;
  readonly text: string;
  /** Parsed draft, or `undefined` while the YAML has a syntax error. */
  readonly value: ConfigValue | undefined;
  readonly parseError?: string;
  /** Increments on every edit so a finished save can tell whether newer edits exist. */
  readonly editRevision: number;
  /** Increments when the draft is replaced wholesale, so field editors drop local text. */
  readonly resets: number;
  /** Form edits since `saved`, replayable on a newer file. `null` after a YAML edit. */
  readonly operations: readonly ConfigPatchOperation[] | null;
  readonly status?: string;
};

/** Where "Show in YAML" or search should take the reader. */
export type ConfigFocus = { readonly path: ConfigPath; readonly sequence: number };

export type ConfigDraftState = {
  readonly drafts: Partial<Record<ConfigKind, ConfigDraft>>;
  readonly pages: Partial<Record<ConfigKind, string>>;
  readonly focus: Partial<Record<ConfigKind, ConfigFocus>>;
  load(document: ConfigDocument): void;
  replace(document: ConfigDocument): void;
  /** Replays form edits on a newer file. Leaves the draft unchanged and returns the error on failure. */
  rebase(document: ConfigDocument, operations: readonly ConfigPatchOperation[]): string | undefined;
  setText(kind: ConfigKind, text: string): void;
  apply(kind: ConfigKind, operations: readonly ConfigPatchOperation[]): string | undefined;
  discard(kind: ConfigKind): void;
  completeSave(kind: ConfigKind, editRevision: number, saved: ConfigDocument): void;
  setStatus(kind: ConfigKind, status: string | undefined): void;
  setPage(kind: ConfigKind, page: string): void;
  reveal(kind: ConfigKind, page: string, path: ConfigPath): void;
};

function parse(text: string): Pick<ConfigDraft, "value" | "parseError"> {
  return parseConfigYaml(text).match<Pick<ConfigDraft, "value" | "parseError">>({
    ok: ({ value }) => ({ value }),
    err: (error) => ({ value: undefined, parseError: error.message.split("\n")[0] }),
  });
}

function fresh(document: ConfigDocument): ConfigDraft {
  const parsed = parse(document.text);
  return {
    saved: document,
    savedValue: parsed.value,
    text: document.text,
    ...parsed,
    editRevision: 0,
    resets: 0,
    operations: [],
  };
}

export function createConfigDraftStore(): StoreApi<ConfigDraftState> {
  let sequence = 0;
  return createStore<ConfigDraftState>()((set, get) => {
    const update = (kind: ConfigKind, change: (draft: ConfigDraft) => ConfigDraft) =>
      set((state) => {
        const draft = state.drafts[kind];
        return draft ? { drafts: { ...state.drafts, [kind]: change(draft) } } : state;
      });
    return {
      drafts: {},
      pages: {},
      focus: {},
      load: (document) =>
        set((state) =>
          state.drafts[document.kind]
            ? state
            : { drafts: { ...state.drafts, [document.kind]: fresh(document) } },
        ),
      rebase: (document, operations) =>
        applyConfigPatch(document.text, operations).match({
          ok: (text) => {
            update(document.kind, (draft) => ({
              ...fresh(document),
              text,
              ...parse(text),
              editRevision: draft.editRevision + 1,
              resets: draft.resets + 1,
              operations: text === document.text ? [] : operations,
            }));
            return undefined;
          },
          err: (error) => error.message,
        }),
      replace: (document) =>
        set((state) => {
          // Keep the edit revision increasing so pending saves and reads notice the replacement.
          const previous = state.drafts[document.kind];
          const draft = {
            ...fresh(document),
            editRevision: (previous?.editRevision ?? -1) + 1,
            resets: (previous?.resets ?? -1) + 1,
          };
          return { drafts: { ...state.drafts, [document.kind]: draft } };
        }),
      setText: (kind, text) =>
        update(kind, (draft) =>
          draft.text === text
            ? draft
            : {
                ...draft,
                text,
                ...parse(text),
                editRevision: draft.editRevision + 1,
                operations: text === draft.saved.text ? [] : null,
                status: undefined,
              },
        ),
      apply: (kind, operations) => {
        const draft = get().drafts[kind];
        if (!draft) return "Configuration is not loaded";
        return applyConfigPatch(draft.text, operations).match({
          ok: (text) => {
            update(kind, (current) => ({
              ...current,
              text,
              ...parse(text),
              editRevision: current.editRevision + 1,
              operations:
                text === current.saved.text
                  ? []
                  : current.operations && [...current.operations, ...operations],
              status: undefined,
            }));
            return undefined;
          },
          err: (error) => error.message,
        });
      },
      discard: (kind) =>
        update(kind, (draft) => ({
          ...fresh(draft.saved),
          editRevision: draft.editRevision + 1,
          resets: draft.resets + 1,
        })),
      completeSave: (kind, editRevision, saved) =>
        update(kind, (draft) => {
          const savedValue = parse(saved.text).value;
          if (draft.editRevision !== editRevision)
            return {
              ...draft,
              saved,
              savedValue,
              operations: null,
              status: "Earlier changes saved. New edits are unsaved.",
            };
          return {
            ...fresh(saved),
            editRevision: draft.editRevision,
            resets: draft.resets,
            status: "Saved",
          };
        }),
      setStatus: (kind, status) => update(kind, (draft) => ({ ...draft, status })),
      setPage: (kind, page) => set((state) => ({ pages: { ...state.pages, [kind]: page } })),
      reveal: (kind, page, path) => {
        sequence += 1;
        set((state) => ({
          pages: { ...state.pages, [kind]: page },
          focus: { ...state.focus, [kind]: { path, sequence } },
        }));
      },
    };
  });
}

export const ConfigDraftContext = createContext<StoreApi<ConfigDraftState> | null>(null);

export function useConfigDraftStore(): StoreApi<ConfigDraftState> {
  return useContext(ConfigDraftContext)!;
}

export function useConfigDrafts<T>(selector: (state: ConfigDraftState) => T): T {
  return useStore(useConfigDraftStore(), selector);
}

/**
 * Subscribes to one value in a draft. Lists and records keep their reference while their
 * entries are unchanged, so editing one field does not rerender the others.
 */
export function useConfigValue(
  kind: ConfigKind,
  path: ConfigPath,
  source: "draft" | "saved" = "draft",
): ConfigValue | undefined {
  return useConfigDrafts(
    useShallow((state) => {
      const draft = state.drafts[kind];
      const root = source === "draft" ? draft?.value : draft?.savedValue;
      return root === undefined ? undefined : readConfigValue(root, path);
    }),
  );
}

/** Whether the draft differs from the saved file at `path`. */
export function useConfigDirty(kind: ConfigKind, path: ConfigPath): boolean {
  return useConfigDrafts((state) => {
    const draft = state.drafts[kind];
    if (!draft?.value || draft.savedValue === undefined) return false;
    return !configValuesEqual(
      readConfigValue(draft.value, path),
      readConfigValue(draft.savedValue, path),
    );
  });
}
