import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigFiles, diffConfigText } from "../../src/runtime/config-files";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const CORE =
  "# Lilac\nconfigVersion: 3\nagent:\n  # depth comment\n  subagents:\n    maxDepth: 1\n";

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-files-"));
  dirs.push(dataDir);
  await fs.writeFile(path.join(dataDir, "core-config.yaml"), CORE);
  return { dataDir, files: new ConfigFiles({ dataDir }) };
}

function errorOf<T>(result: {
  match: (h: {
    ok: (v: T) => string;
    err: (e: { code: string; message: string }) => string;
  }) => string;
}) {
  return result.match({ ok: () => "ok", err: (error) => `${error.code}: ${error.message}` });
}

describe("config file patching", () => {
  it("writes a comment-preserving patch and returns the new revision and diff", async () => {
    const { files, dataDir } = await fixture();
    const outcome = (
      await files.patch({
        kind: "core",
        operations: [{ op: "set", path: ["agent", "subagents", "maxDepth"], value: 2 }],
      })
    ).unwrap();
    const text = await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8");
    expect(text).toContain("# depth comment");
    expect(text).toContain("maxDepth: 2");
    expect(outcome.written).toBe(true);
    expect(outcome.document.revision).toBe((await files.read("core")).unwrap().revision);
    expect(outcome.diff).toContain("-    maxDepth: 1");
    expect(outcome.diff).toContain("+    maxDepth: 2");
    expect(outcome.restartPaths).toEqual([]);
  });

  it("dry runs without writing", async () => {
    const { files, dataDir } = await fixture();
    const outcome = (
      await files.patch({
        kind: "core",
        dryRun: true,
        operations: [{ op: "unset", path: ["agent", "subagents", "maxDepth"] }],
      })
    ).unwrap();
    expect(outcome.written).toBe(false);
    expect(outcome.changed).toBe(true);
    expect(outcome.diff).toContain("-    maxDepth: 1");
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toBe(CORE);
  });

  it("rejects a stale expected revision with the current revision", async () => {
    const { files } = await fixture();
    const current = (await files.read("core")).unwrap();
    const result = await files.patch({
      kind: "core",
      expectedRevision: "stale",
      operations: [{ op: "set", path: ["agent", "subagents", "maxDepth"], value: 3 }],
    });
    expect(errorOf(result)).toStartWith("conflict:");
    expect(result.match({ ok: () => "", err: (error) => error.currentRevision ?? "" })).toBe(
      current.revision,
    );
  });

  it("rejects a result that fails validation and leaves the file unchanged", async () => {
    const { files, dataDir } = await fixture();
    const result = await files.patch({
      kind: "core",
      operations: [{ op: "set", path: ["surface", "native", "port"], value: -1 }],
    });
    expect(errorOf(result)).toStartWith("invalid:");
    expect(errorOf(result)).toContain("port");
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toBe(CORE);
  });

  it("names the nearest valid parent for an unknown path", async () => {
    const { files } = await fixture();
    const result = await files.patch({
      kind: "core",
      operations: [{ op: "set", path: ["agent", "subagents", "maxDepht"], value: 3 }],
    });
    expect(errorOf(result)).toContain("Unknown core-config.yaml path agent.subagents.maxDepht");
    expect(errorOf(result)).toContain("Nearest valid parent: agent.subagents.");
    expect(errorOf(result)).toContain("maxDepth");
  });

  it("reports touched paths at or around restart-only fields", async () => {
    const { files } = await fixture();
    const outcome = (
      await files.patch({
        kind: "core",
        operations: [
          { op: "set", path: ["surface", "native", "port"], value: 8123 },
          { op: "set", path: ["agent", "subagents", "maxDepth"], value: 2 },
        ],
      })
    ).unwrap();
    expect(outcome.restartPaths).toEqual(["surface.native.port"]);
  });
});

describe("config text diff", () => {
  it("returns nothing for equal text and unified hunks for changes", () => {
    expect(diffConfigText("a\nb\n", "a\nb\n")).toBe("");
    expect(diffConfigText("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nD\ne\nf\n")).toBe(
      ["@@ -2,5 +2,5 @@", " b", " c", "-d", "+D", " e", " f"].join("\n"),
    );
    expect(diffConfigText("", "x\n")).toBe(["@@ -1,0 +1,1 @@", "+x"].join("\n"));
  });
});
