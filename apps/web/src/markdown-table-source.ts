import type { Root as MdRoot, RootContent as MdRootContent } from "mdast";

type Table = Extract<MdRootContent, { type: "table" }>;

export function markdownTableSource(source: string, table: Table): string {
  const rows = table.children.map((row) =>
    source.slice(row.position?.start.offset, row.position?.end.offset),
  );
  const between = source.slice(
    table.children[0]?.position?.end.offset,
    table.children[1]?.position?.start.offset ?? table.position?.end.offset,
  );
  const newline = /\r\n|\n|\r/.exec(between)?.[0] ?? "\n";
  // Row positions exclude enclosing quote/list prefixes; the separator has no AST row.
  const separator = (between.split(newline)[1] ?? "").replace(/^[\s>]*/, "");
  rows.splice(1, 0, separator);
  return rows.join(newline);
}

export function remarkTableSources(tables: Map<string, string>) {
  return (tree: MdRoot, file: { toString(): string }) => {
    const source = file.toString();
    const definitions = new Map<string, string>();
    function collect(node: MdRoot | MdRootContent) {
      if (node.type === "definition" || node.type === "footnoteDefinition")
        definitions.set(
          node.identifier,
          source.slice(node.position?.start.offset, node.position?.end.offset),
        );
      if ("children" in node) node.children.forEach(collect);
    }
    collect(tree);
    function visit(node: MdRoot | MdRootContent) {
      if (node.type !== "table") {
        if ("children" in node) node.children.forEach(visit);
        return;
      }
      const references = new Set<string>();
      function referenced(child: MdRootContent) {
        if ("identifier" in child && definitions.has(child.identifier))
          references.add(child.identifier);
        if ("children" in child) child.children.forEach(referenced);
      }
      referenced(node);
      tables.set(
        `${node.position?.start.offset}:${node.position?.end.offset}`,
        [
          markdownTableSource(source, node),
          ...Array.from(references, (id) => definitions.get(id)!),
        ].join("\n\n"),
      );
    }
    tables.clear();
    visit(tree);
  };
}
