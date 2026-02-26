import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { AlignType, PhrasingContent, Root, RootContent, Table, TableCell } from "mdast";
import { gfm } from "micromark-extension-gfm";

export type MarkdownTableRenderStyle = "unicode" | "ascii";
export type MarkdownTableFallbackMode = "list" | "passthrough";

export type MarkdownTableRenderOptions = {
  style?: MarkdownTableRenderStyle;
  maxWidth?: number;
  fallbackMode?: MarkdownTableFallbackMode;
};

const DEFAULT_STYLE: MarkdownTableRenderStyle = "unicode";
const DEFAULT_MAX_WIDTH = 80;
const DEFAULT_FALLBACK_MODE: MarkdownTableFallbackMode = "list";

type BorderSet = {
  readonly vertical: string;
  readonly horizontal: string;
  readonly topLeft: string;
  readonly topMid: string;
  readonly topRight: string;
  readonly midLeft: string;
  readonly midMid: string;
  readonly midRight: string;
  readonly bottomLeft: string;
  readonly bottomMid: string;
  readonly bottomRight: string;
};

const UNICODE_BORDERS: BorderSet = {
  vertical: "│",
  horizontal: "─",
  topLeft: "┌",
  topMid: "┬",
  topRight: "┐",
  midLeft: "├",
  midMid: "┼",
  midRight: "┤",
  bottomLeft: "└",
  bottomMid: "┴",
  bottomRight: "┘",
};

const ASCII_BORDERS: BorderSet = {
  vertical: "|",
  horizontal: "-",
  topLeft: "+",
  topMid: "+",
  topRight: "+",
  midLeft: "+",
  midMid: "+",
  midRight: "+",
  bottomLeft: "+",
  bottomMid: "+",
  bottomRight: "+",
};

type TableRange = {
  start: number;
  end: number;
  node: Table;
};

type ResolvedOptions = {
  style: MarkdownTableRenderStyle;
  maxWidth: number;
  fallbackMode: MarkdownTableFallbackMode;
};

function resolveOptions(options: MarkdownTableRenderOptions): ResolvedOptions {
  return {
    style: options.style ?? DEFAULT_STYLE,
    maxWidth: Math.max(1, options.maxWidth ?? DEFAULT_MAX_WIDTH),
    fallbackMode: options.fallbackMode ?? DEFAULT_FALLBACK_MODE,
  };
}

function getStringWidth(text: string): number {
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
    return Bun.stringWidth(text);
  }
  return text.length;
}

function splitGraphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (segment) => segment.segment);
  }

  return Array.from(text);
}

function normalizeCellText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function toInlineText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    case "image":
      return node.alt ?? "";
    case "html":
      return node.value;
    default: {
      if ("children" in node && Array.isArray(node.children)) {
        return node.children.map((child) => toInlineText(child)).join("");
      }
      if ("value" in node && typeof node.value === "string") {
        return node.value;
      }
      return "";
    }
  }
}

function tableCellToText(cell: TableCell): string {
  const raw = cell.children.map((child) => toInlineText(child)).join("");
  return normalizeCellText(raw);
}

function wrapLineByWidth(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  if (width <= 0) return [line];

  const out: string[] = [];
  const graphemes = splitGraphemes(line);
  let current = "";
  let currentWidth = 0;

  for (const grapheme of graphemes) {
    const graphemeWidth = Math.max(0, getStringWidth(grapheme));
    if (graphemeWidth === 0) {
      current += grapheme;
      continue;
    }

    if (currentWidth > 0 && currentWidth + graphemeWidth > width) {
      out.push(current);
      current = grapheme;
      currentWidth = graphemeWidth;
      continue;
    }

    current += grapheme;
    currentWidth += graphemeWidth;
  }

  if (current.length > 0 || out.length === 0) {
    out.push(current);
  }

  return out;
}

function wrapCellText(text: string, width: number): string[] {
  const lines = text.length === 0 ? [""] : text.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    out.push(...wrapLineByWidth(line, width));
  }

  if (out.length === 0) return [""];
  return out;
}

function truncateByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (getStringWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const ellipsisWidth = getStringWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return ellipsis;

  const target = maxWidth - ellipsisWidth;
  let current = "";
  let currentWidth = 0;

  for (const grapheme of splitGraphemes(text)) {
    const graphemeWidth = getStringWidth(grapheme);
    if (currentWidth + graphemeWidth > target) break;
    current += grapheme;
    currentWidth += graphemeWidth;
  }

  return `${current}${ellipsis}`;
}

function wrapPrefixedValue(input: {
  prefix: string;
  continuationPrefix: string;
  value: string;
  maxWidth: number;
}): string[] {
  const normalized = normalizeCellText(input.value);
  const valueLines = normalized.length > 0 ? normalized.split("\n") : [""];
  const output: string[] = [];

  const cappedPrefixMax = input.maxWidth > 1 ? input.maxWidth - 1 : input.maxWidth;
  const firstPrefix = truncateByWidth(input.prefix, cappedPrefixMax);
  const firstPrefixWidth = getStringWidth(firstPrefix);
  const continuationWidth = Math.min(getStringWidth(input.continuationPrefix), firstPrefixWidth);
  const continuationPrefix = " ".repeat(continuationWidth);

  let activePrefix = firstPrefix;
  for (const valueLine of valueLines) {
    const available = input.maxWidth - getStringWidth(activePrefix);
    if (available <= 0) {
      output.push(...wrapLineByWidth(valueLine, input.maxWidth));
      activePrefix = continuationPrefix;
      continue;
    }

    const minDisplayWidth = getMinDisplayWidth(valueLine);
    if (available < minDisplayWidth) {
      output.push(activePrefix.trimEnd());

      const continuationAvailable = input.maxWidth - getStringWidth(continuationPrefix);
      if (continuationAvailable >= minDisplayWidth && continuationAvailable > 0) {
        const wrapped = wrapLineByWidth(valueLine, continuationAvailable);
        for (const line of wrapped) {
          output.push(`${continuationPrefix}${line}`);
        }
      } else {
        output.push(...wrapLineByWidth(valueLine, input.maxWidth));
      }

      activePrefix = continuationPrefix;
      continue;
    }

    const wrapped = wrapLineByWidth(valueLine, available);
    const first = wrapped[0] ?? "";
    output.push(`${activePrefix}${first}`);

    for (let i = 1; i < wrapped.length; i++) {
      output.push(`${continuationPrefix}${wrapped[i] ?? ""}`);
    }

    activePrefix = continuationPrefix;
  }

  return output;
}

function getMinDisplayWidth(text: string): number {
  const graphemes = splitGraphemes(text);
  if (graphemes.length === 0) return 1;

  let maxWidth = 1;
  for (const grapheme of graphemes) {
    maxWidth = Math.max(maxWidth, getStringWidth(grapheme));
  }

  return maxWidth;
}

function alignCellContent(
  text: string,
  width: number,
  align: AlignType | null | undefined,
): string {
  const textWidth = getStringWidth(text);
  const remaining = Math.max(0, width - textWidth);

  if (align === "right") {
    return `${" ".repeat(remaining)}${text}`;
  }

  if (align === "center") {
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
  }

  return `${text}${" ".repeat(remaining)}`;
}

function toRows(table: Table): string[][] {
  const rows = table.children;
  const colCount = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
  if (colCount === 0) return [];

  return rows.map((row) => {
    const cells: string[] = [];
    for (let i = 0; i < colCount; i++) {
      const cell = row.children[i];
      cells.push(cell ? tableCellToText(cell) : "");
    }
    return cells;
  });
}

