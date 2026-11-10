import { createHash } from "node:crypto";

import { Result, TaggedError, type Result as ResultType } from "better-result";

export const HASHLINE_MAX_LINE_CHARS = 2_048;
export const HASHLINE_ID_LENGTH = 4;

export type HashlineWarning = {
  code: "LINE_TOO_LONG_FOR_HASHLINE";
  message: string;
  line: number;
  maxLength: number;
  actualLength: number;
};

export type HashlineEdit =
  | {
      op: "replace";
      pos: string;
      end?: string;
      lines?: string | readonly string[] | null;
    }
  | {
      op: "append" | "prepend";
      pos: string;
      lines?: string | readonly string[] | null;
    };

type HashlineRef = {
  line: number;
  hash: string;
  raw: string;
};

type NormalizedHashlineEdit =
  | {
      kind: "replace";
      startLine: number;
      endLine: number;
      lines: string[];
      originalIndex: number;
    }
  | {
      kind: "append" | "prepend";
      line: number;
      lines: string[];
      originalIndex: number;
    };

export class HashlineEditFailed extends TaggedError("HashlineEditFailed")<{
  readonly code: "INVALID_EDIT" | "STALE_ANCHOR";
  readonly message: string;
}> {}

export type AppliedHashlineEdits = {
  readonly content: string;
  readonly appliedEditCount: number;
};

function hashlineEditFailure(
  code: "INVALID_EDIT" | "STALE_ANCHOR",
  message: string,
): ResultType<never, HashlineEditFailed> {
  return Result.err(new HashlineEditFailed({ code, message }));
}

function hashlinePrefixPattern() {
  return new RegExp(`^(\\d+)#([0-9a-f]{${HASHLINE_ID_LENGTH}}):(.*)$`, "i");
}

export function computeHashlineId(lineNumber: number, line: string): string {
  return createHash("sha1")
    .update(`${lineNumber}:${line}`)
    .digest("hex")
    .slice(0, HASHLINE_ID_LENGTH);
}

export function formatHashlineLine(lineNumber: number, line: string): string {
  return `${lineNumber}#${computeHashlineId(lineNumber, line)}:${line}`;
}

export function buildHashlineWarning(line: number, actualLength: number): HashlineWarning {
  return {
    code: "LINE_TOO_LONG_FOR_HASHLINE",
    line,
    maxLength: HASHLINE_MAX_LINE_CHARS,
    actualLength,
    message:
      `Line ${line} is too long for hashline mode (${actualLength} chars; max ${HASHLINE_MAX_LINE_CHARS}). ` +
      "This response is downgraded and must not be used as an edit anchor. Use bash to inspect or modify this line instead.",
  };
}

export function findFirstHashlineOverflow(params: {
  lines: readonly string[];
  startLine: number;
}): HashlineWarning | null {
  for (let i = 0; i < params.lines.length; i++) {
    const line = params.lines[i] ?? "";
    if (line.length > HASHLINE_MAX_LINE_CHARS) {
      return buildHashlineWarning(params.startLine + i, line.length);
    }
  }
  return null;
}

export function formatHashlineWindow(lines: readonly string[], startLine: number): string {
  return lines.map((line, index) => formatHashlineLine(startLine + index, line)).join("\n");
}

function parseHashlineRef(input: string): HashlineRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = new RegExp(`^(\\d+)#([0-9a-f]{${HASHLINE_ID_LENGTH}})\\b`, "i").exec(trimmed);
  if (!match) return null;

  const line = Number(match[1]);
  const hash = (match[2] ?? "").toLowerCase();
  if (!Number.isInteger(line) || line < 1 || hash.length !== HASHLINE_ID_LENGTH) return null;
  return { line, hash, raw: trimmed };
}

function splitLinesPreserveBlank(input: string): string[] {
  return input.replace(/\r\n/g, "\n").split("\n");
}

function maybeStripHashlinePrefixes(lines: readonly string[]): string[] {
  const nonEmpty = lines.filter((line) => line.length > 0);
  if (nonEmpty.length === 0) return [...lines];
  if (!nonEmpty.every((line) => hashlinePrefixPattern().test(line))) {
    return [...lines];
  }
  return lines.map((line) => {
    const match = hashlinePrefixPattern().exec(line);
    return match ? (match[3] ?? "") : line;
  });
}

function normalizeReplacementLines(input: string | readonly string[] | null | undefined): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return maybeStripHashlinePrefixes(input.map((line) => String(line).replace(/\r$/, "")));
  }
  return maybeStripHashlinePrefixes(splitLinesPreserveBlank(String(input)));
}

function formatNearbyAnchors(lines: readonly string[], targetLine: number): string {
  const start = Math.max(1, targetLine - 1);
  const end = Math.min(lines.length, targetLine + 1);
  const window: string[] = [];
  for (let line = start; line <= end; line++) {
    const prefix = line === targetLine ? ">>>" : "   ";
    window.push(`${prefix} ${formatHashlineLine(line, lines[line - 1] ?? "")}`);
  }
  return window.join("\n");
}

function validateHashlineRef(
  lines: readonly string[],
  ref: HashlineRef,
): ResultType<number, HashlineEditFailed> {
  const actual = lines[ref.line - 1];
  if (actual === undefined) {
    return hashlineEditFailure(
      "STALE_ANCHOR",
      `Stale anchor ${ref.raw}: file now has only ${lines.length} lines.`,
    );
  }

  const actualHash = computeHashlineId(ref.line, actual);
  if (actualHash !== ref.hash) {
    return hashlineEditFailure(
      "STALE_ANCHOR",
      `Stale anchor ${ref.raw}. Re-read the file and use the current anchors.\n${formatNearbyAnchors(lines, ref.line)}`,
    );
  }

  return Result.ok(ref.line);
}

