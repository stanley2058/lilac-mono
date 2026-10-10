import { Kbd } from "./ui/kbd";
import { shortcutOverlayOpen } from "../shortcuts";
import { formatBinding, ariaBinding } from "../keybindings";
import { parseReferenceHref } from "@stanley2058/lilac-client-protocol";
import { ConversationBadge } from "./ConversationReference";
import { FileIcon } from "./FileIcon";
import { SkillBadge } from "./SkillBadge";
import { FileActions } from "./FileActions";
import { useOptionalWorkspace } from "../workspace-context";
import {
  memo,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading2,
  Quote,
  List,
  ListOrdered,
  SquareCode,
  X,
  RotateCcw,
} from "lucide-react";
import { IconButton } from "./ui";
import { inlineChipStyles } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { Attachment } from "../types";

import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import { type Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import {
  composerExtensions,
  attachmentNode,
  referenceNode,
  skillNode,
  markEditorSkills,
  readComposerDocument,
  writeComposerDocument,
  composerText,
  composerCompletionPrefix,
  insertEditorAttachment,
  captureEditorPaste,
  Placeholder,
  editorAttachmentKeys,
  editorSkillIds,
  type ComposerSkill,
  completeEditor,
  replaceEditorDocument,
  insertEditorReference,
  composerBadgeSelection,
  type CompletionRange,
} from "./composer-tiptap";
export {
  createComposerEditor,
  replaceComposerDocument,
  composerMarkdown,
  composerPrefix,
  composerPlainText,
  insertComposerCompletion,
  insertComposerAttachment,
  composerSubmissionMarkdown,
  remapComposerAttachments,
  resolveComposerAttachments,
  restoreMessageAttachments,
  captureComposerPaste,
} from "./composer-document";
const emptyAttachments: readonly Attachment[] = [];
const emptySkills: readonly ComposerSkill[] = [];
const AttachmentContext = createContext<{
  attachments: readonly Attachment[];
  disabled: boolean;
  retry?: (key: string) => void;
}>({ attachments: emptyAttachments, disabled: false });

function AttachmentElement(props: NodeViewProps) {
  const workspace = useOptionalWorkspace();
  const context = useContext(AttachmentContext);
  const metadata = {
    key: props.node.attrs.attachmentKey as string,
    name: props.node.attrs.name as string,
  };
  const key = metadata.key ?? "";
  const attachment = context.attachments.find((item) => item.key === key);
  const name = attachment?.file.name ?? metadata.name;
  return (
    <NodeViewWrapper as="span" className="composer-attachment-node inline">
      <FileActions
        disabled={attachment?.state !== "ready" || !attachment.resourceId}
        target={{
          type: "resource",
          href: attachment?.resourceId
            ? (workspace?.resourceUrl(attachment.resourceId) ??
              `/api/resources/${encodeURIComponent(attachment.resourceId)}`)
            : "",
          name,
          mediaType: attachment?.file.type || "application/octet-stream",
          resourceId: attachment?.resourceId,
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-ui="composer-attachment-chip"
                className={`composer-attachment-chip ${inlineChipStyles}`}
                data-state={attachment?.state ?? "missing"}
              />
            }
          >
            {attachment?.preview ? (
              <img src={attachment.preview} alt="" />
            ) : (
              <FileIcon name={name} mediaType={attachment?.file.type} />
            )}
            <span className="composer-attachment-name overflow-hidden text-ellipsis">{name}</span>
            <small>{attachment ? attachmentSize(attachment.file.size) : "Reattach file"}</small>
            {attachment?.state === "reserving" ? (
              <span className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap">
                Preparing upload
              </span>
            ) : null}
            {attachment?.state === "uploading" ? (
              <progress value={attachment.progress} max={1} aria-label={`Uploading ${name}`} />
            ) : null}
            {attachment?.state === "failed" ? (
              <IconButton
                label={`Retry ${name}`}
                disabled={context.disabled}
                onClick={() => context.retry?.(key)}
              >
                <RotateCcw />
              </IconButton>
            ) : null}
            <IconButton
              label={`Remove ${name}`}
              disabled={context.disabled}
              onClick={() => {
                props.deleteNode();
                props.editor.commands.focus();
              }}
            >
              <X />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{attachment?.error ?? name}</TooltipContent>
        </Tooltip>
      </FileActions>
    </NodeViewWrapper>
  );
}

export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReferenceElement(props: NodeViewProps) {
  const href = props.node.attrs.url as string;
  const target = parseReferenceHref(href);
  return (
    <NodeViewWrapper as="span">
      {target ? <ConversationBadge target={target} /> : href}
    </NodeViewWrapper>
  );
}

function SkillElement(props: NodeViewProps) {
  const context = useContext(AttachmentContext);
  const name = props.node.attrs.name as string;
  return (
    <NodeViewWrapper as="span" className="inline">
      <SkillBadge name={name}>
        <IconButton
          label={`Remove ${name}`}
          disabled={context.disabled}
          onClick={() => {
            props.deleteNode();
            props.editor.commands.focus();
          }}
        >
          <X />
        </IconButton>
      </SkillBadge>
    </NodeViewWrapper>
  );
}
export type ComposerEditorHandle = {
  capturePaste: () => ReturnType<typeof captureEditorPaste>;
  complete: (
    text: string,
    replaceLength: number,
    skill?: ComposerSkill,
    range?: CompletionRange,
  ) => void;
  submissionText: () => string;
  hasMissingAttachments: () => boolean;
};
export type ComposerEditorProps = {
  ref?: Ref<ComposerEditorHandle>;
  text: string;
  documentKey?: string;
  loadingDraft?: boolean;
  autoFocus?: boolean;
  attachments?: readonly Attachment[];
  skills?: readonly ComposerSkill[];
  onRemoveAttachment?: (key: string) => void;
  onRetryAttachment?: (key: string) => void;
  disabled: boolean;
  placeholder: string;
  onText: (text: string, plainText: string, skillIds: string[]) => void;
  onPlainText: (text: string, markdown: string) => void;
  onPrefix: (prefix: string) => void;
  onKeyDown: (event: globalThis.KeyboardEvent) => void;
  onPaste: (event: ClipboardEvent) => void;
  expanded: boolean;
  activeDescendant?: string;
};
const ComposerEditor = memo(function ComposerEditor(props: ComposerEditorProps) {
  const current = useRef(props);
  current.current = props;
  const lastText = useRef(props.text);
  const documentKey = useRef(props.documentKey);
  const seenAttachments = useRef(new Set<string>());
  const referencedAttachments = useRef(new Set<string>());
  const attachments = props.attachments ?? emptyAttachments;
  const skills = props.skills ?? emptySkills;
  const [initialDocument] = useState(() => readComposerDocument(props.text).toJSON());
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      ...composerExtensions,
      Placeholder.configure({ placeholder: () => current.current.placeholder }),
      attachmentNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(AttachmentElement, {
            attrs: { contenteditable: "inherit", "data-composer-badge": "" },
          }),
      }),
      referenceNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(ReferenceElement, {
            attrs: { contenteditable: "inherit", "data-composer-badge": "" },
          }),
      }),
      skillNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(SkillElement, {
            attrs: { contenteditable: "inherit", "data-composer-badge": "" },
          }),
      }),
    ],
    content: initialDocument,
    editable: !props.disabled,
    editorProps: {
      createSelectionBetween: composerBadgeSelection,
      handleTextInput: (view, from, to, text) =>
        insertEditorReference(view, from, to, text, location.origin),
      attributes: {
        class: "composer-editor",
        "data-ui": "composer-input",
        "aria-label": "Message",
        role: "textbox",
        "aria-multiline": "true",
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          current.current.onKeyDown(event);
          return event.defaultPrevented;
        },
        paste: (_view, event) => {
          current.current.onPaste(event);
          return event.defaultPrevented;
        },
      },
      handlePaste: (view, event) => {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        const text = clipboard.getData("text/plain");
        const { from, to } = view.state.selection;
        if (insertEditorReference(view, from, to, text, location.origin)) return true;
        if (clipboard.getData("text/html")) return false;
        if (!text) return false;
        view.dispatch(
          view.state.tr
            .replaceSelection(Slice.maxOpen(readComposerDocument(text, view.state.schema).content))
            .scrollIntoView(),
        );
        return true;
      },
      transformPastedHTML: (html) => {
        const root = new DOMParser().parseFromString(html, "text/html");
        for (const link of root.querySelectorAll("a")) {
          const url = link.getAttribute("href");
          const label = link.textContent ?? "";
          link.replaceWith(
            root.createTextNode(!url || label === url ? label : `[${label}](${url})`),
          );
        }
        return root.body.innerHTML;
      },
      clipboardTextSerializer: (slice) => {
        const schema = readComposerDocument("").type.schema;
        const content = slice.content;
        const doc = schema.topNodeType.create(
          null,
          content.firstChild?.isInline ? schema.nodes.paragraph!.create(null, content) : content,
        );
        return writeComposerDocument(doc);
      },
    },
    onUpdate: ({ editor }) => {
      const p = current.current;
      if (p.loadingDraft) return;
      const references = editorAttachmentKeys(editor.state.doc);
      for (const key of referencedAttachments.current) {
        if (!references.has(key) && p.attachments?.some((attachment) => attachment.key === key))
          p.onRemoveAttachment?.(key);
      }
      referencedAttachments.current = references;
      const text = writeComposerDocument(editor.state.doc);
      const plain = composerText(editor.state.doc);
      lastText.current = text;
      if (text !== p.text) p.onText(text, plain, editorSkillIds(editor.state.doc));
      p.onPlainText(plain, text);
      p.onPrefix(composerCompletionPrefix(editor));
    },
    onSelectionUpdate: ({ editor }) => current.current.onPrefix(composerCompletionPrefix(editor)),
  });
  useLayoutEffect(() => {
    if (!editor || props.loadingDraft) return;
    const switched = documentKey.current !== props.documentKey;
    lastText.current = switched ? props.text : lastText.current;
    if (switched) {
      documentKey.current = props.documentKey;
      seenAttachments.current.clear();
      referencedAttachments.current.clear();
      replaceEditorDocument(editor, props.text);
      markEditorSkills(editor, skills);
    } else if (props.text !== lastText.current) {
      lastText.current = props.text;
      editor.commands.setContent(readComposerDocument(props.text, editor.schema).toJSON(), {
        emitUpdate: false,
      });
      markEditorSkills(editor, skills);
    }
    props.onPlainText(composerText(editor.state.doc), props.text);
  }, [editor, props.documentKey, props.loadingDraft, props.text, props.onPlainText, skills]);
  useLayoutEffect(() => {
    if (!editor || props.loadingDraft) return;
    markEditorSkills(editor, skills);
  }, [editor, props.loadingDraft, skills]);
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
    const element = editor.view.dom;
    for (const [name, value] of Object.entries({
      "aria-controls": props.expanded ? "composer-completions" : undefined,
      "aria-activedescendant": props.activeDescendant,
    })) {
      if (value) element.setAttribute(name, value);
      else element.removeAttribute(name);
    }
    editor.view.dispatch(editor.state.tr);
  }, [editor, props.disabled, props.expanded, props.activeDescendant, props.placeholder]);
  useEffect(() => {
    if (!editor || props.loadingDraft) return;
    const keys = new Set(attachments.map((attachment) => attachment.key));
    const references = editorAttachmentKeys(editor.state.doc);
    const transaction = editor.state.tr;
    editor.state.doc.descendants((node, pos) => {
      const key = node.attrs.attachmentKey;
      if (
        node.type.name === "composer_attachment" &&
        seenAttachments.current.has(key) &&
        !keys.has(key)
      ) {
        transaction.delete(
          transaction.mapping.map(pos),
          transaction.mapping.map(pos + node.nodeSize),
        );
      }
    });
    if (transaction.docChanged) editor.view.dispatch(transaction);
    for (const attachment of attachments) {
      if (!seenAttachments.current.has(attachment.key) && !references.has(attachment.key))
        insertEditorAttachment(editor, attachment);
    }
    seenAttachments.current = keys;
    referencedAttachments.current = editorAttachmentKeys(editor.state.doc);
  }, [editor, attachments, props.loadingDraft]);
  useImperativeHandle(
    props.ref,
    () => ({
      capturePaste: () => (editor ? captureEditorPaste(editor) : { cancel() {}, insert() {} }),
      submissionText: () => (editor ? writeComposerDocument(editor.state.doc, false) : props.text),
      hasMissingAttachments: () =>
        !!editor &&
        [...editorAttachmentKeys(editor.state.doc)].some(
          (key) => !attachments.some((attachment) => attachment.key === key),
        ),
      complete(text, length, skill, range) {
        if (!editor) return;
        completeEditor(editor, text, length, skill, range);
        editor.commands.focus();
      },
    }),
    [editor, attachments, props.text],
  );
  const focusedDocument = useRef<string>(undefined);
  useEffect(() => {
    if (
      !editor ||
      !props.documentKey ||
      props.loadingDraft ||
      props.disabled ||
      focusedDocument.current === props.documentKey
    )
      return;
    focusedDocument.current = props.documentKey;
    if (!props.autoFocus || window.matchMedia("(pointer: coarse)").matches || shortcutOverlayOpen())
      return;
    const focused = document.activeElement;
    if (focused instanceof Element && focused.closest('input, textarea, [contenteditable="true"]'))
      return;
    editor.commands.focus("end");
  }, [editor, props.documentKey, props.loadingDraft, props.disabled, props.autoFocus]);
  return (
    <AttachmentContext
      value={{ attachments, disabled: props.disabled, retry: props.onRetryAttachment }}
    >
      <ComposerFormatting editor={editor} disabled={props.disabled} />
      <EditorContent editor={editor} />
    </AttachmentContext>
  );
});
export default ComposerEditor;
const ComposerFormatting = memo(function ComposerFormatting({
  editor,
  disabled,
}: {
  editor: Editor | null;
  disabled: boolean;
}) {
  function mark(key: string) {
    editor?.chain().focus().toggleMark(key).run();
  }
  function block(type: string) {
    if (!editor) return;
    if (type === "heading") editor.chain().focus().toggleHeading({ level: 2 }).run();
    else editor.chain().focus().toggleBlockquote().run();
  }
  function list(style: string) {
    if (style === "disc") editor?.chain().focus().toggleBulletList().run();
    else editor?.chain().focus().toggleOrderedList().run();
  }
  return (
    <div
      className="composer-formatting flex gap-1 px-1 flex-wrap"
      role="toolbar"
      aria-label="Text formatting"
      onMouseDown={(event) => event.preventDefault()}
    >
      <IconButton
        tooltip={
          <>
            Bold <Kbd>{formatBinding({ code: "KeyB", mod: true, alt: false, shift: false })}</Kbd>
          </>
        }
        aria-keyshortcuts={ariaBinding({ code: "KeyB", mod: true, alt: false, shift: false })}
        label="Bold"
        disabled={disabled}
        onClick={() => mark("bold")}
      >
        <Bold />
      </IconButton>
      <IconButton
        tooltip={
          <>
            Italic <Kbd>{formatBinding({ code: "KeyI", mod: true, alt: false, shift: false })}</Kbd>
          </>
        }
        aria-keyshortcuts={ariaBinding({ code: "KeyI", mod: true, alt: false, shift: false })}
        label="Italic"
        disabled={disabled}
        onClick={() => mark("italic")}
      >
        <Italic />
      </IconButton>
      <IconButton label="Strikethrough" disabled={disabled} onClick={() => mark("strike")}>
        <Strikethrough />
      </IconButton>
      <IconButton label="Inline code" disabled={disabled} onClick={() => mark("code")}>
        <Code />
      </IconButton>
      <IconButton label="Heading" disabled={disabled} onClick={() => block("heading")}>
        <Heading2 />
      </IconButton>
      <IconButton label="Quote" disabled={disabled} onClick={() => block("blockquote")}>
        <Quote />
      </IconButton>
      <IconButton label="Bulleted list" disabled={disabled} onClick={() => list("disc")}>
        <List />
      </IconButton>
      <IconButton label="Numbered list" disabled={disabled} onClick={() => list("decimal")}>
        <ListOrdered />
      </IconButton>
      <IconButton
        label="Code block"
        disabled={disabled}
        onClick={() => {
          editor?.chain().focus().toggleCodeBlock().run();
        }}
      >
        <SquareCode />
      </IconButton>
    </div>
  );
});
