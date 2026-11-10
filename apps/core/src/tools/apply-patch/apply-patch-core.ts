import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  parsePatchResult as parseCodingPatchResult,
  type PatchHunk,
  type PatchRejected,
  type UpdateFileChunk,
} from "@stanley2058/lilac-coding-tools/apply-patch";
import { canonicalizePathAsFarAsExists } from "@stanley2058/lilac-fs";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  captureOpaqueErrorCause,
  projectOpaqueErrorCapture,
} from "../../ssh/remote-js/remote-runner-utils";
import { adaptToolResultToHost, preserveToolPanic } from "../tool-result-adapters";

export type { PatchHunk };

export function parsePatchResult(patchText: string): ResultType<PatchHunk[], PatchRejected> {
  return parseCodingPatchResult(patchText);
}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

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

export class ApplyPatchOperationError extends TaggedError("ApplyPatchOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ApplyPatchCancelled extends TaggedError("ApplyPatchCancelled")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ApplyPatchContentMismatch extends TaggedError("ApplyPatchContentMismatch")<{
  readonly filePath: string;
  readonly message: string;
}> {}

export class ApplyPatchAccessDenied extends TaggedError("ApplyPatchAccessDenied")<{
  readonly resolvedPath: string;
  readonly operation: string;
  readonly message: string;
}> {}

export class ApplyPatchDirectoryDeleteDenied extends TaggedError(
  "ApplyPatchDirectoryDeleteDenied",
)<{
  readonly filePath: string;
  readonly message: string;
}> {}

export type ApplyPatchError =
  | ApplyPatchOperationError
  | ApplyPatchCancelled
  | ApplyPatchContentMismatch
  | ApplyPatchAccessDenied
  | ApplyPatchDirectoryDeleteDenied;

async function captureApplyPatchOperation<T>(params: {
  readonly operation: string;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, ApplyPatchOperationError | ApplyPatchCancelled>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureOpaqueErrorCause })
  ).mapError((error) =>
    projectOpaqueErrorCapture(error, `Opaque apply_patch ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, ApplyPatchOperationError | ApplyPatchCancelled>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      if (params.signal?.aborted) {
        return Result.err(new ApplyPatchCancelled({ cause, message: "patch was cancelled" }));
      }
      return Result.err(
        new ApplyPatchOperationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `patch failed while ${params.operation}`),
        }),
      );
    },
  })();
}

function checkApplyPatchCancellation(
  signal: AbortSignal | undefined,
): ResultType<void, ApplyPatchCancelled> {
  if (!signal?.aborted) return Result.ok();
  return Result.err(
    new ApplyPatchCancelled({ cause: signal.reason, message: "patch was cancelled" }),
  );
}

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
): ResultType<Array<[number, number, string[]]>, ApplyPatchContentMismatch> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIdx = seekSequence(originalLines, [chunk.changeContext], lineIndex);
      if (contextIdx === -1) {
        return Result.err(
          new ApplyPatchContentMismatch({
            filePath,
            message: `Failed to find context '${chunk.changeContext}' in ${filePath}`,
          }),
        );
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
      return Result.err(
        new ApplyPatchContentMismatch({
          filePath,
          message: `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
        }),
      );
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return Result.ok(replacements);
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
  signal?: AbortSignal;
}): Promise<ResultType<{ modifiedPath: string }, ApplyPatchError>> {
  const { resolvedPath, moveToResolvedPath, chunks, signal } = params;
  const initialCancellation = checkApplyPatchCancellation(signal);
  const initialCancellationError = initialCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (initialCancellationError) return Result.err(initialCancellationError);
  const originalContentResult = await captureApplyPatchOperation({
    operation: `reading ${resolvedPath}`,
    signal,
    run: () => readFile(resolvedPath, { encoding: "utf-8", signal }),
  });
  const readError = originalContentResult.match({ ok: () => null, err: (error) => error });
  if (readError) return Result.err(readError);
  const originalContent = selectResultValue(originalContentResult);
  const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
  let originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }
  const replacementsResult = computeReplacements(originalLines, resolvedPath, chunks);
  const replacementsError = replacementsResult.match({ ok: () => null, err: (error) => error });
  if (replacementsError) return Result.err(replacementsError);
  const newLines = applyReplacements(originalLines, selectResultValue(replacementsResult));
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");
  const newContent = newLines.join(lineEnding);
  const target = moveToResolvedPath ?? resolvedPath;
  const directoryCancellation = checkApplyPatchCancellation(signal);
  const directoryCancellationError = directoryCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (directoryCancellationError) return Result.err(directoryCancellationError);
  const directoryCreated = await captureApplyPatchOperation({
    operation: `creating the parent directory for ${target}`,
    signal,
    run: () => mkdir(path.dirname(target), { recursive: true }).then(() => undefined),
  });
  const directoryError = directoryCreated.match({ ok: () => null, err: (error) => error });
  if (directoryError) return Result.err(directoryError);
  const writeCancellation = checkApplyPatchCancellation(signal);
  const writeCancellationError = writeCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (writeCancellationError) return Result.err(writeCancellationError);
  const written = await captureApplyPatchOperation({
    operation: `writing ${target}`,
    signal,
    run: () => writeFile(target, newContent, { encoding: "utf-8", signal }),
  });
  const writeError = written.match({ ok: () => null, err: (error) => error });
  if (writeError) return Result.err(writeError);
  if (moveToResolvedPath && moveToResolvedPath !== resolvedPath) {
    const removeCancellation = checkApplyPatchCancellation(signal);
    const removeCancellationError = removeCancellation.match({
      ok: () => null,
      err: (error) => error,
    });
    if (removeCancellationError) return Result.err(removeCancellationError);
    const removed = await captureApplyPatchOperation({
      operation: `removing moved source ${resolvedPath}`,
      signal,
      run: () => rm(resolvedPath, { force: true }),
    });
    const removeError = removed.match({ ok: () => null, err: (error) => error });
    if (removeError) return Result.err(removeError);
  }
  return Result.ok({ modifiedPath: target });
}

