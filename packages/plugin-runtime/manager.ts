import { buildExternalToolPluginFreshnessKey, discoverExternalToolPlugins } from "./discovery";
import { loadToolPluginModule } from "./loader";
import type {
  Level1ToolSpec,
  LilacToolPlugin,
  LoadedToolPlugin,
  PluginLogger,
  ToolPluginCreateContext,
  ToolPluginStatus,
} from "./types";

function loggerCall(
  logger: PluginLogger | undefined,
  level: keyof PluginLogger,
  message: string,
  ...args: readonly unknown[]
): void {
  const fn = logger?.[level];
  if (typeof fn === "function") {
    fn.call(logger, message, ...args);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ToolPluginSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPluginSkipError";
  }
}

type LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
  loaded: LoadedToolPlugin<TLevel1, TLevel2>[];
  level1: TLevel1[];
  level2: TLevel2[];
  statuses: ToolPluginStatus[];
  freshnessKey: string;
  _runtime?: TRuntimeContext;
};

type TryLoadPluginResult<TLevel1, TLevel2> =
  | {
      kind: "loaded";
      loadedPlugin: LoadedToolPlugin<TLevel1, TLevel2>;
    }
  | {
      kind: "disabled";
      pluginId: string;
    }
  | {
      kind: "skipped";
      pluginId: string;
      reason: string;
    };

export type ToolPluginManagerOptions<TRuntimeContext, TLevel1, TLevel2> = {
  runtime: TRuntimeContext;
  dataDir: string;
  configPath?: string;
  logger?: PluginLogger;
  builtinPlugins?: readonly LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2>[];
  getDisabledPluginIds?: () => Promise<readonly string[]> | readonly string[];
  getPluginConfig?: (pluginId: string) => Promise<unknown> | unknown;
  getLevel1Name?: (spec: TLevel1) => string;
  getLevel2CallableIds?: (tool: TLevel2) => Promise<readonly string[]> | readonly string[];
  initLevel2Item?: (tool: TLevel2) => Promise<void> | void;
  destroyLevel2Item?: (tool: TLevel2) => Promise<void> | void;
};

