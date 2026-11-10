import { type ReactNode } from "react";
import type {
  DisplayMessage,
  NativeThread,
  WorkflowCard as WorkflowCardData,
  WorkflowRunSummary,
} from "@stanley2058/lilac-client-protocol";
import logo from "../assets/logo.svg";
import { ThreadSettleButton } from "../components/ThreadSettleButton";
import { toolActivities } from "../generated/tool-activities";

export const sections = [
  ["foundations", "Foundations"],
  ["threads", "Threads"],
  ["messages", "Messages"],
  ["agent-work", "Agent work"],
  ["appearance", "Appearance"],
  ["notifications", "Notifications"],
  ["keybindings", "Keybindings"],
  ["deployment", "Deployment settings"],
  ["composer", "Composer"],
  ["citations", "Citations"],
  ["reconnection", "Reconnection"],
  ["attachments", "Attachments"],
  ["content", "Rich content"],
  ["controls", "Controls"],
  ["overlays", "Overlays"],
  ["layout", "Layout"],
] as const;
export const now = new Date("2026-09-19T09:00:00Z").getTime();
export const directThreadBase = {
  id: "demo-dm",
  kind: "dm",
  title: "Chat with Lilac",
  starterId: "demo",
  archived: false,
  revision: 0,
  capabilities: { read: true, edit: true, share: false },
} satisfies Omit<NativeThread, "updatedAt">;
export const directThreadDemos: NativeThread[] = [
  {
    ...directThreadBase,
    updatedAt: now - 3 * 60_000,
    preview: { role: "user", text: "Let us plan the project launch for next week." },
  },
  {
    ...directThreadBase,
    displayStatus: "working",
    workingSince: now - 42_000,
    updatedAt: now,
  },
  {
    ...directThreadBase,
    displayStatus: "completed",
    updatedAt: now - 2 * 3_600_000,
    preview: {
      role: "assistant",
      text: "Here is a launch checklist with owners, dates, and the open risks we still need to close.",
    },
  },
  { ...directThreadBase, displayStatus: "error", updatedAt: now - 3 * 86_400_000 },
];
export const workflowCardSample: WorkflowCardData = {
  name: "audit-routes",
  description: "Audit routes for missing authentication coverage.",
  status: "running",
  startedAt: now - 84_000,
  progress: { completed: 3, queued: 3, active: 1, waiting: 0, failed: 0, cancelled: 0, total: 7 },
  phases: [],
  steps: [],
  agents: { used: 4, active: 1, queued: 3 },
  sensitive: false,
};
export const workflowResultSample: WorkflowCardData = {
  ...workflowCardSample,
  status: "succeeded",
  endedAt: now - 60_000,
  progress: { ...workflowCardSample.progress, completed: 7, queued: 0, active: 0 },
  agents: { used: 4, active: 0, queued: 0 },
  result: {
    kind: "text",
    text: "Route notes: every admin route checks the session and the owner role. ".repeat(12),
    truncated: true,
  },
};
export const workflowRunSamples: WorkflowRunSummary[] = [
  {
    id: "audit",
    card: workflowCardSample,
    thread: { id: "thread", title: "Compare the two proposals" },
  },
  {
    id: "reply",
    card: {
      ...workflowCardSample,
      name: "release-review",
      status: "waiting-reply",
      startedAt: now - 3_600_000,
      progress: { ...workflowCardSample.progress, completed: 2, queued: 2, active: 0, total: 4 },
    },
    platform: "discord",
  },
  {
    id: "failed",
    card: {
      ...workflowCardSample,
      name: "nightly-backup",
      status: "failed",
      endedAt: now - 7_080_000,
      startedAt: now - 7_200_000,
      progress: {
        ...workflowCardSample.progress,
        completed: 1,
        queued: 0,
        active: 0,
        failed: 2,
        total: 3,
      },
    },
  },
];
export const threadStates = [
  { state: "idle", label: "Idle", title: "Weekend reading list" },
  { state: "completed", label: "Completed · unread", title: "A few places to visit in Kyoto" },
  { state: "working", label: "Working", title: "Compare the two proposals" },
  { state: "waiting", label: "Waiting", title: "Survey the three vendors" },
  { state: "error", label: "Error", title: "Find the missing receipt" },
  { state: "input", label: "Needs input", title: "Which date works for everyone?" },
] as const;
export const swatches = [
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
export const spacings = [1, 2, 3, 4, 6, 8, 12];
export const noop = () => {};
export const markdownAttachment = [
  "#### A quiet weekend",
  "Start with **coffee by the river**, then browse the bookstore. Leave enough time to explore the neighborhood and find somewhere to read before heading home.",
  "- Bring a book to swap\n- Leave the afternoon free",
  "https://example.com/" + "a-long-path-without-breaks".repeat(8),
  "```text\n" + "A long code line should wrap within the preview. ".repeat(8) + "\n```",
  "| Plan | Details |\n| --- | --- |\n| Morning | " + "CoffeeAndBooks".repeat(12) + " |",
].join("\n\n");
export const identities = {
  viewerId: "alex",
  agent: { displayName: "Lilac", avatarUrl: logo },
  users: new Map([
    ["alex", { displayName: "Alex Chen" }],
    ["morgan", { displayName: "Morgan Lee" }],
  ]),
};
export const messageFixtures: DisplayMessage[] = [
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
      { type: "data-activity", id: "gallery-search", data: toolActivities.nearby.settled },
      {
        type: "data-activity",
        id: "gallery-cli-search",
        data: {
          kind: "tool",
          label: 'bash tools search "Kyoto bookstore opening hours"',
          state: "complete",
        },
      },
      {
        type: "data-activity",
        id: "gallery-cli-fetch",
        data: {
          kind: "tool",
          label: "bash tools fetch 'https://example.com/bookstore'",
          state: "complete",
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
export const richText =
  '### A small plan\n\nUse **bold**, *italic*, ~~strikethrough~~, and `inline code`. Links include a favicon: [GitHub](https://github.com).\n\n> Leave enough room to change your mind.\n\n- [x] Pick a place\n- [ ] Check the weather\n\n| Time | Plan |\n| --- | --- |\n| Morning | Coffee and a walk |\n| Afternoon | Bookstore |\n\n```typescript\nconst weekend = { pace: "slow", reservations: false };\nconsole.log("There is time to stop and explore", weekend);\n```\n\n```bash\nbun run dev:web\n```\n\nCurrency stays prose: your $10 suggestion makes sense over $7.\n\n**注意：**粗體與~~刪除線：~~在全形標點後也能正確結束。\n\nInline math: $a^2 + b^2 = c^2$.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nLaTeX delimiters: \\(e^{i\\pi} + 1 = 0\\)\n\n\\[\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n\\]\n\nEscaped brackets stay literal: array\\[0\\] and see \\[1\\].\n\n```mermaid\nflowchart TD\n  Coffee["Coffee and a slow start"] --> Weather{"What does the weather look like?"}\n  Weather -->|Clear| Walk["A long walk through the neighborhood"]\n  Weather -->|Rain| Bookstore["Find a book and somewhere warm to read"]\n```';

export const tableExample = [
  "| Restaurant | Location | Budget per person | Why consider it |",
  "| --- | --- | ---: | --- |",
  "| **時時香 SHANN Rice Bar** | Main building **9F** | **NT$600–850** | **Good for a mixed group.** Taiwanese, Sichuan and Cantonese sharing dishes let everyone order a varied spread. Some dishes are spicy, but the whole meal does not need to be. |",
  "| Garden Kitchen | Station **2F** | NT$400–600 | Set meals, vegetarian options, and plenty of room for six people. |",
].join("\n");

export const alertExamples = [
  "> [!NOTE]\n> Keep useful context close to the conversation.",
  "> [!TIP]\n> Use **Shift + Enter** to add a new line.",
  "> [!IMPORTANT]\n> Save your work before starting the next step.",
  "> [!WARNING]\n> Check the destination before moving files.",
  "> [!CAUTION]\n> Deleting this file cannot be undone.",
].join("\n\n");

export function Section({
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
export function Specimen({
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
export function DemoThreadActions({ onAction }: { onAction: (label: string) => void }) {
  return <ThreadSettleButton onClick={() => onAction("Settle selected")} />;
}
