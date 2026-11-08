import { useState } from "react";
import { X } from "lucide-react";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { moveInQueues, type ThreadQueues } from "../sidebar-order";
import { ThreadQueue } from "./ThreadQueue";
import { ThreadSettleButton } from "./ThreadSettleButton";
import { ThreadCard, threadDisplayState } from "./ThreadSelect";
import { IconButton } from "./ui";
const draftTitles: Record<string, string> = {
  "draft:weekend": "Plan a weekend by the river",
  "draft:notes": "Turn these notes into a proposal",
};
const titles = [
  "Plan the next release",
  "Compare the two proposals",
  "Find a quiet place for lunch",
  "Review the weekend itinerary",
  "Write up the meeting notes",
];

function initialQueues(): ThreadQueues {
  const entries = titles.map((title, index) => {
    const source: NativeThread = {
      id: `queue-demo-${index}`,
      title,
      starterId: index % 2 ? "morgan" : "alex",
      starterDisplayName: index % 2 ? "Morgan Lee" : "Alex Chen",
      updatedAt: Date.now() - index * 3_600_000,
      revision: 0,
      archived: false,
      displayStatus: index === 1 ? "working" : "idle",
      capabilities: { read: true, edit: true, share: true },
    };
    return { id: source.id, source };
  });
  return {
    pinned: entries.slice(0, 1),
    active: [...Object.keys(draftTitles).map((id) => ({ id })), ...entries.slice(1, 4)],
    settled: entries.slice(4),
  };
}
export function ThreadQueueDemo() {
  const [queues, setQueues] = useState(initialQueues);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState("");
  const [replyDraftId, setReplyDraftId] = useState<string>("queue-demo-0");
  function replyDraft(id: string) {
    return id === replyDraftId ? "reply" : undefined;
  }
  function discard(id: string) {
    if (id === replyDraftId) {
      setReplyDraftId("");
      return;
    }
    setQueues((current) => ({
      ...current,
      active: current.active.filter((entry) => entry.id !== id),
    }));
  }
  return (
    <div className="ds-queue-preview h-128 flex flex-col min-w-0 bg-surface rounded-lg p-2">
      <ThreadQueue
        queues={queues}
        totals={{
          pinned: queues.pinned.length,
          active: queues.active.filter((entry) => entry.source).length,
          settled: queues.settled.length,
        }}
        onMove={(move) => setQueues((current) => moveInQueues(current, move))}
        settledOpen={open}
        onSettledOpen={setOpen}
        renderThread={(entry, section) => (
          <ThreadCard
            title={entry.source?.title ?? draftTitles[entry.id]!}
            draft={entry.source ? replyDraft(entry.id) : "new"}
            starterName={entry.source?.starterDisplayName ?? "Alex Chen"}
            updatedAt={entry.source?.updatedAt ?? 0}
            state={entry.source ? threadDisplayState(entry.source) : "idle"}
            selected={selected === entry.id}
            pinned={section === "pinned"}
            settled={section === "settled"}
            onSelect={() => setSelected(entry.id)}
            actions={
              <>
                {selected !== entry.id && (!entry.source || entry.id === replyDraftId) ? (
                  <IconButton
                    label={`Discard draft for ${entry.source?.title ?? draftTitles[entry.id]}`}
                    tooltip="Discard draft"
                    onClick={() => discard(entry.id)}
                  >
                    <X />
                  </IconButton>
                ) : null}
                {entry.source ? (
                  <ThreadSettleButton
                    settled={section === "settled"}
                    title={entry.source.title}
                    onClick={() =>
                      setQueues((current) =>
                        moveInQueues(current, {
                          threadId: entry.id,
                          section: section === "settled" ? "active" : "settled",
                          atStart: true,
                        }),
                      )
                    }
                  />
                ) : null}
              </>
            }
          />
        )}
      />
    </div>
  );
}
