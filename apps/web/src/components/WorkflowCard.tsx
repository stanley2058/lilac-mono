import { useEffect, useState, type ReactNode } from "react";
import {
  Ban,
  Bot,
  CalendarClock,
  Check,
  CircleDashed,
  CircleX,
  Hourglass,
  MessageCircleQuestion,
  Minus,
  Pause,
  Play,
  Square,
  TimerOff,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  DisplayPart,
  WorkflowCard as WorkflowCardData,
} from "@stanley2058/lilac-client-protocol";
import { formatDuration } from "../activity-presentation";
import { Markdown } from "./Markdown";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useMessageServices } from "./message-services";
import {
  workflowSegments,
  workflowStatuses,
  WorkflowProgressBar,
  WorkflowStatusIcon,
} from "./WorkflowStatusIcon";

type ActionsPart = Extract<DisplayPart, { type: "data-actions" }>;
type Step = WorkflowCardData["steps"][number];
type Counts = WorkflowCardData["progress"];

const actionIcons: Record<string, LucideIcon> = { Pause, Resume: Play, Cancel: Square };

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function WorkflowCard({
  messageId,
  card,
  actions,
  source,
}: {
  messageId: string;
  card: WorkflowCardData;
  actions?: ActionsPart;
  /** Where the run came from, for views that show the card outside its conversation. */
  source?: ReactNode;
}) {
  const ended = card.endedAt !== undefined;
  const now = useNow(!ended);
  const elapsed = (card.endedAt ?? now) - card.startedAt;
  const status = workflowStatuses[card.status];
  return (
    <section
      data-ui="workflow-card"
      data-workflow-card={messageId}
      data-status={card.status}
      aria-label={`Workflow ${card.name}, ${status.label}`}
      className="workflow-card flex w-full min-w-0 flex-col gap-3 rounded-xl bg-muted px-4 py-3"
    >
      <header className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/60">
          <Workflow aria-hidden="true" className="size-4 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="m-0 truncate font-mono text-sm font-semibold text-foreground">
            {card.name}
          </h3>
          <p
            data-ui="workflow-status"
            className={`m-0 flex items-center gap-1.5 text-sm ${status.tone}`}
          >
            <WorkflowStatusIcon status={card.status} />
            <span>{status.label}</span>
            <span className="text-muted-foreground tabular-nums">· {formatDuration(elapsed)}</span>
          </p>
        </div>
        {actions?.data.actions.length ? (
          <WorkflowActions messageId={messageId} part={actions} />
        ) : null}
      </header>
      {card.description ? (
        <p className="m-0 text-sm text-muted-foreground text-pretty">{card.description}</p>
      ) : null}
      {card.progress.total > 0 ? (
        <Progress counts={card.progress} live={card.status === "running"} />
      ) : null}
      <Notice card={card} now={now} />
      {card.phases.length > 1 ? <Phases phases={card.phases} /> : null}
      {card.steps.length ? <Steps steps={card.steps} /> : null}
      <Result card={card} />
      <Footer card={card} />
      {source}
    </section>
  );
}

function WorkflowActions({ messageId, part }: { messageId: string; part: ActionsPart }) {
  const { canEdit, onAction } = useMessageServices();
  // A card update replaces the action set, which ends the pending state. Failed requests leave the
  // set unchanged, so the controls unlock again after a short delay.
  const key = `${part.data.revision}:${part.data.actions.map((action) => action.actionId).join()}`;
  const [pending, setPending] = useState<{ key: string; actionId: string }>();
  const waiting = pending?.key === key ? pending.actionId : undefined;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setPending(undefined), 10_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  return (
    <div data-ui="workflow-actions" className="flex shrink-0 items-center gap-1">
      {part.data.actions.map((action) => {
        const Icon = actionIcons[action.label];
        const disabled = !canEdit || action.disabled || waiting !== undefined;
        const run = () => {
          setPending({ key, actionId: action.actionId });
          onAction(messageId, part, action.actionId);
        };
        if (!Icon)
          return (
            <Button
              key={action.actionId}
              type="button"
              size="sm"
              variant={action.style === "danger" ? "destructive" : "secondary"}
              disabled={disabled}
              onClick={run}
            >
              {action.label}
            </Button>
          );
        return (
          <IconButton
            key={action.actionId}
            label={action.label}
            disabled={disabled}
            onClick={run}
            className={action.style === "danger" ? "hover:text-danger" : ""}
          >
            {waiting === action.actionId ? <LoadingSpinner size={14} /> : <Icon />}
          </IconButton>
        );
      })}
    </div>
  );
}

