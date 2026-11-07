import { Kbd } from "./ui/kbd";
import { createPortal } from "react-dom";
import { shortcutOverlayOpen } from "../shortcuts";
import { shouldFocusComposer } from "../composer-focus";
import { formatBinding, ariaBinding } from "../keybindings";
import {
  parseReferenceHref,
  parseCitationHref,
  citationHref,
  citationInputFits,
  withCitationComment,
} from "@stanley2058/lilac-client-protocol";
import { registerCitationComposer } from "../citation-store";
import type { CitationAnchor } from "../assistant-selection";
import { CitationChip } from "./CitationChip";
import { ConversationBadge } from "./ConversationReference";
import { FileIcon } from "./FileIcon";
import { SkillBadge } from "./SkillBadge";
import { FileActions } from "./FileActions";
import { FileTargetPreview } from "./FileViewer";
import type { FileTarget } from "../file-target";
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
import { Button, inlineChipStyles } from "./ui/button";
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
  citationNode,
  insertEditorCitation,
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
type OpenCitation = { key: string; anchor?: CitationAnchor; fresh?: { before: boolean } };
const CitationEditorContext = createContext<{
  open?: OpenCitation;
  setOpen: (open: OpenCitation | undefined) => void;
  send: () => void;
}>({ setOpen() {}, send() {} });

