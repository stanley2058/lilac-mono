import { memo, useDeferredValue, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { IconButton } from "./ui";
import { ProviderIcon, providerName } from "./ProviderIcon";

const EMPTY_FAVORITES: string[] = [];
type Props = {
  client?: NativeClient;
  models?: DisplayCatalog["models"];
  modelId?: string;
  reasoning?: ModelReasoning;
  disabled: boolean;
  onChange: (modelId: string, reasoning?: ModelReasoning) => void;
};

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
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const favorites = useQuery({
    queryKey: ["model-favorites"],
    queryFn: () => queryNativeRPC(client, (rpc) => rpc.catalogs.favorites({})),
    enabled: open && online,
    staleTime: 0,
  });
  const ids = favorites.data ?? EMPTY_FAVORITES;
  const catalog = useInfiniteQuery({
    queryKey: ["model-catalog", provider, deferredSearch, provider === "favorites" ? ids : null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      queryNativeRPC(client, (rpc) =>
        rpc.catalogs.models(
          {
            ...(provider && provider !== "favorites" ? { provider } : {}),
            ...(provider === "favorites" ? { ids } : {}),
            search: deferredSearch,
            cursor: pageParam,
          },
          { signal },
        ),
      ),
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && online,
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
      providers={catalog.data?.pages[0]?.providers ?? []}
      favorites={ids}
      open={open}
      onOpenChange={setOpen}
      provider={provider}
      onProviderChange={setProvider}
      search={search}
      onSearchChange={setSearch}
      onFavorite={(id) => favorite.mutate({ modelId: id, favorite: !ids.includes(id) })}
      favoritePending={favorite.isPending}
      loadMore={catalog.hasNextPage ? () => void catalog.fetchNextPage() : undefined}
      loading={catalog.isFetching}
      error={favorite.error?.message ?? catalog.error?.message}
    />
  );
}

export function ModelSelectorView({
  models,
  selected,
  providers,
  favorites,
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
  const [localProvider, setLocalProvider] = useState("");
  const [localSearch, setLocalSearch] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const provider = controlledProvider ?? localProvider;
  const search = controlledSearch ?? localSearch;
  const current = selected ?? models.find((model) => model.id === modelId);
  const visible = models.filter(
    (model) =>
      (!provider ||
        (provider === "favorites" ? favorites.includes(model.id) : model.provider === provider)) &&
      (!search || `${model.label} ${model.id}`.toLowerCase().includes(search.toLowerCase())),
  );
  const regular = visible.filter(
    (model) => !model.legacy || provider === "favorites" || Boolean(search),
  );
  const legacy = visible.filter((model) => model.legacy && provider !== "favorites" && !search);
  function select(model: CatalogModelChoice) {
    onChange(model.id, model.defaultReasoning ?? "provider-default");
    setOpen(false);
  }
  function row(model: CatalogModelChoice) {
    const starred = favorites.includes(model.id);
    return (
      <div
        key={model.id}
        className={`flex items-center gap-1 rounded-md ${model.id === current?.id ? "bg-accent" : "hover:bg-accent/60"}`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-3 py-2 text-left focus-visible:outline-ring"
          onClick={() => select(model)}
          aria-pressed={model.id === current?.id}
          title={
            model.alias
              ? `${model.alias} → ${model.provider}/${model.model}`
              : `${model.provider}/${model.model}`
          }
        >
          <span className="w-full truncate text-sm font-medium">{model.label}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProviderIcon provider={model.provider} className="size-3.5" />
            {providerName(model.provider)}
          </span>
        </button>
        <IconButton
          label={`${starred ? "Unfavorite" : "Favorite"} ${model.label}`}
          disabled={!onFavorite || favoritePending}
          onClick={() => onFavorite?.(model.id)}
          className="mr-1 shrink-0"
        >
          <Star className={`size-4 ${starred ? "fill-primary text-primary" : ""}`} />
        </IconButton>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id="composer-model"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label="Response model"
              className="max-w-64 min-w-0 gap-2 text-muted-foreground"
            />
          }
        >
          <ProviderIcon provider={current?.provider ?? ""} />
          <span className="truncate">{current?.label ?? modelId ?? "Model"}</span>
          <ChevronDown className="size-3 shrink-0" />
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)] p-1.5">
          <div className="flex min-h-64">
            <nav aria-label="Model providers" className="flex w-11 shrink-0 flex-col gap-1 pr-1">
              <IconButton
                label="Favorites"
                aria-pressed={provider === "favorites"}
                onClick={() => (onProviderChange ?? setLocalProvider)("favorites")}
              >
                <Star className={`size-5 ${provider === "favorites" ? "fill-current" : ""}`} />
              </IconButton>
              <IconButton
                label="All providers"
                aria-pressed={provider === ""}
                onClick={() => (onProviderChange ?? setLocalProvider)("")}
              >
                <Search className="size-5" />
              </IconButton>
              {providers.map((id) => (
                <IconButton
                  key={id}
                  label={providerName(id)}
                  aria-pressed={provider === id}
                  className={provider === id ? "bg-accent" : ""}
                  onClick={() => (onProviderChange ?? setLocalProvider)(id)}
                >
                  <ProviderIcon provider={id} className="size-5" />
                </IconButton>
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Input
                aria-label="Search models"
                placeholder="Search models…"
                value={search}
                onChange={(event) => (onSearchChange ?? setLocalSearch)(event.target.value)}
              />
              <div className="max-h-80 min-h-48 overflow-y-auto" aria-busy={loading}>
                {regular.map(row)}
                {legacy.length ? (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
                      aria-expanded={legacyOpen}
                      onClick={() => setLegacyOpen(!legacyOpen)}
                    >
                      {legacyOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                      Legacy models<span className="ml-auto text-xs">{legacy.length}</span>
                    </button>
                    {legacyOpen ? legacy.map(row) : null}
                  </>
                ) : null}
                {!visible.length ? (
                  <p className="px-3 py-4 text-sm text-muted-foreground">
                    {loading ? "Loading…" : "No models"}
                  </p>
                ) : null}
                {loadMore ? (
                  <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
                    More
                  </Button>
                ) : null}
              </div>
              {error ? (
                <p role="alert" className="text-xs text-destructive">
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
          <SelectTrigger
            aria-label="Reasoning"
            title="Reasoning"
            className="h-8 w-auto gap-1 border-0 bg-transparent text-xs text-muted-foreground"
          >
            <Brain className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {current.reasoning.map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort === "provider-default" ? "Default" : effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
