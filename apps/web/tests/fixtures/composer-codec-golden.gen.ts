// Writes composer-codec-golden.json from the codec in src. The checked-in file was recorded from the
// Plate codec before the port to mdast; rerun this only to record an intended change.
import path from "node:path";
import type { JSONContent } from "@tiptap/core";
import {
  composerSchema,
  composerText,
  readComposerDocument,
  writeComposerDocument,
} from "../../src/components/composer-tiptap";
import {
  remapComposerAttachments,
  resolveComposerAttachments,
  restoreMessageAttachments,
} from "../../src/components/composer-editor";
import { attachmentCorpus, documentCorpus, markdownCorpus } from "./composer-codec-corpus";

const notes = {
  key: "new-key",
  file: new File(["notes"], "notes.md", { type: "text/markdown" }),
  state: "ready" as const,
  progress: 1,
  reservation: Promise.resolve("new-resource"),
};

/** Citation keys are random per read, so the golden file leaves them out. */
export function stableJSON(value: JSONContent): JSONContent {
  return JSON.parse(
    JSON.stringify(value, (key, field) => (key === "citationKey" ? undefined : field)),
  );
}

export function codecResults() {
  return {
    markdown: markdownCorpus.map((input) => {
      const doc = readComposerDocument(input);
      return {
        input,
        read: stableJSON(doc.toJSON()),
        draft: writeComposerDocument(doc),
        submission: writeComposerDocument(doc, false),
        text: composerText(doc),
      };
    }),
    documents: documentCorpus.map(({ name, doc: json }) => {
      const doc = composerSchema.nodeFromJSON(json);
      const draft = writeComposerDocument(doc);
      return {
        name,
        draft,
        submission: writeComposerDocument(doc, false),
        text: composerText(doc),
        reread: writeComposerDocument(readComposerDocument(draft)),
      };
    }),
    resolve: attachmentCorpus.resolve.map((input) => ({
      input,
      output: resolveComposerAttachments(
        input,
        new Map([
          ["first", "upload-one"],
          ["second", "upload-two"],
          ["known", "id/with space"],
          ["upload-key", "reserved-id"],
        ]),
      ),
    })),
    remap: attachmentCorpus.remap.map((input) => ({
      input,
      output: remapComposerAttachments(
        input,
        new Map([
          ["old-key", "new-key"],
          ["local-key", "upload-key"],
        ]),
      ),
    })),
    restore: attachmentCorpus.restore.map((input) => ({
      input,
      output: restoreMessageAttachments(input, new Map([["original", notes]])),
    })),
  };
}

if (import.meta.main)
  await Bun.write(
    path.join(import.meta.dir, "composer-codec-golden.json"),
    `${JSON.stringify(codecResults(), null, 2)}\n`,
  );
