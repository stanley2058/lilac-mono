import { Kbd } from "./ui/kbd";
import { useThreadShortcut } from "../shortcuts";
import { LoadingSpinner } from "./ui/loading-spinner";
import { useWorkspace } from "../workspace-context";
import { useQuery } from "@tanstack/react-query";
import { participantOptions, useNativeOnline } from "../queries";
import { sidebarPreferencesOptions } from "../sidebar-queries";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  SquarePen,
  Clock3,
  Cpu,
  MessageSquare,
  UserRound,
  Users,
  Pin,
  CircleAlert,
  Hourglass,
  MessageCircleQuestion,
  Workflow,
} from "lucide-react";
import type { NativeThread, NativeUser } from "@stanley2058/lilac-client-protocol";
import {
  defaultAutoSettleDays,
  relativeThreadTime,
  threadAge,
  workingDuration,
} from "../thread-metadata";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { AvatarGroup } from "./ui/avatar";
import { ActorAvatar } from "./ActorAvatar";
import "./thread-card.css";

export type ThreadDisplayState = "idle" | "completed" | "working" | "waiting" | "error" | "input";

export function threadDisplayState(
  thread: Pick<NativeThread, "displayStatus" | "activeRunId" | "waitingOn">,
): ThreadDisplayState {
  if (thread.waitingOn === "input") return "input";
  if (thread.waitingOn === "other") return "waiting";
  return thread.displayStatus ?? (thread.activeRunId ? "working" : "idle");
}

const states = {
  idle: { label: "Idle" },
  completed: { label: "Completed, unread" },
  working: { label: "Working" },
  waiting: { label: "Waiting", icon: Hourglass },
  error: { label: "Run failed", icon: CircleAlert },
  input: { label: "Needs your input", icon: MessageCircleQuestion },
} satisfies Record<ThreadDisplayState, { label: string; icon?: ComponentType }>;

export function ThreadCard({
  title,
  shortcutId,
  starterName,
  starterAvatarUrl,
  starterIcon,
  showStarter = true,
  updatedAt,
  workingSince,
  now,
  settleDays,
  state,
  workflowActive,
  selected,
  pinned,
  settled,
  draft,
  actions,
  onSelect,
}: {
  title: string;
  shortcutId?: string;
  starterName: string;
  starterAvatarUrl?: string;
  starterIcon?: ReactNode;
  /** Shows the starter's avatar; a viewer's own conversations omit it. */
  showStarter?: boolean;
  updatedAt?: number;
  workingSince?: number;
  now?: number;
  settleDays?: number;
  state: ThreadDisplayState;
  /** A workflow is running independently of this conversation's own status. */
  workflowActive?: boolean;
  selected?: boolean;
  pinned?: boolean;
  settled?: boolean;
  draft?: "new" | "reply";
  actions?: ReactNode;
  onSelect: () => void;
}) {
  const shortcut = useThreadShortcut(shortcutId);
  const runningSince = state === "working" || state === "waiting" ? workingSince : undefined;
  return (
    <div
      className={`thread-card relative min-w-0 rounded-lg ${selected ? "selected" : ""}`}
      data-settled={settled || undefined}
      data-state={state}
      data-draft={selected ? undefined : draft}
    >
      <Button
        variant="ghost"
        className="thread-card-select absolute inset-0 w-full h-full rounded-[inherit]"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        aria-keyshortcuts={shortcut.aria}
        aria-label={`${title || "Untitled"}, ${states[state].label}${workflowActive ? ", Workflow running" : ""}${draft && !selected ? ", Draft" : ""}`}
      />
      <span className="thread-card-copy relative pointer-events-none flex h-9 min-w-0 items-center gap-2 pr-2 pl-4">
        {state === "completed" ? (
          <span
            className="thread-unread-dot absolute top-1/2 left-[0.3125rem] size-1.5 -translate-y-1/2 rounded-full bg-primary"
            role="img"
            aria-label={states.completed.label}
          />
        ) : null}
        {draft && !selected ? (
          <span
            className="thread-draft-icon text-draft flex-none grid place-items-center"
            role="img"
            aria-label="Draft"
          >
            <SquarePen />
          </span>
        ) : null}
        <ThreadCardLead
          settled={settled}
          starterIcon={starterIcon}
          showStarter={showStarter}
          starterName={starterName}
          starterAvatarUrl={starterAvatarUrl}
        />
        <span className="thread-card-title min-w-0 flex-1 truncate text-sm">
          {title || "Untitled"}
        </span>
        <span className="thread-card-meta flex-none flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="thread-card-status flex items-center gap-1">
            {pinned ? (
              <span
                className="thread-pin grid place-items-center flex-none"
                role="img"
                aria-label="Pinned"
              >
                <Pin />
              </span>
            ) : null}
            {workflowActive ? (
              <span
                className="grid size-[var(--ui-text-lg)] flex-none place-items-center text-muted-foreground [&_svg]:size-[var(--ui-icon-size)]"
                role="img"
                aria-label="Workflow running"
                data-breath=""
              >
                <Workflow />
              </span>
            ) : null}
            {state === "error" || state === "input" || state === "waiting" ? (
              <ThreadStateIcon state={state} />
            ) : null}
            {state === "working" ? (
              <span
                className="thread-state-icon grid size-[var(--ui-text-lg)] flex-none place-items-center"
                role="img"
                aria-label={states[state].label}
              >
                <LoadingSpinner size={14} />
              </span>
            ) : null}
          </span>
          {settled || draft === "new" ? null : (
            <ThreadCardTime
              runningSince={runningSince}
              updatedAt={updatedAt}
              now={now}
              settleDays={settleDays}
              counting={!pinned}
            />
          )}
          {actions ? (
            <span
              data-ui="thread-card-actions"
              className="thread-card-actions absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center opacity-0 pointer-events-none rounded-md"
            >
              {actions}
            </span>
          ) : null}
        </span>
      </span>
      {shortcut.held && shortcut.label ? (
        <Kbd
          data-ui="thread-shortcut"
          className="absolute top-1/2 right-2 -translate-y-1/2 bg-popover px-2 text-popover-foreground shadow-sm"
        >
          {shortcut.label}
        </Kbd>
      ) : null}
    </div>
  );
}

