import { parseReferenceHref, parseCitationHref } from "@stanley2058/lilac-client-protocol";
import type { RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { ComposerNode } from "./composer-markdown";

type ComposerMarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: ComposerMarkdownNode[];
  url?: string;
  value?: string;
};
const literalSyntax = unified().use(remarkParse).use(remarkGfm);

export function editableComposerLinks(resourceUrls?: ReadonlySet<string>) {
  return (tree: ComposerMarkdownNode, file: { toString(): string }) => {
    const source = file.toString();
    function visit(nodes: ComposerMarkdownNode[]) {
      for (const [index, node] of nodes.entries()) {
        if (node.type === "link") {
          if (
            (node.url && parseReferenceHref(node.url)) ||
            (node.url && parseCitationHref(node.url)) ||
            node.url?.startsWith("attachment:") ||
            (node.url && resourceUrls?.has(node.url))
          )
            continue;
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined)
            nodes[index] = { type: "text", value: source.slice(start, end) };
          continue;
        }
        if (node.children) visit(node.children);
      }
    }
    visit(tree.children ?? []);
  };
}

/**
 * Text that reads as a link, image, table, or definition would be escaped when written as Markdown. Each
 * one is swapped for a marker before writing, and the returned function puts the source back.
 */
export function protectComposerSyntax(value: ComposerNode[]) {
  const source = value.map(composerNodeString).join("\n");
  let marker = "\uE000";
  while (source.includes(marker)) marker += "\uE000";
  const literals: { text: string; table: boolean }[] = [];

  function protect(text: string) {
    if (!/[[<:@|]|www\./.test(text)) return text;
    const tree = literalSyntax.parse(text);
    let end = 0;
    let result = "";
    function visit(nodes: RootContent[]) {
      for (const node of nodes) {
        if (
          node.type === "link" ||
          node.type === "image" ||
          node.type === "table" ||
          node.type === "definition"
        ) {
          const start = node.position?.start.offset;
          const next = node.position?.end.offset;
          if (start === undefined || next === undefined) continue;
          result += text.slice(end, start) + marker + literals.length + marker;
          literals.push({ text: text.slice(start, next), table: node.type === "table" });
          end = next;
          continue;
        }
        if ("children" in node) visit(node.children);
      }
    }
    visit(tree.children);
    return result + text.slice(end);
  }

  function visit(nodes: ComposerNode[]) {
    for (const node of nodes) {
      if ("text" in node) {
        if (node.code) continue;
        node.text = protect(node.text);
        continue;
      }
      if (node.type === "a" || node.type === "code_block") continue;
      visit(node.children);
    }
  }
  visit(value);
  const pattern = new RegExp(`${marker}(\\d+)${marker}`, "g");
  return (markdown: string) =>
    markdown.replace(pattern, (match, index: string, offset: number) => {
      const literal = literals[Number(index)];
      if (!literal) return match;
      if (!literal.table) return literal.text;
      const prefix = markdown.slice(markdown.lastIndexOf("\n", offset - 1) + 1, offset);
      const continuation = prefix.replace(/[^\s>]/g, " ");
      return literal.text.replaceAll("\n", `\n${continuation}`);
    });
}

function composerNodeString(node: ComposerNode): string {
  return "text" in node ? node.text : node.children.map(composerNodeString).join("");
}
