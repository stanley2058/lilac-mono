import { memo } from "react";
import { useStore } from "zustand";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { workflowBoardStore } from "../workflow-board-store";
import { useWorkflowRuns } from "../workflow-runs";
import { Button } from "./ui/button";
import { ErrorNotice, VirtualList } from "./ui";
import { workflowStatuses, WorkflowStatusIcon } from "./WorkflowStatusIcon";

export const WorkflowSidebarRow = memo(function WorkflowSidebarRow({
  run,
  onSelect,
}: {
  run: WorkflowRunSummary;
  onSelect: (runId: string) => void;
}) {
  const selected = useStore(workflowBoardStore, (state) => state.focus?.runId === run.id);
  const { name, status } = run.card;
  return (
    <div className="py-0.5">
      <Button
        variant="ghost"
        aria-current={selected || undefined}
        data-ui="workflow-sidebar-run"
        data-status={status}
        data-selected={selected || undefined}
        className="flex h-auto w-full min-w-0 items-center justify-start gap-2 rounded-md px-2 py-1 text-left font-normal data-[selected]:bg-selection data-[selected]:text-selection-foreground"
        onClick={() => onSelect(run.id)}
      >
        <span className="grid size-4 flex-none place-items-center">
          <WorkflowStatusIcon status={status} className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {workflowStatuses[status].label}
          </span>
        </span>
      </Button>
    </div>
  );
});

export function WorkflowSidebar({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (runId: string) => void;
}) {
  const runs = useWorkflowRuns(query);
  const rows = runs.sections.flatMap((section) => section.runs);
  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <ErrorNotice message={runs.error} />
      <VirtualList
        items={rows}
        itemKey={(run) => run.id}
        label="Workflows"
        className="thread-list flex-1"
        estimate={48}
        scrollFade
        hasMore={runs.hasMore}
        loading={runs.fetchingAny}
        onEndReached={runs.loadNext}
        render={(run) => <WorkflowSidebarRow run={run} onSelect={onSelect} />}
      />
      {query && runs.loaded && !rows.length ? (
        <p className="muted text-muted-foreground empty-list p-4 text-sm">No results</p>
      ) : null}
    </div>
  );
}
