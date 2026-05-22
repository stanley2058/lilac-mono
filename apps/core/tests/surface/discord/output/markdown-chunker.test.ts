import { describe, expect, it } from "bun:test";

import { chunkMarkdownForEmbeds } from "../../../../src/surface/discord/output/markdown-chunker";

// Intentionally copied/adapted from ref/js-llmcord.

const ZWSP = "\u200b";

function expectDiscordChunksSafe(chunks: readonly string[], hardLimit: number): void {
  expect(chunks.length).toBeGreaterThan(0);
  chunks.forEach((chunk) => {
    expect(chunk.length).toBeLessThanOrEqual(hardLimit);
  });

  const joined = chunks.join("\n");
  expect(joined).not.toContain(`\`${ZWSP}\`\`txt\n\`${ZWSP}\`\`txt`);
  expect(joined).not.toContain(`\`${ZWSP}\`\`ts\n\`${ZWSP}\`\`ts`);
  expect(joined).not.toContain("``````````````````");
}

describe("markdown-chunker", () => {
  it("should not drop content for plain text", () => {
    const input = "0123456789ABCDEFGHIJ";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 7,
      maxLastChunkLength: 7,
      useSmartSplitting: true,
    });

    expect(chunks.join("")).toBe(input);
  });

  it("should prefer splitting on whitespace (lexical)", () => {
    const input = "This is a sentence";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["This is a", "sentence"]);
  });

  it("should prefer splitting on nearby newlines", () => {
    const input = "Line1\nLine2 more text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 13,
      maxLastChunkLength: 13,
      useSmartSplitting: true,
    });

    expect(chunks[0]).toBe("Line1");
    expect(chunks.join(" ")).toContain("Line2");
  });

  it("should keep earlier chunks stable after splitting", () => {
    const opts = {
      maxChunkLength: 10,
      maxLastChunkLength: 8,
      useSmartSplitting: true,
    };

    const beforeSplit = chunkMarkdownForEmbeds("0123456789AB", opts);
    expect(beforeSplit).toEqual(["0123456789", "AB"]);

    const afterSplit = chunkMarkdownForEmbeds("0123456789ABCDEFG", opts);
    expect(afterSplit[0]).toBe("0123456789");
    expect(afterSplit.join("")).toBe("0123456789ABCDEFG");
  });

  it("should keep code fence chunks renderable", () => {
    const input = "```js\nconsole.log(1)";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 10,
      maxLastChunkLength: 10,
      useSmartSplitting: true,
    });

    expect(chunks[0]).toContain("```");
  });

  it("should split fenced code blocks on line boundaries", () => {
    const input = "```js\nconsole.log(1)\nnextLine\nthird";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 22,
      maxLastChunkLength: 22,
      useSmartSplitting: true,
    });

    expect(chunks[0]).toBe("```js\nconsole.log(1)\n```");
    expect(chunks[1]).toContain("nextLine");
  });

  it("should rechunk last chunk to reserve indicator space", () => {
    const opts = {
      maxChunkLength: 10,
      maxLastChunkLength: 8,
      useSmartSplitting: false,
    };

    const chunks = chunkMarkdownForEmbeds("0123456789ABCDEFGHI", opts);
    expect(chunks).toEqual(["0123456789", "ABCDEFGH", "I"]);
  });

  it("should keep final plain-output chunks under the hard limit without dropping overflow", () => {
    const input = [
      "Mmm. I’d treat this as a **defaults migration problem**, not a breaking-change label problem.",
      "",
      "For example:",
      "",
      "```yaml",
      "configVersion: 1",
      "```",
      "Then new generated configs use:",
      "",
      "```yaml",
      "configVersion: 2",
      "```",
      "And the app does something like:",
      "",
      "```ts",
      "const defaults = config.configVersion >= 2",
      "  ? modernDefaults",
      "  : legacyDefaults;",
      "```",
      "That gives us a nice split. Small ghost. Manageable.",
      "",
      "The migration command should show a diff or summary before applying changes:",
      "",
      "```txt",
      "This migration will:",
      "- switch default model routing from X to Y",
      "- enable feature Z by default",
      "- change timeout from 30s to 60s",
      "",
      "Existing explicit config values will be preserved.",
      "```",
      "",
      "The golden rule: **only change implicit defaults, never overwrite explicit user choices.**",
      "",
      "That gives new users the polished experience, existing users stability, and us room to improve the creature without making it bite its current caretakers. 🌸",
    ].join("\n");

    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 300,
      maxLastChunkLength: 300,
      useSmartSplitting: true,
      hardMaxChunkLength: 300,
    });

    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
    expect(chunks.join("\n")).toContain("change timeout from 30s to 60s");
    expect(chunks.join("\n")).toContain("room to improve the creature");
  });

  it("should not emit repeated fence prefixes after earlier nested markdown examples", () => {
    const input = [
      "Fixed and pushed directly to `main`.",
      "",
      "The root fix is in `token-complete.ts`: closed code fences now preserve the newline after the closing fence, so `completeMarkdown()` no longer rewrites:",
      "",
      "```md",
      "```yaml",
      "configVersion: 1",
      "```",
      "Then continue",
      "```",
      "",
      "into the subtly broken:",
      "",
      "```md",
      "```yaml",
      "configVersion: 1",
      "```Then continue",
      "```",
      "",
      "Validation run on your PC:",
      "",
      "```txt",
      "bun test ./apps/core/tests/surface/discord/output/token-complete.test.ts ./apps/core/tests/surface/discord/output/markdown-chunker.test.ts ./apps/core/tests/surface/discord/output/discord-output-stream.test.ts",
      "71 pass",
      "0 fail",
      "```",
      "",
      "Also clean:",
      "",
      "```txt",
      "bun run lint",
      "0 warnings, 0 errors",
      "",
      "bun run typecheck",
      "passed",
      "```",
      "",
      "Tiny goblin contained. Not forgiven.",
    ].join("\n");

    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 900,
      maxLastChunkLength: 900,
      useSmartSplitting: true,
      hardMaxChunkLength: 920,
    });

    expectDiscordChunksSafe(chunks, 920);
    expect(chunks.join("\n")).toContain("0 warnings, 0 errors");
    expect(chunks.join("\n")).toContain("bun run typecheck");
  });

  const edgeCases = [
    {
      name: "bold and italic boundaries",
      input: [
        "A paragraph with **bold text that keeps going past the boundary** and then normal text.",
        "Another paragraph with *italic text that also crosses the boundary* safely.",
      ].join("\n\n"),
    },
    {
      name: "inline code markers",
      input: [
        "Inline code near the boundary: `const value = response.*.items.map((x) => x.id)` should not leak emphasis.",
        "Trailing text keeps this longer than a single chunk.",
      ].join("\n\n"),
    },
    {
      name: "fenced code",
      input: [
        "```ts",
        "const alpha = 1;",
        "const beta = 2;",
        "const gamma = alpha + beta;",
        "console.log(gamma);",
        "```",
      ].join("\n"),
    },
    {
      name: "nested markdown fences",
      input: [
        "```md",
        "# Example",
        "",
        "```ts",
        "const nested = true;",
        "```",
        "",
        "Back to markdown.",
        "```",
        "After the nested fence example, keep writing until the text needs multiple chunks.",
      ].join("\n"),
    },
    {
      name: "block math",
      input: ["$$", "x = y + z + veryLongSymbolName", "$$", "Then normal prose after math."].join(
        "\n",
      ),
    },
  ];

  for (const { name, input } of edgeCases) {
    it(`should keep ${name} edge cases within hard limits`, () => {
      const chunks = chunkMarkdownForEmbeds(input.repeat(3), {
        maxChunkLength: 120,
        maxLastChunkLength: 120,
        useSmartSplitting: true,
        hardMaxChunkLength: 130,
      });

      expectDiscordChunksSafe(chunks, 130);
    });
  }
});