function normalizeEdit(
  edit: HashlineEdit,
  lines: readonly string[],
  originalIndex: number,
): ResultType<NormalizedHashlineEdit, HashlineEditFailed> {
  const pos = parseHashlineRef(edit.pos);
  if (!pos) {
    return hashlineEditFailure("INVALID_EDIT", `Invalid hashline anchor: ${edit.pos}`);
  }
  const validatedPos = validateHashlineRef(lines, pos).match<
    { value: number } | { error: HashlineEditFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in validatedPos) return Result.err(validatedPos.error);
  const posLine = validatedPos.value;

  if (edit.op === "replace") {
    let endLine = posLine;
    if (edit.end) {
      const end = parseHashlineRef(edit.end);
      if (!end) {
        return hashlineEditFailure("INVALID_EDIT", `Invalid hashline anchor: ${edit.end}`);
      }
      const validatedEnd = validateHashlineRef(lines, end).match<
        { value: number } | { error: HashlineEditFailed }
      >({
        ok: (value) => ({ value }),
        err: (error) => ({ error }),
      });
      if ("error" in validatedEnd) return Result.err(validatedEnd.error);
      endLine = validatedEnd.value;
    }

    if (endLine < posLine) {
      return hashlineEditFailure(
        "INVALID_EDIT",
        `Invalid hashline range ${edit.pos} -> ${edit.end}`,
      );
    }

    return Result.ok({
      kind: "replace",
      startLine: posLine,
      endLine,
      lines: normalizeReplacementLines(edit.lines),
      originalIndex,
    } satisfies NormalizedHashlineEdit);
  }

  return Result.ok({
    kind: edit.op,
    line: posLine,
    lines: normalizeReplacementLines(edit.lines),
    originalIndex,
  } satisfies NormalizedHashlineEdit);
}

function editsOverlap(a: NormalizedHashlineEdit, b: NormalizedHashlineEdit): boolean {
  const isReplaceA = a.kind === "replace";
  const isReplaceB = b.kind === "replace";

  if (isReplaceA && isReplaceB) {
    return !(a.endLine < b.startLine || b.endLine < a.startLine);
  }

  if (isReplaceA) {
    return (
      b.kind !== "replace" &&
      b.line >= a.startLine &&
      b.line <= a.endLine &&
      !(a.startLine === a.endLine && b.line === a.startLine)
    );
  }

  if (isReplaceB) {
    return (
      a.line >= b.startLine &&
      a.line <= b.endLine &&
      !(b.startLine === b.endLine && a.line === b.startLine)
    );
  }

  return false;
}

function validateNoOverlaps(
  edits: readonly NormalizedHashlineEdit[],
): ResultType<void, HashlineEditFailed> {
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) {
      const left = edits[i]!;
      const right = edits[j]!;
      if (!editsOverlap(left, right)) continue;
      return hashlineEditFailure(
        "INVALID_EDIT",
        `Overlapping hashline edits are not supported (edits ${left.originalIndex + 1} and ${right.originalIndex + 1}).`,
      );
    }
  }
  return Result.ok(undefined);
}

function precedence(edit: NormalizedHashlineEdit): number {
  if (edit.kind === "append") return 2;
  if (edit.kind === "replace") return 1;
  return 0;
}

function anchorLine(edit: NormalizedHashlineEdit): number {
  return edit.kind === "replace" ? edit.startLine : edit.line;
}

export function applyHashlineEdits(params: {
  content: string;
  edits: readonly HashlineEdit[];
}): ResultType<AppliedHashlineEdits, HashlineEditFailed> {
  const lineEnding = params.content.includes("\r\n") ? "\r\n" : "\n";
  const originalLines = params.content.replace(/\r\n/g, "\n").split("\n");
  const normalized: NormalizedHashlineEdit[] = [];
  for (let index = 0; index < params.edits.length; index++) {
    const edit = params.edits[index];
    if (!edit) continue;
    const decoded = normalizeEdit(edit, originalLines, index).match<
      { value: NormalizedHashlineEdit } | { error: HashlineEditFailed }
    >({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in decoded) return Result.err(decoded.error);
    normalized.push(decoded.value);
  }

  const overlaps = validateNoOverlaps(normalized).match<
    { value: void } | { error: HashlineEditFailed }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in overlaps) return Result.err(overlaps.error);

  const nextLines = [...originalLines];
  const sorted = [...normalized].sort((a, b) => {
    const lineDelta = anchorLine(b) - anchorLine(a);
    if (lineDelta !== 0) return lineDelta;
    const precedenceDelta = precedence(b) - precedence(a);
    if (precedenceDelta !== 0) return precedenceDelta;
    return b.originalIndex - a.originalIndex;
  });

  for (const edit of sorted) {
    if (edit.kind === "replace") {
      nextLines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.lines);
      continue;
    }
    if (edit.kind === "append") {
      nextLines.splice(edit.line, 0, ...edit.lines);
      continue;
    }
    nextLines.splice(edit.line - 1, 0, ...edit.lines);
  }

  return Result.ok({
    content: nextLines.join(lineEnding),
    appliedEditCount: normalized.length,
  });
}