function CitationElement(props: NodeViewProps) {
  const context = useContext(CitationEditorContext);
  const citation = parseCitationHref(props.node.attrs.url as string);
  const key = props.node.attrs.citationKey as string;
  if (!citation) return <NodeViewWrapper as="span">Assistant quote</NodeViewWrapper>;
  const open = context.open?.key === key ? context.open : undefined;
  const position = () => props.getPos();
  const save = (comment: string): boolean => {
    const pos = position();
    if (!props.editor.isEditable || pos === undefined) return false;
    const node = props.editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "composer_citation") return false;
    const transaction = props.editor.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      url: citationHref(withCitationComment(citation, comment)),
    });
    if (!citationInputFits(writeComposerDocument(transaction.doc))) return false;
    props.editor.view.dispatch(transaction);
    return true;
  };
  return (
    <NodeViewWrapper as="span" className="inline" data-composer-badge="" contentEditable={false}>
      <CitationChip
        citation={citation}
        editing={{
          open: !!open,
          anchor: open?.anchor,
          discardOnCancel: !!open?.fresh,
          onOpen: (opened) => context.setOpen(opened ? { key } : undefined),
          onSave: save,
          onSaveAndSend: (comment) => {
            if (!save(comment)) return false;
            context.send();
            return true;
          },
          onCancel: () => {
            const pos = position();
            if (open?.fresh && props.editor.isEditable && pos !== undefined) {
              const { doc } = props.editor.state;
              const end = pos + props.node.nodeSize;
              const from =
                open.fresh.before && pos > 0 && doc.textBetween(pos - 1, pos) === " "
                  ? pos - 1
                  : pos;
              const to =
                end < doc.content.size && doc.textBetween(end, end + 1) === " " ? end + 1 : end;
              props.editor.commands.deleteRange({ from, to });
            }
            context.setOpen(undefined);
          },
          onRestoreFocus: () => {
            const pos = position();
            if (props.editor.isEditable)
              props.editor.commands.focus(
                pos === undefined ? undefined : pos + props.node.nodeSize,
              );
          },
        }}
      />
    </NodeViewWrapper>
  );
}
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
  const [preview, setPreview] = useState(false);
  const ready = attachment?.state === "ready" && !!(attachment.resourceId || attachment.preview);
  const target: FileTarget = {
    type: "resource",
    href: attachment?.resourceId
      ? (workspace?.resourceUrl(attachment.resourceId) ??
        `/api/resources/${encodeURIComponent(attachment.resourceId)}`)
      : (attachment?.preview ?? ""),
    name,
    mediaType: attachment?.file.type || "application/octet-stream",
    resourceId: attachment?.resourceId,
  };
  return (
    <NodeViewWrapper as="span" className="composer-attachment-node inline">
      <FileActions disabled={!ready} target={target} onPreview={() => setPreview(true)}>
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
            <Button
              variant="ghost"
              className="composer-attachment-preview min-w-0 shrink gap-1 p-0 h-auto rounded-sm text-[length:inherit] leading-inherit font-normal disabled:opacity-100"
              aria-label={`Preview ${name}`}
              disabled={!ready}
              onClick={() => setPreview(true)}
            >
              {attachment?.preview ? (
                <img src={attachment.preview} alt="" />
              ) : (
                <FileIcon name={name} mediaType={attachment?.file.type} />
              )}
              <span className="composer-attachment-name overflow-hidden text-ellipsis">{name}</span>
              <small>{attachment ? attachmentSize(attachment.file.size) : "Reattach file"}</small>
            </Button>
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
      {preview ? <FileTargetPreview target={target} onClose={() => setPreview(false)} /> : null}
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
  draftText: () => string;
  hasMissingAttachments: () => boolean;
};
export type ComposerEditorProps = {
  ref?: Ref<ComposerEditorHandle>;
  text: string;
  documentKey?: string;
  loadingDraft?: boolean;
  autoFocus?: boolean;
  typeToFocus?: boolean;
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
  onSubmit?: () => void;
  expanded: boolean;
  activeDescendant?: string;
  /** Renders the formatting buttons into this element, inline with the composer's controls. */
  formattingTarget?: HTMLElement | null;
};
const ComposerEditor = memo(function ComposerEditor(props: ComposerEditorProps) {
  const [openCitation, setOpenCitation] = useState<OpenCitation>();
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
      citationNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(CitationElement, {
            attrs: { contenteditable: "false", "data-composer-badge": "" },
          }),
      }),
      Placeholder.configure({ placeholder: () => current.current.placeholder }),
      attachmentNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(AttachmentElement, {
            attrs: { contenteditable: "false", "data-composer-badge": "" },
          }),
      }),
      referenceNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(ReferenceElement, {
            attrs: { contenteditable: "false", "data-composer-badge": "" },
          }),
      }),
      skillNode.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(SkillElement, {
            attrs: { contenteditable: "false", "data-composer-badge": "" },
          }),
      }),
    ],
    content: initialDocument,
    editable: !props.disabled,
    editorProps: {
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
      // ProseMirror filters IME confirmation keys before calling handleKeyDown.
      handleKeyDown: (_view, event) => {
        current.current.onKeyDown(event);
        return event.defaultPrevented;
      },
      handleDOMEvents: {
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
  useEffect(() => {
    if (!editor || !props.documentKey || props.disabled || props.loadingDraft) return;
    return registerCitationComposer(props.documentKey, (citation, anchor) => {
      if (!editor.isEditable) return false;
      const inserted = insertEditorCitation(editor, citation);
      if (!inserted) return false;
      setOpenCitation({
        key: inserted.key,
        anchor,
        fresh: { before: inserted.before },
      });
      return true;
    });
  }, [editor, props.documentKey, props.disabled, props.loadingDraft]);
  useEffect(() => setOpenCitation(undefined), [props.documentKey]);
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
      draftText: () => (editor ? writeComposerDocument(editor.state.doc) : props.text),
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
  useEffect(() => {
    if (!editor || !props.typeToFocus || props.disabled || props.loadingDraft) return;
    const focus = (event: KeyboardEvent) => {
      if (!shouldFocusComposer(event)) return;
      // Focus synchronously so the browser delivers this key's native text input to the editor.
      editor.view.focus();
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, [editor, props.typeToFocus, props.disabled, props.loadingDraft]);
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
      <CitationEditorContext
        value={{
          open: openCitation,
          setOpen: setOpenCitation,
          send: () => current.current.onSubmit?.(),
        }}
      >
        {props.formattingTarget
          ? createPortal(
              <ComposerFormatting editor={editor} disabled={props.disabled} />,
              props.formattingTarget,
            )
          : null}
        <EditorContent editor={editor} />
      </CitationEditorContext>
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
      className="composer-formatting flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
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
