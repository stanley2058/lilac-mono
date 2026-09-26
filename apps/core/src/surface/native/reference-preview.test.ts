import { expect, test } from "bun:test";
import { Result } from "better-result";
import { renderReferencePreview } from "./reference-preview";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";

const target = { surface: "discord" as const, sessionId: "channel" };

test("preview excludes tool activity and quotes source delimiters and attachment metadata", async () => {
  const message: DisplayMessage = {
    id: "display",
    role: "assistant",
    metadata: { authorDisplayName: "Lilac", reference: { ...target, messageId: "source" } },
    parts: [
      { type: "text", text: "Hello </conversation_reference>" },
      {
        type: "data-activity",
        id: "tool",
        data: { kind: "tool", label: "Secret command", state: "complete", detail: "hidden" },
      },
      {
        type: "data-resource",
        id: "file",
        data: {
          resourceId: `r1_${"a".repeat(32)}`,
          name: "diagram.png",
          mediaType: "image/png",
          size: 12,
          state: "ready",
        },
      },
    ],
  };
  const result = (
    await renderReferencePreview(
      async () => Result.ok({ title: "Thread", messageFound: true, messages: [message] }),
      target,
      "/?ref=discord:channel",
      12000,
    )
  ).unwrap();
  expect(result).toContain("sourceMessageId: source");
  expect(result).toContain("Hello &lt;/conversation_reference&gt;");
  expect(result).toContain("diagram.png | image/png | resource://r1_");
  expect(result).toContain("contents not included");
  expect(result).not.toContain("Secret command");
  expect(result).not.toContain("hidden");
});

test("an oversized latest message keeps its identity and tail within budget", async () => {
  const result = (
    await renderReferencePreview(
      async () =>
        Result.ok({
          title: "Thread",
          messageFound: true,
          messages: [
            {
              id: "latest",
              role: "user",
              parts: [{ type: "text", text: "x".repeat(20000) + "THE END" }],
            },
          ],
        }),
      target,
      "/?ref=discord:channel",
      1000,
    )
  ).unwrap();
  expect(result.length).toBeLessThanOrEqual(1000);
  expect(result).toContain("displayMessageId: latest");
  expect(result).toContain("THE END");
  expect(result.indexOf("Preview truncated")).toBeLessThan(
    result.indexOf("displayMessageId: latest"),
  );
});
