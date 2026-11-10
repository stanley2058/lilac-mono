import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../src/components/Timeline";
import { pendingMessageParts, pendingTurnSlot } from "../src/pending-message";
import { joinMessageTurns } from "../src/message-grouping";
import type { Attachment, ComposerSubmission } from "../src/types";

const image: Attachment = {
  key: "image-key",
  file: new File(["image"], "photo.png", { type: "image/png" }),
  preview: "blob:local-photo",
  reservation: Promise.resolve(undefined),
  progress: 0,
  state: "reserving",
};
function submission(text = ""): ComposerSubmission {
  return { text, skillIds: [], mode: "steer", attachments: [image] };
}

test("attachment-only optimistic messages retain the local image preview before reservation", () => {
  const parts = pendingMessageParts(submission(), [image]);
  const html = renderToStaticMarkup(
    <Message
      message={{ id: "pending", role: "user", parts }}
      canEdit={false}
      resourceUrl={() => image.preview!}
      onAction={() => {}}
      onReaction={() => {}}
    />,
  );
  expect(html).toContain('src="blob:local-photo"');
  expect(html).toContain('alt="photo.png"');
  expect(html).not.toContain("Image unavailable");
});

test("inline references and resource parts use the same identity before and after reservation", () => {
  const entry = {
    ...submission("Look at photo.png"),
    attachmentText: "Look at [photo.png](attachment:image-key)",
  };
  for (const attachment of [image, { ...image, resourceId: "reserved-image" }]) {
    const parts = pendingMessageParts(entry, [attachment]);
    const resourceId = attachment.resourceId ?? attachment.key;
    expect(parts[0]).toEqual({
      type: "text",
      text: `Look at [photo.png](/api/resources/${resourceId})`,
    });
    expect(parts[1]).toMatchObject({
      type: "data-resource",
      data: { resourceId },
    });
  }
});

test("the optimistic turn carries its send time so it groups like the confirmed turn", () => {
  const sentAt = Date.UTC(2026, 10, 10, 12, 0, 30);
  const slot = pendingTurnSlot(
    {
      commandId: "command",
      text: "Next",
      createdAt: sentAt,
      submission: submission("Next"),
      state: "preparing",
    },
    [],
    1,
    "owner",
  );
  expect(slot.messages[0]?.metadata?.createdAt).toBe(sentAt);
  expect(slot.startedAt).toBe(sentAt);
  const previous = {
    kind: "ready" as const,
    slotId: "earlier",
    turnId: "earlier",
    position: 0,
    state: "complete" as const,
    messages: [
      {
        id: "earlier",
        role: "user" as const,
        metadata: { authorId: "owner", createdAt: sentAt - 10_000 },
        parts: [{ type: "text" as const, text: "First" }],
      },
    ],
  };
  expect(joinMessageTurns(previous, slot)).toBe(true);
});
