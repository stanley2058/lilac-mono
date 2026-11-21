import { mergeSubagentTranscript, type SubagentTranscriptPage } from "../src/queries";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentWorkStages, demoSubagents, demoSubagentTranscript } from "../src/agent-work-fixtures";
import { AgentSidebarView, SubagentPanelView } from "../src/components/SubagentPanel";
import {
  agentTabTarget,
  SubagentContext,
  subagentContextValue,
  subagentRelations,
} from "../src/components/subagent-context";
import { nestedAgentsLabel, subagentTitle } from "../src/components/NestedAgents";
import { ActivityItem } from "../src/components/ActivityLog";
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

test("the expanded agent sidebar lists delegated agents under their parent", () => {
  const ordered = [...nestedAgents].reverse();
  const html = renderToStaticMarkup(
    <AgentSidebarView items={ordered} activeId="demo_subagent_tickets" onSelect={() => {}} />,
  );
  const titles = [...html.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
  expect(titles).toEqual([
    "Plan the museum visit",
    "Find ticket prices",
    "Check exhibit hours",
    "Check the weather",
  ]);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain("var(--ui-space-unit) * 6");
});

test("agent preview uses an agent avatar and readable profile and work title, with no raw tool tree", () => {
  const agent = agents[0]!;
  const part = slot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "data-activity" && part.id === agent.activityId)!;
  if (part.type !== "data-activity") throw new Error("Missing agent activity");
  const html = renderToStaticMarkup(
    <SubagentContext value={subagentContextValue([agent], () => {})}>
      <ActivityItem part={part} />
    </SubagentContext>,
  );
  expect(html).toContain('data-agent-profile="explore"');
  expect(html).toContain(agent.taskTitle!);
  expect(html).toContain(agent.profile);
  expect(html).toContain(agent.title.replaceAll("&", "&amp;").replaceAll('"', "&quot;"));
  expect(html).not.toContain("subagent (explore;");
  expect(html).not.toMatch(/\sdisabled(?:=|\s|>)/);
  const unresolved = renderToStaticMarkup(<ActivityItem part={part} />);
  expect(unresolved).not.toMatch(/\sdisabled(?:=|\s|>)/);
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

test("completed transcripts keep every initial prompt chunk outside folded work", () => {
  const selected = { ...agents[0]!, state: "complete" as const };
  const messages = demoSubagentTranscript(selected);
  const html = renderToStaticMarkup(
    <SubagentPanelView
      items={agents}
      selected={selected}
      messages={[
        { id: "prompt_0", role: "user", parts: [{ type: "text", text: "x".repeat(2000) }] },
        {
          id: "prompt_2000",
          role: "user",
          parts: [{ type: "text", text: "End of the long prompt." }],
        },
        ...messages.slice(1),
      ]}
      {...actions}
    />,
  );
  expect(html).toContain("x".repeat(2000) + "End of the long prompt.");
  expect(html).toContain("Worked");
  expect(html).not.toContain('data-message-id="child_1_0"');
});

test("nested agents take a color apart from their parent", () => {
  const { colors, children } = subagentRelations(nestedAgents);
  const plan = nestedAgents.find((agent) => agent.id === "demo_subagent_plan")!;
  const nested = children.get(plan.id)!;
  expect(nested.map((agent) => agent.parentId)).toEqual([plan.id, plan.id]);
  for (const agent of nested) expect(colors.get(agent.id)).not.toBe(colors.get(plan.id));
  expect(subagentRelations(nestedAgents).colors).toEqual(colors);
});

test("a delegating agent row stacks its running agents instead of the raw progress label", () => {
  const part = nestedSlot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "data-activity" && part.id === "demo_subagent_plan")!;
  if (part.type !== "data-activity") throw new Error("Missing agent activity");
  const html = renderToStaticMarkup(
    <SubagentContext value={subagentContextValue(nestedAgents, () => {})}>
      <ActivityItem part={part} />
    </SubagentContext>,
  );
  expect(html).toContain("Plan the museum visit");
  expect(html).toContain("2 agents running");
  expect(html.match(/\bnested-agents\b/g)).toHaveLength(1);
  expect(html.match(/data-agent-color=/g)).toHaveLength(3);
  expect(html).not.toContain("subagent (");
  expect(subagentTitle("subagent (full; codex/gpt [high]; 1/2 done)\n`- > read a")).toBe(
    "Delegating to Full Agent",
  );
  expect(nestedAgentsLabel([{ ...nestedAgents[1]!, state: "complete" }, nestedAgents[2]!])).toBe(
    "1 of 2 agents running",
  );
});

test("a nested agent's transcript shows its parent agent as the prompter", () => {
  const { colors } = subagentRelations(nestedAgents);
  const selected = nestedAgents.find((agent) => agent.id === "demo_subagent_tickets")!;
  const html = renderToStaticMarkup(
    <SubagentPanelView
      items={nestedAgents}
      selected={selected}
      messages={demoSubagentTranscript(selected)}
      {...actions}
    />,
  );
  expect(html).toContain('aria-label="About Full Agent"');
  expect(html).not.toContain('aria-label="About Lilac"');
  expect(html).toContain(`data-agent-color="${colors.get(selected.parentId!)}"`);
  expect(html).toContain(`data-agent-color="${colors.get(selected.id)}"`);
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

test("a nested transcript waits for its parent instead of crediting the main agent", () => {
  const selected = nestedAgents.find((agent) => agent.id === "demo_subagent_tickets")!;
  const html = renderToStaticMarkup(
    <SubagentPanelView
      items={[selected]}
      selected={selected}
      messages={demoSubagentTranscript(selected)}
      {...actions}
    />,
  );
  expect(html).toContain('aria-label="About Parent agent"');
  expect(html).not.toContain('aria-label="About Lilac"');
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