function stepSummary(counts: Counts): string {
  return workflowSegments
    .filter(({ key }) => key !== "completed" && counts[key] > 0)
    .map(({ key, label }) => `${counts[key]} ${label}`)
    .join(" · ");
}

function Progress({ counts, live }: { counts: Counts; live: boolean }) {
  const extra = stepSummary(counts);
  return (
    <div data-ui="workflow-progress" className="flex flex-col gap-1.5">
      <WorkflowProgressBar counts={counts} live={live} />
      <p className="m-0 text-xs text-muted-foreground tabular-nums">
        {counts.completed} of {counts.total} {counts.total === 1 ? "step" : "steps"} complete
        {extra ? ` · ${extra}` : ""}
      </p>
    </div>
  );
}

function relative(at: number, now: number): string {
  const delta = at - now;
  if (delta <= 0) return "now";
  return `in ${formatDuration(delta)}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Callout({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone: string;
  children: ReactNode;
}) {
  return (
    <div
      data-ui="workflow-notice"
      className="flex items-start gap-2 rounded-lg bg-background/60 px-3 py-2 text-sm"
    >
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Notice({ card, now }: { card: WorkflowCardData; now: number }) {
  if (card.status === "needs-attention")
    return (
      <Callout icon={TriangleAlert} tone="text-warning">
        <span>Lilac couldn't confirm whether a step finished.</span>
        <span className="text-muted-foreground">Cancel this run and start a new one.</span>
      </Callout>
    );
  if (card.reason)
    return (
      <Callout
        icon={card.status === "failed" ? CircleX : Ban}
        tone={card.status === "failed" ? "text-danger" : "text-muted-foreground"}
      >
        <span className="whitespace-pre-wrap wrap-anywhere">{card.reason}</span>
      </Callout>
    );
  const wait = card.wait;
  if (wait?.kind === "sleep")
    return (
      <Callout icon={Hourglass} tone="text-info">
        <span className="wrap-anywhere">{wait.prompt}</span>
        {wait.dueAt !== undefined ? (
          <span className="text-muted-foreground tabular-nums">
            Resumes {relative(wait.dueAt, now)}
          </span>
        ) : null}
      </Callout>
    );
  if (wait?.kind === "reply") {
    const target = wait.replyToMessage ? "reply to the prompt message" : "reply";
    const where = wait.elsewhere ? " in the Discord channel where this workflow started" : " here";
    return (
      <Callout icon={MessageCircleQuestion} tone="text-warning">
        <span className="wrap-anywhere">{wait.prompt}</span>
        <span className="text-muted-foreground">
          To continue, {target}
          {where}.{wait.deadlineAt !== undefined ? ` Respond by ${clock(wait.deadlineAt)}.` : ""}
        </span>
      </Callout>
    );
  }
  return null;
}

function phaseState(phase: Counts): { label: string; icon: ReactNode } {
  const icon = (Icon: LucideIcon, tone: string) => (
    <Icon aria-hidden="true" className={`size-3.5 ${tone}`} />
  );
  if (phase.failed) return { label: "Failed", icon: icon(X, "text-danger") };
  if (phase.completed === phase.total) return { label: "Done", icon: icon(Check, "text-success") };
  if (phase.active) return { label: "Running", icon: <LoadingSpinner size={14} /> };
  if (phase.waiting) return { label: "Waiting", icon: icon(Hourglass, "text-info") };
  if (phase.cancelled && !phase.queued)
    return { label: "Stopped", icon: icon(Minus, "text-muted-foreground") };
  return { label: "Queued", icon: icon(CircleDashed, "text-muted-foreground") };
}

function Phases({ phases }: { phases: WorkflowCardData["phases"] }) {
  return (
    <ol data-ui="workflow-phases" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {phases.map((phase, index) => {
        const state = phaseState(phase);
        return (
          <li
            key={`${index}:${phase.name}`}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-background/60 py-0.5 ps-1.5 pe-2.5 text-xs"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">{state.icon}</span>
            <span className="min-w-0 truncate">{phase.name}</span>
            {phase.total > 1 ? (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {phase.completed}/{phase.total}
              </span>
            ) : null}
            <span className="sr-only">{state.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function stepState(step: Step): { label: string; icon: ReactNode } {
  const icon = (Icon: LucideIcon, tone: string) => (
    <Icon aria-hidden="true" className={`size-3.5 ${tone}`} />
  );
  switch (step.state) {
    case "queued":
      return { label: "Queued", icon: icon(CircleDashed, "text-muted-foreground") };
    case "dispatched":
      return { label: "Starting", icon: <LoadingSpinner size={14} /> };
    case "running":
      return { label: "Running", icon: <LoadingSpinner size={14} /> };
    case "blocked":
      return step.kind === "wait"
        ? { label: "Waiting", icon: icon(Hourglass, "text-info") }
        : { label: "Blocked", icon: icon(TriangleAlert, "text-warning") };
    case "succeeded":
      return { label: "Done", icon: icon(Check, "text-success") };
    case "failed":
      return { label: "Failed", icon: icon(X, "text-danger") };
    case "timed_out":
      return { label: "Timed out", icon: icon(TimerOff, "text-danger") };
    case "cancelled":
      return { label: "Stopped", icon: icon(Minus, "text-muted-foreground") };
  }
}

function Steps({ steps }: { steps: WorkflowCardData["steps"] }) {
  return (
    <ul data-ui="workflow-steps" className="m-0 flex list-none flex-col gap-1 p-0">
      {steps.map((step, index) => {
        const state = stepState(step);
        return (
          <li
            key={`${index}:${step.label ?? step.kind}`}
            data-state={step.state}
            className="flex min-w-0 items-center gap-2 text-sm"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">{state.icon}</span>
            <span className="min-w-0 flex-1 truncate">
              {step.label ?? (step.kind === "wait" ? "Wait" : "Agent step")}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{state.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Result({ card }: { card: WorkflowCardData }) {
  if (card.status === "succeeded" && card.sensitive)
    return (
      <p className="m-0 text-sm text-muted-foreground">
        The result is hidden because this workflow handles sensitive input.
      </p>
    );
  const result = card.result;
  if (!result) return null;
  if (result.kind === "stored")
    return (
      <p data-ui="workflow-result" className="m-0 text-sm text-muted-foreground">
        The result is too large to show here. Ask Lilac for the full result.
      </p>
    );
  return (
    <div
      data-ui="workflow-result"
      className="flex min-w-0 flex-col gap-1 rounded-lg bg-background/60 px-3 py-2"
    >
      <Markdown
        text={result.kind === "json" ? `\`\`\`json\n${result.text}\n\`\`\`` : result.text}
        wrap
      />
      {result.truncated ? (
        <p className="m-0 text-xs text-muted-foreground">
          Shortened. Ask Lilac for the full result.
        </p>
      ) : null}
    </div>
  );
}

function Footer({ card }: { card: WorkflowCardData }) {
  const { used, active, queued } = card.agents;
  if (!used && !queued && card.nextRunAt === undefined) return null;
  const agentDetail = [active ? `${active} active` : "", queued ? `${queued} queued` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {used || queued ? (
        <Tooltip>
          <TooltipTrigger
            render={<span data-ui="workflow-agents" className="inline-flex items-center gap-1" />}
          >
            <Bot aria-hidden="true" className="size-3.5" />
            {used} {used === 1 ? "agent" : "agents"}
          </TooltipTrigger>
          <TooltipContent>{agentDetail || "None running"}</TooltipContent>
        </Tooltip>
      ) : null}
      {card.nextRunAt !== undefined ? (
        <span className="inline-flex items-center gap-1">
          <CalendarClock aria-hidden="true" className="size-3.5" />
          Next run {clock(card.nextRunAt)}
        </span>
      ) : null}
    </footer>
  );
}
