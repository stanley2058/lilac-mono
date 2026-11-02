import { ProviderIcon } from "./ProviderIcon";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Bot,
  Brain,
  ChevronRight,
  Eye,
  Globe,
  Hammer,
  Search,
  SquarePen,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import {
  activityCommand,
  activityEditedPaths,
  activityGroupKind,
  activityGroupSummary,
  activityRowKind,
  activityRowTitle,
  activityVisible,
  formatActivityOutput,
  formatDuration,
  liveActivityLabel,
  parseToolLabel,
  subagentLabelProfile,
  type ActivityPart,
  type ActivityRowKind,
} from "../activity-presentation";
import { AgentAvatar } from "./AgentAvatar";
import { Markdown } from "./Markdown";
import { useMessageArrival } from "./message-arrivals";
import { subagentProfileName, useSubagents } from "./subagent-context";
import { activityFileTarget, type FileTarget } from "../file-target";
import { useFileResolution, useFileViewer } from "./file-viewer-context";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Skeleton } from "./ui/skeleton";
import { WorkingText } from "./ui/working-text";

export type { ActivityPart };

export const RequestActiveContext = createContext<boolean | undefined>(undefined);
export const LiveTailContext = createContext<string | undefined>(undefined);
export const ActivityTimesContext = createContext<ReadonlyMap<string, number>>(new Map());

const kindIcons: Record<ActivityRowKind | "mixed", LucideIcon> = {
  thinking: Brain,
  workflow: Workflow,
  agent: Bot,
  command: Terminal,
  read: Eye,
  search: Search,
  edit: SquarePen,
  web: Globe,
  tool: Wrench,
  mixed: Hammer,
};

const rowClass =
  "activity-row group/row flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left text-sm leading-relaxed text-muted-foreground select-none";
const triggerClass = `${rowClass} cursor-pointer transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-focus aria-expanded:text-foreground`;
const panelClass =
  "activity-panel ms-8 mt-1 mb-2 flex flex-col gap-2 rounded-md bg-muted/40 px-3 py-2";
const blockClass =
  "activity-block-text max-h-80 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-border/50 bg-background/60 p-2 font-mono text-xs leading-relaxed text-muted-foreground select-text";

function RowIcon({ kind, failed }: { kind: ActivityRowKind | "mixed"; failed?: boolean }) {
  const Icon = kindIcons[kind];
  return (
    <span
      aria-hidden="true"
      className="activity-icon flex size-6 shrink-0 items-center justify-center"
    >
      <Icon className={`size-4 ${failed ? "text-danger" : "opacity-70"}`} />
    </span>
  );
}

