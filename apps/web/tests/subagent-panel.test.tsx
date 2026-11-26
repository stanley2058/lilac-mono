import { mergeSubagentTranscript, type SubagentTranscriptPage } from "../src/queries";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentWorkStages, demoSubagents, demoSubagentTranscript } from "../src/agent-work-fixtures";
import { AgentSidebarView, SubagentPanelView } from "../src/components/SubagentPanel";
import {
  agentTabTarget,
  subagentContextValue,
  subagentRelations,
} from "../src/components/subagent-context";
import { nestedAgentsLabel, subagentTitle } from "../src/components/NestedAgents";
import { createPanelStore, defaultRightPanel } from "../src/panel-store";

const actions = { onSelect: () => {} };
const slot = agentWorkStages.find((stage) => stage.id === "subagents-working")!.frames[0]!;
const agents = demoSubagents(slot);
const nestedSlot = agentWorkStages.find((stage) => stage.id === "subagents-nested")!.frames[0]!;
const nestedAgents = demoSubagents(nestedSlot);

test("each agent opens its own tab beside a single Agents tab", () => {
  const store = createPanelStore();
  const tabIds = () =>
    store
      .getState()
      .tabs.get("thread")
      ?.items.map((tab) => tab.id);
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(false);
  const [parent, child] = demoSubagents(nestedSlot);
  store.getState().openAgent("thread", agentTabTarget(parent!));
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(true);
  store.getState().openAgent("thread", agentTabTarget(child!));
  store.getState().openAgents("thread");
  store.getState().openAgent("thread", agentTabTarget(parent!));
  expect(tabIds()).toEqual(["agents", `agent:${parent!.id}`, `agent:${child!.id}`]);
  expect(store.getState().tabs.get("thread")?.activeId).toBe(`agent:${parent!.id}`);
  store.getState().toggle("thread");
  store.getState().toggle("thread");
  expect(store.getState().tabs.get("thread")?.activeId).toBe(`agent:${parent!.id}`);
  store.getState().closeTab("thread", `agent:${child!.id}`);
  expect(tabIds()).toEqual(["agents", `agent:${parent!.id}`]);
});

