import { useCallback, useEffect, useRef, useState } from "react";
import { watchConnectionLifecycle } from "../connection-lifecycle";
import { draftAttachment, releaseDraftAttachments } from "../draft-thread";
import type { Attachment } from "../types";
import { useConnectionNotice } from "../use-connection-notice";
import { useEventCallback } from "../use-event-callback";
import { Composer } from "./Composer";
import { Button } from "./ui/button";

type Draft = { text: string; skillIds: string[]; attachments: Attachment[] };
type Selection = "draft" | "thread";
const catalog = { revision: "demo", models: [], skills: [], commands: [] };

export function ReconnectionDemo() {
  const [online, setOnline] = useState(true);
  const [phone, setPhone] = useState(false);
  const [selected, setSelected] = useState<Selection>("draft");
  const [sent, setSent] = useState(false);
  const [drafts, setDrafts] = useState<Record<Selection, Draft>>({
    draft: { text: "Help me plan a quiet weekend by the river.", skillIds: [], attachments: [] },
    thread: { text: "One more thought about the itinerary…", skillIds: [], attachments: [] },
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnect = useCallback(() => {
    clearTimeout(timer.current);
    setOnline(true);
  }, []);
  const retry = useCallback(
    () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          reconnect();
          resolve();
        }, 1_000);
      }),
    [reconnect],
  );
  useConnectionNotice({ online, retry, id: "reconnection-demo" });
  useEffect(
    () =>
      watchConnectionLifecycle({
        connectionState: online ? "online" : "offline",
        reconnect,
        checkConnection: async () => {},
      }),
    [online, reconnect],
  );
  const release = useEventCallback(() => {
    for (const draft of Object.values(drafts)) releaseDraftAttachments(draft.attachments);
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      release();
    },
    [release],
  );
  const draft = drafts[selected];
  function update(change: Partial<Draft>) {
    setSent(false);
    setDrafts((current) => ({ ...current, [selected]: { ...current[selected], ...change } }));
  }
  function disconnect(brief: boolean) {
    clearTimeout(timer.current);
    setSent(false);
    setOnline(false);
    if (brief) timer.current = setTimeout(reconnect, 250);
  }
  return (
    <div className="flex flex-col gap-4" data-reconnection-demo>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={!online} onClick={() => disconnect(false)}>
          Go offline
        </Button>
        <Button variant="secondary" disabled={online} onClick={reconnect}>
          Reconnect
        </Button>
        <Button variant="secondary" disabled={!online} onClick={() => disconnect(true)}>
          Brief interruption
        </Button>
        <Button variant="outline" aria-pressed={phone} onClick={() => setPhone((value) => !value)}>
          Phone preview
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {online ? "Connected" : "Offline"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Go offline and keep typing. Reconnect, press Retry in the notice, or switch tabs and return.
        Brief interruptions finish before the notice appears. This demo sends no messages.
      </p>
      <div
        className={`w-full min-w-0 rounded-lg bg-surface p-3 ${phone ? "max-w-sm" : "max-w-3xl"}`}
      >
        <div className="flex flex-wrap gap-2 mb-4" aria-label="Demo conversations">
          <Button
            variant={selected === "draft" ? "secondary" : "ghost"}
            aria-pressed={selected === "draft"}
            onClick={() => {
              setSelected("draft");
              setSent(false);
            }}
          >
            Unsent draft
          </Button>
          <Button
            variant={selected === "thread" ? "secondary" : "ghost"}
            aria-pressed={selected === "thread"}
            onClick={() => {
              setSelected("thread");
              setSent(false);
            }}
          >
            Weekend itinerary
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          {selected === "draft"
            ? "New conversation"
            : "Let's leave Saturday afternoon free for the bookstore."}
        </p>
        <Composer
          documentKey={`reconnection-demo:${selected}`}
          catalog={catalog}
          text={draft.text}
          onText={(text) => update({ text })}
          skillIds={draft.skillIds}
          onSkills={(skillIds) => update({ skillIds })}
          onCommand={() => {}}
          attachments={draft.attachments}
          onAttach={(files) => {
            const added = files.map(draftAttachment);
            update({ attachments: [...draft.attachments, ...added] });
            return added;
          }}
          onRemoveAttachment={(key) => {
            releaseDraftAttachments(
              draft.attachments.filter((attachment) => attachment.key === key),
            );
            update({
              attachments: draft.attachments.filter((attachment) => attachment.key !== key),
            });
          }}
          onRetryAttachment={() => {}}
          active={false}
          canCancel={false}
          disabled={false}
          offline={!online}
          onModelChange={() => {}}
          onSubmit={() => setSent(true)}
          onCancel={() => {}}
        />
        <p className="text-sm text-muted-foreground mt-3" role="status">
          {sent
            ? "Send is available. Your demo draft is still here."
            : "Your draft and selected conversation stay in place during reconnects."}
        </p>
      </div>
    </div>
  );
}
