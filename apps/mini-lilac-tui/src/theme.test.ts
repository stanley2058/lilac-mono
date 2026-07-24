import { describe, expect, it } from "bun:test";

import { COLORS, createMarkdownSyntaxStyle, createTerminalTheme } from "./theme";

describe("Markdown syntax theme", () => {
  it("adopts terminal defaults and ANSI colors", () => {
    const theme = createTerminalTheme({
      palette: [
        "#101010",
        "#aa0000",
        "#00aa00",
        "#aa5500",
        "#0000aa",
        "#aa00aa",
        "#00aaaa",
        "#aaaaaa",
        null,
        "#ff5555",
        null,
        null,
        "#5555ff",
      ],
      defaultForeground: "#f0f0f0",
      defaultBackground: "#080808",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightBackground: null,
      highlightForeground: null,
    });

    expect(theme.background).toBe("transparent");
    expect(theme.text).toBe("#f0f0f0");
    expect(theme.accent).toBe("#00aaaa");
    expect(theme.success).toBe("#00aa00");
    expect(theme.warning).toBe("#aa5500");
    expect(theme.danger).toBe("#aa0000");
    expect(theme.tool).toBe("#aa00aa");
    expect(theme.model).toBe("#0000aa");
    expect(theme.syntaxType).toBe("#5555ff");
    expect(theme.panel).not.toBe(COLORS.panel);
  });

  it("uses the built-in palette when terminal defaults are unavailable", () => {
    expect(
      createTerminalTheme({
        palette: [],
        defaultForeground: null,
        defaultBackground: null,
        cursorColor: null,
        mouseForeground: null,
        mouseBackground: null,
        tekForeground: null,
        tekBackground: null,
        highlightBackground: null,
        highlightForeground: null,
      }),
    ).toBe(COLORS);
  });

  it("registers distinct styles for common Tree-sitter token groups", () => {
    const style = createMarkdownSyntaxStyle();
    try {
      expect(style.getStyle("comment")?.italic).toBe(true);
      expect(style.getStyle("keyword")?.italic ?? false).toBe(false);
      for (const name of ["type", "module", "class"] as const) {
        expect(style.getStyle(name)?.fg).toEqual(style.getStyle("type")?.fg);
        expect(style.getStyle(name)?.bold ?? false).toBe(false);
      }
      expect(style.getStyle("function.call")?.fg).toEqual(style.getStyle("function")?.fg);
      expect(style.getStyle("string")?.fg).not.toEqual(style.getStyle("keyword")?.fg);
      expect(style.getStyle("number")?.fg).not.toEqual(style.getStyle("string")?.fg);
    } finally {
      style.destroy();
    }
  });

  it("covers specialized language and markup scopes", () => {
    const style = createMarkdownSyntaxStyle();
    try {
      expect(style.getRegisteredNames()).toEqual(
        expect.arrayContaining([
          "comment.documentation",
          "keyword.type",
          "keyword.function",
          "string.escape",
          "variable.builtin",
          "punctuation.bracket",
          "tag",
          "attribute",
          "markup.heading.1",
          "markup.heading.6",
          "markup.strikethrough",
          "markup.raw.block",
        ]),
      );
    } finally {
      style.destroy();
    }
  });
});
