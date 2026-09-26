import {
  conversationReferenceSchema,
  referenceKey,
  type ConversationReference,
} from "@stanley2058/lilac-client-protocol";
import type { FileTarget } from "./file-target";
import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import { z } from "zod";
import type { CacheScope } from "@stanley2058/lilac-client";

export const panelSizes = {
  left: { initial: 288, min: 192, max: 512 },
  right: { initial: 360, min: 240, max: 640 },
};
type PanelLayout = { open: boolean; width: number };
export const defaultRightPanel: PanelLayout = { open: false, width: panelSizes.right.initial };
const defaultSidebar: PanelLayout = { open: true, width: panelSizes.left.initial };
const layoutSchema = (side: keyof typeof panelSizes) =>
  z
    .object({
      open: z.boolean(),
      width: z.number().int().min(panelSizes[side].min).max(panelSizes[side].max),
    })
    .strict();
const fileTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("path"),
      path: z.string(),
      name: z.string(),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      href: z.string(),
      name: z.string(),
      mediaType: z.string(),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      resourceId: z.string().optional(),
    })
    .strict(),
]);
const tabsSchema = z
  .object({
    items: z.array(
      z.discriminatedUnion("type", [
        z
          .object({
            id: z.string(),
            type: z.literal("thread"),
            target: conversationReferenceSchema,
            title: z.string(),
          })
          .strict(),
        z.object({ id: z.literal("agents"), type: z.literal("agents") }).strict(),
        z.object({ id: z.string(), type: z.literal("file"), target: fileTargetSchema }).strict(),
      ]),
    ),
    activeId: z.string().optional(),
  })
  .strict()
  .refine(
    (tabs) =>
      new Set(tabs.items.map((tab) => tab.id)).size === tabs.items.length &&
      (tabs.items.length === 0
        ? tabs.activeId === undefined
        : tabs.items.some((tab) => tab.id === tabs.activeId)),
  );
const storedPanelsSchema = z
  .object({
    sidebar: layoutSchema("left"),
    threads: z.array(z.tuple([z.string(), layoutSchema("right")])),
    tabs: z.unknown().optional(),
  })
  .strict();
type PanelLayouts = {
  sidebar: PanelLayout;
  threads: Map<string, PanelLayout>;
  tabs: Map<string, PanelTabs>;
};
export type PanelTab =
  | { id: string; type: "thread"; target: ConversationReference; title: string }
  | { id: string; type: "agents" }
  | { id: string; type: "file"; target: FileTarget };
