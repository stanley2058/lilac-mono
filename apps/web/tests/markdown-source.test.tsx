import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Markdown } from "../src/components/Markdown";
import { remarkChatMath } from "../src/components/remark-chat-math";
import {
  createMarkdownSource,
  remarkMarkdownSource,
  rehypeMarkdownSource,
  selectedMarkdown,
  sourceTextSelection,
  type SourceSelection,
} from "../src/markdown-source";

function parse(text: string) {
  const source = createMarkdownSource(text);
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkChatMath, [remarkMarkdownSource, source]]}
      rehypePlugins={[[rehypeMarkdownSource, source]]}
    >
      {text}
    </ReactMarkdown>,
  );
  return { source, html };
}

function select(text: string, values: [string, number?, number?][]) {
  const { source } = parse(text);
  const selection: SourceSelection = new Map();
  for (const [value, start = 0, end = value.length] of values) {
    const node = source.nodes.find((node) => {
      const normalized = node.value?.replace(/\r\n?/g, "\n");
      return (
        (node.type === "inlineCode" ? normalized?.replaceAll("\n", " ") : normalized) === value
      );
    })!;
    const slice = sourceTextSelection(
      source,
      node.id,
      value,
      start,
      end,
      (entity) => ({ "&amp;": "&", "&#x1f680;": "🚀" })[entity] ?? entity,
    )!;
    selection.set(node.id, slice);
  }
  return selectedMarkdown(source, selection);
}

test("source metadata reaches HTML text and rich-render wrappers", () => {
  const text =
    "## Title\n\nA **bold** [link](https://example.com) and `inline`.\n\n```ts\nconst value = 42;\n```";
  const html = renderToStaticMarkup(<Markdown text={text} sourcePositions />);
  expect(html).toContain('data-markdown-source=""');
  expect(html).toContain('data-source="3:8:2">Title</span>');
  expect(html).toMatch(/<div[^>]*data-source="\d+:\d+:\d+"[^>]*data-language="ts"/);
  expect(html).toMatch(/<span[^>]*data-source="\d+:\d+:\d+"[^>]*><a class="markdown-link"/);
});

test("partial selections retain the original inline delimiters and link destination", () => {
  expect(select("A __bold text__ after", [["bold text", 5, 9]])).toBe("__text__");
  expect(select("A *one **two** three* after", [["one ", 2], ["two"], [" three", 0, 4]])).toBe(
    "*e **two** thr*",
  );
  expect(select('[long label](https://example.com "Title")', [["long label", 5, 10]])).toBe(
    '[label](https://example.com "Title")',
  );
  expect(select("Use ``a ` b`` now", [["a ` b", 2, 5]])).toBe("`` ` b ``");
});

test("escaped characters and entities map to original source spans", () => {
  expect(select("A \\*literal\\* &amp; &#x1f680; end", [["A *literal* & 🚀 end", 2, 15]])).toBe(
    "\\*literal\\* &amp; &#x1f680;",
  );
  expect(select("one\r\ntwo", [["one\ntwo", 2, 6]])).toBe("e\r\ntw");
  expect(select("> one\n> \\>two", [["one\n>two", 4, 8]])).toBe("> \\>two");
  expect(select("> `one\n> two`", [["one two", 4, 7]])).toBe("> `two`");
  expect(select("- `one\n  two`", [["one two", 4, 7]])).toBe("- `two`");
});

