import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { workflowRunOptions } from "../queries";
import { useOptionalWorkspace } from "../workspace-context";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { workflowStatuses } from "./WorkflowStatusIcon";

const WorkflowRunDialog = lazy(() => import("./WorkflowRunDialog"));

/** The shared spinner renders a div, which is invalid in the paragraph that holds this chip. */
function ChipStatusIcon({ status }: { status: WorkflowRunSummary["card"]["status"] }) {
  const { icon, tone } = workflowStatuses[status];
  const Icon = icon === "spinner" ? LoaderCircle : icon;
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${tone}`} />;
}

export function WorkflowRunBadge({
  run,
  onClick,
}: {
  run: WorkflowRunSummary;
  onClick: () => void;
}) {
  const { name, status, progress } = run.card;
  const label = workflowStatuses[status].label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="reference"
            data-ui="workflow-run-chip"
            data-status={status}
            aria-label={`Workflow ${name}, ${label}`}
            className="inline-flex h-auto max-w-full gap-1 rounded-sm px-2 no-underline [font-weight:inherit] hover:no-underline"
            onClick={onClick}
          >
            <ChipStatusIcon status={status} />
            <span className="truncate">{name}</span>
          </Button>
        }
      />
      <TooltipContent className="max-w-sm">
        <div className="min-w-0 space-y-1 break-words">
          <div className="font-medium">{name}</div>
          <div>
            {label}
            {progress.total > 0 ? ` · ${progress.completed} of ${progress.total} steps` : ""}
          </div>
          <div className="break-all">{run.id}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Shows the id itself until the run loads, and for runs the viewer cannot see or that do not exist. */
export function WorkflowRunChip({ runId }: { runId: string }) {
  const workspace = useOptionalWorkspace();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    ...workflowRunOptions(workspace?.client, runId, true),
    enabled: !!workspace?.client.rpc,
    retry: false,
  });
  if (!query.data) return <code data-ui="workflow-run-id">{runId}</code>;
  return (
    <>
      <WorkflowRunBadge run={query.data} onClick={() => setOpen(true)} />
      {open ? (
        <Suspense fallback={null}>
          <WorkflowRunDialog runId={runId} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
