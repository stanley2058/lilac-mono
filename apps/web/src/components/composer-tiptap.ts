import { Extension, Node, getSchema, type Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Slice, type Node as DocumentNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { parseReferenceHref, referenceHref } from "@stanley2058/lilac-client-protocol";
import { KEYS, NodeApi } from "platejs";
import {
  createComposerEditor,
  composerMarkdown,
  composerSubmissionMarkdown,
  composerPlainText,
} from "./composer-document";
import type { Attachment } from "../types";
import { skillMentionPattern } from "./skill-mentions";

export const attachmentNode = Node.create({
  name: "composer_attachment",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ attachmentKey: { default: "" }, name: { default: "File" } }),
  parseHTML: () => [{ tag: "span[data-composer-attachment]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-composer-attachment": "", contenteditable: "false" },
    HTMLAttributes.name,
  ],
});
export const referenceNode = Node.create({
  name: "composer_reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ url: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-composer-reference]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-composer-reference": "", contenteditable: "false" },
    HTMLAttributes.url,
  ],
});
export const skillNode = Node.create({
  name: "composer_skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ id: { default: "" }, name: { default: "" }, text: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-composer-skill]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-composer-skill": "", contenteditable: "false" },
    HTMLAttributes.text,
  ],
});

export function insertEditorReference(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  origin: string,
): boolean {
  const target = parseReferenceHref(text.trim(), origin);
  if (!target) return false;
  const node = view.state.schema.nodes.composer_reference!.create({ url: referenceHref(target) });
  const transaction = view.state.tr;
  if (transaction.selection.from !== from || transaction.selection.to !== to)
    transaction.setSelection(TextSelection.create(transaction.doc, from, to));
  view.dispatch(transaction.replaceSelectionWith(node).scrollIntoView());
  return true;
}

export function composerBadgeSelection(
  view: EditorView,
  anchor: ResolvedPos,
): TextSelection | null {
  // Native edits can request a selection in a document the view has not applied yet.
  if (anchor.doc !== view.state.doc) return null;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.isCollapsed || !selection.focusNode) return null;
  const focus = selection.focusNode;
  const element = focus.nodeType === 1 ? (focus as Element) : focus.parentElement;
  const badge = element?.closest("[data-composer-badge]");
  if (!badge || !view.dom.contains(badge)) return null;
  const from = view.posAtDOM(badge, 0);
  const node = view.state.doc.nodeAt(from);
  if (!node?.isAtom) return null;
  const to = from + node.nodeSize;
  // Android drops its IME connection at non-editable spans. Keep the DOM editable,
  // then move native caret positions inside a badge across the atomic model node.
  return TextSelection.create(view.state.doc, view.state.selection.head >= to ? from : to);
}

const indentation = Extension.create({
  name: "composerIndentation",
  addGlobalAttributes: () => [
    {
      types: ["bulletList"],
      attributes: { composerListStyle: { default: "disc" } },
    },
    {
      types: ["listItem"],
      attributes: { checked: { default: null } },
    },
    {
      types: ["paragraph", "heading", "blockquote", "codeBlock"],
      attributes: {
        indent: {
          default: 0,
          renderHTML: (attributes) =>
            attributes.indent ? { style: `margin-left: ${attributes.indent * 24}px` } : {},
        },
      },
    },
  ],
  addKeyboardShortcuts() {
    const indent = (delta: number) => {
      if (this.editor.isActive("listItem"))
        return delta > 0
          ? this.editor.commands.sinkListItem("listItem")
          : this.editor.commands.liftListItem("listItem");
      const { $from } = this.editor.state.selection;
      return this.editor.commands.updateAttributes($from.parent.type.name, {
        indent: Math.max(0, Number($from.parent.attrs.indent) + delta),
      });
    };
    return {
      Tab: () => indent(1),
      "Shift-Tab": () => indent(-1),
      "Shift-Enter": () =>
        this.editor.commands.first(({ commands }) => [
          () => commands.newlineInCode(),
          () => commands.splitListItem("listItem"),
          () => commands.splitBlock(),
        ]),
    };
  },
});

const horizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: () => ["hr"],
});

export const composerExtensions = [
  StarterKit.configure({
    link: false,
    underline: false,
    horizontalRule: false,
    trailingNode: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
  }),
  indentation,
  horizontalRule,
];
export const composerSchema = getSchema([
  ...composerExtensions,
  attachmentNode,
  referenceNode,
  skillNode,
]);
export { Placeholder };

type ComposerLeaf = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
};
type ComposerBlock = {
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
type ComposerNode = ComposerLeaf | ComposerBlock;
const markKeys = ["bold", "italic", "strikethrough", "code"] as const;
const marks = { bold: "bold", italic: "italic", strikethrough: "strike", code: "code" };
function inline(nodes: ComposerNode[]): JSONContent[] {
  return nodes.flatMap<JSONContent>((node) => {
    if ("text" in node) {
      const nodeMarks = markKeys.filter((key) => node[key]).map((key) => ({ type: marks[key] }));
      return node.text
        .split("\n")
        .flatMap<JSONContent>((text, index) => [
          ...(index ? [{ type: "hardBreak" }] : []),
          ...(text ? [{ type: "text", text, marks: nodeMarks }] : []),
        ]);
    }
    if (node.type === "composer_attachment")
      return [{ type: node.type, attrs: { attachmentKey: node.attachmentKey, name: node.name } }];
    if (node.type === "composer_reference") return [{ type: node.type, attrs: { url: node.url } }];
    return inline(node.children);
  });
}
function block(node: ComposerBlock): JSONContent {
  const attrs = {
    indent: typeof node.indent === "number" && !node.listStyleType ? node.indent : 0,
  };
  if (node.type === KEYS.codeBlock) {
    const text = node.children.map((child) => NodeApi.string(child)).join("\n");
    return {
      type: "codeBlock",
      attrs: { ...attrs, language: node.lang ?? null },
      content: text ? [{ type: "text", text }] : [],
    };
  }
  if (node.type === KEYS.blockquote) {
    const children = node.children.filter((child): child is ComposerBlock => !("text" in child));
    return {
      type: "blockquote",
      attrs,
      content: children.length
        ? blocks(children)
        : [{ type: "paragraph", content: inline(node.children) }],
    };
  }
  if (/^h[1-6]$/.test(node.type))
    return {
      type: "heading",
      attrs: { ...attrs, level: Number(node.type.slice(1)) },
      content: inline(node.children),
    };
  if (node.type === KEYS.hr) return { type: "horizontalRule" };
  return { type: "paragraph", attrs, content: inline(node.children) };
}
function blocks(nodes: ComposerBlock[]): JSONContent[] {
  const result: JSONContent[] = [];
  let index = 0;
  function list(depth: number): JSONContent {
    const first = nodes[index]!;
    const style = first.listStyleType;
    const content: JSONContent[] = [];
    while (index < nodes.length) {
      const node = nodes[index]!;
      const level = Number(node.indent ?? 1);
      if (!node.listStyleType || level < depth || (level === depth && node.listStyleType !== style))
        break;
      if (level > depth && content.length) {
        content.at(-1)!.content!.push(list(level));
        continue;
      }
      index++;
      content.push({
        type: "listItem",
        attrs: { checked: node.checked ?? null },
        content: [block(node)],
      });
    }
    return {
      type: style === "decimal" ? "orderedList" : "bulletList",
      attrs: style === "decimal" ? { start: first.listStart ?? 1 } : { composerListStyle: style },
      content,
    };
  }
  while (index < nodes.length) {
    const node = nodes[index]!;
    if (node.listStyleType) {
      result.push(list(Number(node.indent ?? 1)));
      continue;
    }
    result.push(block(node));
    index++;
  }
  return result.length ? result : [{ type: "paragraph" }];
}

export function readComposerDocument(text: string, schema: Schema = composerSchema): DocumentNode {
  return schema.nodeFromJSON({ type: "doc", content: blocks(createComposerEditor(text).children) });
}
function leaves(node: DocumentNode): ComposerNode[] {
  const result: ComposerNode[] = [];
  node.forEach((child) => {
    if (child.isText) {
      result.push({
        text: child.text ?? "",
        ...Object.fromEntries(
          child.marks.map((mark) => [
            mark.type.name === "strike" ? "strikethrough" : mark.type.name,
            true,
          ]),
        ),
      });
      return;
    }
    if (child.type.name === "hardBreak") {
      result.push({ text: "\n" });
      return;
    }
    if (child.type.name === "composer_skill") {
      result.push({ text: child.attrs.text });
      return;
    }
    result.push({ type: child.type.name, ...child.attrs, children: [{ text: "" }] });
  });
  const merged: ComposerNode[] = [];
  for (const child of result) {
    const previous = merged.at(-1);
    if (
      previous &&
      "text" in previous &&
      "text" in child &&
      markKeys.every((key) => previous[key] === child[key])
    ) {
      previous.text += child.text;
      continue;
    }
    merged.push(child);
  }
  return merged.length ? merged : [{ text: "" }];
}
function plateList(list: DocumentNode, depth: number): ComposerBlock[] {
  const result: ComposerBlock[] = [];
  list.forEach((item, _, index) => {
    item.forEach((part) => {
      if (part.type.name === "bulletList" || part.type.name === "orderedList") {
        result.push(...plateList(part, depth + 1));
        return;
      }
      result.push({
        ...plateBlock(part),
        indent: depth + 1,
        listStyleType: list.type.name === "orderedList" ? "decimal" : list.attrs.composerListStyle,
        ...(typeof item.attrs.checked === "boolean" ? { checked: item.attrs.checked } : {}),
        ...(list.type.name === "orderedList"
          ? { listStart: Number(list.attrs.start) + index }
          : {}),
      });
    });
  });
  return result;
}
function plateBlocks(node: DocumentNode): ComposerBlock[] {
  const result: ComposerBlock[] = [];
  node.forEach((child) => {
    if (child.type.name === "bulletList" || child.type.name === "orderedList") {
      result.push(...plateList(child, 0));
      return;
    }
    result.push(plateBlock(child));
  });
  return result;
}
function plateBlock(node: DocumentNode): ComposerBlock {
  const name = node.type.name;
  if (name === "horizontalRule") return { type: KEYS.hr, children: [{ text: "" }] };
  if (name === "blockquote")
    return { type: KEYS.blockquote, children: plateBlocks(node), indent: node.attrs.indent };
  if (name === "codeBlock")
    return {
      type: KEYS.codeBlock,
      lang: node.attrs.language ?? undefined,
      children: node.textContent
        .split("\n")
        .map((text) => ({ type: KEYS.codeLine, children: [{ text }] })),
      indent: node.attrs.indent,
    };
  return {
    type: name === "heading" ? `h${node.attrs.level}` : KEYS.p,
    children: leaves(node),
    indent: node.attrs.indent,
  };
}
const markdownCodec = createComposerEditor();
const documentValues = new WeakMap<DocumentNode, ComposerBlock[]>();
function codec(doc: DocumentNode) {
  let value = documentValues.get(doc);
  if (!value) {
    value = plateBlocks(doc);
    documentValues.set(doc, value);
  }
  markdownCodec.children = value;
  return markdownCodec;
}
// Keep the existing Markdown codec so saved drafts, resource links, and copied messages keep their syntax.
export function writeComposerDocument(doc: DocumentNode, references = true): string {
  const editor = codec(doc);
  return references ? composerMarkdown(editor) : composerSubmissionMarkdown(editor);
}
export function composerText(doc: DocumentNode): string {
  return composerPlainText(codec(doc));
}
export function composerCompletionPrefix(editor: Editor): string {
  const { empty, $from } = editor.state.selection;
  if (!empty || $from.parent.type.name === "codeBlock") return "";
  return $from.parent.textBetween(0, $from.parentOffset, "", (node) =>
    node.type.name === "hardBreak" ? "\n" : "",
  );
}
export function editorAttachmentKeys(doc: DocumentNode): Set<string> {
  const keys = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "composer_attachment" && typeof node.attrs.attachmentKey === "string")
      keys.add(node.attrs.attachmentKey);
  });
  return keys;
}
export type ComposerSkill = { id: string; name: string };
export function editorSkillIds(doc: DocumentNode): string[] {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "composer_skill") ids.add(node.attrs.id);
  });
  return [...ids];
}
export function insertEditorAttachment(
  editor: Editor,
  attachment: Pick<Attachment, "key" | "file">,
) {
  const { from } = editor.state.selection;
  const previous = editor.state.doc.textBetween(Math.max(0, from - 1), from, "", "x");
  editor.commands.insertContent([
    ...(/\S/.test(previous) ? [{ type: "text", text: " " }] : []),
    {
      type: "composer_attachment",
      attrs: { attachmentKey: attachment.key, name: attachment.file.name },
    },
    { type: "text", text: " " },
  ]);
}
export function captureEditorPaste(editor: Editor) {
  let range: { from: number; to: number } | undefined = {
    from: editor.state.selection.from,
    to: editor.state.selection.to,
  };
  const map = ({ transaction }: { transaction: import("@tiptap/pm/state").Transaction }) => {
    if (range)
      range = {
        from: transaction.mapping.map(range.from, 1),
        to: transaction.mapping.map(range.to, 1),
      };
  };
  editor.on("transaction", map);
  const cancel = () => {
    range = undefined;
    editor.off("transaction", map);
  };
  return {
    cancel,
    insert(text: string) {
      const at = range;
      cancel();
      if (!at || editor.isDestroyed) return;
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, at.from, at.to))
          .replaceSelection(Slice.maxOpen(readComposerDocument(text, editor.schema).content))
          .scrollIntoView(),
      );
    },
  };
}
/** `after` extends the replacement past the cursor; `space` appends a separating space. */
export type CompletionRange = { space?: boolean; after?: number };
export function completeEditor(
  editor: Editor,
  text: string,
  length: number,
  skill?: ComposerSkill,
  { space = true, after = 0 }: CompletionRange = {},
) {
  const { from } = editor.state.selection;
  const start = Math.max(1, from - length);
  const end = Math.min(from + after, editor.state.selection.$from.end());
  const { schema, tr } = editor.state;
  if (!skill) {
    editor.view.dispatch(tr.insertText(space ? `${text} ` : text, start, end).scrollIntoView());
    return;
  }
  editor.view.dispatch(
    tr
      .replaceWith(start, from, [
        schema.nodes.composer_skill!.create({ ...skill, text }),
        schema.text(" "),
      ])
      .scrollIntoView(),
  );
}
// Drafts store skill mentions as text. Restore badges for mentions of skills the draft selected.
export function markEditorSkills(editor: Editor, skills: readonly ComposerSkill[]) {
  if (!skills.length) return;
  const pattern = skillMentionPattern(skills.map((skill) => skill.name));
  const { schema, tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText || node.marks.some((mark) => mark.type.name === "code")) return;
    const before = editor.state.doc.resolve(pos).nodeBefore;
    const boundary = !before || before.type.name === "hardBreak";
    for (const match of node.text!.matchAll(pattern)) {
      if (match.index === 0 && !match[1] && !boundary) continue;
      const from = pos + match.index + match[1]!.length;
      tr.replaceWith(
        tr.mapping.map(from),
        tr.mapping.map(from + match[2]!.length),
        schema.nodes.composer_skill!.create({
          id: skills.find((skill) => skill.name === match[3])!.id,
          name: match[3],
          text: match[2],
        }),
      );
    }
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
}
export function replaceEditorDocument(editor: Editor, text: string) {
  const doc = readComposerDocument(text, editor.schema);
  editor.view.updateState(
    EditorState.create({
      schema: editor.schema,
      doc,
      plugins: editor.state.plugins,
      selection: TextSelection.atEnd(doc),
    }),
  );
}
