import { describe, expect, it } from "bun:test";

import {
  buildMarkdownContinuationPrefix,
  getMarkdownContinuationState,
} from "../../../../src/surface/discord/output/markdown-state";

function expectPrefix(text: string, expected: string, lookahead = ""): void {
  const state = getMarkdownContinuationState(text, lookahead);

  expect(buildMarkdownContinuationPrefix(state)).toBe(expected);
}

describe("markdown-state", () => {
  describe("code fences", () => {
    it("should reopen an unclosed fence with its marker and language", () => {
      expectPrefix("```ts\nconst x = 1;", "```ts\n");
    });

    it("should not reopen a closed fence", () => {
      expectPrefix("```ts\nconst x = 1;\n```", "");
    });

    it("should allow longer closers for shorter fence openers", () => {
      expectPrefix("```ts\nconst x = 1;\n````", "");
    });

    it("should keep fences open when the closer is shorter than the opener", () => {
      expectPrefix("````ts\nconst x = 1;\n```", "````ts\n");
    });

    it("should accept fence openers indented up to three spaces", () => {
      expectPrefix("   ```ts\nconst x = 1;", "```ts\n");
    });

    it("should ignore fence-like lines indented four spaces", () => {
      expectPrefix("    ```ts\nconst x = 1;", "");
    });

    it("should not infer inline formatting from code fence contents", () => {
      expectPrefix("```ts\nconst glob = '**/*';\n```\nplain", "");
    });

    it("should not reopen after a closed markdown fence containing a closed nested fence", () => {
      expectPrefix("````md\n```ts\nconst x = 1;\n```\n````", "");
    });

    it("should close an outer markdown fence with a longer marker than an unclosed nested example", () => {
      expectPrefix("````md\n```ts\nconst x = 1;\n````", "");
    });

    it("should close a same-marker markdown fence with an unclosed nested example", () => {
      expectPrefix("```md\n```ts\nconst x = 1;\n```", "");
    });

    it("should reopen a genuinely unclosed fence after an earlier closed markdown example", () => {
      expectPrefix("````md\n```ts\nconst x = 1;\n```\n````\n```js\nopen", "```js\n");
    });
  });

  describe("inline code", () => {
    it("should reopen unclosed inline code", () => {
      expectPrefix("Use `code", "`");
    });

    it("should reopen unclosed double-backtick inline code", () => {
      expectPrefix("Use ``code", "``");
    });

    it("should reopen unclosed long-backtick inline code", () => {
      expectPrefix("Use `````code", "`````");
    });

    it("should not reopen closed inline code", () => {
      expectPrefix("Use `code` here", "");
    });

    it("should not infer formatting inside closed long-backtick inline code", () => {
      expectPrefix("`````*````` tail", "");
    });

    it("should ignore escaped inline-code openers", () => {
      expectPrefix("Escaped \\` marker", "");
    });

    it("should treat escaped-looking backticks as inline-code closers", () => {
      expectPrefix("Inline `a\\` then prose", "");
    });

    it("should preserve outer formatting around open inline code", () => {
      expectPrefix("**bold `code", "**`");
    });

    it("should preserve delimiter flanking around closed inline code", () => {
      expectPrefix("**`code` tail", "**");
    });
  });

  describe("emphasis and delimiter rules", () => {
    it("should reopen open emphasis markers", () => {
      expectPrefix("**bold", "**");
      expectPrefix("*italic", "*");
      expectPrefix("***bold italic", "***");
      expectPrefix("__bold", "__");
      expectPrefix("_italic", "_");
      expectPrefix("~~strike", "~~");
    });

    it("should preserve nested formatting order", () => {
      expectPrefix("**bold *italic", "***");
      expectPrefix("~~strike **bold", "~~**");
    });

    it("should not reopen closed emphasis markers", () => {
      expectPrefix("**bold** and *italic* and ~~strike~~", "");
    });

    it("should not reopen literal multiplication as italic", () => {
      expectPrefix("The formula is 2 * 3 and keeps going", "");
    });

    it("should not reopen underscores inside ASCII or Unicode words", () => {
      expectPrefix("The snake_case identifier keeps going", "");
      expectPrefix("The caf\u00e9_na\u00efve identifier keeps going", "");
    });

    it("should ignore escaped formatting markers", () => {
      expectPrefix("Escaped \\* marker", "");
      expectPrefix("Escaped \\~~ marker", "");
    });

    it("should not reopen literal strong markers followed by whitespace", () => {
      expectPrefix("** warning marker", "");
      expectPrefix("__ note marker", "");
    });

    it("should not reopen strikethrough markers followed by whitespace", () => {
      expectPrefix("~~ warning marker", "");
    });

    it("should treat Unicode punctuation as punctuation in flanking checks", () => {
      expectPrefix("a**\u2014note marker", "");
    });
  });

  describe("math delimiters", () => {
    it("should reopen open inline math", () => {
      expectPrefix("The equation $$x + y", "$$");
    });

    it("should not reopen inline math closed before whitespace", () => {
      expectPrefix("The equation $$x + y$$ continues", "");
    });

    it("should not reopen escaped or literal shell-style dollar markers", () => {
      expectPrefix("Escaped \\$$ marker", "");
      expectPrefix("Run echo $$ and keep going", "");
    });

    it("should reopen open block math", () => {
      expectPrefix("$$\nx = y", "$$\n");
    });

    it("should not reopen closed block math at EOF", () => {
      expectPrefix("$$\nx = y\n$$", "");
    });

    it("should not reopen closed block math before following prose in lookahead", () => {
      expectPrefix("$$\nx = y\n$$", "", "\nAfter math prose");
    });
  });

  describe("state precedence", () => {
    it("should prefer an open code fence over inline state", () => {
      expectPrefix("```ts\nconst glob = '**/*';", "```ts\n");
    });

    it("should strip closed code spans before scanning formatting", () => {
      expectPrefix("`**not bold**` then prose", "");
    });
  });
});