test("shared panel shows agent status and production messages without editing controls", () => {
  for (const state of ["running", "complete"] as const) {
    const selected = {
      ...agents[0]!,
      state,
      title: state === "running" ? "Thinking…" : "Completed",
    };
    const messages = demoSubagentTranscript(selected).map((message) => ({
      ...message,
      metadata: undefined,
    }));
    const html = renderToStaticMarkup(
      <SubagentPanelView items={agents} selected={selected} messages={messages} {...actions} />,
    );
    expect(html).toContain("Subagent transcript");
    expect(html).toContain(`title="${selected.name}"`);
    expect(html).toContain(selected.title);
    expect(html).toContain('aria-label="About Lilac"');
    expect(html).not.toContain("Participant");
    expect(html).toContain('data-message-id="child_0_0_0"');
    if (state === "running") {
      expect(html).toContain('data-message-id="child_1_0"');
      expect(html.match(/class="activity-group/g)).toHaveLength(1);
    } else {
      expect(html).toContain("Worked");
      expect(html).toContain('data-message-id="child_3_0_0"');
      expect(html).not.toContain('data-message-id="child_1_1"');
    }
    expect(html).not.toContain('contenteditable="true"');
    expect(html).not.toContain("Rewind to this turn");
    expect(html).toContain("Copy message");
  }
  const empty = renderToStaticMarkup(<SubagentPanelView items={[]} {...actions} />);
  expect(empty).toContain("No subagents yet");
});

test("live refresh retains loaded tail messages and catches up without gaps after reopening", () => {
  const page = (offset: number, end: number, total = end): SubagentTranscriptPage => ({
    agent: agents[0]!,
    offset,
    total,
    unavailable: false,
    nextBefore: offset || undefined,
    messages: Array.from({ length: end - offset }, (_, i) => ({
      id: `message_${offset + i}`,
      role: "assistant",
      parts: [{ type: "text", text: String(offset + i) }],
    })),
  });
  const initial = page(80, 100);
  const update = mergeSubagentTranscript(initial, page(80, 120, 150));
  expect(update.messages).toHaveLength(40);
  expect(update.offset).toBe(80);
  expect(update.nextBefore).toBe(80);
  const caughtUp = mergeSubagentTranscript(update, page(100, 140, 150));
  const complete = mergeSubagentTranscript(caughtUp, page(120, 150));
  expect(complete.messages.map((message) => message.id)).toEqual(
    page(80, 150).messages.map((message) => message.id),
  );
  const older = page(60, 80).messages;
  expect([...older, ...complete.messages]).toHaveLength(90);
  expect(complete.total).toBe(150);
  const reset = mergeSubagentTranscript(complete, page(10, 30));
  expect(reset).toEqual(page(10, 30));
});

test("nested agents take a color apart from their parent", () => {
  const { colors, children } = subagentRelations(nestedAgents);
  const plan = nestedAgents.find((agent) => agent.id === "demo_subagent_plan")!;
  const nested = children.get(plan.id)!;
  expect(nested.map((agent) => agent.parentId)).toEqual([plan.id, plan.id]);
  for (const agent of nested) expect(colors.get(agent.id)).not.toBe(colors.get(plan.id));
  expect(subagentRelations(nestedAgents).colors).toEqual(colors);
});

test("a delegating agent row names its running agents instead of the raw progress label", () => {
  expect(subagentTitle("subagent (full; codex/gpt [high]; 1/2 done)\n`- > read a")).toBe(
    "Delegating to Full Agent",
  );
  expect(nestedAgentsLabel([{ ...nestedAgents[1]!, state: "complete" }, nestedAgents[2]!])).toBe(
    "1 of 2 agents running",
  );
});

test("a tab opened by activity ID converges on the agent's run tab", () => {
  const store = createPanelStore();
  const [parent, child] = demoSubagents(nestedSlot);
  const alias = { ...agentTabTarget(child!), agentId: "activity-child" };
  store.getState().openAgent("thread", alias);
  store.getState().resolveAgent("thread", "activity-child", agentTabTarget(child!));
  expect(store.getState().tabs.get("thread")).toEqual({
    items: [
      { id: "agents", type: "agents" },
      { id: `agent:${child!.id}`, type: "agent", ...agentTabTarget(child!) },
    ],
    activeId: `agent:${child!.id}`,
  });
  store.getState().openAgent("thread", alias);
  store.getState().openAgent("thread", agentTabTarget(parent!));
  store.getState().resolveAgent("thread", "activity-child", agentTabTarget(child!));
  expect(
    store
      .getState()
      .tabs.get("thread")
      ?.items.map((tab) => tab.id),
  ).toEqual(["agents", `agent:${child!.id}`, `agent:${parent!.id}`]);
  expect(store.getState().tabs.get("thread")?.activeId).toBe(`agent:${parent!.id}`);
});

test("opening a loaded agent merges a hidden tab opened under its activity ID", () => {
  const store = createPanelStore();
  const [, child] = demoSubagents(nestedSlot);
  store
    .getState()
    .openAgent("thread", { ...agentTabTarget(child!), agentId: child!.activityId + "-pending" });
  store.getState().openAgents("thread");
  store.getState().openAgent("thread", agentTabTarget(child!), child!.activityId + "-pending");
  expect(store.getState().tabs.get("thread")).toEqual({
    items: [
      { id: "agents", type: "agents" },
      { id: `agent:${child!.id}`, type: "agent", ...agentTabTarget(child!) },
    ],
    activeId: `agent:${child!.id}`,
  });
});

test("follow-up runs of one child session show as one agent", () => {
  const [first] = agents;
  const followUp = {
    ...first!,
    id: `${first!.id}_follow_up`,
    firstRunId: first!.id,
    activityId: `${first!.activityId}_follow_up`,
    model: "openai/gpt-follow-up",
    startedAt: first!.startedAt + 1000,
  };
  const items = [followUp, ...agents];
  const relations = subagentRelations(items);
  expect(relations.latest.get(first!.id)).toBe(followUp);
  expect(relations.colors.get(followUp.id)).toBe(relations.colors.get(first!.id));
  // An earlier page holding the first run does not change the agent's color.
  expect(subagentRelations([followUp]).colors.get(followUp.id)).toBe(
    relations.colors.get(followUp.id),
  );
  const list = renderToStaticMarkup(<SubagentPanelView items={items} {...actions} />);
  expect(list.match(/subagent-card/g)).toHaveLength(agents.length);
  expect(list).toContain("gpt-follow-up");
  const sidebar = renderToStaticMarkup(
    <AgentSidebarView items={items} activeId={followUp.id} onSelect={() => {}} />,
  );
  expect(sidebar.match(/aria-current="page"/g)).toHaveLength(1);
  expect(sidebar.match(/<button/g)).toHaveLength(agents.length);

  const opened: string[] = [];
  subagentContextValue(items, (agent) => opened.push(agent.agentId)).open(agentTabTarget(first!));
  expect(opened).toEqual([followUp.id]);
});

test("a delegating agent counts each nested child session once", () => {
  const plan = nestedAgents.find((agent) => agent.id === "demo_subagent_plan")!;
  const [child] = nestedAgents.filter((agent) => agent.parentId === plan.id);
  const finished = { ...child!, state: "complete" as const };
  const followUp = {
    ...child!,
    id: `${child!.id}_follow_up`,
    firstRunId: child!.id,
    activityId: `${child!.activityId}_follow_up`,
    startedAt: child!.startedAt + 1000,
  };
  const items = nestedAgents.map((agent) => (agent === child ? finished : agent));
  const { children } = subagentRelations([...items, followUp]);
  const nested = children.get(plan.id)!;
  expect(nested).toHaveLength(nestedAgents.filter((agent) => agent.parentId === plan.id).length);
  expect(nested).toContain(followUp);
  expect(nested).not.toContain(finished);
});

test("every run of a nested child session shares one color", () => {
  const plan = nestedAgents.find((agent) => agent.id === "demo_subagent_plan")!;
  const [child] = nestedAgents.filter((agent) => agent.parentId === plan.id);
  // This follow-up was sent by a parent run that is not loaded.
  const followUp = {
    ...child!,
    id: `${child!.id}_follow_up`,
    firstRunId: child!.id,
    previousId: child!.id,
    parentId: "unloaded_parent_run",
    activityId: `${child!.activityId}_follow_up`,
  };
  const { colors, latest } = subagentRelations([...nestedAgents, followUp]);
  expect(colors.get(followUp.id)).toBe(colors.get(child!.id));
  expect(latest.get(child!.id)).toBe(followUp);
});

test("tied follow-ups pick the run no other run continues", () => {
  const [first] = agents;
  const followUp = (suffix: string, previousId: string) => ({
    ...first!,
    id: `${first!.id}_${suffix}`,
    firstRunId: first!.id,
    previousId,
    activityId: `${first!.activityId}_${suffix}`,
  });
  const older = followUp("older", first!.id);
  const newest = followUp("newest", older.id);
  expect(subagentRelations([older, newest, first!]).latest.get(first!.id)).toBe(newest);
});
