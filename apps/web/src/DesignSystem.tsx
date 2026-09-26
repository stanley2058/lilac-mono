import { AgentAvatar } from "./components/AgentAvatar";
import { FloatingChatMenu } from "./components/FloatingChatMenu";
import { useAppShortcuts, useThreadTargets } from "./shortcuts";
import { KeybindingsSettings } from "./components/KeybindingsSettings";
import { createKeybindings } from "./keybindings";
import { ConversationContext, CopyReferenceButton } from "./components/ConversationReference";
import { Switch } from "./components/ui/switch";
import { NotificationSettings } from "./components/NotificationSettings";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { createNotificationPreferences } from "./notifications";
import { SPINNERS } from "loading-dev";
import { LoadingSpinner } from "./components/ui/loading-spinner";
import { ConnectionLoading } from "./components/ui/connection-loading";
import { ReconnectionDemo } from "./components/ReconnectionDemo";
import { ConversationBadge } from "./components/ConversationReference";
import lilacLogo from "./assets/logo.svg";
import { LinkPreviewAnchor } from "./components/LinkWithFavicon";
import { SidebarEmptyState } from "./components/SidebarEmptyState";
import { setThemeMode } from "./theme/theme";
import { clerkAppearance } from "./theme/clerk";
import { FileIcon } from "./components/FileIcon";
import { useStore } from "zustand";
import { createPanelStore, defaultPanelTabs } from "./panel-store";
import { RightPanelTabs } from "./components/FileViewer";
import { FileSource } from "./components/FileSource";
import { Link, useLocation } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import logo from "./assets/logo.svg";
import motion from "./assets/design-system/motion.mp4";
import tone from "./assets/design-system/tone.wav";
import weekendPdf from "./assets/design-system/weekend.pdf";
import type { Attachment } from "./types";
import { AttachmentPreviewBody, ReadyAttachment } from "./components/ResourcePreview";
import { MessageIdentityContext } from "./components/message-identity";
import { toast } from "./components/ui/toast";
import { showAppUpdateToast } from "./app-update-toast";
import { IconButton, Modal, VirtualList } from "./components/ui";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./components/ui/avatar";
import { Bubble, BubbleContent } from "./components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "./components/ui/marker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { TooltipProvider } from "./components/ui/tooltip";
import { Markdown } from "./components/Markdown";
import { Composer } from "./components/Composer";
import { Message, ThinkingIndicator } from "./components/Timeline";
import { ThreadQueueDemo } from "./components/ThreadQueueDemo";
import { DeploymentSettingsForm } from "./components/DeploymentSettings";
import { AgentWorkDemo } from "./components/AgentWorkDemo";
import { SidebarSearch } from "./components/SidebarSearch";
import { AgentDiscordLink } from "./components/AgentIdentity";
import { ExternalMessages } from "./components/ExternalMessages";
import { ExternalSkeleton } from "./components/ExternalSidebar";
import { ThreadCard } from "./components/ThreadSelect";
import "./design-system.css";

