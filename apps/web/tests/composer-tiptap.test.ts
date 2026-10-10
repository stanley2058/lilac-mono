import { expect, it } from "bun:test";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection, AllSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import {
  readComposerDocument,
  writeComposerDocument,
  composerText,
  composerSchema,
  editorAttachmentKeys,
  composerExtensions,
  attachmentNode,
  referenceNode,
  skillNode,
  markEditorSkills,
  editorSkillIds,
  captureEditorPaste,
  composerCompletionPrefix,
  completeEditor,
  insertEditorReference,
  composerBadgeSelection,
} from "../src/components/composer-tiptap";
import { createComposerEditor, composerMarkdown } from "../src/components/composer-document";

function headlessEditor(text: string) {
  const editor = new Editor({
    element: null,
    extensions: [...composerExtensions, attachmentNode, referenceNode, skillNode],
    content: readComposerDocument(text).toJSON(),
  });
  // Tiptap treats an unmounted editor as destroyed even though its transactions work headlessly.
  Object.defineProperty(editor, "isDestroyed", { get: () => false });
  return editor;
}

it("converts a keyboard-inserted reference at its replacement range and supports undo", () => {
  const editor = headlessEditor("before replace after");
  editor.registerPlugin(history());
  const url = "https://lilac.stw.tw/?ref=discord%3A1556290807915610183&range=first..last";
  expect(insertEditorReference(editor.view, 8, 15, url, "https://lilac.stw.tw")).toBe(true);
  expect(editor.state.doc.firstChild?.child(1).type.name).toBe("composer_reference");
  expect(editor.state.doc.firstChild?.child(1).attrs.url).toBe(
    "/?ref=discord%3A1556290807915610183&range=first..last",
  );
  expect(editor.state.selection.from).toBe(9);
  expect(composerText(editor.state.doc)).toContain("before ");
  expect(composerText(editor.state.doc)).toEndWith(" after");
  undo(editor.state, editor.view.dispatch);
  expect(composerText(editor.state.doc)).toBe("before replace after");
  editor.destroy();
});

it("leaves ordinary keyboard text and foreign-origin references unchanged", () => {
  const editor = headlessEditor("before after");
  for (const text of [
    "hello",
    "h",
    "https://example.com/?ref=discord%3Atest",
    "https://lilac.stw.tw/",
  ]) {
    expect(insertEditorReference(editor.view, 8, 8, text, "https://lilac.stw.tw")).toBe(false);
    expect(composerText(editor.state.doc)).toBe("before after");
  }
  editor.destroy();
});

it("keeps reference insertion selections valid after fitting the document", () => {
  const editor = headlessEditor("before\n\nafter");
  editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
  insertEditorReference(
    editor.view,
    0,
    editor.state.doc.content.size,
    "/?ref=discord%3Atest",
    "https://lilac.stw.tw",
  );
  expect(editor.state.selection.from).toBe(2);
  expect(editor.state.selection.$from.nodeBefore?.type.name).toBe("composer_reference");
  editor.destroy();

  const code = headlessEditor("```\nabc\n```");
  insertEditorReference(code.view, 2, 2, "/?ref=discord%3Atest", "https://lilac.stw.tw");
  expect(code.state.selection.$from.parent.inlineContent).toBe(true);
  expect(code.state.selection.$from.nodeBefore?.type.name).toBe("composer_reference");
  expect(code.state.selection.$from.nodeAfter?.text).toBe("bc");
  code.destroy();
});

it("preserves active marks when inserting a reference", () => {
  const editor = headlessEditor("**abc**");
  insertEditorReference(editor.view, 2, 2, "/?ref=discord%3Atest", "https://lilac.stw.tw");
  expect(editor.state.selection.$from.nodeBefore?.marks.map((mark) => mark.type.name)).toEqual([
    "bold",
  ]);
  editor.view.dispatch(editor.state.tr.insertText("next"));
  expect(editor.state.selection.$from.nodeBefore?.marks.map((mark) => mark.type.name)).toEqual([
    "bold",
  ]);
  editor.destroy();
});

it("leaves native mutation selections to ProseMirror's updated document", () => {
  const editor = headlessEditor("before");
  const transaction = editor.state.tr.insertText("x", 1);
  expect(composerBadgeSelection(editor.view, transaction.doc.resolve(2))).toBeNull();
  editor.destroy();
});

it("pastes copied message fragments inline at a tracked position", () => {
  const editor = headlessEditor("before after");
  editor.commands.setTextSelection(8);
  const paste = captureEditorPaste(editor);
  editor.view.dispatch(editor.state.tr.insertText("typed "));
  paste.insert("**middle** [file](attachment:key)");
  expect(writeComposerDocument(editor.state.doc)).toBe(
    "before typed **middle** [file](attachment:key)after",
  );
  expect(editor.state.doc.childCount).toBe(1);
  const cancelled = captureEditorPaste(editor);
  cancelled.cancel();
  cancelled.insert("discarded");
  expect(composerText(editor.state.doc)).not.toContain("discarded");
  editor.destroy();
});

it("completes a mention after a soft line break without deleting preceding text", () => {
  const editor = headlessEditor("hello\n$sk");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  expect(composerCompletionPrefix(editor)).toBe("hello\n$sk");
  completeEditor(editor, "$skill", 3);
  expect(writeComposerDocument(editor.state.doc)).toBe("hello\n$skill ");
  editor.destroy();
});

