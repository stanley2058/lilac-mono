import { useMemo, useState } from "react";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import { dmRewindDisabledReason, type ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { RewindDialog } from "./RewindDialog";
import { Timeline } from "./Timeline";
import { Button } from "./ui/button";

const noop = () => {};
export function DmRewindDemo() {
  const [state, setState] = useState("available");
  const [rewound, setRewound] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { client, restriction } = useMemo(() => {
    const now = Date.now();
    const turn: ReadyTurnSlot = {
      kind: "ready",
      slotId: "dm-rewind",
      turnId: "dm-rewind",
      position: 0,
      state: "complete",
      settledAt: now - (state === "expired" ? 1_800_000 : 1000),
      messages: [
        {
          id: "dm-rewind-prompt",
          role: "user",
          metadata: { authorId: "alex", inputId: "dm-rewind-input", inputMode: "prompt" },
          parts: [{ type: "text", text: "Draft a short reply." }],
        },
        {
          id: "dm-rewind-reply",
          role: "assistant",
          parts: [{ type: "text", text: "Thanks for the update. I'll review it this afternoon." }],
        },
      ],
    };
    const post: ReadyTurnSlot = {
      kind: "ready",
      slotId: "dm-post",
      turnId: "dm-post",
      position: 1,
      state: "complete",
      messages: [
        {
          id: "dm-post-message",
          role: "assistant",
          parts: [{ type: "text", text: "Reminder: your meeting starts in ten minutes." }],
        },
      ],
    };
    const last = state === "outside" ? post : turn;
    const reason = dmRewindDisabledReason({
      turn: last,
      latestTurnId: last.turnId,
      ownerId: "alex",
      busy: state === "busy",
      windowMs: 1_800_000,
      now,
    });
    const turns = state === "outside" ? [turn, post] : [turn];
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: 1,
        cursor: "dm-rewind-demo",
      },
      slots: rewound ? [] : turns,
    });
    return {
      client: {
        thread: () => store,
        hydrate: async () => {},
        loadTurnPage: async () => {},
        subscribe: () => noop,
      },
      restriction: { turnId: reason ? undefined : turn.turnId, reason },
    };
  }, [state, rewound]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {["available", "expired", "outside", "busy"].map((value) => (
          <Button
            key={value}
            variant={state === value ? "secondary" : "ghost"}
            onClick={() => {
              setState(value);
              setRewound(false);
              setConfirming(value === "expired");
            }}
          >
            {value}
          </Button>
        ))}
      </div>
      <RewindDialog
        open={confirming}
        reason={restriction.reason}
        onClose={() => setConfirming(false)}
        onRewind={() => {
          setRewound(true);
          setConfirming(false);
        }}
      />
      <div className="h-80 flex flex-col bg-background rounded-lg">
        <Timeline
          client={client}
          threadId="dm-rewind-demo"
          canEdit
          rewindRestriction={restriction}
          onRewind={() => setConfirming(true)}
          resourceUrl={(id) => id}
          onAction={noop}
          onReaction={noop}
          emptyContent={<p>Restored draft: Draft a short reply.</p>}
        />
      </div>
    </div>
  );
}
