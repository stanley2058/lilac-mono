import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystem, type GlobResult, type GrepResult } from "../../src/tools/fs/fs-impl";

const runnerPath = path.resolve(
  import.meta.dir,
  "../../src/ssh/remote-js/remote-runner.cjs",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function runRemoteOp<T>(params: {
  cwd: string;
  op: string;
  input: Record<string, unknown>;
}): Promise<T> {
  const proc = Bun.spawn(["bun", runnerPath], {
    cwd: params.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!proc.stdin) {
    throw new Error("remote runner stdin unavailable");
  }

  const payload = JSON.stringify({
    op: params.op,
    denyPaths: [],
    input: params.input,
  });
  proc.stdin.write(payload);
  proc.stdin.end();

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `remote runner exited with code ${exitCode}: ${stderrText || stdoutText}`,
    );
  }

  const parsed = JSON.parse(stdoutText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("remote runner returned invalid JSON envelope");
  }

  const ok = parsed["ok"];
  if (ok !== true) {
    const error = parsed["error"];
    throw new Error(
      `remote runner op failed: ${typeof error === "string" ? error : "unknown"}`,
    );
  }

  return parsed["value"] as T;
}

function normalizePathPrefix(p: string): string {
  return p.replace(/^\.\//, "");
}

function normalizeLeanText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ""))
    .sort();
}

function normalizeVerboseResults(results: NonNullable<Extract<GrepResult, { mode: "verbose" }>["results"]>) {
  return results
    .map((match) => ({
      file: normalizePathPrefix(match.file),
      line: match.line,
      column: match.column,
      text: match.text,
      submatches: (match.submatches ?? []).map((sm) => ({
        match: sm.match,
        start: sm.start,
        end: sm.end,
      })),
    }))
    .sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });
}

