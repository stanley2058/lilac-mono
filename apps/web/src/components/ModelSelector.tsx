import { memo, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Result } from "better-result";
import type { NativeClient } from "@stanley2058/lilac-client";
import type {
  CatalogModelChoice,
  ModelReasoning,
  DisplayCatalog,
} from "@stanley2058/lilac-client-protocol";
import { Brain, ChevronDown, ChevronRight, Search, Star } from "lucide-react";
import { queryNativeRPC, useNativeOnline } from "../queries";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Select, SelectContent, SelectItem } from "./ui/select";
import { IconButton } from "./ui";
import { ProviderIcon, providerName } from "./ProviderIcon";

const EMPTY_FAVORITES: string[] = [];
const FAVORITES = "favorites";
const TAB_KEY = "lilac-model-selector-tab-v1";

type Props = {
  client?: NativeClient;
  models?: DisplayCatalog["models"];
  modelId?: string;
  reasoning?: ModelReasoning;
  disabled: boolean;
  onChange: (modelId: string, reasoning?: ModelReasoning) => void;
};

function readStoredTab(): string | undefined {
  return Result.try({
    try: () => localStorage.getItem(TAB_KEY) ?? undefined,
    catch: () => "Storage unavailable",
  }).match({ ok: (value) => value, err: () => undefined });
}

function storeTab(tab: string) {
  Result.try({
    try: () => localStorage.setItem(TAB_KEY, tab),
    catch: () => "Storage unavailable",
  }).match({ ok: () => {}, err: () => {} });
}

/** Falls back to favorites, then the first provider, when the stored tab is missing or no longer configured. */
function resolveTab(
  stored: string | undefined,
  providers: readonly string[] | undefined,
  favorites: readonly string[] | undefined,
): string {
  if (stored === FAVORITES) return stored;
  if (stored && (!providers || providers.includes(stored))) return stored;
  if (!providers || !favorites || favorites.length) return FAVORITES;
  return providers[0] ?? FAVORITES;
}

// Both composer triggers share one ghost-button look and shrink before the toolbar overflows.
const triggerClass = "min-w-0 shrink gap-1.5 font-normal text-muted-foreground";

