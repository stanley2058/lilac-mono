import fs from "node:fs/promises";
import path from "node:path";

import { expandTilde } from "@stanley2058/lilac-fs";
import { tool, type ToolSet } from "ai";

import {
  assertCanonicalPathAllowed,
  assertGuardrailBypassAllowed,
  assertLocalCwd,
} from "./guardrails";
import { applyPatchInputSchema } from "./schemas";

export type UpdateFileChunk = {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile?: boolean;
};

export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match?.[2] ?? input;
}

function parsePatchHeader(
  lines: readonly string[],
  startIndex: number,
): {
  kind: "add" | "delete" | "update";
  filePath: string;
  movePath?: string;
  nextIndex: number;
} | null {
  const line = lines[startIndex];
  if (line === undefined) return null;

  if (line.startsWith("*** Add File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath ? { kind: "add", filePath, nextIndex: startIndex + 1 } : null;
  }
  if (line.startsWith("*** Delete File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath ? { kind: "delete", filePath, nextIndex: startIndex + 1 } : null;
  }
  if (!line.startsWith("*** Update File:")) return null;

  const filePath = line.split(":", 2)[1]?.trim();
  let movePath: string | undefined;
  let nextIndex = startIndex + 1;
  if (lines[nextIndex]?.startsWith("*** Move to:")) {
    movePath = lines[nextIndex]!.split(":", 2)[1]?.trim();
    nextIndex++;
  }
  return filePath ? { kind: "update", filePath, movePath, nextIndex } : null;
}

function parseAddFileContent(
  lines: readonly string[],
  startIndex: number,
): { contents: string; nextIndex: number } {
  let contents = "";
  let index = startIndex;
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    const line = lines[index]!;
    if (line.startsWith("+")) contents += `${line.slice(1)}\n`;
    index++;
  }
  if (contents.endsWith("\n")) contents = contents.slice(0, -1);
  return { contents, nextIndex: index };
}

function parseUpdateChunks(
  lines: readonly string[],
  startIndex: number,
): { chunks: UpdateFileChunk[]; nextIndex: number } {
  const chunks: UpdateFileChunk[] = [];
  let index = startIndex;
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    const header = lines[index]!;
    if (!header.startsWith("@@")) {
      index++;
      continue;
    }
    const changeContext = header.slice(2).trim();
    index++;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let isEndOfFile = false;
    while (
      index < lines.length &&
      !lines[index]!.startsWith("@@") &&
      !lines[index]!.startsWith("***")
    ) {
      const line = lines[index]!;
      if (line === "*** End of File") {
        isEndOfFile = true;
        index++;
        break;
      }
      const prefix = line[0];
      if (prefix === " ") {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (prefix === "-") {
        oldLines.push(line.slice(1));
      } else if (prefix === "+") {
        newLines.push(line.slice(1));
      }
      index++;
    }
    chunks.push({
      oldLines,
      newLines,
      changeContext: changeContext || undefined,
      isEndOfFile: isEndOfFile || undefined,
    });
  }
  return { chunks, nextIndex: index };
}

export function parsePatch(patchText: string): PatchHunk[] {
  const lines = stripHeredoc(patchText.trim()).split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (begin < 0 || end < 0 || begin >= end) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const hunks: PatchHunk[] = [];
  let index = begin + 1;
  while (index < end) {
    const header = parsePatchHeader(lines, index);
    if (!header) {
      index++;
      continue;
    }

    if (header.kind === "add") {
      const parsed = parseAddFileContent(lines, header.nextIndex);
      hunks.push({ type: "add", path: header.filePath, contents: parsed.contents });
      index = parsed.nextIndex;
      continue;
    }
    if (header.kind === "delete") {
      hunks.push({ type: "delete", path: header.filePath });
      index = header.nextIndex;
      continue;
    }
    const parsed = parseUpdateChunks(lines, header.nextIndex);
    hunks.push({
      type: "update",
      path: header.filePath,
      movePath: header.movePath,
      chunks: parsed.chunks,
    });
    index = parsed.nextIndex;
  }

  if (hunks.length === 0) throw new Error("patch rejected: empty patch");
  return hunks;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ");
}

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  atEnd = false,
): number {
  if (pattern.length === 0) return -1;
  const comparators = [
    (left: string, right: string) => left === right,
    (left: string, right: string) => left.trimEnd() === right.trimEnd(),
    (left: string, right: string) => left.trim() === right.trim(),
    (left: string, right: string) =>
      normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
  ];
  for (const compare of comparators) {
    const first = atEnd ? Math.max(start, lines.length - pattern.length) : start;
    const last = atEnd ? first : lines.length - pattern.length;
    for (let index = first; index <= last; index++) {
      if (pattern.every((line, offset) => compare(lines[index + offset]!, line))) return index;
    }
  }
  return -1;
}

