import {
  Ban,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock,
  Hourglass,
  MessageCircleQuestion,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { WorkflowCard } from "@stanley2058/lilac-client-protocol";
import { LoadingSpinner } from "./ui/loading-spinner";

export type WorkflowStatus = WorkflowCard["status"];

export const workflowStatuses: Record<
  WorkflowStatus,
  { label: string; icon: LucideIcon | "spinner"; tone: string }
> = {
  queued: { label: "Queued", icon: Clock, tone: "text-muted-foreground" },
  running: { label: "Running", icon: "spinner", tone: "text-primary" },
  blocked: { label: "Blocked", icon: TriangleAlert, tone: "text-warning" },
  waiting: { label: "Waiting", icon: Hourglass, tone: "text-info" },
  "waiting-reply": {
    label: "Waiting for reply",
    icon: MessageCircleQuestion,
    tone: "text-warning",
  },
  paused: { label: "Paused", icon: CirclePause, tone: "text-muted-foreground" },
  "needs-attention": { label: "Needs attention", icon: TriangleAlert, tone: "text-warning" },
  succeeded: { label: "Succeeded", icon: CircleCheck, tone: "text-success" },
  failed: { label: "Failed", icon: CircleX, tone: "text-danger" },
  cancelled: { label: "Cancelled", icon: Ban, tone: "text-muted-foreground" },
};

export function WorkflowStatusIcon({
  status,
  className = "size-4",
}: {
  status: WorkflowStatus;
  className?: string;
}) {
  const { icon: Icon, tone } = workflowStatuses[status];
  if (Icon === "spinner") return <LoadingSpinner size={16} />;
  return <Icon aria-hidden="true" className={`${className} ${tone}`} />;
}

/** Segments in display order. Finished work fills from the left; queued work stays empty. */
export const workflowSegments = [
  { key: "completed", label: "complete", className: "bg-success" },
  { key: "failed", label: "failed", className: "bg-danger" },
  { key: "cancelled", label: "stopped", className: "bg-muted-foreground/50" },
  { key: "active", label: "active", className: "bg-primary" },
  { key: "waiting", label: "waiting", className: "bg-info" },
  { key: "queued", label: "queued", className: "bg-transparent" },
] as const satisfies readonly {
  key: keyof WorkflowCard["progress"];
  label: string;
  className: string;
}[];

export function WorkflowProgressBar({
  counts,
  className = "h-1.5 w-full",
  live = false,
}: {
  counts: WorkflowCard["progress"];
  className?: string;
  live?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex overflow-hidden rounded-full bg-background/70 ${className}`}
    >
      {workflowSegments.map(({ key, className: segment }) =>
        counts[key] > 0 ? (
          <span
            key={key}
            data-shine={(live && key === "active") || undefined}
            className={`h-full transition-[width] ${segment}`}
            style={{ width: `${(counts[key] / Math.max(1, counts.total)) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}
