import { lazy, Suspense } from "react";
import { SkeletonRows } from "./ui/skeleton";
import { fileDraftKey } from "../file-editors";
import { FileDocumentEditor } from "./FileDocumentEditor";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
const WorkspaceTree = lazy(() => import("./WorkspaceTree"));
import { ThreadReferenceView } from "./ThreadReferenceView";
import { ConversationIcon } from "./ConversationReference";
import { FileIcon } from "./FileIcon";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { defaultPanelTabs, defaultRightPanel, type PanelTabs, type PanelTab } from "../panel-store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { IconButton } from "./ui";
import { useStore } from "zustand";
import { Bot, Plus, X, Files, Maximize2, Minimize2, Pencil, Eye } from "lucide-react";
import { useOptionalWorkspace, useWorkspace } from "../workspace-context";
import type { FileTarget } from "../file-target";
import { useFileResolution, useFileViewer } from "./file-viewer-context";
import {
  AttachmentPreviewBody,
  ResourcePreview,
  attachmentKind,
  useResourcePreviewText,
} from "./ResourcePreview";
import { FileSource } from "./FileSource";
import { NativeSubagentPanel } from "./SubagentPanel";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import "./file-viewer.css";

export function FileTargetPreview({
  target,
  onClose,
}: {
  target: FileTarget;
  onClose: () => void;
}) {
  const { file, error } = useFileResolution(target);
  const unresolved = error
    ? { status: "error" as const, message: error }
    : { status: "loading" as const };
  return (
    <ResourcePreview
      name={file?.name ?? target.name}
      href={file?.href ?? ""}
      kind={file ? attachmentKind(file.mediaType, file.name) : "text"}
      line={target.line}
      endLine={target.endLine}
      target={file ?? target}
      textState={file ? undefined : unresolved}
      onClose={onClose}
    />
  );
}

export function FilePanelContent({
  target,
  tabId,
  active = true,
}: {
  target: FileTarget;
  tabId?: string;
  active?: boolean;
}) {
  const workspace = useOptionalWorkspace();
  const viewer = useFileViewer();
  const [editing, setEditing] = useState(false);
  const { file, error } = useFileResolution(target, active);
  useEffect(() => {
    if (file && tabId && viewer)
      workspace?.panels.getState().resolveFile(viewer.threadId, tabId, file);
  }, [file, tabId, viewer, workspace]);
  const kind = file ? attachmentKind(file.mediaType, file.name) : "text";
  const loaded = useResourcePreviewText(file?.href ?? "", kind, active);
  const unresolved = error
    ? { status: "error" as const, message: error }
    : { status: "loading" as const };
  const text = file ? loaded : unresolved;
  const path = target.type === "path" ? target.path : (target.path ?? target.name);
  const media = file ? (
    <AttachmentPreviewBody key={file.href} name={file.name} href={file.href} kind={kind} fill />
  ) : null;
  const heading = (
    <Tooltip>
      <TooltipTrigger
        render={<div className="file-panel-heading flex items-center min-w-0 py-2 px-3 text-sm" />}
      >
        <span>{file?.path ?? path}</span>
      </TooltipTrigger>
      <TooltipContent>{file?.path ?? path}</TooltipContent>
    </Tooltip>
  );
  let editablePath: string | undefined;
  if (target.type === "path") editablePath = target.path;
  if (
    target.type === "resource" &&
    tabId?.startsWith("path:") &&
    target.href.startsWith("/api/files/")
  )
    editablePath = target.path;
  const canEdit = !!(editablePath && workspace && viewer);
  const modeToggle = canEdit ? (
    <IconButton
      label={editing ? "View file" : "Edit file"}
      aria-pressed={editing}
      onClick={() => setEditing(!editing)}
    >
      {editing ? <Eye /> : <Pencil />}
    </IconButton>
  ) : null;
  if (kind === "text" && editing && editablePath && viewer)
    return (
      <FileDocumentEditor
        threadId={viewer.threadId}
        path={editablePath}
        target={target}
        active={active}
        heading={heading}
        actions={modeToggle}
      />
    );
  if (kind === "text")
    return (
      <FileSource
        href={file?.href}
        name={file?.name ?? target.name}
        text={text}
        line={target.line}
        endLine={target.endLine}
        navigation={target}
        heading={heading}
        actions={modeToggle}
      />
    );
  return (
    <>
      {heading}
      {media}
    </>
  );
}