function isDeniedPath(resolvedPath: string, denyAbs: readonly string[]): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const deny of denyAbs) {
    const relative = path.relative(deny, normalized);
    if (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      return true;
    }
  }
  return false;
}

async function canonicalizeApplyPatchPath(
  resolvedPath: string,
): Promise<ResultType<string, ApplyPatchOperationError>> {
  const canonical = await canonicalizePathAsFarAsExists(resolvedPath);
  return canonical.mapError(
    (error) =>
      new ApplyPatchOperationError({
        operation: `canonicalizing ${resolvedPath}`,
        cause: error,
        message: error.message,
      }),
  );
}

async function assertAllowed(
  resolvedPath: string,
  denyAbs: readonly string[],
  operation: string,
): Promise<ResultType<void, ApplyPatchAccessDenied | ApplyPatchOperationError>> {
  if (denyAbs.length === 0) return Result.ok();
  if (!isDeniedPath(resolvedPath, denyAbs)) {
    const canonicalPath = await canonicalizeApplyPatchPath(resolvedPath);
    const allowed = canonicalPath.map((value) => !isDeniedPath(value, denyAbs));
    const allowedValue = allowed.match({ ok: (value) => value, err: () => null });
    if (allowedValue === null) return canonicalPath.map(() => undefined);
    if (allowedValue) return Result.ok();
  }
  return Result.err(
    new ApplyPatchAccessDenied({
      resolvedPath,
      operation,
      message: `Access denied: '${resolvedPath}' is blocked for ${operation}`,
    }),
  );
}

