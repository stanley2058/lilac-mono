import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import {
  latestReadableTurnId,
  joinMessageTurns,
  lastTurnMessageTime,
  workflowPostsDuring,
} from "../src/message-grouping";
import { agentWorkStages } from "../src/agent-work-fixtures";
import { Turn, turnPostsKey } from "../src/components/Timeline";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import { MessageServicesContext } from "../src/components/message-services";

const time = new Date(2026, 9, 19, 12).getTime();
function post(
  position: number,
  authorId = "lilac",
  role: "assistant" | "user" = "assistant",
): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `slot-${position}`,
    turnId: `turn-${position}`,
    position,
    state: "complete",
    messages: [
      {
        id: `message-${position}`,
        role,
        metadata: { authorId, createdAt: time + position * 1000, phase: "final" },
        parts: [{ type: "text", text: `Post ${position}` }],
      },
    ],
  };
}

test("consecutive posts group by author and stop at context, time, and intervening authors", () => {
  expect(joinMessageTurns(post(0), post(1))).toBe(true);
  expect(joinMessageTurns(post(0, "owner", "user"), post(1, "owner", "user"))).toBe(true);
  expect(joinMessageTurns(post(0), post(1, "other"))).toBe(false);
  expect(joinMessageTurns(post(0), post(1, "owner", "user"))).toBe(false);
  expect(joinMessageTurns(post(0), post(1), 1)).toBe(false);
  expect(joinMessageTurns(post(0), post(1), undefined, 1000)).toBe(false);
  const later = post(1);
  later.messages[0]!.metadata!.createdAt = time + DEFAULT_DM_TIMESTAMP_GAP_MS;
  expect(joinMessageTurns(post(0), later)).toBe(false);
  expect(joinMessageTurns({ ...post(0), state: "running" }, post(1))).toBe(false);
  expect(joinMessageTurns(undefined, post(1))).toBe(false);
});

test("completed work and following posts share one avatar and leave controls on the last bubble", () => {
  const first = agentWorkStages.find((stage) => stage.id === "grouped-messages")!.frames[0]!;
  const second = first.following!;
  expect(joinMessageTurns(first, second)).toBe(true);
  const html = renderToStaticMarkup(
    <MessageServicesContext
      value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
    >
      <Turn slot={first} joinedAfter onRewind={() => {}} onLoadMore={() => {}} />
      <Turn slot={second} joinedBefore onRewind={() => {}} onLoadMore={() => {}} />
    </MessageServicesContext>,
  );
  expect(html.match(/data-slot="message-avatar"/g)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/g)).toHaveLength(1);
  expect(html).toContain('data-ui="work-summary"');
  expect(html).toContain("The forecast is ready");
  expect(html).toContain("Bring a light jacket");
});

test("a post immediately after a long run uses the last message for both grouping and timestamps", () => {
  const first = post(0);
  first.messages.unshift({
    id: "prompt",
    role: "user",
    metadata: { authorId: "owner", createdAt: time - DEFAULT_DM_TIMESTAMP_GAP_MS },
    parts: [{ type: "text", text: "Long task" }],
  });
  const next = post(1);
  expect(lastTurnMessageTime(first)).toBe(time);
  expect(next.messages[0]!.metadata!.createdAt! - lastTurnMessageTime(first)!).toBeLessThan(
    DEFAULT_DM_TIMESTAMP_GAP_MS,
  );
  expect(joinMessageTurns(first, next)).toBe(true);
});

test("a completed incoming post joins the following bubble without its old bottom margin", () => {
  const first = post(0);
  first.messages[0]!.metadata = {
    ...first.messages[0]!.metadata,
    inputId: "surface-input",
    inputMode: "prompt",
  };
  const html = renderToStaticMarkup(
    <MessageServicesContext
      value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
    >
      <Turn slot={first} joinedAfter onRewind={() => {}} onLoadMore={() => {}} />
      <Turn slot={post(1)} joinedBefore onRewind={() => {}} onLoadMore={() => {}} />
    </MessageServicesContext>,
  );
  expect(html).not.toContain('class="mb-6"');
  expect(html.match(/data-slot="message-avatar"/g)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/g)).toHaveLength(1);
});

test("a deferred assistant post with an older acceptance timestamp still joins the completed reply", () => {
  const first = post(0);
  const next = post(1);
  next.messages[0]!.id = next.turnId;
  next.messages[0]!.metadata!.createdAt = time - 30_000;
  expect(joinMessageTurns(first, next)).toBe(true);
  expect(joinMessageTurns(first, next, undefined, 1000)).toBe(false);
  expect(joinMessageTurns({ ...first, state: "running" }, next)).toBe(false);
  expect(joinMessageTurns(first, next, next.position)).toBe(false);
  expect(
    joinMessageTurns(first, { ...next, messages: [{ ...next.messages[0]!, role: "user" }] }),
  ).toBe(false);
});

