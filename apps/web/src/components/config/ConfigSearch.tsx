import { useMemo, useState } from "react";
import { cn } from "cn";
import { Search } from "lucide-react";
import { formatConfigPath, type ConfigPath } from "@stanley2058/lilac-utils/config-document";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { isCollection, type Manifest } from "../../config-ui/manifest";
import { cleanDescription, fieldNode } from "../../config-ui/field-model";
import { useConfigDraftStore } from "../../config-ui/draft-store";
import { splitPath } from "./use-config-field";

type SearchItem = {
  readonly page: string;
  readonly where: string;
  readonly label: string;
  readonly path: ConfigPath;
  /** Lowercase text in rank order: label, section, YAML path, help. */
  readonly text: readonly string[];
};

const RESULT_LIMIT = 12;

/** Ranks by the weakest place any word matched, so label matches come before help-text matches. */
function matchRank(item: SearchItem, words: readonly string[]): number | undefined {
  let rank = 0;
  for (const word of words) {
    const tier = item.text.findIndex((text) => text.includes(word));
    if (tier < 0) return undefined;
    rank = Math.max(rank, tier);
  }
  return rank;
}

function searchResults(index: readonly SearchItem[], words: readonly string[]): SearchItem[] {
  return index
    .flatMap((item) => {
      const rank = matchRank(item, words);
      return rank === undefined ? [] : [{ item, rank }];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, RESULT_LIMIT)
    .map(({ item }) => item);
}

const searchText = (...parts: string[]) => parts.map((part) => part.toLowerCase());

function searchIndex<P extends string>(manifest: Manifest<P>): SearchItem[] {
  const items: SearchItem[] = [];
  for (const page of manifest.pages)
    for (const section of page.sections) {
      const first = section.entries[0];
      // A section result opens at its first setting, which also expands an advanced section.
      // A setting named like its section already stands for it.
      if (first && !section.entries.some((entry) => entry.label === section.title))
        items.push({
          page: page.id,
          where: page.title,
          label: section.title,
          path: splitPath(isCollection(first) ? first.collection : first.path),
          text: searchText(section.title, page.title, "", section.help ?? ""),
        });
      for (const entry of section.entries) {
        const where = `${page.title} › ${section.title}`;
        if (!isCollection(entry)) {
          const path = splitPath(entry.path);
          const description = cleanDescription(
            fieldNode(manifest.kind, path, undefined)?.description,
          );
          items.push({
            page: page.id,
            where,
            label: entry.label,
            path,
            text: searchText(
              entry.label,
              section.title,
              entry.path,
              entry.help ?? description ?? "",
            ),
          });
          continue;
        }
        const path = splitPath(entry.collection);
        items.push({
          page: page.id,
          where,
          label: entry.label,
          path,
          text: searchText(entry.label, section.title, entry.collection, entry.help ?? ""),
        });
        for (const field of entry.fields)
          items.push({
            page: page.id,
            where: `${where} › ${entry.label}`,
            label: field.label,
            path,
            text: searchText(field.label, entry.label, `${entry.collection}.${field.path}`),
          });
      }
    }
  return items;
}

/** Finds a section or setting by title, label, description, or YAML path and opens it. */
export function ConfigSearch<P extends string>({ manifest }: { manifest: Manifest<P> }) {
  const store = useConfigDraftStore();
  const index = useMemo(() => searchIndex(manifest), [manifest]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const results = words.length === 0 ? [] : searchResults(index, words);
  function choose(item: SearchItem) {
    store.getState().reveal(manifest.kind, item.page, item.path);
    setQuery("");
    setOpen(false);
  }
  return (
    <div
      className="relative w-60"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <InputGroup>
        <InputGroupAddon className="pr-0 pl-2.5">
          <Search className="size-4" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search settings"
          aria-expanded={open && results.length > 0}
          aria-controls="config-search-results"
          role="combobox"
          placeholder="Search settings"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(results.length - 1, value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter") {
              const item = results[active];
              if (item) choose(item);
            }
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </InputGroup>
      {open && words.length > 0 ? (
        <div
          id="config-search-results"
          role="listbox"
          className="absolute top-full right-0 z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {results.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matching settings</p>
          ) : (
            results.map((item, position) => (
              <button
                key={`${item.where}-${item.label}-${formatConfigPath(item.path)}`}
                type="button"
                role="option"
                aria-selected={position === active}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  position === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
                onMouseEnter={() => setActive(position)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <span className="text-sm">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.where}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
