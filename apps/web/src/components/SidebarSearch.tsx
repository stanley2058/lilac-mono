import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "./ui";
import { Input } from "./ui/input";

export function SidebarSearch({
  label,
  onSearch,
}: {
  label: string;
  onSearch: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  useEffect(() => {
    startTransition(() => onSearch(deferredQuery));
  }, [deferredQuery, onSearch]);

  return (
    <div role="search" className="search-box relative text-muted-foreground">
      <Search />
      <Input
        className="pl-9 pr-9"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
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