const sections = [
  ["foundations", "Foundations"],
  ["threads", "Threads"],
  ["messages", "Messages"],
  ["agent-work", "Agent work"],
  ["appearance", "Appearance"],
  ["notifications", "Notifications"],
  ["keybindings", "Keybindings"],
  ["deployment", "Deployment settings"],
  ["composer", "Composer"],
  ["reconnection", "Reconnection"],
  ["attachments", "Attachments"],
  ["content", "Rich content"],
  ["controls", "Controls"],
  ["overlays", "Overlays"],
  ["layout", "Layout"],
] as const;
const now = new Date("2026-09-19T09:00:00Z").getTime();
const threadStates = [
  { state: "idle", label: "Idle", title: "Weekend reading list" },
  { state: "completed", label: "Completed · unread", title: "A few places to visit in Kyoto" },
  { state: "working", label: "Working", title: "Compare the two proposals" },
  { state: "error", label: "Error", title: "Find the missing receipt" },
  { state: "input", label: "Needs input · preview only", title: "Which date works for everyone?" },
] as const;
const swatches = [
  ["Canvas", "background", "foreground"],
  ["Sidebar", "sidebar", "sidebar-foreground"],
  ["Raised", "surface-raised", "surface-raised-foreground"],
  ["Primary", "primary", "primary-foreground"],
  ["Secondary", "secondary", "secondary-foreground"],
  ["Input", "input-background", "input-foreground"],
  ["Hover", "surface-hover", "hover-foreground"],
  ["Selection", "selection", "selection-foreground"],
  ["Menu", "menu", "menu-foreground"],
  ["Menu selection", "menu-selection", "menu-selection-foreground"],
  ["Link", "background", "link"],
  ["Disabled", "background", "disabled"],
  ["Info", "background", "info"],
  ["Warning / draft", "background", "warning"],
  ["Danger", "background", "danger"],
  ["Success", "background", "success"],
] as const;
const spacings = [1, 2, 3, 4, 6, 8, 12];
const noop = () => {};
const markdownAttachment = [
  "#### A quiet weekend",
  "Start with **coffee by the river**, then browse the bookstore. Leave enough time to explore the neighborhood and find somewhere to read before heading home.",
  "- Bring a book to swap\n- Leave the afternoon free",
  "https://example.com/" + "a-long-path-without-breaks".repeat(8),
  "```text\n" + "A long code line should wrap within the preview. ".repeat(8) + "\n```",
  "| Plan | Details |\n| --- | --- |\n| Morning | " + "CoffeeAndBooks".repeat(12) + " |",
].join("\n\n");
const identities = {
  viewerId: "alex",
  agent: { displayName: "Lilac", avatarUrl: logo },
  users: new Map([
    ["alex", { displayName: "Alex Chen" }],
    ["morgan", { displayName: "Morgan Lee" }],
  ]),
};
const messageFixtures: DisplayMessage[] = [
  {
    id: "gallery-user",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 60_000 },
    parts: [
      {
        type: "text",
        text: "Can you help me plan a quiet weekend? Somewhere with good coffee and a bookstore.",
      },
    ],
  },
  {
    id: "gallery-participant",
    role: "user",
    metadata: { authorId: "morgan", createdAt: now - 30_000 },
    parts: [{ type: "text", text: "The riverside sounds good. I'll bring a book to swap." }],
  },
  {
    id: "gallery-user-attachment",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 15_000 },
    parts: [
      {
        type: "text",
        text: "Use [lilac.svg](/api/resources/gallery-shared-image) for the cover. Keep the plan short enough to share.",
      },
      {
        type: "data-resource",
        id: "gallery-shared-image",
        data: {
          resourceId: "gallery-shared-image",
          name: "lilac.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-cover-image",
        data: {
          resourceId: "gallery-cover-image",
          name: "cover-option.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-detail-image",
        data: {
          resourceId: "gallery-detail-image",
          name: "detail.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-shared-pdf",
        data: {
          resourceId: "gallery-shared-pdf",
          name: "Weekend_travel_itinerary_and_reservations_2026.pdf",
          mediaType: "application/pdf",
          size: 728,
          state: "ready",
        },
      },
    ],
  },
  {
    id: "gallery-long-user",
    role: "user",
    metadata: { authorId: "alex", createdAt: now - 10_000 },
    parts: [
      {
        type: "text",
        text: Array.from(
          { length: 14 },
          () =>
            `Leave room for a riverside walk, a bookstore visit, and an unhurried coffee. Keep the afternoon flexible so everyone can choose their own pace.`,
        ).join("\n\n"),
      },
    ],
  },
  {
    id: "gallery-agent",
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: now },
    parts: [
      {
        type: "text",
        text: "Start with the riverside walk, then stop at **Chapter House** for coffee. The bookstore next door stays open until six.\n\nLeave the afternoon free. You won't need reservations.\n\nSave `weekend.md` and check [the itinerary](/tmp/weekend.md) or [meeting-room](/?ref=discord:meeting-room&message=demo).",
      },
    ],
  },
  {
    id: "gallery-work",
    role: "assistant",
    metadata: { createdAt: now },
    parts: [
      {
        type: "data-activity",
        id: "gallery-think",
        data: {
          kind: "thinking",
          label: "Thinking",
          state: "complete",
          detail: "Comparing opening hours and walking distances.",
          durationMs: 2100,
        },
      },
      {
        type: "data-activity",
        id: "gallery-search",
        data: {
          kind: "tool",
          label: "Searched nearby places",
          state: "complete",
          detail: "Found three cafés and two independent bookstores.",
          durationMs: 900,
        },
      },
      {
        type: "text",
        text: "The café opens earlier than the bookstore, so that order works well.",
      },
    ],
  },
  {
    id: "gallery-files",
    role: "assistant",
    parts: [
      {
        type: "data-resource",
        id: "gallery-logo",
        data: {
          resourceId: "gallery-logo",
          name: "lilac.svg",
          mediaType: "image/svg+xml",
          size: 2400,
          state: "ready",
        },
      },
      {
        type: "data-resource",
        id: "gallery-upload",
        data: {
          resourceId: "gallery-upload",
          name: "weekend-notes.txt",
          mediaType: "text/plain",
          size: 48000,
          state: "pending",
          progress: 0.6,
        },
      },
      {
        type: "data-resource",
        id: "gallery-failed",
        data: {
          resourceId: "gallery-failed",
          name: "map.pdf",
          mediaType: "application/pdf",
          size: 340000,
          state: "failed",
          error: "Upload interrupted",
        },
      },
    ],
  },
];
const richText =
  '### A small plan\n\nUse **bold**, *italic*, ~~strikethrough~~, and `inline code`. Links include a favicon: [GitHub](https://github.com).\n\n> Leave enough room to change your mind.\n\n- [x] Pick a place\n- [ ] Check the weather\n\n| Time | Plan |\n| --- | --- |\n| Morning | Coffee and a walk |\n| Afternoon | Bookstore |\n\n```typescript\nconst weekend = { pace: "slow", reservations: false };\nconsole.log("There is time to stop and explore", weekend);\n```\n\n```bash\nbun run dev:web\n```\n\nCurrency stays prose: your $10 suggestion makes sense over $7.\n\n**注意：**粗體與~~刪除線：~~在全形標點後也能正確結束。\n\nInline math: $a^2 + b^2 = c^2$.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n```mermaid\nflowchart LR\n  Coffee --> Walk --> Bookstore\n```';

const tableExample = [
  "| Restaurant | Location | Budget per person | Why consider it |",
  "| --- | --- | ---: | --- |",
  "| **時時香 SHANN Rice Bar** | Main building **9F** | **NT$600–850** | **Good for a mixed group.** Taiwanese, Sichuan and Cantonese sharing dishes let everyone order a varied spread. Some dishes are spicy, but the whole meal does not need to be. |",
  "| Garden Kitchen | Station **2F** | NT$400–600 | Set meals, vegetarian options, and plenty of room for six people. |",
].join("\n");

const alertExamples = [
  "> [!NOTE]\n> Keep useful context close to the conversation.",
  "> [!TIP]\n> Use **Shift + Enter** to add a new line.",
  "> [!IMPORTANT]\n> Save your work before starting the next step.",
  "> [!WARNING]\n> Check the destination before moving files.",
  "> [!CAUTION]\n> Deleting this file cannot be undone.",
].join("\n\n");

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ds-section py-8 scroll-mt-6" aria-labelledby={`${id}-title`}>
      <header className="ds-section-heading mb-6">
        <h2 id={`${id}-title`}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
