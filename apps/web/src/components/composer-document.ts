import {
  parseReferenceHref,
  referenceHref,
  parseCitationHref,
  citationHref,
  citationLabel,
  serializeCitation,
} from "@stanley2058/lilac-client-protocol";
import type { Attachment } from "../types";
import {
  ParagraphPlugin,
  createPlateEditor,
  createPlatePlugin,
  type PlateEditor,
} from "platejs/react";
import {
  KEYS,
  NodeApi,
  TextApi,
  type TElement,
  type TListProps,
  type Descendant,
  type TNode,
} from "platejs";
import {
  BoldRules,
  ItalicRules,
  StrikethroughRules,
  CodeRules,
  HeadingRules,
  BlockquoteRules,
} from "@platejs/basic-nodes";
import {
  BoldPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  BlockquotePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockRules } from "@platejs/code-block";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { BulletedListRules, OrderedListRules } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { MarkdownPlugin, defaultRules } from "@platejs/markdown";
import remarkCjkFriendly from "remark-cjk-friendly/bidi";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/bidi";
import remarkGfm from "remark-gfm";
import { editableComposerLinks, protectComposerSyntax } from "./composer-links";
import { editableComposerTables } from "./composer-tables";
import { composerParagraphSpacing } from "./composer-line-breaks";
const attachmentType = "composer_attachment";
const referenceType = "composer_reference";
const citationType = "composer_citation";
const CitationPlugin = createPlatePlugin({
  key: citationType,
  node: { isElement: true, isInline: true, isVoid: true },
});
const AttachmentPlugin = createPlatePlugin({
  key: attachmentType,
  node: { isElement: true, isInline: true, isVoid: true },
});
const ReferencePlugin = createPlatePlugin({
  key: referenceType,
  node: { isElement: true, isInline: true, isVoid: true },
});
function projectComposerNode(node: TNode): {
  key?: string;
  name: string;
  url?: string;
  attachment: boolean;
} {
  return {
    key: typeof node.attachmentKey === "string" ? node.attachmentKey : undefined,
    name: typeof node.name === "string" ? node.name : "File",
    url: typeof node.url === "string" ? node.url : undefined,
    attachment: node.type === attachmentType,
  };
}

function mapComposerNodes(nodes: Descendant[], map: (node: TElement) => Descendant): Descendant[] {
  return nodes.map((node) => {
    if (TextApi.isText(node)) return node;
    node.children = mapComposerNodes(node.children, map);
    return map(node);
  });
}

function mapComposerValue(value: TElement[], map: (node: TElement) => Descendant): TElement[] {
  return structuredClone(value).map((node) => {
    node.children = mapComposerNodes(node.children, map);
    return node;
  });
}

export function insertComposerAttachment(
  editor: PlateEditor,
  attachment: Pick<Attachment, "key" | "file">,
) {
  if (!editor.selection) editor.tf.select(editor.api.end([])!);
  const focus = editor.selection?.focus;
  const previous = focus && editor.api.before(focus, { distance: 1, unit: "character" });
  if (
    focus &&
    previous &&
    editor.api.isCollapsed() &&
    /\S/.test(editor.api.string({ anchor: previous, focus }))
  )
    editor.tf.insertText(" ");
  editor.tf.insertNodes({
    type: attachmentType,
    attachmentKey: attachment.key,
    name: attachment.file.name,
    children: [{ text: "" }],
  });
  editor.tf.move({ distance: 1, unit: "offset" });
  editor.tf.insertText(" ");
}

const composerMarkdownSyntax = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  editableComposerTables,
];

export const composerPlugins = [
  CitationPlugin,
  AttachmentPlugin,
  ReferencePlugin,
  ParagraphPlugin,
  BoldPlugin.configure({
    inputRules: [BoldRules.markdown({ variant: "*" }), BoldRules.markdown({ variant: "_" })],
  }),
  ItalicPlugin.configure({
    inputRules: [ItalicRules.markdown({ variant: "*" }), ItalicRules.markdown({ variant: "_" })],
  }),
  StrikethroughPlugin.configure({ inputRules: [StrikethroughRules.markdown()] }),
  CodePlugin.configure({ inputRules: [CodeRules.markdown()] }),
  H1Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H2Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H3Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
  }),
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
  }),
  CodeLinePlugin,
  createPlatePlugin({
    key: KEYS.a,
    node: { isElement: true, isInline: true },
    parsers: {
      html: {
        deserializer: {
          rules: [{ validNodeName: "A" }],
          parse: ({ element }) => {
            const url = element.getAttribute("href");
            const label = element.textContent ?? "";
            return { text: !url || label === url ? label : `[${label}](${url})` };
          },
        },
      },
    },
  }),
  IndentPlugin,
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
    ],
  }),
  MarkdownPlugin.configure({
    options: {
      remarkPlugins: [...composerMarkdownSyntax, editableComposerLinks, composerParagraphSpacing],
      rules: {
        text: { deserialize: (node, decoration) => ({ ...decoration, text: node.value }) },
      },
    },
  }),
];

