import type { OptimisticTurn } from "../optimistic-turns";
import { WorkspacePanels, WorkspaceSidePanel } from "./WorkspacePanels";
import { useMemo, useLayoutEffect } from "react";
import { useStore } from "zustand";
import { demoSubagents, demoSubagentTranscript } from "../agent-work-fixtures";
import { createPanelStore, defaultRightPanel } from "../panel-store";
import { SubagentContext } from "./subagent-context";
import { SubagentPanelView, RightPanelToggle } from "./SubagentPanel";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import {
  agentWorkStages,
  demoQuestion,
  rebaseWorkflowTimes,
  workflowActionFrame,
  type AgentWorkFrame,
} from "../agent-work-fixtures";
import { MessageIdentityContext } from "./message-identity";
import { QuestionReplyContext, type MessageServices } from "./message-services";
import { useQuestionReplyDemo } from "./QuestionDemo";
import { QuestionWaiting } from "./QuestionReply";
import { Timeline } from "./Timeline";
import { FileViewerContext } from "./file-viewer-context";
import demoRouteImage from "../assets/logo.svg";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import { StreamingModeSelect, type StreamingMode } from "./StreamingSettings";
import { Composer } from "./Composer";
import { Button } from "./ui/button";
import { IconButton } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// The demo resolves attached file paths to a bundled image instead of a workspace file.
const demoFileViewer = {
  threadId: "demo",
  openFile: () => {},
  resolveFile: async (path: string) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    mediaType: "image/svg+xml",
    href: demoRouteImage,
  }),
};

const identities = {
  viewerId: "demo_user",
  agent: { displayName: "Lilac" },
  users: new Map([
    ["demo_user", { displayName: "Alex Chen" }],
    ["demo_other_user", { displayName: "Morgan Lee" }],
  ]),
};

