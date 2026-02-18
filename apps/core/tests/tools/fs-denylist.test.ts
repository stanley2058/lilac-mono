import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "../../src/tools/fs/fs-impl";

describe("fs denylist", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "lilac-fs-deny-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("blocks reads under denied directories", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const secretFile = join(secretDir, "key.txt");
    await writeFile(secretFile, "super-secret", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });
    const res = await fsTool.readFile({ path: secretFile });

    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PERMISSION");
  });

  it("allows reads under denied directories with dangerouslyAllow=true", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const secretFile = join(secretDir, "key.txt");
    await writeFile(secretFile, "super-secret", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });
    const res = await fsTool.readFile({ path: secretFile, dangerouslyAllow: true });

    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.format).toBe("raw");
    if (res.format !== "raw") return;
    expect(res.content).toBe("super-secret");
  });

  it("blocks editFile under denied directories unless dangerouslyAllow=true", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const secretFile = join(secretDir, "key.txt");
    await writeFile(secretFile, "api_key=old", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });

    const readRes = await fsTool.readFile({ path: secretFile, dangerouslyAllow: true });
    expect(readRes.success).toBe(true);
    if (!readRes.success) return;

    const denied = await fsTool.editFile({
      path: secretFile,
      expectedHash: readRes.fileHash,
      edits: [
        {
          type: "replace_snippet",
          target: "api_key=old",
          newText: "api_key=new",
        },
      ],
    });
    expect(denied.success).toBe(false);
    if (denied.success) return;
    expect(denied.error.code).toBe("PERMISSION");

    const allowed = await fsTool.editFile({
      path: secretFile,
      expectedHash: readRes.fileHash,
      dangerouslyAllow: true,
      edits: [
        {
          type: "replace_snippet",
          target: "api_key=old",
          newText: "api_key=new",
        },
      ],
    });

    expect(allowed.success).toBe(true);
  });

  it("keeps denied files out of glob results unless dangerouslyAllow=true", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "hidden.txt"), "hidden", "utf8");
    await writeFile(join(baseDir, "public.txt"), "public", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });

    const denied = await fsTool.glob({ patterns: ["**/*.txt"] });
    expect(denied.mode).toBe("default");
    if (denied.mode !== "default") return;
    expect(denied.paths).toContain("public.txt");
    expect(denied.paths).not.toContain("secret/hidden.txt");

    const allowed = await fsTool.glob({ patterns: ["**/*.txt"], dangerouslyAllow: true });
    expect(allowed.mode).toBe("default");
    if (allowed.mode !== "default") return;
    expect(allowed.paths).toContain("public.txt");
    expect(allowed.paths).toContain("secret/hidden.txt");
  });

  it("keeps denied files out of grep results unless dangerouslyAllow=true", async () => {
    const secretDir = join(baseDir, "secret");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "hidden.txt"), "token=super-secret", "utf8");
    await writeFile(join(baseDir, "public.txt"), "hello world", "utf8");

    const fsTool = new FileSystem(baseDir, { denyPaths: [secretDir] });

    const denied = await fsTool.grep({ pattern: "token=super-secret", fileExtensions: ["txt"] });
    expect(denied.mode).toBe("default");
    if (denied.mode !== "default") return;
    expect(denied.results).toEqual([]);

    const allowed = await fsTool.grep({
      pattern: "token=super-secret",
      fileExtensions: ["txt"],
      dangerouslyAllow: true,
    });
    expect(allowed.mode).toBe("default");
    if (allowed.mode !== "default") return;
    const files = allowed.results.map((r) => r.file.replace(/^\.\//, ""));
    expect(files).toContain("secret/hidden.txt");
  });
});
