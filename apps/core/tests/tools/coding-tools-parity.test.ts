import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import {
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  LEVEL1_TOOL_NAMES,
  applyPatchInputSchema,
  bashInputSchema as sharedBashInputSchema,
  editFileInputSchema as sharedEditFileInputSchema,
  fuzzySearchInputSchema as sharedFuzzySearchInputSchema,
  globInputSchema as sharedGlobInputSchema,
  grepInputSchema as sharedGrepInputSchema,
  readFileInputSchema as sharedReadFileInputSchema,
} from "@stanley2058/lilac-coding-tools/schemas";
import {
  applyPatchResult as applySharedPatch,
  parsePatchResult as parseSharedPatch,
} from "@stanley2058/lilac-coding-tools/apply-patch";

import { BUILTIN_LEVEL1_TOOLS, createLocalToolSpecs } from "../../src/plugins/builtin/local-tools";
import { applyHunks } from "../../src/tools/apply-patch/apply-patch-core";
import { bashInputSchema } from "../../src/tools/bash";
import {
  editFileInputZod,
  fuzzySearchInputZod,
  globInputZod,
  grepInputZod,
  readFileInputZod,
} from "../../src/tools/fs/fs";

describe("Core coding-tools parity", () => {
  it("keeps the complete built-in Level-1 registry aligned", () => {
    expect(Object.keys(BUILTIN_LEVEL1_TOOLS)).toEqual([...LEVEL1_TOOL_NAMES]);
    for (const name of LEVEL1_TOOL_NAMES) {
      expect(BUILTIN_LEVEL1_TOOLS[name].name).toBe(name);
      expect(BUILTIN_LEVEL1_TOOLS[name].formatArgs).toBeFunction();
      expect(BUILTIN_LEVEL1_TOOLS[name].summarizeFailure).toBeFunction();
    }
    expect(createLocalToolSpecs().map((spec) => spec.name)).toEqual([...LEVEL1_TOOL_NAMES]);
  });

  it("accepts legacy and hashline edit targets and honors child cwd overrides", async () => {
    const editTargets = BUILTIN_LEVEL1_TOOLS.edit.editTargets;
    const applyPatchTargets = BUILTIN_LEVEL1_TOOLS.patch.editTargets;
    if (!editTargets || !applyPatchTargets)
      throw new Error("missing built-in edit target metadata");

    expect([
      ...(await editTargets(
        {
          path: "src/edit.ts",
          edits: [{ op: "replace", pos: "1#abcd", lines: ["replacement"] }],
          cwd: "/override/edit",
        },
        { cwd: "/default" },
      )),
    ]).toEqual(["file:///override/edit/src/edit.ts"]);
    expect([
      ...(await editTargets(
        {
          path: "src/legacy.ts",
          oldText: "before",
          newText: "after",
          cwd: "host:/override",
        },
        { cwd: "/default" },
      )),
    ]).toEqual(["ssh://host/override/src/legacy.ts"]);
    expect([
      ...(await applyPatchTargets(
        {
          patchText: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch",
          cwd: "/override/patch",
        },
        { cwd: "/default" },
      )),
    ]).toEqual(["file:///override/patch/src/old.ts"]);
  });

  it("uses package-owned baseline input schemas", () => {
    expect(bashInputSchema).toBe(sharedBashInputSchema);
    expect(readFileInputZod).toBe(sharedReadFileInputSchema);
    expect(globInputZod).toBe(sharedGlobInputSchema);
    expect(grepInputZod).toBe(sharedGrepInputSchema);
    expect(fuzzySearchInputZod).toBe(sharedFuzzySearchInputSchema);
    expect(editFileInputZod).toBe(sharedEditFileInputSchema);
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
    expect(hashlineGrep.safeParse({ pattern: "needle", path: "host:/repo" }).success).toBe(true);
    expect(hashlineGrep.safeParse({ pattern: "needle", cwd: "host:/repo" }).success).toBe(false);
    expect(grepInputZod.safeParse({ pattern: "needle", includeContextLines: 1 }).success).toBe(
      false,
    );
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
      await applyHunks(coreDir, parseSharedPatch(patchText).unwrap());
      (await applySharedPatch({ cwd: sharedDir, patchText, denyPaths: [] })).unwrap();
      expect(await readFile(path.join(coreDir, "file.txt"), "utf8")).toBe("changed\n");
      expect(await readFile(path.join(sharedDir, "file.txt"), "utf8")).toBe("changed\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