function computeContentWidths(rows: readonly string[][]): { natural: number[]; min: number[] } {
  const colCount = rows[0]?.length ?? 0;
  const natural = Array.from({ length: colCount }, () => 1);
  const min = Array.from({ length: colCount }, () => 1);

  for (const row of rows) {
    for (let col = 0; col < colCount; col++) {
      const value = row[col] ?? "";
      const lines = value.length === 0 ? [""] : value.split("\n");
      let cellNatural = 1;
      let cellMin = 1;

      for (const line of lines) {
        cellNatural = Math.max(cellNatural, getStringWidth(line));
        cellMin = Math.max(cellMin, getMinDisplayWidth(line));
      }

      natural[col] = Math.max(natural[col] ?? 1, cellNatural);
      min[col] = Math.max(min[col] ?? 1, cellMin);
    }
  }

  return { natural, min };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function tableOverhead(colCount: number, padding: number): number {
  return colCount + 1 + 2 * padding * colCount;
}

function computeColumnWidths(
  natural: readonly number[],
  min: readonly number[],
  availableWidth: number,
): number[] | null {
  const colCount = natural.length;
  if (colCount === 0) return [];
  if (availableWidth <= 0) return null;

  const minSum = sum(min);
  if (minSum > availableWidth) return null;

  const widths = natural.map((width, index) => Math.max(width, min[index] ?? 1));
  let total = sum(widths);

  while (total > availableWidth) {
    let maxIndex = -1;
    let maxValue = -1;

    for (let i = 0; i < widths.length; i++) {
      const width = widths[i] ?? 0;
      const minWidth = min[i] ?? 1;
      if (width > minWidth && width > maxValue) {
        maxValue = width;
        maxIndex = i;
      }
    }

    if (maxIndex === -1) return null;

    widths[maxIndex] = (widths[maxIndex] ?? 0) - 1;
    total -= 1;
  }

  return widths;
}

function drawBorder(
  widths: readonly number[],
  padding: number,
  borders: BorderSet,
  kind: "top" | "mid" | "bottom",
): string {
  const left =
    kind === "top" ? borders.topLeft : kind === "bottom" ? borders.bottomLeft : borders.midLeft;
  const mid =
    kind === "top" ? borders.topMid : kind === "bottom" ? borders.bottomMid : borders.midMid;
  const right =
    kind === "top" ? borders.topRight : kind === "bottom" ? borders.bottomRight : borders.midRight;

  const segments = widths.map((width) => borders.horizontal.repeat(width + 2 * padding));
  return `${left}${segments.join(mid)}${right}`;
}

function renderRowLines(input: {
  row: readonly string[];
  widths: readonly number[];
  align: readonly (AlignType | null | undefined)[];
  padding: number;
  vertical: string;
}): string[] {
  const wrappedCells = input.row.map((value, col) => wrapCellText(value, input.widths[col] ?? 1));
  const rowHeight = wrappedCells.reduce((max, lines) => Math.max(max, lines.length), 1);

  const out: string[] = [];
  for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
    const cells: string[] = [];
    for (let col = 0; col < input.widths.length; col++) {
      const width = input.widths[col] ?? 1;
      const line = wrappedCells[col]?.[lineIndex] ?? "";
      const aligned = alignCellContent(line, width, input.align[col]);
      const cell =
        input.padding > 0
          ? `${" ".repeat(input.padding)}${aligned}${" ".repeat(input.padding)}`
          : aligned;
      cells.push(cell);
    }
    out.push(`${input.vertical}${cells.join(input.vertical)}${input.vertical}`);
  }

  return out;
}

function getBorders(style: MarkdownTableRenderStyle): BorderSet {
  return style === "ascii" ? ASCII_BORDERS : UNICODE_BORDERS;
}

