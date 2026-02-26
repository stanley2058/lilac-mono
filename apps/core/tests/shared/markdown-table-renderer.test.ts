import { describe, expect, it } from "bun:test";

import { renderMarkdownTablesAsCodeBlocks } from "../../src/shared/markdown-table-renderer";

function extractCodeBlockLines(text: string): string[] {
  const startTag = "```text\n";
  const start = text.indexOf(startTag);
  if (start === -1) return [];

  const bodyStart = start + startTag.length;
  const end = text.indexOf("\n```", bodyStart);
  if (end === -1) return [];

  return text.slice(bodyStart, end).split("\n");
}

describe("markdown-table-renderer", () => {
  it("renders markdown tables as unicode codeblock tables by default", () => {
    const input = ["| Name | Score |", "| --- | ---: |", "| Alice | 10 |", "| Bob | 200 |"].join(
      "\n",
    );

    const output = renderMarkdownTablesAsCodeBlocks(input);
    expect(output.startsWith("```text\n")).toBe(true);
    expect(output).toContain("┌");
    expect(output).toContain("│ Name");
    expect(output).toContain("Bob");
  });

  it("supports ascii rendering style", () => {
    const input = ["| Name | Score |", "| --- | ---: |", "| Alice | 10 |"].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      style: "ascii",
      maxWidth: 80,
    });

    expect(output).toContain("+");
    expect(output).toContain("|");
    expect(output).not.toContain("┌");
  });

  it("keeps rendered table width under configured max width", () => {
    const input = [
      "| ColA | ColB |",
      "| --- | --- |",
      "| very long content that must wrap | second column with long content |",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      style: "unicode",
      maxWidth: 32,
    });

    const lines = extractCodeBlockLines(output);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(32);
    }
  });

  it("handles cjk + emoji widths with Bun.stringWidth", () => {
    const input = ["| Key | Value |", "| --- | --- |", "| a | 漢字🙂漢字🙂漢字🙂漢字🙂 |"].join(
      "\n",
    );

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      style: "unicode",
      maxWidth: 24,
    });

    const lines = extractCodeBlockLines(output);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it("uses list fallback when table cannot fit max width", () => {
    const input = [
      "| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      maxWidth: 12,
      fallbackMode: "list",
    });

    expect(output).toContain("```text\n");
    expect(output).toContain("row 1:");
    expect(output).toContain("  c1: 1");

    const lines = extractCodeBlockLines(output);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  it("keeps list fallback width-safe with long labels and cjk values", () => {
    const input = [
      "| extremely-long-header-1 | extremely-long-header-2 | extremely-long-header-3 | extremely-long-header-4 | extremely-long-header-5 | extremely-long-header-6 | extremely-long-header-7 | extremely-long-header-8 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 漢字🙂漢字🙂 | 值🙂值🙂 | 三🙂三🙂 | 四🙂四🙂 | 五🙂五🙂 | 六🙂六🙂 | 七🙂七🙂 | 八🙂八🙂 |",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      maxWidth: 12,
      fallbackMode: "list",
    });

    expect(output).toContain("row 1:");
    const lines = extractCodeBlockLines(output);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(12);
    }
  });

  it("supports passthrough fallback mode", () => {
    const input = [
      "| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input, {
      maxWidth: 12,
      fallbackMode: "passthrough",
    });

    expect(output).toBe(input);
  });

  it("does not rewrite tables inside fenced code blocks", () => {
    const input = [
      "before",
      "```md",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "```",
      "after",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input);
    expect(output).toBe(input);
  });

  it("leaves non-table pipe content unchanged", () => {
    const input = ["| A | B |", "| 1 | 2 |"].join("\n");
    const output = renderMarkdownTablesAsCodeBlocks(input);
    expect(output).toBe(input);
  });

  it("rewrites multiple tables in one document", () => {
    const input = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "middle",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");

    const output = renderMarkdownTablesAsCodeBlocks(input);
    const matches = output.match(/```text/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