describe("fs search parity (local vs remote runner)", () => {
  let baseDir: string;
  let fsTool: FileSystem;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-fs-parity-"));
    fsTool = new FileSystem(baseDir);

    await mkdir(path.join(baseDir, "src"), { recursive: true });
    await writeFile(path.join(baseDir, "src", "a.ts"), "export const alpha = 1;\n");
    await writeFile(
      path.join(baseDir, "src", "b.ts"),
      "export const beta = alpha;\n",
    );
    await writeFile(
      path.join(baseDir, "src", "c.ts"),
      "export const gamma = alpha + alpha;\n",
    );
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("glob lean and verbose outputs match", async () => {
    const localLean = await fsTool.glob({
      patterns: ["src/**/*.ts"],
      mode: "lean",
    });
    const remoteLean = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: { patterns: ["src/**/*.ts"], mode: "lean" },
    });

    expect(localLean.mode).toBe("lean");
    expect(remoteLean.mode).toBe("lean");
    if (localLean.mode !== "lean" || remoteLean.mode !== "lean") {
      throw new Error("expected lean glob outputs");
    }
    expect(localLean.truncated).toBe(remoteLean.truncated);
    expect(localLean.paths.map(normalizePathPrefix).sort()).toEqual(
      remoteLean.paths.map(normalizePathPrefix).sort(),
    );

    const localVerbose = await fsTool.glob({
      patterns: ["src/**/*.ts"],
      mode: "verbose",
    });
    const remoteVerbose = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: { patterns: ["src/**/*.ts"], mode: "verbose" },
    });

    expect(localVerbose.mode).toBe("verbose");
    expect(remoteVerbose.mode).toBe("verbose");
    if (localVerbose.mode !== "verbose" || remoteVerbose.mode !== "verbose") {
      throw new Error("expected verbose glob outputs");
    }

    const localEntries = localVerbose.entries
      .map((entry) => ({
        path: normalizePathPrefix(entry.path),
        type: entry.type,
        size: entry.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const remoteEntries = remoteVerbose.entries
      .map((entry) => ({
        path: normalizePathPrefix(entry.path),
        type: entry.type,
        size: entry.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(localEntries).toEqual(remoteEntries);
  });

  it("glob negate patterns match and do not leak node_modules", async () => {
    await mkdir(path.join(baseDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(baseDir, "node_modules", "pkg", "ignored.ts"),
      "export const ignored = true;\n",
    );

    const local = await fsTool.glob({
      patterns: ["**/*.ts", "src/**/*.ts", "!**/node_modules/**"],
      mode: "lean",
    });
    const remote = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: {
        patterns: ["**/*.ts", "src/**/*.ts", "!**/node_modules/**"],
        mode: "lean",
      },
    });

    expect(local.mode).toBe("lean");
    expect(remote.mode).toBe("lean");
    if (local.mode !== "lean" || remote.mode !== "lean") {
      throw new Error("expected lean glob outputs");
    }

    const localPaths = local.paths.map(normalizePathPrefix).sort();
    const remotePaths = remote.paths.map(normalizePathPrefix).sort();

    expect(localPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(localPaths).toEqual(remotePaths);
  });

  it("grep lean and verbose outputs match", async () => {
    const localLean = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "lean",
    });
    const remoteLean = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "lean",
      },
    });

    expect(localLean.mode).toBe("lean");
    expect(remoteLean.mode).toBe("lean");
    if (localLean.mode !== "lean" || remoteLean.mode !== "lean") {
      throw new Error("expected lean grep outputs");
    }
    expect(localLean.truncated).toBe(remoteLean.truncated);
    expect(normalizeLeanText(localLean.text)).toEqual(normalizeLeanText(remoteLean.text));

    const localVerbose = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "verbose",
    });
    const remoteVerbose = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "verbose",
      },
    });

    expect(localVerbose.mode).toBe("verbose");
    expect(remoteVerbose.mode).toBe("verbose");
    if (localVerbose.mode !== "verbose" || remoteVerbose.mode !== "verbose") {
      throw new Error("expected verbose grep outputs");
    }

    expect(localVerbose.truncated).toBe(remoteVerbose.truncated);
    expect(normalizeVerboseResults(localVerbose.results)).toEqual(
      normalizeVerboseResults(remoteVerbose.results),
    );
  });

  it("grep truncation behavior matches (exact and overflow)", async () => {
    const exactLocal = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "lean",
      maxResults: 3,
    });
    const exactRemote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "lean",
        maxResults: 3,
      },
    });

    expect(exactLocal.mode).toBe("lean");
    expect(exactRemote.mode).toBe("lean");
    if (exactLocal.mode !== "lean" || exactRemote.mode !== "lean") {
      throw new Error("expected lean grep outputs");
    }
    expect(exactLocal.truncated).toBe(false);
    expect(exactRemote.truncated).toBe(false);

    await writeFile(path.join(baseDir, "src", "d.ts"), "export const delta = alpha;\n");

    const overflowLocal = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "verbose",
      maxResults: 3,
    });
    const overflowRemote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "verbose",
        maxResults: 3,
      },
    });

    expect(overflowLocal.mode).toBe("verbose");
    expect(overflowRemote.mode).toBe("verbose");
    if (overflowLocal.mode !== "verbose" || overflowRemote.mode !== "verbose") {
      throw new Error("expected verbose grep outputs");
    }

    expect(overflowLocal.truncated).toBe(true);
    expect(overflowRemote.truncated).toBe(true);
    expect(overflowLocal.results.length).toBe(3);
    expect(overflowRemote.results.length).toBe(3);
  });

  it("grep skips binary-like files in both local and remote", async () => {
    await writeFile(
      path.join(baseDir, "binary.undo"),
      Buffer.from([0x41, 0x00, 0x47, 0x45, 0x4e, 0x54, 0x53, 0x2e, 0x6d, 0x64]),
    );

    const local = await fsTool.grep({
      pattern: "AGENTS.md",
      mode: "lean",
    });
    const remote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "AGENTS.md",
        mode: "lean",
      },
    });

    expect(local.mode).toBe("lean");
    expect(remote.mode).toBe("lean");
    if (local.mode !== "lean" || remote.mode !== "lean") {
      throw new Error("expected lean grep outputs");
    }

    expect(normalizeLeanText(local.text)).toEqual([]);
    expect(normalizeLeanText(remote.text)).toEqual([]);
    expect(local.truncated).toBe(false);
    expect(remote.truncated).toBe(false);
  });
});
