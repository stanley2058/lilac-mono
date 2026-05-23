import { describe, expect, it } from "bun:test";
import { buildMarkdownIndex } from "../../../../src/surface/discord/output/markdown-index";

describe("markdown-index", () => {
  it("should report active fence state inside an open fence", () => {
    const index = buildMarkdownIndex("```js\nconsole.log(1)");

    expect(index.getStateAt(6).fence).toEqual({ markerLength: 3, lang: "js" });
  });

  it("should treat fence lines as unsafe split zones", () => {
    const index = buildMarkdownIndex("```js\ncode\n```");

    expect(index.isSafeOffset(1)).toBe(false);
    expect(index.isSafeOffset(7)).toBe(true);
  });

  it("should keep markdown fences outermost for markdown language blocks", () => {
    const input = ["```md", "```ts", "code", "```", "tail", "```"].join("\n");
    const index = buildMarkdownIndex(input);

    expect(index.codeFences).toHaveLength(1);
    expect(index.codeFences[0]?.closeStart).toBe(input.lastIndexOf("```"));
  });

  it("should not let closed markdown fences absorb later code blocks", () => {
    const input = ["```md", "inside", "```", "outside", "```js", "code", "```"].join("\n");
    const index = buildMarkdownIndex(input);

    expect(index.codeFences).toHaveLength(2);
    expect(index.codeFences[0]).toMatchObject({
      lang: "md",
      closeStart: input.indexOf("```\noutside"),
    });
    expect(index.codeFences[1]).toMatchObject({ lang: "js" });
  });

  it("should close outer markdown fences before unclosed shorter nested fences", () => {
    const input = ["````md", "```ts", "code", "````", "outside"].join("\n");
    const index = buildMarkdownIndex(input);

    expect(index.codeFences).toHaveLength(1);
    expect(index.codeFences[0]?.closeStart).toBe(input.indexOf("````\noutside"));
  });

  it("should not treat fence closer ticks as inline code state", () => {
    const input = "```js\none\n```\nafter";
    const index = buildMarkdownIndex(input);
    const afterCloser = input.indexOf("after");

    expect(index.getStateAt(afterCloser).inlineCode).toBeNull();
  });

  it("should not treat list markers as formatting state", () => {
    const index = buildMarkdownIndex("* item one with lots of text");

    expect(index.getStateAt(10).formatting).toEqual([]);
  });

  it("should recognize tilde fences", () => {
    const index = buildMarkdownIndex("~~~js\ncode\n~~~");

    expect(index.codeFences[0]).toMatchObject({ marker: "~", lang: "js" });
    expect(index.getStateAt(6).fence).toEqual({ markerLength: 3, lang: "js" });
  });

  it("should preserve multi-backtick inline code marker state", () => {
    const input = "prefix ``code value`` suffix";
    const index = buildMarkdownIndex(input);

    expect(index.getStateAt(input.indexOf("value")).inlineCode).toEqual({ marker: "``" });
  });

  it("should ignore escaped backticks in inline code state", () => {
    const input = "literal \\` backtick still text";
    const index = buildMarkdownIndex(input);

    expect(index.getStateAt(input.indexOf("still")).inlineCode).toBeNull();
  });

  it("should conservatively track unclosed emphasis state", () => {
    const index = buildMarkdownIndex("**bold text still streaming");

    expect(index.getStateAt(10).formatting).toEqual(["**"]);
  });

  it("should conservatively track unclosed single emphasis state", () => {
    const index = buildMarkdownIndex("*italic text still streaming");

    expect(index.getStateAt(10).formatting).toEqual(["*"]);
  });

  it("should ignore escaped emphasis delimiters in formatting state", () => {
    const input = "literal \\* emphasis marker still text";
    const index = buildMarkdownIndex(input);

    expect(index.getStateAt(input.indexOf("still")).formatting).toEqual([]);
  });
});