export class ToolPluginManager<TRuntimeContext, TLevel1, TLevel2> {
  private readonly options: ToolPluginManagerOptions<TRuntimeContext, TLevel1, TLevel2>;
  private state: LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
    loaded: [],
    level1: [],
    level2: [],
    statuses: [],
    freshnessKey: "",
  };
  private initialized = false;

  constructor(options: ToolPluginManagerOptions<TRuntimeContext, TLevel1, TLevel2>) {
    this.options = options;
  }

  getLevel1Items(): readonly TLevel1[] {
    return this.state.level1;
  }

  getLevel1Tools(): readonly TLevel1[] {
    return this.getLevel1Items();
  }

  getLevel2Items(): readonly TLevel2[] {
    return this.state.level2;
  }

  getLevel2Tools(): readonly TLevel2[] {
    return this.getLevel2Items();
  }

  getStatuses(): readonly ToolPluginStatus[] {
    return this.state.statuses;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const next = await this.loadAll();
    this.state = next;
    this.initialized = true;
  }

  async destroy(): Promise<void> {
    await this.destroyLevel2Items(this.state.level2);
    await this.destroyLoaded(this.state.loaded);
    this.state = {
      loaded: [],
      level1: [],
      level2: [],
      statuses: [],
      freshnessKey: "",
    };
    this.initialized = false;
  }

  async reload(): Promise<void> {
    const prev = this.state;
    const next = await this.loadAll({
      cacheBustToken: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    this.state = next;
    this.initialized = true;
    await this.destroyLevel2Items(prev.level2);
    await this.destroyLoaded(prev.loaded);
  }

  async ensureFresh(): Promise<void> {
    if (!this.initialized) {
      await this.init();
      return;
    }

    const nextKey = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    if (nextKey === this.state.freshnessKey) return;

    loggerCall(this.options.logger, "info", "plugin freshness change detected; reloading plugins");
    await this.reload();
  }

  private async loadAll(options?: {
    cacheBustToken?: string;
  }): Promise<LoadedState<TRuntimeContext, TLevel1, TLevel2>> {
    const disabledPluginIds = new Set(await this.resolveDisabledPluginIds());
    const statuses: ToolPluginStatus[] = [];
    const loaded: LoadedToolPlugin<TLevel1, TLevel2>[] = [];
    const level1: TLevel1[] = [];
    const level2: TLevel2[] = [];
    const initializedLevel2: TLevel2[] = [];
    const seenPluginIds = new Set<string>();
    const seenLevel1Names = new Map<string, string>();
    const seenLevel2Ids = new Map<string, string>();
    const freshnessKey = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    const moduleCacheBustKey = options?.cacheBustToken
      ? `${freshnessKey}-${options.cacheBustToken}`
      : freshnessKey;

    try {
      for (const plugin of this.options.builtinPlugins ?? []) {
        const result = await this.tryLoadPlugin({
          plugin,
          source: "builtin",
          disabledPluginIds,
          pluginDir: undefined,
          entrypointPath: undefined,
        });
        if (result.kind === "disabled") {
          statuses.push({
            pluginId: result.pluginId,
            source: "builtin",
            state: "disabled",
            level1Names: [],
            level2Ids: [],
          });
          continue;
        }
        if (result.kind === "skipped") {
          statuses.push({
            pluginId: result.pluginId,
            source: "builtin",
            state: "skipped",
            reason: result.reason,
            level1Names: [],
            level2Ids: [],
          });
          continue;
        }

        const loadedPlugin = result.loadedPlugin;

        this.assertUniquePluginId(seenPluginIds, loadedPlugin.meta.id, "builtin");
        const callableIds = await this.registerContributionKeys({
          loadedPlugin,
          seenLevel1Names,
          seenLevel2Ids,
        });
        await this.initLevel2Items(loadedPlugin.level2);
        initializedLevel2.push(...loadedPlugin.level2);

        loaded.push(loadedPlugin);
        level1.push(...loadedPlugin.level1);
        level2.push(...loadedPlugin.level2);
        statuses.push({
          pluginId: loadedPlugin.meta.id,
          source: "builtin",
          state: "loaded",
          level1Names: loadedPlugin.level1.map((item) => this.getLevel1Name(item)),
          level2Ids: callableIds,
        });
      }

      for (const discovered of await discoverExternalToolPlugins({
        dataDir: this.options.dataDir,
      })) {
        if (discovered.type === "invalid") {
          statuses.push({
            pluginId: discovered.pluginId,
            source: "external",
            state: disabledPluginIds.has(discovered.pluginId) ? "disabled" : "failed",
            reason: disabledPluginIds.has(discovered.pluginId) ? undefined : discovered.reason,
            pluginDir: discovered.pluginDir,
            level1Names: [],
            level2Ids: [],
          });
          continue;
        }

        if (seenPluginIds.has(discovered.pluginId)) {
          statuses.push({
            pluginId: discovered.pluginId,
            source: "external",
            state: disabledPluginIds.has(discovered.pluginId) ? "disabled" : "failed",
            reason: disabledPluginIds.has(discovered.pluginId)
              ? undefined
              : `duplicate plugin id '${discovered.pluginId}'`,
            pluginDir: discovered.pluginDir,
            entrypointPath: discovered.entrypointPath,
            level1Names: [],
            level2Ids: [],
          });
          continue;
        }

        let loadedPlugin: LoadedToolPlugin<TLevel1, TLevel2> | null = null;
        try {
          const plugin = (await loadToolPluginModule({
            entrypointPath: discovered.entrypointPath,
            pluginDir: discovered.pluginDir,
            cacheBustKey: moduleCacheBustKey,
          })) as LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2>;

          if (plugin.meta.id !== discovered.pluginId) {
            throw new Error(
              `plugin meta.id '${plugin.meta.id}' must match directory name '${discovered.pluginId}'`,
            );
          }

          const result = await this.tryLoadPlugin({
            plugin,
            source: "external",
            disabledPluginIds,
            pluginDir: discovered.pluginDir,
            entrypointPath: discovered.entrypointPath,
          });
          if (result.kind === "disabled") {
            statuses.push({
              pluginId: discovered.pluginId,
              source: "external",
              state: "disabled",
              pluginDir: discovered.pluginDir,
              entrypointPath: discovered.entrypointPath,
              level1Names: [],
              level2Ids: [],
            });
            continue;
          }
          if (result.kind === "skipped") {
            statuses.push({
              pluginId: discovered.pluginId,
              source: "external",
              state: "skipped",
              reason: result.reason,
              pluginDir: discovered.pluginDir,
              entrypointPath: discovered.entrypointPath,
              level1Names: [],
              level2Ids: [],
            });
            continue;
          }
          loadedPlugin = result.loadedPlugin;
        } catch (error) {
          statuses.push({
            pluginId: discovered.pluginId,
            source: "external",
            state: disabledPluginIds.has(discovered.pluginId) ? "disabled" : "failed",
            reason: disabledPluginIds.has(discovered.pluginId) ? undefined : toErrorMessage(error),
            pluginDir: discovered.pluginDir,
            entrypointPath: discovered.entrypointPath,
            level1Names: [],
            level2Ids: [],
          });
          continue;
        }

        if (!loadedPlugin) {
          continue;
        }

        try {
          seenPluginIds.add(loadedPlugin.meta.id);
          const callableIds = await this.registerContributionKeys({
            loadedPlugin,
            seenLevel1Names,
            seenLevel2Ids,
          });
          await this.initLevel2Items(loadedPlugin.level2);
          initializedLevel2.push(...loadedPlugin.level2);

          loaded.push(loadedPlugin);
          level1.push(...loadedPlugin.level1);
          level2.push(...loadedPlugin.level2);
          statuses.push({
            pluginId: loadedPlugin.meta.id,
            source: "external",
            state: "loaded",
            pluginDir: loadedPlugin.pluginDir,
            entrypointPath: loadedPlugin.entrypointPath,
            level1Names: loadedPlugin.level1.map((item) => this.getLevel1Name(item)),
            level2Ids: callableIds,
          });
        } catch (error) {
          await this.destroyLoaded([loadedPlugin]);
          statuses.push({
            pluginId: loadedPlugin.meta.id,
            source: "external",
            state: "failed",
            reason: toErrorMessage(error),
            pluginDir: loadedPlugin.pluginDir,
            entrypointPath: loadedPlugin.entrypointPath,
            level1Names: [],
            level2Ids: [],
          });
        }
      }

      return {
        loaded,
        level1,
        level2,
        statuses,
        freshnessKey,
        _runtime: this.options.runtime,
      };
    } catch (error) {
      await this.destroyLevel2Items(initializedLevel2);
      await this.destroyLoaded(loaded);
      throw error;
    }
  }

  private async tryLoadPlugin(params: {
    plugin: LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2>;
    source: "builtin" | "external";
    disabledPluginIds: ReadonlySet<string>;
    pluginDir?: string;
    entrypointPath?: string;
  }): Promise<TryLoadPluginResult<TLevel1, TLevel2>> {
    const pluginId = params.plugin.meta.id;
    if (params.disabledPluginIds.has(pluginId)) {
      return {
        kind: "disabled",
        pluginId,
      };
    }

    const createContext: ToolPluginCreateContext<TRuntimeContext> = {
      runtime: this.options.runtime,
      dataDir: this.options.dataDir,
      pluginConfig: await this.resolvePluginConfig(pluginId),
      source: params.source,
      pluginDir: params.pluginDir,
      entrypointPath: params.entrypointPath,
      logger: this.options.logger,
    };

    try {
      const instance = await params.plugin.create(createContext);
      await instance.init?.();
      return {
        kind: "loaded",
        loadedPlugin: {
          plugin: params.plugin as LilacToolPlugin<unknown, TLevel1, TLevel2>,
          instance,
          meta: params.plugin.meta,
          source: params.source,
          pluginDir: params.pluginDir,
          entrypointPath: params.entrypointPath,
          level1: [...(instance.level1 ?? [])],
          level2: [...(instance.level2 ?? [])],
        },
      };
    } catch (error) {
      if (error instanceof ToolPluginSkipError) {
        loggerCall(this.options.logger, "info", `plugin skipped: ${pluginId}`, {
          reason: error.message,
          source: params.source,
        });
        return {
          kind: "skipped",
          pluginId,
          reason: error.message,
        };
      }

      if (params.source === "builtin") {
        throw error;
      }

      throw error;
    }
  }

  private async registerContributionKeys(params: {
    loadedPlugin: LoadedToolPlugin<TLevel1, TLevel2>;
    seenLevel1Names: Map<string, string>;
    seenLevel2Ids: Map<string, string>;
  }): Promise<string[]> {
    const level1Names = params.loadedPlugin.level1.map((item) => this.getLevel1Name(item));
    for (const name of level1Names) {
      const prior = params.seenLevel1Names.get(name);
      if (prior) {
        throw new Error(`duplicate Level 1 tool name '${name}' (already provided by '${prior}')`);
      }
      params.seenLevel1Names.set(name, params.loadedPlugin.meta.id);
    }

    const callableIds: string[] = [];
    for (const item of params.loadedPlugin.level2) {
      for (const callableId of await this.getLevel2CallableIds(item)) {
        const prior = params.seenLevel2Ids.get(callableId);
        if (prior) {
          throw new Error(
            `duplicate Level 2 callable id '${callableId}' (already provided by '${prior}')`,
          );
        }
        params.seenLevel2Ids.set(callableId, params.loadedPlugin.meta.id);
        callableIds.push(callableId);
      }
    }

    return callableIds;
  }

  private assertUniquePluginId(
    seenPluginIds: Set<string>,
    pluginId: string,
    source: "builtin" | "external",
  ): void {
    if (seenPluginIds.has(pluginId)) {
      throw new Error(`duplicate ${source} plugin id '${pluginId}'`);
    }
    seenPluginIds.add(pluginId);
  }

  private getLevel1Name(item: TLevel1): string {
    if (this.options.getLevel1Name) {
      return this.options.getLevel1Name(item);
    }

    if (
      typeof item === "object" &&
      item !== null &&
      "name" in item &&
      typeof (item as { name: unknown }).name === "string"
    ) {
      return (item as { name: string }).name;
    }

    throw new Error("getLevel1Name is required when Level 1 specs do not expose a string name");
  }

  private async getLevel2CallableIds(item: TLevel2): Promise<readonly string[]> {
    if (!this.options.getLevel2CallableIds) return [];
    return await this.options.getLevel2CallableIds(item);
  }

  private async resolveDisabledPluginIds(): Promise<readonly string[]> {
    return (await this.options.getDisabledPluginIds?.()) ?? [];
  }

  private async resolvePluginConfig(pluginId: string): Promise<unknown> {
    return (await this.options.getPluginConfig?.(pluginId)) ?? undefined;
  }

  private async destroyLoaded(
    loaded: readonly LoadedToolPlugin<TLevel1, TLevel2>[],
  ): Promise<void> {
    await Promise.allSettled(loaded.map((item) => item.instance.destroy?.() ?? Promise.resolve()));
  }

  private async initLevel2Items(items: readonly TLevel2[]): Promise<void> {
    if (!this.options.initLevel2Item) return;

    const initialized: TLevel2[] = [];
    try {
      for (const item of items) {
        await Promise.resolve(this.options.initLevel2Item?.(item));
        initialized.push(item);
      }
    } catch (error) {
      await this.destroyLevel2Items(initialized);
      throw error;
    }
  }

  private async destroyLevel2Items(items: readonly TLevel2[]): Promise<void> {
    if (!this.options.destroyLevel2Item) return;
    await Promise.allSettled(
      items.map((item) => Promise.resolve(this.options.destroyLevel2Item?.(item))),
    );
  }
}

export function isLevel1ToolSpec(value: unknown): value is Level1ToolSpec<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.createTool === "function" &&
    typeof record.isEnabled === "function"
  );
}