function applyUpdateChunks(
  original: string,
  filePath: string,
  chunks: readonly UpdateFileChunk[],
): string {
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hadTrailingNewline) lines.pop();
  let searchFrom = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = findSequence(lines, [chunk.changeContext], searchFrom);
      if (contextIndex < 0) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      searchFrom = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      lines.splice(lines.length, 0, ...chunk.newLines);
      searchFrom = lines.length;
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = findSequence(lines, oldLines, searchFrom, chunk.isEndOfFile);
    if (found < 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = findSequence(lines, oldLines, searchFrom, chunk.isEndOfFile);
    }
    if (found < 0) {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      );
    }
    lines.splice(found, oldLines.length, ...newLines);
    searchFrom = found + newLines.length;
  }

  const updated = lines.join("\n");
  return hadTrailingNewline || chunks.length > 0 ? `${updated}\n` : updated;
}

function resolvePatchPath(cwd: string, target: string): string {
  const expanded = expandTilde(target);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) throw new Error("apply_patch aborted");
}

export async function applyPatch(params: {
  cwd: string;
  patchText: string;
  denyPaths: readonly string[];
  dangerouslyAllow?: boolean;
  allowGuardrailBypass?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string> {
  assertGuardrailBypassAllowed(params.dangerouslyAllow, params.allowGuardrailBypass ?? false);
  assertLocalCwd(params.cwd);
  throwIfAborted(params.abortSignal);
  const cwd = path.resolve(expandTilde(params.cwd));
  const hunks = parsePatch(params.patchText);
  const touched: string[] = [];

  for (const hunk of hunks) {
    throwIfAborted(params.abortSignal);
    const source = resolvePatchPath(cwd, hunk.path);
    if (hunk.type === "add") {
      await assertCanonicalPathAllowed(
        source,
        params.denyPaths,
        "apply_patch add",
        params.dangerouslyAllow,
      );
      throwIfAborted(params.abortSignal);
      await fs.mkdir(path.dirname(source), { recursive: true });
      throwIfAborted(params.abortSignal);
      await assertCanonicalPathAllowed(
        source,
        params.denyPaths,
        "apply_patch add",
        params.dangerouslyAllow,
      );
      throwIfAborted(params.abortSignal);
      await fs.writeFile(source, hunk.contents, "utf8");
      throwIfAborted(params.abortSignal);
      touched.push(`A ${path.relative(cwd, source) || path.basename(source)}`);
      continue;
    }
    if (hunk.type === "delete") {
      await assertCanonicalPathAllowed(
        source,
        params.denyPaths,
        "apply_patch delete",
        params.dangerouslyAllow,
      );
      throwIfAborted(params.abortSignal);
      const stats = await fs.stat(source).catch(() => undefined);
      throwIfAborted(params.abortSignal);
      if (stats?.isDirectory()) throw new Error(`Refusing to delete directory: ${hunk.path}`);
      await assertCanonicalPathAllowed(
        source,
        params.denyPaths,
        "apply_patch delete",
        params.dangerouslyAllow,
      );
      throwIfAborted(params.abortSignal);
      await fs.rm(source, { force: true });
      throwIfAborted(params.abortSignal);
      touched.push(`D ${path.relative(cwd, source) || path.basename(source)}`);
      continue;
    }

    const destination = hunk.movePath ? resolvePatchPath(cwd, hunk.movePath) : source;
    await assertCanonicalPathAllowed(
      source,
      params.denyPaths,
      "apply_patch update read",
      params.dangerouslyAllow,
    );
    throwIfAborted(params.abortSignal);
    const original = await fs.readFile(source, "utf8");
    throwIfAborted(params.abortSignal);
    const updated = applyUpdateChunks(original, hunk.path, hunk.chunks);
    await assertCanonicalPathAllowed(
      destination,
      params.denyPaths,
      "apply_patch update write",
      params.dangerouslyAllow,
    );
    throwIfAborted(params.abortSignal);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    throwIfAborted(params.abortSignal);
    await assertCanonicalPathAllowed(
      destination,
      params.denyPaths,
      "apply_patch update write",
      params.dangerouslyAllow,
    );
    throwIfAborted(params.abortSignal);
    await fs.writeFile(destination, updated, "utf8");
    throwIfAborted(params.abortSignal);
    if (destination !== source) {
      await assertCanonicalPathAllowed(
        source,
        params.denyPaths,
        "apply_patch move delete",
        params.dangerouslyAllow,
      );
      throwIfAborted(params.abortSignal);
      await fs.rm(source, { force: true });
      throwIfAborted(params.abortSignal);
    }
    touched.push(`M ${path.relative(cwd, destination) || path.basename(destination)}`);
  }

  return `Success. Updated the following files:\n${touched.join("\n")}`;
}

export function createApplyPatchTool(params: {
  cwd: string;
  denyPaths: readonly string[];
  allowGuardrailBypass?: boolean;
}): ToolSet {
  return {
    apply_patch: tool({
      description:
        "Apply a local *** Begin Patch with Add, Delete, Update, and optional Move to sections. Directory deletion is refused.",
      inputSchema: applyPatchInputSchema,
      execute: ({ cwd, ...input }, { abortSignal }) =>
        applyPatch({ ...params, ...input, cwd: cwd ?? params.cwd, abortSignal }),
    }),
  };
}