export async function applyHunksResult(
  baseDir: string,
  hunks: PatchHunk[],
  options?: { denyPaths?: readonly string[]; signal?: AbortSignal },
): Promise<ResultType<string, ApplyPatchError>> {
  const initialCancellation = checkApplyPatchCancellation(options?.signal);
  const initialCancellationError = initialCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (initialCancellationError) return Result.err(initialCancellationError);
  const baseResolved = path.resolve(expandTilde(baseDir));
  const denyAbs: string[] = [];
  for (const deniedPath of options?.denyPaths ?? []) {
    const resolvedPath = path.resolve(expandTilde(deniedPath));
    const canonical = await canonicalizeApplyPatchPath(resolvedPath);
    const canonicalError = canonical.match({ ok: () => null, err: (error) => error });
    if (canonicalError) return Result.err(canonicalError);
    const canonicalPath = selectResultValue(canonical);
    denyAbs.push(resolvedPath);
    if (canonicalPath !== resolvedPath) denyAbs.push(canonicalPath);
  }
  const touched: string[] = [];

  for (const hunk of hunks) {
    const cancellation = checkApplyPatchCancellation(options?.signal);
    const cancellationError = cancellation.match({ ok: () => null, err: (error) => error });
    if (cancellationError) return Result.err(cancellationError);
    switch (hunk.type) {
      case "add": {
        const dst = resolvePath(baseResolved, hunk.path);
        const allowed = await assertAllowed(dst, denyAbs, "patch");
        const allowError = allowed.match({ ok: () => null, err: (error) => error });
        if (allowError) return Result.err(allowError);
        const directoryCreated = await captureApplyPatchOperation({
          operation: `creating the parent directory for ${dst}`,
          signal: options?.signal,
          run: () => mkdir(path.dirname(dst), { recursive: true }).then(() => undefined),
        });
        const directoryError = directoryCreated.match({ ok: () => null, err: (error) => error });
        if (directoryError) return Result.err(directoryError);
        const written = await captureApplyPatchOperation({
          operation: `writing ${dst}`,
          signal: options?.signal,
          run: () => writeFile(dst, hunk.contents, { encoding: "utf-8", signal: options?.signal }),
        });
        const writeError = written.match({ ok: () => null, err: (error) => error });
        if (writeError) return Result.err(writeError);
        touched.push(`A ${toDisplayPath(dst, baseResolved)}`);
        break;
      }
      case "delete": {
        const target = resolvePath(baseResolved, hunk.path);
        const allowed = await assertAllowed(target, denyAbs, "patch");
        const allowError = allowed.match({ ok: () => null, err: (error) => error });
        if (allowError) return Result.err(allowError);
        const inspected = await captureApplyPatchOperation({
          operation: `inspecting ${target}`,
          signal: options?.signal,
          run: () => stat(target),
        });
        const inspectResult = inspected.match<ResultType<void, ApplyPatchError>>({
          ok: (value) =>
            value.isDirectory()
              ? Result.err(
                  new ApplyPatchDirectoryDeleteDenied({
                    filePath: hunk.path,
                    message: `Refusing to delete directory: ${hunk.path}`,
                  }),
                )
              : Result.ok(undefined),
          err: (error) =>
            ApplyPatchCancelled.is(error) ? Result.err(error) : Result.ok(undefined),
        });
        const inspectError = inspectResult.match({ ok: () => null, err: (error) => error });
        if (inspectError) return Result.err(inspectError);
        const removed = await captureApplyPatchOperation({
          operation: `removing ${target}`,
          signal: options?.signal,
          run: () => rm(target, { force: true }),
        });
        const removeError = removed.match({ ok: () => null, err: (error) => error });
        if (removeError) return Result.err(removeError);
        touched.push(`D ${toDisplayPath(target, baseResolved)}`);
        break;
      }
      case "update": {
        const src = resolvePath(baseResolved, hunk.path);
        const moveTo = hunk.movePath ? resolvePath(baseResolved, hunk.movePath) : undefined;
        const sourceAllowed = await assertAllowed(src, denyAbs, "patch");
        const sourceAllowError = sourceAllowed.match({ ok: () => null, err: (error) => error });
        if (sourceAllowError) return Result.err(sourceAllowError);
        if (moveTo) {
          const destinationAllowed = await assertAllowed(moveTo, denyAbs, "patch");
          const destinationAllowError = destinationAllowed.match({
            ok: () => null,
            err: (error) => error,
          });
          if (destinationAllowError) return Result.err(destinationAllowError);
        }
        const updated = await applyUpdateHunk({
          resolvedPath: src,
          moveToResolvedPath: moveTo,
          chunks: hunk.chunks,
          signal: options?.signal,
        });
        const updateError = updated.match({ ok: () => null, err: (error) => error });
        if (updateError) return Result.err(updateError);
        touched.push(`M ${toDisplayPath(selectResultValue(updated).modifiedPath, baseResolved)}`);
        break;
      }
    }
  }

  return Result.ok(
    touched.length > 0
      ? `Success. Updated the following files:\n${touched.join("\n")}`
      : "No files were modified.",
  );
}

export async function applyHunks(
  baseDir: string,
  hunks: PatchHunk[],
  options?: { denyPaths?: readonly string[]; signal?: AbortSignal },
): Promise<string> {
  return adaptToolResultToHost(await applyHunksResult(baseDir, hunks, options));
}
