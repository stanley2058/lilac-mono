import { referencedConversations } from "@stanley2058/lilac-client-protocol";
import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KEYS, NodeApi } from "platejs";
import { messageClipboard } from "../src/message-clipboard";
import ComposerEditor, {
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
  attachmentSize,
  restoreMessageAttachments,
  captureComposerPaste,
} from "../src/components/composer-editor";

it("preserves typed line breaks through send, copy, paste, and draft reload", () => {
  const lines = [
    "sounds about right where I wanted it to be.",
    "",
    "btw, the new sol and luna are so cheap, intelligence cheaper than water (whatever that means)",
    "https://simonwillison.net/2026/Sep/22/opus-and-sol-and-luna/",
  ];
  const text = lines.join("\n");
  const editor = createComposerEditor();
  editor.tf.select({ path: [0, 0], offset: 0 });
  for (const [index, line] of lines.entries()) {
    if (index) editor.tf.insertBreak();
    editor.tf.insertText(line);
  }
  expect(composerMarkdown(editor)).toBe(text);
  expect(composerSubmissionMarkdown(editor)).toBe(text);
  const copied = messageClipboard(composerSubmissionMarkdown(editor), []).text;
  expect(copied).toBe(text);
  const pasted = createComposerEditor();
  pasted.tf.select({ path: [0, 0], offset: 0 });
  captureComposerPaste(pasted).insert(copied);
  for (const restored of [createComposerEditor(text), pasted]) {
    expect(composerMarkdown(restored)).toBe(text);
    expect(restored.children.map((node) => NodeApi.string(node)).join("\n")).toBe(text);
  }
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
    expect(composerMarkdown(createComposerEditor(text))).toBe(text);
    expect(composerSubmissionMarkdown(createComposerEditor(text))).not.toContain("\u200b");
  }
});

it("round trips basic rich Markdown through draft text", () => {
  const markdown =
    "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```";
  const editor = createComposerEditor(markdown);
  const serialized = composerMarkdown(editor);
  expect(serialized).toBe(markdown);
  expect(composerMarkdown(createComposerEditor(serialized))).toBe(serialized);
  expect(editor.children[0]?.type).toBe(KEYS.h1);
  expect(editor.children[1]?.children[0]).toMatchObject({ text: "bold", bold: true });
  expect(editor.children[2]).toMatchObject({ listStyleType: "disc" });
  expect(editor.children.at(-1)).toMatchObject({ type: KEYS.codeBlock, lang: "ts" });
});

it("round trips CJK emphasis that closes after full-width punctuation", () => {
  const markdown = "**注意：**粗體 ~~刪除：~~文字";
  const editor = createComposerEditor(markdown);
  expect(editor.children[0]?.children).toMatchObject([
    { text: "注意：", bold: true },
    { text: "粗體 " },
    { text: "刪除：", strikethrough: true },
    { text: "文字" },
  ]);
  expect(composerSubmissionMarkdown(editor)).toBe(markdown);
  expect(restoreMessageAttachments(markdown, new Map())).toBe(markdown);
});

it("inserts a completion at the selected rich-text range without flattening marks or suffixes", () => {
  const editor = createComposerEditor("**Keep** $Rev later");
  editor.tf.select({ path: [0, 1], offset: 5 });
  expect(composerPrefix(editor)).toBe("Keep $Rev");
  insertComposerCompletion(editor, "$Review", 4);
  expect(composerMarkdown(editor)).toBe("**Keep** $Review  later");
  expect(editor.children[0]?.children[0]).toMatchObject({ bold: true, text: "Keep" });
});

it("keeps URLs and Markdown links editable and preserves their syntax through reload and send", () => {
  for (const text of [
    "https://example.com/a_b?q=one&next=two",
    "[example.com](https://example.com)",
    '[example](https://example.com/a_(b) "A title")',
    "Before [**label**](https://example.com) after",
    "[https://example.com](https://example.com)",
    "[line\nbreak](https://example.com)",
    "Before \uE0000\uE000 [example](https://example.com) after",
  ]) {
    const editor = createComposerEditor(text);
    expect(NodeApi.string(editor)).toBe(text);
    expect([...editor.api.nodes({ at: [], match: { type: KEYS.a } })]).toHaveLength(0);
    expect(composerMarkdown(editor)).toBe(text);
    expect(composerSubmissionMarkdown(editor)).toBe(text);
    expect(NodeApi.string(createComposerEditor(composerMarkdown(editor)))).toBe(text);
  }
});

