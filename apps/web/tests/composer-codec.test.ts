import { describe, expect, test } from "bun:test";
import golden from "./fixtures/composer-codec-golden.json";
import { codecResults } from "./fixtures/composer-codec-golden.gen";
import { markdownCorpus } from "./fixtures/composer-codec-corpus";
import { readComposerDocument, writeComposerDocument } from "../src/components/composer-tiptap";

/**
 * The golden file holds what the Plate codec wrote before the port to mdast. These inputs differ on
 * purpose: Plate dropped images, reference links, and footnotes, and the port keeps their source.
 */
const keptAsSource: Record<string, string> = {
  "[ref][1]\n\n[1]: https://x.example": "\\[ref]\\[1]\n\n[1]: https://x.example",
  "![alt](https://x.example/y.png)": "![alt](https://x.example/y.png)",
  "Text ![img](https://x.example/u.png) more": "Text ![img](https://x.example/u.png) more",
  "Footnote[^1]\n\n[^1]: the note": "Footnote\\[^1]\n\n\\[^1]: the note",
  "![other](https://example.com/x.png) and ![notes](/api/resources/original)":
    "![other](https://example.com/x.png) and [notes.md](attachment:new-key)",
};

const current = codecResults();

describe("composer Markdown codec", () => {
  test.each(golden.markdown.map((expected, index) => [expected.input, expected, index] as const))(
    "reads and writes %j as the Plate codec did",
    (input, expected, index) => {
      const actual = current.markdown[index]!;
      if (input in keptAsSource) {
        expect(actual.draft).toBe(keptAsSource[input]!);
        return;
      }
      expect(actual).toEqual(expected);
    },
  );

  test.each(golden.documents.map((expected, index) => [expected.name, expected, index] as const))(
    "writes the %s document as the Plate codec did",
    (_name, expected, index) => {
      expect(current.documents[index]).toEqual(expected);
    },
  );

  test("resolves, remaps, and restores file references as the Plate codec did", () => {
    expect(current.resolve).toEqual(golden.resolve);
    expect(current.remap).toEqual(golden.remap);
    for (const [index, expected] of golden.restore.entries()) {
      const actual = current.restore[index]!;
      if (expected.input in keptAsSource) expect(actual.output).toBe(keptAsSource[expected.input]!);
      else expect(actual).toEqual(expected);
    }
  });

  test("a written draft reads back to the same Markdown", () => {
    for (const input of markdownCorpus) {
      const draft = writeComposerDocument(readComposerDocument(input));
      expect(writeComposerDocument(readComposerDocument(draft))).toBe(draft);
    }
  });
});
