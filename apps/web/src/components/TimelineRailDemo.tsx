import { useMemo, useState } from "react";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import {
  DEFAULT_DM_CONTEXT_GAP_MS,
  startsContextWindow,
  turnPreviewText,
  type ContextWindowOutline,
  type ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import type { OutlineSource } from "../timeline-outline";
import { Timeline } from "./Timeline";

const start = Date.parse("2026-09-01T09:00:00Z");
const minute = 60_000;
const topics = [
  "the search cache",
  "the release checklist",
  "the onboarding guide",
  "the billing export",
  "the mobile layout",
  "the retry policy",
];
const asks = [
  "Summarize where we are on {t}.",
  "What changed in {t} since Monday?",
  "Draft a short update about {t} for the team.",
  "List the open questions about {t}.",
];

function turn(position: number, at: number, ask: string, answer: string): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `rail-demo-${position}`,
    turnId: `rail-demo-${position}`,
    position,
    state: "complete",
    startedAt: at,
    settledAt: at + 4_000,
    messages: [
      {
        id: `rail-ask-${position}`,
        role: "user",
        metadata: { createdAt: at },
        parts: [{ type: "text", text: ask }],
      },
      {
        id: `rail-answer-${position}`,
        role: "assistant",
        metadata: { createdAt: at + 3_000, phase: "final" },
        parts: [{ type: "text", text: answer }],
      },
    ],
  };
}

function threadTurns(): ReadyTurnSlot[] {
  return [...Array(48).keys()].map((position) => {
    const topic = topics[position % topics.length]!;
    const ask = asks[Math.floor(position / topics.length) % asks.length]!.replace("{t}", topic);
    return turn(
      position,
      start + position * 7 * minute,
      ask,
      `Turn ${position + 1}: ${topic} is on track. The remaining work is review and a short rollout note.`,
    );
  });
}

function directTurns(): ReadyTurnSlot[] {
  const turns: ReadyTurnSlot[] = [];
  for (let day = 0; day < 14; day++) {
    const count = 1 + ((day * 5) % 4);
    for (let index = 0; index < count; index++)
      turns.push(
        turn(
          turns.length,
          start + day * 26 * 60 * minute + index * 6 * minute,
          index === 0 ? `Morning check-in for day ${day + 1}.` : "Anything else on my list?",
          index === 0 ? "Two meetings and one reminder today." : "Just the grocery order.",
        ),
      );
  }
  return turns;
}

function contextWindows(slots: readonly ReadyTurnSlot[]): ContextWindowOutline[] {
  const windows: ContextWindowOutline[] = [];
  for (const slot of slots) {
    const startAt = slot.startedAt ?? 0;
    const endAt = slot.settledAt ?? startAt;
    const open = windows.at(-1);
    if (open && !startsContextWindow(open.endAt, startAt, DEFAULT_DM_CONTEXT_GAP_MS)) {
      windows[windows.length - 1] = { ...open, endPosition: slot.position + 1, endAt };
      continue;
    }
    windows.push({ firstPosition: slot.position, endPosition: slot.position + 1, startAt, endAt });
  }
  return windows;
}

/** Serves the outline from the demo's own turns, the way Core serves it over RPC. */
function localOutline(slots: readonly ReadyTurnSlot[], dm: boolean): OutlineSource {
  return {
    online: true,
    page: async () => ({
      historyGeneration: 0,
      positions: slots.map((slot) => slot.position),
      ...(dm ? { windows: contextWindows(slots) } : {}),
    }),
    previews: async ({ positions }) => ({
      historyGeneration: 0,
      previews: positions.map((position) => ({
        position,
        ...turnPreviewText(slots[position]?.messages ?? []),
      })),
    }),
  };
}

export function TimelineRailDemo({ dm = false }: { dm?: boolean }) {
  const threadId = dm ? "rail-demo-dm" : "rail-demo-thread";
  const [{ store, outline }] = useState(() => {
    const slots = dm ? directTurns() : threadTurns();
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: 1,
        cursor: threadId,
      },
      slots,
    });
    return { store, outline: localOutline(slots, dm) };
  });
  const client = useMemo(
    () => ({ thread: () => store, hydrate: async () => {}, loadTurnPage: async () => {} }),
    [store],
  );
  const noop = () => {};
  return (
    <div className="h-120 flex flex-col bg-background rounded-lg" data-thread-id={threadId}>
      <Timeline
        threadId={threadId}
        client={client}
        outline={outline}
        canEdit={false}
        timestamps={dm}
        resourceUrl={(id) => id}
        onAction={noop}
        onReaction={noop}
        onRewind={noop}
      />
    </div>
  );
}
