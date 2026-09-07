import fs from "node:fs/promises";
import path from "node:path";

import {
  captureFilesystemOperation,
  expandTilde,
  type FileSystemOperationFailed,
} from "@stanley2058/lilac-fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  canonicalPathAllowed,
  guardrailBypassAllowed,
  validateLocalCwd,
  type CanonicalPathError,
  type CodingToolGuardrailViolation,
} from "./guardrails";

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

export class PatchRejected extends TaggedError("PatchRejected")<{
  readonly message: string;
}> {}

export class PatchAborted extends TaggedError("PatchAborted")<{
  readonly message: string;
}> {}

export type CommittedPatchMutation = {
  readonly type: "directory-created" | "file-written" | "path-removed";
  readonly path: string;
};

export class PatchAbortedAfterCommit extends TaggedError("PatchAbortedAfterCommit")<{
  readonly committedMutations: readonly CommittedPatchMutation[];
  readonly message: string;
  readonly retrySafe: false;
}> {}

export type ApplyPatchError =
  | PatchRejected
  | PatchAborted
  | PatchAbortedAfterCommit
  | CodingToolGuardrailViolation
  | FileSystemOperationFailed;

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

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

export function parsePatchResult(patchText: string): ResultType<PatchHunk[], PatchRejected> {
  const lines = stripHeredoc(patchText.trim()).split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (begin < 0 || end < 0 || begin >= end) {
    return Result.err(
      new PatchRejected({ message: "Invalid patch format: missing Begin/End markers" }),
    );
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

  if (hunks.length === 0) {
    return Result.err(new PatchRejected({ message: "patch rejected: empty patch" }));
  }
  return Result.ok(hunks);
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
): ResultType<string, PatchRejected> {
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hadTrailingNewline) lines.pop();
  let searchFrom = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = findSequence(lines, [chunk.changeContext], searchFrom);
      if (contextIndex < 0) {
        return Result.err(
          new PatchRejected({
            message: `Failed to find context '${chunk.changeContext}' in ${filePath}`,
          }),
        );
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
      return Result.err(
        new PatchRejected({
          message: `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
        }),
      );
    }
    lines.splice(found, oldLines.length, ...newLines);
    searchFrom = found + newLines.length;
  }

  const updated = lines.join("\n");
  return Result.ok(hadTrailingNewline || chunks.length > 0 ? `${updated}\n` : updated);
}

function resolvePatchPath(cwd: string, target: string): string {
  const expanded = expandTilde(target);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function checkAborted(
  abortSignal: AbortSignal | undefined,
  committedMutations: readonly CommittedPatchMutation[],
): ResultType<void, PatchAborted | PatchAbortedAfterCommit> {
  if (!abortSignal?.aborted) return Result.ok(undefined);
  if (committedMutations.length === 0) {
    return Result.err(new PatchAborted({ message: "patch aborted" }));
  }
  return Result.err(
    new PatchAbortedAfterCommit({
      committedMutations: [...committedMutations],
      message:
        "patch aborted after filesystem changes were committed; do not retry the patch without inspecting the listed mutations",
      retrySafe: false,
    }),
  );
}

function patchPathAllowed(params: {
  targetPath: string;
  denyPaths: readonly string[];
  operation: string;
  dangerouslyAllow?: boolean;
}): Promise<ResultType<void, CanonicalPathError>> {
  return canonicalPathAllowed(params);
}

export async function applyPatchResult(params: {
  cwd: string;
  patchText: string;
  denyPaths: readonly string[];
  dangerouslyAllow?: boolean;
  allowGuardrailBypass?: boolean;
  abortSignal?: AbortSignal;
}): Promise<ResultType<string, ApplyPatchError>> {
  const bypass = resultOutcome(
    guardrailBypassAllowed(params.dangerouslyAllow, params.allowGuardrailBypass ?? false),
  );
  if (!bypass.ok) return Result.err(bypass.error);
  const localCwd = resultOutcome(validateLocalCwd(params.cwd));
  if (!localCwd.ok) return Result.err(localCwd.error);
  const committedMutations: CommittedPatchMutation[] = [];
  const initialAbort = resultOutcome(checkAborted(params.abortSignal, committedMutations));
  if (!initialAbort.ok) return Result.err(initialAbort.error);
  const cwd = path.resolve(expandTilde(params.cwd));
  const parsed = resultOutcome(parsePatchResult(params.patchText));
  if (!parsed.ok) return Result.err(parsed.error);
  const touched: string[] = [];

  for (const hunk of parsed.value) {
    const beforeHunk = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!beforeHunk.ok) return Result.err(beforeHunk.error);
    const source = resolvePatchPath(cwd, hunk.path);
    if (hunk.type === "add") {
      const allowed = resultOutcome(
        await patchPathAllowed({
          targetPath: source,
          denyPaths: params.denyPaths,
          operation: "patch add",
          dangerouslyAllow: params.dangerouslyAllow,
        }),
      );
      if (!allowed.ok) return Result.err(allowed.error);
      const beforeCreate = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!beforeCreate.ok) return Result.err(beforeCreate.error);
      const createDirectory = resultOutcome(
        await captureFilesystemOperation("create patch directory", () =>
          fs.mkdir(path.dirname(source), { recursive: true }),
        ),
      );
      if (!createDirectory.ok) return Result.err(createDirectory.error);
      if (createDirectory.value !== undefined) {
        committedMutations.push({ type: "directory-created", path: createDirectory.value });
      }
      const afterCreate = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!afterCreate.ok) return Result.err(afterCreate.error);
      const allowedAfterCreate = resultOutcome(
        await patchPathAllowed({
          targetPath: source,
          denyPaths: params.denyPaths,
          operation: "patch add",
          dangerouslyAllow: params.dangerouslyAllow,
        }),
      );
      if (!allowedAfterCreate.ok) return Result.err(allowedAfterCreate.error);
      const beforeWrite = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!beforeWrite.ok) return Result.err(beforeWrite.error);
      const written = resultOutcome(
        await captureFilesystemOperation("write added patch file", () =>
          fs.writeFile(source, hunk.contents, "utf8"),
        ),
      );
      if (!written.ok) return Result.err(written.error);
      committedMutations.push({ type: "file-written", path: source });
      const afterWrite = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!afterWrite.ok) return Result.err(afterWrite.error);
      touched.push(`A ${path.relative(cwd, source) || path.basename(source)}`);
      continue;
    }
    if (hunk.type === "delete") {
      const allowed = resultOutcome(
        await patchPathAllowed({
          targetPath: source,
          denyPaths: params.denyPaths,
          operation: "patch delete",
          dangerouslyAllow: params.dangerouslyAllow,
        }),
      );
      if (!allowed.ok) return Result.err(allowed.error);
      const inspected = resultOutcome(
        await captureFilesystemOperation("inspect patch deletion target", () => fs.stat(source)),
      );
      if (!inspected.ok && inspected.error.code !== "ENOENT") return Result.err(inspected.error);
      const stats = inspected.ok ? inspected.value : null;
      if (stats?.isDirectory()) {
        return Result.err(
          new PatchRejected({ message: `Refusing to delete directory: ${hunk.path}` }),
        );
      }
      const allowedBeforeDelete = resultOutcome(
        await patchPathAllowed({
          targetPath: source,
          denyPaths: params.denyPaths,
          operation: "patch delete",
          dangerouslyAllow: params.dangerouslyAllow,
        }),
      );
      if (!allowedBeforeDelete.ok) return Result.err(allowedBeforeDelete.error);
      const beforeDelete = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!beforeDelete.ok) return Result.err(beforeDelete.error);
      const removed = resultOutcome(
        await captureFilesystemOperation("delete patch file", () => fs.rm(source, { force: true })),
      );
      if (!removed.ok) return Result.err(removed.error);
      if (stats !== null) committedMutations.push({ type: "path-removed", path: source });
      const afterDelete = resultOutcome(checkAborted(params.abortSignal, committedMutations));
      if (!afterDelete.ok) return Result.err(afterDelete.error);
      touched.push(`D ${path.relative(cwd, source) || path.basename(source)}`);
      continue;
    }

    const destination = hunk.movePath ? resolvePatchPath(cwd, hunk.movePath) : source;
    const sourceAllowed = resultOutcome(
      await patchPathAllowed({
        targetPath: source,
        denyPaths: params.denyPaths,
        operation: "patch update read",
        dangerouslyAllow: params.dangerouslyAllow,
      }),
    );
    if (!sourceAllowed.ok) return Result.err(sourceAllowed.error);
    const original = resultOutcome(
      await captureFilesystemOperation("read patch source", () => fs.readFile(source, "utf8")),
    );
    if (!original.ok) return Result.err(original.error);
    const updated = resultOutcome(applyUpdateChunks(original.value, hunk.path, hunk.chunks));
    if (!updated.ok) return Result.err(updated.error);
    const destinationAllowed = resultOutcome(
      await patchPathAllowed({
        targetPath: destination,
        denyPaths: params.denyPaths,
        operation: "patch update write",
        dangerouslyAllow: params.dangerouslyAllow,
      }),
    );
    if (!destinationAllowed.ok) return Result.err(destinationAllowed.error);
    const beforeCreate = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!beforeCreate.ok) return Result.err(beforeCreate.error);
    const createDirectory = resultOutcome(
      await captureFilesystemOperation("create patch destination", () =>
        fs.mkdir(path.dirname(destination), { recursive: true }),
      ),
    );
    if (!createDirectory.ok) return Result.err(createDirectory.error);
    if (createDirectory.value !== undefined) {
      committedMutations.push({ type: "directory-created", path: createDirectory.value });
    }
    const afterCreate = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!afterCreate.ok) return Result.err(afterCreate.error);
    const destinationAllowedAfterCreate = resultOutcome(
      await patchPathAllowed({
        targetPath: destination,
        denyPaths: params.denyPaths,
        operation: "patch update write",
        dangerouslyAllow: params.dangerouslyAllow,
      }),
    );
    if (!destinationAllowedAfterCreate.ok) return Result.err(destinationAllowedAfterCreate.error);
    const beforeWrite = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!beforeWrite.ok) return Result.err(beforeWrite.error);
    const written = resultOutcome(
      await captureFilesystemOperation("write patched file", () =>
        fs.writeFile(destination, updated.value, "utf8"),
      ),
    );
    if (!written.ok) return Result.err(written.error);
    committedMutations.push({ type: "file-written", path: destination });
    const afterWrite = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!afterWrite.ok) return Result.err(afterWrite.error);
    if (destination !== source) {
      const sourceDeleteAllowed = resultOutcome(
        await patchPathAllowed({
          targetPath: source,
          denyPaths: params.denyPaths,
          operation: "patch move delete",
          dangerouslyAllow: params.dangerouslyAllow,
        }),
      );
      if (!sourceDeleteAllowed.ok) return Result.err(sourceDeleteAllowed.error);
      const beforeSourceDelete = resultOutcome(
        checkAborted(params.abortSignal, committedMutations),
      );
      if (!beforeSourceDelete.ok) return Result.err(beforeSourceDelete.error);
      const removed = resultOutcome(
        await captureFilesystemOperation("remove moved patch source", () =>
          fs.rm(source, { force: true }),
        ),
      );
      if (!removed.ok) return Result.err(removed.error);
      committedMutations.push({ type: "path-removed", path: source });
    }
    const afterUpdate = resultOutcome(checkAborted(params.abortSignal, committedMutations));
    if (!afterUpdate.ok) return Result.err(afterUpdate.error);
    touched.push(`M ${path.relative(cwd, destination) || path.basename(destination)}`);
  }

  return Result.ok(`Success. Updated the following files:\n${touched.join("\n")}`);
}