function Specimen({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ds-specimen min-w-0 py-4 ${className}`}>
      <h3>{title}</h3>
      <div className="ds-specimen-body">{children}</div>
    </div>
  );
}
function DemoThreadActions({ onAction }: { onAction: (label: string) => void }) {
  return (
    <>
      <IconButton
        label="Settle conversation"
        tooltip="Settle"
        onClick={() => onAction("Settle selected")}
      >
        <Check />
      </IconButton>
      <IconButton
        label="Rename conversation"
        tooltip="Rename"
        onClick={() => onAction("Rename selected")}
      >
        <Pencil />
      </IconButton>
    </>
  );
}
function Foundations() {
  return (
    <Section id="foundations" title="Foundations">
      <div className="ds-swatches grid [grid-template-columns:repeat(3,_minmax(0,_1fr))] gap-3">
        {swatches.map(([label, background, foreground]) => (
          <div key={label} className="flex flex-col gap-2 text-xs min-w-0">
            <span
              className="flex items-center h-12 rounded-md px-3 border border-border"
              style={{ background: `var(--ui-${background})`, color: `var(--ui-${foreground})` }}
            >
              {label}
            </span>
            <code className="wrap-anywhere">
              {background} / {foreground}
            </code>
          </div>
        ))}
      </div>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Type">
          <div className="ds-type flex flex-col gap-3">
            <span className="ds-type-2xl text-2xl">A little room to think</span>
            <span className="ds-type-lg text-lg">Conversation title</span>
            <span>Body text and message content</span>
            <span className="ds-type-sm text-sm text-muted-foreground">Supporting details</span>
            <span className="ds-type-xs text-xs text-muted-foreground">
              Metadata and timestamps
            </span>
          </div>
        </Specimen>
        <Specimen title="Spacing & corners">
          <div className="ds-spacing flex flex-wrap items-start gap-3">
            {spacings.map((space) => (
              <div key={space}>
                <code>{space}</code>
                <span
                  className="block h-4 bg-primary rounded-sm"
                  style={{ width: `calc(var(--ui-space-unit) * ${space})` }}
                />
              </div>
            ))}
          </div>
          <div className="ds-row flex items-center flex-wrap gap-2">
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-sm rounded-sm">
              sm
            </span>
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-md rounded-md">
              md
            </span>
            <span className="ds-radius p-3 bg-surface-raised text-xs ds-radius-lg rounded-lg">
              lg
            </span>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
function Threads() {
  const [selected, setSelected] = useState("working");
  const [action, setAction] = useState("");
  useThreadTargets(
    threadStates.map(({ state }) => state),
    setSelected,
  );
  useAppShortcuts({
    enabled: true,
    blocked: false,
    newThread: noop,
    settings: noop,
    sidebar: noop,
    rightPanel: noop,
  });
  return (
    <Section
      id="threads"
      title="Threads"
      description="Hover or focus a row to inspect its actions. Hold Ctrl or ⌘ to reveal thread shortcuts."
    >
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <div className="ds-thread-list flex flex-col gap-6 p-3 bg-surface rounded-lg">
          {threadStates.map(({ state, label, title }, index) => (
            <div key={state}>
              <h3 className="ds-state-label">{label}</h3>
              <ThreadCard
                shortcutId={state}
                title={title}
                starterName={index % 2 ? "Morgan Lee" : "Alex Chen"}
                updatedAt={now - index * 3_600_000}
                now={now}
                state={state}
                selected={selected === state}
                onSelect={() => setSelected(state)}
                actions={<DemoThreadActions onAction={setAction} />}
              />
            </div>
          ))}
        </div>
        <Specimen title="Other conversations">
          <ThreadCard
            title="Calendar Enums"
            starterName="Discord"
            updatedAt={now}
            now={now}
            state="idle"
            selected
            onSelect={() => {}}
          />
          <ExternalSkeleton />
          <ExternalSkeleton conversation />
        </Specimen>
        <Specimen title="Discord conversation">
          <ConversationContext value={{ surface: "discord", sessionId: "preview-channel" }}>
            <div className="h-80 flex flex-col">
              <div className="flex items-center justify-end gap-2 px-6">
                <CopyReferenceButton
                  label="Copy conversation link"
                  target={{ surface: "discord", sessionId: "preview-channel" }}
                />
                <IconButton
                  label="Refresh conversation"
                  onClick={() => toast.add({ title: "Conversation refreshed" })}
                >
                  <RefreshCw />
                </IconButton>
              </div>
              <ExternalMessages
                messages={[
                  {
                    id: "discord-preview-1",
                    role: "user",
                    metadata: {
                      externalRunId: "preview-thread-1",
                      authorDisplayName: "Stanley (Discord)",
                      createdAt: now - 60_000,
                    },
                    parts: [{ type: "text", text: "Can we meet in the afternoon?" }],
                  },
                  {
                    id: "discord-preview-2",
                    role: "assistant",
                    metadata: {
                      externalRunId: "preview-thread-1",
                      authorDisplayName: "Lilac (Discord)",
                      createdAt: now - 60_000,
                    },
                    parts: [{ type: "text", text: "Yes, the afternoon works." }],
                  },
                  {
                    id: "discord-preview-followup-user",
                    role: "user",
                    metadata: {
                      externalRunId: "preview-thread-1",
                      authorDisplayName: "Stanley (Discord)",
                      createdAt: now - 30_000,
                    },
                    parts: [{ type: "text", text: "Does three o'clock work?" }],
                  },
                  {
                    id: "discord-preview-followup-assistant",
                    role: "assistant",
                    metadata: {
                      externalRunId: "preview-thread-1",
                      authorDisplayName: "Lilac (Discord)",
                      createdAt: now - 30_000,
                    },
                    parts: [{ type: "text", text: "Yes, see you at three." }],
                  },
                  {
                    id: "discord-preview-3",
                    role: "user",
                    metadata: {
                      externalRunId: "preview-thread-2",
                      authorDisplayName: "Stanley (Discord)",
                      createdAt: now,
                    },
                    parts: [
                      { type: "text", text: "Here is the agenda." },
                      {
                        type: "data-resource",
                        id: "missing-external-image",
                        data: {
                          resourceId: "missing-external-image",
                          name: "agenda.png",
                          mediaType: "image/png",
                          size: 1024,
                          state: "ready",
                        },
                      },
                    ],
                  },
                  {
                    id: "discord-preview-4",
                    role: "assistant",
                    metadata: {
                      externalRunId: "preview-thread-2",
                      authorDisplayName: "Lilac (Discord)",
                      createdAt: now,
                    },
                    parts: [
                      {
                        type: "text",
                        text: "I'll review it before the meeting. This reply appears as one assistant message even when Discord splits it.",
                      },
                    ],
                  },
                ]}
                resourceUrl={(id) => id}
                loadDirection="start"
                hasMore={false}
                loading={false}
                onLoadMore={noop}
              />
            </div>
          </ConversationContext>
        </Specimen>
        <Specimen title="Empty conversation lists">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["default", "archived", "others"] as const).map((view) => (
              <div key={view} className="h-64 bg-sidebar rounded-lg">
                <SidebarEmptyState view={view} />
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen title="Personal queues">
          <ThreadQueueDemo />
          <p className="ds-muted">
            Drag conversations to reorder, pin, or settle them. Changes affect this preview only.
          </p>
        </Specimen>
        <Specimen title="Thread details">
          <div className="thread-details flex flex-col gap-2 text-sm wrap-anywhere">
            <strong>Compare the two proposals</strong>
            <span>Started by Alex Chen</span>
            <span>Last active today at 5:00 PM</span>
            <span>Access: Alex Chen, Morgan Lee</span>
            <span>Working</span>
          </div>
          <p className="ds-feedback min-h-6 text-sm text-muted-foreground" role="status">
            {action || "Actions here affect this preview only."}
          </p>
        </Specimen>
      </div>
    </Section>
  );
}
const reactionDemoNames = ["Morgan Lee", "Sam Rivera", "Jo Park", "Taylor Kim", "Casey Jones"];

function Messages() {
  const [reactionMessages, setReactionMessages] = useState<DisplayMessage[]>([
    {
      id: "gallery-reactions-short",
      role: "user",
      metadata: { authorId: "alex", createdAt: now },
      parts: [
        { type: "text", text: "Coffee and a bookstore sounds perfect. Let's meet by the river." },
        {
          type: "data-reactions",
          id: "short-reactions",
          data: {
            items: [
              {
                emoji: "❤️",
                count: 1,
                reacted: false,
                userNames: ["Morgan Lee"],
                overflowCount: 0,
              },
              {
                emoji: "👍",
                count: 2,
                reacted: true,
                userNames: ["Alex Chen", "Morgan Lee"],
                overflowCount: 0,
              },
            ],
          },
        },
      ],
    },
    {
      id: "gallery-reactions-wrap",
      role: "assistant",
      metadata: { createdAt: now },
      parts: [
        { type: "text", text: "A good weekend plan." },
        {
          type: "data-reactions",
          id: "wrapped-reactions",
          data: {
            items: ["👍", "❤️", "🎉", "🔥", "👀", "🙏", "😂", "🚀", "✅", "💯", "🤔", "📚"].map(
              (emoji, index) => ({
                emoji,
                count: index === 3 ? 12 : (index % 5) + 1,
                reacted: false,
                userNames: reactionDemoNames.slice(0, index === 3 ? 5 : (index % 5) + 1),
                overflowCount: index === 3 ? 7 : 0,
              }),
            ),
          },
        },
      ],
    },
  ]);
  function react(messageId: string, emoji: string, active: boolean) {
    setReactionMessages((messages) =>
      messages.map((message) =>
        message.id !== messageId
          ? message
          : {
              ...message,
              parts: message.parts.map((part) => {
                if (part.type !== "data-reactions") return part;
                const existing = part.data.items.find((item) => item.emoji === emoji);
                if (!existing)
                  return {
                    ...part,
                    data: {
                      items: [
                        ...part.data.items,
                        {
                          emoji,
                          count: 1,
                          reacted: true,
                          userNames: ["Alex Chen"],
                          overflowCount: 0,
                        },
                      ],
                    },
                  };
                return {
                  ...part,
                  data: {
                    items: part.data.items
                      .map((item) => {
                        if (item.emoji !== emoji) return item;
                        const count = item.count + (active ? 1 : -1);
                        const otherCount = count - (active ? 1 : 0);
                        const names = reactionDemoNames.slice(0, Math.min(5, otherCount));
                        const userNames = (active ? ["Alex Chen", ...names] : names).slice(0, 5);
                        return {
                          ...item,
                          count,
                          reacted: active,
                          userNames,
                          overflowCount: Math.max(0, count - userNames.length),
                        };
                      })
                      .filter((item) => item.count > 0),
                  },
                };
              }),
            },
      ),
    );
  }
  return (
    <Section
      id="messages"
      title="Messages"
      description="The same message renderer used in conversations, with sample content."
    >
      <MessageIdentityContext value={identities}>
        <div className="ds-conversation flex flex-col gap-6 py-3">
          {reactionMessages.map((message) => (
            <Message
              key={message.id}
              message={message}
              canEdit
              resourceUrl={(id) => id}
              onAction={noop}
              onReaction={react}
            />
          ))}
          {messageFixtures.map((message) => (
            <Message
              key={message.id}
              message={message}
              resourceUrl={(id) => (id === "gallery-shared-pdf" ? weekendPdf : logo)}
              canEdit={false}
              onAction={noop}
              onReaction={noop}
            />
          ))}
        </div>
      </MessageIdentityContext>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Avatars">
          <div className="ds-row flex items-center flex-wrap gap-2">
            {(["sm", "default", "lg"] as const).map((size) => (
              <Avatar key={size} size={size}>
                <AvatarImage src={logo} alt="Lilac" />
                <AvatarFallback>LI</AvatarFallback>
              </Avatar>
            ))}
            <Avatar>
              <AvatarFallback>AC</AvatarFallback>
              <AvatarBadge />
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>AC</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>ML</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+2</AvatarGroupCount>
            </AvatarGroup>
          </div>
        </Specimen>
        <Specimen title="Agent avatars">
          <div className="ds-row flex items-center flex-wrap gap-4">
            {(["general", "explore", "self"] as const).map((profile) => (
              <div key={profile} className="flex items-center gap-2">
                <AgentAvatar profile={profile} displayName={`${profile} agent`} size="lg" />
                <span className="text-sm capitalize">{profile}</span>
              </div>
            ))}
            <MessageIdentityContext value={identities}>
              <div className="flex items-center gap-2">
                <AgentAvatar profile="self" displayName="Self with configured avatar" size="lg" />
                <span className="text-sm">Self with custom avatar</span>
              </div>
            </MessageIdentityContext>
          </div>
        </Specimen>
        <Specimen title="Bubble variants">
          <div className="ds-stack">
            {(
              [
                "default",
                "secondary",
                "muted",
                "tinted",
                "outline",
                "ghost",
                "destructive",
              ] as const
            ).map((variant) => (
              <Bubble key={variant} variant={variant}>
                <BubbleContent>{variant}</BubbleContent>
              </Bubble>
            ))}
          </div>
        </Specimen>
      </div>
      <ThinkingSpinnerDemo />
      <Specimen title="Markers">
        <div className="ds-stack">
          <ThinkingIndicator />
          <Marker variant="separator">
            <MarkerContent>Conversation compacted</MarkerContent>
          </Marker>
          <Marker variant="border">
            <MarkerIcon>
              <Check />
            </MarkerIcon>
            <MarkerContent>Finished in 8 seconds</MarkerContent>
          </Marker>
        </div>
      </Specimen>
    </Section>
  );
}
function ComposerSpecimen() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [text, setText] = useState(
    "Help me turn these **notes** into a weekend plan.\n\nKeep Sunday free.\nhttps://example.com/weekend",
  );
  const [disabled, setDisabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>(() => [
    {
      key: "gallery-notes",
      file: new File(["A quiet weekend"], "notes.txt", { type: "text/plain" }),
      reservation: Promise.resolve("gallery-notes"),
      state: "ready",
      progress: 1,
    },
  ]);
  return (
    <Section
      id="composer"
      title="Composer"
      description="Try the formatting toolbar, Markdown shortcuts, and multiline input."
    >
      <div className="ds-row flex items-center flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setDisabled((value) => !value)}>
          {disabled ? "Enable editor" : "Disable editor"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setText("Review [missing.txt](attachment:missing)")}
        >
          Missing attachment
        </Button>
      </div>
      <div className="ds-composer my-4">
        <FloatingChatMenu
          sidebarOpen={sidebarOpen}
          rightOpen={rightOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleRight={() => setRightOpen((open) => !open)}
          onShare={() => toast.add({ title: "Share selected", type: "info" })}
          onRename={() => toast.add({ title: "Rename selected", type: "info" })}
          onArchive={() => toast.add({ title: "Archive selected", type: "info" })}
          onDelete={() => toast.add({ title: "Delete selected", type: "info" })}
        />
        <Composer
          text={text}
          onText={setText}
          attachments={attachments}
          onRemoveAttachment={(key) =>
            setAttachments((items) => items.filter((item) => item.key !== key))
          }
          disabled={disabled}
          skillIds={[]}
          onSkills={noop}
          onCommand={noop}
          onAttach={noop}
          onRetryAttachment={noop}
          active={false}
          canCancel={false}
          onModelChange={noop}
          onSubmit={() => setText("")}
          onCancel={noop}
        />
      </div>
      <Specimen title="Message preview">
        <Markdown text={text} preserveLineBreaks />
      </Specimen>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" />}>
          <ChevronRight />
          Markdown output
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="ds-source p-4 bg-surface rounded-md whitespace-pre-wrap wrap-anywhere text-sm">
            {text}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </Section>
  );
}
function FileTabsDemo() {
  const [store] = useState(() => {
    const store = createPanelStore();
    store
      .getState()
      .openFile("demo", { type: "path", path: "/workspace/notes.md", name: "notes.md" });
    store
      .getState()
      .openFile("demo", { type: "path", path: "/workspace/example.ts", name: "example.ts" });
    store
      .getState()
      .openThread(
        "demo",
        { surface: "native", sessionId: "example-thread" },
        "Example conversation",
      );
    return store;
  });
  const tabs = useStore(store, (state) => state.tabs.get("demo") ?? defaultPanelTabs);
  const actions = store.getState();
  return (
    <div style={{ height: 420 }}>
      <RightPanelTabs
        tabs={tabs}
        onFocus={(id) => actions.focusTab("demo", id)}
        onClose={(id) => actions.closeTab("demo", id)}
        onAgents={() => actions.openAgents("demo")}
        renderTab={(tab) => {
          if (tab.type === "thread") return <ConversationBadge target={tab.target} />;
          return tab.type === "agents" ? (
            <div className="file-status grid place-content-center flex-1 p-4 text-sm text-muted-foreground">
              No subagents yet
            </div>
          ) : (
            <FileSource
              name={tab.target.name}
              heading={
                <span>{tab.target.type === "path" ? tab.target.path : tab.target.name}</span>
              }
              text={{
                status: "ready",
                text: tab.target.name.endsWith(".md")
                  ? Array.from<number, string>(
                      { length: 25 },
                      (_, index) => `- Note ${index + 1}: Each file keeps its own view.`,
                    ).join("\n")
                  : Array.from<number, string>(
                      { length: 180 },
                      (_, index) => `export const line${index + 1} = "A longer source file";`,
                    ).join("\n"),
                truncated: false,
              }}
            />
          );
        }}
      />
    </div>
  );
}

function Attachments() {
  return (
    <Section
      id="attachments"
      title="Attachments"
      description="Open a media card to try the viewer. These files are generated preview fixtures."
    >
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="File icons">
          <div className="ds-stack">
            {[
              "README.md",
              "App.tsx",
              "example.test.ts",
              "package.json",
              "Dockerfile",
              ".bashrc",
              "report.pdf",
              "archive.zip",
              "photo.png",
              "unknown",
            ].map((name) => (
              <span key={name} className="ds-row flex items-center flex-wrap gap-2">
                <FileIcon name={name} />
                {name}
              </span>
            ))}
          </div>
        </Specimen>
        <Specimen title="Image">
          <ReadyAttachment
            href={logo}
            data={{
              resourceId: "gallery-image",
              name: "lilac.svg",
              mediaType: "image/svg+xml",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Video">
          <ReadyAttachment
            href={motion}
            data={{
              resourceId: "gallery-video",
              name: "motion.mp4",
              mediaType: "video/mp4",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Audio">
          <ReadyAttachment
            href={tone}
            data={{
              resourceId: "gallery-audio",
              name: "tone.wav",
              mediaType: "audio/wav",
              size: 88278,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Text preview">
          <AttachmentPreviewBody
            name="notes.txt"
            href="data:text/plain,A%20quiet%20weekend"
            kind="text"
            text={{
              status: "ready",
              text: "A quiet weekend\n\n1. Coffee by the river\n2. Browse the bookstore\n3. Leave the afternoon free",
              truncated: false,
            }}
          />
        </Specimen>
        <Specimen title="Markdown preview">
          <AttachmentPreviewBody
            name="notes.md"
            href={`data:text/markdown,${encodeURIComponent(markdownAttachment)}`}
            kind="text"
            text={{ status: "ready", text: markdownAttachment, truncated: false }}
          />
        </Specimen>
        <Specimen title="Right panel tabs">
          <div className="flex flex-wrap gap-2 mb-3">
            <ConversationBadge target={{ surface: "native", sessionId: "example-thread" }} />
            <ConversationBadge
              target={{
                surface: "discord",
                sessionId: "123456789012345678",
                messageId: "987654321098765432",
              }}
            />
          </div>
          <FileTabsDemo />
        </Specimen>
        <Specimen title="File source · lines 123–125">
          <div style={{ height: 440 }}>
            <FileSource
              name="example.ts"
              line={123}
              endLine={125}
              text={{
                status: "ready",
                truncated: false,
                text: Array.from<number, string>(
                  { length: 180 },
                  (_, index) =>
                    `export const item${index + 1} = "A long line that wraps naturally in the file viewer without stretching the panel.";`,
                ).join("\n"),
              }}
            />
          </div>
        </Specimen>
        <Specimen title="PDF · long filename">
          <ReadyAttachment
            href={weekendPdf}
            data={{
              resourceId: "gallery-pdf",
              name: "Weekend_travel_itinerary_and_reservations_2026.pdf",
              mediaType: "application/pdf",
              size: 728,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Truncated text">
          <AttachmentPreviewBody
            name="long-notes.txt"
            href="data:text/plain,Preview%20fixture"
            kind="text"
            text={{ status: "ready", text: "Preview fixture…", truncated: true }}
          />
        </Specimen>
        <Specimen title="Binary file">
          <AttachmentPreviewBody
            name="archive.zip"
            href=""
            kind="text"
            text={{ status: "error", message: "This binary file cannot be previewed as text." }}
          />
        </Specimen>
      </div>
    </Section>
  );
}
const spinnerOptions = Object.entries(SPINNERS).map(([value, component]) => ({
  value,
  label: value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase()),
  component,
}));

function ThinkingSpinnerDemo() {
  const [selected, setSelected] = useState<string | null>("morph");
  const spinner = spinnerOptions.find((option) => option.value === selected)?.component;
  return (
    <Specimen title="Thinking spinner">
      <div className="flex flex-col items-start gap-4" data-ui="thinking-spinner-demo">
        <Select value={selected} onValueChange={setSelected} items={spinnerOptions}>
          <SelectTrigger aria-label="Thinking spinner">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spinnerOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ThinkingIndicator spinner={<LoadingSpinner spinner={spinner} />} />
      </div>
    </Specimen>
  );
}

function Controls() {
  const [discordId, setDiscordId] = useState("");
  const [savedDiscordId, setSavedDiscordId] = useState("");
  const [search, setSearch] = useState("");
  const [model, setModel] = useState<string | null>("balanced");
  return (
    <Section id="controls" title="Controls">
      <Specimen title="Switches">
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2">
            <Switch /> Off
          </label>
          <label className="flex items-center gap-2">
            <Switch defaultChecked /> On
          </label>
          <label className="flex items-center gap-2">
            <Switch size="sm" defaultChecked /> Small
          </label>
          <label className="flex items-center gap-2">
            <Switch disabled /> Disabled off
          </label>
          <label className="flex items-center gap-2">
            <Switch disabled defaultChecked /> Disabled on
          </label>
        </div>
      </Specimen>
      <Specimen title="Buttons">
        <div className="ds-row flex items-center flex-wrap gap-2">
          {(
            [
              "default",
              "secondary",
              "reference",
              "outline",
              "ghost",
              "destructive",
              "link",
            ] as const
          ).map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button disabled>Disabled</Button>
          <IconButton label="New conversation">
            <Plus />
          </IconButton>
        </div>
        <div className="ds-row flex items-center flex-wrap gap-2">
          {(["xs", "sm", "default", "lg"] as const).map((size) => (
            <Button key={size} size={size} variant="secondary">
              {size}
            </Button>
          ))}
        </div>
      </Specimen>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Inputs">
          <label className="ds-field flex flex-col gap-2 text-sm">
            Conversation title
            <Input placeholder="Untitled conversation" />
          </label>
          <div className="ds-field flex flex-col gap-2 text-sm">
            <span>Search</span>
            <SidebarSearch onSearch={setSearch} />
            <span className="ds-muted" role="status">
              {search ? `Search: ${search}` : ""}
            </span>
          </div>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Disabled
            <Input disabled value="Unavailable" readOnly />
          </label>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Invalid
            <Input aria-invalid defaultValue="Needs a name" />
          </label>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Plain text
            <Textarea placeholder="Write a note…" />
          </label>
        </Specimen>
        <Specimen title="Agent Discord identity">
          <AgentDiscordLink
            value={discordId}
            savedValue={savedDiscordId}
            disabled={false}
            onChange={setDiscordId}
            onSave={() => setSavedDiscordId(discordId.trim())}
          />
        </Specimen>
        <Specimen title="Reconnecting">
          <div className="login-shell flex flex-col gap-6 py-12">
            <h1>Lilac</h1>
            <ConnectionLoading />
          </div>
        </Specimen>
        <Specimen title="Sign-in styles">
          <div className={clerkAppearance.signIn.elements.cardBox}>
            <div className={`flex flex-col ${clerkAppearance.signIn.elements.card}`}>
              <div className="space-y-2 text-center">
                <h3 className={clerkAppearance.elements.headerTitle}>Enter your password</h3>
                <p className={clerkAppearance.elements.headerSubtitle}>alex@example.com</p>
              </div>
              <label className="flex flex-col gap-2 text-sm">
                Password
                <Input type="password" autoComplete="off" placeholder="Enter your password" />
              </label>
              <Button type="button" className={clerkAppearance.elements.formButtonPrimary}>
                Continue
              </Button>
            </div>
          </div>
        </Specimen>
        <Specimen title="Select & tabs">
          <Select
            value={model}
            onValueChange={setModel}
            items={[
              { value: "balanced", label: "Balanced" },
              { value: "deep", label: "Deep thinking" },
            ]}
          >
            <SelectTrigger aria-label="Example response model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="deep">Deep thinking</SelectItem>
            </SelectContent>
          </Select>
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general">General settings content.</TabsContent>
            <TabsContent value="appearance">Appearance settings content.</TabsContent>
          </Tabs>
          <Tabs defaultValue="chat">
            <TabsList variant="line">
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
            <TabsContent value="chat">Conversation content.</TabsContent>
            <TabsContent value="files">Shared files.</TabsContent>
          </Tabs>
          <Tabs
            defaultValue="account"
            orientation="vertical"
            className="rounded-lg bg-surface-raised p-4 text-surface-raised-foreground"
          >
            <TabsList activateOnFocus variant="navigation" aria-label="Settings sections">
              <TabsTrigger tabIndex={0} value="account">
                Account
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="options">
                Settings
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="keybindings">
                Keybindings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="account">Account settings.</TabsContent>
            <TabsContent value="options">
              Appearance, thread, notification, and access settings.
            </TabsContent>
            <TabsContent value="keybindings">Keyboard shortcuts.</TabsContent>
          </Tabs>
        </Specimen>
      </div>
    </Section>
  );
}
function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [action, setAction] = useState("");
  return (
    <Section id="overlays" title="Overlays">
      <div className="ds-row flex items-center flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>
            Thread actions
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setAction("Rename selected")}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAction("Archive selected")}>
              <Archive />
              Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" />}>Popover</PopoverTrigger>
          <PopoverContent>
            <strong>Shared with 2 people</strong>
            <p className="ds-muted">Alex Chen and Morgan Lee can edit this conversation.</p>
          </PopoverContent>
        </Popover>
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <IconButton label="Notifications">
          <Bell />
        </IconButton>
        <IconButton label="Copy message">
          <Copy />
        </IconButton>
        <CopyReferenceButton
          target={{ surface: "native", sessionId: "demo", messageId: "message" }}
        />
      </div>
      <ContextMenu>
        <ContextMenuTrigger
          className="ds-context-target flex items-center justify-center min-h-[calc(calc(var(--ui-space-unit)*12)_*_3)] bg-surface text-muted-foreground text-sm rounded-lg mt-4"
          tabIndex={0}
        >
          Right-click for thread actions
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setAction("Rename selected")}>
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setAction("Archive selected")}>
            <Archive />
            Archive
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setAction("Delete selected")}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <p className="ds-feedback min-h-6 text-sm text-muted-foreground" role="status">
        {action}
      </p>
      <Specimen title="Toasts">
        <div className="ds-row flex items-center flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              showAppUpdateToast(() => setAction("Reload selected in preview"), "app-update-demo")
            }
          >
            Update
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.add({
                id: "connection-demo",
                title: "Reconnecting…",
                type: "info",
                timeout: 0,
                actionProps: { children: "Retry", onClick: () => toast.close("connection-demo") },
              })
            }
          >
            Reconnecting
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.add({
                title: "Could not connect",
                description: "Check your connection and try again.",
                type: "error",
              })
            }
          >
            Connection error
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.add({ title: "Changes saved", type: "success" })}
          >
            Success
          </Button>
        </div>
      </Specimen>
      <Modal open={dialog} title="Rename conversation" onClose={() => setDialog(false)}>
        <label className="ds-field flex flex-col gap-2 text-sm">
          Title
          <Input defaultValue="A quiet weekend" />
        </label>
        <div className="dialog-actions flex justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={() => setDialog(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setDialog(false);
              setAction("Preview title saved");
            }}
          >
            Save
          </Button>
        </div>
      </Modal>
    </Section>
  );
}
const listItems = [...Array.from({ length: 100 }).keys()].map((index) => ({
  id: String(index),
  label: `Conversation ${index + 1}`,
}));
function Layout() {
  return (
    <Section
      id="layout"
      title="Layout"
      description="Drag the divider. The list renders only visible rows."
    >
      <div className="ds-resizable h-[calc(calc(var(--ui-space-unit)*12)_*_6)] bg-surface rounded-lg overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="35%" minSize="25%">
            <div className="ds-panel flex flex-col h-full gap-3 p-4 text-sm min-w-0">
              <strong>Conversations</strong>
              <VirtualList
                items={listItems}
                label="Example conversations"
                itemKey={(item) => item.id}
                render={(item) => (
                  <Button
                    variant="ghost"
                    className="ds-list-row flex items-center gap-2 py-3 px-0 whitespace-nowrap"
                  >
                    <FileText />
                    {item.label}
                  </Button>
                )}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel minSize="30%">
            <div className="ds-panel flex flex-col h-full gap-3 p-4 text-sm min-w-0 ds-panel-center items-center justify-center text-center">
              <span className="brand inline-flex gap-1 items-baseline text-2xl [letter-spacing:-0.07em] font-[650]">
                lilac<span>.</span>
              </span>
              <span className="ds-muted">Your next conversation starts here.</span>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Section>
  );
}
export default function DesignSystem() {
  const returnThreadId = useLocation({ select: (location) => location.state.chatThreadId });
  const returnDraftId = useLocation({ select: (location) => location.state.draftThreadId });

  const [queries] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "system");
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    return () => {
      setThemeMode(previous ?? "system");
    };
  }, []);
  useEffect(() => {
    setThemeMode(theme);
  }, [theme]);
  return (
    <QueryClientProvider client={queries}>
      <TooltipProvider>
        <div className="ds-page h-dvh overflow-auto bg-background">
          <header className="ds-header py-8">
            <Link
              to={returnThreadId ? "/threads/$threadId" : "/"}
              params={returnThreadId ? { threadId: returnThreadId } : {}}
              state={{ draftThreadId: returnDraftId }}
              className="ds-back inline-flex items-center gap-2 text-muted-foreground text-sm mb-8"
            >
              <ArrowLeft />
              Back to chat
            </Link>
            <div className="ds-header-main flex items-start workspace:items-center justify-between gap-6">
              <div>
                <span className="ds-eyebrow text-primary text-sm font-semibold">Lilac</span>
                <h1>Design system</h1>
                <p>Components, states, and patterns used in the native app.</p>
              </div>
              <Select
                value={theme}
                items={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
                onValueChange={(value) => {
                  if (value) setTheme(value);
                }}
              >
                <SelectTrigger aria-label="Preview theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </header>
          <div className="ds-body block workspace:grid workspace:[grid-template-columns:calc(var(--ui-sidebar-width)_/_2)_minmax(0,_1fr)] gap-8 pb-12">
            <nav
              className="ds-nav static workspace:sticky top-6 self-start flex flex-row workspace:flex-col gap-1 py-2 workspace:pt-6 workspace:pb-0 overflow-x-auto"
              aria-label="Component sections"
            >
              {sections.map(([id, title]) => (
                <a key={id} href={`#${id}`}>
                  {title}
                </a>
              ))}
            </nav>
            <main className="ds-main min-w-0">
              <Foundations />
              <Threads />
              <Messages />
              <Section
                id="agent-work"
                title="Agent work"
                description="Choose a stage to inspect, or play through the examples. Expand work summaries and tool details. These use the conversation renderer with local sample data."
              >
                <AgentWorkDemo />
              </Section>
              <Section id="appearance" title="Appearance">
                <div className="max-w-2xl">
                  <AppearanceSettings theme={theme} onTheme={setTheme} />
                </div>
              </Section>
              <Section id="keybindings" title="Keybindings">
                <KeybindingsDemo />
              </Section>
              <Section id="notifications" title="Notifications">
                <NotificationSettingsDemo />
              </Section>
              <Section id="deployment" title="Deployment settings">
                <DeploymentSettingsForm
                  value={{
                    titleModel: "fast",
                    outputStreaming: "complete",
                    oldMessageSelectionMaxAgeMs: null,
                    storageRetentionMaxAgeMs: null,
                    crossThreadSend: { triggerRun: true },
                  }}
                  onSave={() => undefined}
                />
              </Section>
              <ComposerSpecimen />
              <Section
                id="reconnection"
                title="Reconnection"
                description="Try the real composer and connection notice with a simulated outage."
              >
                <ReconnectionDemo />
              </Section>
              <Attachments />
              <Section id="content" title="Rich content">
                <div className="ds-content min-w-0">
                  <div className="flex flex-wrap gap-4 mb-4">
                    <LinkPreviewAnchor
                      href="https://example.com/article"
                      preview={{
                        title: "A quiet weekend",
                        description: "A few places to explore, with time to stop along the way.",
                      }}
                    >
                      Preview with text
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor
                      href="https://example.com/photo"
                      preview={{
                        title: "A quiet weekend",
                        description: "A few places to explore, with time to stop along the way.",
                        image: lilacLogo,
                      }}
                    >
                      Preview with image
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor href="https://example.com/unavailable" preview={{}}>
                      Unavailable preview
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor href="https://example.com/loading" loading>
                      Loading preview
                    </LinkPreviewAnchor>
                  </div>
                  <Markdown text={richText} />
                  <Specimen title="Table with long descriptions">
                    <Markdown text={tableExample} />
                  </Specimen>
                  <Specimen title="Table in a wrapped preview">
                    <Markdown text={tableExample} wrap />
                  </Specimen>
                  <Specimen title="GitHub alerts">
                    <Markdown text={alertExamples} />
                  </Specimen>
                </div>
              </Section>
              <Controls />
              <Overlays />
              <Layout />
            </main>
          </div>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function KeybindingsDemo() {
  const [store] = useState(() => createKeybindings());
  return <KeybindingsSettings store={store} />;
}

function NotificationSettingsDemo() {
  const [preferences] = useState(() =>
    createNotificationPreferences({ installationId: "design-system", principalId: "preview" }),
  );
  return (
    <div className="max-w-xl">
      <NotificationSettings preferences={preferences} />
    </div>
  );
}
