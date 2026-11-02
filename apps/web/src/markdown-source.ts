import type { AllowElement, ExtraProps } from "react-markdown";

type Position = { start: { offset?: number }; end: { offset?: number } };
type MarkdownNode = {
  type: string;
  value?: string;
  identifier?: string;
  position?: Position;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string | number | boolean | string[]> };
};
type HtmlParent = NonNullable<Parameters<AllowElement>[2]>;
type HtmlElement = NonNullable<ExtraProps["node"]>;
type SourceNode = {
  id: number;
  type: string;
  start: number;
  end: number;
  children: SourceNode[];
  value?: string;
  identifier?: string;
};
export type MarkdownSource = {
  text: string;
  nodes: SourceNode[];
  positions: Map<string, number>;
  root?: SourceNode;
};

const sources = new WeakMap<Element, MarkdownSource>();

export function createMarkdownSource(text: string): MarkdownSource {
  return { text, nodes: [], positions: new Map() };
}

export function registerMarkdownSource(element: Element, source: MarkdownSource): void {
  sources.set(element, source);
}

export function getMarkdownSource(element: Element): MarkdownSource | undefined {
  const root = element.closest("[data-markdown-source]");
  return root ? sources.get(root) : undefined;
}

export function remarkMarkdownSource(source: MarkdownSource) {
  return (tree: MarkdownNode) => {
    source.nodes = [];
    source.positions.clear();
    const visit = (node: MarkdownNode): SourceNode | undefined => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const entry: SourceNode = {
        id: source.nodes.length,
        type: node.type,
        start,
        end,
        value: node.value,
        identifier: node.identifier,
        children: [],
      };
      source.nodes.push(entry);
      source.positions.set(
        `${start}:${end}:${node.type === "text" ? "text" : "element"}`,
        entry.id,
      );
      if (node.type !== "root" && node.type !== "text") {
        node.data ??= {};
        node.data.hProperties = {
          ...node.data.hProperties,
          "data-source": `${start}:${end}:${entry.id}`,
        };
      }
      for (const child of node.children ?? []) {
        const mapped = visit(child);
        if (mapped) entry.children.push(mapped);
      }
      return entry;
    };
    source.root = visit(tree);
  };
}

export function rehypeMarkdownSource(source: MarkdownSource) {
  return (tree: HtmlParent) => {
    const visit = (parent: HtmlParent) => {
      const children = parent.children.map((node) => {
        if (node.type === "element") {
          visit(node);
          return node;
        }
        if (node.type !== "text") return node;
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const id = source.positions.get(`${start}:${end}:text`);
        if (id === undefined || start === undefined || end === undefined) return node;
        return {
          type: "element",
          tagName: "span",
          properties: {
            "data-source": `${start}:${end}:${id}`,
          },
          children: [node],
        } satisfies HtmlElement;
      });
      parent.children.splice(0, parent.children.length, ...children);
    };
    visit(tree);
  };
}

export function sourceAttributes(node: ExtraProps["node"]) {
  return { "data-source": node?.properties["data-source"] };
}

type SourceSlice = { start: number; end: number; prefix?: string; suffix?: string; text?: string };
export type SourceSelection = Map<number, SourceSlice>;

export function selectedMarkdown(
  source: MarkdownSource,
  selection: SourceSelection,
  unwrapped: ReadonlySet<number> = new Set(),
): string {
  if (!source.root) return "";
  const references = new Set<string>();
  const visit = (node: SourceNode): string | undefined => {
    const selected = selection.get(node.id);
    if (
      node.identifier &&
      !unwrapped.has(node.id) &&
      (selected || node.children.some(containsSelection))
    )
      references.add(node.identifier);
    if (selected)
      return (
        selected.text ??
        (selected.prefix ?? "") +
          source.text.slice(selected.start, selected.end) +
          (selected.suffix ?? "")
      );
    const children = node.children.filter(containsSelection);
    if (!children.length) return;
    const first = node.children[0]!;
    const last = node.children.at(-1)!;
    const pieces = children.map((child) => visit(child) ?? "");
    if (node.type === "table") {
      const originalSeparator = source.text.slice(first.end, node.children[1]?.start ?? node.end);
      const row = children[0]!;
      const columns = row.children.flatMap((cell, index) =>
        containsSelection(cell) ? [index] : [],
      );
      const line = originalSeparator.split(/\r?\n/).find((line) => line.trim()) ?? "";
      const delimiters = line.split("|").filter((cell) => cell.trim());
      const separator =
        columns.length === first.children.length
          ? originalSeparator
          : `\n|${columns.map((column) => delimiters[column] ?? " --- ").join("|")}|\n`;
      let text = pieces[0] + separator;
      for (let index = 1; index < children.length; index++) {
        if (index > 1) text += source.text.slice(children[index - 1]!.end, children[index]!.start);
        text += pieces[index];
      }
      return text;
    }
    let text = "";
    let previous: SourceNode | undefined;
    for (const [index, child] of children.entries()) {
      if (previous) text += source.text.slice(previous.end, child.start);
      text += pieces[index];
      previous = child;
    }
    if (node.type === "root" || node.type === "list") return text;
    if (unwrapped.has(node.id))
      return node.type === "blockquote" ? text.replace(/\n[ \t]{0,3}>[ \t]?/g, "\n") : text;
    if (node.type === "tableRow") {
      const row =
        source.text.slice(node.start, first.start) + text + source.text.slice(last.end, node.end);
      const closed = row.endsWith("|") ? row : row.trimEnd() + " |";
      return `${row.startsWith("|") ? "" : "| "}${closed}`;
    }
    return (
      source.text.slice(node.start, first.start) + text + source.text.slice(last.end, node.end)
    );
  };
  const containsSelection = (node: SourceNode): boolean =>
    selection.has(node.id) || node.children.some(containsSelection);
  const text = visit(source.root) ?? "";
  const definitions = source.nodes
    .filter(
      (node) =>
        (node.type === "definition" || node.type === "footnoteDefinition") &&
        node.identifier &&
        references.has(node.identifier) &&
        !containsSelection(node),
    )
    .map((node) => source.text.slice(node.start, node.end));
  const output = [text, ...definitions].join("\n\n");
  const first = source.root.children.find(containsSelection);
  if (first?.type !== "code") return output.trim();
  const lineStart = source.text.lastIndexOf("\n", first.start - 1) + 1;
  const prefix = source.text.slice(lineStart, first.start);
  const indentation = /^[ \t]{0,3}$/.test(prefix) ? prefix : "";
  return (indentation + output).trimEnd();
}

