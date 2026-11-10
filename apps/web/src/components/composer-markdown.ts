import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/bidi";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/bidi";
import {
  citationHref,
  citationLabel,
  parseCitationHref,
  parseReferenceHref,
  referenceHref,
  serializeCitation,
} from "@stanley2058/lilac-client-protocol";
import type { Attachment } from "../types";
import { editableComposerLinks, protectComposerSyntax } from "./composer-links";
import { editableComposerTables } from "./composer-tables";
import { composerParagraphSpacing } from "./composer-line-breaks";

/**
 * The composer's Markdown codec. Drafts, resource links, and copied messages keep the syntax they
 * had when the composer stored them through a flat block list, so this keeps that list: blocks with
 * inline leaves, and list items as indented paragraphs.
 */
export type ComposerLeaf = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
};
export type ComposerBlock = {
  type: string;
  children: ComposerNode[];
  indent?: number;
  listStyleType?: string;
  listStart?: number;
  checked?: boolean;
  lang?: string;
  attachmentKey?: string;
  name?: string;
  url?: string;
};
export type ComposerNode = ComposerLeaf | ComposerBlock;

export const PARAGRAPH = "p";
export const BLOCKQUOTE = "blockquote";
export const CODE_BLOCK = "code_block";
export const CODE_LINE = "code_line";
export const RULE = "hr";
const LINK = "a";
export const ATTACHMENT = "composer_attachment";
export const REFERENCE = "composer_reference";
export const CITATION = "composer_citation";
const inlineTypes = new Set([LINK, ATTACHMENT, REFERENCE, CITATION]);
const markKeys = ["italic", "bold", "strikethrough", "code"] as const;
type MarkKey = (typeof markKeys)[number];
type Decoration = Partial<Record<MarkKey, true>>;

export function isLeaf(node: ComposerNode): node is ComposerLeaf {
  return "text" in node;
}

/** The text of a node and its descendants, with no separator between blocks. */
export function nodeString(node: ComposerNode): string {
  return isLeaf(node) ? node.text : node.children.map(nodeString).join("");
}

const composerSyntax = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  editableComposerTables,
];

/** Definitions the composer cannot edit stay as source lines, spaced like other paragraphs. */
function sourceDefinitions() {
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    function visit(node: Root | RootContent) {
      if (!("children" in node)) return;
      node.children = node.children.map((child) => {
        if (child.type !== "definition" && child.type !== "footnoteDefinition") {
          visit(child);
          return child;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        return {
          type: "paragraph",
          position: child.position,
          children: [{ type: "text", value: source.slice(start, end) }],
        };
      }) as never;
    }
    visit(tree);
  };
}

function parseTree(text: string, resourceUrls?: ReadonlySet<string>): Root {
  const processor = unified()
    .use(remarkParse)
    .use(composerSyntax)
    .use(() => editableComposerLinks(resourceUrls))
    .use(sourceDefinitions)
    .use(composerParagraphSpacing);
  return processor.runSync(processor.parse(text), text) as Root;
}

type ReadOptions = {
  source: string;
  image?: (node: Extract<Nodes, { type: "image" }>) => ComposerNode;
};

/** Markdown the composer cannot edit stays as its source text. */
function sourceText(node: Nodes, options: ReadOptions): ComposerLeaf {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return { text: start === undefined || end === undefined ? "" : options.source.slice(start, end) };
}

function readInline(nodes: readonly Nodes[], decoration: Decoration, options: ReadOptions) {
  if (!nodes.length) return [{ text: "" }];
  return nodes.flatMap((node) => readNode(node, decoration, options));
}

function readMarked(
  nodes: readonly Nodes[],
  decoration: Decoration,
  mark: MarkKey,
  options: ReadOptions,
): ComposerNode[] {
  return nodes.flatMap((node) => readNode(node, { ...decoration, [mark]: true }, options));
}

/** Inline runs in a quote become paragraphs around the quote's block children. */
function groupInline(children: ComposerNode[]): ComposerBlock[] {
  const blocks: ComposerBlock[] = [];
  let inline: ComposerNode[] = [];
  const flush = () => {
    if (!inline.length) return;
    blocks.push({ type: PARAGRAPH, children: inline });
    inline = [];
  };
  for (const child of children) {
    if (!isLeaf(child) && !inlineTypes.has(child.type)) {
      flush();
      blocks.push(child);
      continue;
    }
    inline.push(child);
  }
  flush();
  return blocks.length ? blocks : [{ type: PARAGRAPH, children: [{ text: "" }] }];
}

