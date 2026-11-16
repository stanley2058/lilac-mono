import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { Result, type Result as ResultType } from "better-result";

import { captureFilesystemOperation, type FileSystemOperationFailed } from "./filesystem-operation";
import { HASHLINE_MAX_LINE_CHARS } from "./hashline";

const BUFFERED_LINE_READ_MAX_BYTES = 16 * 1024 * 1024;
const BUFFERED_LINE_ARRAY_MAX_UTF16 = 64 * 1024;

/**
 * What `readFile` asks a host to collect in one pass over a text file. Positions count Unicode code
 * points after CRLF normalization, and lines are numbered from 1.
 */
export type TextScanRequest = {
  readonly start:
    | { readonly type: "line"; readonly line: number; readonly column: number }
    | { readonly type: "offset"; readonly offset: number };
  readonly maxLines: number;
  readonly maxCharacters: number;
};

/** The state `readFile` needs after scanning; every host must produce identical values. */
export type TextScan = {
  readonly fileHash: string;
  readonly windowLines: readonly string[];
  readonly totalLines: number;
  readonly selectedLineCount: number;
  readonly firstSelectedLineCharacters: number;
  readonly offsetStartLine?: number;
  readonly offsetStartColumn?: number;
  readonly normalizedStartOffset?: number;
  readonly selectedNextLineOffset?: number;
  readonly sourceOffset: number;
  /** The first selected line longer than hashline allows, with its UTF-16 length. */
  readonly hashlineOverflow?: { readonly line: number; readonly length: number };
};

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