it("preserves attachment chips whose filenames contain Markdown links", () => {
  const editor = createComposerEditor();
  insertComposerAttachment(editor, {
    key: "file-key",
    file: new File(["contents"], "[x](a).txt"),
  });
  const markdown = composerMarkdown(editor);
  const restored = createComposerEditor(markdown);
  expect([...restored.api.nodes({ at: [], match: { type: "composer_attachment" } })]).toHaveLength(
    1,
  );
  expect(composerMarkdown(restored)).toBe(markdown);
  expect(composerSubmissionMarkdown(restored)).toBe("[x](a).txt ");
});

it("does not linkify typed URLs or Markdown links and allows editing the destination", () => {
  const editor = createComposerEditor();
  editor.tf.select(editor.api.end([])!);
  for (const character of "[example](https://example.com) https://example.com ")
    editor.tf.insertText(character);
  expect([...editor.api.nodes({ at: [], match: { type: KEYS.a } })]).toHaveLength(0);
  expect(composerMarkdown(editor)).toBe("[example](https://example.com) https://example.com ");
  const text = NodeApi.string(editor);
  const offset = text.indexOf("example.com");
  editor.tf.select({
    anchor: { path: [0, 0], offset },
    focus: { path: [0, 0], offset: offset + "example.com".length },
  });
  editor.tf.insertText("changed.example");
  expect(composerSubmissionMarkdown(editor)).toBe(
    "[example](https://changed.example) https://example.com ",
  );
});

it("preserves command separators and trailing spaces through completion and draft restore", () => {
  const editor = createComposerEditor("/fi");
  editor.tf.select(editor.api.end([])!);
  insertComposerCompletion(editor, "/fixture-status", 3);
  expect(composerMarkdown(editor)).toBe("/fixture-status ");
  const restored = createComposerEditor(composerMarkdown(editor));
  expect(NodeApi.string(restored)).toBe("/fixture-status ");
  expect(composerMarkdown(restored)).toBe("/fixture-status ");
});

it("does not offer completion for a range or code-block content", () => {
  const editor = createComposerEditor("```\n$review\n```");
  editor.tf.select(editor.api.end([])!);
  expect(composerPrefix(editor)).toBe("");
  const prose = createComposerEditor("$review");
  prose.tf.select({ anchor: prose.api.start([])!, focus: prose.api.end([])! });
  expect(composerPrefix(prose)).toBe("");
});

it("keeps completion identities and custom arguments independent of Markdown escaping", () => {
  const skill = createComposerEditor("$my_skill");
  expect(composerMarkdown(skill)).toBe("$my\\_skill");
  expect(composerPlainText(skill)).toBe("$my_skill");
  const slashSkill = createComposerEditor("/skill:my_skill next");
  expect(composerPlainText(slashSkill)).toBe("/skill:my_skill next");
  const command = createComposerEditor("/my_command argument_with_underscores");
  expect(composerPlainText(command)).toBe("/my_command argument_with_underscores");
  expect(composerPlainText(createComposerEditor(composerMarkdown(command)))).toBe(
    "/my_command argument_with_underscores",
  );
});

it("keeps an empty or cleared editor empty on the wire", () => {
  const editor = createComposerEditor();
  expect(composerMarkdown(editor)).toBe("");
  expect(composerPlainText(editor)).toBe("");
  editor.tf.insertText("test");
  editor.tf.select({ anchor: editor.api.start([])!, focus: editor.api.end([])! });
  editor.tf.delete();
  expect(composerMarkdown(editor)).toBe("");
});

