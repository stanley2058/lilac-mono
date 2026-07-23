import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  parsePatch,
  type PatchHunk,
  type UpdateFileChunk,
} from "@stanley2058/lilac-coding-tools/apply-patch";

export { parsePatch };

function expandTilde(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function resolvePath(baseDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function toDisplayPath(resolved: string, baseDir: string): string {
  const rel = path.relative(baseDir, resolved);
  if (!rel || rel === "") {
    return path.basename(resolved);
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return resolved;
  }
  return rel;
}

function normalizeUnicode(str: string): string {
  return str
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j]!, pattern[j]!)) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j]!, pattern[j]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  );
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex);
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = contextIdx + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === -1) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]!;
    result.splice(startIdx, oldLen);
    for (let j = 0; j < newSegment.length; j++) {
      result.splice(startIdx + j, 0, newSegment[j]!);
    }
  }
  return result;
}

async function applyUpdateHunk(params: {
  resolvedPath: string;
  moveToResolvedPath?: string;
  chunks: UpdateFileChunk[];
}): Promise<{ modifiedPath: string }> {
  const { resolvedPath, moveToResolvedPath, chunks } = params;

  const originalContent = await readFile(resolvedPath, "utf-8");
  let originalLines = originalContent.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, resolvedPath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  const newContent = newLines.join("\n");

  const target = moveToResolvedPath ?? resolvedPath;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, newContent, "utf-8");

  if (moveToResolvedPath && moveToResolvedPath !== resolvedPath) {
    await rm(resolvedPath, { force: true });
  }

  return { modifiedPath: target };
}

function isDeniedPath(resolvedPath: string, denyAbs: readonly string[]): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const deny of denyAbs) {
    if (normalized === deny) return true;
    if (normalized.startsWith(`${deny}${path.sep}`)) return true;
  }
  return false;
}

function assertAllowed(resolvedPath: string, denyAbs: readonly string[], operation: string): void {
  if (denyAbs.length === 0) return;
  if (!isDeniedPath(resolvedPath, denyAbs)) return;
  throw new Error(`Access denied: '${resolvedPath}' is blocked for ${operation}`);
}

export async function applyHunks(
  baseDir: string,
  hunks: PatchHunk[],
  options?: { denyPaths?: readonly string[] },
): Promise<string> {
  const baseResolved = path.resolve(expandTilde(baseDir));
  const denyAbs = (options?.denyPaths ?? []).map((p) => path.resolve(expandTilde(p)));
  const touched: string[] = [];

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const dst = resolvePath(baseResolved, hunk.path);
      assertAllowed(dst, denyAbs, "apply_patch");
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, hunk.contents, "utf-8");
      touched.push(`A ${toDisplayPath(dst, baseResolved)}`);
      continue;
    }

    if (hunk.type === "delete") {
      const target = resolvePath(baseResolved, hunk.path);
      assertAllowed(target, denyAbs, "apply_patch");
      const s = await stat(target).catch(() => null);
      if (s?.isDirectory()) {
        throw new Error(`Refusing to delete directory: ${hunk.path}`);
      }
      await rm(target, { force: true });
      touched.push(`D ${toDisplayPath(target, baseResolved)}`);
      continue;
    }

    if (hunk.type === "update") {
      const src = resolvePath(baseResolved, hunk.path);
      const moveTo = hunk.movePath ? resolvePath(baseResolved, hunk.movePath) : undefined;
      assertAllowed(src, denyAbs, "apply_patch");
      if (moveTo) {
        assertAllowed(moveTo, denyAbs, "apply_patch");
      }
      const { modifiedPath } = await applyUpdateHunk({
        resolvedPath: src,
        moveToResolvedPath: moveTo,
        chunks: hunk.chunks,
      });
      touched.push(`M ${toDisplayPath(modifiedPath, baseResolved)}`);
      continue;
    }

    const _exhaustive: never = hunk;
    throw new Error(`Unhandled hunk type: ${String(_exhaustive)}`);
  }

  return touched.length > 0
    ? `Success. Updated the following files:\n${touched.join("\n")}`
    : "No files were modified.";
}