export function RightPanel({ threadId, foreground }: { threadId: string; foreground: boolean }) {
  const { panels, fileEditors } = useWorkspace();
  const dirty = useStore(fileEditors, (state) => state.dirty);
  const [closing, setClosing] = useState<string>();
  const tabs = useStore(panels, (state) => state.tabs.get(threadId) ?? defaultPanelTabs);
  const open = useStore(panels, (state) => (state.threads.get(threadId) ?? defaultRightPanel).open);
  const visible = foreground && open;
  const actions = panels.getState();
  function draftKey(id: string) {
    const tab = tabs.items.find((item) => item.id === id);
    return tab?.type === "file" && tab.target.path
      ? fileDraftKey(threadId, tab.target.path)
      : undefined;
  }
  function closeTab(id: string) {
    const key = draftKey(id);
    if (key) fileEditors.getState().discard(key);
    actions.closeTab(threadId, id);
    setClosing(undefined);
  }
  return (
    <>
      <RightPanelTabs
        key={threadId}
        visible={visible}
        tabs={tabs}
        dirtyIds={
          new Set(
            tabs.items
              .filter((tab) => {
                const key = draftKey(tab.id);
                return key && dirty.has(key);
              })
              .map((tab) => tab.id),
          )
        }
        onFocus={(id) => actions.focusTab(threadId, id)}
        onClose={(id) => {
          const key = draftKey(id);
          if (key && dirty.has(key)) {
            setClosing(id);
            return;
          }
          closeTab(id);
        }}
        onAgents={() => actions.openAgents(threadId)}
        onFiles={() => actions.openFiles(threadId)}
        expandedSidebar={
          <Suspense fallback={<SkeletonRows label="Loading files" rows={8} />}>
            <WorkspaceTree threadId={threadId} active={visible} />
          </Suspense>
        }
        renderTab={(tab, active) => {
          if (tab.type === "agents")
            return (
              <NativeSubagentPanel threadId={threadId} foreground={foreground && active} embedded />
            );
          if (tab.type === "thread")
            return <ThreadReferenceView target={tab.target} active={visible && active} panel />;
          if (tab.type === "files")
            return (
              <Suspense fallback={<SkeletonRows label="Loading files" rows={8} />}>
                <WorkspaceTree threadId={threadId} active={visible && active} />
              </Suspense>
            );
          return <FilePanelContent target={tab.target} tabId={tab.id} active={visible && active} />;
        }}
      />
      <Dialog
        open={!!closing}
        onOpenChange={(open) => {
          if (!open) setClosing(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Discard unsaved edits?</DialogTitle>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setClosing(undefined)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (closing) closeTab(closing);
              }}
            >
              Discard and close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RightPanelTabs({
  tabs,
  onFocus,
  onClose,
  onAgents,
  onFiles,
  renderTab,
  visible = true,
  dirtyIds,
  expandedSidebar,
}: {
  tabs: PanelTabs;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onAgents: () => void;
  onFiles?: () => void;
  renderTab: (tab: PanelTab, active: boolean) => ReactNode;
  visible?: boolean;
  dirtyIds?: ReadonlySet<string>;
  expandedSidebar?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  if (expanded && !visible) setExpanded(false);
  function tabName(tab: PanelTab) {
    if (tab.type === "agents") return "Agents";
    if (tab.type === "files") return "Files";
    return tab.type === "thread" ? tab.title : tab.target.name;
  }
  useLayoutEffect(() => {
    const viewport = list.current;
    const active = viewport?.querySelector<HTMLElement>('[role="tab"][data-active]');
    if (!viewport || !active) return;
    const bounds = viewport.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    if (target.right > bounds.right) viewport.scrollLeft += target.right - bounds.right;
    else if (target.left < bounds.left) viewport.scrollLeft += target.left - bounds.left;
  }, [tabs.activeId, tabs.items.length]);
  useEffect(() => {
    if (!expanded) return;
    const collapse = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false);
    };
    const narrow = window.matchMedia("(width < 47.5rem)");
    const collapseWhenNarrow = () => {
      if (narrow.matches) setExpanded(false);
    };
    collapseWhenNarrow();
    window.addEventListener("keydown", collapse);
    narrow.addEventListener("change", collapseWhenNarrow);
    return () => {
      window.removeEventListener("keydown", collapse);
      narrow.removeEventListener("change", collapseWhenNarrow);
    };
  }, [expanded]);
  const activeType = tabs.items.find((tab) => tab.id === tabs.activeId)?.type;
  const sidebar = expanded && expandedSidebar && activeType !== "files";
  return (
    <>
      {expanded ? (
        <div
          className="file-panel-backdrop fixed inset-0 z-50 bg-overlay supports-backdrop-filter:backdrop-blur-xs"
          aria-hidden
          onClick={() => setExpanded(false)}
        />
      ) : null}
      <aside
        className={`file-panel flex flex-col min-w-0 min-h-0 bg-sidebar text-sidebar-foreground ${expanded ? "fixed inset-4 z-50 rounded-lg shadow-lg overflow-hidden" : "h-full"}`}
        aria-label="Right panel"
        data-expanded={expanded}
      >
        <Tabs
          value={tabs.activeId ?? null}
          onValueChange={(value) => {
            if (typeof value === "string") onFocus(value);
          }}
          className="file-panel-tabs-root"
        >
          <div
            className={`file-panel-tab-bar flex items-center gap-1 flex-none pl-2 ${expanded ? "h-10 pr-2" : "h-[var(--ui-header-height)] pr-[calc(calc(var(--ui-space-unit)*3)_+_var(--ui-control-compact)_+_calc(var(--ui-space-unit)*2))]"}`}
          >
            <TabsList
              ref={list}
              className="file-panel-tabs flex justify-start overflow-x-auto overflow-y-hidden [flex:0_1_auto] w-auto min-w-0 p-0 gap-1 bg-transparent [scrollbar-width:none]"
              aria-label="Right panel tabs"
            >
              {tabs.items.map((tab) => (
                <div className="file-panel-tab relative flex flex-none max-w-48" key={tab.id}>
                  <TabsTrigger value={tab.id}>
                    {tab.type === "agents" ? <Bot /> : null}
                    {tab.type === "files" ? <Files /> : null}
                    {tab.type === "thread" ? (
                      <ConversationIcon surface={tab.target.surface} />
                    ) : null}
                    {tab.type === "file" ? (
                      <FileIcon
                        name={tab.target.name}
                        mediaType={
                          tab.target.type === "resource" ? tab.target.mediaType : undefined
                        }
                      />
                    ) : null}
                    <span>
                      {tabName(tab)}
                      {dirtyIds?.has(tab.id) ? <span aria-label="Unsaved edits"> •</span> : null}
                    </span>
                  </TabsTrigger>
                  <IconButton
                    className="file-tab-close"
                    label={`Close ${tabName(tab)}`}
                    onClick={() => onClose(tab.id)}
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
            </TabsList>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton label="Add tab" />}>
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={onAgents}>
                  <Bot />
                  Agents
                </DropdownMenuItem>
                {onFiles ? (
                  <DropdownMenuItem onClick={onFiles}>
                    <Files />
                    Files
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="flex-1" />
            <IconButton
              className="max-workspace:hidden"
              label={expanded ? "Restore panel" : "Expand panel"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          </div>
          <div className="flex flex-1 min-h-0 min-w-0">
            {sidebar ? (
              <div className="file-panel-tree flex flex-none w-64 min-h-0 border-r border-border">
                {expandedSidebar}
              </div>
            ) : null}
            <div className="file-panel-tab-content">
              {tabs.items.map((tab) => (
                <TabsContent
                  key={tab.id}
                  value={tab.id}
                  keepMounted
                  className="file-panel-tab-page"
                >
                  <VisitedTabContent active={visible && tabs.activeId === tab.id}>
                    {renderTab(tab, tabs.activeId === tab.id)}
                  </VisitedTabContent>
                </TabsContent>
              ))}
              {!tabs.items.length ? (
                <div className="file-status grid place-content-center flex-1 p-4 text-sm text-muted-foreground">
                  <Button variant="ghost" onClick={onAgents}>
                    <Bot />
                    Open Agents
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </Tabs>
      </aside>
    </>
  );
}

function VisitedTabContent({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return active || visited ? children : null;
}