function RowTime({ at }: { at?: number }) {
  if (at === undefined) return null;
  return (
    <time
      className="activity-time shrink-0 text-xs opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
      dateTime={new Date(at).toISOString()}
    >
      {new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={`size-3 shrink-0 opacity-70 transition-transform ${open ? "rotate-90" : ""}`}
    />
  );
}

function Label({ children, live }: { children: ReactNode; live?: boolean }) {
  const className = "activity-label min-w-0 flex-1 truncate";
  if (live) return <WorkingText className={className}>{children}</WorkingText>;
  return <span className={className}>{children}</span>;
}

export function subagentActivity(
  part: ActivityPart,
  agents: ReadonlyMap<string, SubagentSummary>,
):
  | (Pick<SubagentSummary, "profile" | "title" | "state" | "taskTitle" | "model" | "reasoning"> & {
      id?: string;
    })
  | undefined {
  const agent = agents.get(part.id);
  if (agent) return agent;
  const profile = subagentLabelProfile(part);
  if (!profile) return;
  const current = part.data.label
    .split("\n")
    .findLast((line) => line.includes("> "))
    ?.split("> ")[1];
  return {
    profile,
    title: current ?? (part.data.state === "running" ? "Thinking…" : "Completed"),
    state: part.data.state,
    id: undefined,
  };
}

function useKindOf() {
  const { agents } = useSubagents();
  return useCallback(
    (part: ActivityPart): ActivityRowKind =>
      subagentActivity(part, agents) ? "agent" : activityRowKind(part),
    [agents],
  );
}

/**
 * A run of consecutive activities. Subagents always get their own rows so they can be opened.
 * A running turn collapses its trailing work into one live row; otherwise a single visible
 * activity renders as its own row and several share a summary row.
 */
export function Activity({ parts }: { parts: ActivityPart[] }) {
  const kindOf = useKindOf();
  const arrivalRef = useMessageArrival(`activity:${parts[0]?.id}`);
  const requestActive = useContext(RequestActiveContext);
  const liveTail = useContext(LiveTailContext);
  const agents = parts.filter((part) => kindOf(part) === "agent");
  const work = parts.filter((part) => kindOf(part) !== "agent");
  const live =
    requestActive === undefined
      ? parts.some((part) => part.data.state === "running")
      : requestActive && liveTail !== undefined && parts.at(-1)?.id === liveTail;
  // Work stays live even when a subagent row comes last; a turn whose subagents have all settled
  // still shows Thinking while the parent continues.
  const thinking = live && !work.length && !agents.some((part) => part.data.state === "running");
  return (
    <div ref={arrivalRef} className="activity-group w-full min-w-0">
      {agents.map((part) => (
        <ActivityItem key={part.id} part={part} />
      ))}
      {work.length ? <WorkGroup key="work" parts={work} kindOf={kindOf} live={live} /> : null}
      {thinking ? <LiveThinkingRow /> : null}
    </div>
  );
}

// One component for the live and settled forms keeps the disclosure open when the run settles.
function WorkGroup({
  parts,
  kindOf,
  live,
}: {
  parts: ActivityPart[];
  kindOf: (part: ActivityPart) => ActivityRowKind;
  live: boolean;
}) {
  const times = useContext(ActivityTimesContext);
  const [open, setOpen] = useState(false);
  // Row disclosure lives here so expanded rows stay open when the live row settles into a plain row.
  const [openItems, setOpenItems] = useState<ReadonlySet<string>>(() => new Set());
  const itemOpenChange = useCallback(
    (id: string, next: boolean) =>
      setOpenItems((current) => {
        const updated = new Set(current);
        if (next) updated.add(id);
        else updated.delete(id);
        return updated;
      }),
    [],
  );
  const visible = parts.filter(activityVisible);
  const item = (part: ActivityPart) => (
    <ActivityItem
      key={part.id}
      part={part}
      open={openItems.has(part.id)}
      onOpenChange={itemOpenChange}
    />
  );
  if (live && !visible.length)
    return (
      <div className={rowClass} role="status" data-ui="thinking">
        <LiveHeader parts={parts} kindOf={kindOf} />
      </div>
    );
  if (!live && !visible.length) return null;
  if (!live && visible.length === 1) return item(visible[0]!);
  return (
    <Collapsible className="activity-work w-full min-w-0" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <button type="button" className={triggerClass} aria-live={live ? "polite" : undefined} />
        }
      >
        {live ? (
          <LiveHeader parts={parts} kindOf={kindOf} />
        ) : (
          <>
            <RowIcon
              kind={activityGroupKind(visible, kindOf)}
              failed={visible.some((part) => part.data.state === "failed")}
            />
            <Label>{activityGroupSummary(visible, kindOf)}</Label>
            <RowTime at={times.get(visible[0]!.id)} />
          </>
        )}
        <Chevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent className="activity-members">{visible.map(item)}</CollapsibleContent>
    </Collapsible>
  );
}

function LiveHeader({
  parts,
  kindOf,
}: {
  parts: ActivityPart[];
  kindOf: (part: ActivityPart) => ActivityRowKind;
}) {
  const current = parts.findLast((part) => part.data.state === "running");
  return (
    <>
      <RowIcon kind={current ? kindOf(current) : "thinking"} />
      <Label live>{current ? liveActivityLabel(current) : "Thinking"}</Label>
    </>
  );
}

function SubagentItem({
  part,
  agent,
}: {
  part: ActivityPart;
  agent: NonNullable<ReturnType<typeof subagentActivity>>;
}) {
  const { open } = useSubagents();
  const requestActive = useContext(RequestActiveContext);
  const times = useContext(ActivityTimesContext);
  const arrivalRef = useMessageArrival(`activity-item:${part.id}`);
  return (
    <div ref={arrivalRef}>
      <button
        type="button"
        className={`subagent-activity ${triggerClass}`}
        onClick={() => open(agent.id ?? part.id)}
      >
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center [&>[data-slot=avatar]]:size-5"
        >
          <AgentAvatar
            decorative
            profile={agent.profile}
            displayName={subagentProfileName(agent.profile)}
            size="sm"
          />
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-foreground">
          {agent.taskTitle ?? subagentProfileName(agent.profile)}
        </span>
        <Label live={requestActive !== false && agent.state === "running"}>
          {agent.state === "failed" ? (
            <span className="text-danger">{agent.title}</span>
          ) : (
            agent.title
          )}
        </Label>
        {agent.model ? (
          <span
            title={`${agent.model} · ${agent.profile}${agent.reasoning ? ` · ${agent.reasoning}` : ""}`}
            className="flex max-w-40 shrink-0 items-center gap-1 text-xs"
          >
            <ProviderIcon provider={agent.model.split("/")[0] ?? ""} className="size-3.5" />
            <span className="truncate">{agent.model.split("/").slice(1).join("/")}</span>
          </span>
        ) : null}
        <RowTime at={times.get(part.id)} />
        <Chevron open={false} />
      </button>
    </div>
  );
}

