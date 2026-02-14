import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileSystem,
  type EditFileResult,
  type GlobResult,
  type GrepResult,
} from "../../src/tools/fs/fs-impl";

const runnerPath = path.resolve(import.meta.dir, "../../src/ssh/remote-js/remote-runner.cjs");

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
    throw new Error(`remote runner exited with code ${exitCode}: ${stderrText || stdoutText}`);
  }

  const parsed = JSON.parse(stdoutText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("remote runner returned invalid JSON envelope");
  }

  const ok = parsed["ok"];
  if (ok !== true) {
    const error = parsed["error"];
    throw new Error(`remote runner op failed: ${typeof error === "string" ? error : "unknown"}`);
  }

  return parsed["value"] as T;
}

function normalizePathPrefix(p: string): string {
  return p.replace(/^\.\//, "");
}

function normalizeDefaultResults(
  results: NonNullable<Extract<GrepResult, { mode: "default" }>["results"]>,
) {
  return results
    .map((match) => ({
      file: normalizePathPrefix(match.file),
      line: match.line,
      text: match.text,
    }))
    .sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      if (a.line !== b.line) return a.line - b.line;
      return a.text.localeCompare(b.text);
    });
}

function normalizeDetailedResults(
  results: NonNullable<Extract<GrepResult, { mode: "detailed" }>["results"]>,
) {
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
    await writeFile(path.join(baseDir, "src", "b.ts"), "export const beta = alpha;\n");
    await writeFile(path.join(baseDir, "src", "c.ts"), "export const gamma = alpha + alpha;\n");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("glob default and detailed outputs match", async () => {
    const localLean = await fsTool.glob({
      patterns: ["src/**/*.ts"],
      mode: "default",
    });
    const remoteLean = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: { patterns: ["src/**/*.ts"], mode: "default" },
    });

    expect(localLean.mode).toBe("default");
    expect(remoteLean.mode).toBe("default");
    if (localLean.mode !== "default" || remoteLean.mode !== "default") {
      throw new Error("expected default glob outputs");
    }
    expect(localLean.truncated).toBe(remoteLean.truncated);
    expect(localLean.paths.map(normalizePathPrefix).sort()).toEqual(
      remoteLean.paths.map(normalizePathPrefix).sort(),
    );

    const localVerbose = await fsTool.glob({
      patterns: ["src/**/*.ts"],
      mode: "detailed",
    });
    const remoteVerbose = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: { patterns: ["src/**/*.ts"], mode: "detailed" },
    });

    expect(localVerbose.mode).toBe("detailed");
    expect(remoteVerbose.mode).toBe("detailed");
    if (localVerbose.mode !== "detailed" || remoteVerbose.mode !== "detailed") {
      throw new Error("expected detailed glob outputs");
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
      mode: "default",
    });
    const remote = await runRemoteOp<GlobResult>({
      cwd: baseDir,
      op: "fs.glob",
      input: {
        patterns: ["**/*.ts", "src/**/*.ts", "!**/node_modules/**"],
        mode: "default",
      },
    });

    expect(local.mode).toBe("default");
    expect(remote.mode).toBe("default");
    if (local.mode !== "default" || remote.mode !== "default") {
      throw new Error("expected default glob outputs");
    }

    const localPaths = local.paths.map(normalizePathPrefix).sort();
    const remotePaths = remote.paths.map(normalizePathPrefix).sort();

    expect(localPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(localPaths).toEqual(remotePaths);
  });

  it("grep default and detailed outputs match", async () => {
    const localLean = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "default",
    });
    const remoteLean = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "default",
      },
    });

    expect(localLean.mode).toBe("default");
    expect(remoteLean.mode).toBe("default");
    if (localLean.mode !== "default" || remoteLean.mode !== "default") {
      throw new Error("expected default grep outputs");
    }
    expect(localLean.truncated).toBe(remoteLean.truncated);
    expect(normalizeDefaultResults(localLean.results)).toEqual(
      normalizeDefaultResults(remoteLean.results),
    );

    const localVerbose = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "detailed",
    });
    const remoteVerbose = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "detailed",
      },
    });

    expect(localVerbose.mode).toBe("detailed");
    expect(remoteVerbose.mode).toBe("detailed");
    if (localVerbose.mode !== "detailed" || remoteVerbose.mode !== "detailed") {
      throw new Error("expected detailed grep outputs");
    }

    expect(localVerbose.truncated).toBe(remoteVerbose.truncated);
    expect(normalizeDetailedResults(localVerbose.results)).toEqual(
      normalizeDetailedResults(remoteVerbose.results),
    );
  });

  it("grep truncation behavior matches (exact and overflow)", async () => {
    const exactLocal = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "default",
      maxResults: 3,
    });
    const exactRemote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "default",
        maxResults: 3,
      },
    });

    expect(exactLocal.mode).toBe("default");
    expect(exactRemote.mode).toBe("default");
    if (exactLocal.mode !== "default" || exactRemote.mode !== "default") {
      throw new Error("expected default grep outputs");
    }
    expect(exactLocal.truncated).toBe(false);
    expect(exactRemote.truncated).toBe(false);

    await writeFile(path.join(baseDir, "src", "d.ts"), "export const delta = alpha;\n");

    const overflowLocal = await fsTool.grep({
      pattern: "alpha",
      fileExtensions: ["ts"],
      mode: "detailed",
      maxResults: 3,
    });
    const overflowRemote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "alpha",
        fileExtensions: ["ts"],
        mode: "detailed",
        maxResults: 3,
      },
    });

    expect(overflowLocal.mode).toBe("detailed");
    expect(overflowRemote.mode).toBe("detailed");
    if (overflowLocal.mode !== "detailed" || overflowRemote.mode !== "detailed") {
      throw new Error("expected detailed grep outputs");
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
      mode: "default",
    });
    const remote = await runRemoteOp<GrepResult>({
      cwd: baseDir,
      op: "fs.grep",
      input: {
        pattern: "AGENTS.md",
        mode: "default",
      },
    });

    expect(local.mode).toBe("default");
    expect(remote.mode).toBe("default");
    if (local.mode !== "default" || remote.mode !== "default") {
      throw new Error("expected default grep outputs");
    }

    expect(normalizeDefaultResults(local.results)).toEqual([]);
    expect(normalizeDefaultResults(remote.results)).toEqual([]);
    expect(local.truncated).toBe(false);
    expect(remote.truncated).toBe(false);
  });

  it("edit default snippet replacement matches between local and remote", async () => {
    await writeFile(path.join(baseDir, "edit-local.ts"), "const value = alpha;\n");
    await writeFile(path.join(baseDir, "edit-remote.ts"), "const value = alpha;\n");

    const localRead = await fsTool.readFile({ path: "edit-local.ts" });
    expect(localRead.success).toBe(true);
    if (!localRead.success) throw new Error("local read failed");

    const local = await fsTool.editFile({
      path: "edit-local.ts",
      expectedHash: localRead.fileHash,
      edits: [
        {
          type: "replace_snippet",
          target: "alpha",
          newText: "beta",
        },
      ],
    });

    const remoteRead = await runRemoteOp<{
      success: true;
      fileHash: string;
      resolvedPath: string;
    }>({
      cwd: baseDir,
      op: "fs.read_text",
      input: { path: "edit-remote.ts" },
    });

    const remote = await runRemoteOp<EditFileResult>({
      cwd: baseDir,
      op: "fs.edit",
      input: {
        path: "edit-remote.ts",
        expectedHash: remoteRead.fileHash,
        edits: [
          {
            type: "replace_snippet",
            target: "alpha",
            newText: "beta",
          },
        ],
      },
    });

    expect(local.success).toBe(true);
    expect(remote.success).toBe(true);
    if (!local.success || !remote.success) {
      throw new Error("edit failed unexpectedly");
    }

    expect(local.replacementsMade).toBe(remote.replacementsMade);
    expect(local.changesMade).toBe(remote.changesMade);
  });

  it("edit malformed regex error matches between local and remote", async () => {
    await writeFile(path.join(baseDir, "edit-error.ts"), "alpha\n");

    const localRead = await fsTool.readFile({ path: "edit-error.ts" });
    expect(localRead.success).toBe(true);
    if (!localRead.success) throw new Error("local read failed");

    const local = await fsTool.editFile({
      path: "edit-error.ts",
      expectedHash: localRead.fileHash,
      edits: [
        {
          type: "replace_snippet",
          matching: "regex",
          target: "(",
          newText: "beta",
        },
      ],
    });

    const remoteRead = await runRemoteOp<{
      success: true;
      fileHash: string;
      resolvedPath: string;
    }>({
      cwd: baseDir,
      op: "fs.read_text",
      input: { path: "edit-error.ts" },
    });

    const remote = await runRemoteOp<EditFileResult>({
      cwd: baseDir,
      op: "fs.edit",
      input: {
        path: "edit-error.ts",
        expectedHash: remoteRead.fileHash,
        edits: [
          {
            type: "replace_snippet",
            matching: "regex",
            target: "(",
            newText: "beta",
          },
        ],
      },
    });

    expect(local.success).toBe(false);
    expect(remote.success).toBe(false);
    if (local.success || remote.success) {
      throw new Error("expected edit to fail");
    }

    expect(local.error.code).toBe("INVALID_REGEX");
    expect(remote.error.code).toBe("INVALID_REGEX");
  });
});
