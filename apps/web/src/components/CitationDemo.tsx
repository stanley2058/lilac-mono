import { useMemo, useState } from "react";
import { NativeThreadStore } from "@stanley2058/lilac-client";
import { serializeCitation } from "@stanley2058/lilac-client-protocol";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";

export function CitationDemo() {
  const [text, setText] = useState("");
  const [store] = useState(() => {
    const store = new NativeThreadStore();
    store.replay({
      kind: "window",
      checkpoint: {
        protocolVersion: 1,
        historyGeneration: 0,
        projectionRevision: 1,
        cursor: "citation-demo",
      },
      slots: [
        {
          kind: "ready",
          slotId: "citation-demo-turn",
          turnId: "citation-demo-turn",
          position: 0,
          state: "complete",
          messages: [
            {
              id: "citation-demo-message",
              role: "assistant",
              metadata: { phase: "final" },
              parts: [
                {
                  type: "text",
                  text: 'Select part of this reply and __Cite__ it, or copy it as Markdown.\n\nCopy keeps __original delimiters__, escaped \\*stars\\*, &amp;, and [reference links][demo].\n\n> A quote across\n> two lines.\n\n- Keep the quote and your comment together.\n- Follow [the source](https://example.com).\n\n| Surface | Output |\n| :------ | -----: |\n| Web | **Rich** |\n\n```ts\nconst reply = { quoted: true };\n```\n\n[demo]: https://example.com "Source"',
                },
              ],
            },
          ],
        },
        {
          kind: "ready",
          slotId: "citation-demo-follow-up",
          turnId: "citation-demo-follow-up",
          position: 1,
          state: "complete",
          messages: [
            {
              id: "citation-demo-follow-up",
              role: "user",
              metadata: { authorId: "demo_user" },
              parts: [
                {
                  type: "text",
                  text: `${serializeCitation({
                    version: 1,
                    threadId: "citation-demo",
                    messageId: "citation-demo-message",
                    text: "Keep the quote and your comment together.",
                    start: 0,
                    end: 41,
                    prefix: "",
                    suffix: "",
                    comment: "Show both in the sent message.",
                  })} How does this look after sending?`,
                },
              ],
            },
          ],
        },
      ],
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
    <div className="h-120 flex flex-col bg-background rounded-lg" data-thread-id="citation-demo">
      <Timeline
        threadId="citation-demo"
        client={client}
        canEdit
        resourceUrl={(id) => id}
        onAction={noop}
        onReaction={noop}
        onRewind={noop}
        footer={
          <Composer
            documentKey="citation-demo"
            text={text}
            onText={setText}
            attachments={[]}
            skillIds={[]}
            onSkills={noop}
            onCommand={noop}
            onAttach={noop}
            onRemoveAttachment={noop}
            onRetryAttachment={noop}
            active={false}
            canCancel={false}
            disabled={false}
            onModelChange={noop}
            onCancel={noop}
            onSubmit={() => setText("")}
          />
        }
      />
    </div>
  );
}
