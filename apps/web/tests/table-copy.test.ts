import { expect, test } from "bun:test";
import { tableCsv, tableText } from "../src/table-copy";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTableSources } from "../src/markdown-table-source";

test("CSV preserves commas, quotes, newlines, Unicode, and empty cells", () => {
  expect(
    tableCsv([
      ["Name", "Notes", "Empty"],
      ["火星", 'one, "two"', ""],
      ["Venus", "first\nsecond", "last"],
    ]),
  ).toBe('Name,Notes,Empty\r\n火星,"one, ""two""",\r\nVenus,"first\nsecond",last');
});

test("selected table text uses tabs and newlines without Markdown delimiters", () => {
  expect(
    tableText([
      ["Planet", "Score"],
      ["Mars", "8"],
      ["", "6"],
    ]),
  ).toBe("Planet\tScore\nMars\t8\n\t6");
});

test("table exports remove enclosing quote prefixes and include referenced definitions", () => {
  const sources = new Map<string, string>();
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkTableSources, sources]],
      children:
        '> | Name | Link |\n> | --- | --- |\n> | Earth | [Docs][ref] |\n\n[ref]: https://example.com "Title"\n\n[unused]: https://unused.example',
    }),
  );
  expect([...sources.values()]).toEqual([
    '| Name | Link |\n| --- | --- |\n| Earth | [Docs][ref] |\n\n[ref]: https://example.com "Title"',
  ]);
});
