import type { Root as MdRoot, RootContent as MdRootContent } from "mdast";

// Generated ids are hex. Excluding underscores also keeps Markdown from escaping an id when saved.
const WORKFLOW_RUN_ID = String.raw`wfrun:[A-Za-z0-9-]{1,122}`;
// Boundaries reject longer tokens, including subagent runs (wfrun:subagent:...), which have no card.
const workflowRunIds = () => new RegExp(String.raw`(?<![\w:-])${WORKFLOW_RUN_ID}(?![\w:-])`, "g");
const wholeWorkflowRunId = new RegExp(`^${WORKFLOW_RUN_ID}$`);

export function isWorkflowRunId(text: string) {
  return wholeWorkflowRunId.test(text);
}

/** Splits text into plain strings and workflow run ids, in order. */
export function splitWorkflowRunIds(text: string): { text: string; runId: boolean }[] {
  const parts: { text: string; runId: boolean }[] = [];
  let end = 0;
  for (const match of text.matchAll(workflowRunIds())) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), runId: false });
    parts.push({ text: match[0], runId: true });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), runId: false });
  return parts;
}

const literalNodes = new Set(["code", "inlineCode", "inlineMath", "math", "link", "linkReference"]);

type TextNode = Extract<MdRootContent, { type: "text" }>;

type SourcePoint = { line: number; column: number; offset: number };

/** Selection copy reads only the offsets, so line and column stay approximate. */
function sourcePoint(start: SourcePoint, offset: number): SourcePoint {
  return { line: start.line, column: start.column + offset, offset: start.offset + offset };
}

function sourceRanges(node: TextNode, parts: { text: string; runId: boolean }[], source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  // Escapes and entities make decoded text differ from its source, so ids are matched in the source.
  // A mismatch means an id is escaped there, and no range can be trusted.
  const raw = source.slice(start, end);
  const matches = [...raw.matchAll(workflowRunIds())];
  const ids = parts.filter((part) => part.runId);
  if (matches.length !== ids.length || ids.some((id, index) => id.text !== matches[index]![0]))
    return;
  let next = 0;
  let cursor = 0;
  return parts.map((part) => {
    if (part.runId) {
      const from = matches[next++]!.index;
      cursor = from + part.text.length;
      return { from, to: cursor };
    }
    const from = cursor;
    cursor = matches[next]?.index ?? raw.length;
    return { from, to: cursor };
  });
}

function splitTextNode(node: TextNode, source: string): MdRootContent[] {
  const parts = splitWorkflowRunIds(node.value);
  if (!parts.some((part) => part.runId)) return [node];
  const start = node.position?.start;
  const ranges = start ? sourceRanges(node, parts, source) : undefined;
  if (start && !ranges) return [node];
  return parts.map((part, index): MdRootContent => {
    const range = ranges?.[index];
    const located = start &&
      start.offset !== undefined &&
      range && {
        position: {
          start: sourcePoint({ ...start, offset: start.offset }, range.from),
          end: sourcePoint({ ...start, offset: start.offset }, range.to),
        },
      };
    if (!part.runId) return { type: "text", value: part.text, ...located };
    // A childless element, not text, so selection copy treats the chip as one source range.
    return {
      type: "emphasis",
      children: [],
      ...located,
      data: { hName: "span", hProperties: { dataWorkflowRun: part.text } },
    };
  });
}

export function remarkWorkflowRunIds() {
  return (tree: MdRoot, file: { toString(): string }) => {
    const source = file.toString();
    function visit(node: MdRoot | MdRootContent) {
      if (!("children" in node) || literalNodes.has(node.type)) return;
      node.children = node.children.flatMap<MdRootContent>((child) => {
        if (child.type === "text") return splitTextNode(child, source);
        visit(child);
        return [child];
      });
    }
    visit(tree);
  };
}