function renderTable(table: Table, options: ResolvedOptions): string | null {
  const rows = toRows(table);
  if (rows.length === 0) return null;

  const { natural, min } = computeContentWidths(rows);
  const colCount = natural.length;
  if (colCount === 0) return null;

  const paddingOptions = [1, 0];
  let widths: number[] | null = null;
  let padding = 1;

  for (const nextPadding of paddingOptions) {
    const availableWidth = options.maxWidth - tableOverhead(colCount, nextPadding);
    const computed = computeColumnWidths(natural, min, availableWidth);
    if (!computed) continue;

    widths = computed;
    padding = nextPadding;
    break;
  }

  if (!widths) return null;

  const rawAlign = table.align ?? [];
  const align: readonly (AlignType | null | undefined)[] =
    rawAlign.length > 0
      ? widths.map((_, index) => rawAlign[index] ?? null)
      : widths.map(() => null);

  const borders = getBorders(options.style);
  const lines: string[] = [];
  lines.push(drawBorder(widths, padding, borders, "top"));

  const header = rows[0] ?? [];
  lines.push(
    ...renderRowLines({
      row: header,
      widths,
      align,
      padding,
      vertical: borders.vertical,
    }),
  );

  if (rows.length > 1) {
    lines.push(drawBorder(widths, padding, borders, "mid"));
  }

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    lines.push(
      ...renderRowLines({
        row,
        widths,
        align,
        padding,
        vertical: borders.vertical,
      }),
    );

    if (rowIndex < rows.length - 1) {
      lines.push(drawBorder(widths, padding, borders, "mid"));
    }
  }

  lines.push(drawBorder(widths, padding, borders, "bottom"));
  return lines.join("\n");
}

function renderTableFallbackList(table: Table, options: ResolvedOptions): string | null {
  const rows = toRows(table);
  if (rows.length === 0) return null;

  const header = rows[0] ?? [];
  const labels = header.map((value, index) => {
    const compact = value.replace(/\s+/g, " ").trim();
    const fallback = compact.length > 0 ? compact : `col_${index + 1}`;
    const maxLabelWidth = Math.max(8, Math.floor(options.maxWidth / 2));
    return truncateByWidth(fallback, maxLabelWidth);
  });

  const dataRows = rows.slice(1);
  const out: string[] = [];
  out.push(...wrapLineByWidth("Table (fallback list mode)", options.maxWidth));

  if (dataRows.length === 0) {
    out.push(...wrapLineByWidth("(no data rows)", options.maxWidth));
    return out.join("\n");
  }

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const row = dataRows[rowIndex] ?? [];
    out.push(...wrapLineByWidth(`row ${rowIndex + 1}:`, options.maxWidth));

    for (let col = 0; col < row.length; col++) {
      const label = labels[col] ?? `col_${col + 1}`;
      const prefix = `  ${label}: `;
      const continuationPrefix = " ".repeat(getStringWidth(prefix));
      out.push(
        ...wrapPrefixedValue({
          prefix,
          continuationPrefix,
          value: row[col] ?? "",
          maxWidth: options.maxWidth,
        }),
      );
    }
  }

  return out.join("\n");
}

function renderTableWithFallback(table: Table, options: ResolvedOptions): string | null {
  const standard = renderTable(table, options);
  if (standard) return standard;

  if (options.fallbackMode === "passthrough") {
    return null;
  }

  return renderTableFallbackList(table, options);
}

function collectTableRanges(node: Root | RootContent, ranges: TableRange[] = []): TableRange[] {
  if (node.type === "table" && node.position) {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      ranges.push({ start, end, node });
    }
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectTableRanges(child as RootContent, ranges);
    }
  }

  return ranges;
}

export function renderMarkdownTablesAsCodeBlocks(
  markdown: string,
  options: MarkdownTableRenderOptions = {},
): string {
  if (!markdown) return markdown;

  const resolved = resolveOptions(options);
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const ranges = collectTableRanges(tree)
    .sort((a, b) => a.start - b.start)
    .filter((range, index, arr) => {
      const previous = arr[index - 1];
      if (!previous) return true;
      return range.start >= previous.end;
    });

  if (ranges.length === 0) return markdown;

  let cursor = 0;
  let out = "";

  for (const range of ranges) {
    const start = Math.max(cursor, range.start);
    const end = Math.max(start, range.end);

    out += markdown.slice(cursor, start);

    const rendered = renderTableWithFallback(range.node, resolved);
    if (!rendered) {
      out += markdown.slice(start, end);
      cursor = end;
      continue;
    }

    out += `\`\`\`text\n${rendered}\n\`\`\``;
    cursor = end;
  }

  out += markdown.slice(cursor);
  return out;
}
