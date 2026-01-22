import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  patchText: z
    .string()
    .describe(
      "Patch text in the '*** Begin Patch' format (Add/Update/Delete File sections)",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Optional base directory for relative patch paths"),
});

const outputSchema = z.object({
  status: z.enum(["completed", "failed"]),
  output: z.string().optional(),
});

type PatchInput = z.infer<typeof inputSchema>;

type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

type UpdateFileChunk = {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile?: boolean;
};

function resolvePath(baseDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  );
  if (heredocMatch) return heredocMatch[2]!;
  return input;
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { kind: "add" | "delete" | "update"; filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];
  if (line === undefined) return null;

  if (line.startsWith("*** Add File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath
      ? { kind: "add", filePath, nextIdx: startIdx + 1 }
      : null;
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath
      ? { kind: "delete", filePath, nextIdx: startIdx + 1 }
      : null;
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    if (nextIdx < lines.length && lines[nextIdx]!.startsWith("*** Move to:")) {
      movePath = lines[nextIdx]!.split(":", 2)[1]?.trim();
      nextIdx += 1;
    }

    return filePath
      ? { kind: "update", filePath, movePath, nextIdx }
      : null;
  }

  return null;
}

function parseAddFileContent(
  lines: string[],
  startIdx: number,
): { content: string; nextIdx: number } {
  let content = "";
  let i = startIdx;

  while (i < lines.length && !lines[i]!.startsWith("***")) {
    const line = lines[i]!;
    if (line.startsWith("+")) {
      content += line.substring(1) + "\n";
    }
    i += 1;
  }

  if (content.endsWith("\n")) {
    content = content.slice(0, -1);
  }

  return { content, nextIdx: i };
}

function parseUpdateFileChunks(
  lines: string[],
  startIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i]!.startsWith("***")) {
    const line = lines[i]!;
    if (!line.startsWith("@@")) {
      i += 1;
      continue;
    }

    const contextLine = line.substring(2).trim();
    i += 1;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;

    while (
      i < lines.length &&
      !lines[i]!.startsWith("@@") &&
      !lines[i]!.startsWith("***")
    ) {
      const changeLine = lines[i]!;
      if (changeLine === "*** End of File") {
        isEndOfFile = true;
        i += 1;
        break;
      }

      if (changeLine.startsWith(" ")) {
        const content = changeLine.substring(1);
        oldLines.push(content);
        newLines.push(content);
      } else if (changeLine.startsWith("-")) {
        oldLines.push(changeLine.substring(1));
      } else if (changeLine.startsWith("+")) {
        newLines.push(changeLine.substring(1));
      }

      i += 1;
    }

    chunks.push({
      oldLines,
      newLines,
      changeContext: contextLine || undefined,
      isEndOfFile: isEndOfFile || undefined,
    });
  }

  return { chunks, nextIdx: i };
}

export function parsePatch(patchText: string): PatchHunk[] {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split("\n");

  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
  const endIdx = lines.findIndex((line) => line.trim() === endMarker);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const hunks: PatchHunk[] = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i += 1;
      continue;
    }

    if (header.kind === "add") {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({ type: "add", path: header.filePath, contents: content });
      i = nextIdx;
      continue;
    }

    if (header.kind === "delete") {
      hunks.push({ type: "delete", path: header.filePath });
      i = header.nextIdx;
      continue;
    }

    if (header.kind === "update") {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({
        type: "update",
        path: header.filePath,
        movePath: header.movePath,
        chunks,
      });
      i = nextIdx;
      continue;
    }

    i += 1;
  }

  if (hunks.length === 0) {
    throw new Error("patch rejected: empty patch");
  }

  return hunks;
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

function seekSequence(
  lines: string[],
  pattern: string[],
  startIndex: number,
  eof = false,
): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => a.trimEnd() === b.trimEnd(),
    eof,
  );
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

async function applyHunks(baseDir: string, hunks: PatchHunk[]): Promise<string> {
  const touched: string[] = [];

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const dst = resolvePath(baseDir, hunk.path);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, hunk.contents, "utf-8");
      touched.push(`A ${dst}`);
      continue;
    }

    if (hunk.type === "delete") {
      const target = resolvePath(baseDir, hunk.path);
      const s = await stat(target).catch(() => null);
      if (s?.isDirectory()) {
        throw new Error(`Refusing to delete directory: ${hunk.path}`);
      }
      await rm(target, { force: true });
      touched.push(`D ${target}`);
      continue;
    }

    if (hunk.type === "update") {
      const src = resolvePath(baseDir, hunk.path);
      const moveTo = hunk.movePath ? resolvePath(baseDir, hunk.movePath) : undefined;
      const { modifiedPath } = await applyUpdateHunk({
        resolvedPath: src,
        moveToResolvedPath: moveTo,
        chunks: hunk.chunks,
      });
      touched.push(`M ${modifiedPath}`);
      continue;
    }

    const _exhaustive: never = hunk;
    throw new Error(`Unhandled hunk type: ${String(_exhaustive)}`);
  }

  return touched.length > 0
    ? `Success. Updated the following files:\n${touched.join("\n")}`
    : "No files were modified.";
}

export function localApplyPatchTool(defaultCwd: string) {
  return {
    apply_patch: tool({
      description:
        "Apply a patch in '*** Begin Patch' format (add/update/delete/move files).",
      inputSchema,
      outputSchema,
      execute: async (input: PatchInput) => {
        try {
          const cwd = input.cwd ?? defaultCwd;
          const hunks = parsePatch(input.patchText);
          const output = await applyHunks(cwd, hunks);
          return { status: "completed" as const, output };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { status: "failed" as const, output: msg };
        }
      },
    }),
  };
}
