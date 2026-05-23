import { describe, expect, it } from "bun:test";
import { chunkMarkdownForEmbeds } from "../../../../src/surface/discord/output/markdown-chunker";

// Intentionally copied/adapted from ref/js-llmcord.

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

    expect(chunks).toEqual(["This is a ", "sentence"]);
  });

  it("should prefer splitting on nearby newlines", () => {
    const input = "Line1\nLine2 more text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 13,
      maxLastChunkLength: 13,
      useSmartSplitting: true,
    });

    expect(chunks[0]).toBe("Line1\n");
    expect(chunks.join("")).toBe(input);
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

    expect(chunks.every((chunk) => chunk.length <= 22)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```js\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
    const rendered = chunks.join("\n");
    expect(rendered).toContain("console.log(");
    expect(rendered).toContain("1)");
    expect(rendered).toContain("nextLine");
    expect(rendered).toContain("third");
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

  it("should preserve raw marker bytes instead of moving synthetic prefixes into raw ownership", () => {
    const input = "abcde**bold**fghij";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 9,
      maxLastChunkLength: 9,
      useSmartSplitting: true,
    });

    expect(chunks.join("").replaceAll("**", "")).toBe("abcdeboldfghij");
    expect(chunks.join("")).not.toContain("******");
  });

  it("should normalize outer fences and neutralize nested fence markers", () => {
    const chunks = chunkMarkdownForEmbeds("````txt\n```ts\ncode\n```\n````", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```txt\n`​``ts\ncode\n`​``\n```"]);
  });

  it("should neutralize mid-line fence markers inside displayed code", () => {
    const chunks = chunkMarkdownForEmbeds("```txt\nThe ``` marker stays code\n```", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```txt\nThe `​`` marker stays code\n```"]);
  });

  it("should preserve tilde runs inside displayed code", () => {
    const chunks = chunkMarkdownForEmbeds("```txt\nThe ~~~ marker stays literal\n```", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```txt\nThe ~~~ marker stays literal\n```"]);
  });

  it("should not close fences on mixed marker runs", () => {
    const chunks = chunkMarkdownForEmbeds(
      ["```txt", "```~~~", "still code", "```", "outside"].join("\n"),
      {
        maxChunkLength: 100,
        maxLastChunkLength: 100,
        useSmartSplitting: true,
      },
    );

    expect(chunks).toEqual(["```txt\n`​``~~~\nstill code\n```\noutside"]);
  });

  it("should close markdown fences after same-length nested language lines", () => {
    const chunks = chunkMarkdownForEmbeds(
      ["````md", "text", "````js", "code", "````", "outside"].join("\n"),
      {
        maxChunkLength: 100,
        maxLastChunkLength: 100,
        useSmartSplitting: true,
      },
    );

    expect(chunks).toEqual(["```md\ntext\n`​```js\ncode\n```\noutside"]);
  });

  it("should not render original closer lines as standalone fence artifacts", () => {
    const chunks = chunkMarkdownForEmbeds("```js\none\n```\nafter", {
      maxChunkLength: 13,
      maxLastChunkLength: 13,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```js\none\n```", "after"]);
  });

  it("should not turn list bullets into synthetic emphasis", () => {
    const input = "* item one with lots of text\n* item two with more text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 18,
      maxLastChunkLength: 18,
      useSmartSplitting: true,
    });

    expect(chunks.join("")).toBe(input);
  });

  it("should not turn literal operators into synthetic emphasis", () => {
    const input = "Use a * b and c_d as literal text that wraps.";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 14,
      maxLastChunkLength: 14,
      useSmartSplitting: true,
    });

    expect(chunks.join("")).toBe(input);
  });

  it("should not turn unmatched literal delimiters into synthetic formatting", () => {
    const input = "a*b c d e f g h";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 5,
      maxLastChunkLength: 5,
      useSmartSplitting: true,
      hardMaxChunkLength: 5,
    });

    expect(chunks.join("")).toBe(input);
    expect(chunks).not.toContain("*c d*");
  });

  it("should not add formatting wrappers for escaped emphasis delimiters", () => {
    const input = "literal \\* emphasis marker still text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
      hardMaxChunkLength: 12,
    });

    expect(chunks.join("")).toBe(input);
  });

  it("should normalize tilde code fences to backtick display fences", () => {
    const chunks = chunkMarkdownForEmbeds("~~~js\nconsole.log(1)\n~~~", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```js\nconsole.log(1)\n```"]);
  });

  it("should drop invalid backticks from normalized fence info strings", () => {
    const chunks = chunkMarkdownForEmbeds("~~~lang`x\ncode\n~~~", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
    });

    expect(chunks).toEqual(["```\ncode\n```"]);
  });

  it("should not shrink backward into a fence opener", () => {
    const chunks = chunkMarkdownForEmbeds("a".repeat(4079) + "\n```ts\nx", {
      maxChunkLength: 4086,
      maxLastChunkLength: 4086,
      useSmartSplitting: true,
      hardMaxChunkLength: 4086,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(4079) + "\n");
    expect(chunks[1]).toBe("```ts\nx\n```");
    expect(chunks.every((chunk) => chunk.length <= 4086)).toBe(true);
  });

  it("should balance multi-backtick inline code when split", () => {
    const chunks = chunkMarkdownForEmbeds("prefix ``code value`` suffix", {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
      hardMaxChunkLength: 12,
    });

    expect(chunks).toEqual(["prefix ", "``code ``", "``value`` ", "suffix"]);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
  });

  it("should not duplicate inline code markers at closing boundaries", () => {
    const chunks = chunkMarkdownForEmbeds("prefix `code` suffix", {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
      hardMaxChunkLength: 12,
    });

    expect(chunks).toEqual(["prefix ", "`code` ", "suffix"]);
  });

  it("should not add inline code wrappers for escaped backticks", () => {
    const input = "literal \\` backtick still text";
    const chunks = chunkMarkdownForEmbeds(input, {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
      hardMaxChunkLength: 12,
    });

    expect(chunks.join("")).toBe(input);
  });

  it("should not split surrogate pairs", () => {
    const chunks = chunkMarkdownForEmbeds("abc🌸def", {
      maxChunkLength: 4,
      maxLastChunkLength: 4,
      useSmartSplitting: false,
    });

    expect(chunks).not.toContain("\ud83c");
    expect(chunks).not.toContain("\udf38");
    expect(chunks.join("")).toBe("abc🌸def");
  });

  it("should preserve surrogate pairs with tiny budgets", () => {
    const chunks = chunkMarkdownForEmbeds("🌸", {
      maxChunkLength: 1,
      maxLastChunkLength: 1,
      useSmartSplitting: false,
      hardMaxChunkLength: 1,
    });

    expect(chunks).toEqual(["🌸"]);
  });

  it("should only complete the last streaming display chunk", () => {
    const chunks = chunkMarkdownForEmbeds("prefix enough text **bold", {
      maxChunkLength: 12,
      maxLastChunkLength: 12,
      useSmartSplitting: true,
      completeLastChunk: true,
    });

    expect(chunks.at(-1)?.endsWith("**")).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.length <= 14)).toBe(true);
  });

  it("should preserve unclosed emphasis across streaming chunks", () => {
    const chunks = chunkMarkdownForEmbeds("**aaaaaaaaaaaaaaaaaaaaaaaaa", {
      maxChunkLength: 10,
      maxLastChunkLength: 10,
      useSmartSplitting: true,
      hardMaxChunkLength: 10,
      completeLastChunk: true,
    });

    expect(chunks).toEqual(["**aaaaaa**", "**aaaaaa**", "**aaaaaa**", "**aaaaaa**", "**a**"]);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });

  it("should preserve unclosed single emphasis across streaming chunks", () => {
    const chunks = chunkMarkdownForEmbeds("*aaaaaaaaaaaaaaaaaaaaaaaaa", {
      maxChunkLength: 9,
      maxLastChunkLength: 9,
      useSmartSplitting: true,
      hardMaxChunkLength: 9,
      completeLastChunk: true,
    });

    expect(chunks).toEqual(["*aaaaaaa*", "*aaaaaaa*", "*aaaaaaa*", "*aaaa*"]);
    expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
  });

  it("should complete unmatched markdown on final last chunk when requested", () => {
    const chunks = chunkMarkdownForEmbeds("hello **bold", {
      maxChunkLength: 100,
      maxLastChunkLength: 100,
      useSmartSplitting: true,
      hardMaxChunkLength: 100,
      completeLastChunk: true,
    });

    expect(chunks).toEqual(["hello **bold**"]);
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
});
