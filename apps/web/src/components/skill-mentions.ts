import { createContext } from "react";
import type { Root as MdRoot, RootContent as MdRootContent } from "mdast";
import type { SkillChoice } from "@stanley2058/lilac-client-protocol";

export const SkillCatalogContext = createContext<readonly SkillChoice[]>([]);

export function skillMentionPattern(names: readonly string[]): RegExp {
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(^|\\s)((?:\\$|/skill:)(${alternatives.join("|")}))(?=$|[^\\p{L}\\p{N}_-])`,
    "gu",
  );
}

const literalNodes = new Set(["code", "inlineCode", "inlineMath", "math", "link", "linkReference"]);

export function remarkSkillMentions(names: readonly string[]) {
  return (tree: MdRoot) => {
    if (!names.length) return;
    const pattern = skillMentionPattern(names);
    function split(value: string, boundary: boolean): MdRootContent[] {
      const parts: MdRootContent[] = [];
      let end = 0;
      for (const match of value.matchAll(pattern)) {
        if (match.index === 0 && !match[1] && !boundary) continue;
        const start = match.index + match[1]!.length;
        if (start > end) parts.push({ type: "text", value: value.slice(end, start) });
        parts.push({
          type: "text",
          value: match[2]!,
          data: { hName: "span", hProperties: { dataSkill: match[3]! } },
        });
        end = start + match[2]!.length;
      }
      if (end < value.length) parts.push({ type: "text", value: value.slice(end) });
      return parts;
    }
    function visit(node: MdRoot | MdRootContent) {
      if (!("children" in node) || literalNodes.has(node.type)) return;
      node.children = node.children.flatMap<MdRootContent>((child, index, siblings) => {
        const previous = siblings[index - 1];
        if (child.type === "text")
          return split(child.value, !previous || previous.type === "break");
        visit(child);
        return [child];
      });
    }
    visit(tree);
  };
}
