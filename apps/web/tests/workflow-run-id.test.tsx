import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MarkdownContent from "../src/components/MarkdownContent";
import ReactMarkdown from "react-markdown";
import {
  createMarkdownSource,
  rehypeMarkdownSource,
  remarkMarkdownSource,
  selectedMarkdown,
} from "../src/markdown-source";
import { isWorkflowRunId, remarkWorkflowRunIds, splitWorkflowRunIds } from "../src/workflow-run-id";

const hash = "a".repeat(64);
const id = `wfrun:${hash}`;

test("a workflow id is recognized alone and inside text", () => {
  expect(isWorkflowRunId(id)).toBe(true);
  expect(isWorkflowRunId(`${id} `)).toBe(false);
  expect(splitWorkflowRunIds(`See ${id}, please.`)).toEqual([
    { text: "See ", runId: false },
    { text: id, runId: true },
    { text: ", please.", runId: false },
  ]);
});

test("longer tokens and subagent runs are not workflow ids", () => {
  for (const text of [
    "wfrun:subagent:1234",
    "wfrun:has_underscore",
    `xwfrun:${hash}`,
    `prefix:wfrun:${hash}`,
    "wfrun:",
    "wfrun",
  ])
    expect(splitWorkflowRunIds(text).some((part) => part.runId)).toBe(false);
});

const chip = 'data-ui="workflow-run-id"';

function render(text: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MarkdownContent text={text} />
    </QueryClientProvider>,
  );
}

test("chat text and inline code show the chip; code blocks and links keep the id literal", () => {
  expect(render(`See ${id} now`)).toContain(chip);
  expect(render(`See \`${id}\` now`)).toContain(chip);
  const block = render(`\`\`\`text\n${id}\n\`\`\``);
  expect(block).toContain(id);
  expect(block).not.toContain(chip);
  expect(render(`[${id}](https://example.com)`)).not.toContain(chip);
});

test("rendered text around a chip stays in order", () => {
  const html = render(`Before ${id} after`);
  expect(html.indexOf("Before")).toBeLessThan(html.indexOf(id));
  expect(html.indexOf(id)).toBeLessThan(html.indexOf("after"));
});

function mapped(text: string) {
  const source = createMarkdownSource(text);
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkWorkflowRunIds, [remarkMarkdownSource, source]]}
      rehypePlugins={[[rehypeMarkdownSource, source]]}
    >
      {text}
    </ReactMarkdown>,
  );
  return source;
}

test("copying a selection over a chip returns the id and the text around it", () => {
  const text = `Before ${id} after`;
  const source = mapped(text);
  const chipNode = source.nodes.find((node) => node.type === "emphasis")!;
  expect(text.slice(chipNode.start, chipNode.end)).toBe(id);
  const selection = new Map(
    source.nodes
      .filter((node) => node.type === "text" || node.type === "emphasis")
      .map((node) => [node.id, { start: node.start, end: node.end }]),
  );
  expect(selectedMarkdown(source, selection)).toBe(text);
});

test("escapes and entities beside an id keep the chip and copy their original source", () => {
  for (const text of [`Tom &amp; Jerry ${id} after`, `Escaped \\* star ${id} after`]) {
    const source = mapped(text);
    const chipNode = source.nodes.find((node) => node.type === "emphasis")!;
    expect(text.slice(chipNode.start, chipNode.end)).toBe(id);
    const selection = new Map(
      source.nodes
        .filter((node) => node.type === "text" || node.type === "emphasis")
        .map((node) => [node.id, { start: node.start, end: node.end }]),
    );
    expect(selectedMarkdown(source, selection)).toBe(text);
  }
});

test("a longer token holding the same id text does not take the chip's source range", () => {
  const text = "xwfrun:abc wfrun:abc tail";
  const source = mapped(text);
  const chipNode = source.nodes.find((node) => node.type === "emphasis")!;
  expect(chipNode.start).toBe(text.lastIndexOf("wfrun:abc"));
  const selection = new Map(
    source.nodes
      .filter((node) => node.type === "text" || node.type === "emphasis")
      .map((node) => [node.id, { start: node.start, end: node.end }]),
  );
  expect(selectedMarkdown(source, selection)).toBe(text);
});

test("an id split by an escape in its source stays plain text", () => {
  expect(mapped(`See wfrun\\:${hash}`).nodes.some((node) => node.type === "emphasis")).toBe(false);
});