function readParagraph(node: Paragraph, decoration: Decoration, options: ReadOptions) {
  const children = readInline(node.children, decoration, options);
  // A trailing line break ends the paragraph rather than adding an empty line.
  const kept = children.filter(
    (child, index) =>
      !(
        isLeaf(child) &&
        child.text === "\n" &&
        children.length > 1 &&
        index === children.length - 1
      ),
  );
  return { type: PARAGRAPH, children: kept };
}

function readList(list: List, options: ReadOptions, indent = 1, start = list.start ?? 1) {
  const items: ComposerBlock[] = [];
  let listStyleType = list.ordered ? "decimal" : "disc";
  for (const [index, item] of list.children.entries()) {
    const todo = typeof item.checked === "boolean";
    if (todo) listStyleType = "todo";
    const [first, ...rest] = item.children;
    const read = first
      ? readNode(first, {}, options)
      : [{ type: PARAGRAPH, children: [{ text: "" }] }];
    for (const node of read) {
      if (isLeaf(node)) continue;
      items.push({
        ...node,
        indent,
        type: PARAGRAPH,
        listStyleType,
        ...(todo ? { checked: item.checked! } : {}),
        ...(list.ordered ? { listStart: start + index } : {}),
      });
    }
    for (const child of rest) {
      if (child.type === "list") {
        items.push(...readList(child, options, indent + 1, child.start ?? 1));
        continue;
      }
      for (const node of readNode(child, {}, options))
        if (!isLeaf(node)) items.push({ ...node, indent: indent + 1 });
    }
  }
  return items;
}

function readNode(node: Nodes, decoration: Decoration, options: ReadOptions): ComposerNode[] {
  switch (node.type) {
    case "text":
      return [{ ...decoration, text: node.value }];
    case "emphasis":
      return readMarked(node.children, decoration, "italic", options);
    case "strong":
      return readMarked(node.children, decoration, "bold", options);
    case "delete":
      return readMarked(node.children, decoration, "strikethrough", options);
    case "inlineCode":
      return [{ ...decoration, code: true, text: node.value }];
    case "break":
      return [{ text: "\n" }];
    case "html":
      return [{ text: /^<br\s*\/?>$/i.test(node.value) ? "\n" : node.value }];
    case "link":
      return [
        { type: LINK, url: node.url, children: readInline(node.children, decoration, options) },
      ];
    case "image":
      return [options.image?.(node) ?? sourceText(node, options)];
    case "paragraph":
      return [readParagraph(node, decoration, options)];
    case "heading":
      return [{ type: `h${node.depth}`, children: readInline(node.children, decoration, options) }];
    case "blockquote":
      return [
        {
          type: BLOCKQUOTE,
          children: groupInline(
            node.children.flatMap((child) => readNode(child, decoration, options)),
          ),
        },
      ];
    case "code":
      return [
        {
          type: CODE_BLOCK,
          ...(node.lang ? { lang: node.lang } : {}),
          children: (node.value || "")
            .split("\n")
            .map((line) => ({ type: CODE_LINE, children: [{ text: line }] })),
        },
      ];
    case "thematicBreak":
      return [{ type: RULE, children: [{ text: "" }] }];
    case "list":
      return readList(node, options);
    case "linkReference":
    case "imageReference":
    case "footnoteReference":
      return [sourceText(node, options)];
    default:
      return "children" in node
        ? node.children.flatMap((child) => readNode(child, decoration, options))
        : [sourceText(node, options)];
  }
}

function mapBlocks(
  nodes: ComposerNode[],
  map: (node: ComposerBlock) => ComposerNode,
): ComposerNode[] {
  return nodes.map((node) => {
    if (isLeaf(node)) return { ...node };
    return map({ ...node, children: mapBlocks(node.children, map) });
  });
}

function mapValue(value: ComposerBlock[], map: (node: ComposerBlock) => ComposerNode) {
  return value.map((block) => ({ ...block, children: mapBlocks(block.children, map) }));
}

function lastLeaf(node: ComposerNode): ComposerLeaf | undefined {
  if (isLeaf(node)) return node;
  const last = node.children.at(-1);
  return last ? lastLeaf(last) : undefined;
}