function ThreadStateIcon({ state }: { state: "error" | "input" | "waiting" }) {
  const { label, icon: Icon } = states[state];
  return (
    <span
      className="thread-state-icon grid size-[var(--ui-text-lg)] flex-none place-items-center text-muted-foreground"
      role="img"
      aria-label={label}
      data-breath={state === "waiting" ? "" : undefined}
    >
      <Icon />
    </span>
  );
}

/** Settled rows show both parties; others show a starter only when it is someone else. */
function ThreadCardLead({
  settled,
  starterIcon,
  showStarter,
  starterName,
  starterAvatarUrl,
}: {
  settled?: boolean;
  starterIcon?: ReactNode;
  showStarter: boolean;
  starterName: string;
  starterAvatarUrl?: string;
}) {
  if (settled)
    return (
      <AvatarGroup className="thread-settled-avatars shrink-0 -space-x-2 [&>[data-slot=avatar]]:size-[var(--ui-text-lg)] [&>[data-slot=avatar]]:ring-0">
        <ActorAvatar displayName="Lilac" agentProfile="self" size="sm" />
        <ActorAvatar displayName={starterName} avatarUrl={starterAvatarUrl} size="sm" />
      </AvatarGroup>
    );
  if (starterIcon)
    return (
      <span className="thread-starter-icon flex-none grid place-items-center size-[var(--ui-text-lg)]">
        {starterIcon}
      </span>
    );
  if (!showStarter) return null;
  return (
    <span className="thread-starter flex-none" title={starterName}>
      <ActorAvatar displayName={starterName} avatarUrl={starterAvatarUrl} size="sm" />
    </span>
  );
}

function ThreadCardTime({
  runningSince,
  updatedAt,
  now,
  settleDays,
  counting,
}: {
  runningSince?: number;
  updatedAt?: number;
  now?: number;
  settleDays?: number;
  counting: boolean;
}) {
  if (runningSince !== undefined) return <WorkingTime since={runningSince} now={now} />;
  if (updatedAt === undefined) return null;
  return <ThreadTime updatedAt={updatedAt} now={now} settleDays={settleDays} counting={counting} />;
}