it("replaces the rest of a command argument token after the cursor", () => {
  const editor = headlessEditor("/tarot 3 single more");
  editor.commands.setTextSelection(12);
  expect(composerCompletionPrefix(editor)).toBe("/tarot 3 si");
  completeEditor(editor, "spread=single", 2, undefined, { after: 4 });
  expect(composerText(editor.state.doc)).toBe("/tarot 3 spread=single  more");
  completeEditor(editor, "mode=", 0, undefined, { space: false });
  expect(composerText(editor.state.doc)).toContain("spread=single mode= more");
  editor.destroy();
});

it("completes a skill as a badge that keeps its mention syntax", () => {
  const editor = headlessEditor("use $ag");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  completeEditor(editor, "$my_skill", 3, { id: "skill-1", name: "my_skill" });
  const badge = editor.state.doc.firstChild?.child(1);
  expect(badge?.type.name).toBe("composer_skill");
  expect(badge?.attrs).toMatchObject({ id: "skill-1", name: "my_skill" });
  expect(composerText(editor.state.doc)).toBe("use $my_skill ");
  expect(writeComposerDocument(editor.state.doc)).toBe("use $my\\_skill ");
  expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  editor.destroy();
});

it("restores badges only for exact selected skill mentions outside code", () => {
  const text =
    "$review /skill:review $reviewer $review-next `$review` **x**$review $Better Result, $a+b\n\n```\n$review\n```";
  const editor = headlessEditor(text);
  const before = writeComposerDocument(editor.state.doc);
  markEditorSkills(editor, [
    { id: "r", name: "review" },
    { id: "b", name: "Better Result" },
    { id: "a", name: "a+b" },
  ]);
  const badges: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composer_skill") badges.push(node.attrs.text);
  });
  expect(badges).toEqual(["$review", "/skill:review", "$Better Result", "$a+b"]);
  expect(editorSkillIds(editor.state.doc)).toEqual(["r", "b", "a"]);
  expect(writeComposerDocument(editor.state.doc)).toBe(before);
  editor.destroy();
});

it("preserves existing draft and submission syntax through the Tiptap document", () => {
  for (const text of [
    "",
    "first\n\n\nlast",
    "\nfirst",
    "first\n",
    "first\n\n",
    "**first**\n_last_",
    "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```",
    "* one\n  * nested\n* two",
    "#### Fourth\n\n##### Fifth\n\n###### Sixth",
    "* [x] done\n* [ ] pending\n  * [x] nested",
    "before\n\n---\n\nafter",
    "3. third\n4. fourth",
    "> first\n> next\n>\n> paragraph",
    "**注意：**粗體 ~~刪除：~~文字",
    "https://example.com/a_b?q=one&next=two",
    '[example](https://example.com/a_(b) "A title")',
    "Before [**label**](https://example.com) after",
    "[line\nbreak](https://example.com)",
    "Before \uE0000\uE000 [example](https://example.com) after",
    "$my_skill",
    "/fixture-status ",
    "Compare [my_\\[draft\\].txt](attachment:file) after",
    "[x](attachment:a) [x](attachment:b)",
    "[Discussion](/?ref=discord%3Achannel&range=first..last)",
    "[#native:thread](/?ref=native%3Athread&message=message)",
  ]) {
    const expected = composerMarkdown(createComposerEditor(text));
    const actual = writeComposerDocument(readComposerDocument(text));
    expect(actual).toBe(expected);
    expect(writeComposerDocument(readComposerDocument(actual))).toBe(actual);
    expect(actual).not.toContain("\uFEFF");
  }
});

it("keeps attachment identity and position through deletion and undo", () => {
  let state = EditorState.create({
    schema: composerSchema,
    doc: readComposerDocument(
      "**Before** [same.png](attachment:first) [same.png](attachment:second) after",
    ),
    plugins: [history()],
  });
  let position = 0;
  state.doc.descendants((node, pos) => {
    if (node.attrs.attachmentKey === "first") position = pos;
  });
  state = state.apply(state.tr.delete(position, position + 1));
  expect([...editorAttachmentKeys(state.doc)]).toEqual(["second"]);
  expect(writeComposerDocument(state.doc, false)).toBe("**Before**  same.png after");
  expect(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect([...editorAttachmentKeys(state.doc)]).toEqual(["first", "second"]);
  expect(writeComposerDocument(state.doc)).toBe(
    "**Before** [same.png](attachment:first) [same.png](attachment:second) after",
  );
});

it("clears text and chips with select all and restores a valid empty paragraph", () => {
  let state = EditorState.create({
    schema: composerSchema,
    doc: readComposerDocument("**Text** [file](attachment:key)\n\nlast"),
  });
  state = state.apply(state.tr.setSelection(new AllSelection(state.doc)).deleteSelection());
  expect(writeComposerDocument(state.doc)).toBe("");
  expect([...editorAttachmentKeys(state.doc)]).toEqual([]);
  expect(state.doc.firstChild?.type.name).toBe("paragraph");
  state = state.apply(state.tr.insertText("hello"));
  expect(composerText(state.doc)).toBe("hello");
});

it("inserts a pasted reference into an empty document without a leading space", () => {
  let state = EditorState.create({ schema: composerSchema, doc: readComposerDocument("") });
  state = state.apply(
    state.tr
      .setSelection(TextSelection.create(state.doc, 1))
      .replaceSelectionWith(
        composerSchema.nodes.composer_reference!.create({ url: "/?ref=native%3Athread" }),
      ),
  );
  expect(writeComposerDocument(state.doc)).toBe("[#native:thread](/?ref=native%3Athread)");
});
