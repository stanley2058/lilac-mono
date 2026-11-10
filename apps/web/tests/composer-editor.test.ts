import { referencedConversations } from "@stanley2058/lilac-client-protocol";
import { expect, it } from "bun:test";
import { Editor } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { AllSelection } from "@tiptap/pm/state";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { messageClipboard } from "../src/message-clipboard";
import {
  attachmentNode,
  captureEditorPaste,
  citationNode,
  completeEditor,
  composerCompletionPrefix,
  composerExtensions,
  composerText,
  insertEditorAttachment,
  readComposerDocument,
  referenceNode,
  replaceEditorDocument,
  skillNode,
  workflowRunNode,
  writeComposerDocument,
} from "../src/components/composer-tiptap";
import {
  attachmentSize,
  composerSubmission,
  remapComposerAttachments,
  resolveComposerAttachments,
  restoreMessageAttachments,
} from "../src/components/composer-editor";

function headlessEditor(text = "") {
  const editor = new Editor({
    element: null,
    extensions: [
      ...composerExtensions,
      attachmentNode,
      referenceNode,
      workflowRunNode,
      skillNode,
      citationNode,
    ],
    content: readComposerDocument(text).toJSON(),
  });
  // Tiptap treats an unmounted editor as destroyed even though its transactions work headlessly.
  Object.defineProperty(editor, "isDestroyed", { get: () => false });
  return editor;
}

