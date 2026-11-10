import type { ModelReasoning } from "@stanley2058/lilac-client-protocol";
import { z } from "zod";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import type { ComposerSubmission, Attachment } from "./types";
import type { Draft, PendingInput } from "./components/Chat";

export type DraftThread = {
  id: string;
  draft: Draft;
  attachments: Attachment[];
  title?: string;
  modelId?: string;
  reasoning?: ModelReasoning;
  sending?: boolean;
  error?: string;
  creation?: {
    commandId: string;
    title: string;
    autoTitle?: boolean;
    modelId?: string;
    reasoning?: ModelReasoning;
    entry: PendingInput;
  };
};

export function newDraftThread(): DraftThread {
  return {
    id: `draft:${crypto.randomUUID()}`,
    draft: { text: "", skillIds: [], attachments: [] },
    attachments: [],
  };
}

export function draftThreadTitle(thread: DraftThread): string {
  return (
    (thread.title ?? draftPreviewLine(thread.draft.text).slice(0, 80) ?? "") ||
    thread.attachments[0]?.file.name ||
    "New conversation"
  );
}

function draftPreviewLine(text: string): string {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  const line = newline < 0 ? trimmed : trimmed.slice(0, newline);
  let preview = "";
  let offset = 0;
  while (offset < line.length && preview.length < 80) {
    const remaining = line.slice(offset);
    if (remaining.startsWith("\\")) {
      preview += remaining.slice(0, 2);
      offset += 2;
      continue;
    }
    const code = /^`+/.exec(remaining)?.[0];
    if (code) {
      const closing = line.indexOf(code, offset + code.length);
      const end = closing < 0 ? line.length : closing + code.length;
      preview += line.slice(offset, Math.min(end, offset + 80 - preview.length));
      offset = end;
      continue;
    }
    const attachment = /^\[((?:\\.|[^\\\]])*)\]\(attachment:[^\s)]+\)/.exec(remaining);
    if (attachment) {
      preview += attachment[1]!.replace(/\\([\\`*{}[\]()#+\-.!_>~|])/g, "$1");
      offset += attachment[0].length;
      continue;
    }
    preview += line[offset];
    offset++;
  }
  return preview;
}

export function hasDraftContent(thread: DraftThread): boolean {
  return !!(
    thread.draft.text.trim() ||
    thread.draft.skillIds.length ||
    thread.draft.commandId ||
    thread.attachments.length ||
    thread.creation
  );
}

export function draftAttachment(file: File): Attachment {
  return {
    key: crypto.randomUUID(),
    file,
    ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    reservation: Promise.resolve(undefined),
    progress: 0,
    state: "ready",
  };
}

export function prepareDraftSend(
  thread: DraftThread,
  submission: ComposerSubmission,
): NonNullable<DraftThread["creation"]> {
  if (thread.creation) return thread.creation;
  return {
    commandId: crypto.randomUUID(),
    title: draftThreadTitle({
      ...thread,
      draft: { ...thread.draft, text: submission.attachmentText ?? submission.text },
    }),
    autoTitle: thread.title === undefined,
    modelId: submission.modelId,
    reasoning: submission.reasoning,
    entry: {
      commandId: crypto.randomUUID(),
      text: submission.text,
      createdAt: Date.now(),
      submission,
      state: "preparing",
    },
  };
}

export function releaseDraftAttachments(attachments: readonly Attachment[]) {
  for (const attachment of attachments)
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
}

const draftHistorySchema = z.strictObject({ draftThreadId: z.string() });

export function restoreDraftThread(
  drafts: ReadonlyMap<string, DraftThread>,
  historyState: unknown,
): DraftThread {
  const parsed = draftHistorySchema.safeParse(historyState);
  if (!parsed.success) return newDraftThread();
  return drafts.get(parsed.data.draftThreadId) ?? newDraftThread();
}

export async function applyDraftTitleChanges(options: {
  thread: NativeThread;
  initialTitle: string | undefined;
  getTitle: () => string | undefined;
  updateTitle: (thread: NativeThread, title: string) => Promise<NativeThread | undefined>;
}): Promise<NativeThread | undefined> {
  let thread = options.thread;
  let appliedTitle = options.initialTitle;
  while (true) {
    const title = options.getTitle();
    if (title === undefined || title === appliedTitle) return thread;
    const updated = await options.updateTitle(thread, title);
    if (!updated) return undefined;
    thread = updated;
    appliedTitle = title;
  }
}