export function AgentWorkDemo() {
  const [panel] = useState(createPanelStore);
  const [streaming, setStreaming] = useState<StreamingMode>("paragraph");
  const panelLayout = useStore(panel, (state) => state.threads.get("demo") ?? defaultRightPanel);
  const panelOpen = panelLayout.open;
  const panelSelection = useStore(panel, (state) => state.selection);
  const [playhead, setPlayhead] = useState({ stage: 0, frame: 0, playing: false });
  const [store] = useState(() => new NativeThreadStore());
  const revision = useRef(0);
  const client = useMemo(
    () => ({
      thread: () => store,
      hydrate: async () => {},
      loadTurnPage: async () => {},
      subscribe: () => () => {},
    }),
    [store],
  );
  const [text, setText] = useState("Compare a riverside walk with a museum visit for Saturday.");
  const [run, setRun] = useState(0);
  const [sent, setSent] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticTurn>();
  const [promptText, setPromptText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [workflowOverride, setWorkflowOverride] = useState<AgentWorkFrame>();
  const container = useRef<HTMLDivElement>(null);
  const stage = agentWorkStages[playhead.stage]!;
  const frames = useMemo(
    () =>
      streaming === "paragraph"
        ? stage.frames
        : stage.frames.filter(
            (frame) =>
              frame.state !== "running" ||
              !frame.messages.some((message) => message.metadata?.phase === "final"),
          ),
    [stage, streaming],
  );
  const slot =
    workflowOverride ?? frames[Math.min(playhead.frame, frames.length - 1)] ?? stage.frames.at(-1)!;
  const [stageStartedAt, setStageStartedAt] = useState(Date.now);
  useLayoutEffect(() => setStageStartedAt(Date.now()), [stage.id, run]);
  useLayoutEffect(() => {
    const { following, ...turn } = slot;
    const messages = turn.messages.map((message) => ({
      ...message,
      id: stage.id === "conversation" ? `${message.id}_${run}` : message.id,
      parts:
        message.role === "user" && promptText && stage.id === "conversation"
          ? [{ type: "text" as const, text: promptText }]
          : message.parts.map((part) =>
              "id" in part && stage.id === "conversation"
                ? { ...part, id: `${part.id}_${run}` }
                : part,
            ),
    }));
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: ++revision.current,
        cursor: `demo_${revision.current}`,
      },
      slots:
        stage.id === "conversation" && !sent
          ? []
          : [
              rebaseWorkflowTimes(
                {
                  ...turn,
                  messages,
                  // Running stages count up from when they appear instead of from the fixture date.
                  ...(turn.settledAt === undefined ? { startedAt: stageStartedAt } : {}),
                },
                stageStartedAt,
              ),
              ...(following ? [rebaseWorkflowTimes(following, stageStartedAt)] : []),
            ],
    });
  }, [store, slot, stage.id, sent, promptText, run, stageStartedAt]);
  const agents = useMemo(() => demoSubagents(slot), [slot]);
  const selectedAgent = agents.find((agent) => agent.id === panelSelection?.agentId);
  const agentContext = useMemo(
    () => ({
      agents: new Map(agents.map((agent) => [agent.activityId, agent])),
      open: (id: string) => panel.getState().select("demo", id),
    }),
    [agents, panel],
  );
  useEffect(() => {
    if (!playhead.playing) return;
    const timer = window.setTimeout(
      () => {
        setPlayhead((current) => {
          if (current.frame + 1 < frames.length) return { ...current, frame: current.frame + 1 };
          if (stage.id === "conversation" || stage.id === "workflow")
            return { ...current, playing: false };
          if (current.stage + 1 < agentWorkStages.length)
            return { ...current, stage: current.stage + 1, frame: 0 };
          return { ...current, playing: false };
        });
      },
      frames.length > 1 ? 1400 : 2200,
    );
    return () => window.clearTimeout(timer);
  }, [playhead, stage, frames]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const pause = () =>
      setPlayhead((current) => (current.playing ? { ...current, playing: false } : current));
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) pause();
    });
    const onVisibilityChange = () => {
      if (document.hidden) pause();
    };
    observer.observe(element);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  function select(index: number) {
    setPlayhead({ stage: index, frame: 0, playing: false });
    setSent(false);
    setOptimistic(undefined);
    setFeedback("");
    setWorkflowOverride(undefined);
  }
  function togglePlayback() {
    setOptimistic(undefined);
    setFeedback("");
    setWorkflowOverride(undefined);
    setSent(true);
    setPlayhead((current) => {
      if (current.playing) return { ...current, playing: false };
      if (
        (stage.id === "conversation" || stage.id === "workflow") &&
        current.frame === frames.length - 1
      )
        return { ...current, frame: 0, playing: true };
      if (current.stage === agentWorkStages.length - 1)
        return { stage: 0, frame: 0, playing: true };
      return { ...current, playing: true };
    });
  }
  function selectFrame(index: number) {
    setPlayhead((current) => ({ ...current, frame: index, playing: false }));
    setSent(true);
    setOptimistic(undefined);
    setFeedback("");
    setWorkflowOverride(undefined);
  }
  const onAction: MessageServices["onAction"] = (_messageId, part, actionId) => {
    const updated = workflowActionFrame(slot, actionId);
    if (updated) {
      setWorkflowOverride(updated);
      setPlayhead((current) => ({ ...current, playing: false }));
      return;
    }
    setFeedback(
      `Selected: ${part.data.actions.find((action) => action.actionId === actionId)?.label ?? actionId}`,
    );
  };
  const asking =
    !workflowOverride &&
    slot.messages.some((message) =>
      message.parts.some(
        (part) => part.type === "data-question" && part.data.view.state === "pending",
      ),
    );
  const [answering, setAnswering] = useState(true);
  // Answering settles the card as the server's replay would; the reply text shows below the demo.
  function settleQuestion(
    reply?: string,
    summary?: Extract<typeof demoQuestion.view, { state: "answered" }>["summary"],
  ) {
    setWorkflowOverride({
      ...slot,
      messages: slot.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "data-question"
            ? {
                ...part,
                data: {
                  ...part.data,
                  view: summary
                    ? { state: "answered" as const, summary }
                    : { state: "cancelled" as const },
                },
              }
            : part,
        ),
      })),
    });
    question.reset();
    setFeedback(reply ? `Sent: ${reply.replaceAll("\n\n", " · ")}` : "Question dismissed.");
  }
  const question = useQuestionReplyDemo(demoQuestion, settleQuestion);
  const replying = asking && answering;
  function questionHeader() {
    if (replying)
      return question.panel({
        onExit: () => setAnswering(false),
        onDismiss: () => settleQuestion(),
      });
    if (!asking) return undefined;
    return <QuestionWaiting waiting={[demoQuestion]} onReply={() => setAnswering(true)} />;
  }
  const services: MessageServices = {
    canEdit: true,
    resourceUrl: () => "",
    onAction,
    onReaction: () => {},
    questions: {
      onReply: () => setAnswering(true),
      onDismiss: async () => {
        settleQuestion();
        return undefined;
      },
    },
  };
  return (
    <div className="ds-agent-demo flex flex-col gap-4 min-w-0" ref={container}>
      <div className="ds-agent-controls flex items-center justify-between flex-wrap gap-3">
        <Select
          items={agentWorkStages.map((item) => ({ value: item.id, label: item.label }))}
          value={stage.id}
          onValueChange={(id) => {
            const index = agentWorkStages.findIndex((item) => item.id === id);
            if (index >= 0) select(index);
          }}
        >
          <SelectTrigger aria-label="Agent demo stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentWorkStages.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ds-row flex items-center flex-wrap gap-2">
          <StreamingModeSelect
            value={streaming}
            disabled={playhead.playing}
            onChange={(mode) => {
              setStreaming(mode);
              select(0);
            }}
          />
          <IconButton
            label="Previous stage"
            disabled={playhead.stage === 0}
            onClick={() => select(playhead.stage - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <Button variant="secondary" onClick={togglePlayback}>
            {playhead.playing ? <Pause /> : <Play />}
            {playhead.playing ? "Pause" : "Play stages"}
          </Button>
          <IconButton
            label="Next stage"
            disabled={playhead.stage === agentWorkStages.length - 1}
            onClick={() => select(playhead.stage + 1)}
          >
            <ChevronRight />
          </IconButton>
          <IconButton label="Restart demo" onClick={() => select(0)}>
            <RotateCcw />
          </IconButton>
        </div>
      </div>
      <div className="ds-agent-caption" role="status">
        <span className="ds-state-label">
          {playhead.stage + 1} / {agentWorkStages.length} · {stage.label}
        </span>
        <p className="ds-muted">{stage.description}</p>
      </div>
      {frames.length > 1 ? (
        <div className="ds-row flex items-center gap-2">
          <IconButton
            label="Previous frame"
            disabled={playhead.frame === 0}
            onClick={() => selectFrame(playhead.frame - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <span className="ds-muted">
            Frame {Math.min(playhead.frame + 1, frames.length)} / {frames.length}
          </span>
          <IconButton
            label="Next frame"
            disabled={playhead.frame >= frames.length - 1}
            onClick={() => selectFrame(playhead.frame + 1)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      ) : null}
      <SubagentContext value={agentContext}>
        <div
          className={`ds-agent-workspace h-144 max-h-[70dvh] overflow-clip relative [border:1px_solid_var(--ui-border)] rounded-lg ${panelOpen ? "" : "right-panel-hidden"}`}
        >
          <RightPanelToggle open={panelOpen} onToggle={() => panel.getState().toggle("demo")} />
          <WorkspacePanels rightOpen={panelOpen} rightWidth={panelLayout.width}>
            <div className="chat-panel flex flex-col">
              <MessageIdentityContext value={identities}>
                <FileViewerContext value={demoFileViewer}>
                  <QuestionReplyContext
                    value={{ messageId: replying ? demoQuestion.questionCallId : undefined }}
                  >
                    <Timeline
                      optimisticTurn={optimistic}
                      onOptimisticResolved={() => setOptimistic(undefined)}
                      client={client}
                      threadId="demo"
                      {...services}
                      onRewind={() => select(0)}
                      emptyMessage="Send a message to start the demo."
                      footer={
                        <div className="p-4">
                          {optimistic && !optimistic.confirmedSlotId ? (
                            <Button
                              variant="secondary"
                              onClick={() => {
                                setOptimistic({ ...optimistic, confirmedSlotId: slot.slotId });
                                setSent(true);
                                setPlayhead({ stage: 0, frame: 0, playing: true });
                              }}
                            >
                              Confirm send
                            </Button>
                          ) : null}
                          <Composer
                            documentKey={replying ? question.documentKey : "demo"}
                            text={replying ? question.text : text}
                            onText={replying ? question.onText : setText}
                            header={questionHeader()}
                            placeholder={replying ? question.placeholder : undefined}
                            answer={replying ? question.answer : undefined}
                            skillIds={[]}
                            onSkills={() => {}}
                            onCommand={() => {}}
                            attachments={[]}
                            onAttach={() => {}}
                            onRemoveAttachment={() => {}}
                            onRetryAttachment={() => {}}
                            active={
                              (stage.id !== "conversation" || sent) &&
                              (slot.state === "pending" || slot.state === "running")
                            }
                            canCancel={
                              playhead.playing &&
                              (slot.state === "pending" || slot.state === "running")
                            }
                            disabled={!!optimistic}
                            windowDrop={false}
                            onModelChange={() => {}}
                            onCancel={() =>
                              setPlayhead((current) => ({ ...current, playing: false }))
                            }
                            onSubmit={(submission) => {
                              setWorkflowOverride(undefined);
                              setRun((value) => value + 1);
                              setPromptText(submission.text);
                              setText("");
                              setOptimistic({
                                precedingSlotIds: [],
                                slot: {
                                  kind: "ready",
                                  slotId: `sending:demo:${run + 1}`,
                                  turnId: `sending:demo:${run + 1}`,
                                  position: 0,
                                  state: "pending",
                                  messages: [
                                    {
                                      id: `demo-command:${run + 1}`,
                                      role: "user",
                                      metadata: { authorId: "demo_user" },
                                      parts: [{ type: "text", text: submission.text }],
                                    },
                                  ],
                                },
                              });
                              setSent(false);
                              setPlayhead({ stage: 0, frame: 0, playing: false });
                            }}
                          />
                        </div>
                      }
                    />
                  </QuestionReplyContext>
                </FileViewerContext>
              </MessageIdentityContext>
            </div>
            <WorkspaceSidePanel
              side="right"
              open={panelOpen}
              id="demo-agents-panel"
              onWidthChange={(width) => panel.getState().resize("demo", width)}
              label="Demo agents panel width"
            >
              <SubagentPanelView
                items={agents}
                selected={selectedAgent}
                messages={selectedAgent ? demoSubagentTranscript(selectedAgent) : []}
                onSelect={agentContext.open}
                onBack={panel.getState().back}
              />
            </WorkspaceSidePanel>
          </WorkspacePanels>
        </div>
      </SubagentContext>
      <p className="ds-feedback min-h-6 text-sm text-muted-foreground" role="status">
        {feedback}
      </p>
    </div>
  );
}
