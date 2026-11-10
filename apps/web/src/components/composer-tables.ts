import type { Root as MdRoot, RootContent as MdRootContent } from "mdast";
import { markdownTableSource } from "../markdown-table-source";

export function editableComposerTables() {
  return (tree: MdRoot, file: { toString(): string }) => {
    const source = file.toString();
    const references = new Set<string>();
    function collect(node: MdRoot | MdRootContent, inTable = false) {
      const table = inTable || node.type === "table";
      if (table && "identifier" in node) references.add(node.identifier);
      if ("children" in node) node.children.forEach((child) => collect(child, table));
    }
    collect(tree);
    function visit(node: MdRoot | MdRootContent) {
      if (!("children" in node)) return;
      node.children = node.children.map((child) => {
        if (child.type === "definition" && references.has(child.identifier))
          return {
            type: "paragraph",
            position: child.position,
            children: [
              {
                type: "text",
                value: source.slice(child.position?.start.offset, child.position?.end.offset),
              },
            ],
          };
        if (child.type !== "table") {
          visit(child);
          return child;
        }
        return {
          type: "paragraph",
          position: child.position,
          children: [{ type: "text", value: markdownTableSource(source, child) }],
        };
      });
    }
    visit(tree);
  };
}
