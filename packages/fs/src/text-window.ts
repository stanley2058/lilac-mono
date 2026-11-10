import type { ReadFileStart, ReadFileResult } from "./fs-impl";

export function createStreamingTextWindow(params: {
  readonly resolvedPath: string;
  readonly fileHash: string;
  readonly start?: ReadFileStart;
  readonly maxLines?: number;
  readonly maxCharacters?: number;
  readonly maxOutputBytes: number;
  readonly format?: "raw" | "numbered";
}) {
  const start = params.start ?? { type: "line" as const, line: 1 };
  const requestedStartLine = start.type === "line" ? Math.max(1, Math.floor(start.line)) : 1;
  const requestedStartColumn =
    start.type === "line" ? Math.max(0, Math.floor(start.column ?? 0)) : 0;
  const requestedStartOffset =
    start.type === "offset" ? Math.max(0, Math.floor(start.offset)) : undefined;
  const requestedMaxLines = Number.isFinite(params.maxLines)
    ? Math.max(1, Math.floor(params.maxLines!))
    : 2_000;
  const requestedMaxCharacters = Number.isFinite(params.maxCharacters)
    ? Math.max(1, Math.floor(params.maxCharacters!))
    : 10_000;
  const storedLineLimit = requestedMaxCharacters + 2;
  const storedCharacterLimit = requestedMaxCharacters + 1;
  const windowLines: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineNumber = 1;
  let selectedLineCount = 0;
  let storedCharacters = 0;
  let currentLine = "";
  let currentLineCharacters = 0;
  let firstSelectedLineCharacters = 0;
  let sourceOffset = 0;
  let offsetStartLine: number | undefined;
  let offsetStartColumn: number | undefined;
  let normalizedStartOffset: number | undefined;
  let selectedNextLineOffset: number | undefined;

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
      if (windowLines.length < storedLineLimit) windowLines.push(currentLine);
      selectedLineCount += 1;
      if (hasNewline) selectedNextLineOffset = sourceOffset + 1;
    }
    currentLine = "";
    currentLineCharacters = 0;
  };

  let pendingCR = false;
  const consumeText = (input: string, final = false) => {
    const combined = (pendingCR ? "\r" : "") + input;
    pendingCR = !final && combined.endsWith("\r");
    const text = (pendingCR ? combined.slice(0, -1) : combined).replace(/\r\n/g, "\n");
    for (const character of text) {
      if (character === "\n") {
        finishLine(true);
        sourceOffset += 1;
        lineNumber += 1;
        continue;
      }

      resolveOffsetStart();
      currentLineCharacters += 1;
      if (
        isCurrentLineSelected() &&
        (start.type === "offset" ||
          lineNumber !== requestedStartLine ||
          currentLineCharacters > requestedStartColumn) &&
        storedCharacters < storedCharacterLimit
      ) {
        currentLine += character;
        storedCharacters += 1;
      }
      sourceOffset += 1;
    }
  };

  return {
    consume(chunk: Uint8Array) {
      consumeText(decoder.decode(chunk, { stream: true }));
    },
    finish(): Extract<ReadFileResult, { success: true }> {
      consumeText(decoder.decode(), true);
      if (requestedStartOffset !== undefined && offsetStartLine === undefined) {
        offsetStartLine = lineNumber;
        offsetStartColumn = currentLineCharacters;
        normalizedStartOffset = sourceOffset;
      }
      finishLine(false);

      const totalLines = lineNumber;
      const normalizedStartLine =
        start.type === "line"
          ? Math.min(requestedStartLine, totalLines + 1)
          : (offsetStartLine ?? totalLines);
      const normalizedStartColumn =
        start.type === "line"
          ? Math.min(requestedStartColumn, firstSelectedLineCharacters)
          : (offsetStartColumn ?? 0);
      const windowEndLine = normalizedStartLine + selectedLineCount - 1;
      let output =
        params.format === "numbered"
          ? windowLines
              .map(
                (line, index) =>
                  `${String(normalizedStartLine + index).padStart(Math.max(1, String(Math.max(windowEndLine, normalizedStartLine)).length), " ")}| ${line}`,
              )
              .join("\n")
          : windowLines.join("\n");
      const includesOffsetBoundaryNewline =
        start.type === "offset" &&
        selectedLineCount >= requestedMaxLines &&
        selectedNextLineOffset !== undefined;
      if (includesOffsetBoundaryNewline) output += "\n";

      let outputCharacters = Array.from(output);
      let effectiveFormat: "raw" | "numbered" = params.format ?? "raw";
      if (
        (outputCharacters.length > requestedMaxCharacters ||
          Buffer.byteLength(output, "utf8") > params.maxOutputBytes) &&
        effectiveFormat !== "raw"
      ) {
        effectiveFormat = "raw";
        output = windowLines.join("\n") + (includesOffsetBoundaryNewline ? "\n" : "");
        outputCharacters = Array.from(output);
      }

      const truncatedByChars = outputCharacters.length > requestedMaxCharacters;
      const boundedCharacters: string[] = [];
      let outputBytes = 0;
      for (const character of outputCharacters.slice(0, requestedMaxCharacters)) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (outputBytes + characterBytes > params.maxOutputBytes) break;
        boundedCharacters.push(character);
        outputBytes += characterBytes;
      }
      output = boundedCharacters.join("");
      const truncatedByBytes =
        boundedCharacters.length < Math.min(outputCharacters.length, requestedMaxCharacters);
      const truncated = truncatedByChars || truncatedByBytes;
      const completeLines = truncated ? output.split("\n").length - 1 : selectedLineCount;
      const endLine = truncated ? normalizedStartLine + completeLines - 1 : windowEndLine;
      const hasMoreLines = truncated || endLine < totalLines;
      let nextStart: ReadFileStart | undefined;
      if (hasMoreLines) {
        if (start.type === "offset") {
          nextStart = {
            type: "offset",
            offset: truncated
              ? (normalizedStartOffset ?? sourceOffset) + Array.from(output).length
              : (selectedNextLineOffset ?? normalizedStartOffset ?? sourceOffset),
          };
        } else if (truncated) {
          nextStart = {
            type: "line",
            line: normalizedStartLine + completeLines,
            column:
              completeLines === 0
                ? normalizedStartColumn + Array.from(output).length
                : Array.from(output.slice(output.lastIndexOf("\n") + 1)).length,
          };
        } else {
          nextStart = {
            type: "line",
            line:
              selectedLineCount > 0 ? normalizedStartLine + selectedLineCount : normalizedStartLine,
            ...(selectedLineCount === 0 && normalizedStartColumn > 0
              ? { column: normalizedStartColumn }
              : {}),
          };
        }
      }

      const base = {
        success: true as const,
        resolvedPath: params.resolvedPath,
        fileHash: params.fileHash,
        startLine: normalizedStartLine,
        endLine,
        totalLines,
        hasMoreLines,
        truncatedByChars,
        ...(nextStart ? { nextStart } : {}),
      };
      return effectiveFormat === "numbered"
        ? { ...base, format: "numbered", numberedContent: output }
        : { ...base, format: "raw", content: output };
    },
  };
}
