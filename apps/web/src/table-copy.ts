function cellText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element) {
    if (node.matches("svg,[aria-hidden=true],.sr-only")) return "";
    if (node.matches("button,.select-none") && !node.hasAttribute("data-copy-content")) return "";
    if (node.tagName === "BR") return "\n";
    if (node instanceof HTMLImageElement) return node.alt;
  }
  return Array.from(node.childNodes, cellText).join("");
}

export function tableRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows, (row) => Array.from(row.cells, cellText));
}

export function tableCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(","),
    )
    .join("\r\n");
}

export function tableText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join("\t")).join("\n");
}