export function ThreadTime({
  updatedAt,
  now,
  settleDays = defaultAutoSettleDays,
  counting,
}: {
  updatedAt: number;
  now?: number;
  settleDays?: number;
  counting: boolean;
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const current = now ?? clock;
  return (
    <time
      dateTime={new Date(updatedAt).toISOString()}
      data-age={counting ? threadAge(updatedAt, current, settleDays) : undefined}
      className="tabular-nums data-[age=aging]:opacity-70 data-[age=settling]:opacity-45"
    >
      {relativeThreadTime(updatedAt, current)}
    </time>
  );
}

export function WorkingTime({ since, now }: { since: number; now?: number }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (now !== undefined) return;
    // The label drops seconds after the first minute, so wake only when its text changes.
    const elapsed = Math.max(0, clock - since);
    const step = elapsed < 60_000 ? 1000 : 60_000;
    const timer = window.setTimeout(() => setClock(Date.now()), step - (elapsed % step));
    return () => window.clearTimeout(timer);
  }, [now, clock, since]);
  return (
    <time
      dateTime={new Date(since).toISOString()}
      data-ui="thread-working-time"
      className="tabular-nums font-semibold text-primary"
    >
      {workingDuration(since, now ?? clock)}
    </time>
  );
}

export function ThreadSelect({
  thread,
  viewer,
  modelLabel,
  now,
  onSelect,
  actions,
  selected,
  pinned,
  settled,
  draft,
  participantNames,
}: {
  participantNames?: string[];
  thread: NativeThread;
  viewer: NativeUser;
  modelLabel?: string;
  now?: number;
  onSelect: () => void;
  actions?: ReactNode;
  selected?: boolean;
  pinned?: boolean;
  settled?: boolean;
  draft?: "new" | "reply";
}) {
  const { client } = useWorkspace();
  const [open, setOpen] = useState(false);
  const online = useNativeOnline(client);
  const { data, error } = useQuery({
    ...participantOptions(client, thread.id),
    enabled: online && open && !participantNames,
  });
  const { data: settleDays } = useQuery({
    ...sidebarPreferencesOptions(client, online),
    select: (preferences) => preferences.autoSettleDays,
  });
  const names = participantNames ?? data?.items.map(({ user }) => user.displayName);
  const starter =
    thread.starterId === viewer.id
      ? viewer.displayName
      : (thread.starterDisplayName ?? "Participant");
  const state = threadDisplayState(thread);
  return (
    <Tooltip onOpenChange={setOpen}>
      <TooltipTrigger render={<div className="thread-card-trigger block min-w-0 w-full" />}>
        <ThreadCard
          shortcutId={thread.id}
          title={thread.title}
          starterName={starter}
          starterAvatarUrl={
            thread.starterId === viewer.id ? viewer.avatarUrl : thread.starterAvatarUrl
          }
          showStarter={thread.starterId !== viewer.id}
          updatedAt={thread.updatedAt}
          workingSince={thread.workingSince}
          now={now}
          settleDays={settleDays}
          state={state}
          workflowActive={thread.hasActiveWorkflow}
          selected={selected}
          pinned={pinned}
          settled={settled}
          draft={draft}
          actions={actions}
          onSelect={onSelect}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="thread-details-tooltip rounded-xl shadow-overlay bg-popover text-popover-foreground p-3 ring-1 ring-border [&>[aria-hidden=true]]:hidden"
      >
        <div className="thread-details flex flex-col gap-2 text-sm wrap-anywhere">
          <strong>{thread.title || "Untitled"}</strong>
          <span>
            <UserRound />
            Started by {starter}
          </span>
          <span>
            <Clock3 />
            Last active{" "}
            {new Date(thread.updatedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          {modelLabel || thread.modelId ? (
            <span>
              <Cpu />
              {modelLabel ?? thread.modelId}
            </span>
          ) : null}
          {draft && !selected ? (
            <span>
              <SquarePen />
              Unsent draft
            </span>
          ) : null}
          <span>
            <MessageSquare />
            {thread.archived ? "Archived" : states[state].label}
            {!thread.capabilities.edit ? " · Read-only" : ""}
          </span>
          {names ? (
            <span>
              <Users />
              {names.slice(0, 6).join(", ")}
              {names.length > 6 ? ` and ${names.length - 6} more` : ""}
            </span>
          ) : null}
          {error ? (
            <span className="muted text-muted-foreground">Participants unavailable</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