function effortLabel(effort: ModelReasoning): string {
  if (effort === "provider-default") return "Default";
  return `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
}

export const ModelSelector = memo(function ModelSelector(props: Props) {
  if (props.client) return <ConnectedSelector {...props} client={props.client} />;
  const models: CatalogModelChoice[] = (props.models ?? []).map((model) => ({
    ...model,
    provider: model.id.split("/")[0] ?? "",
    model: model.id,
    legacy: false,
    reasoning: ["provider-default"],
  }));
  return (
    <ModelSelectorView
      {...props}
      models={models}
      providers={[...new Set(models.map((model) => model.provider))]}
      favorites={EMPTY_FAVORITES}
    />
  );
});

function ConnectedSelector(props: Props & { client: NativeClient }) {
  const { client } = props;
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [storedTab, setStoredTab] = useState(readStoredTab);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const favorites = useQuery({
    queryKey: ["model-favorites"],
    queryFn: () => queryNativeRPC(client, (rpc) => rpc.catalogs.favorites({})),
    enabled: open && online,
    staleTime: 0,
  });
  const ids = favorites.data ?? EMPTY_FAVORITES;
  const providers = useQuery({
    queryKey: ["model-catalog-providers"],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) => rpc.catalogs.models({ ids: [] }, { signal })),
    select: (page) => page.providers,
    enabled: open && online,
    staleTime: 60_000,
  }).data;
  const tab = resolveTab(storedTab, providers, favorites.data);
  // Search spans every provider, so the tab only scopes an empty query.
  const scope = deferredSearch ? "" : tab;
  const catalog = useInfiniteQuery({
    queryKey: ["model-catalog", scope, deferredSearch, scope === FAVORITES ? ids : null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      queryNativeRPC(client, (rpc) =>
        rpc.catalogs.models(
          {
            ...(scope && scope !== FAVORITES ? { provider: scope } : {}),
            ...(scope === FAVORITES ? { ids } : {}),
            search: deferredSearch,
            cursor: pageParam,
          },
          { signal },
        ),
      ),
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && online && (scope !== FAVORITES || favorites.isSuccess),
    // Switching tabs keeps the previous list until the next one arrives instead of blanking the popup.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const selectedId = props.modelId ?? props.models?.[0]?.id;
  const selected = useQuery({
    queryKey: ["model-catalog-selection", selectedId],
    queryFn: ({ signal }) =>
      queryNativeRPC(client, (rpc) =>
        rpc.catalogs.models({ ids: selectedId ? [selectedId] : [] }, { signal }),
      ),
    enabled: Boolean(selectedId) && online,
    staleTime: 60_000,
  });
  const favorite = useMutation({
    mutationFn: (input: { modelId: string; favorite: boolean }) =>
      queryNativeRPC(client, (rpc) => rpc.catalogs.favorite(input)),
    onMutate: async (input) => {
      await queries.cancelQueries({ queryKey: ["model-favorites"] });
      const previous = queries.getQueryData<string[]>(["model-favorites"]) ?? [];
      queries.setQueryData(
        ["model-favorites"],
        input.favorite
          ? [...new Set([...previous, input.modelId])]
          : previous.filter((id) => id !== input.modelId),
      );
      return previous;
    },
    onError: (_error, _input, previous) => queries.setQueryData(["model-favorites"], previous),
    onSuccess: (value) => queries.setQueryData(["model-favorites"], value),
  });
  const models = useMemo(
    () => catalog.data?.pages.flatMap((page) => page.models) ?? [],
    [catalog.data],
  );
  return (
    <ModelSelectorView
      {...props}
      models={models}
      modelId={selectedId}
      selected={selected.data?.models[0]}
      providers={providers ?? []}
      favorites={ids}
      filtered
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
      provider={tab}
      onProviderChange={(next) => {
        setStoredTab(next);
        storeTab(next);
      }}
      search={search}
      onSearchChange={setSearch}
      onFavorite={(id) => favorite.mutate({ modelId: id, favorite: !ids.includes(id) })}
      favoritePending={favorite.isPending}
      loadMore={catalog.hasNextPage ? () => void catalog.fetchNextPage() : undefined}
      loading={catalog.isPending || catalog.isFetchingNextPage}
      error={favorite.error?.message ?? catalog.error?.message}
    />
  );
}

export function ModelSelectorView({
  models,
  selected,
  providers,
  favorites,
  filtered,
  modelId,
  reasoning,
  disabled,
  onChange,
  open: controlledOpen,
  onOpenChange,
  provider: controlledProvider,
  onProviderChange,
  search: controlledSearch,
  onSearchChange,
  onFavorite,
  favoritePending,
  loadMore,
  loading,
  error,
}: Omit<Props, "models"> & {
  models: CatalogModelChoice[];
  selected?: CatalogModelChoice;
  providers: string[];
  favorites: string[];
  /** The caller already filtered models by tab and search. */
  filtered?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  search?: string;
  onSearchChange?: (search: string) => void;
  onFavorite?: (id: string) => void;
  favoritePending?: boolean;
  loadMore?: () => void;
  loading?: boolean;
  error?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [localProvider, setLocalProvider] = useState(FAVORITES);
  const [localSearch, setLocalSearch] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const provider = controlledProvider ?? localProvider;
  const setProvider = onProviderChange ?? setLocalProvider;
  const search = controlledSearch ?? localSearch;
  const query = search.trim().toLowerCase();
  const current = selected ?? models.find((model) => model.id === modelId);
  const visible = filtered ? models : models.filter(matches);
  function matches(model: CatalogModelChoice) {
    if (query)
      return `${model.label} ${model.id} ${model.family ?? ""}`.toLowerCase().includes(query);
    if (provider === FAVORITES) return favorites.includes(model.id);
    return model.provider === provider;
  }
  const grouped = !query && provider !== FAVORITES;
  const regular = grouped ? visible.filter((model) => !model.legacy) : visible;
  const legacy = grouped ? visible.filter((model) => model.legacy) : [];
  function select(model: CatalogModelChoice) {
    onChange(model.id, model.defaultReasoning ?? "provider-default");
    setOpen(false);
  }
  function row(model: CatalogModelChoice) {
    const starred = favorites.includes(model.id);
    const active = model.id === current?.id;
    return (
      <div
        key={model.id}
        className={`group/model flex items-center rounded-md ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-focus"
          onClick={() => select(model)}
          aria-pressed={active}
          title={
            model.alias
              ? `${model.alias} → ${model.provider}/${model.model}`
              : `${model.provider}/${model.model}`
          }
        >
          <span className="w-full truncate text-sm">{model.label}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProviderIcon provider={model.provider} className="size-3.5" />
            {providerName(model.provider)}
          </span>
        </button>
        <IconButton
          label={`${starred ? "Unfavorite" : "Favorite"} ${model.label}`}
          tooltip={starred ? "Unfavorite" : "Favorite"}
          disabled={!onFavorite || favoritePending}
          onClick={() => onFavorite?.(model.id)}
          className={`mr-1 shrink-0 ${starred ? "" : "opacity-0 group-hover/model:opacity-100 focus-visible:opacity-100"}`}
        >
          <Star className={`size-4 ${starred ? "fill-primary text-primary" : ""}`} />
        </IconButton>
      </div>
    );
  }
  function tabButton(id: string, label: string, icon: ReactNode) {
    const active = !query && provider === id;
    return (
      <IconButton
        key={id}
        label={label}
        tooltipSide="left"
        aria-pressed={active}
        className={`relative ${active ? "bg-accent text-foreground before:absolute before:top-1/2 before:-left-1 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary" : ""}`}
        onClick={() => setProvider(id)}
      >
        {icon}
      </IconButton>
    );
  }
  let empty = "No models";
  if (query) empty = "No matching models";
  else if (provider === FAVORITES) empty = "Star a model to pin it here";
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id="composer-model"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label="Response model"
              className={`max-w-64 ${triggerClass}`}
            />
          }
        >
          <ProviderIcon provider={current?.provider ?? ""} />
          <span className="truncate">{current?.label ?? modelId ?? "Model"}</span>
          <ChevronDown className="size-3" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="h-[min(26rem,70vh)] w-96 max-w-[calc(100vw-2rem)] gap-0 p-0"
        >
          <div className="flex h-full min-h-0">
            <nav
              aria-label="Model providers"
              className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/60 py-1.5"
            >
              {tabButton(FAVORITES, "Favorites", <Star className="size-4" />)}
              {providers.map((id) =>
                tabButton(id, providerName(id), <ProviderIcon provider={id} className="size-4" />),
              )}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <label className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-muted-foreground">
                <Search className="size-4 shrink-0" />
                <input
                  aria-label="Search models"
                  placeholder="Search models…"
                  autoFocus
                  value={search}
                  onChange={(event) => (onSearchChange ?? setLocalSearch)(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>
              <div className="min-h-0 flex-1 overflow-y-auto p-1" aria-busy={loading}>
                {regular.map(row)}
                {legacy.length ? (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-accent/60"
                      aria-expanded={legacyOpen}
                      onClick={() => setLegacyOpen(!legacyOpen)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm">Legacy models</span>
                        <span className="text-xs text-muted-foreground">
                          {legacy.length} {legacy.length === 1 ? "model" : "models"}
                        </span>
                      </span>
                      {legacyOpen ? (
                        <ChevronDown className="mr-2 size-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mr-2 size-4 text-muted-foreground" />
                      )}
                    </button>
                    {legacyOpen ? legacy.map(row) : null}
                  </>
                ) : null}
                {!visible.length ? (
                  <p className="px-2.5 py-4 text-sm text-muted-foreground">
                    {loading ? "Loading…" : empty}
                  </p>
                ) : null}
                {loadMore ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={loadMore}
                    disabled={loading}
                  >
                    More
                  </Button>
                ) : null}
              </div>
              {error ? (
                <p role="alert" className="border-t border-border/60 px-3 py-2 text-xs text-danger">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {current && current.reasoning.length > 1 ? (
        <Select
          value={reasoning ?? current.defaultReasoning ?? "provider-default"}
          disabled={disabled}
          onValueChange={(value) => {
            const effort = current.reasoning.find((entry) => entry === value);
            if (effort) onChange(current.id, effort);
          }}
        >
          <SelectPrimitive.Trigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Reasoning"
                title="Reasoning"
                className={triggerClass}
              />
            }
          >
            <Brain className="size-4" />
            <span className="hidden truncate @sm:inline">
              {effortLabel(reasoning ?? current.defaultReasoning ?? "provider-default")}
            </span>
            <ChevronDown className="size-3" />
          </SelectPrimitive.Trigger>
          <SelectContent>
            {current.reasoning.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effortLabel(effort)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
