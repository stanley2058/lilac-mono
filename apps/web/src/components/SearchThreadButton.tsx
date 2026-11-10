import { Kbd } from "./ui/kbd";
import { useThreadShortcut } from "../shortcuts";
import { SearchHighlight } from "./search-highlight";
import { Button } from "./ui/button";

export function keyedSearchHits<T extends { threadId: string; turnId?: string; excerpt: string }>(
  hits: readonly T[],
) {
  const seen = new Map<string, number>();
  return hits.map((hit) => {
    const base = `${hit.threadId}:${hit.turnId ?? hit.excerpt}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { ...hit, key: count ? `${base}:${count}` : base };
  });
}

export function SearchThreadButton({
  id,
  title,
  excerpt,
  query,
  onSelect,
}: {
  id: string;
  title: string;
  excerpt: string;
  query: string;
  onSelect: () => void;
}) {
  const shortcut = useThreadShortcut(id);
  return (
    <Button
      type="button"
      variant="ghost"
      className="search-result relative flex w-full gap-1 p-3 text-left rounded-sm h-auto flex-col items-start whitespace-normal"
      aria-keyshortcuts={shortcut.aria}
      onClick={onSelect}
    >
      <strong>
        <SearchHighlight text={title} query={query} />
      </strong>
      <span>
        <SearchHighlight text={excerpt} query={query} />
      </span>
      {shortcut.held && shortcut.label ? (
        <Kbd className="absolute bottom-2 right-2 bg-popover px-2 text-popover-foreground shadow-sm">
          {shortcut.label}
        </Kbd>
      ) : null}
    </Button>
  );
}
