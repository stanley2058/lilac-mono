import { mergeSubagentTranscript, type SubagentTranscriptPage } from "../src/queries";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentWorkStages, demoSubagents, demoSubagentTranscript } from "../src/agent-work-fixtures";
import { SubagentPanelView } from "../src/components/SubagentPanel";
import { SubagentContext } from "../src/components/subagent-context";
import { ActivityItem } from "../src/components/ActivityLog";
import { createPanelStore, defaultRightPanel } from "../src/panel-store";

const actions = { onSelect: () => {}, onBack: () => {} };
const slot = agentWorkStages.find((stage) => stage.id === "subagents-working")!.frames[0]!;
const agents = demoSubagents(slot);

test("agents panel starts closed and retains its selected transcript across close and reopen", () => {
  const store = createPanelStore();
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(false);
  store.getState().select("thread", agents[0]!.id);
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(true);
  store.getState().toggle("thread");
  expect(store.getState().selection).toEqual({ threadId: "thread", agentId: agents[0]!.id });
  store.getState().toggle("thread");
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(true);
  store.getState().back();
  expect(store.getState().selection).toBeUndefined();
});

test("agent preview uses an agent avatar and readable profile and work title, with no raw tool tree", () => {
  const agent = agents[0]!;
  const part = slot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "data-activity" && part.id === agent.activityId)!;
  if (part.type !== "data-activity") throw new Error("Missing agent activity");
  const html = renderToStaticMarkup(
    <SubagentContext value={{ agents: new Map([[agent.activityId, agent]]), open: () => {} }}>
      <ActivityItem part={part} />
    </SubagentContext>,
  );
  expect(html).toContain('data-agent-profile="explore"');
  expect(html).toContain("Restricted Agent");
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