test("source slicing preserves heading, list, quote, and table syntax", () => {
  expect(select("Title\n=====\n", [["Title"]])).toBe("Title\n=====");
  expect(select("3. [x] first\n4. second", [["first"], ["second"]])).toBe(
    "3. [x] first\n4. second",
  );
  expect(select("> one\n> two", [["one\ntwo"]])).toBe("> one\n> two");
  expect(select("| A | B |\n| :-- | --: |\n| c | d |", [["A"], ["B"], ["c"], ["d"]])).toBe(
    "| A | B |\n| :-- | --: |\n| c | d |",
  );
  expect(select("| A | B |\n| :-- | --: |\n| c | d |", [["c"], ["d"]])).toBe(
    "| c | d |\n| :-- | --: |",
  );
  expect(select("| A | B |\n| :-- | --: |\n| c | d |", [["d"]])).toBe("| d |\n| --: |");
  expect(select("| A | B |\n| :-- | --: |", [["A"]])).toBe("| A |\n| :-- |");
});

test("reference-style links keep their original definitions", () => {
  expect(
    select("Read [the source][ref].\n\n[ref]: https://example.com 'Title'", [["the source"]]),
  ).toBe("[the source][ref]\n\n[ref]: https://example.com 'Title'");
});

test("unwrapping a reference link retains crossed inner formatting without its definition", () => {
  const { source } = parse("[one **two** three][ref]\n\n[ref]: https://example.com");
  const selection: SourceSelection = new Map();
  for (const node of source.nodes.filter((node) => node.value === "two" || node.value === " three"))
    selection.set(node.id, { start: node.start, end: node.end });
  const link = source.nodes.find((node) => node.type === "linkReference")!;
  expect(selectedMarkdown(source, selection, new Set([link.id]))).toBe("**two** three");
});

test("mixed prose and partial code copy only the selected code with its original fence", () => {
  expect(
    select("Before\n\n~~~js\nfirst();\nsecond();\n~~~", [
      ["Before"],
      ["first();\nsecond();", 0, 8],
    ]),
  ).toBe("Before\n\n~~~js\nfirst();\n~~~");
  expect(
    select("Before\n\n    first();\n    second();", [["Before"], ["first();\nsecond();", 9, 18]]),
  ).toBe("Before\n\n    second();");
});

test("partial fenced code remains a code block inside nested quotes and lists", () => {
  const examples = [
    "> ```js\n> first();\n> second();\n> ```",
    "> > ```js\n> > first();\n> > second();\n> > ```",
    "- ```js\n  first();\n  second();\n  ```",
    "- one\n  - ```js\n    first();\n    second();\n    ```",
    "> - ```js\n>   first();\n>   second();\n>   ```",
    "- > ```js\n  > first();\n  > second();\n  > ```",
  ];
  for (const example of examples) {
    const copied = select(`Before\n\n${example}`, [["Before"], ["first();\nsecond();", 9, 18]]);
    expect(copied).not.toContain("first();");
    expect(
      parse(copied)
        .source.nodes.filter((node) => node.type === "code")
        .map((node) => node.value),
    ).toEqual(["second();"]);
  }
});

test("mixed copy beginning in indented code keeps the rendered code content", () => {
  for (const opening of ["```js", "  ```js", "    "]) {
    const indent = opening === "    " ? "    " : /^ */.exec(opening)![0];
    const code =
      opening === "    "
        ? `${indent}first();\n${indent}second();`
        : `${opening}\n${indent}first();\n${indent}second();\n${indent}\`\`\``;
    const copied = select(`${code}\n\nAfter`, [["first();\nsecond();", 9, 18], ["After"]]);
    expect(
      parse(copied)
        .source.nodes.filter((node) => node.type === "code")
        .map((node) => node.value),
    ).toEqual(["second();"]);
    expect(copied).toContain("After");
  }
});

test("math reparsing preserves source offsets after currency and escaped brackets", () => {
  const text = "Pay $10 **now** and $7.\n\n## \\[Draft\\] *title*";
  const { source } = parse(text);
  for (const node of source.nodes.filter(
    (node) => node.type === "strong" || node.type === "emphasis",
  ))
    expect(text.slice(node.start, node.end)).toBe(node.type === "strong" ? "**now**" : "*title*");
  expect(select(text, [["now"]])).toBe("**now**");
  expect(select(text, [["title"]])).toBe("## *title*");
});