/** Links that point at chips become chips; the rest of the draft keeps its syntax as text. */
function chipLinks(node: ComposerBlock): ComposerNode {
  if (node.type !== LINK) return node;
  const url = node.url ?? "";
  const citation = parseCitationHref(url);
  if (citation) return { type: CITATION, url: citationHref(citation), children: [{ text: "" }] };
  const target = parseReferenceHref(url);
  if (target) return { type: REFERENCE, url: referenceHref(target), children: [{ text: "" }] };
  if (!url.startsWith("attachment:")) return node;
  return {
    type: ATTACHMENT,
    attachmentKey: url.slice("attachment:".length),
    name: nodeString(node),
    children: [{ text: "" }],
  };
}

function readValue(text: string, options: ReadOptions & { resourceUrls?: ReadonlySet<string> }) {
  const tree = parseTree(text, options.resourceUrls);
  const children = tree.children.map<RootContent>((child) =>
    child.type === "html" && child.value === "<br />"
      ? { type: "paragraph", children: [{ type: "text", value: "\n" }] }
      : child,
  );
  return children
    .flatMap((child) => readNode(child, {}, options))
    .map((node): ComposerBlock => (isLeaf(node) ? { type: PARAGRAPH, children: [node] } : node));
}

/** Reads a stored draft into composer blocks. */
export function readComposerBlocks(text: string): ComposerBlock[] {
  const value = readValue(text, { source: text });
  // Markdown drops spaces at the end of a draft, but a command keeps its separator.
  const trailing = /[ \t]+$/.exec(text)?.[0];
  const block = value.at(-1);
  if (trailing && block) {
    const child = block.children.at(-1);
    if (child && !isLeaf(child) && inlineTypes.has(child.type))
      block.children.push({ text: trailing });
    else {
      const last = lastLeaf(block);
      if (last) last.text += trailing;
    }
  }
  return mapValue(value, chipLinks) as ComposerBlock[];
}

type MdastNode = RootContent | PhrasingContent;
type Leaf = ComposerLeaf & { type?: undefined };

function hasContent(node: MdastNode): boolean {
  if (node.type === "inlineCode" || node.type === "text") return node.value !== "";
  if (!("children" in node)) return false;
  for (const child of node.children as MdastNode[]) {
    if (
      child.type !== "emphasis" &&
      child.type !== "strong" &&
      child.type !== "inlineCode" &&
      child.type !== "delete" &&
      child.type !== "text"
    )
      return true;
    if (hasContent(child)) return true;
  }
  return false;
}

function mergeTexts(nodes: MdastNode[]): MdastNode[] {
  const merged: MdastNode[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (last && last.type === node.type) {
      if ((last.type === "text" || last.type === "inlineCode") && "value" in node) {
        last.value += node.value;
        continue;
      }
      if ("children" in last && "children" in node) {
        last.children = mergeTexts([...last.children, ...node.children] as MdastNode[]) as never;
        continue;
      }
    }
    if (node.type === "text" && node.value === "") continue;
    merged.push(node);
  }
  return merged;
}

/**
 * Turns a run of marked leaves into nested emphasis. A mark that wraps one leaf moves that leaf's
 * outer spaces outside the mark, because Markdown cannot open emphasis next to a space.
 */
function writeLeaves(leaves: readonly Leaf[]): MdastNode[] {
  const nodes: MdastNode[] = [];
  const starts: MarkKey[] = [];
  let ends: MarkKey[] = [];
  let pending = "";
  for (const [index, leaf] of leaves.entries()) {
    pending += leaf.text;
    const previousStarts = starts.slice();
    const previousEnds = ends.slice();
    const previous = leaves[index - 1];
    const next = leaves[index + 1];
    ends = [];
    for (const key of markKeys) {
      if (!leaf[key]) continue;
      if (!previous?.[key]) starts.push(key);
      if (!next?.[key]) ends.push(key);
    }
    const closing = starts.flatMap((key, position) => (ends.includes(key) ? [position] : []));
    if (starts.length) {
      let before = "";
      let after = "";
      if (
        closing.length === 1 &&
        (previousStarts.toString() !== starts.toString() ||
          (previousEnds.includes("italic") && ends.includes("bold"))) &&
        starts.length === closing.length
      ) {
        while (pending.startsWith(" ")) {
          before += " ";
          pending = pending.slice(1);
        }
        while (pending.endsWith(" ")) {
          after += " ";
          pending = pending.slice(0, -1);
        }
      }
      let result: MdastNode = { type: "text", value: pending };
      pending = "";
      for (const key of starts.toReversed()) result = wrapMark(key, result);
      if (before) nodes.push({ type: "text", value: before });
      nodes.push(result);
      if (after) nodes.push({ type: "text", value: after });
    }
    if (closing.length) {
      for (const position of closing.toReversed()) starts.splice(position, 1);
      continue;
    }
    nodes.push({ type: "text", value: pending });
    pending = "";
  }
  if (pending) nodes.push({ type: "text", value: pending });
  return mergeTexts(nodes).map((node) => (hasContent(node) ? node : { type: "text", value: "" }));
}