export type PanelTabs = { items: PanelTab[]; activeId?: string };
export const defaultPanelTabs: PanelTabs = {
  items: [{ id: "agents", type: "agents" }],
  activeId: "agents",
};
function fileKey(target: FileTarget): string {
  if (target.type === "path") return `path:${target.path}`;
  if (target.path) return `path:${target.path}`;
  const resourceId = /^\/api\/resources\/([^/?#]+)$/.exec(target.href)?.[1];
  return `resource:${target.resourceId ?? resourceId ?? target.href}`;
}
function sameFile(left: FileTarget, right: FileTarget): boolean {
  if (fileKey(left) === fileKey(right)) return true;
  return left.type === "resource" && right.type === "resource" && left.href === right.href;
}
function navigateFile(current: FileTarget, requested: FileTarget): FileTarget {
  if (current.type !== "resource") return requested;
  if (requested.type === "path")
    return { ...current, line: requested.line, endLine: requested.endLine };
  return {
    ...requested,
    path: requested.path ?? current.path,
    resourceId: requested.resourceId ?? current.resourceId,
    mediaType:
      requested.mediaType === "application/octet-stream" ? current.mediaType : requested.mediaType,
  };
}
type PanelStore = PanelLayouts & {
  openThread: (
    threadId: string,
    target: ConversationReference,
    title: string,
    conversationThreadId?: string,
  ) => void;
  openAgents: (threadId: string) => void;
  focusTab: (threadId: string, id: string) => void;
  closeTab: (threadId: string, id: string) => void;
  resolveFile: (threadId: string, id: string, target: FileTarget) => void;
  openFile: (threadId: string, target: FileTarget) => void;
  selection?: { threadId: string; agentId: string };
  toggleSidebar: () => void;
  resizeSidebar: (width: number) => void;
  toggle: (threadId: string) => void;
  resize: (threadId: string, width: number) => void;
  select: (threadId: string, agentId: string) => void;
  back: () => void;
  moveThread: (from: string, to: string) => void;
};

function decodePanelLayouts(value: unknown): PanelLayouts | undefined {
  const decoded = storedPanelsSchema.safeParse(value);
  if (!decoded.success) return undefined;
  const tabs = z.array(z.tuple([z.string(), tabsSchema])).safeParse(decoded.data.tabs);
  return {
    sidebar: decoded.data.sidebar,
    threads: new Map(decoded.data.threads),
    tabs: new Map(tabs.success ? tabs.data : []),
  };
}

export function createPanelStore(
  scope?: Pick<CacheScope, "installationId" | "principalId">,
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  const key = scope
    ? `lilac-panels-v1:${JSON.stringify([scope.installationId, scope.principalId])}`
    : undefined;
  const defaults: PanelLayouts = { sidebar: defaultSidebar, threads: new Map(), tabs: new Map() };
  const initial = key
    ? Result.try({
        try: (): unknown => {
          const raw = (storage ?? localStorage).getItem(key);
          return raw ? JSON.parse(raw) : null;
        },
        catch: () => "Storage unavailable",
      }).match({
        ok: (value) => decodePanelLayouts(value) ?? defaults,
        err: () => defaults,
      })
    : defaults;

  function save(layouts: PanelLayouts) {
    if (!key) return;
    Result.try({
      try: () =>
        (storage ?? localStorage).setItem(
          key,
          JSON.stringify({
            sidebar: layouts.sidebar,
            threads: [...layouts.threads],
            tabs: [...layouts.tabs],
          }),
        ),
      catch: () => "Storage unavailable",
    }).match({ ok: () => {}, err: () => {} });
  }

  return createStore<PanelStore>((set, get) => {
    function updateRight(threadId: string, change: Partial<PanelLayout>) {
      const current = get().threads.get(threadId) ?? defaultRightPanel;
      const next = { ...current, ...change };
      if (next.open === current.open && next.width === current.width) return;
      const threads = new Map(get().threads);
      threads.set(threadId, next);
      set({ threads });
      save(get());
    }
    function updateSidebar(change: Partial<PanelLayout>) {
      set({ sidebar: { ...get().sidebar, ...change } });
      save(get());
    }
    function updateTabs(threadId: string, value: PanelTabs) {
      const tabs = new Map(get().tabs);
      tabs.set(threadId, value);
      set({ tabs });
      save(get());
    }
    function openAgents(threadId: string) {
      const current = get().tabs.get(threadId) ?? defaultPanelTabs;
      const items = current.items.some((tab) => tab.type === "agents")
        ? current.items
        : [...current.items, { id: "agents", type: "agents" as const }];
      updateTabs(threadId, { items, activeId: "agents" });
      updateRight(threadId, { open: true });
    }
    return {
      ...initial,
      openThread: (threadId, target, title, conversationThreadId) => {
        const current = get().tabs.get(threadId) ?? defaultPanelTabs;
        const conversation =
          target.surface === "native"
            ? target.sessionId
            : (conversationThreadId ?? target.messageId ?? "session");
        const range = target.range
          ? `:range:${target.range.startMessageId}..${target.range.endMessageId}`
          : "";
        const id = `thread:${referenceKey(target)}:${conversation}${range}`;
        const tab: PanelTab = { id, type: "thread", target, title };
        const items = current.items.some((item) => item.id === id)
          ? current.items.map((item) => (item.id === id ? tab : item))
          : [...current.items, tab];
        updateTabs(threadId, { items, activeId: id });
        updateRight(threadId, { open: true });
      },
      openAgents,
      focusTab: (threadId, id) => {
        const current = get().tabs.get(threadId) ?? defaultPanelTabs;
        if (current.activeId === id || !current.items.some((tab) => tab.id === id)) return;
        updateTabs(threadId, { ...current, activeId: id });
      },
      closeTab: (threadId, id) => {
        const current = get().tabs.get(threadId) ?? defaultPanelTabs;
        const index = current.items.findIndex((tab) => tab.id === id);
        if (index < 0) return;
        const items = current.items.filter((tab) => tab.id !== id);
        const activeId =
          current.activeId === id ? items[Math.min(index, items.length - 1)]?.id : current.activeId;
        updateTabs(threadId, { items, activeId });
      },
      resolveFile: (threadId, id, target) => {
        const current = get().tabs.get(threadId);
        const tab = current?.items.find((tab) => tab.id === id);
        if (!current || tab?.type !== "file" || tab.target.type === "resource") return;
        const duplicate = current.items.find(
          (item) => item.type === "file" && item.id !== id && sameFile(item.target, target),
        );
        if (duplicate) {
          updateTabs(threadId, {
            items: current.items
              .filter((item) => item.id !== id)
              .map((item) =>
                item.id === duplicate.id ? { id: item.id, type: "file", target } : item,
              ),
            activeId: current.activeId === id ? duplicate.id : current.activeId,
          });
          return;
        }
        updateTabs(threadId, {
          ...current,
          items: current.items.map((item) =>
            item.id === id ? { id, type: "file", target } : item,
          ),
        });
      },
      openFile: (threadId, target) => {
        const current = get().tabs.get(threadId) ?? defaultPanelTabs;
        const key = fileKey(target);
        const existing = current.items.find(
          (tab) => tab.type === "file" && sameFile(tab.target, target),
        );
        const tab: PanelTab = {
          id: existing?.id ?? key,
          type: "file",
          target: existing?.type === "file" ? navigateFile(existing.target, target) : { ...target },
        };
        const items = existing
          ? current.items.map((item) => (item.id === existing.id ? tab : item))
          : [...current.items, tab];
        updateTabs(threadId, { items, activeId: tab.id });
        updateRight(threadId, { open: true });
      },
      toggleSidebar: () => updateSidebar({ open: !get().sidebar.open }),
      resizeSidebar: (width) => updateSidebar({ width }),
      toggle: (threadId) =>
        updateRight(threadId, { open: !(get().threads.get(threadId) ?? defaultRightPanel).open }),
      resize: (threadId, width) => updateRight(threadId, { width }),
      select: (threadId, agentId) => {
        openAgents(threadId);
        set({ selection: { threadId, agentId } });
        updateRight(threadId, { open: true });
      },
      back: () => set({ selection: undefined }),
      moveThread: (from, to) => {
        const layout = get().threads.get(from);
        if (!layout) return;
        const threads = new Map(get().threads);
        threads.delete(from);
        threads.set(to, layout);
        const tabs = new Map(get().tabs);
        const previous = tabs.get(from);
        tabs.delete(from);
        if (previous) tabs.set(to, previous);
        set({ threads, tabs });
        save(get());
      },
    };
  });
}