function deserializeComposer(editor: PlateEditor, text: string) {
  const value = editor.getApi(MarkdownPlugin).markdown.deserialize(text);
  const trailing = /[ \t]+$/.exec(text)?.[0];
  if (trailing && value.length) {
    const block = value[value.length - 1]!;
    const child = block.children.at(-1);
    if (child && !TextApi.isText(child) && editor.api.isInline(child))
      block.children.push({ text: trailing });
    else {
      const last = NodeApi.last(block, [])?.[0];
      if (TextApi.isText(last)) last.text += trailing;
    }
  }
  return mapComposerValue(value, (node) => {
    const citation =
      node.type === KEYS.a ? parseCitationHref(projectComposerNode(node).url ?? "") : undefined;
    if (citation)
      return { type: citationType, url: citationHref(citation), children: [{ text: "" }] };
    const target =
      node.type === KEYS.a ? parseReferenceHref(projectComposerNode(node).url ?? "") : undefined;
    if (target)
      return { type: referenceType, url: referenceHref(target), children: [{ text: "" }] };
    if (node.type !== KEYS.a || !projectComposerNode(node).url?.startsWith("attachment:"))
      return node;
    return {
      type: attachmentType,
      attachmentKey: projectComposerNode(node).url?.slice("attachment:".length),
      name: NodeApi.string(node),
      children: [{ text: "" }],
    };
  });
}

export function replaceComposerDocument(editor: PlateEditor, text: string) {
  editor.tf.withoutSaving(() => {
    editor.tf.deselect();
    if (composerMarkdown(editor) !== text) editor.tf.setValue(deserializeComposer(editor, text));
  });
  editor.history = { undos: [], redos: [] };
  editor.marks = null;
}

export function createComposerEditor(text = "") {
  return createPlateEditor({
    plugins: composerPlugins,
    value: (editor) => deserializeComposer(editor, text),
  });
}

function trimEmptyInlineText(nodes: Descendant[]): Descendant[] {
  const visible = nodes.some((node) => NodeApi.string(node).length > 0);
  return nodes.flatMap<Descendant>((node) => {
    if (TextApi.isText(node)) return visible && node.text === "" ? [] : [node];
    node.children = trimEmptyInlineText(node.children);
    return [node];
  });
}

