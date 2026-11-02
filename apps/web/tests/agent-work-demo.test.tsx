import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  readyTurnSlotSchema,
  workflowCardSchema,
  type ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import {
  agentWorkStages,
  demoSubagents,
  workflowActionFrame,
  workflowFrame,
  workflowStages,
} from "../src/agent-work-fixtures";
import { workflowProgress } from "../src/generated/tool-activities";
import { designWorkflowViews } from "../../core/scripts/design-workflow-progress";
import {
  workflowRunStateSchema,
  workflowOperationStateSchema,
} from "../../core/src/workflow/workflow-domain";
import { SubagentContext } from "../src/components/subagent-context";
import { MessageIdentityContext } from "../src/components/message-identity";
import { Turn } from "../src/components/Timeline";
import { MessageServicesContext } from "../src/components/message-services";

test("every demo frame is a valid native turn rendered by the production turn component", () => {
  for (const stage of agentWorkStages) {
    expect(stage.frames.length).toBeGreaterThan(0);
    for (const { following, ...slot } of stage.frames) {
      expect(readyTurnSlotSchema.safeParse(slot).success).toBe(true);
      if (following) expect(readyTurnSlotSchema.safeParse(following).success).toBe(true);
    }
    const html = renderToStaticMarkup(
      <MessageServicesContext
        value={{ canEdit: false, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
      >
        <Turn slot={stage.frames[0]!} onRewind={() => {}} onLoadMore={() => {}} />
      </MessageServicesContext>,
    );
    expect(html).toContain(`data-turn-id="${stage.frames[0]!.turnId}"`);
    if (stage.id === "complete") expect(html).toContain("Worked for 12s");
    if (stage.id === "failed") expect(html).toContain("Run failed");
    if (stage.id === "canceled") expect(html).toContain("Stopped");
  }
});

test("streaming frames preserve message identity and grow into the completed answer", () => {
  const streaming = agentWorkStages.find((stage) => stage.id === "streaming")!;
  const complete = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  const final = complete.messages.find((message) => message.metadata?.phase === "final")!;
  const fullText = final.parts.find((part) => part.type === "text")!.text;
  let previous = "";
  for (const slot of streaming.frames) {
    const message = slot.messages.find((entry) => entry.metadata?.phase === "final")!;
    const text = message.parts.find((part) => part.type === "text")!.text;
    expect(message.id).toBe(final.id);
    expect(text.startsWith(previous)).toBe(true);
    expect(fullText.startsWith(text)).toBe(true);
    expect(message.metadata?.incomplete).not.toBe(true);
    if (slot !== streaming.frames.at(-1)) expect(text.endsWith("\n\n")).toBe(true);
    previous = text;
  }
  expect(previous).toBe(fullText);
});

test("workflow demos cover every run and operation state using Core progress messages", () => {
  const views = Object.values(designWorkflowViews);
  expect(new Set(views.map((view) => view.run.state))).toEqual(
    new Set(workflowRunStateSchema.options),
  );
  expect(
    new Set(views.flatMap((view) => view.recentOperations.map((operation) => operation.state))),
  ).toEqual(new Set(workflowOperationStateSchema.options));
  for (const stage of workflowStages) {
    for (const slot of stage.frames) {
      expect(slot.state).toBe("complete");
      const card = slot.messages.find((message) => message.id === "demo_workflow")!;
      const text = card.parts.find((part) => part.type === "text")!.text;
      const progress = Object.values(workflowProgress).find((progress) => progress.text === text)!;
      expect(progress).toBeDefined();
      const controls = card.parts.find((part) => part.type === "data-actions");
      expect(controls?.data.actions ?? []).toEqual(progress.actions);
      const workflow = card.parts.find((part) => part.type === "data-workflow");
      expect(workflow?.data).toEqual(progress.workflow);
    }
  }
  const cards = Object.values(workflowProgress).flatMap((progress) => [
    progress.workflow,
    ...Object.values(progress.transitions).map((transition) => transition.workflow),
  ]);
  expect(new Set(cards.map((card) => card.status))).toEqual(
    new Set(workflowCardSchema.shape.status.options),
  );
});

test("workflow actions edit the same card and preserve progress through pause and resume", () => {
  const initial = workflowFrame("parallel");
  const paused = workflowActionFrame(initial, "demo_workflow_pause")!;
  const resumed = workflowActionFrame(paused, "demo_workflow_resume")!;
  const cancelled = workflowActionFrame(resumed, "demo_workflow_cancel")!;
  for (const frame of [paused, resumed, cancelled]) {
    expect(readyTurnSlotSchema.safeParse(frame).success).toBe(true);
    expect(frame.messages[0]?.id).toBe(initial.messages[0]?.id);
    expect(frame.slotId).toBe(initial.slotId);
  }
  expect(resumed).toEqual(initial);
  expect(JSON.stringify(paused)).toContain("0/2 steps complete · 2 active");
  expect(JSON.stringify(paused)).toContain("Paused");
  expect(JSON.stringify(cancelled)).toContain("0/2 steps complete · 2 stopped");
  expect(cancelled.messages[0]?.parts.some((part) => part.type === "data-actions")).toBe(false);
  expect(workflowActionFrame(initial, "unrelated")).toBeUndefined();
});

function renderStage(id: string, override?: ReadyTurnSlot) {
  const slot = override ?? agentWorkStages.find((stage) => stage.id === id)!.frames[0]!;
  return renderToStaticMarkup(
    <MessageIdentityContext
      value={{
        viewerId: "demo_user",
        agent: { displayName: "Lilac" },
        users: new Map([
          ["demo_user", { displayName: "Alex Chen" }],
          ["demo_other_user", { displayName: "Morgan Lee" }],
        ]),
      }}
    >
      <MessageServicesContext
        value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
      >
        <SubagentContext
          value={{
            agents: new Map(demoSubagents(slot).map((agent) => [agent.activityId, agent])),
            open: () => {},
          }}
        >
          <Turn slot={slot} onRewind={() => {}} onLoadMore={() => {}} />
        </SubagentContext>
      </MessageServicesContext>
    </MessageIdentityContext>,
  );
}

test("live commentary shares one agent avatar and has no message action rows", () => {
  const html = renderStage("full-turn-working");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(1);
  expect(html).toContain('data-message-id="demo_introduction"');
  expect(html).toContain('data-message-id="demo_commentary"');
});

test("steering stays in order and starts a fresh agent group for each participant", () => {
  const html = renderStage("steering-other");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(3);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(3);
  expect(html).toContain('aria-label="About Morgan Lee"');
  const ids = [
    "demo_introduction",
    "demo_first_work",
    "demo_own_steer",
    "demo_steer_thought",
    "demo_steer_commentary",
    "demo_steer_work",
    "demo_other_steer",
    "demo_cafe_thought",
    "demo_cafe_commentary",
  ];
  for (let index = 1; index < ids.length; index++)
    expect(html.indexOf(`data-message-id="${ids[index - 1]}"`)).toBeLessThan(
      html.indexOf(`data-message-id="${ids[index]}"`),
    );
  expect(html).toMatch(/data-align="end"[^>]+data-message-id="demo_own_steer"/u);
  expect(html).toMatch(/data-align="start"[^>]+data-message-id="demo_other_steer"/u);
});

test("completed turns collapse steering and work under the avatar above the final answer", () => {
  const html = renderStage("steering-complete");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
  expect(html).not.toContain('data-message-id="demo_own_steer"');
  expect(html).not.toContain('data-message-id="demo_other_steer"');
  expect(html).not.toContain('data-message-id="demo_introduction"');
  expect(html).toContain('data-message-id="demo_steered_final"');
  expect(html.indexOf('aria-label="About Lilac"')).toBeLessThan(html.indexOf("Worked for 4m"));
  expect(html.indexOf("Worked for 4m")).toBeLessThan(
    html.indexOf('data-message-id="demo_steered_final"'),
  );
});

test("workflow cards render as their own block from structured progress", () => {
  const html = renderStage("workflow-running");
  expect(html).toContain('data-ui="workflow-turn"');
  expect(html).toContain('data-ui="workflow-card"');
  expect(html).toContain('data-status="running"');
  expect(html).not.toContain('aria-label="About Lilac"');
  expect(html).not.toContain('data-ui="work-summary"');
  expect(html).not.toContain("**Progress**");
  expect(html).toContain("2 of 4 steps complete · 1 active · 1 queued");
  expect(html).toContain("Choose the walking route");
  expect(html).toContain('aria-label="Pause"');
  expect(html).toContain('aria-label="Cancel"');
});

test("terminal workflow cards show results and reasons without controls", () => {
  const succeeded = renderStage("workflow-succeeded");
  expect(succeeded).toContain('data-ui="workflow-result"');
  expect(succeeded).toContain("Walk the river loop for 45 minutes");
  expect(succeeded).not.toContain('data-ui="workflow-actions"');
  expect(renderStage("workflow-shortenedResult")).toContain("Shortened.");
  expect(renderStage("workflow-largeResult")).toContain("too large to show here");
  expect(renderStage("workflow-failed")).toContain("The route service returned an error.");
  expect(renderStage("workflow-sensitive")).toContain("sensitive input");
  expect(renderStage("workflow-sensitive")).not.toContain("Walk the river loop");
  expect(renderStage("workflow-reply")).toContain("Discord channel");
  expect(renderStage("workflow-attention")).toContain("Cancel this run");
});

test("streaming answers have no action row until the turn settles", () => {
  expect(renderStage("streaming").match(/data-ui="message-controls"/gu)).toHaveLength(1);
  expect(renderStage("complete").match(/data-ui="message-controls"/gu)).toHaveLength(2);
});

test("subagents retain activity identity as results arrive and settle under the parent", () => {
  const stages = ["subagents-working", "subagents-results", "subagents-complete"];
  const expectedStates: ("running" | "complete")[][] = [
    ["running", "running"],
    ["complete", "running"],
    ["complete", "complete"],
  ];
  let previousIds: string[] = [];
  for (const [index, id] of stages.entries()) {
    const slot = agentWorkStages.find((stage) => stage.id === id)!.frames[0]!;
    const ids = slot.messages.map((message) => message.id);
    expect(ids.slice(0, previousIds.length)).toEqual(previousIds);
    previousIds = ids;
    const activities = slot.messages
      .filter((message) => ["demo_subagent_weather", "demo_subagent_museum"].includes(message.id))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "data-activity");
    expect(activities.map((part) => part.id)).toEqual([
      "demo_subagent_weather",
      "demo_subagent_museum",
    ]);
    expect(activities.map((part) => part.data.state)).toEqual(expectedStates[index]!);
    for (const part of activities) {
      expect(part.data.kind).toBe("tool");
      expect(part.data.detail).toBe(part.data.label);
      expect(part.data.label.length).toBeLessThanOrEqual(256);
    }
    const html = renderStage(id);
    expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
    expect(html).not.toContain('data-ui="work-participation"');
    if (slot.state === "complete") {
      expect(html).toContain("Worked for 1m");
      expect(html).toContain('data-message-id="demo_final"');
      expect(html).not.toContain('data-message-id="demo_subagent_weather"');
      expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
      continue;
    }
    expect(html.match(/subagent-activity/gu)).toHaveLength(2);
    expect(html).not.toContain('data-message-id="demo_final"');
    expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(1);
  }
});

test("an earlier final answer becomes intermediate when steering continues the turn", () => {
  const original = agentWorkStages.find((stage) => stage.id === "steering-complete")!.frames[0]!;
  const messages = [...original.messages];
  const index = messages.findIndex((message) => message.id === "demo_own_steer");
  messages.splice(index, 0, {
    id: "earlier_answer",
    role: "assistant",
    metadata: { phase: "final" },
    parts: [{ type: "text", text: "An earlier answer before steering." }],
  });
  const html = renderStage("steering-complete", { ...original, messages });
  expect(html).not.toContain("An earlier answer before steering.");
  expect(html).toContain('data-message-id="demo_steered_final"');
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
});

test("the settled work summary lists distinct participating users without the agent", () => {
  const html = renderStage("steering-complete");
  const summary = html.slice(
    html.indexOf('data-ui="work-participation"'),
    html.indexOf('data-ui="expanded-work"') > 0
      ? html.indexOf('data-ui="expanded-work"')
      : html.indexOf('data-message-id="demo_steered_final"'),
  );
  expect(summary).toContain(">with</span>");
  expect(summary.match(/data-ui="work-participant"/gu)).toHaveLength(2);
  expect(summary).toContain('aria-label="Alex Chen"');
  expect(summary).toContain('aria-label="Morgan Lee"');
  expect(summary).not.toContain('aria-label="Lilac"');
});

test("one participant is omitted even when they steer repeatedly", () => {
  const original = agentWorkStages.find((stage) => stage.id === "steering-complete")!.frames[0]!;
  const messages = original.messages.map((message) =>
    message.role === "user"
      ? { ...message, metadata: { ...message.metadata, authorId: "demo_user" } }
      : message,
  );
  const html = renderStage("steering-complete", { ...original, messages });
  expect(html).not.toContain('data-ui="work-participation"');
  expect(html).toContain("Worked for 4m");
  expect(renderStage("complete")).not.toContain('data-ui="work-participation"');
});

test("reaction sits between time and rewind, and rewind is disabled for an active agent", () => {
  const slot = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  for (const rewindDisabled of [false, true]) {
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{ viewerId: "demo_user", agent: { displayName: "Lilac" }, users: new Map() }}
      >
        <MessageServicesContext
          value={{
            canEdit: true,
            rewindDisabled,
            resourceUrl: () => "",
            onAction: () => {},
            onReaction: () => {},
          }}
        >
          <Turn slot={slot} onRewind={() => {}} onLoadMore={() => {}} />
        </MessageServicesContext>
      </MessageIdentityContext>,
    );
    const controls = html.slice(html.indexOf('data-ui="message-controls"'));
    expect(controls.indexOf("<time")).toBeLessThan(controls.indexOf('aria-label="Add reaction"'));
    expect(controls.indexOf('aria-label="Add reaction"')).toBeLessThan(
      controls.indexOf('aria-label="Rewind to this turn"'),
    );
    expect(controls.indexOf('aria-label="Rewind to this turn"')).toBeLessThan(
      controls.indexOf('aria-label="Copy message"'),
    );
    const rewind = controls.match(/<button[^>]*aria-label="Rewind to this turn"[^>]*>/)?.[0];
    expect(rewind).toBeDefined();
    expect(/\sdisabled(?:=|\s|>)/.test(rewind!)).toBe(rewindDisabled);
  }
});