function ActivityDetails({ part }: { part: ActivityPart }) {
  const kind = activityRowKind(part);
  const { detail, output, exitCode, state } = part.data;
  if (kind === "thinking")
    return (
      <div className="activity-thought ms-8 mb-2 max-h-96 overflow-auto py-1 text-sm text-foreground select-text">
        <Markdown text={detail ?? ""} />
      </div>
    );
  const input = detailInput(part, kind);
  return (
    <div className={panelClass}>
      {input ? <pre className={blockClass}>{input}</pre> : null}
      {part.data.file ? <ActivityFile {...part.data.file} /> : null}
      {output ? <pre className={blockClass}>{formatActivityOutput(output)}</pre> : null}
      {exitCode !== undefined ? (
        <span className={`text-xs ${exitCode === 0 ? "text-success" : "text-danger"}`}>
          Process exited with code {exitCode}
        </span>
      ) : null}
      {exitCode === undefined && state === "failed" ? (
        <span className="text-xs text-danger">Failed</span>
      ) : null}
      {part.data.durationMs !== undefined ? (
        <span className="text-xs text-muted-foreground">
          Took {formatDuration(part.data.durationMs)}
        </span>
      ) : null}
    </div>
  );
}

function detailInput(part: ActivityPart, kind: ActivityRowKind): string | undefined {
  if (kind === "command") return activityCommand(part);
  if (kind === "web" && parseToolLabel(part.data.label).name === "bash")
    return activityCommand(part);
  if (kind === "edit" && part.data.detail) return activityEditedPaths(part).paths.join("\n");
  return part.data.detail;
}

function hasDetails(part: ActivityPart): boolean {
  const { detail, output, exitCode, file } = part.data;
  return !!detail?.trim() || !!output?.trim() || exitCode !== undefined || !!file;
}

/** Resolved on expand so collapsed rows never fetch files. */
function ActivityFile({ path, mediaType }: { path: string; mediaType: string }) {
  const viewer = useFileViewer();
  const [failedHref, setFailedHref] = useState<string>();
  const target = useMemo<FileTarget>(() => activityFileTarget(path, mediaType), [path, mediaType]);
  const { file, error } = useFileResolution(target, mediaType.startsWith("image/"));
  const open = viewer ? () => viewer.openFile(target) : undefined;
  if (!mediaType.startsWith("image/"))
    return open ? (
      <button
        type="button"
        className="w-fit text-xs text-link hover:text-link-hover"
        onClick={open}
      >
        Open {target.name}
      </button>
    ) : null;
  if (error) return <span className="text-xs text-muted-foreground">{error}</span>;
  if (!file) return <Skeleton className="h-32 w-48 rounded-md" />;
  if (failedHref === file.href)
    return <span className="text-xs text-muted-foreground">Image unavailable</span>;
  return (
    <button
      type="button"
      className="w-fit max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-focus"
      onClick={open}
      disabled={!open}
      aria-label={`Open ${target.name}`}
    >
      <img
        src={file.href}
        alt={target.name}
        loading="lazy"
        onError={() => setFailedHref(file.href)}
        className="activity-image max-h-80 max-w-full rounded-md object-contain"
      />
    </button>
  );
}

export function ActivityItem({
  part,
  open: controlledOpen,
  onOpenChange,
}: {
  part: ActivityPart;
  open?: boolean;
  onOpenChange?: (id: string, open: boolean) => void;
}) {
  const { agents } = useSubagents();
  const agent = subagentActivity(part, agents);
  const requestActive = useContext(RequestActiveContext);
  const times = useContext(ActivityTimesContext);
  const arrivalRef = useMessageArrival(`activity-item:${part.id}`);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) =>
    onOpenChange ? onOpenChange(part.id, next) : setLocalOpen(next);
  if (agent) return <SubagentItem part={part} agent={agent} />;
  const running = requestActive !== false && part.data.state === "running";
  const failed = part.data.state === "failed";
  const kind = activityRowKind(part);
  let title = running ? liveActivityLabel(part) : activityRowTitle(part);
  if (open && kind === "thinking") title = running ? "Thinking" : "Thought";
  const row = (
    <>
      <RowIcon kind={kind} failed={failed} />
      <Label live={running}>{title}</Label>
      <RowTime at={times.get(part.id)} />
      {hasDetails(part) ? <Chevron open={open} /> : null}
    </>
  );
  if (!hasDetails(part))
    return (
      <div ref={arrivalRef} className={`activity-item ${rowClass}`}>
        {row}
      </div>
    );
  return (
    <Collapsible ref={arrivalRef} className="activity-item" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<button type="button" className={triggerClass} />}>
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ActivityDetails part={part} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function LiveThinkingRow() {
  return (
    <div className={rowClass} role="status" data-ui="thinking">
      <RowIcon kind="thinking" />
      <Label live>Thinking</Label>
    </div>
  );
}

/** Ticks in its own component so the turn does not rerender every second. */
export function ElapsedTime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}
