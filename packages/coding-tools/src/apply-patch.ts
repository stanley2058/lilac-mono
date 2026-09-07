import { Result, TaggedError, type Result as ResultType } from "better-result";

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