function wrapMark(key: MarkKey, node: MdastNode): MdastNode {
  switch (key) {
    case "bold":
      return { type: "strong", children: [node as PhrasingContent] };
    case "italic":
      return { type: "emphasis", children: [node as PhrasingContent] };
    case "strikethrough":
      return { type: "delete", children: [node as PhrasingContent] };
    case "code": {
      let current = node;
      while (current.type !== "text" && current.type !== "inlineCode" && "children" in current)
        current = current.children[0] as MdastNode;
      (current as { type: string }).type = "inlineCode";
      return node;
    }
  }
}

function isListBlock(node: ComposerNode | undefined): node is ComposerBlock {
  return !!node && !isLeaf(node) && node.type === PARAGRAPH && "listStyleType" in node;
}

function writeNodes(nodes: readonly ComposerNode[]): MdastNode[] {
  const result: MdastNode[] = [];
  let leaves: Leaf[] = [];
  const list: ComposerBlock[] = [];
  for (let index = 0; index <= nodes.length; index++) {
    const node = nodes[index];
    if (node && isLeaf(node)) {
      leaves.push(node);
      continue;
    }
    if (leaves.length) result.push(...writeLeaves(leaves));
    leaves = [];
    if (!node) continue;
    if (!isListBlock(node)) {
      const written = writeBlock(node);
      if (written) result.push(written);
      continue;
    }
    list.push(node);
    const next = nodes[index + 1];
    const nextInList = isListBlock(next);
    const restyled =
      nextInList &&
      next.listStyleType !== list[0]!.listStyleType &&
      next.indent === list[0]!.indent;
    if (nextInList && !restyled) continue;
    result.push(writeList(list));
    list.length = 0;
  }
  return result;
}

function newList(node: ComposerBlock): List {
  return {
    type: "list",
    ordered: node.listStyleType === "decimal",
    spread: false,
    start: node.listStart,
    children: [],
  };
}

/** Rebuilds nested lists from indented list paragraphs. */
function writeList(nodes: readonly ComposerBlock[]): List {
  const root = newList(nodes[0]!);
  type Level = { indent?: number; list: List; parent: ListItem | null; style?: string };
  const stack: Level[] = [
    { indent: nodes[0]!.indent, list: root, parent: null, style: nodes[0]!.listStyleType },
  ];
  for (const [index, node] of nodes.entries()) {
    const indent = node.indent ?? 0;
    while (stack.length > 1 && (stack.at(-1)!.indent ?? 0) > indent) stack.pop();
    let top = stack.at(-1)!;
    if (top.indent === node.indent && top.style !== node.listStyleType && top.parent) {
      const sibling = newList(node);
      top.parent.children.push(sibling);
      top = { indent: node.indent, list: sibling, parent: top.parent, style: node.listStyleType };
      stack[stack.length - 1] = top;
    }
    const item: ListItem = {
      type: "listItem",
      checked: node.listStyleType === "todo" && node.checked !== undefined ? node.checked : null,
      spread: false,
      children: [{ type: "paragraph", children: writeNodes(node.children) as PhrasingContent[] }],
    };
    top.list.children.push(item);
    const next = nodes[index + 1];
    if (next && (next.indent ?? 0) > indent) {
      const nested = newList(next);
      item.children.push(nested);
      stack.push({ indent: next.indent, list: nested, parent: item, style: next.listStyleType });
    }
  }
  return root;
}

