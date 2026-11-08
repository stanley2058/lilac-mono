import { memo } from "react";
import { useStore } from "zustand";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { workflowBoardStore } from "../workflow-board-store";
import { useWorkflowRuns, type WorkflowSection } from "../workflow-runs";
import { Button } from "./ui/button";
import { ErrorNotice, VirtualList } from "./ui";
import { workflowStatuses, WorkflowProgressBar, WorkflowStatusIcon } from "./WorkflowStatusIcon";

export const WorkflowMinimapRow = memo(function WorkflowMinimapRow({
  run,
  onSelect,
}: {
  run: WorkflowRunSummary;
  onSelect: (runId: string) => void;
}) {
  const visible = useStore(workflowBoardStore, (state) => state.visible.has(run.id));
  const { card } = run;
  return (
    <div className="py-0.5">
      <Button
        variant="ghost"
        aria-label={`${card.name}, ${workflowStatuses[card.status].label}`}
        aria-current={visible || undefined}
        data-ui="workflow-minimap-run"
        data-status={card.status}
        data-visible={visible || undefined}
        className="flex h-auto w-full min-w-0 flex-col items-stretch gap-1 rounded-md px-2 py-1 text-left font-normal data-[visible]:bg-selection data-[visible]:text-selection-foreground"
        onClick={() => onSelect(run.id)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="grid size-4 flex-none place-items-center">
            <WorkflowStatusIcon status={card.status} className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">{card.name}</span>
          {card.progress.total > 0 ? (
            <span className="flex-none text-xs text-muted-foreground tabular-nums">
              {card.progress.completed}/{card.progress.total}
            </span>
          ) : null}
        </span>
        {card.progress.total > 0 ? (
          <WorkflowProgressBar counts={card.progress} className="h-0.5 w-full" />
        ) : null}
      </Button>
    </div>
  );
});

type MinimapRow =
  | { kind: "section"; key: string; section: WorkflowSection; more: boolean }
  | { kind: "run"; key: string; run: WorkflowRunSummary };

export function WorkflowMinimapHeading({ label, count }: { label: string; count: string }) {
  return (
    <h2 className="m-0 flex items-center justify-between gap-2 px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </h2>
  );
}

export function WorkflowMinimap({ onSelect }: { onSelect: (runId: string) => void }) {
  const runs = useWorkflowRuns();
  const rows: MinimapRow[] = runs.sections.flatMap((section) => [
    {
      kind: "section" as const,
      key: `section:${section.id}`,
      section,
      more: section.finished ? runs.moreFinished : runs.moreActive,
    },
    ...section.runs.map((run) => ({ kind: "run" as const, key: run.id, run })),
  ]);
  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <ErrorNotice message={runs.error} />
      <VirtualList
        items={rows}
        itemKey={(row) => row.key}
        label="Workflows"
        className="thread-list flex-1"
        estimate={34}
        scrollFade
        hasMore={runs.moreActive || runs.moreFinished}
        loading={runs.fetching}
        onEndReached={runs.loadMore}
        render={(row) =>
          row.kind === "section" ? (
            <WorkflowMinimapHeading
              label={row.section.label}
              count={`${row.section.runs.length}${row.more ? "+" : ""}`}
            />
          ) : (
            <WorkflowMinimapRow run={row.run} onSelect={onSelect} />
          )
        }
      />
    </div>
  );
}