test("a sent prompt immediately shows thinking and suppresses the queue marker", () => {
  const html = renderStage("sent");
  expect(html).toContain('data-ui="thinking"');
  expect(html).toContain(
    '>Thinking<span aria-hidden="true" class="working-text-shine">Thinking</span>',
  );
  expect(html).toContain("Working for");
  expect(html).not.toContain(">queued<");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
});

test("incoming surface messages remain visible outside folded destination work", () => {
  const frame = agentWorkStages.find((stage) => stage.id === "surface-message")!.frames[0]!;
  for (const phase of ["final", undefined] as const) {
    const slot = {
      ...frame,
      messages: frame.messages.map((message, index) =>
        index === 0 ? { ...message, metadata: { ...message.metadata, phase } } : message,
      ),
    };
    const html = renderStage("surface-message", slot);
    expect(html).toContain("Notification test. Did your phone blink?");
    expect(html.indexOf("Notification test.")).toBeLessThan(html.indexOf('data-ui="work-summary"'));
    expect(html).not.toContain("Related conversation context was added");
  }
});

test("work duration uses the prompt timestamp for older turns without a start timestamp", () => {
  const complete = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  expect(renderStage("complete", { ...complete, startedAt: undefined })).toContain(
    "Worked for 12s",
  );
});

test("only the last folded section and sections with running agents shine", () => {
  const html = renderStage("folded-activity-running");
  expect(html.match(/class="working-text[ "]/gu)).toHaveLength(2);
  expect(html).toContain(">Compared both options.</span>");
  expect(html).toContain(
    'class="working-text-shine">bash tools web.search &quot;Kyoto museum tickets&quot;</span>',
  );
  expect(html).toContain(
    '>Thinking<span aria-hidden="true" class="working-text-shine">Thinking</span>',
  );
});

test("terminal turns suppress stale running activity even in final messages", () => {
  const slot = agentWorkStages.find((stage) => stage.id === "folded-activity-complete")!.frames[0]!;
  for (const state of ["complete", "failed", "canceled"] as const) {
    const html = renderStage("folded-activity-complete", {
      ...slot,
      state,
      messages: slot.messages.map((message) => ({
        ...message,
        metadata: { ...message.metadata, phase: "final" },
      })),
    });
    expect(html).not.toContain("working-text");
    expect(html).toContain(">Compared both options.</span>");
  }
});
