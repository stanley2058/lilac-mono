import { useAppShortcuts, useThreadTargets } from "../shortcuts";
import { ConversationContext, CopyReferenceButton } from "../components/ConversationReference";
import { ConversationIcon } from "../components/ConversationReference";
import { SidebarEmptyState } from "../components/SidebarEmptyState";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "../components/ui/toast";
import { IconButton, Modal, VirtualList } from "../components/ui";
import { ThreadQueueDemo } from "../components/ThreadQueueDemo";
import { ExternalMessages } from "../components/ExternalMessages";
import { ExternalSkeleton } from "../components/ExternalSidebar";
import { Skeleton } from "../components/ui/skeleton";
import { ThreadCard } from "../components/ThreadSelect";
import { ViewSwitcher } from "../components/ViewSwitcher";
import { WorkflowSidebarRow } from "../components/WorkflowSidebar";
import {
  WorkflowCardSource,
  workflowTrackListClass,
  WorkflowBoardTracks,
  WorkflowTrackFrame,
  workflowTrackRowClass,
} from "../components/WorkflowBoard";
import { WorkflowCard } from "../components/WorkflowCard";
import { MessageServicesContext } from "../components/message-services";
import {
  now,
  workflowResultSample,
  workflowRunSamples,
  threadStates,
  noop,
  Section,
  Specimen,
  DemoThreadActions,
} from "./shared";

export function Threads() {
  const [selected, setSelected] = useState("working");
  const [workflowOpen, setWorkflowOpen] = useState(false);
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
                workingSince={state === "working" || state === "waiting" ? now - 72_000 : undefined}
                now={now}
                state={state}
                selected={selected === state}
                onSelect={() => setSelected(state)}
                actions={<DemoThreadActions onAction={setAction} />}
              />
            </div>
          ))}
        </div>
        <Specimen title="Workflow running">
          <ThreadCard
            title="Nightly dependency audit"
            starterName="Alex Chen"
            showStarter={false}
            updatedAt={now - 3_600_000}
            now={now}
            state="idle"
            workflowActive
            onSelect={() => {}}
          />
        </Specimen>
        <Specimen title="View switcher">
          <div className="flex justify-end gap-2">
            <ViewSwitcher owner onChange={() => {}} />
            <ViewSwitcher view="workflows" owner onChange={() => {}} />
          </div>
        </Specimen>
        <Specimen title="Workflow list">
          <div className="w-72 rounded-lg bg-sidebar p-2">
            <WorkflowSidebarRow run={workflowRunSamples[1]!} onSelect={() => {}} />
            <WorkflowSidebarRow run={workflowRunSamples[0]!} onSelect={() => {}} />
            <WorkflowSidebarRow run={workflowRunSamples[2]!} onSelect={() => {}} />
          </div>
        </Specimen>
        <Specimen title="Workflow board">
          <MessageServicesContext
            value={{
              canEdit: true,
              resourceUrl: (id) => id,
              onAction: () => {},
              onReaction: () => {},
            }}
          >
            <div className="flex h-144 max-h-[70dvh]">
              <WorkflowBoardTracks>
                <WorkflowTrackFrame id="attention" label="Needs attention" count={0} collapsed />
                <WorkflowTrackFrame id="running" label="Running" count={1}>
                  <VirtualList
                    items={[workflowRunSamples[0]!]}
                    itemKey={(run) => run.id}
                    label="Running"
                    className={workflowTrackListClass}
                    estimate={260}
                    render={(run) => (
                      <div className={workflowTrackRowClass}>
                        <WorkflowCard
                          messageId={run.id}
                          card={run.card}
                          source={<WorkflowCardSource run={run} onOpen={() => {}} />}
                          runId="wfrun:example-run"
                          onOpen={() => setWorkflowOpen(true)}
                          body="preview"
                        />
                      </div>
                    )}
                  />
                </WorkflowTrackFrame>
                <WorkflowTrackFrame id="finished" label="Finished" count={1} more>
                  <VirtualList
                    items={[workflowResultSample]}
                    itemKey={(card) => card.name}
                    label="Finished"
                    className={workflowTrackListClass}
                    estimate={260}
                    render={(card) => (
                      <div className={workflowTrackRowClass}>
                        <WorkflowCard
                          messageId="sample-result"
                          card={card}
                          runId="wfrun:example-run"
                          onOpen={() => setWorkflowOpen(true)}
                          body="preview"
                          selected
                        />
                      </div>
                    )}
                  />
                </WorkflowTrackFrame>
                <WorkflowTrackFrame id="paused" label="Paused" count={0} collapsed />
                <WorkflowTrackFrame id="failed" label="Failed" count={0}>
                  <Skeleton className="h-40 w-full rounded-xl" />
                </WorkflowTrackFrame>
              </WorkflowBoardTracks>
            </div>
            <Modal open={workflowOpen} wide title="Workflow" onClose={() => setWorkflowOpen(false)}>
              <WorkflowCard messageId="sample-result" card={workflowResultSample} body="full" />
            </Modal>
          </MessageServicesContext>
        </Specimen>
        <Specimen title="Other conversations">
          <ThreadCard
            title="Calendar Enums"
            starterName="Discord"
            starterIcon={<ConversationIcon surface="discord" />}
            updatedAt={now}
            now={now}
            state="idle"
            selected
            onSelect={() => {}}
          />
          <ThreadCard
            title="Fix search pagination"
            starterName="GitHub"
            starterIcon={<ConversationIcon surface="github" />}
            updatedAt={now - 30 * 3_600_000}
            now={now}
            state="idle"
            onSelect={() => {}}
          />
          <ThreadCard
            title="Archive release notes"
            starterName="GitHub"
            starterIcon={<ConversationIcon surface="github" />}
            updatedAt={now - 40 * 86_400_000}
            now={now}
            state="idle"
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
export const demoWorkingIndicators = [
  "Brewing",
  "Photosynthesizing",
  "Tiptoeing",
  "Tuning",
  "Waltzing",
];
export const reactionDemoNames = [
  "Morgan Lee",
  "Sam Rivera",
  "Jo Park",
  "Taylor Kim",
  "Casey Jones",
];
