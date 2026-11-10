import { startTransition, useEffect, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "./ui";
import { Input } from "./ui/input";

/** Typing waits this long before searching; clearing the field applies at once. */
const SEARCH_DELAY_MS = 250;

export function SidebarSearch({
  label,
  onSearch,
}: {
  label: string;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) {
      startTransition(() => onSearch(""));
      return;
    }
    const timer = setTimeout(() => startTransition(() => onSearch(trimmed)), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed, onSearch]);
  // Down moves from the field to the list's current row, so results are one key away.
  const enterList = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey) return;
    const row = event.currentTarget
      .closest("aside")
      ?.querySelector<HTMLElement>('[data-roving-list] [tabindex="0"]');
    if (!row) return;
    event.preventDefault();
    row.focus();
  };

  return (
    <div role="search" className="search-box relative text-muted-foreground">
      <Search />
      <Input
        className="pl-9 pr-9"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={enterList}
        aria-label={label}
        placeholder="Search"
      />
      {query ? (
        <IconButton label="Clear search" onClick={() => setQuery("")}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}
