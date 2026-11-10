import type { ReactNode } from "react";

/** Splits text into plain and matching parts for each whitespace-separated term in the query. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length || !text) return text ? [{ text, match: false }] : [];
  const pattern = new RegExp(
    terms
      .toSorted((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "gi",
  );
  const parts: { text: string; match: boolean }[] = [];
  let end = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > end) parts.push({ text: text.slice(end, found.index), match: false });
    parts.push({ text: found[0], match: true });
    end = found.index + found[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), match: false });
  return parts;
}

export function SearchHighlight({ text, query }: { text: string; query: string }): ReactNode {
  return highlightParts(text, query).map((part, index) =>
    part.match ? (
      <mark key={index} className="rounded-xs bg-primary/20 text-inherit">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