/** A line break inside a paragraph is a Markdown break; one at the end must stay visible. */
function writeParagraph(node: ComposerBlock): Paragraph {
  const children = node.children.flatMap<ComposerNode | { type: "break" }>((child) => {
    if (!isLeaf(child) || !child.text.includes("\n")) return [child];
    return child.text
      .split("\n")
      .flatMap((part, index, parts) => [
        ...(part ? [{ ...child, text: part }] : []),
        ...(index < parts.length - 1 ? [{ type: "break" as const }] : []),
      ]);
  });
  const nodes = writeMixed(children);
  const last = children.at(-1);
  if (nodes.length && last && "type" in last && last.type === "break")
    nodes[nodes.length - 1] = { type: "html", value: "\n<br />" };
  return { type: "paragraph", children: nodes as PhrasingContent[] };
}

/** Paragraph children with breaks: leaves group into marked runs, breaks stand alone. */
function writeMixed(children: readonly (ComposerNode | { type: "break" })[]): MdastNode[] {
  const nodes: MdastNode[] = [];
  let run: ComposerNode[] = [];
  for (const child of children) {
    if ("type" in child && child.type === "break") {
      nodes.push(...writeNodes(run), { type: "break" });
      run = [];
      continue;
    }
    run.push(child as ComposerNode);
  }
  nodes.push(...writeNodes(run));
  return nodes;
}

