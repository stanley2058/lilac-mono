import type { JSONContent } from "@tiptap/core";
import { serializeCitation } from "@stanley2058/lilac-client-protocol";

/**
 * Inputs the composer's Markdown codec must keep stable. The golden file records what the Plate
 * codec produced for each before the port to mdast, so the port is checked against it.
 */
const workflowRunId = `wfrun:${"a".repeat(64)}`;
const citation = serializeCitation({
  version: 1,
  threadId: "thread",
  messageId: "response",
  text: "A saved quote",
  start: 0,
  end: 13,
  prefix: "",
  suffix: "",
});

export const markdownCorpus: string[] = [
  "",
  " ",
  "\n",
  "\n\n",
  "first\n\n\nlast",
  "first\n\n\n\nfifth",
  "\nfirst",
  "first\n",
  "first\n\n",
  "**first**\n_last_",
  "first\n\nsecond\n\nthird",
  "sounds about right.\n\nbtw, cheaper than water (whatever that means)\nhttps://simonwillison.net/2026/Sep/22/opus-and-sol-and-luna/",
  "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```",
  "* one\n  * nested\n* two",
  "* one\n  * two\n    * three\n      * four",
  "#### Fourth\n\n##### Fifth\n\n###### Sixth",
  "# Heading with **bold** and `code`",
  "* [x] done\n* [ ] pending\n  * [x] nested",
  "- [ ] a\n- [x] b",
  "before\n\n---\n\nafter",
  "***\n\n___\n\n- - -",
  "3. third\n4. fourth",
  "1. a\n   1. nested ordered\n2. b",
  "1) paren\n2) list",
  "+ plus\n+ items",
  "- dash\n- items",
  "* a\n\n* b",
  "* item\n\n  continuation paragraph",
  "* item\n  ```\n  code\n  ```",
  "1. a\n\n   para in item\n2. b",
  "* a\n1. b",
  "* one\n\n\n* two",
  "> first\n> next\n>\n> paragraph",
  "> quote\n> * list in quote",
  "> > nested quote",
  "a\n\n> q\n\nb",
  "> ```\n> code in quote\n> ```",
  "**注意：**粗體 ~~刪除：~~文字",
  "中文 *強調* 和 **粗體**",
  "https://example.com/a_b?q=one&next=two",
  "[example.com](https://example.com)",
  '[example](https://example.com/a_(b) "A title")',
  "Before [**label**](https://example.com) after",
  "[https://example.com](https://example.com)",
  "[line\nbreak](https://example.com)",
  "Before \uE0000\uE000 [example](https://example.com) after",
  "<https://example.com>",
  "www.example.com and user@example.com",
  "[ref][1]\n\n[1]: https://x.example",
  "[empty]()",
  "[link with *emph*](http://a.example)",
  "![alt](https://x.example/y.png)",
  "Text ![img](https://x.example/u.png) more",
  "Footnote[^1]\n\n[^1]: the note",
  "<b>html</b> inline",
  "<div>\nblock html\n</div>",
  "a<br />b",
  "\\*escaped\\* \\# not heading",
  "1\\. not a list",
  "&amp; &copy; &#35;",
  "emoji 😀 and tab\tchar",
  "line with trailing spaces   ",
  "  leading spaces",
  "\ttab start",
  "trailing backslash\\",
  "a  \nb",
  "a\\\nb",
  "Title\n=====",
  "Sub\n---",
  "    indented code",
  "```\nno lang\n```",
  "~~~py\nx\n~~~",
  "````\n```\nnested fence\n```\n````",
  "```\n$review\n```",
  "*a* __b__ ***c*** _**d**_",
  "**bold with `code` inside**",
  "`` code with ` backtick ``",
  "a ~~b~~ ~c~",
  "$x$ and $$y$$",
  "@mention #tag",
  "$my_skill",
  "/skill:my_skill next",
  "/my_command argument_with_underscores",
  "/fixture-status ",
  "**Keep** $Rev later",
  "**Compare**  with the earlier image",
  "**Compare** [screen.png](attachment:image-one)  with the earlier image",
  "Compare [my_\\[draft\\].txt](attachment:file) after",
  "[x](attachment:a) [x](attachment:b)",
  "See [notes.txt](attachment:old-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  "* [file.txt](attachment:in-list)\n* > not a quote",
  "> [file.txt](attachment:in-quote)",
  "# [file.txt](attachment:in-heading)",
  "[Discussion](/?ref=discord%3Achannel&range=first..last)",
  "[#native:thread](/?ref=native%3Athread&message=message)",
  "Before [#native:thread](/?ref=native%3Athread) after",
  `Quote ${citation}\n\n\`${citation}\``,
  `* ${citation}`,
  `Check ${workflowRunId} and tell me.`,
  `Use \`${workflowRunId}\` here`,
  `\`\`\`\n${workflowRunId}\n\`\`\``,
  `**${workflowRunId}** and ~~${workflowRunId}~~`,
  `* ${workflowRunId}`,
  [
    "| Surface | Input | Output |",
    "| :--- | --- | ---: |",
    "| **Web** | Text and files | [Rich content](https://example.com) |",
    "| TUI | `a\\|b` | Plain text |",
  ].join("\n"),
  "Before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter",
  "> | A | B |\n> | --- | --- |\n> | 1 | 2 |",
  '| Name | Link |\n| --- | --- |\n| Earth | [Docs][ref] |\n\n[ref]: https://example.com "Title"',
  "| a |\n|---|",
  "Text\n| a | b |\n|---|---|\n| 1 | 2 |",
  "* | a | b |\n  |---|---|\n  | 1 | 2 |",
  "hello\n$sk",
  "/tarot 3 single more",
  "$review /skill:review $reviewer $review-next `$review` **x**$review $Better Result, $a+b\n\n```\n$review\n```",
  "x".repeat(300),
];

