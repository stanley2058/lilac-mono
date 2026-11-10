import type { Root as MdRoot, RootContent as MdRootContent } from "mdast";

export function composerParagraphSpacing() {
  return (tree: { children?: MdRootContent[]; position?: MdRoot["position"] }) => {
    if (!tree.children) return;
    const children: MdRootContent[] = [];
    const first = tree.children[0];
    if (first?.type === "paragraph") {
      for (
        let line = tree.position?.start.line ?? 1;
        line < (first.position?.start.line ?? 1);
        line++
      )
        children.push({ type: "paragraph", children: [] });
    }
    for (const node of tree.children) {
      const previous = children.at(-1);
      if (previous?.type === "paragraph" && node.type === "paragraph") {
        const end = previous.position?.end.line;
        const start = node.position?.start.line;
        if (end !== undefined && start !== undefined) {
          for (let line = end + 1; line < start; line++)
            children.push({ type: "paragraph", children: [] });
        }
      }
      children.push(node);
    }
    const last = tree.children.at(-1);
    if (last?.type === "paragraph" && last.position && tree.position) {
      for (let line = last.position.end.line; line < tree.position.end.line; line++)
        children.push({ type: "paragraph", children: [] });
    }
    tree.children = children;
  };
}

export function userMessageLineBreaks() {
  return (tree: MdRoot) => {
    for (const [index, node] of tree.children.entries()) {
      const previous = tree.children[index - 1];
      if (previous?.type !== "paragraph" || node.type !== "paragraph") continue;
      if (!previous.position || !node.position) continue;
      for (let line = previous.position.end.line + 2; line < node.position.start.line; line++)
        node.children.unshift({ type: "break" });
    }
    function visit(node: MdRoot | MdRootContent) {
      if (!("children" in node)) return;
      node.children = node.children.flatMap<MdRootContent>((child) => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        return child.value
          .split("\n")
          .flatMap<MdRootContent>((value, index) =>
            index ? [{ type: "break" }, { type: "text", value }] : [{ type: "text", value }],
          );
      });
    }
    visit(tree);
  };
}