function writeBlock(node: ComposerBlock): MdastNode | undefined {
  if (node.type === PARAGRAPH) return writeParagraph(node);
  if (/^h[1-6]$/.test(node.type))
    return {
      type: "heading",
      depth: Number(node.type.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
      children: writeNodes(node.children) as PhrasingContent[],
    };
  if (node.type === BLOCKQUOTE)
    return {
      type: "blockquote",
      children: writeNodes(groupInline(node.children)) as (BlockContent | DefinitionContent)[],
    };
  if (node.type === CODE_BLOCK)
    return {
      type: "code",
      lang: node.lang,
      value: node.children.map(nodeString).join("\n"),
    };
  if (node.type === RULE) return { type: "thematicBreak" };
  if (node.type === LINK)
    return {
      type: "link",
      url: node.url ?? "",
      children: writeNodes(node.children) as PhrasingContent[],
    };
  return undefined;
}

function trimEmptyInlineText(nodes: ComposerNode[]): ComposerNode[] {
  const visible = nodes.some((node) => nodeString(node).length > 0);
  return nodes.flatMap<ComposerNode>((node) => {
    if (isLeaf(node)) return visible && node.text === "" ? [] : [node];
    return [{ ...node, children: trimEmptyInlineText(node.children) }];
  });
}

const stringify = unified()
  .use([remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough])
  .use(remarkStringify, {
    emphasis: "_",
    resourceLink: false,
    handlers: { break: () => "\n" },
    // Composer paragraphs are adjacent lines; an empty block supplies the blank line.
    join: [
      (left, right, parent) =>
        parent.type === "root" && left.type === "paragraph" && right.type === "paragraph"
          ? 0
          : undefined,
    ],
  });

function attachmentLink(node: ComposerBlock, references: boolean): ComposerNode {
  const name = node.name ?? "File";
  if (!references) return { text: name };
  return { type: LINK, url: `attachment:${node.attachmentKey ?? ""}`, children: [{ text: name }] };
}

/** Writes composer blocks as draft Markdown, or with `references: false` as the sent message. */
export function writeComposerBlocks(blocks: readonly ComposerBlock[], references = true): string {
  const value = mapValue(blocks as ComposerBlock[], (node) => {
    if (node.type === CITATION) {
      const citation = parseCitationHref(node.url ?? "");
      return { text: citation ? serializeCitation(citation) : "Assistant quote" };
    }
    if (node.type === REFERENCE) {
      const target = parseReferenceHref(node.url ?? "");
      if (target)
        return {
          type: LINK,
          url: referenceHref(target),
          children: [
            {
              text: `#${target.surface}:${target.sessionId}${target.messageId ? `/${target.messageId}` : ""}`,
            },
          ],
        };
    }
    if (node.type !== ATTACHMENT) return node;
    return attachmentLink(node, references);
  }) as ComposerBlock[];
  if (!value.some((node) => nodeString(node))) return "";
  for (const block of value) block.children = trimEmptyInlineText(block.children);
  const restoreSyntax = protectComposerSyntax(value);
  const last = value.at(-1);
  const endsWithEmptyParagraph =
    last?.type === PARAGRAPH && !last.listStyleType && !nodeString(last);
  const root: Root = { type: "root", children: writeNodes(value) as RootContent[] };
  return restoreSyntax(stringify.stringify(root))
    .replace(/\n$/, endsWithEmptyParagraph ? "\n" : "")
    .replace(/(?:&#x20;)+(?=\n|$)/g, (spaces) => " ".repeat(spaces.length / 6));
}

/** The Markdown a send delivers for a stored draft. */
export function composerSubmission(text: string): string {
  return writeComposerBlocks(readComposerBlocks(text), false);
}

/** What the person sees in the composer, with chips shown by their labels. */
export function composerBlocksText(blocks: readonly ComposerBlock[]): string {
  return mapValue(blocks as ComposerBlock[], (node) => {
    if (node.type === CITATION) {
      const citation = parseCitationHref(node.url ?? "");
      return { text: citation ? citationLabel(citation) : "Assistant quote" };
    }
    if (node.type === ATTACHMENT) return { text: node.name ?? "File" };
    if (node.type === REFERENCE) return { text: node.url ?? "" };
    return node;
  })
    .map(nodeString)
    .join("\n\n");
}

/** Points file chips at their uploaded resources for sending; unknown files keep only their name. */
export function resolveComposerAttachments(
  text: string,
  resourceIds: ReadonlyMap<string, string>,
): string {
  const value = mapValue(readComposerBlocks(text), (node) => {
    if (node.type !== ATTACHMENT) return node;
    const id = node.attachmentKey ? resourceIds.get(node.attachmentKey) : undefined;
    if (!id) return { text: node.name ?? "File" };
    return {
      type: LINK,
      url: `/api/resources/${encodeURIComponent(id)}`,
      children: [{ text: node.name ?? "File" }],
    };
  }) as ComposerBlock[];
  return writeComposerBlocks(value);
}

/** Renames file chips when a local draft's uploads move to a server conversation. */
export function remapComposerAttachments(text: string, keys: ReadonlyMap<string, string>): string {
  const value = mapValue(readComposerBlocks(text), (node) => {
    if (node.type !== ATTACHMENT || !node.attachmentKey) return node;
    const key = keys.get(node.attachmentKey);
    return key ? { ...node, attachmentKey: key } : node;
  }) as ComposerBlock[];
  return writeComposerBlocks(value);
}

/** Separates an appended file chip from text before it, then leaves a space after it. */
function appendAttachment(value: ComposerBlock[], attachment: Pick<Attachment, "key" | "file">) {
  let block = value.at(-1);
  if (!block) {
    block = { type: PARAGRAPH, children: [{ text: "" }] };
    value.push(block);
  }
  const chip: ComposerBlock = {
    type: ATTACHMENT,
    attachmentKey: attachment.key,
    name: attachment.file.name,
    children: [{ text: "" }],
  };
  const last = block.children.at(-1);
  if (last && isLeaf(last) && /\S$/.test(last.text)) last.text += " ";
  block.children.push(chip, { text: " " });
}

/** Turns resource links and images in a copied message back into file chips. */
export function restoreMessageAttachments(
  text: string,
  attachments: ReadonlyMap<string, Attachment>,
): string {
  const byUrl = new Map(
    [...attachments].map(([id, attachment]) => [
      `/api/resources/${encodeURIComponent(id)}`,
      attachment,
    ]),
  );
  const options: ReadOptions & { resourceUrls?: ReadonlySet<string> } = {
    source: text,
    resourceUrls: new Set(byUrl.keys()),
    image: (node) => {
      const attachment = byUrl.get(node.url);
      if (!attachment) return sourceText(node, options);
      return { type: LINK, url: node.url, children: [{ text: attachment.file.name }] };
    },
  };
  const used = new Set<string>();
  const value = mapValue(readValue(text, options), (node) => {
    const attachment = byUrl.get(node.url ?? "");
    if (node.type !== LINK || !attachment) return node;
    used.add(attachment.key);
    return {
      type: ATTACHMENT,
      attachmentKey: attachment.key,
      name: attachment.file.name,
      children: [{ text: "" }],
    };
  }) as ComposerBlock[];
  for (const attachment of attachments.values())
    if (!used.has(attachment.key)) appendAttachment(value, attachment);
  return writeComposerBlocks(value);
}
