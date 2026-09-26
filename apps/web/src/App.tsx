import { FloatingChatMenu } from "./components/FloatingChatMenu";
import { useWorkspaceViewport } from "./use-workspace-viewport";
import { Kbd } from "./components/ui/kbd";
import {
  useAppShortcuts,
  useThreadShortcut,
  useShortcut,
  ThreadShortcutTargets,
  focusMainComposer,
  blurForThreadNavigation,
} from "./shortcuts";
import { watchNotifications, holdNotificationLock, notificationScope } from "./notifications";
import { useConnectionNotice } from "./use-connection-notice";
import { parseReferenceHref } from "@stanley2058/lilac-client-protocol";
import { ThreadReferenceView } from "./components/ThreadReferenceView";
import { SidebarEmptyState } from "./components/SidebarEmptyState";
import type { WorkspaceSearch } from "./router";
import { readTheme, setThemeMode } from "./theme/theme";
import { FileViewerProvider } from "./components/file-viewer-context";
import { RightPanel } from "./components/FileViewer";
import { useEventCallback } from "./use-event-callback";
import { ActorAvatar } from "./components/ActorAvatar";
import { defaultRightPanel } from "./panel-store";
import { WorkspacePanels, WorkspaceSidePanel } from "./components/WorkspacePanels";
import { PanelToggleButton } from "./components/PanelToggleButton";
import { NativeSubagentProvider, RightPanelToggle } from "./components/SubagentPanel";
import { useLocation, useNavigate, useMatch, useRouter } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  updateComposerDraft,
  profileOptions,
  searchOptions,
  threadOptions,
  useNativeOnline,
} from "./queries";
import { useStore } from "zustand";
import { WorkspaceProvider, useWorkspace } from "./workspace-context";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Result } from "better-result";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Plus,
  MessageCirclePlus,
  Settings as SettingsIcon,
  LogOut,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Users,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Palette,
} from "lucide-react";
import type { DisplayCatalog, NativeThread } from "@stanley2058/lilac-client-protocol";
import type { AppProps, ComposerSubmission } from "./types";
import { resolveAttachmentIds } from "./uploads";
import { Chat, type Draft, type PendingInput } from "./components/Chat";
import { Settings } from "./components/Settings";
import { SidebarSearch } from "./components/SidebarSearch";
const Sharing = lazy(() =>
  import("./components/Sharing").then((module) => ({ default: module.Sharing })),
);
const External = lazy(() =>
  import("./components/External").then((module) => ({ default: module.External })),
);
import { attempt, IconButton, Modal, VirtualList } from "./components/ui";
import { MessageIdentityContext } from "./components/message-identity";
import { toast } from "./components/ui/toast";
import { refreshSidebar } from "./sidebar-queries";
import { ExternalSidebar, ExternalSkeleton } from "./components/ExternalSidebar";
import { SidebarQueue } from "./components/SidebarQueue";
import { SidebarThread } from "./components/SidebarThread";
import {
  newDraftThread,
  restoreDraftThread,
  hasDraftContent,
  prepareDraftSend,
  applyDraftTitleChanges,
  releaseDraftAttachments,
  type DraftThread,
} from "./draft-thread";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./components/ui/context-menu";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./styles.css";