it("keeps multiline editor semantics while announcing completion options", () => {
  const noop = () => {};
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      createElement(ComposerEditor, {
        text: "$review",
        disabled: false,
        placeholder: "Message",
        onText: noop,
        onPlainText: noop,
        onPrefix: noop,
        onKeyDown: noop,
        onPaste: noop,
        expanded,
        activeDescendant: expanded ? "completion-0" : undefined,
      }),
    );
  const expanded = render(true);
  expect(expanded).toContain('role="textbox" aria-multiline="true"');
  expect(expanded).toContain('aria-autocomplete="list"');
  expect(expanded).toContain('aria-controls="composer-completions"');
  expect(expanded).toContain('aria-activedescendant="completion-0"');
  expect(expanded).not.toContain('aria-expanded="true"');
  const closed = render(false);
  expect(closed).not.toContain('aria-controls="composer-completions"');
  expect(closed).not.toContain('aria-activedescendant="completion-0"');
});

it("inserts a file reference at the caret and restores its position without flattening Markdown", () => {
  const editor = createComposerEditor("**Compare**  with the earlier image");
  editor.tf.select({ path: [0, 1], offset: 1 });
  insertComposerAttachment(editor, {
    key: "image-one",
    file: new File(["image"], "screen.png", { type: "image/png" }),
  });
  expect(composerMarkdown(editor)).toBe(
    "**Compare** [screen.png](attachment:image-one)  with the earlier image",
  );
  const restored = createComposerEditor(composerMarkdown(editor));
  expect(composerMarkdown(restored)).toBe(composerMarkdown(editor));
  expect(composerPlainText(restored)).toBe("Compare screen.png  with the earlier image");
  expect(composerSubmissionMarkdown(restored)).toBe(
    "**Compare** screen.png  with the earlier image",
  );
});

it("remaps only file references when a local draft moves to a server thread", () => {
  const markdown =
    "See [notes.txt](attachment:old-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```";
  const remapped = remapComposerAttachments(markdown, new Map([["old-key", "new-key"]]));
  expect(remapped).toBe(
    "See [notes.txt](attachment:new-key) and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
  expect(composerSubmissionMarkdown(createComposerEditor(remapped))).toBe(
    "See notes.txt and `attachment:old-key`.\n\n```md\n[notes.txt](attachment:old-key)\n```",
  );
});

it("keeps attachment-only drafts sendable and handles Markdown characters in filenames", () => {
  const editor = createComposerEditor();
  insertComposerAttachment(editor, { key: "special-file", file: new File([""], "my_[draft].txt") });
  const markdown = composerMarkdown(editor);
  const restored = createComposerEditor(markdown);
  expect(composerPlainText(restored)).toBe("my_[draft].txt ");
  expect(composerSubmissionMarkdown(restored)).not.toContain("attachment:");
  expect(markdown).not.toContain("\u200b");
  expect(composerSubmissionMarkdown(restored)).not.toContain("\u200b");
  expect(composerMarkdown(restored)).toBe(markdown);
});

it("renders inline thumbnails, file size and accessible remove and retry controls", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(ComposerEditor, {
      text: "Review [image.png](attachment:image)",
      attachments: [
        {
          key: "image",
          file: new File([new Uint8Array(1536)], "image.png", { type: "image/png" }),
          preview: "blob:preview",
          reservation: Promise.resolve(undefined),
          progress: 0,
          state: "failed",
          error: "Upload failed",
        },
      ],
      disabled: false,
      placeholder: "Message",
      onText: noop,
      onPlainText: noop,
      onPrefix: noop,
      onKeyDown: noop,
      onPaste: noop,
      expanded: false,
    }),
  );
  expect(html).toContain('data-ui="composer-attachment-chip"');
  expect(html).toContain('src="blob:preview"');
  expect(html).toContain("2 KB");
  expect(html).toContain('aria-label="Remove image.png"');
  expect(html).toContain('aria-label="Retry image.png"');
  expect(html).not.toContain('title="Upload failed"');
  expect(html).toContain('data-slot="tooltip-trigger"');
  expect(attachmentSize(512)).toBe("512 B");
  expect(attachmentSize(1572864)).toBe("1.5 MB");
});

it("separates an inserted file name from adjacent prose", () => {
  const editor = createComposerEditor("Review");
  editor.tf.select(editor.api.end([])!);
  insertComposerAttachment(editor, { key: "file", file: new File(["text"], "notes.txt") });
  expect(composerSubmissionMarkdown(editor)).toBe("Review notes.txt ");
});

