import { describe, expect, it } from "bun:test";

import { CodeRenderable, MarkdownRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { MockTreeSitterClient } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

import { createMarkdownSyntaxStyle } from "./theme";

function codeBlocks(renderable: Renderable): CodeRenderable[] {
  const matches = renderable instanceof CodeRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    matches.push(...codeBlocks(child));
  }
  return matches;
}

describe("OpenTUI Markdown completion patch", () => {
  it("finalizes tables without rebuilding unchanged prose and code blocks", async () => {
    const syntaxStyle = createMarkdownSyntaxStyle();
    const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 });
    let finish = () => {};
    const app = await testRender(
      () => {
        const [streaming, setStreaming] = createSignal(true);
        finish = () => setStreaming(false);
        return (
          <markdown
            id="completion-markdown"
            width="100%"
            content={
              "Paragraph\n\n```text\nconst value = 1;\n```\n\n- Item\n\n  ```text\n  const nested = 2;\n  ```\n\n| A | B |\n| - | - |\n| 1 | 2 |"
            }
            syntaxStyle={syntaxStyle}
            treeSitterClient={treeSitterClient}
            streaming={streaming()}
            internalBlockMode="top-level"
          />
        );
      },
      { width: 80, height: 20 },
    );
    try {
      await app.flush();
      const markdown = app.renderer.root.findDescendantById("completion-markdown");
      if (!(markdown instanceof MarkdownRenderable)) throw new Error("Markdown renderable missing");
      const prose = markdown._blockStates.find(
        (state) => state.token.type === "paragraph",
      )?.renderable;
      const code = markdown._blockStates.find((state) => state.token.type === "code")?.renderable;
      const list = markdown._blockStates.find((state) => state.token.type === "list")?.renderable;
      const table = markdown._blockStates.find((state) => state.token.type === "table")?.renderable;
      expect(prose).toBeDefined();
      if (!(code instanceof CodeRenderable)) throw new Error("Code renderable missing");
      if (list === undefined) throw new Error("List renderable missing");
      const nestedCode = codeBlocks(list).find((candidate) => candidate.content.includes("nested"));
      if (nestedCode === undefined) throw new Error("Nested code renderable missing");
      expect(table).toBeDefined();

      finish();
      await app.flush();

      expect(markdown.streaming).toBe(false);
      expect(
        markdown._blockStates.find((state) => state.token.type === "paragraph")?.renderable,
      ).toBe(prose);
      expect(markdown._blockStates.find((state) => state.token.type === "code")?.renderable).toBe(
        code,
      );
      expect(code.streaming).toBe(false);
      expect(
        codeBlocks(
          markdown._blockStates.find((state) => state.token.type === "list")?.renderable ?? list,
        ).find((candidate) => candidate.content.includes("nested")),
      ).toBe(nestedCode);
      expect(nestedCode.streaming).toBe(false);
      expect(
        markdown._blockStates.find((state) => state.token.type === "table")?.renderable,
      ).not.toBe(table);
      await app.waitForVisualIdle();
    } finally {
      await Promise.all(
        codeBlocks(app.renderer.root).map((codeBlock) => codeBlock.highlightingDone),
      );
      app.renderer.destroy();
      await treeSitterClient.destroy();
      syntaxStyle.destroy();
    }
  });

  it("keeps custom coalesced table rendering during finalization", async () => {
    const syntaxStyle = createMarkdownSyntaxStyle();
    const app = await testRender(() => <box />, { width: 80, height: 20 });
    const markdown = new MarkdownRenderable(app.renderer, {
      id: "custom-table-markdown",
      width: "100%",
      content: "Paragraph\n\n| A | B |\n| - | - |\n| 1 | 2 |",
      syntaxStyle,
      streaming: true,
      renderNode: (token) =>
        token.type === "paragraph"
          ? new TextRenderable(app.renderer, { content: "CUSTOM PARAGRAPH" })
          : token.type === "table"
            ? new TextRenderable(app.renderer, { content: "CUSTOM TABLE" })
            : undefined,
    });
    app.renderer.root.add(markdown);
    try {
      await app.flush();
      const customParagraph = markdown._blockStates.find(
        (state) => state.token.type === "paragraph",
      )?.renderable;
      expect(customParagraph).toBeInstanceOf(TextRenderable);
      expect(
        markdown._blockStates.find((state) => state.token.type === "table")?.renderable,
      ).toBeInstanceOf(TextRenderable);

      markdown.streaming = false;
      await app.flush();

      expect(
        markdown._blockStates.find((state) => state.token.type === "paragraph")?.renderable,
      ).toBe(customParagraph);
      const finalized = markdown._blockStates.find(
        (state) => state.token.type === "table",
      )?.renderable;
      expect(finalized).toBeInstanceOf(TextRenderable);
      if (!(finalized instanceof TextRenderable)) throw new Error("Custom table was discarded");
      expect(finalized.content.chunks.map((chunk) => chunk.text).join("")).toBe("CUSTOM TABLE");
    } finally {
      app.renderer.destroy();
      syntaxStyle.destroy();
    }
  });
});