function serializeComposer(editor: PlateEditor, references: boolean): string {
  const value = mapComposerValue(editor.children, (node) => {
    if (node.type === citationType) {
      const citation = parseCitationHref(projectComposerNode(node).url ?? "");
      return { text: citation ? serializeCitation(citation) : "Assistant quote" };
    }
    if (node.type === referenceType) {
      const target = parseReferenceHref(projectComposerNode(node).url ?? "");
      if (target)
        return {
          type: KEYS.a,
          url: referenceHref(target),
          children: [
            {
              text: `#${target.surface}:${target.sessionId}${target.messageId ? `/${target.messageId}` : ""}`,
            },
          ],
        };
    }
    if (node.type !== attachmentType) return node;
    const metadata = projectComposerNode(node);
    const text = metadata.name;
    if (!references) return { text };
    return { type: KEYS.a, url: `attachment:${metadata.key}`, children: [{ text }] };
  });
  if (!value.some((node) => NodeApi.string(node))) return "";
  for (const block of value) block.children = trimEmptyInlineText(block.children);
  const restoreSyntax = protectComposerSyntax(editor, value);
  const last: (TElement & Partial<TListProps>) | undefined = value.at(-1);
  const endsWithEmptyParagraph =
    last?.type === KEYS.p && !last.listStyleType && !NodeApi.string(last);
  return restoreSyntax(
    editor.getApi(MarkdownPlugin).markdown.serialize({
      value,
      preserveEmptyParagraphs: false,
      remarkStringifyOptions: {
        handlers: { break: () => "\n" },
        // Composer paragraphs are adjacent lines; an empty block supplies the blank line.
        join: [
          (left, right, parent) =>
            parent.type === "root" && left.type === "paragraph" && right.type === "paragraph"
              ? 0
              : undefined,
        ],
      },
    }),
  )
    .replace(/\n$/, endsWithEmptyParagraph ? "\n" : "")
    .replace(/(?:&#x20;)+(?=\n|$)/g, (spaces) => " ".repeat(spaces.length / 6));
}

export function composerMarkdown(editor: PlateEditor): string {
  return serializeComposer(editor, true);
}

export function composerSubmissionMarkdown(editor: PlateEditor): string {
  return serializeComposer(editor, false);
}

export function resolveComposerAttachments(
  text: string,
  resourceIds: ReadonlyMap<string, string>,
): string {
  const editor = createComposerEditor(text);
  editor.children = mapComposerValue(editor.children, (node) => {
    const metadata = projectComposerNode(node);
    if (!metadata.attachment) return node;
    const id = metadata.key ? resourceIds.get(metadata.key) : undefined;
    if (!id) return { text: metadata.name };
    return {
      type: KEYS.a,
      url: `/api/resources/${encodeURIComponent(id)}`,
      children: [{ text: metadata.name }],
    };
  });
  return composerMarkdown(editor);
}

export function restoreMessageAttachments(
  text: string,
  attachments: ReadonlyMap<string, Attachment>,
): string {
  const editor = createComposerEditor(text);
  const byUrl = new Map(
    [...attachments].map(([id, attachment]) => [
      `/api/resources/${encodeURIComponent(id)}`,
      attachment,
    ]),
  );
  const value = editor.getApi(MarkdownPlugin).markdown.deserialize(text, {
    remarkPlugins: [
      ...composerMarkdownSyntax,
      () => editableComposerLinks(new Set(byUrl.keys())),
      composerParagraphSpacing,
    ],
    rules: {
      ...editor.getOptions(MarkdownPlugin).rules,
      img: {
        deserialize: (node, decoration, options) => {
          const attachment = byUrl.get(node.url);
          if (!attachment) return defaultRules.img!.deserialize!(node, decoration, options);
          return { type: KEYS.a, url: node.url, children: [{ text: attachment.file.name }] };
        },
      },
    },
  });
  if (value.length) editor.children = value;
  const used = new Set<string>();
  editor.children = mapComposerValue(editor.children, (node) => {
    const attachment = byUrl.get(projectComposerNode(node).url ?? "");
    if (!attachment) return node;
    used.add(attachment.key);
    return {
      type: attachmentType,
      attachmentKey: attachment.key,
      name: attachment.file.name,
      children: [{ text: "" }],
    };
  });
  for (const attachment of attachments.values()) {
    if (!used.has(attachment.key)) insertComposerAttachment(editor, attachment);
  }
  return composerMarkdown(editor);
}

export function captureComposerPaste(editor: PlateEditor) {
  const end = editor.api.end([])!;
  const range = editor.api.rangeRef(editor.selection ?? { anchor: end, focus: end });
  return {
    cancel: () => {
      range.unref();
    },
    insert(text: string) {
      const at = range.unref();
      if (!at) return;
      editor.tf.select(at);
      editor.tf.insertFragment(deserializeComposer(editor, text));
    },
  };
}

export function remapComposerAttachments(text: string, keys: ReadonlyMap<string, string>): string {
  const editor = createComposerEditor(text);
  editor.children = mapComposerValue(editor.children, (node) => {
    const metadata = projectComposerNode(node);
    if (!metadata.attachment || !metadata.key) return node;
    const key = keys.get(metadata.key);
    if (!key) return node;
    return {
      type: attachmentType,
      attachmentKey: key,
      name: metadata.name,
      children: [{ text: "" }],
    };
  });
  return composerMarkdown(editor);
}

export function composerPlainText(editor: PlateEditor): string {
  return mapComposerValue(editor.children, (node) => {
    if (node.type === citationType) {
      const citation = parseCitationHref(projectComposerNode(node).url ?? "");
      return { text: citation ? citationLabel(citation) : "Assistant quote" };
    }
    if (node.type === attachmentType) return { text: projectComposerNode(node).name };
    if (node.type === referenceType) return { text: projectComposerNode(node).url ?? "" };
    return node;
  })
    .map((node) => NodeApi.string(node))
    .join("\n\n");
}

export function composerPrefix(editor: PlateEditor): string {
  if (!editor.selection || !editor.api.isCollapsed()) return "";
  const block = editor.api.block();
  if (!block || block[0].type === KEYS.codeLine) return "";
  const start = editor.api.start(block[1]);
  return start ? editor.api.string({ anchor: start, focus: editor.selection.anchor }) : "";
}

export function insertComposerCompletion(editor: PlateEditor, text: string, replaceLength: number) {
  if (!editor.selection) return;
  const focus = editor.selection.anchor;
  const anchor = editor.api.before(focus, { distance: replaceLength, unit: "character" });
  if (!anchor) return;
  editor.tf.insertText(`${text} `, { at: { anchor, focus } });
}
