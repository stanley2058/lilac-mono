import { useMemo, useState } from "react";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import type { DisplayMessage, ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { Timeline } from "./Timeline";

const start = Date.parse("2026-09-19T18:00:00Z");
const minute = 60_000;

function say(
  id: string,
  role: "user" | "assistant",
  at: number,
  text: string,
  authorId?: string,
): DisplayMessage {
  return {
    id,
    role,
    metadata: role === "user" ? { authorId, createdAt: at } : { phase: "final", createdAt: at },
    parts: [{ type: "text", text }],
  };
}

function turn(position: number, messages: DisplayMessage[]): ReadyTurnSlot {
  const id = `grouping-${position}`;
  return {
    kind: "ready",
    slotId: id,
    turnId: messages[0]?.role === "assistant" ? messages[0].id : id,
    position,
    state: "complete",
    startedAt: messages[0]?.metadata?.createdAt,
    settledAt: messages.at(-1)?.metadata?.createdAt,
    messages,
  };
}

/** Agent posts within the DM gap join the previous turn; a longer pause starts a new block. */
const slots: ReadyTurnSlot[] = [
  turn(0, [
    say("grouping-ask", "user", start, "Anything I should pack for tomorrow?", "alex"),
    say(
      "grouping-reply",
      "assistant",
      start + 0.2 * minute,
      "A light jacket. It cools off after six.",
    ),
  ]),
  turn(1, [
    say(
      "grouping-follow-1",
      "assistant",
      start + 2 * minute,
      "Also, the forecast now shows rain from 06:00 to noon.",
    ),
  ]),
  turn(2, [
    say(
      "grouping-follow-2",
      "assistant",
      start + 3 * minute,
      "Keep the umbrella near the top of your bag.",
    ),
  ]),
  turn(3, [
    say(
      "grouping-later",
      "assistant",
      start + 180 * minute,
      "Your 11:30 flight is still on time as of this evening.",
    ),
  ]),
  turn(4, [
    say("grouping-thanks", "user", start + 185 * minute, "Thanks for checking.", "alex"),
    say("grouping-ack-1", "assistant", start + 185.2 * minute, "Anytime."),
    say(
      "grouping-ack-2",
      "assistant",
      start + 185.3 * minute,
      "Sleep well, the alarm is set for 07:00.",
    ),
  ]),
];

export function MessageGroupingDemo() {
  const [store] = useState(() => {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: 1,
        cursor: "grouping-demo",
      },
      slots,
    });
    return store;
  });
  const client = useMemo(
    () => ({
      thread: () => store,
      hydrate: async () => {},
      loadTurnPage: async () => {},
      subscribe: () => () => {},
    }),
    [store],
  );
  const noop = () => {};
  return (
    <div className="h-120 flex flex-col bg-background rounded-lg" data-thread-id="grouping-demo">
      <Timeline
        threadId="grouping-demo"
        client={client}
        canEdit={false}
        timestamps
        resourceUrl={(id) => id}
        onAction={noop}
        onReaction={noop}
        onRewind={noop}
      />
    </div>
  );
}