it("resolves duplicate file names by their attachment identities and leaves code literal", () => {
  const source =
    "First [same.png](attachment:first), then [same.png](attachment:second). `literal [same.png](attachment:first)`";
  const sent = resolveComposerAttachments(
    source,
    new Map([
      ["first", "upload-one"],
      ["second", "upload-two"],
    ]),
  );
  expect(sent).toBe(
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
  const editor = createComposerEditor("First draft");
  editor.tf.select(editor.api.end([])!);
  editor.tf.insertText(" edited");
  editor.marks = { bold: true };
  expect(editor.history.undos.length).toBeGreaterThan(0);
  const firstDraft = composerMarkdown(editor);
  const secondDraft = "**Second draft** [notes.txt](attachment:second-file)";
  replaceComposerDocument(editor, secondDraft);
  expect(composerMarkdown(editor)).toBe(secondDraft);
  expect(editor.selection).toBeNull();
  expect(editor.marks).toBeNull();
  expect(editor.history).toEqual({ undos: [], redos: [] });
  editor.tf.undo();
  expect(composerMarkdown(editor)).toBe(secondDraft);
  replaceComposerDocument(editor, firstDraft);
  expect(composerMarkdown(editor)).toBe("First draft edited");
});

it("resets history even when two threads have identical draft text", () => {
  const editor = createComposerEditor("Shared text");
  editor.tf.select(editor.api.end([])!);
  editor.tf.insertText("!");
  const document = editor.children;
  replaceComposerDocument(editor, "Shared text!");
  expect(editor.children).toBe(document);
  editor.tf.undo();
  expect(composerMarkdown(editor)).toBe("Shared text!");
  expect(editor.history.undos).toHaveLength(0);
});

it("keeps the empty document nodes when switching between empty drafts", () => {
  const editor = createComposerEditor();
  const paragraph = editor.children[0];
  replaceComposerDocument(editor, "");
  expect(editor.children[0]).toBe(paragraph);
  expect(composerMarkdown(editor)).toBe("");
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
  expect(text).toContain("`/api/resources/original`");
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

it("keeps an asynchronous paste range current and releases it on insertion or cancellation", () => {
  const editor = createComposerEditor("before after");
  editor.tf.select({ path: [0, 0], offset: 7 });
  const target = captureComposerPaste(editor);
  editor.tf.insertText("prefix ", { at: { path: [0, 0], offset: 0 } });
  target.insert("**pasted** ");
  expect(composerMarkdown(editor)).toBe("prefix before **pasted** after");
  expect(editor.api.rangeRefs().size).toBe(0);
  const canceled = captureComposerPaste(editor);
  canceled.cancel();
  canceled.insert("must not appear");
  expect(composerMarkdown(editor)).not.toContain("must not appear");
  expect(editor.api.rangeRefs().size).toBe(0);
});

it("preserves conversation reference chips through drafts, send, edit and paste", () => {
  const markdown = "[#native:thread](/?ref=native%3Athread&message=message)";
  const editor = createComposerEditor(markdown);
  expect([...editor.api.nodes({ at: [], match: { type: "composer_reference" } })]).toHaveLength(1);
  expect(composerPlainText(editor)).not.toBe("");
  const sent = composerSubmissionMarkdown(editor);
  expect(referencedConversations(sent)).toEqual([
    { surface: "native", sessionId: "thread", messageId: "message" },
  ]);
  expect(composerMarkdown(createComposerEditor(sent))).toBe(sent);
  expect(resolveComposerAttachments(sent, new Map())).toBe(sent);
  const pasted = createComposerEditor("Before ");
  captureComposerPaste(pasted).insert(sent);
  expect(referencedConversations(composerMarkdown(pasted))).toEqual(referencedConversations(sent));
});

it("preserves inclusive range references through composer paste and submission", () => {
  const markdown = "[Discussion](/?ref=discord%3Achannel&range=first..last)";
  const editor = createComposerEditor("Before ");
  captureComposerPaste(editor).insert(markdown);
  const sent = composerSubmissionMarkdown(editor);
  expect(referencedConversations(sent)).toEqual([
    {
      surface: "discord",
      sessionId: "channel",
      range: { startMessageId: "first", endMessageId: "last" },
    },
  ]);
  expect(composerSubmissionMarkdown(createComposerEditor(sent))).toBe(sent);
});
