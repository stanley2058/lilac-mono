import { ProviderIcon } from "./ProviderIcon";
import { AgentAvatar } from "./AgentAvatar";
import { LoadingSpinner } from "./ui/loading-spinner";
import { defaultRightPanel } from "../panel-store";
import {
  useContext,
  useMemo,
  useEffect,
  useCallback,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleCheck,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import type {
  DisplayMessage,
  ReadyTurnSlot,
  SubagentSummary,
  DisplayStreamTarget,
} from "@stanley2058/lilac-client-protocol";
import { useWorkspace } from "../workspace-context";
import { subagentsOptions, useNativeOnline } from "../queries";
import { SubagentContext, subagentProfileName } from "./subagent-context";
import { MessageIdentityContext } from "./message-identity";
import { Turn, useSlot, useSlotIds } from "./Timeline";
import {
  DisplayStreamContext,
  MessageServicesContext,
  type MessageServices,
} from "./message-services";
import { Button } from "./ui/button";
import { IconButton } from "./ui";
import { WorkingText } from "./ui/working-text";
import { PanelToggleButton } from "./PanelToggleButton";
import "./subagent-panel.css";

const transcriptServices: MessageServices = {
  canEdit: false,
  resourceUrl: () => "",
  onAction: () => {},
  onReaction: () => {},
};
const ignoreTurnAction = () => {};

export function NativeSubagentProvider({
  threadId,
  running,
  foreground,
  children,
}: {
  threadId: string;
  running: boolean;
  foreground: boolean;
  children: ReactNode;
}) {
  const { client, panels } = useWorkspace();
  const online = useNativeOnline(client);
  const query = useInfiniteQuery({
    ...subagentsOptions(client, threadId),
    enabled: online && foreground,
    refetchInterval: (query) =>
      foreground &&
      (running ||
        query.state.data?.pages.some((page) =>
          page.items.some((agent) => agent.state === "running"),
        ))
        ? 2000
        : false,
  });
  const agents = useMemo(
    () =>
      new Map(
        query.data?.pages.flatMap((page) => page.items).map((agent) => [agent.activityId, agent]),
      ),
    [query.data],
  );
  const value = useMemo(
    () => ({ agents, open: (id: string) => panels.getState().select(threadId, id) }),
    [agents, panels, threadId],
  );
  return <SubagentContext value={value}>{children}</SubagentContext>;
}

export function NativeSubagentPanel({
  threadId,
  foreground,
  embedded,
}: {
  threadId: string;
  foreground: boolean;
  embedded?: boolean;
}) {
  const { client, panels, resourceUrl } = useWorkspace();
  const open = useStore(panels, (state) => (state.threads.get(threadId) ?? defaultRightPanel).open);
  const selection = useStore(panels, (state) => state.selection);

  const targetId = selection?.threadId === threadId ? selection.agentId : "";
  const online = useNativeOnline(client);
  const list = useInfiniteQuery({
    ...subagentsOptions(client, threadId),
    enabled: open && online && foreground,
  });
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const target = items.find((agent) => agent.id === targetId || agent.activityId === targetId);
  const agentId = target?.id ?? "";
  const resolving = !!targetId && !target && (list.isPending || !!list.hasNextPage);
  useEffect(() => {
    if (
      open &&
      foreground &&
      online &&
      targetId &&
      !target &&
      list.hasNextPage &&
      !list.isFetching &&
      !list.error
    )
      void list.fetchNextPage();
  }, [
    open,
    foreground,
    online,
    targetId,
    target,
    list.hasNextPage,
    list.isFetching,
    list.error,
    list.fetchNextPage,
  ]);
  const targetStream = useMemo<DisplayStreamTarget>(
    () => ({ kind: "subagent", threadId, agentId }),
    [threadId, agentId],
  );
  const store = useMemo(() => client.stream(targetStream), [client, targetStream]);
  useEffect(() => {
    if (!open || !foreground || !agentId) return;
    return client.observeStream(targetStream);
  }, [client, targetStream, open, foreground, agentId]);
  const slotIds = useSlotIds(store);
  const slot = useSlot(store, slotIds.at(-1));
  const subscribe = useCallback(
    (listener: () => void) => {
      const stopStore = store.subscribe(listener);
      const stopClient = client.subscribe((event) => {
        if (event.kind === "removed" || event.kind === "connection") listener();
      });
      return () => {
        stopStore();
        stopClient();
      };
    },
    [client, store],
  );
  const getError = useCallback(() => client.streamError(targetStream), [client, targetStream]);
  const streamError = useSyncExternalStore(subscribe, getError, getError);
  const checkpoint = useCallback(() => !!store.checkpoint, [store]);
  const ready = useSyncExternalStore(subscribe, checkpoint, checkpoint);
  const turn = slot?.kind === "ready" ? slot : undefined;
  const selected = streamAgentSummary(target, turn);
  const loading = resolving || (agentId ? !ready && !streamError : list.isPending);
  const missing =
    targetId && !target && !resolving ? "Subagent is no longer available." : undefined;
  const error = list.error?.message ?? streamError ?? missing;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const moreHistory = !!turn?.partsCursor;
  const loadHistory = () => {
    if (!turn || loadingHistory) return;
    setLoadingHistory(true);
    void client
      .loadStreamTurnPage(targetStream, turn.slotId)
      .finally(() => setLoadingHistory(false));
  };
  const actions = panels.getState();
  return (
    <SubagentPanelView
      embedded={embedded}
      items={items}
      selected={selected}
      messages={turn?.messages}
      streamedTurn={turn}
      resourceUrl={resourceUrl}
      streamTarget={targetStream}
      loading={loading}
      error={error}
      onSelect={(id) => actions.select(threadId, id)}
      onBack={actions.back}
      hasMore={agentId ? moreHistory : list.hasNextPage}
      loadingMore={agentId ? loadingHistory : list.isFetchingNextPage}
      onMore={() => {
        if (agentId) loadHistory();
        else void list.fetchNextPage();
      }}
    />
  );
}

function streamAgentSummary(agent: SubagentSummary | undefined, turn: ReadyTurnSlot | undefined) {
  if (!agent || !turn) return agent;
  const state = turn.state === "pending" || !turn.state ? "running" : turn.state;
  const titles = {
    complete: "Completed",
    failed: "Failed",
    canceled: "Canceled",
    running: agent.title,
  };
  return { ...agent, state, title: titles[state] };
}

export function SubagentPanelView({
  embedded,
  items,
  selected,
  messages = [],
  streamedTurn,
  streamTarget,
  resourceUrl = transcriptServices.resourceUrl,
  loading,
  error,
  unavailable,
  onSelect,
  onBack,
  hasMore,
  loadingMore,
  onMore,
}: {
  embedded?: boolean;
  items: readonly SubagentSummary[];
  selected?: SubagentSummary;
  messages?: readonly DisplayMessage[];
  streamedTurn?: ReadyTurnSlot;
  streamTarget?: DisplayStreamTarget;
  resourceUrl?: MessageServices["resourceUrl"];
  loading?: boolean;
  error?: string;
  unavailable?: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
}) {
  const services = useMemo(() => ({ ...transcriptServices, resourceUrl }), [resourceUrl]);
  const identity = useContext(MessageIdentityContext);
  const transcriptIdentity = useMemo(
    () => ({
      ...identity,
      viewerId: undefined,
      promptingAgent: identity.agent,
      agent: {
        displayName: selected ? subagentProfileName(selected.profile) : "Agent",
        agentProfile: selected?.profile,
      },
    }),
    [identity, selected?.profile],
  );
  const turn = useMemo<ReadyTurnSlot | undefined>(() => {
    if (streamedTurn) return streamedTurn;
    if (!selected) return undefined;
    // The transcript splits long prompts into consecutive user messages.
    const firstResponse = messages.findIndex((message) => message.role !== "user");
    const promptChunks = messages.slice(0, firstResponse < 0 ? messages.length : firstResponse);
    const transcript =
      promptChunks.length > 1
        ? [
            { ...promptChunks[0]!, parts: promptChunks.flatMap((message) => message.parts) },
            ...messages.slice(promptChunks.length),
          ]
        : messages;
    // Transcript projection has no final-phase metadata. The completed reply follows the last activity or prompt.
    const lastWork = transcript.findLastIndex(
      (message) =>
        message.role !== "assistant" || message.parts.some((part) => part.type !== "text"),
    );
    return {
      kind: "ready",
      slotId: selected.id,
      turnId: selected.id,
      position: 0,
      state: selected.state,
      startedAt: selected.startedAt,
      messages: transcript.map((message, index) =>
        selected.state === "complete" && index > lastWork
          ? { ...message, metadata: { ...message.metadata, phase: "final" } }
          : message,
      ),
    };
  }, [selected, messages, streamedTurn]);
  const more =
    hasMore && !streamedTurn ? (
      <Button variant="ghost" disabled={loadingMore} onClick={onMore}>
        {selected ? "Load older messages" : "Load more agents"}
      </Button>
    ) : null;
  return (
    <aside
      className="subagent-panel flex flex-col min-w-0 h-full bg-sidebar text-sidebar-foreground"
      aria-label="Subagents"
    >
      {selected || !embedded ? (
        <header className="subagent-panel-header flex items-center gap-2 h-8 flex-none px-2 pr-[calc(calc(var(--ui-space-unit)*3)_+_var(--ui-control-compact)_+_calc(var(--ui-space-unit)*2))]">
          {selected ? (
            <IconButton label="Back to agents" onClick={onBack}>
              <ArrowLeft />
            </IconButton>
          ) : (
            <Bot />
          )}
          <h2 title={selected?.name}>
            {selected ? (selected.taskTitle ?? subagentProfileName(selected.profile)) : "Agents"}
          </h2>
          {selected ? (
            <span className="subagent-status flex flex-1 gap-1.5 items-center min-w-0 text-muted-foreground text-xs">
              <AgentStatus agent={selected} />
              <StatusTitle agent={selected} />
            </span>
          ) : null}
        </header>
      ) : null}
      {error ? (
        <p className="subagent-notice p-3 text-muted-foreground text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="subagent-notice p-3 text-muted-foreground text-sm" role="status">
          Loading…
        </p>
      ) : null}
      {selected ? (
        <div
          className="subagent-transcript flex-1 flex flex-col-reverse overflow-y-auto overflow-x-hidden min-h-0 bg-background"
          role="region"
          aria-label="Subagent transcript"
          tabIndex={0}
        >
          <div className="subagent-transcript-content shrink-0 flex flex-col gap-4 p-3 min-w-0">
            {more}
            {unavailable ? (
              <p className="subagent-notice p-3 text-muted-foreground text-sm">
                Transcript unavailable.
              </p>
            ) : null}
            {!loading && !unavailable && messages.length === 0 ? (
              <p className="subagent-notice p-3 text-muted-foreground text-sm">
                Waiting for the first message…
              </p>
            ) : null}
            <DisplayStreamContext value={streamTarget}>
              <MessageIdentityContext value={transcriptIdentity}>
                <MessageServicesContext value={services}>
                  {turn && messages.length > 0 ? (
                    <Turn
                      key={turn.turnId}
                      slot={turn}
                      animateArrivals={false}
                      onRewind={ignoreTurnAction}
                      onLoadMore={onMore ?? ignoreTurnAction}
                    />
                  ) : null}
                </MessageServicesContext>
              </MessageIdentityContext>
            </DisplayStreamContext>
          </div>
        </div>
      ) : (
        <div className="subagent-list overflow-auto min-h-0 flex-1 p-2">
          {!loading && !error && items.length === 0 ? (
            <div className="subagent-empty flex items-center flex-col justify-center text-center gap-3 min-h-56 text-muted-foreground p-4">
              <Bot />
              <p>No subagents yet</p>
              <span>Agents spawned in this conversation appear here.</span>
            </div>
          ) : null}
          {items.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              className="subagent-card flex items-start justify-start w-full h-auto p-3 text-left gap-3"
              onClick={() => onSelect(agent.id)}
            >
              <AgentAvatar
                decorative
                profile={agent.profile}
                displayName={subagentProfileName(agent.profile)}
                size="sm"
              />
              <span>
                <strong>{agent.taskTitle ?? subagentProfileName(agent.profile)}</strong>
                <span className="subagent-name overflow-hidden text-ellipsis whitespace-nowrap">
                  {agent.model ? (
                    <span
                      className="flex items-center gap-1"
                      title={`${agent.model} · ${agent.profile}`}
                    >
                      <ProviderIcon provider={agent.model.split("/")[0] ?? ""} />
                      {agent.model.split("/").slice(1).join("/")} · {agent.profile}
                    </span>
                  ) : (
                    agent.name
                  )}
                </span>
                <span className="subagent-status flex gap-2 items-center min-w-0 text-muted-foreground text-sm">
                  <AgentStatus agent={agent} />
                  <StatusTitle agent={agent} />
                </span>
              </span>
            </Button>
          ))}
          {more}
        </div>
      )}
    </aside>
  );
}

function StatusTitle({ agent }: { agent: SubagentSummary }) {
  if (agent.state === "running") return <WorkingText>{agent.title}</WorkingText>;
  return <span>{agent.title}</span>;
}

function AgentStatus({ agent }: { agent: SubagentSummary }) {
  if (agent.state === "running") return <LoadingSpinner />;
  if (agent.state === "complete") return <CircleCheck />;
  return <CircleAlert />;
}

export function RightPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="right-panel-toggle">
      <PanelToggleButton
        shortcut="rightPanel"
        label={open ? "Hide right panel" : "Show right panel"}
        open={open}
        onToggle={onToggle}
      >
        {open ? <PanelRightClose /> : <PanelRightOpen />}
      </PanelToggleButton>
    </div>
  );
}