export function sourceTextSelection(
  source: MarkdownSource,
  id: number,
  rendered: string,
  start: number,
  end: number,
  decodeEntity: (entity: string) => string,
): SourceSlice | undefined {
  const node = source.nodes[id];
  if (!node) return;
  if (node.type !== "text" && node.type !== "inlineCode" && node.type !== "code")
    return { start: node.start, end: node.end };
  const original = source.text.slice(node.start, node.end);
  const inline = node.type === "inlineCode";
  const block = node.type === "code";
  const literal = inline || block;
  const fence = inline ? (/^`+/.exec(original)?.[0] ?? "") : "";
  let bodyStart = fence.length;
  let bodyEnd = original.length - fence.length;
  const body = original.slice(bodyStart, bodyEnd).replace(/\r\n?|\n/g, " ");
  if (inline && body.startsWith(" ") && body.endsWith(" ") && /\S/.test(body)) {
    bodyStart++;
    bodyEnd--;
  }
  const header = block
    ? /^[ \t]*(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(original)?.[0]
    : undefined;
  const footer = header
    ? /(?:\r\n|\r|\n)[ \t>]*(?:`{3,}|~{3,})[ \t]*$/.exec(original)?.[0]
    : undefined;
  if (block) {
    bodyStart = header?.length ?? 0;
    bodyEnd = original.length - (footer?.length ?? 0);
    if (!footer) bodyEnd -= /(?:\r\n|\r|\n)$/.exec(original)?.[0].length ?? 0;
  }
  const raw = original.slice(bodyStart, bodyEnd);
  const normalized = (node.value ?? rendered).replace(/\r\n?/g, "\n");
  const value = inline ? normalized.replaceAll("\n", " ") : normalized;
  const offset = value.indexOf(rendered);
  if (offset < 0) return;
  const starts: number[] = [];
  const ends: number[] = [];
  const lines = normalized.split("\n");
  if (literal && lines.join(inline ? " " : "\n") !== value) return;
  let valueOffset = 0;
  let rawOffset = 0;
  for (const expected of lines) {
    const newline = /\r\n|\r|\n/.exec(raw.slice(rawOffset));
    const lineEnd = newline ? rawOffset + newline.index : raw.length;
    let decoded = "";
    const lineStarts: number[] = [];
    const lineEnds: number[] = [];
    let cursor = rawOffset;
    while (cursor < lineEnd) {
      const tokenStart = cursor;
      const entity =
        !literal &&
        raw[cursor] === "&" &&
        /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/.exec(raw.slice(cursor));
      const escaped =
        !literal &&
        raw[cursor] === "\\" &&
        /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(raw[cursor + 1] ?? "");
      const character = entity ? decodeEntity(entity[0]) : raw[cursor + (escaped ? 1 : 0)]!;
      const characterWidth = escaped ? 2 : 1;
      cursor += entity ? entity[0].length : characterWidth;
      const token = character === "\0" ? "\ufffd" : character;
      for (let i = 0; i < token.length; i++) {
        lineStarts.push(tokenStart);
        lineEnds.push(cursor);
      }
      decoded += token;
    }
    // Container markers belong to the source line but are absent from its parsed text value.
    if (!decoded.endsWith(expected)) return;
    const skip = decoded.length - expected.length;
    for (let i = 0; i < expected.length; i++) {
      starts[valueOffset + i] = lineStarts[skip + i]!;
      ends[valueOffset + i] = lineEnds[skip + i]!;
    }
    valueOffset += expected.length;
    if (!newline) continue;
    starts[valueOffset] = lineEnd;
    rawOffset = lineEnd + newline[0].length;
    ends[valueOffset++] = rawOffset;
  }
  const left = starts[offset + start];
  const right = ends[offset + end - 1];
  if (left === undefined || right === undefined) return;
  const selected = raw.slice(left, right);
  const padding = inline && (selected.startsWith("`") || selected.endsWith("`"));
  if (padding)
    return {
      start: node.start + bodyStart + left,
      end: node.start + bodyStart + right,
      prefix: fence + " ",
      suffix: " " + fence,
    };
  return {
    start: node.start + bodyStart + left,
    end: node.start + bodyStart + right,
    prefix: literal ? original.slice(0, bodyStart) + raw.slice(0, starts[0]) : undefined,
    suffix: literal ? original.slice(bodyEnd) : undefined,
  };
}