function workflowCard(id: string, at: number): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: id,
    turnId: id,
    position: 1,
    state: "complete",
    messages: [
      {
        id,
        role: "assistant",
        metadata: { createdAt: at, phase: "final" },
        parts: [
          {
            type: "data-workflow",
            id: `workflow_${id}`,
            data: workflowFrameData(),
          },
        ],
      },
    ],
  };
}
function workflowFrameData() {
  const frame = agentWorkStages.find((stage) => stage.id === "workflow")!.frames[0]!;
  const part = frame.messages[0]!.parts.find((item) => item.type === "data-workflow");
  if (part?.type !== "data-workflow") throw new Error("missing workflow fixture");
  return part.data;
}
function agentTurn(state: ReadyTurnSlot["state"], replyAt?: number): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: "agent",
    turnId: "agent",
    position: 0,
    state,
    startedAt: time,
    settledAt: replyAt === undefined ? undefined : replyAt + 5000,
    messages: [
      {
        id: "ask",
        role: "user",
        metadata: { authorId: "owner", createdAt: time },
        parts: [{ type: "text", text: "Plan Saturday." }],
      },
      ...(replyAt === undefined
        ? []
        : [
            {
              id: "reply",
              role: "assistant" as const,
              metadata: { createdAt: replyAt, phase: "final" as const },
              parts: [{ type: "text" as const, text: "Here is the plan." }],
            },
          ]),
    ],
  };
}

test("workflow cards posted during a turn fold ahead of its reply", () => {
  const card = workflowCard("card", time + 10_000);
  expect(workflowPostsDuring(agentTurn("complete", time + 60_000), [card])).toEqual(["card"]);
  expect(workflowPostsDuring(agentTurn("running"), [card])).toEqual(["card"]);
});

test("workflow cards stay after a reply that began before them", () => {
  const late = workflowCard("late", time + 90_000);
  expect(workflowPostsDuring(agentTurn("complete", time + 60_000), [late])).toEqual([]);
  expect(workflowPostsDuring(agentTurn("complete", time + 60_000), [post(1)])).toEqual([]);
  expect(workflowPostsDuring(workflowCard("card", time), [late])).toEqual([]);
});

test("an incoming agent message that starts a turn is not mistaken for its reply", () => {
  const turn = agentTurn("complete", time + 60_000);
  const triggered: ReadyTurnSlot = {
    ...turn,
    messages: [
      {
        id: "incoming",
        role: "assistant",
        metadata: { createdAt: time, phase: "final", inputId: "input-1", inputMode: "prompt" },
        parts: [{ type: "text", text: "Plan Saturday." }],
      },
      ...turn.messages.slice(1),
    ],
  };
  expect(workflowPostsDuring(triggered, [workflowCard("card", time + 10_000)])).toEqual(["card"]);
});

test("rows around folded cards see the owner turn as their visible neighbor", () => {
  const owner = agentTurn("complete", time + 60_000);
  const card = { ...workflowCard("card", time + 10_000), position: 1 };
  const after = { ...post(2), slotId: "after", turnId: "after" };
  after.messages = [{ ...after.messages[0]!, id: "after" }];
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint: { protocolVersion: 1, historyGeneration: 0, projectionRevision: 1, cursor: "c" },
    slots: [owner, card, after],
  });
  expect(JSON.parse(turnPostsKey(store, "agent", undefined, "card"))).toMatchObject({
    ids: ["card"],
    next: "after",
  });
  expect(turnPostsKey(store, "card", "agent", "after")).toBe("folded");
  expect(JSON.parse(turnPostsKey(store, "after", "card", undefined))).toMatchObject({
    ids: [],
    previous: "agent",
  });
});

test("a workflow card left after the reply sees the owner, not the folded card before it", () => {
  const owner = agentTurn("complete", time + 60_000);
  const early = { ...workflowCard("early", time + 10_000), position: 1 };
  const late = { ...workflowCard("late", time + 90_000), position: 2 };
  const store = new NativeThreadStore();
  store.replay({
    kind: "window",
    checkpoint: { protocolVersion: 1, historyGeneration: 0, projectionRevision: 1, cursor: "c" },
    slots: [owner, early, late],
  });
  expect(JSON.parse(turnPostsKey(store, "agent", undefined, "early"))).toMatchObject({
    ids: ["early"],
    next: "late",
  });
  expect(turnPostsKey(store, "early", "agent", "late")).toBe("folded");
  expect(JSON.parse(turnPostsKey(store, "late", "early", undefined))).toMatchObject({
    ids: [],
    previous: "agent",
  });
});

const ready = (turnId: string, state: string, messages: unknown[]) =>
  ({ kind: "ready", slotId: turnId, turnId, position: 0, state, messages }) as never;
const message = { id: "m", role: "assistant", parts: [] };

function latest(slots: Record<string, never>) {
  return latestReadableTurnId(Object.keys(slots), (id) => slots[id]);
}

test("latestReadableTurnId: returns the latest settled turn", () => {
  expect(latest({ a: ready("a", "complete", [message]) })).toBe("a");
});

test("latestReadableTurnId: waits while the latest turn is running", () => {
  expect(
    latest({ a: ready("a", "complete", [message]), b: ready("b", "running", [message]) }),
  ).toBeUndefined();
});

test("latestReadableTurnId: skips a silent wake, settled or running, which has nothing to read", () => {
  expect(latest({ a: ready("a", "complete", [message]), b: ready("b", "complete", []) })).toBe("a");
  expect(latest({ a: ready("a", "complete", [message]), b: ready("b", "running", []) })).toBe("a");
});

test("latestReadableTurnId: has nothing to mark when only a silent wake exists", () => {
  expect(latest({ a: ready("a", "complete", []) })).toBeUndefined();
});
