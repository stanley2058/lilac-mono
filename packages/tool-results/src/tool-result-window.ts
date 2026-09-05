import type {
  ToolResultArtifactReadWindow,
  ToolResultArtifactStart,
  ToolResultArtifactStore,
} from "./tool-result-artifact-store";

// Four-byte Unicode characters still fit within the configured 40 KiB raw preview budget.
export const TOOL_RESULT_MAX_PAGE_CHARACTERS = 10 * 1024;

export type ToolResultWindowOptions = Parameters<ToolResultArtifactStore["readWindow"]>[2];
export type ToolResultWindow = Pick<
  ToolResultArtifactReadWindow,
  "content" | "startOffset" | "endOffset" | "totalCharacters" | "hasMore" | "nextStart"
>;

export function createToolResultWindow(options: ToolResultWindowOptions): {
  consume(text: string): void;
  finish(): ToolResultWindow;
} {
  const requestedStart = options.start;
  const start: ToolResultArtifactStart =
    requestedStart.type === "offset"
      ? {
          type: "offset",
          offset: Number.isFinite(requestedStart.offset)
            ? Math.max(0, Math.floor(requestedStart.offset))
            : 0,
        }
      : {
          type: "line",
          line: Number.isFinite(requestedStart.line)
            ? Math.max(1, Math.floor(requestedStart.line))
            : 1,
          column:
            requestedStart.column !== undefined && Number.isFinite(requestedStart.column)
              ? Math.max(0, Math.floor(requestedStart.column))
              : 0,
        };
  const requestedCharacters = Number.isFinite(options.maxCharacters)
    ? Math.floor(options.maxCharacters)
    : TOOL_RESULT_MAX_PAGE_CHARACTERS;
  const maxCharacters = Math.min(TOOL_RESULT_MAX_PAGE_CHARACTERS, Math.max(1, requestedCharacters));
  const maxLines = Number.isFinite(options.maxLines)
    ? Math.max(1, Math.floor(options.maxLines))
    : 1;
  const maxOutputBytes =
    options.maxOutputBytes !== undefined && Number.isFinite(options.maxOutputBytes)
      ? Math.max(1, Math.floor(options.maxOutputBytes))
      : Number.POSITIVE_INFINITY;
  let offset = 0;
  let line = 1;
  let column = 0;
  let startOffset: number | undefined;
  let endOffset: number | undefined;
  let endLine: number | undefined;
  let endColumn: number | undefined;
  let selectedLines = 1;
  let selectedBytes = 0;
  const selected: string[] = [];

  function consume(text: string): void {
    for (const character of text) {
      if (startOffset === undefined) {
        const reached =
          start.type === "offset"
            ? offset >= start.offset
            : line === start.line && (column >= (start.column ?? 0) || character === "\n");
        if (reached) startOffset = offset;
      }
      let selectionEnds = false;
      if (startOffset !== undefined && endOffset === undefined) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (selectedBytes + characterBytes > maxOutputBytes) {
          endOffset = offset;
          endLine = line;
          endColumn = column;
        } else if (character === "\n" && selectedLines >= maxLines) {
          if (start.type === "offset") {
            selected.push(character);
            selectedBytes += characterBytes;
          }
          selectionEnds = true;
        } else {
          selected.push(character);
          selectedBytes += characterBytes;
          if (selected.length >= maxCharacters) selectionEnds = true;
          else if (character === "\n") selectedLines += 1;
        }
      }
      offset += 1;
      if (character === "\n") {
        line += 1;
        column = 0;
      } else column += 1;
      if (selectionEnds) {
        endOffset = offset;
        endLine = line;
        endColumn = column;
      }
    }
  }

  function finish(): ToolResultWindow {
    const resolvedStartOffset = startOffset ?? offset;
    const resolvedEndOffset = endOffset ?? offset;
    const hasMore = resolvedEndOffset < offset;
    let nextStart: ToolResultArtifactStart | undefined;
    if (hasMore && start.type === "offset") {
      nextStart = { type: "offset", offset: resolvedEndOffset };
    } else if (hasMore) {
      nextStart = { type: "line", line: endLine ?? line, column: endColumn ?? column };
    }
    return {
      content: selected.join(""),
      startOffset: resolvedStartOffset,
      endOffset: resolvedEndOffset,
      totalCharacters: offset,
      hasMore,
      ...(nextStart === undefined ? {} : { nextStart }),
    };
  }

  return { consume, finish };
}
