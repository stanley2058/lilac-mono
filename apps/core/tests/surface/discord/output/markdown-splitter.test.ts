import { describe, expect, it } from "bun:test";
import {
  findLexicalSafeSplitPoint,
} from "../../../../src/surface/discord/output/markdown-splitter";
import { tokenComplete } from "../../../../src/surface/discord/output/token-complete";

// Intentionally copied/adapted from ref/js-llmcord.

describe("markdown-splitter", () => {
  describe("integration: findLexicalSafeSplitPoint + tokenComplete", () => {
    it("findLexicalSafeSplitPoint should prefer whitespace", () => {
      const input = "This is a sentence";
      const splitPos = findLexicalSafeSplitPoint(input, 12, {
        maxBacktrack: 100,
        newlineBacktrack: 100,
        locale: "en-US",
      });
      // "This is a " ends at 10.
      expect(splitPos).toBe(10);
    });

    it("should chunk long markdown with *italics* without duplication", () => {
      const input = `# The Secret Life of Error Messages

Most people treat error messages as the machine's way of saying *no*. But that's unfair. An error message is closer to a **confession**.

## 1) The Myth of the "Unexpected" Thing

We love the phrase **"unexpected error"**. Consider this spell:

\`\`\`ts
function openDoor(key: string) {
  if (key === "gold") return "open";
  throw new Error("unexpected key");
}
\`\`\`

The door was never truly "confused."

## 2) Errors as Communication

A good error message is a handshake in the dark.

## 3) The Three Roles

An error message plays roles in a tiny stage production.

## 4) The Aesthetics of Failure

A clean error message has a certain aesthetic.

| Trait | Bad | Better |
|---|---|---|
| Specificity | "Failed." | "Failed to parse JSON." |

## 5) A Love Letter to the Catch Block

Sometimes, error messages exist because we failed. That's what \`try/catch\` is: a promise that we will at least *look* when we stumble.

\`\`\`ts
try {
  await doTheThing();
} catch (err) {
  console.error("failed:", err);
}
\`\`\`

The catch block is not pessimism. It's respect for reality.`;

      const maxLen = 500;

      const chunks: string[] = [];
      let remaining = input;

      while (remaining.length > 0) {
        const splitPos = findLexicalSafeSplitPoint(remaining, maxLen, {
          maxBacktrack: 100,
          newlineBacktrack: 100,
          locale: "en-US",
        });
        const { completed, overflow } = tokenComplete(
          remaining.slice(0, splitPos),
          maxLen,
        );
        chunks.push(completed);
        remaining = overflow + remaining.slice(splitPos);

        if (chunks.length > 20) break;
      }

      expect(chunks.every((c) => c.length <= maxLen + 10)).toBe(true);

      const allText = chunks.join("");
      const matches = allText.match(/\*look\*/g) || [];
      expect(matches.length).toBe(1);
    });
  });
});