export type { AppProps } from "./types";
export function App(props: AppProps) {
  return (
    <WorkspaceProvider {...props}>
      <Workspace {...props} />
    </WorkspaceProvider>
  );
}
function Workspace(props: AppProps) {
  const viewport = useWorkspaceViewport();
  const navigate = useNavigate();
  const router = useRouter();
  const active = useMatch({ from: "/chat", shouldThrow: false, select: () => true }) ?? false;
  const routeThreadId = useMatch({
    from: "/chat/threads/$threadId",
    shouldThrow: false,
    select: (match) => match.params.threadId,
  });
  const routePathname = useLocation({ select: (location) => location.pathname });
  const routeDraftId = useLocation({ select: (location) => location.state.draftThreadId });
  const { pool, drafts: draftStore, panels, notifications } = useWorkspace();
  const draftIds = useStore(draftStore, (state) => state.ids);
  const setLocalDrafts = draftStore.getState().setLocalDrafts;
  const { client, initial } = props;
  const online = useNativeOnline(client);
  const profile = useQuery({ ...profileOptions(client), enabled: online });
  const viewer = profile.data ?? initial.viewer;
  const [threads, setThreads] = useState(initial.threads.items);
  const [nextCursor, setNextCursor] = useState(initial.threads.nextCursor);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadListError, setThreadListError] = useState(false);
  const threadListRequest = useRef({ loading: false });
  const [firstDraft] = useState(() => draftStore.getState().localDrafts.values().next().value!);
  const removedDrafts = useRef(new Set<string>());
  const [lastSelectedId, setLastSelectedId] = useState(
    routeThreadId ?? routeDraftId ?? initial.threads.items[0]?.id ?? firstDraft.id,
  );
  // Clerk's hash navigation creates history entries without our draft selection state.
  const routeSelection = routeThreadId ?? routeDraftId ?? lastSelectedId;
  if (active && lastSelectedId !== routeSelection) setLastSelectedId(routeSelection);
  const selectedId = active ? routeSelection : lastSelectedId;
  useEffect(() => {
    if (!active || routePathname !== "/" || routeThreadId || routeDraftId) return;
    if (selectedId.startsWith("draft:")) {
      void navigate({
        to: "/",
        state: { draftThreadId: selectedId },
        search: true,
        hash: true,
        replace: true,
      });
      return;
    }
    void navigate({
      to: "/threads/$threadId",
      params: { threadId: selectedId },
      search: true,
      hash: true,
      replace: true,
    });
  }, [active, routePathname, routeThreadId, routeDraftId, selectedId, navigate]);
  const [catalog, setCatalog] = useState<DisplayCatalog | undefined>(() =>
    initial.catalog.kind === "catalog" ? initial.catalog.catalog : client.catalogs.get(props.scope),
  );
  const [error, setError] = useState<string>();
  const search: WorkspaceSearch =
    useMatch({
      from: "/chat",
      shouldThrow: false,
      select: (match) => match.search,
    }) ?? {};
  const reference = search.ref
    ? parseReferenceHref(
        `/?${new URLSearchParams({ ref: search.ref, ...(search.message ? { message: search.message } : {}), ...(search.range ? { range: search.range } : {}) })}`,
      )
    : undefined;
  const settings = search.settings;
  const viewedNotificationThread = search.view === "others" ? search.otherThread : routeThreadId;
  const openNotificationThread = useEventCallback((threadId: string) => {
    void navigate({ to: "/threads/$threadId", params: { threadId }, search: {} });
  });
  useEffect(
    () =>
      watchNotifications({
        client,
        initial: initial.threads.items,
        scope: props.scope,
        preferences: notifications,
        openThread: openNotificationThread,
      }),
    [client, notifications],
  );
  useEffect(() => {
    let release: (() => void) | undefined;
    const update = () => {
      release?.();
      release = undefined;
      if (
        active &&
        !settings &&
        viewedNotificationThread &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        navigator.locks
      )
        release = holdNotificationLock(
          `${notificationScope(props.scope)}:view:${viewedNotificationThread}`,
        );
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      release?.();
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [active, settings, viewedNotificationThread, notifications]);

  const archived = search.view === "archived";
  const external = search.view === "others" && viewer.role === "owner";
  const externalId = search.otherThread;
  const changeView = useEventCallback((change: Partial<WorkspaceSearch>) => {
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, ...change }),
      state: true,
      hash: true,
    });
  });
  const [sharing, setSharing] = useState(false);
  const sidebarLayout = useStore(panels, (state) => state.sidebar);
  const rightLayout = useStore(
    panels,
    (state) => state.threads.get(selectedId) ?? defaultRightPanel,
  );
  const sidebar = sidebarLayout.open;
  const rightOpen = rightLayout.open;
  const [searchQuery, setSearchQuery] = useState("");
  const queries = useQueryClient();
  const searchResults = useInfiniteQuery({
    ...searchOptions(client, searchQuery),
    enabled: online && !!searchQuery,
  });
  const results = searchQuery
    ? {
        items: searchResults.data?.pages.flatMap((page) => page.items) ?? [],
        nextCursor: searchResults.hasNextPage,
      }
    : undefined;
  const searching = searchResults.isFetching;
  useEffect(() => {
    if (searchResults.error) setError(searchResults.error.message);
  }, [searchResults.error]);
  const [rename, setRename] = useState<{ id: string; title: string }>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  useEffect(() => {
    if (active) return;
    setSharing(false);
    setRename(undefined);
    setConfirmDelete(undefined);
  }, [active]);
  const [theme, setTheme] = useState<string>(() => readTheme());
  const drafts = useRef(new Map<string, Draft>());
  const [pendingInputs, setPendingInputs] = useState(new Map<string, PendingInput[]>());
  const pending = useRef(pendingInputs);
  pending.current = pendingInputs;
  const patchPending = useCallback(
    (id: string, update: (entries: PendingInput[]) => PendingInput[]) => {
      const changed = new Map(pending.current);
      changed.set(id, update(changed.get(id) ?? []));
      pending.current = changed;
      setPendingInputs(changed);
    },
    [],
  );
  const readTurns = useRef(new Map<string, string>());
  const selected = threads.find((thread) => thread.id === selectedId);
  const owner = viewer.role === "owner";
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const archivedRef = useRef(archived);
  archivedRef.current = archived;

  const identities = useMemo(
    () => ({
      agent: catalog?.agent ?? { displayName: "Lilac" },
      viewerId: viewer.id,
      users: new Map([
        [viewer.id, { displayName: viewer.displayName, avatarUrl: viewer.avatarUrl }],
      ]),
    }),
    [catalog?.agent, viewer],
  );
  const listedArchived = useRef(false);
  useEffect(() => {
    if (listedArchived.current === archived) return;
    listedArchived.current = archived;
    void listThreads(archived);
  }, [archived]);
  const [draftsHydrated, setDraftsHydrated] = useState(!props.draftCache);
  const routeDraftExists = useStore(
    draftStore,
    (state) => !routeDraftId || state.localDrafts.has(routeDraftId),
  );
  useEffect(() => {
    const cache = props.draftCache;
    if (!cache) return;
    let canceled = false;
    void attempt(() => cache.listLocalDrafts(props.scope), setError).then((saved) => {
      if (canceled) return;
      setDraftsHydrated(true);
      if (!saved) return;
      const changed = new Map(draftStore.getState().localDrafts);
      for (const { threadId, draft } of saved) {
        if (changed.has(threadId) || removedDrafts.current.has(threadId)) continue;
        changed.set(threadId, {
          id: threadId,
          draft: { ...draft, attachments: [] },
          attachments: [],
          title: draft.title,
          modelId: draft.modelId,
        });
      }
      setLocalDrafts(changed);
    });
    return () => {
      canceled = true;
    };
  }, [props.draftCache, props.scope]);
  useEffect(() => {
    if (!active || !draftsHydrated || !routeDraftId || routeDraftExists) return;
    const changed = new Map(draftStore.getState().localDrafts);
    const draft = restoreDraftThread(changed, { draftThreadId: routeDraftId });
    changed.set(draft.id, draft);
    setLocalDrafts(changed);
    void navigate({
      to: "/",
      state: { draftThreadId: draft.id },
      search: true,
      hash: true,
      replace: true,
    });
  }, [
    active,
    draftsHydrated,
    routeDraftId,
    routeDraftExists,
    draftStore,
    setLocalDrafts,
    navigate,
  ]);

  useEffect(() => {
    setThemeMode(theme);
    const saved = Result.try({
      try: () => localStorage.setItem("lilac-theme-v1", theme),
      catch: () => "Storage unavailable",
    });
    saved.match({ ok: () => {}, err: () => {} });
  }, [theme]);
  const upsert = useCallback(
    (thread: NativeThread) =>
      setThreads((current) => {
        if (current.some((entry) => entry === thread)) return current;
        const found = current.some((entry) => entry.id === thread.id);
        if (!found && thread.archived !== archivedRef.current && thread.id !== selectedRef.current)
          return current;
        return [...current.filter((entry) => entry.id !== thread.id), thread].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
      }),
    [],
  );
  useEffect(
    () =>
      client.subscribe((event) => {
        switch (event.kind) {
          case "bootstrap":
            queries.setQueryData(["profile"], event.bootstrap.viewer);
            void queries.invalidateQueries({ queryKey: ["participants"] });
            void queries.invalidateQueries({ queryKey: ["users"] });
            threadListRequest.current = { loading: false };
            setLoadingThreads(false);
            setThreadListError(false);
            setCatalog(client.catalogs.get(props.scope));
            if (archivedRef.current) {
              void listThreads(true);
              return;
            }
            setThreads(event.bootstrap.threads.items);
            setNextCursor(event.bootstrap.threads.nextCursor);
            return;
          case "thread":
            upsert(event.thread);
            return;
          case "removed":
            setThreads((items) => items.filter((thread) => thread.id !== event.threadId));
            queries.removeQueries({ queryKey: ["participants", event.threadId] });
            drafts.current.delete(event.threadId);
            pending.current.delete(event.threadId);
            readTurns.current.delete(event.threadId);
            if (activeRef.current && selectedRef.current === event.threadId) createThread();
            return;
          case "catalog":
            setCatalog(client.catalogs.get(props.scope));
            return;
          case "connection":
            return;
          case "error":
            setError(event.error.message);
            return;
          case "checkpoint":
            return;
          case "input":
            return;
        }
      }),
    [client, props.scope, upsert],
  );
  useEffect(() => {
    void client.selectThread(selectedId?.startsWith("draft:") ? undefined : selectedId);
  }, [client, selectedId]);
  const selectedMetadata = useQuery({
    ...threadOptions(client, selectedId ?? ""),
    enabled: online && !!selectedId && !selectedId.startsWith("draft:") && !selected,
  });
  useEffect(() => {
    if (selectedMetadata.data && !selected) upsert(selectedMetadata.data);
  }, [selectedMetadata.data, !!selected, upsert]);
  function changeLocalDraft(id: string, update: (thread: DraftThread) => DraftThread) {
    const current = draftStore.getState().localDrafts.get(id);
    if (!current) return;
    const changed = new Map(draftStore.getState().localDrafts);
    const next = update(current);
    changed.set(id, next);
    setLocalDrafts(changed);
    const cache = props.draftCache;
    if (!cache) return;
    void attempt(
      () =>
        cache.saveDraft(props.scope, id, {
          ...next.draft,
          title: next.title,
          modelId: next.modelId,
        }),
      setError,
    );
  }
  function removeLocalDraft(id: string, persistence: "delete" | "clear" = "delete") {
    removedDrafts.current.add(id);
    const cache = props.draftCache;
    if (cache)
      void attempt(
        () =>
          persistence === "clear"
            ? cache.saveDraft(props.scope, id, { text: "", skillIds: [] })
            : cache.deleteDraft(props.scope, id),
        setError,
      );
    const current = draftStore.getState().localDrafts.get(id);
    if (!current) return;
    releaseDraftAttachments(current.attachments);
    releaseDraftAttachments(current.creation?.entry.submission.attachments ?? []);
    const changed = new Map(draftStore.getState().localDrafts);
    changed.delete(id);
    setLocalDrafts(changed);
  }
  const discardDraft = useEventCallback(function discardDraft(id: string) {
    if (id.startsWith("draft:")) {
      if (draftStore.getState().localDrafts.get(id)?.creation) return;
      // Clearing avoids invalidating concurrent cache reads for other threads.
      removeLocalDraft(id, "clear");
      return;
    }
    const draft = queries.getQueryData<Draft>(["composer-draft", id]);
    const empty: Draft = { text: "", skillIds: [], attachments: [] };
    updateComposerDraft(queries, id, empty);
    drafts.current.delete(id);
    for (const key of draft?.attachments ?? []) pool.remove(id, key);
    if (props.draftCache)
      void attempt(() => props.draftCache!.saveDraft(props.scope, id, empty), setError);
  });
  const select = useEventCallback(function select(id: string) {
    blurForThreadNavigation();
    if (id === selectedRef.current) focusMainComposer();
    const search = { view: archived ? ("archived" as const) : undefined };
    if (id.startsWith("draft:")) {
      void navigate({ to: "/", state: { draftThreadId: id }, search });
      return;
    }
    void navigate({ to: "/threads/$threadId", params: { threadId: id }, search });
  });

  const createThread = useEventCallback(function createThread() {
    blurForThreadNavigation();
    const draft = newDraftThread();
    const changed = new Map(draftStore.getState().localDrafts);
    for (const [id, existing] of changed) if (!hasDraftContent(existing)) changed.delete(id);
    changed.set(draft.id, draft);
    setLocalDrafts(changed);
    void navigate({ to: "/", state: { draftThreadId: draft.id }, search: {} });
  });
  function finishDraftNavigation(draftId: string, threadId: string) {
    if (selectedRef.current !== draftId) return;
    if (activeRef.current) {
      void navigate({
        to: "/threads/$threadId",
        params: { threadId },
        search: true,
        hash: true,
      });
      return;
    }
    const location = router.state.location;
    if (location.pathname !== "/design-system" || location.state.draftThreadId !== draftId) return;
    void navigate({ to: "/design-system", state: { chatThreadId: threadId }, replace: true });
  }
  async function submitDraft(id: string, submission: ComposerSubmission) {
    const current = draftStore.getState().localDrafts.get(id);
    const rpc = client.rpc;
    if (!current || current.sending) return;
    if (!rpc) {
      changeLocalDraft(id, (draft) => ({ ...draft, error: "Connect before sending" }));
      return;
    }
    const creation = prepareDraftSend(current, submission);
    changeLocalDraft(id, (draft) => ({
      ...draft,
      creation,
      sending: true,
      error: undefined,
      ...(draft.creation
        ? {}
        : { attachments: [], draft: { text: "", skillIds: [], attachments: [] } }),
    }));
    const initialThread = await attempt(
      () =>
        rpc.threads.create({
          commandId: creation.commandId,
          title: creation.title,
          autoTitle: creation.autoTitle,
          modelId: creation.modelId,
        }),
      (error) => changeLocalDraft(id, (draft) => ({ ...draft, sending: false, error })),
    );
    if (!initialThread || pool.signal.aborted) return;
    const { remapComposerAttachments, resolveComposerAttachments } =
      await import("./components/composer-editor");
    const created = await applyDraftTitleChanges({
      thread: initialThread,
      initialTitle: creation.autoTitle ? undefined : creation.title,
      getTitle: () => draftStore.getState().localDrafts.get(id)?.title,
      updateTitle: (thread, title) =>
        attempt(
          () =>
            rpc.threads.update({ threadId: thread.id, expectedRevision: thread.revision, title }),
          (error) => changeLocalDraft(id, (draft) => ({ ...draft, sending: false, error })),
        ),
    });
    if (!created || pool.signal.aborted) return;
    upsert(created);
    const latest = draftStore.getState().localDrafts.get(id);
    const moveAttachments = (files: ComposerSubmission["attachments"]) =>
      files.map((item) => {
        const key = pool.add(created.id, item.file);
        return pool.get(created.id).find((item) => item.key === key)!;
      });
    const files = moveAttachments(creation.entry.submission.attachments);
    const entry: PendingInput = {
      ...creation.entry,
      optimisticSlotIds: [],
      submission: {
        ...creation.entry.submission,
        attachmentText: creation.entry.submission.attachmentText
          ? remapComposerAttachments(
              creation.entry.submission.attachmentText,
              new Map(
                creation.entry.submission.attachments.map((attachment, index) => [
                  attachment.key,
                  files[index]!.key,
                ]),
              ),
            )
          : undefined,
        attachments: files,
      },
    };
    patchPending(created.id, (entries) => [...entries, entry]);
    if (latest) {
      const unsent = moveAttachments(latest.attachments);
      const transferredDraft = {
        ...latest.draft,
        text: remapComposerAttachments(
          latest.draft.text,
          new Map(latest.attachments.map((item, index) => [item.key, unsent[index]!.key])),
        ),
        attachments: unsent.map((file) => file.key),
      };
      drafts.current.set(created.id, transferredDraft);
      updateComposerDraft(queries, created.id, transferredDraft);
      if (props.draftCache)
        void attempt(
          () => props.draftCache!.saveDraft(props.scope, created.id, transferredDraft),
          setError,
        );
    }
    panels.getState().moveThread(id, created.id);
    removeLocalDraft(id);
    finishDraftNavigation(id, created.id);
    const patch = (change: Partial<PendingInput> | null) =>
      patchPending(created.id, (entries) =>
        change
          ? entries.map((item) =>
              item.commandId === entry.commandId ? { ...item, ...change } : item,
            )
          : entries.filter((item) => item.commandId !== entry.commandId),
      );
    const prepared = await attempt(
      async () => {
        const [attachmentIds, replay] = await Promise.all([
          resolveAttachmentIds(pool, created.id, files, false),
          rpc.threads.sync({ threadId: created.id }),
        ]);
        if (attachmentIds.some((resourceId) => !resourceId)) {
          patch({
            state: "rejected",
            error: "A file could not be prepared. Retry this message to retry its upload.",
          });
          return;
        }
        return {
          threadId: created.id,
          commandId: entry.commandId,
          historyGeneration: replay.checkpoint.historyGeneration,
          text: entry.submission.attachmentText
            ? resolveComposerAttachments(
                entry.submission.attachmentText,
                new Map(files.map((file, index) => [file.key, attachmentIds[index]!])),
              )
            : entry.text,
          mode: "prompt" as const,
          modelId: entry.submission.modelId,
          attachmentIds: attachmentIds.filter((resourceId): resourceId is string => !!resourceId),
          skillIds: entry.submission.skillIds,
          command: entry.submission.command,
        };
      },
      (error) => patch({ state: "rejected", error }),
    );
    if (!prepared || pool.signal.aborted) return;
    patch({ input: prepared });
    const outcome = await client.submit(prepared);
    if (pool.signal.aborted) return;
    if (outcome.kind === "accepted") {
      if (outcome.receipt.turnId) {
        patch({ state: "accepted", receipt: outcome.receipt });
        return;
      }
      for (const file of files) pool.release(created.id, file.key);
      patch(null);
      return;
    }
    patch(
      outcome.kind === "uncertain"
        ? { state: "uncertain", error: "Send not confirmed. Retry safely when connected." }
        : { state: "rejected", error: outcome.error.message },
    );
  }
  async function listThreads(showArchived: boolean, cursor?: string) {
    if (!client.rpc || (cursor && threadListRequest.current.loading)) return;
    const request = { loading: true };
    threadListRequest.current = request;
    setLoadingThreads(true);
    setThreadListError(false);
    if (!cursor) setNextCursor(undefined);
    const page = await attempt(
      () =>
        client.rpc!.threads.list({
          archived: showArchived,
          excludeSettled: !showArchived,
          limit: 100,
          cursor,
        }),
      (message) => {
        if (threadListRequest.current === request) setError(message);
      },
    );
    if (threadListRequest.current !== request) return;
    request.loading = false;
    setLoadingThreads(false);
    if (!page) {
      setThreadListError(true);
      return;
    }
    setThreads((current) => {
      if (!cursor) return page.items;
      const ids = new Set(current.map((thread) => thread.id));
      return [...current, ...page.items.filter((thread) => !ids.has(thread.id))];
    });
    setNextCursor(page.nextCursor);
  }
  async function update(id: string, change: { title?: string; archived?: boolean }) {
    if (id.startsWith("draft:")) {
      changeLocalDraft(id, (draft) => ({ ...draft, title: change.title ?? draft.title }));
      setRename(undefined);
      return;
    }
    if (!client.rpc) return;
    const target =
      threads.find((thread) => thread.id === id) ??
      (await attempt(() => client.rpc!.threads.get({ threadId: id }), setError));
    if (!target) return;
    const revision = client.thread(id).checkpoint?.projectionRevision ?? target.revision;
    const changed = await attempt(
      () => client.rpc!.threads.update({ threadId: id, expectedRevision: revision, ...change }),
      setError,
    );
    if (changed) {
      upsert(changed);
      void refreshSidebar(queries);
      setRename(undefined);
    }
  }
  async function deleteThread() {
    const id = confirmDelete;
    if (!id) return;
    if (id.startsWith("draft:")) {
      removeLocalDraft(id);
      setConfirmDelete(undefined);
      if (activeRef.current && selectedRef.current === id) createThread();
      return;
    }
    const rpc = client.rpc;
    if (!rpc) return;
    const checkpoint =
      client.thread(id).checkpoint ??
      (await attempt(() => rpc.threads.sync({ threadId: id }), setError))?.checkpoint;
    if (!checkpoint) return;
    const deleted = await attempt(
      () =>
        rpc.threads.delete({
          threadId: id,
          commandId: crypto.randomUUID(),
          historyGeneration: checkpoint.historyGeneration,
        }),
      setError,
    );
    if (!deleted) return;
    setThreads((items) => items.filter((item) => item.id !== id));
    void refreshSidebar(queries);
    drafts.current.delete(id);
    patchPending(id, () => []);
    setConfirmDelete(undefined);
    if (activeRef.current && selectedRef.current === id) createThread();
  }
  const sidebarThreads = [
    ...(!archived ? draftIds.map((id) => ({ id, source: undefined })) : []),
    ...threads
      .filter((thread) => thread.archived === archived)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        draft: false,
        editable: thread.capabilities.edit,
        archived: thread.archived,
        source: thread,
      })),
  ];
  useEffect(() => {
    if (!error) return;
    toast.add({ id: "app-error", title: error, type: "error", onClose: () => setError(undefined) });
  }, [error]);
  useConnectionNotice(online, () => client.reconnect());

  const renameSidebarThread = useEventCallback((id: string, title: string) =>
    setRename({ id, title }),
  );
  const archiveSidebarThread = useEventCallback(
    (id: string, archived: boolean) => void update(id, { archived }),
  );
  const toggleArchived = useEventCallback(() => {
    changeView({ view: archived ? undefined : "archived", otherThread: undefined });
  });
  const toggleExternal = useEventCallback(() => {
    changeView({ view: external ? undefined : "others", otherThread: undefined });
  });
  const selectExternal = useEventCallback((id: string) => {
    changeView({ view: "others", otherThread: id, ref: undefined, message: undefined });
  });
  const openSettings = useEventCallback(() => changeView({ settings: "account" }));
  const openDesign = useEventCallback(
    () =>
      void navigate({
        to: "/design-system",
        state: selectedId.startsWith("draft:")
          ? { draftThreadId: selectedId }
          : { chatThreadId: selectedId },
      }),
  );
  const logout = useEventCallback(() => void attempt(props.onLogout, setError));
  const newThreadKeys = useShortcut("newThread");
  const settingsKeys = useShortcut("settings");
  useAppShortcuts({
    enabled: active,
    blocked: !!settings,
    newThread: createThread,
    settings: openSettings,
    sidebar: () => {
      const focused = document.activeElement?.closest("#sidebar");
      panels.getState().toggleSidebar();
      if (focused) focusMainComposer();
    },
    rightPanel: () => {
      const focused = document.activeElement?.closest("#right-panel");
      panels.getState().toggle(selectedId);
      if (focused) focusMainComposer();
    },
  });
  const sidebarToolbar = useMemo(
    () => (
      <div className="sidebar-search-row flex items-center gap-1 min-w-0 mb-2">
        <SidebarSearch onSearch={setSearchQuery} />
        <nav
          className="sidebar-tabs flex items-center py-2 px-0"
          aria-label="Conversation filters and actions"
        >
          <IconButton
            label={archived ? "Show active conversations" : "Show archived conversations"}
            tooltip="Archived"
            aria-pressed={archived}
            onClick={toggleArchived}
          >
            <Archive />
          </IconButton>
          {owner ? (
            <IconButton
              label="Show other conversations"
              tooltip="Others"
              aria-pressed={external}
              onClick={toggleExternal}
            >
              <Globe />
            </IconButton>
          ) : null}
          <IconButton
            label="New conversation"
            tooltip="New thread"
            shortcut="newThread"
            onClick={createThread}
          >
            <MessageCirclePlus />
          </IconButton>
        </nav>
      </div>
    ),
    [archived, external, owner, toggleArchived, toggleExternal, createThread],
  );
  const sidebarFooter = useMemo(
    () => (
      <footer className="sidebar-footer flex items-center gap-2 pt-3">
        <ActorAvatar displayName={viewer.displayName} avatarUrl={viewer.avatarUrl} />
        <span className="viewer-name text-sm whitespace-nowrap overflow-hidden text-ellipsis">
          {viewer.displayName}
        </span>
        {props.sessionControl}
        <span className="toolbar-spacer flex-1" />
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <IconButton label="Settings" shortcut="settings" onClick={openSettings}>
                <SettingsIcon />
              </IconButton>
            }
          />
          <ContextMenuContent side="top" align="end">
            <ContextMenuItem onClick={openSettings}>
              <SettingsIcon /> Settings{" "}
              <span className="ml-auto text-xs text-muted-foreground">{settingsKeys.label}</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={openDesign}>
              <Palette /> Design
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={logout}>
              <LogOut /> Logout
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </footer>
    ),
    [viewer, props.sessionControl, openSettings, openDesign, logout, settingsKeys.label],
  );
  const actionThread = !external && !reference ? (selected ?? selectedMetadata.data) : undefined;
  return (
    <MessageIdentityContext.Provider value={identities}>
      <FileViewerProvider threadId={selectedId}>
        <NativeSubagentProvider
          threadId={selectedId ?? ""}
          running={selected?.displayStatus === "working"}
          foreground={active && !external && !reference}
        >
          <Tooltip.Provider delay={350}>
            <main
              ref={viewport}
              className={`app-shell group/workspace relative flex h-dvh overflow-hidden ${sidebar ? "" : "sidebar-hidden"} ${rightOpen ? "" : "right-panel-hidden"}`}
              aria-label="Chat workspace"
            >
              <div className="sidebar-toggle fixed top-0 left-3 h-8 flex items-center z-40 [&_.icon-button]:size-[var(--ui-control-compact)]">
                <PanelToggleButton
                  label={sidebar ? "Hide sidebar" : "Show sidebar"}
                  shortcut="sidebar"
                  open={sidebar}
                  onToggle={panels.getState().toggleSidebar}
                >
                  {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
                </PanelToggleButton>
              </div>
              <RightPanelToggle
                open={rightOpen}
                onToggle={() => panels.getState().toggle(selectedId)}
              />
              <FloatingChatMenu
                sidebarOpen={sidebar}
                rightOpen={rightOpen}
                onToggleSidebar={panels.getState().toggleSidebar}
                onToggleRight={() => panels.getState().toggle(selectedId)}
                archived={actionThread?.archived}
                onShare={owner && actionThread ? () => setSharing(true) : undefined}
                onRename={
                  actionThread?.capabilities.edit
                    ? () => setRename({ id: actionThread.id, title: actionThread.title })
                    : undefined
                }
                onArchive={
                  actionThread?.capabilities.edit
                    ? () => void update(actionThread.id, { archived: !actionThread.archived })
                    : undefined
                }
                onDelete={
                  actionThread?.capabilities.edit
                    ? () => setConfirmDelete(actionThread.id)
                    : undefined
                }
              />
              <WorkspacePanels
                leftOpen={sidebar}
                rightOpen={rightOpen}
                leftWidth={sidebarLayout.width}
                rightWidth={rightLayout.width}
                layoutKey={selectedId}
              >
                {sidebar && !rightOpen ? (
                  <button
                    type="button"
                    aria-label="Close sidebar"
                    className="absolute inset-0 z-20 hidden bg-overlay max-workspace:block"
                    onClick={panels.getState().toggleSidebar}
                  />
                ) : null}
                <WorkspaceSidePanel
                  side="left"
                  open={sidebar}
                  id="sidebar"
                  label="Sidebar width"
                  onWidthChange={panels.getState().resizeSidebar}
                >
                  <aside className="sidebar flex flex-col bg-sidebar text-sidebar-foreground p-3 pt-0 min-h-0 h-full">
                    <header className="sidebar-header flex items-center gap-2 h-8 min-h-8 shrink-0 pl-[calc(var(--ui-control-compact)+var(--ui-space-unit)*3)] mb-3 [&_.brand]:leading-none">
                      <span className="brand inline-flex gap-1 items-baseline text-2xl [letter-spacing:-0.07em] font-[650]">
                        lilac
                        <span />
                      </span>
                    </header>
                    {sidebarToolbar}
                    {archived && !results && !external ? (
                      <ThreadShortcutTargets
                        ids={sidebarThreads.map((thread) => thread.id)}
                        select={select}
                      />
                    ) : null}
                    {results ? (
                      <ThreadShortcutTargets
                        ids={results.items.map((hit) => hit.threadId)}
                        select={(id) => {
                          const hit = results.items.find((hit) => hit.threadId === id);
                          if (hit?.surface === "native") select(id);
                          else selectExternal(id);
                        }}
                      />
                    ) : null}
                    {external && owner && !results ? (
                      <ExternalSidebar selectedId={externalId} onSelect={selectExternal} />
                    ) : null}
                    {(results || !external) &&
                      (results ? (
                        <>
                          <VirtualList
                            items={results.items}
                            itemKey={(hit) => `${hit.threadId}:${hit.turnId ?? hit.excerpt}`}
                            label="Search results"
                            className="thread-list flex-1"
                            estimate={92}
                            render={(hit) => (
                              <SearchThreadButton
                                id={hit.threadId}
                                title={hit.title}
                                excerpt={hit.excerpt}
                                onSelect={() => {
                                  if (hit.surface === "native") select(hit.threadId);
                                  else {
                                    selectExternal(hit.threadId);
                                  }
                                }}
                              />
                            )}
                          />
                          {results.items.length === 0 && !searching ? (
                            <p className="muted text-muted-foreground empty-list p-4 text-sm">
                              No results
                            </p>
                          ) : null}
                          {results.nextCursor ? (
                            <Button
                              variant="ghost"
                              className="text-primary py-2 px-3 text-sm"
                              disabled={searching}
                              onClick={() => {
                                if (!searching)
                                  void searchResults.fetchNextPage({ cancelRefetch: false });
                              }}
                            >
                              More results
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {!archived ? (
                            <SidebarQueue
                              fallbackThreads={online ? undefined : threads}
                              draftIds={draftIds}
                              viewer={viewer}
                              external={external}
                              models={catalog?.models}
                              onThread={upsert}
                              onSelect={select}
                              onRename={renameSidebarThread}
                              onArchive={archiveSidebarThread}
                              onDelete={setConfirmDelete}
                              onDiscardDraft={discardDraft}
                            />
                          ) : (
                            <VirtualList
                              emptyState={
                                !loadingThreads &&
                                !threadListError &&
                                sidebarThreads.length === 0 ? (
                                  <SidebarEmptyState view="archived" />
                                ) : null
                              }
                              items={sidebarThreads}
                              itemKey={(thread) => thread.id}
                              label="Conversations"
                              scrollFade
                              hasMore={!!nextCursor && !threadListError}
                              loading={loadingThreads}
                              onEndReached={() => {
                                if (nextCursor) void listThreads(archived, nextCursor);
                              }}
                              className="thread-list flex-1"
                              estimate={64}
                              render={(thread) => (
                                <SidebarThread
                                  id={thread.id}
                                  thread={thread.source}
                                  viewer={viewer}
                                  modelLabel={
                                    catalog?.models.find(
                                      (model) => model.id === thread.source?.modelId,
                                    )?.label
                                  }
                                  external={external}
                                  onSelect={select}
                                  onRename={renameSidebarThread}
                                  onArchive={archiveSidebarThread}
                                  onDelete={setConfirmDelete}
                                  onDiscardDraft={discardDraft}
                                />
                              )}
                            />
                          )}
                          {threadListError ? (
                            <Button
                              variant="ghost"
                              onClick={() => void listThreads(archived, nextCursor)}
                            >
                              Retry loading conversations
                            </Button>
                          ) : null}
                        </>
                      ))}
                    {sidebarFooter}
                  </aside>
                </WorkspaceSidePanel>
                <div id="chat" className="chat-panel">
                  <div className="main-panel h-full relative min-w-0 min-h-0 flex flex-col">
                    {reference ? <ThreadReferenceView target={reference} active={active} /> : null}
                    {!reference && external && owner ? (
                      <Suspense fallback={<ExternalSkeleton conversation />}>
                        <External threadId={externalId} />
                      </Suspense>
                    ) : null}
                    {!reference && !external && selectedId && routeDraftExists
                      ? (() => {
                          const thread = selected ?? selectedMetadata.data;
                          const conversationActions = thread ? (
                            <>
                              {owner ? (
                                <IconButton
                                  label="Share conversation"
                                  tooltip="Share"
                                  onClick={() => setSharing(true)}
                                >
                                  <Users />
                                </IconButton>
                              ) : null}
                              {thread.capabilities.edit ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    render={
                                      <IconButton label="Conversation actions" tooltip="Options">
                                        <MoreHorizontal />
                                      </IconButton>
                                    }
                                  />
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                      onClick={() =>
                                        setRename({ id: thread.id, title: thread.title })
                                      }
                                    >
                                      <Pencil />
                                      Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() =>
                                        void update(thread.id, { archived: !thread.archived })
                                      }
                                    >
                                      {thread.archived ? <ArchiveRestore /> : <Archive />}
                                      {thread.archived ? "Unarchive" : "Archive"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => setConfirmDelete(thread.id)}
                                    >
                                      <Trash2 />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </>
                          ) : null;
                          return (
                            <Chat
                              threadId={selectedId}
                              thread={thread}
                              foreground={active}
                              autoFocus={active && !settings && !search.ref && !search.message}
                              catalog={catalog}
                              onError={setError}
                              readTurns={readTurns.current}
                              draft={drafts.current.get(selectedId)}
                              onDraft={(id, value) => drafts.current.set(id, value)}
                              pending={pendingInputs.get(selectedId) ?? []}
                              onPending={patchPending}
                              onLocalChange={changeLocalDraft}
                              onLocalSubmit={(id, submission) => void submitDraft(id, submission)}
                              onRetryLoad={() => {
                                void selectedMetadata.refetch();
                                void client.selectThread(selectedId);
                              }}
                              loadingMessage={
                                selectedMetadata.error?.message ??
                                (!online && !thread
                                  ? "This conversation is unavailable while offline."
                                  : undefined)
                              }
                              header={
                                thread ? (
                                  <header className="thread-header flex items-center gap-2 h-8 min-h-0 px-6 py-0.5 [&_h1]:truncate [&_.icon-button]:size-[var(--ui-control-compact)] max-workspace:gap-1 max-workspace:pl-15 group-[.sidebar-hidden]/workspace:pl-15 group-[.right-panel-hidden]/workspace:pr-[calc(var(--ui-space-unit)*5+var(--ui-control-compact))]">
                                    <h1>{thread.title || "Untitled"}</h1>
                                    {thread.archived ? (
                                      <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
                                        Archived
                                      </span>
                                    ) : null}
                                    <span className="toolbar-spacer flex-1" />
                                    <div className="hidden workspace:flex items-center gap-2">
                                      {conversationActions}
                                    </div>
                                  </header>
                                ) : undefined
                              }
                            />
                          );
                        })()
                      : null}
                    {!reference && !external && !selectedId ? (
                      <div className="welcome">
                        <Button
                          title={
                            newThreadKeys.label
                              ? `New thread (${newThreadKeys.label})`
                              : "New thread"
                          }
                          aria-keyshortcuts={newThreadKeys.aria}
                          onClick={createThread}
                        >
                          <Plus />
                          New conversation
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
                <WorkspaceSidePanel
                  side="right"
                  open={rightOpen}
                  id="right-panel"
                  resizeKey={selectedId}
                  onWidthChange={(width) => panels.getState().resize(selectedId, width)}
                  label="Right panel width"
                >
                  <RightPanel threadId={selectedId ?? ""} foreground={active} />
                </WorkspaceSidePanel>
              </WorkspacePanels>
              {settings ? (
                <Settings
                  viewer={viewer}
                  onClose={() => changeView({ settings: undefined })}
                  tab={settings}
                  onTabChange={(settings) => changeView({ settings })}
                  agent={identities.agent}
                  theme={theme}
                  onTheme={setTheme}
                />
              ) : null}
              {sharing && owner && selected ? (
                <Modal title="Share conversation" onClose={() => setSharing(false)}>
                  <Suspense fallback={<p role="status">Loading people…</p>}>
                    <Sharing key={selected.id} thread={selected} />
                  </Suspense>
                </Modal>
              ) : null}
              <Modal
                open={!!rename}
                title="Rename conversation"
                onClose={() => setRename(undefined)}
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (rename) void update(rename.id, { title: rename.title });
                  }}
                >
                  <Input
                    className="wide-input w-full"
                    autoFocus
                    aria-label="Conversation name"
                    value={rename?.title ?? ""}
                    onChange={(event) => {
                      if (rename) setRename({ ...rename, title: event.target.value });
                    }}
                    maxLength={512}
                  />
                  <div className="dialog-actions flex justify-end gap-2 mt-6">
                    <Button className="gap-2 rounded-sm px-4" type="submit">
                      Rename
                    </Button>
                  </div>
                </form>
              </Modal>
              <Modal
                open={!!confirmDelete}
                title="Delete conversation?"
                onClose={() => setConfirmDelete(undefined)}
              >
                <p>
                  This removes the conversation and makes its files unavailable. Any active run will
                  be canceled.
                </p>
                <div className="dialog-actions flex justify-end gap-2 mt-6">
                  <Button
                    variant="secondary"
                    className="gap-2 rounded-sm px-4"
                    onClick={() => setConfirmDelete(undefined)}
                  >
                    Keep conversation
                  </Button>
                  <Button
                    variant="destructive"
                    className="gap-2 rounded-sm px-4"
                    onClick={() => void deleteThread()}
                  >
                    Delete
                  </Button>
                </div>
              </Modal>
            </main>
          </Tooltip.Provider>
        </NativeSubagentProvider>
      </FileViewerProvider>
    </MessageIdentityContext.Provider>
  );
}
export default App;

function SearchThreadButton({
  id,
  title,
  excerpt,
  onSelect,
}: {
  id: string;
  title: string;
  excerpt: string;
  onSelect: () => void;
}) {
  const shortcut = useThreadShortcut(id);
  return (
    <Button
      type="button"
      variant="ghost"
      className="search-result relative flex w-full gap-1 p-3 text-left rounded-sm h-auto flex-col items-start whitespace-normal"
      aria-keyshortcuts={shortcut.aria}
      onClick={onSelect}
    >
      <strong>{title}</strong>
      <span>{excerpt}</span>
      {shortcut.held && shortcut.label ? (
        <Kbd className="absolute bottom-2 right-2 bg-popover px-2 text-popover-foreground shadow-sm">
          {shortcut.label}
        </Kbd>
      ) : null}
    </Button>
  );
}