const text = (value: string, marks: string[] = []): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const item = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });

export const documentCorpus: { name: string; doc: JSONContent }[] = [
  { name: "typed emphasis characters", doc: doc(paragraph(text("*not emph* _no_ **no**"))) },
  { name: "typed heading marker", doc: doc(paragraph(text("# not heading"))) },
  {
    name: "typed list markers",
    doc: doc(
      paragraph(text("1. not list")),
      paragraph(text("- not list")),
      paragraph(text("+ plus")),
    ),
  },
  { name: "typed quote marker", doc: doc(paragraph(text("> not quote"))) },
  { name: "typed underscores", doc: doc(paragraph(text("a_b_c snake_case __init__"))) },
  { name: "typed html", doc: doc(paragraph(text("<tag> & </tag> &amp;"))) },
  {
    name: "typed link syntax",
    doc: doc(paragraph(text("[x](y) and [label](https://example.com)"))),
  },
  { name: "typed backticks", doc: doc(paragraph(text("`tick` and ``double``"))) },
  { name: "typed backslashes", doc: doc(paragraph(text("C:\\path\\to and \\*"))) },
  { name: "typed tildes and pipes", doc: doc(paragraph(text("~~not strike~~ |a|b|"))) },
  { name: "typed thematic break", doc: doc(paragraph(text("---")), paragraph(text("***"))) },
  { name: "typed fence", doc: doc(paragraph(text("```js"))) },
  { name: "leading and trailing spaces", doc: doc(paragraph(text("  lead and trail  "))) },
  { name: "only spaces", doc: doc(paragraph(text("   "))) },
  {
    name: "bold and italic overlap",
    doc: doc(
      paragraph(
        text("a "),
        text("bold", ["bold"]),
        text("both", ["bold", "italic"]),
        text("italic", ["italic"]),
        text(" z"),
      ),
    ),
  },
  {
    name: "marks with outer spaces",
    doc: doc(paragraph(text(" spaced ", ["bold"]), text("next"))),
  },
  {
    name: "code with bold",
    doc: doc(paragraph(text("x", ["bold", "code"]), text(" "), text("y", ["code"]))),
  },
  {
    name: "strike and code",
    doc: doc(paragraph(text("gone", ["strike"]), text(" "), text("c", ["strike", "code"]))),
  },
  {
    name: "adjacent bold runs",
    doc: doc(
      paragraph(text("one", ["bold"]), text("two", ["bold", "italic"]), text("three", ["bold"])),
    ),
  },
  {
    name: "hard break in paragraph",
    doc: doc(paragraph(text("a"), { type: "hardBreak" }, text("b"))),
  },
  { name: "hard break at end", doc: doc(paragraph(text("a"), { type: "hardBreak" })) },
  {
    name: "hard break inside bold",
    doc: doc(
      paragraph(
        text("a", ["bold"]),
        { type: "hardBreak", marks: [{ type: "bold" }] },
        text("b", ["bold"]),
      ),
    ),
  },
  {
    name: "empty paragraphs between",
    doc: doc(
      paragraph(text("a")),
      { type: "paragraph" },
      { type: "paragraph" },
      paragraph(text("b")),
    ),
  },
  { name: "leading empty paragraph", doc: doc({ type: "paragraph" }, paragraph(text("a"))) },
  {
    name: "trailing empty paragraphs",
    doc: doc(paragraph(text("a")), { type: "paragraph" }, { type: "paragraph" }),
  },
  {
    name: "heading with break",
    doc: doc({
      type: "heading",
      attrs: { level: 2 },
      content: [text("a"), { type: "hardBreak" }, text("b")],
    }),
  },
  {
    name: "code block with fence inside",
    doc: doc({ type: "codeBlock", attrs: { language: null }, content: [text("```\ninner\n```")] }),
  },
  {
    name: "code block with language",
    doc: doc({
      type: "codeBlock",
      attrs: { language: "py" },
      content: [text("print(1)\n\nprint(2)")],
    }),
  },
  { name: "empty code block", doc: doc({ type: "codeBlock", attrs: { language: null } }) },
  {
    name: "nested bullet list",
    doc: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("a")), { type: "bulletList", content: [item(paragraph(text("b")))] }),
        item(paragraph(text("c"))),
      ],
    }),
  },
  {
    name: "ordered list from three",
    doc: doc({
      type: "orderedList",
      attrs: { start: 3 },
      content: [item(paragraph(text("c"))), item(paragraph(text("d")))],
    }),
  },
  {
    name: "task list",
    doc: doc({
      type: "bulletList",
      content: [
        { type: "listItem", attrs: { checked: true }, content: [paragraph(text("done"))] },
        { type: "listItem", attrs: { checked: false }, content: [paragraph(text("todo"))] },
      ],
    }),
  },
  {
    name: "list item with two paragraphs",
    doc: doc({
      type: "bulletList",
      content: [item(paragraph(text("first")), paragraph(text("second")))],
    }),
  },
  {
    name: "list item with code block",
    doc: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("run")), {
          type: "codeBlock",
          attrs: { language: "sh" },
          content: [text("ls")],
        }),
      ],
    }),
  },
  {
    name: "empty list item",
    doc: doc({ type: "bulletList", content: [item({ type: "paragraph" })] }),
  },
  {
    name: "ordered inside bullet",
    doc: doc({
      type: "bulletList",
      content: [
        item(paragraph(text("a")), {
          type: "orderedList",
          attrs: { start: 1 },
          content: [item(paragraph(text("one")))],
        }),
      ],
    }),
  },
  {
    name: "blockquote with list and code",
    doc: doc({
      type: "blockquote",
      content: [
        paragraph(text("q")),
        { type: "bulletList", content: [item(paragraph(text("i")))] },
        { type: "codeBlock", attrs: { language: null }, content: [text("c")] },
      ],
    }),
  },
  { name: "empty blockquote", doc: doc({ type: "blockquote", content: [{ type: "paragraph" }] }) },
  {
    name: "indented paragraph",
    doc: doc({ type: "paragraph", attrs: { indent: 2 }, content: [text("indented")] }),
  },
  {
    name: "horizontal rule between",
    doc: doc(paragraph(text("a")), { type: "horizontalRule" }, paragraph(text("b"))),
  },
  {
    name: "skill chip",
    doc: doc(
      paragraph(
        text("use "),
        { type: "composer_skill", attrs: { id: "s", name: "my_skill", text: "$my_skill" } },
        text(" now"),
      ),
    ),
  },
  {
    name: "workflow chip with mark",
    doc: doc(
      paragraph({
        type: "composer_workflow_run",
        attrs: { runId: workflowRunId },
        marks: [{ type: "italic" }],
      }),
    ),
  },
  {
    name: "attachment in list",
    doc: doc({
      type: "bulletList",
      content: [
        item(
          paragraph({
            type: "composer_attachment",
            attrs: { attachmentKey: "k", name: "a_[b].txt" },
          }),
        ),
      ],
    }),
  },
  {
    name: "attachment between marks",
    doc: doc(
      paragraph(
        text("x", ["bold"]),
        { type: "composer_attachment", attrs: { attachmentKey: "k", name: "f.png" } },
        text("y", ["bold"]),
      ),
    ),
  },
  {
    name: "reference in quote",
    doc: doc({
      type: "blockquote",
      content: [paragraph({ type: "composer_reference", attrs: { url: "/?ref=native%3Athread" } })],
    }),
  },
  {
    name: "citation in heading",
    doc: doc({
      type: "heading",
      attrs: { level: 1 },
      content: [
        {
          type: "composer_citation",
          attrs: { url: citation.slice(citation.indexOf("](") + 2, -1), citationKey: "c" },
        },
      ],
    }),
  },
  { name: "unicode and emoji", doc: doc(paragraph(text("café 😀 中文 \u00a0nbsp"))) },
  {
    name: "literal url text",
    doc: doc(paragraph(text("see https://example.com/a_b and www.example.com"))),
  },
];

export const attachmentCorpus = {
  resolve: [
    "First [same.png](attachment:first), then [same.png](attachment:second). `literal [same.png](attachment:first)`",
    "[missing.txt](attachment:missing)",
    "[safe.txt](attachment:known)",
    "Compare [image.png](attachment:upload-key)",
    "[#native:thread](/?ref=native%3Athread&message=message)",
    "* [a.txt](attachment:first)\n\n> [b.txt](attachment:second) after  ",
  ],
  remap: [
    "See [notes.txt](attachment:old-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
    "Compare [image.png](attachment:local-key)",
    "[x](attachment:other) **bold** [y](attachment:old-key)",
  ],
  restore: [
    "Before [notes.md](/api/resources/original) after [site](https://example.com).\n\n`/api/resources/original`",
    "Before ![notes](/api/resources/original) after",
    "",
    "Text only",
    "Ends with space ",
    "[#native:thread](/?ref=native%3Athread&message=message) and [notes.md](/api/resources/original)",
    "**注意：**粗體 ~~刪除：~~文字",
    "![other](https://example.com/x.png) and ![notes](/api/resources/original)",
    "# Heading\n\n* item",
  ],
};
