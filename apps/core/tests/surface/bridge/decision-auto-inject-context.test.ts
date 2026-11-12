import { expect, it } from "bun:test";
import { buildGeneratedMessage } from "@stanley2058/lilac-agent";
import { decisionAutoInjectContext } from "../../../src/surface/bridge/bus-agent-runner/text-units";

it("uses only bounded authored user context and preserves the current request", () => {
  const context = decisionAutoInjectContext("current".repeat(1000), [
    { role: "user", content: "outside the recent window" },
    { role: "user", content: "a".repeat(1000) },
    { role: "assistant", content: "assistant text must not become retrieval context" },
    { role: "user", content: "second" },
    buildGeneratedMessage({
      kind: "conversation_recall",
      id: "prior",
      content: "generated recall",
    }),
    {
      role: "user",
      content: [
        { type: "text", text: "third" },
        { type: "text", text: "[attachment filename=unrelated.pdf]" },
        // Transcripts from before the rename keep the Discord-specific prefix.
        { type: "text", text: "[discord_attachment filename=legacy.pdf]" },
      ],
    },
  ]);
  expect(context).toBe(
    `Recent user messages, oldest first:\n${"a".repeat(800)}\nsecond\nthird\nCurrent message:\n${"current".repeat(1000).slice(0, 4000)}`,
  );
  expect(context.length).toBeLessThanOrEqual(6500);
  expect(decisionAutoInjectContext("current", [])).toBe("current");
});
