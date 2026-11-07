import { CopySessionIdContextMenuItem } from "./CopySessionIdMenuItem";
import { CopyReferenceItem } from "./ConversationReference";
import { memo, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useStore } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { composerDraftOptions } from "../queries";
import type { Draft } from "./Chat";
import {
  X,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Check,
  Undo2,
  Pin,
  PinOff,
  RefreshCw,
} from "lucide-react";
import type { NativeThread, NativeUser, SidebarSection } from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { IconButton } from "./ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { ThreadSettleButton } from "./ThreadSettleButton";
import { ThreadCard, ThreadSelect } from "./ThreadSelect";

function hasUnsentDraft(draft: Draft) {
  return !!(
    draft.text.trim() ||
    draft.attachments.length ||
    draft.skillIds.length ||
    draft.commandId
  );
}

export const SidebarThread = memo(function SidebarThread({
  id,
  thread,
  viewer,
  modelLabel,
  external,
  onSelect,
  onRename,
  onRegenerateTitle,
  onArchive,
  onDelete,
  onDiscardDraft,
  section,
  onSettle,
  onPin,
  settleDisabled,
}: {
  section?: SidebarSection;
  onSettle?: (id: string, section: SidebarSection) => void;
  onPin?: (id: string, section: SidebarSection) => void;
  settleDisabled?: boolean;
  id: string;
  thread?: NativeThread;
  viewer: NativeUser;
  modelLabel?: string;
  external?: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRegenerateTitle: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onDiscardDraft: (id: string) => void;
}) {
  const selected = useLocation({
    select: (location) =>
      !external &&
      (location.pathname === `/threads/${id}` ||
        (location.pathname === "/" && location.state.draftThreadId === id)),
  });
  const settle = () => onSettle?.(id, section ?? "active");
  const pin = () => onPin?.(id, section ?? "active");
  const { drafts, scope, draftCache } = useWorkspace();
  const { data: hasReplyDraft } = useQuery({
    ...composerDraftOptions(scope, id, draftCache),
    enabled: !!thread,
    select: hasUnsentDraft,
  });
  const draft = useStore(drafts, (state) =>
    thread ? undefined : state.summaries.find((item) => item.id === id),
  );
  const title = thread?.title ?? draft?.title ?? "";
  const editable = thread?.capabilities.edit ?? draft?.editable ?? false;
  const settleAction =
    thread && !thread.archived && onSettle ? (
      <ThreadSettleButton
        settled={section === "settled"}
        title={title}
        onClick={settle}
        disabled={settleDisabled}
      />
    ) : null;
  const showDiscard = !selected && (thread ? hasReplyDraft : !!draft);
  const actions =
    showDiscard || settleAction ? (
      <>
        {showDiscard ? (
          <IconButton
            label={`Discard draft for ${title || "conversation"}`}
            tooltip="Discard draft"
            disabled={!thread && !draft?.editable}
            onClick={() => onDiscardDraft(id)}
          >
            <X />
          </IconButton>
        ) : null}
        {settleAction}
      </>
    ) : undefined;
  const [now] = useState(Date.now);
  return (
    <ContextMenu>
      <ContextMenuTrigger className="thread-row-card block py-0.5">
        {thread ? (
          <ThreadSelect
            thread={thread}
            draft={hasReplyDraft ? "reply" : undefined}
            viewer={viewer}
            modelLabel={modelLabel}
            selected={selected}
            pinned={section === "pinned"}
            settled={section === "settled"}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        ) : (
          <ThreadCard
            shortcutId={id}
            title={title}
            starterName={viewer.displayName}
            showStarter={false}
            draft="new"
            starterAvatarUrl={viewer.avatarUrl}
            state="idle"
            updatedAt={now}
            now={now}
            selected={selected}
            pinned={section === "pinned"}
            settled={section === "settled"}
            actions={actions}
            onSelect={() => onSelect(id)}
          />
        )}
      </ContextMenuTrigger>
      {thread || editable || settleAction ? (
        <ContextMenuContent>
          {thread && !thread.archived && onPin ? (
            <ContextMenuItem disabled={settleDisabled} onClick={pin}>
              {section === "pinned" ? <PinOff /> : <Pin />}
              {section === "pinned" ? "Unpin" : "Pin"}
            </ContextMenuItem>
          ) : null}
          {settleAction ? (
            <ContextMenuItem disabled={settleDisabled} onClick={settle}>
              {section === "settled" ? <Undo2 /> : <Check />}
              {section === "settled" ? "Unsettle" : "Settle"}
            </ContextMenuItem>
          ) : null}
          {editable ? (
            <>
              <ContextMenuItem onClick={() => onRename(id, title)}>
                <Pencil />
                Rename
              </ContextMenuItem>
              {thread ? (
                <ContextMenuItem onClick={() => onRegenerateTitle(id)}>
                  <RefreshCw />
                  Regenerate title
                </ContextMenuItem>
              ) : null}
            </>
          ) : null}
          {thread ? (
            <>
              <ContextMenuSeparator />
              <CopyReferenceItem label="Copy link" target={{ surface: "native", sessionId: id }} />
              <CopySessionIdContextMenuItem threadId={id} />
            </>
          ) : null}
          {editable ? (
            <>
              <ContextMenuSeparator />
              {thread ? (
                <ContextMenuItem onClick={() => onArchive(id, !thread.archived)}>
                  {thread.archived ? <ArchiveRestore /> : <Archive />}
                  {thread.archived ? "Unarchive" : "Archive"}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem variant="destructive" onClick={() => onDelete(id)}>
                <Trash2 />
                Delete
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
});