/** Types like a keyboard, so input rules see each character. */
function type(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    // An unmounted editor keeps its input rules on the extension manager, not on the state.
    const handled = editor.extensionManager.plugins.some((plugin) =>
      plugin.props.handleTextInput?.call(plugin, editor.view, from, to, character, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

function insert(editor: Editor, text: string) {
  editor.view.dispatch(editor.state.tr.insertText(text));
}

function draft(editor: Editor) {
  return writeComposerDocument(editor.state.doc);
}

function sent(editor: Editor) {
  return writeComposerDocument(editor.state.doc, false);
}

function count(doc: DocumentNode, name: string) {
  let found = 0;
  doc.descendants((node) => {
    if (node.type.name === name) found++;
  });
  return found;
}

function textPosition(editor: Editor, text: string, occurrence = 0) {
  let found: number | undefined;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (found !== undefined || !node.isText) return;
    let index = node.text!.indexOf(text);
    while (index >= 0) {
      if (seen++ === occurrence) {
        found = pos + index;
        return;
      }
      index = node.text!.indexOf(text, index + 1);
    }
  });
  return found!;
}

it("preserves typed line breaks through send, copy, paste, and draft reload", () => {
  const lines = [
    "sounds about right where I wanted it to be.",
    "",
    "btw, the new sol and luna are so cheap, intelligence cheaper than water (whatever that means)",
    "https://simonwillison.net/2026/Sep/22/opus-and-sol-and-luna/",
  ];
  const text = lines.join("\n");
  const editor = headlessEditor();
  for (const [index, line] of lines.entries()) {
    if (index) editor.commands.splitBlock();
    insert(editor, line);
  }
  expect(draft(editor)).toBe(text);
  expect(sent(editor)).toBe(text);
  const copied = messageClipboard(sent(editor), []).text;
  expect(copied).toBe(text);
  const pasted = headlessEditor();
  captureEditorPaste(pasted).insert(copied);
  for (const restored of [readComposerDocument(text), pasted.state.doc]) {
    expect(writeComposerDocument(restored)).toBe(text);
    const paragraphs: string[] = [];
    restored.forEach((node) =>
      paragraphs.push(
        node.textBetween(0, node.content.size, "", (leaf) =>
          leaf.type.name === "hardBreak" ? "\n" : "",
        ),
      ),
    );
    expect(paragraphs.join("\n")).toBe(text);
  }
  editor.destroy();
  pasted.destroy();
});

it("keeps repeated blank lines and formatted lines without invisible filler", () => {
  for (const text of [
    "first\n\n\nlast",
    "**first**\n_last_",
    "first\n\nsecond\n\nthird",
    "\nfirst",
    "first\n",
    "first\n\n",
  ]) {
    expect(writeComposerDocument(readComposerDocument(text))).toBe(text);
    expect(writeComposerDocument(readComposerDocument(text), false)).not.toContain("​");
  }
});

it("round trips basic rich Markdown through draft text", () => {
  const markdown =
    "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```";
  const doc = readComposerDocument(markdown);
  const serialized = writeComposerDocument(doc);
  expect(serialized).toBe(markdown);
  expect(writeComposerDocument(readComposerDocument(serialized))).toBe(serialized);
  expect(doc.child(0).type.name).toBe("heading");
  expect(doc.child(0).attrs.level).toBe(1);
  expect(doc.child(1).child(0).text).toBe("bold");
  expect(
    doc
      .child(1)
      .child(0)
      .marks.map((mark) => mark.type.name),
  ).toEqual(["bold"]);
  expect(doc.child(2).type.name).toBe("bulletList");
  expect(doc.lastChild?.type.name).toBe("codeBlock");
  expect(doc.lastChild?.attrs.language).toBe("ts");
});

it("round trips CJK emphasis that closes after full-width punctuation", () => {
  const markdown = "**注意：**粗體 ~~刪除：~~文字";
  const paragraph = readComposerDocument(markdown).child(0);
  const runs: { text?: string; marks: string[] }[] = [];
  paragraph.forEach((node) =>
    runs.push({ text: node.text, marks: node.marks.map((mark) => mark.type.name) }),
  );
  expect(runs).toEqual([
    { text: "注意：", marks: ["bold"] },
    { text: "粗體 ", marks: [] },
    { text: "刪除：", marks: ["strike"] },
    { text: "文字", marks: [] },
  ]);
  expect(composerSubmission(markdown)).toBe(markdown);
  expect(restoreMessageAttachments(markdown, new Map())).toBe(markdown);
});

it("inserts a completion at the selected rich-text range without flattening marks or suffixes", () => {
  const editor = headlessEditor("**Keep** $Rev later");
  editor.commands.setTextSelection(textPosition(editor, "$Rev") + 4);
  expect(composerCompletionPrefix(editor)).toBe("Keep $Rev");
  completeEditor(editor, "$Review", 4);
  expect(draft(editor)).toBe("**Keep** $Review  later");
  expect(
    editor.state.doc
      .child(0)
      .child(0)
      .marks.map((mark) => mark.type.name),
  ).toEqual(["bold"]);
  editor.destroy();
});

it("keeps URLs and Markdown links editable and preserves their syntax through reload and send", () => {
  for (const text of [
    "https://example.com/a_b?q=one&next=two",
    "[example.com](https://example.com)",
    '[example](https://example.com/a_(b) "A title")',
    "Before [**label**](https://example.com) after",
    "[https://example.com](https://example.com)",
    "[line\nbreak](https://example.com)",
    "Before 0 [example](https://example.com) after",
  ]) {
    const doc = readComposerDocument(text);
    expect(composerText(doc)).toBe(text);
    expect(writeComposerDocument(doc)).toBe(text);
    expect(writeComposerDocument(doc, false)).toBe(text);
    expect(composerText(readComposerDocument(writeComposerDocument(doc)))).toBe(text);
  }
});

it("preserves attachment chips whose filenames contain Markdown links", () => {
  const editor = headlessEditor();
  insertEditorAttachment(editor, { key: "file-key", file: new File(["contents"], "[x](a).txt") });
  const markdown = draft(editor);
  const restored = readComposerDocument(markdown);
  expect(count(restored, "composer_attachment")).toBe(1);
  expect(writeComposerDocument(restored)).toBe(markdown);
  expect(writeComposerDocument(restored, false)).toBe("[x](a).txt ");
  editor.destroy();
});

it("does not linkify typed URLs or Markdown links and allows editing the destination", () => {
  const editor = headlessEditor();
  type(editor, "[example](https://example.com) https://example.com ");
  expect(draft(editor)).toBe("[example](https://example.com) https://example.com ");
  const from = textPosition(editor, "example.com");
  editor.view.dispatch(
    editor.state.tr.insertText("changed.example", from, from + "example.com".length),
  );
  expect(sent(editor)).toBe("[example](https://changed.example) https://example.com ");
  editor.destroy();
});

it("preserves command separators and trailing spaces through completion and draft restore", () => {
  const editor = headlessEditor("/fi");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  completeEditor(editor, "/fixture-status", 3);
  expect(draft(editor)).toBe("/fixture-status ");
  const restored = readComposerDocument(draft(editor));
  expect(composerText(restored)).toBe("/fixture-status ");
  expect(writeComposerDocument(restored)).toBe("/fixture-status ");
  editor.destroy();
});

it("does not offer completion for a range or code-block content", () => {
  const editor = headlessEditor("```\n$review\n```");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  expect(composerCompletionPrefix(editor)).toBe("");
  const prose = headlessEditor("$review");
  prose.view.dispatch(prose.state.tr.setSelection(new AllSelection(prose.state.doc)));
  expect(composerCompletionPrefix(prose)).toBe("");
  editor.destroy();
  prose.destroy();
});

it("keeps completion identities and custom arguments independent of Markdown escaping", () => {
  const skill = readComposerDocument("$my_skill");
  expect(writeComposerDocument(skill)).toBe("$my\\_skill");
  expect(composerText(skill)).toBe("$my_skill");
  expect(composerText(readComposerDocument("/skill:my_skill next"))).toBe("/skill:my_skill next");
  const command = readComposerDocument("/my_command argument_with_underscores");
  expect(composerText(command)).toBe("/my_command argument_with_underscores");
  expect(composerText(readComposerDocument(writeComposerDocument(command)))).toBe(
    "/my_command argument_with_underscores",
  );
});

it("keeps an empty or cleared editor empty on the wire", () => {
  const editor = headlessEditor();
  expect(draft(editor)).toBe("");
  expect(composerText(editor.state.doc)).toBe("");
  insert(editor, "test");
  editor.view.dispatch(
    editor.state.tr.setSelection(new AllSelection(editor.state.doc)).deleteSelection(),
  );
  expect(draft(editor)).toBe("");
  editor.destroy();
});

it("inserts a file reference at the caret and restores its position without flattening Markdown", () => {
  const editor = headlessEditor("**Compare**  with the earlier image");
  editor.commands.setTextSelection(textPosition(editor, "  with") + 1);
  insertEditorAttachment(editor, {
    key: "image-one",
    file: new File(["image"], "screen.png", { type: "image/png" }),
  });
  expect(draft(editor)).toBe(
    "**Compare** [screen.png](attachment:image-one)  with the earlier image",
  );
  const restored = readComposerDocument(draft(editor));
  expect(writeComposerDocument(restored)).toBe(draft(editor));
  expect(composerText(restored)).toBe("Compare screen.png  with the earlier image");
  expect(writeComposerDocument(restored, false)).toBe(
    "**Compare** screen.png  with the earlier image",
  );
  editor.destroy();
});

it("remaps only file references when a local draft moves to a server thread", () => {
  const markdown =
    "See [notes.txt](attachment:old-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```";
  const remapped = remapComposerAttachments(markdown, new Map([["old-key", "new-key"]]));
  expect(remapped).toBe(
    "See [notes.txt](attachment:new-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
  expect(composerSubmission(remapped)).toBe(
    "See notes.txt and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
});

it("keeps attachment-only drafts sendable and handles Markdown characters in filenames", () => {
  const editor = headlessEditor();
  insertEditorAttachment(editor, { key: "special-file", file: new File([""], "my_[draft].txt") });
  const markdown = draft(editor);
  const restored = readComposerDocument(markdown);
  expect(composerText(restored)).toBe("my_[draft].txt ");
  expect(writeComposerDocument(restored, false)).not.toContain("attachment:");
  expect(markdown).not.toContain("​");
  expect(writeComposerDocument(restored, false)).not.toContain("​");
  expect(writeComposerDocument(restored)).toBe(markdown);
  editor.destroy();
});

it("separates an inserted file name from adjacent prose", () => {
  const editor = headlessEditor("Review");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  insertEditorAttachment(editor, { key: "file", file: new File(["text"], "notes.txt") });
  expect(sent(editor)).toBe("Review notes.txt ");
  editor.destroy();
});

it("resolves duplicate file names by their attachment identities and leaves code literal", () => {
  const source =
    "First [same.png](attachment:first), then [same.png](attachment:second). `literal [same.png](attachment:first)`";
  const resolved = resolveComposerAttachments(
    source,
    new Map([
      ["first", "upload-one"],
      ["second", "upload-two"],
    ]),
  );
  expect(resolved).toBe(
    "First [same.png](/api/resources/upload-one), then [same.png](/api/resources/upload-two). `literal [same.png](attachment:first)`",
  );
  expect(resolveComposerAttachments("[missing.txt](attachment:missing)", new Map())).toBe(
    "missing.txt",
  );
  expect(
    resolveComposerAttachments(
      "[safe.txt](attachment:known)",
      new Map([["known", "id/with space"]]),
    ),
  ).toBe("[safe.txt](/api/resources/id%2Fwith%20space)");
});

it("preserves file references through local draft remapping before resource reservation", () => {
  const local = "Compare [image.png](attachment:local-key)";
  const moved = remapComposerAttachments(local, new Map([["local-key", "upload-key"]]));
  expect(resolveComposerAttachments(moved, new Map([["upload-key", "reserved-id"]]))).toBe(
    "Compare [image.png](/api/resources/reserved-id)",
  );
});

it("swaps thread documents in the same editor without carrying undo, selection, or marks across", () => {
  const editor = headlessEditor("First draft");
  editor.registerPlugin(history());
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  insert(editor, " edited");
  editor.view.dispatch(editor.state.tr.addStoredMark(editor.schema.marks.bold!.create()));
  const firstDraft = draft(editor);
  const secondDraft = "**Second draft** [notes.txt](attachment:second-file)";
  replaceEditorDocument(editor, secondDraft);
  expect(draft(editor)).toBe(secondDraft);
  expect(editor.state.storedMarks).toBeNull();
  expect(undo(editor.state, editor.view.dispatch)).toBe(false);
  expect(draft(editor)).toBe(secondDraft);
  replaceEditorDocument(editor, firstDraft);
  expect(draft(editor)).toBe("First draft edited");
  editor.destroy();
});

it("resets history even when two threads have identical draft text", () => {
  const editor = headlessEditor("Shared text");
  editor.registerPlugin(history());
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  insert(editor, "!");
  replaceEditorDocument(editor, "Shared text!");
  expect(undo(editor.state, editor.view.dispatch)).toBe(false);
  expect(draft(editor)).toBe("Shared text!");
  editor.destroy();
});

it("keeps an empty paragraph when switching between empty drafts", () => {
  const editor = headlessEditor();
  replaceEditorDocument(editor, "");
  expect(editor.state.doc.childCount).toBe(1);
  expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  expect(draft(editor)).toBe("");
  editor.destroy();
});

it("restores copied resources inline and keeps unrelated links and code intact", () => {
  const file = new File(["notes"], "notes.md", { type: "text/markdown" });
  const attachment = {
    key: "new-key",
    file,
    state: "ready" as const,
    progress: 1,
    reservation: Promise.resolve("new-resource"),
  };
  const text = restoreMessageAttachments(
    "Before [notes.md](/api/resources/original) after [site](https://example.com).\n\n`/api/resources/original`",
    new Map([["original", attachment]]),
  );
  expect(text).toBe(
    "Before [notes.md](attachment:new-key) after [site](https://example.com).\n\n`/api/resources/original`",
  );
  const image = restoreMessageAttachments(
    "Before ![notes](/api/resources/original) after",
    new Map([["original", attachment]]),
  );
  expect(image).toBe("Before [notes.md](attachment:new-key) after");
  const submitted = resolveComposerAttachments(text, new Map([["new-key", "new-resource"]]));
  expect(submitted).toContain("[notes.md](/api/resources/new-resource)");
  expect(restoreMessageAttachments("", new Map([["original", attachment]]))).toContain(
    "[notes.md](attachment:new-key)",
  );
});

it("keeps an asynchronous paste range current and drops it on cancellation", () => {
  const editor = headlessEditor("before after");
  editor.commands.setTextSelection(8);
  const target = captureEditorPaste(editor);
  editor.view.dispatch(editor.state.tr.insertText("prefix ", 1));
  target.insert("**pasted** ");
  expect(draft(editor)).toBe("prefix before **pasted** after");
  const canceled = captureEditorPaste(editor);
  canceled.cancel();
  canceled.insert("must not appear");
  expect(draft(editor)).not.toContain("must not appear");
  editor.destroy();
});

it("preserves conversation reference chips through drafts, send, edit and paste", () => {
  const markdown = "[#native:thread](/?ref=native%3Athread&message=message)";
  const doc = readComposerDocument(markdown);
  expect(count(doc, "composer_reference")).toBe(1);
  expect(composerText(doc)).not.toBe("");
  const submitted = writeComposerDocument(doc, false);
  expect(referencedConversations(submitted)).toEqual([
    { surface: "native", sessionId: "thread", messageId: "message" },
  ]);
  expect(writeComposerDocument(readComposerDocument(submitted))).toBe(submitted);
  expect(resolveComposerAttachments(submitted, new Map())).toBe(submitted);
  const pasted = headlessEditor("Before ");
  pasted.commands.setTextSelection(pasted.state.doc.content.size - 1);
  captureEditorPaste(pasted).insert(submitted);
  expect(referencedConversations(draft(pasted))).toEqual(referencedConversations(submitted));
  pasted.destroy();
});

it("preserves inclusive range references through composer paste and submission", () => {
  const markdown = "[Discussion](/?ref=discord%3Achannel&range=first..last)";
  const editor = headlessEditor("Before ");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  captureEditorPaste(editor).insert(markdown);
  const submitted = sent(editor);
  expect(referencedConversations(submitted)).toEqual([
    {
      surface: "discord",
      sessionId: "channel",
      range: { startMessageId: "first", endMessageId: "last" },
    },
  ]);
  expect(composerSubmission(submitted)).toBe(submitted);
  editor.destroy();
});

it("formats attachment sizes", () => {
  expect(attachmentSize(512)).toBe("512 B");
  expect(attachmentSize(1536)).toBe("2 KB");
  expect(attachmentSize(1572864)).toBe("1.5 MB");
});