export async function scanLocalTextFile(
  canonicalPath: string,
  request: TextScanRequest,
): Promise<ResultType<TextScan, FileSystemOperationFailed>> {
  const { start } = request;
  const requestedStartLine = start.type === "line" ? start.line : 1;
  const requestedStartColumn = start.type === "line" ? start.column : 0;
  const requestedStartOffset = start.type === "offset" ? start.offset : undefined;
  const requestedMaxLines = request.maxLines;
  const storedLineLimit = request.maxCharacters + 2;
  const storedCharacterLimit = request.maxCharacters + 1;
  const windowLines: string[] = [];
  const decoder = new StringDecoder("utf8");
  const hasher = createHash("sha256");
  let lineNumber = 1;
  let selectedLineCount = 0;
  let storedCharacters = 0;
  let currentLine = "";
  let currentLineCharacters = 0;
  let currentLineUtf16Length = 0;
  let firstSelectedLineCharacters = 0;
  let sourceOffset = 0;
  let offsetStartLine: number | undefined;
  let offsetStartColumn: number | undefined;
  let normalizedStartOffset: number | undefined;
  let selectedNextLineOffset: number | undefined;
  let hashlineOverflow: { line: number; length: number } | undefined;

  const resolveOffsetStart = () => {
    if (
      requestedStartOffset === undefined ||
      offsetStartLine !== undefined ||
      sourceOffset < requestedStartOffset
    ) {
      return;
    }
    offsetStartLine = lineNumber;
    offsetStartColumn = currentLineCharacters;
    normalizedStartOffset = sourceOffset;
  };

  const isCurrentLineSelected = () => {
    if (start.type === "line") {
      return (
        lineNumber >= requestedStartLine && lineNumber < requestedStartLine + requestedMaxLines
      );
    }
    return (
      offsetStartLine !== undefined &&
      lineNumber >= offsetStartLine &&
      lineNumber < offsetStartLine + requestedMaxLines
    );
  };

  const finishLine = (hasNewline: boolean) => {
    resolveOffsetStart();
    if (isCurrentLineSelected()) {
      if (selectedLineCount === 0) firstSelectedLineCharacters = currentLineCharacters;
      if (!hashlineOverflow && currentLineUtf16Length > HASHLINE_MAX_LINE_CHARS) {
        hashlineOverflow = { line: lineNumber, length: currentLineUtf16Length };
      }
      if (windowLines.length < storedLineLimit) windowLines.push(currentLine);
      selectedLineCount++;
      if (hasNewline) selectedNextLineOffset = sourceOffset + 1;
    }
    currentLine = "";
    currentLineCharacters = 0;
    currentLineUtf16Length = 0;
  };

  let pendingCR = false;
  const consumeText = (input: string, final = false) => {
    const combined = (pendingCR ? "\r" : "") + input;
    pendingCR = !final && combined.endsWith("\r");
    const text = (pendingCR ? combined.slice(0, -1) : combined).replace(/\r\n/g, "\n");
    for (const character of text) {
      if (character === "\n") {
        finishLine(true);
        sourceOffset++;
        lineNumber++;
        continue;
      }

      resolveOffsetStart();
      currentLineCharacters++;
      currentLineUtf16Length += character.length;
      if (
        isCurrentLineSelected() &&
        (start.type === "offset" ||
          lineNumber !== requestedStartLine ||
          currentLineCharacters > requestedStartColumn) &&
        storedCharacters < storedCharacterLimit
      ) {
        currentLine += character;
        storedCharacters++;
      }
      sourceOffset++;
    }
  };

  const consumeBufferedLine = (bytes: Buffer, hasNewline = false) => {
    if (!isCurrentLineSelected()) return;

    const decoded = bytes.toString("utf8");
    const text = hasNewline ? decoded.replace(/\r$/, "") : decoded;
    currentLineUtf16Length = text.length;
    const remainingCharacters = Math.max(0, storedCharacterLimit - storedCharacters);
    const contentStart = lineNumber === requestedStartLine ? requestedStartColumn : 0;
    if (text.length <= BUFFERED_LINE_ARRAY_MAX_UTF16) {
      const characters = Array.from(text);
      currentLineCharacters = characters.length;
      const stored = characters.slice(contentStart, contentStart + remainingCharacters);
      currentLine = stored.join("");
      storedCharacters += stored.length;
      return;
    }

    const stored: string[] = [];
    for (const character of text) {
      if (currentLineCharacters >= contentStart && stored.length < remainingCharacters) {
        stored.push(character);
      }
      currentLineCharacters++;
    }
    currentLine = stored.join("");
    storedCharacters += stored.length;
  };

  const consumeBufferedFile = (bytes: Buffer) => {
    hasher.update(bytes);
    let lineStart = 0;
    // UTF-8 never uses LF inside a multibyte code point, so line boundaries
    // can be found before decoding the selected window.
    while (true) {
      const newline = bytes.indexOf(0x0a, lineStart);
      if (newline === -1) {
        consumeBufferedLine(bytes.subarray(lineStart));
        finishLine(false);
        return;
      }

      consumeBufferedLine(bytes.subarray(lineStart, newline), true);
      finishLine(true);
      lineNumber++;
      lineStart = newline + 1;
    }
  };

  const consumeLineBytes = (bytes: Buffer) => {
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline + 1;
      if (isCurrentLineSelected()) {
        consumeText(decoder.write(bytes.subarray(offset, end)));
      } else if (newline !== -1) {
        finishLine(true);
        lineNumber++;
      }
      offset = end;
    }
  };
  const consumeStreamBytes = (bytes: Buffer) => {
    if (start.type === "line") return consumeLineBytes(bytes);
    consumeText(decoder.write(bytes));
  };
  const bufferedChunks: Buffer[] = [];
  let bufferedBytes = 0;
  let streamHighWaterMark: number | undefined;
  let streamingText = start.type === "offset";
  if (start.type === "line") {
    const stats = resultOutcome(
      await captureFilesystemOperation("stat file for line reading", () => fs.stat(canonicalPath)),
    );
    if (!stats.ok) return Result.err(stats.error);
    if (stats.value.isFile() && stats.value.size > BUFFERED_LINE_READ_MAX_BYTES) {
      streamingText = true;
    } else if (stats.value.isFile() && stats.value.size > 0) {
      streamHighWaterMark = stats.value.size + 1;
    }
  }
  const streamed = resultOutcome(
    await captureFilesystemOperation("stream file for reading", async () => {
      for await (const chunk of createReadStream(canonicalPath, {
        highWaterMark: streamHighWaterMark,
      })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!streamingText && bufferedBytes + bytes.length <= BUFFERED_LINE_READ_MAX_BYTES) {
          bufferedChunks.push(bytes);
          bufferedBytes += bytes.length;
          continue;
        }

        if (!streamingText) {
          streamingText = true;
          for (const buffered of bufferedChunks) {
            hasher.update(buffered);
            consumeStreamBytes(buffered);
          }
          bufferedChunks.length = 0;
        }

        hasher.update(bytes);
        consumeStreamBytes(bytes);
      }
    }),
  );
  if (!streamed.ok) return Result.err(streamed.error);

  if (!streamingText) {
    const bytes =
      bufferedChunks.length === 1
        ? bufferedChunks[0]!
        : Buffer.concat(bufferedChunks, bufferedBytes);
    consumeBufferedFile(bytes);
  } else {
    consumeText(decoder.end(), true);
    if (start.type === "offset" && offsetStartLine === undefined) {
      offsetStartLine = lineNumber;
      offsetStartColumn = currentLineCharacters;
      normalizedStartOffset = sourceOffset;
    }
    finishLine(false);
  }

  return Result.ok({
    fileHash: hasher.digest("hex"),
    windowLines,
    totalLines: lineNumber,
    selectedLineCount,
    firstSelectedLineCharacters,
    offsetStartLine,
    offsetStartColumn,
    normalizedStartOffset,
    selectedNextLineOffset,
    sourceOffset,
    hashlineOverflow,
  });
}
