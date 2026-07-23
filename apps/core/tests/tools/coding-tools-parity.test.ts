import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import {
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  LEVEL1_TOOL_NAMES,
  applyPatchInputSchema as sharedApplyPatchInputSchema,
  bashInputSchema as sharedBashInputSchema,
  editFileInputSchema as sharedEditFileInputSchema,
  fuzzySearchInputSchema as sharedFuzzySearchInputSchema,
  globInputSchema as sharedGlobInputSchema,
  grepInputSchema as sharedGrepInputSchema,
  readFileInputSchema as sharedReadFileInputSchema,
  subagentDelegateBaseInputSchema as sharedSubagentDelegateBaseInputSchema,
  subagentDelegateOutputSchema as sharedSubagentDelegateOutputSchema,
} from "@stanley2058/lilac-coding-tools/schemas";
import {
  applyPatch as applySharedPatch,
  parsePatch as parseSharedPatch,
} from "@stanley2058/lilac-coding-tools/apply-patch";

import { createLocalToolSpecs } from "../../src/plugins/builtin/local-tools";
import { applyPatchInputSchema } from "../../src/tools/apply-patch";
import { applyHunks } from "../../src/tools/apply-patch/apply-patch-core";
import { bashInputSchema } from "../../src/tools/bash";
import {
  editFileInputZod,
  fuzzySearchInputZod,
  globInputZod,
  grepInputZod,
  readFileInputZod,
} from "../../src/tools/fs/fs";
import {
  subagentDelegateBaseInputSchema,
  subagentDelegateOutputSchema,
} from "../../src/tools/subagent";

describe("Core coding-tools parity", () => {
  it("keeps the complete built-in Level-1 registry aligned", () => {
    expect(createLocalToolSpecs().map((spec) => spec.name)).toEqual([...LEVEL1_TOOL_NAMES]);
  });

  it("uses package-owned baseline input schemas", () => {
    expect(bashInputSchema).toBe(sharedBashInputSchema);
    expect(readFileInputZod).toBe(sharedReadFileInputSchema);
    expect(globInputZod).toBe(sharedGlobInputSchema);
    expect(grepInputZod).toBe(sharedGrepInputSchema);
    expect(fuzzySearchInputZod).toBe(sharedFuzzySearchInputSchema);
    expect(editFileInputZod).toBe(sharedEditFileInputSchema);
    expect(applyPatchInputSchema).toBe(sharedApplyPatchInputSchema);
    expect(subagentDelegateBaseInputSchema).toBe(sharedSubagentDelegateBaseInputSchema);
    expect(subagentDelegateOutputSchema).toBe(sharedSubagentDelegateOutputSchema);
  });

  it("retains representative Core contract fields in shared schemas", () => {
    expect(
      bashInputSchema.safeParse({
        command: "pwd",
        cwd: "host:/repo",
        stdinMode: "error",
        dangerouslyAllow: true,
      }).success,
    ).toBe(true);
    expect(
      readFileInputZod.safeParse({
        path: "src/index.ts",
        cwd: "host:/repo",
        start: { type: "line", line: 1, column: 0 },
        maxCharacters: 40 * 1024,
      }).success,
    ).toBe(true);
    expect(
      applyPatchInputSchema.safeParse({
        patchText: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch",
        cwd: "host:/repo",
      }).success,
    ).toBe(true);

    const hashlineRead = createReadFileInputSchema({ hashlineEnabled: true });
    const hashlineGrep = createGrepInputSchema(true);
    const hashlineEdit = createEditFileInputSchema(true);
    expect(hashlineRead.safeParse({ path: "src/index.ts", format: "hashline" }).success).toBe(true);
    expect(hashlineGrep.safeParse({ pattern: "needle", mode: "hashline" }).success).toBe(true);
    expect(
      hashlineEdit.safeParse({
        path: "src/index.ts",
        cwd: "host:/repo",
        edits: [{ op: "replace", pos: "1#abcd", lines: ["replacement"] }],
      }).success,
    ).toBe(true);
    expect(
      createEditFileInputSchema(false).safeParse({
        path: "src/index.ts",
        edits: [{ op: "replace", pos: "1#abcd" }],
      }).success,
    ).toBe(false);
  });

  it("keeps package and Core patch execution aligned for trailing empty old lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lilac-patch-parity-"));
    const coreDir = path.join(root, "core");
    const sharedDir = path.join(root, "shared");
    const patchText = [
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      "-target",
      "-",
      "+changed",
      "*** End Patch",
    ].join("\n");

    try {
      await mkdir(coreDir);
      await mkdir(sharedDir);
      await writeFile(path.join(coreDir, "file.txt"), "target\n");
      await writeFile(path.join(sharedDir, "file.txt"), "target\n");
      await applyHunks(coreDir, parseSharedPatch(patchText));
      await applySharedPatch({ cwd: sharedDir, patchText, denyPaths: [] });
      expect(await readFile(path.join(coreDir, "file.txt"), "utf8")).toBe("changed\n");
      expect(await readFile(path.join(sharedDir, "file.txt"), "utf8")).toBe("changed\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
