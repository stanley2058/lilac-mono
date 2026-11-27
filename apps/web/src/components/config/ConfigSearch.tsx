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
  readonly haystack: string;
};

function searchIndex<P extends string>(manifest: Manifest<P>): SearchItem[] {
  const items: SearchItem[] = [];
  for (const page of manifest.pages)
    for (const section of page.sections)
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
            haystack:
              `${entry.label} ${section.title} ${entry.path} ${entry.help ?? description ?? ""}`.toLowerCase(),
          });
          continue;
        }
        const path = splitPath(entry.collection);
        items.push({
          page: page.id,
          where,
          label: entry.label,
          path,
          haystack:
            `${entry.label} ${section.title} ${entry.collection} ${entry.help ?? ""}`.toLowerCase(),
        });
        for (const field of entry.fields)
          items.push({
            page: page.id,
            where: `${where} › ${entry.label}`,
            label: field.label,
            path,
            haystack:
              `${field.label} ${entry.label} ${entry.collection}.${field.path}`.toLowerCase(),
          });
      }
  return items;
}

/** Finds a setting by label, description, or YAML path and opens it. */
export function ConfigSearch<P extends string>({ manifest }: { manifest: Manifest<P> }) {
  const store = useConfigDraftStore();
  const index = useMemo(() => searchIndex(manifest), [manifest]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const results =
    words.length === 0
      ? []
      : index.filter((item) => words.every((word) => item.haystack.includes(word))).slice(0, 12);
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
