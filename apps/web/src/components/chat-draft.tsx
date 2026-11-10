import { useStore } from "zustand";
import { useQuery } from "@tanstack/react-query";
import type { DraftThread } from "../draft-thread";
import { composerDraftOptions } from "../queries";
import { useWorkspace } from "../workspace-context";
import { Composer, type ComposerProps } from "./Composer";

export type Draft = {
  text: string;
  skillIds: string[];
  commandId?: string;
  attachments: string[];
  savedText?: string;
};

export const emptyDraft: Draft = { text: "", skillIds: [], attachments: [] };
/** What the conversation needs from a draft. Typing changes only the text, which the composer reads. */
export type DraftSummary = Omit<Draft, "text"> & { hasText: boolean };
export const summarizeDraft = ({ text, ...draft }: Draft): DraftSummary => ({
  ...draft,
  hasText: !!text.trim(),
});
export const emptySummary = summarizeDraft(emptyDraft);

export const draftText = (draft: Draft) => draft.text;

/**
 * A local conversation without its draft. Typing replaces the draft on every keystroke, so a
 * shallow-compared selector over this keeps the conversation from rerendering.
 */
export const localThreadSettings = (thread: DraftThread | undefined) => {
  if (!thread) return undefined;
  const { draft: _draft, ...settings } = thread;
  return settings;
};
export const localDraftSummary = (thread: DraftThread | undefined) =>
  thread && summarizeDraft(thread.draft);

export type DraftTextSource = {
  local: boolean;
  threadId: string;
  options: ReturnType<typeof composerDraftOptions>;
  initialData?: Draft;
};

/** Reads the draft text, so typing rerenders the composer instead of the whole conversation. */
export function DraftComposer({
  source,
  ...props
}: Omit<ComposerProps, "text"> & { source: DraftTextSource }) {
  const { drafts } = useWorkspace();
  const localText = useStore(drafts, (state) =>
    source.local ? (state.localDrafts.get(source.threadId)?.draft.text ?? "") : "",
  );
  const saved = useQuery({
    ...source.options,
    initialData: source.initialData,
    enabled: !source.local,
    select: draftText,
  });
  return <Composer {...props} text={source.local ? localText : (saved.data ?? "")} />;
}
