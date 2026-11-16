import path from "node:path";
import {
  parsePatchResult as parseCodingPatchResult,
  type PatchHunk,
  type PatchRejected,
  type UpdateFileChunk,
} from "@stanley2058/lilac-coding-tools/apply-patch";
import {
  expandTilde,
  nodeFileSystemHost,
  type FileSystemHost,
  type FileSystemOperationFailed,
} from "@stanley2058/lilac-fs";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../../runtime/error-format";
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
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque apply_patch ${params.operation} failure`),
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

/** Runs one host I/O call and reports its failure as an apply_patch failure. */
async function runHostOperation<T>(params: {
  readonly operation: string;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<ResultType<T, FileSystemOperationFailed>>;
}): Promise<ResultType<T, ApplyPatchOperationError | ApplyPatchCancelled>> {
  const captured = await captureApplyPatchOperation(params);
  return captured.andThen((result) =>
    result.mapError((error) =>
      params.signal?.aborted
        ? new ApplyPatchCancelled({ cause: error, message: "patch was cancelled" })
        : new ApplyPatchOperationError({
            operation: params.operation,
            cause: error,
            message: error.message,
          }),
    ),
  );
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

    lineIndex = found + pattern.length;
    let prefix = 0;
    while (
      prefix < pattern.length &&
      prefix < newSlice.length &&
      pattern[prefix] === newSlice[prefix]
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < pattern.length - prefix &&
      suffix < newSlice.length - prefix &&
      pattern[pattern.length - 1 - suffix] === newSlice[newSlice.length - 1 - suffix]
    )
      suffix++;
    replacements.push([
      found + prefix,
      pattern.length - prefix - suffix,
      newSlice.slice(prefix, newSlice.length - suffix),
    ]);
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
  host: FileSystemHost;
  resolvedPath: string;
  moveToResolvedPath?: string;
  chunks: UpdateFileChunk[];
  signal?: AbortSignal;
}): Promise<ResultType<{ modifiedPath: string }, ApplyPatchError>> {
  const { host, resolvedPath, moveToResolvedPath, chunks, signal } = params;
  const initialCancellation = checkApplyPatchCancellation(signal);
  const initialCancellationError = initialCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (initialCancellationError) return Result.err(initialCancellationError);
  const originalContentResult = await runHostOperation({
    operation: `reading ${resolvedPath}`,
    signal,
    run: () => host.readText(resolvedPath),
  });
  const readError = originalContentResult.match({ ok: () => null, err: (error) => error });
  if (readError) return Result.err(readError);
  const originalContent = selectResultValue(originalContentResult);
  const endings = originalContent.match(/\r?\n/g) ?? [];
  const lineEnding =
    endings.filter((ending) => ending === "\r\n").length > endings.length / 2 ? "\r\n" : "\n";
  let originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }
  const replacementsResult = computeReplacements(originalLines, resolvedPath, chunks);
  const replacementsError = replacementsResult.match({ ok: () => null, err: (error) => error });
  if (replacementsError) return Result.err(replacementsError);
  const replacements = selectResultValue(replacementsResult);
  for (const [start, count, inserted] of [...replacements].reverse()) {
    const previous = endings.slice(start, start + count);
    endings.splice(start, count, ...inserted.map((_, index) => previous[index] ?? lineEnding));
  }
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");
  const newContent = newLines
    .map(
      (line, index) => line + (index < newLines.length - 1 ? (endings[index] ?? lineEnding) : ""),
    )
    .join("");
  const target = moveToResolvedPath ?? resolvedPath;
  const writeCancellation = checkApplyPatchCancellation(signal);
  const writeCancellationError = writeCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (writeCancellationError) return Result.err(writeCancellationError);
  const written = await runHostOperation({
    operation: `writing ${target}`,
    signal,
    run: () => host.writeText(target, newContent, { createParents: true }),
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
    const removed = await runHostOperation({
      operation: `removing moved source ${resolvedPath}`,
      signal,
      run: () => removeIfPresent(host, resolvedPath),
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

async function removeIfPresent(
  host: FileSystemHost,
  target: string,
): Promise<ResultType<void, FileSystemOperationFailed>> {
  const removed = await host.unlink(target);
  return removed.match<ResultType<void, FileSystemOperationFailed>>({
    ok: () => Result.ok(),
    err: (error) => (error.code === "ENOENT" ? Result.ok() : Result.err(error)),
  });
}

async function canonicalizeApplyPatchPath(
  host: FileSystemHost,
  resolvedPath: string,
): Promise<ResultType<string, ApplyPatchOperationError>> {
  const canonical = await host.canonicalizeAsFarAsExists(resolvedPath);
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
  host: FileSystemHost,
  resolvedPath: string,
  denyAbs: readonly string[],
  operation: string,
): Promise<ResultType<void, ApplyPatchAccessDenied | ApplyPatchOperationError>> {
  if (denyAbs.length === 0) return Result.ok();
  if (!isDeniedPath(resolvedPath, denyAbs)) {
    const canonicalPath = await canonicalizeApplyPatchPath(host, resolvedPath);
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

export type ApplyHunksOptions = {
  denyPaths?: readonly string[];
  signal?: AbortSignal;
  /** Where the files live; defaults to this machine. */
  host?: FileSystemHost;
};

export async function applyHunksResult(
  baseDir: string,
  hunks: PatchHunk[],
  options?: ApplyHunksOptions,
): Promise<ResultType<string, ApplyPatchError>> {
  const host = options?.host ?? nodeFileSystemHost;
  const initialCancellation = checkApplyPatchCancellation(options?.signal);
  const initialCancellationError = initialCancellation.match({
    ok: () => null,
    err: (error) => error,
  });
  if (initialCancellationError) return Result.err(initialCancellationError);
  const baseResolved = path.resolve(expandTilde(baseDir, host.homeDir));
  const denyAbs: string[] = [];
  for (const deniedPath of options?.denyPaths ?? []) {
    const resolvedPath = path.resolve(expandTilde(deniedPath, host.homeDir));
    const canonical = await canonicalizeApplyPatchPath(host, resolvedPath);
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
        const allowed = await assertAllowed(host, dst, denyAbs, "patch");
        const allowError = allowed.match({ ok: () => null, err: (error) => error });
        if (allowError) return Result.err(allowError);
        const written = await runHostOperation({
          operation: `writing ${dst}`,
          signal: options?.signal,
          run: () => host.writeText(dst, hunk.contents, { createParents: true }),
        });
        const writeError = written.match({ ok: () => null, err: (error) => error });
        if (writeError) return Result.err(writeError);
        touched.push(`A ${toDisplayPath(dst, baseResolved)}`);
        break;
      }
      case "delete": {
        const target = resolvePath(baseResolved, hunk.path);
        const allowed = await assertAllowed(host, target, denyAbs, "patch");
        const allowError = allowed.match({ ok: () => null, err: (error) => error });
        if (allowError) return Result.err(allowError);
        const inspected = await runHostOperation({
          operation: `inspecting ${target}`,
          signal: options?.signal,
          run: () => host.stat(target),
        });
        const inspectResult = inspected.match<ResultType<void, ApplyPatchError>>({
          ok: (value) =>
            value.type === "directory"
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
        const removed = await runHostOperation({
          operation: `removing ${target}`,
          signal: options?.signal,
          run: () => removeIfPresent(host, target),
        });
        const removeError = removed.match({ ok: () => null, err: (error) => error });
        if (removeError) return Result.err(removeError);
        touched.push(`D ${toDisplayPath(target, baseResolved)}`);
        break;
      }
      case "update": {
        const src = resolvePath(baseResolved, hunk.path);
        const moveTo = hunk.movePath ? resolvePath(baseResolved, hunk.movePath) : undefined;
        const sourceAllowed = await assertAllowed(host, src, denyAbs, "patch");
        const sourceAllowError = sourceAllowed.match({ ok: () => null, err: (error) => error });
        if (sourceAllowError) return Result.err(sourceAllowError);
        if (moveTo) {
          const destinationAllowed = await assertAllowed(host, moveTo, denyAbs, "patch");
          const destinationAllowError = destinationAllowed.match({
            ok: () => null,
            err: (error) => error,
          });
          if (destinationAllowError) return Result.err(destinationAllowError);
        }
        const updated = await applyUpdateHunk({
          host,
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
  options?: ApplyHunksOptions,
): Promise<string> {
  return adaptToolResultToHost(await applyHunksResult(baseDir, hunks, options));
}
