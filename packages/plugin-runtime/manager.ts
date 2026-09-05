import { Result, type Panic, type Result as ResultType } from "better-result";

import {
  decodeDisabledPluginIds,
  decodeLevel1RegistrationKey,
  decodeToolPlugin,
  decodeToolPluginInstance,
  isPluginPanic,
  safePluginExceptionCause,
  type Level1ToolSpecCapabilitySnapshot,
  type ServerToolCapabilitySnapshot,
  type ToolPluginCapabilitySnapshot,
  type ToolPluginInstanceCapabilitySnapshot,
} from "./capabilities";
import {
  buildExternalToolPluginFreshnessKey,
  discoverExternalToolPlugins,
  type ExternalToolPluginDiscovery,
} from "./discovery";
import {
  ToolPluginCapabilityError,
  ToolPluginCleanupError,
  ToolPluginManagerHookError,
  ToolPluginOperationAndCleanupError,
  ToolPluginReloadCommittedCleanupError,
  ToolPluginRegistrationError,
  type ToolPluginCleanupFailure,
  type ToolPluginManagerError,
  type ToolPluginOperationError,
} from "./errors";
import {
  invokeLevel2Destroy,
  invokeLevel2Init,
  invokeLevel2List,
  invokeToolPluginCreate,
  invokeToolPluginInstanceDestroy,
  invokeToolPluginInstanceInit,
} from "./hooks";
import { loadToolPluginModuleCapability } from "./loader";
import type {
  Level1ContributionInfo,
  Level1RegistrationContext,
  Level1ToolSpec,
  Level2ContributionInfo,
  LilacToolPlugin,
  PluginLogger,
  PluginSource,
  ServerTool,
  ServerToolListResult,
  ToolPluginCreateContext,
  ToolPluginInstance,
  ToolPluginStatus,
} from "./types";

type LoadedPlugin<TRuntimeContext, TLevel1, TLevel2> = {
  readonly pluginId: string;
  readonly instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>;
  readonly meta: { readonly id: string; readonly name?: string; readonly version?: string };
  readonly source: PluginSource;
  readonly pluginDir?: string;
  readonly entrypointPath?: string;
  readonly level1: readonly TLevel1[];
  readonly level1Names: readonly string[];
  readonly level1Capabilities: ReadonlyMap<
    TLevel1,
    Level1ToolSpecCapabilitySnapshot<TRuntimeContext>
  >;
  readonly level2: readonly TLevel2[];
  readonly level2Capabilities: ReadonlyMap<TLevel2, ServerToolCapabilitySnapshot>;
  readonly initializedLevel2: ServerToolCapabilitySnapshot[];
};

type CleanupState = {
  readonly failures: ToolPluginCleanupFailure[];
  panic?: Panic;
};

type LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
  readonly loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[];
  readonly level1: readonly TLevel1[];
  readonly level2: readonly TLevel2[];
  readonly statuses: readonly ToolPluginStatus[];
  readonly freshnessKey: string;
};

type GenerationLifetime = {
  holders: number;
  retired: boolean;
  cleanup?: Promise<ResultType<void, ToolPluginCleanupError>>;
};

type LoadedOutcome<TRuntimeContext, TLevel1, TLevel2> =
  | { readonly kind: "loaded"; readonly plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2> }
  | { readonly kind: "disabled"; readonly pluginId: string }
  | { readonly kind: "skipped"; readonly pluginId: string; readonly reason: string };

const level1ContributionSnapshots = new WeakMap<object, Level1ContributionInfo>();

function continueResult<T, E, ROk, RErr>(
  result: ResultType<T, E>,
  branches: { ok: (value: T) => ROk; err: (error: E) => RErr },
): ROk | RErr {
  const continuation = result.match<() => ROk | RErr>({
    ok: (value) => () => branches.ok(value),
    err: (error) => () => branches.err(error),
  });
  return continuation();
}

export function getLevel1ContributionSnapshot(
  spec: Level1ToolSpec<unknown>,
): Level1ContributionInfo | undefined {
  return level1ContributionSnapshots.get(spec);
}

export type ToolPluginManagerOptions<
  TRuntimeContext,
  TLevel1 extends Level1ToolSpec<TRuntimeContext>,
  TLevel2 extends ServerTool,
> = {
  runtime: TRuntimeContext;
  dataDir: string;
  configPath?: string;
  logger?: PluginLogger;
  builtinPlugins?: readonly LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2>[];
  getDisabledPluginIds?: () => Promise<readonly string[]> | readonly string[];
  getPluginConfig?: (pluginId: string) => Promise<unknown> | unknown;
  getLevel1RegistrationKey?: (
    spec: TLevel1,
    context: Level1RegistrationContext,
    capturedName: string,
  ) => string;
  adaptLevel1Item: (
    spec: Level1ToolSpec<TRuntimeContext>,
    context: Level1RegistrationContext,
  ) => TLevel1;
  adaptLevel2Item: (tool: ServerTool, context: Level1RegistrationContext) => TLevel2;
};

type PluginManagerHookExceptionParams = {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  cause: Error;
};

export function mapPluginManagerHookException(
  params: PluginManagerHookExceptionParams,
): ToolPluginManagerHookError {
  return new ToolPluginManagerHookError({
    hook: params.hook,
    pluginId: params.pluginId,
    cause: params.cause,
    message: `Plugin manager ${params.hook} failed${params.pluginId ? ` for '${params.pluginId}'` : ""}: ${params.cause.message}`,
  });
}

async function captureManagerHook<T>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<T> | T;
}): Promise<ResultType<T, ToolPluginManagerHookError>>;
async function captureManagerHook<TInput, TOutput, E>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<TInput> | TInput;
  continueWith: (
    value: Awaited<TInput>,
  ) => Promise<ResultType<TOutput, E>> | ResultType<TOutput, E>;
}): Promise<ResultType<TOutput, ToolPluginManagerHookError | E>>;
async function captureManagerHook<TInput, TOutput = TInput, E = never>(params: {
  hook: ToolPluginManagerHookError["hook"];
  pluginId?: string;
  run: () => Promise<TInput> | TInput;
  continueWith?: (
    value: Awaited<TInput>,
  ) => Promise<ResultType<TOutput, E>> | ResultType<TOutput, E>;
}): Promise<ResultType<Awaited<TInput> | TOutput, ToolPluginManagerHookError | E>> {
  const captured = await Result.tryPromise({
    try: async () => {
      const value = await params.run();
      return params.continueWith ? await params.continueWith(value) : Result.ok(value);
    },
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const outcome = captured.match<
    | { readonly kind: "result"; readonly result: ResultType<Awaited<TInput> | TOutput, E> }
    | { readonly kind: "failure"; readonly restoreCause: () => unknown }
  >({
    ok: (result) => ({ kind: "result", result }),
    err: ({ restoreCause }) => ({ kind: "failure", restoreCause }),
  });
  if (outcome.kind === "result") return outcome.result;
  const cause = outcome.restoreCause();
  if (isPluginPanic(cause)) throw cause;
  return Result.err(
    mapPluginManagerHookException({
      ...params,
      cause: safePluginExceptionCause(cause),
    }),
  );
}

function cleanupError(failures: readonly ToolPluginCleanupFailure[]): ToolPluginCleanupError {
  return new ToolPluginCleanupError({
    failures,
    message: `Plugin cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`,
  });
}

function combineOperationAndCleanup(
  primary: ToolPluginOperationError,
  cleanup: ResultType<void, ToolPluginCleanupError>,
): ToolPluginManagerError {
  return continueResult(cleanup, {
    ok: () => primary,
    err: (error) =>
      new ToolPluginOperationAndCleanupError({
        primary,
        cleanup: error,
        message: `${primary.message}; cleanup also failed: ${error.message}`,
      }),
  });
}

function appendCleanup(
  error: ToolPluginManagerError,
  cleanup: ResultType<void, ToolPluginCleanupError>,
): ToolPluginManagerError {
  return continueResult(cleanup, {
    ok: () => error,
    err: (cleanupFailure) => {
      if (error._tag === "ToolPluginCleanupError") {
        return cleanupError([...error.failures, ...cleanupFailure.failures]);
      }
      if (error._tag === "ToolPluginOperationAndCleanupError") {
        const combinedCleanup = cleanupError([
          ...error.cleanup.failures,
          ...cleanupFailure.failures,
        ]);
        return new ToolPluginOperationAndCleanupError({
          primary: error.primary,
          cleanup: combinedCleanup,
          message: `${error.primary.message}; cleanup also failed: ${combinedCleanup.message}`,
        });
      }
      if (error._tag === "ToolPluginReloadCommittedCleanupError") {
        const combinedCleanup = cleanupError([
          ...error.cleanup.failures,
          ...cleanupFailure.failures,
        ]);
        return new ToolPluginReloadCommittedCleanupError({
          cleanup: combinedCleanup,
          message: `Plugin reload committed, but cleanup failed: ${combinedCleanup.message}`,
        });
      }
      return new ToolPluginOperationAndCleanupError({
        primary: error,
        cleanup: cleanupFailure,
        message: `${error.message}; cleanup also failed: ${cleanupFailure.message}`,
      });
    },
  });
}

function cleanupRejectionError<TCause>(pluginId: string, cause: TCause): ToolPluginCapabilityError {
  const safeCause = safePluginExceptionCause(cause);
  const message = `Plugin manager adaptLevel2Item failed for '${pluginId}': ${safeCause.message}`;
  return new ToolPluginCapabilityError({
    capability: "hook_result",
    pluginId,
    issues: [message],
    cause: safeCause,
    message,
  });
}

export class ToolPluginManager<
  TRuntimeContext,
  TLevel1 extends Level1ToolSpec<TRuntimeContext>,
  TLevel2 extends ServerTool,
> {
  private state: LoadedState<TRuntimeContext, TLevel1, TLevel2> = {
    loaded: [],
    level1: [],
    level2: [],
    statuses: [],
    freshnessKey: "",
  };
  private initialized = false;
  private readonly generations = new WeakMap<
    LoadedState<TRuntimeContext, TLevel1, TLevel2>,
    GenerationLifetime
  >();

  constructor(
    private readonly options: ToolPluginManagerOptions<TRuntimeContext, TLevel1, TLevel2>,
  ) {}

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

  getLevel2ContributionInfo(): ReadonlyMap<TLevel2, Level2ContributionInfo> {
    const result = new Map<TLevel2, Level2ContributionInfo>();
    for (const plugin of this.state.loaded) {
      for (const item of plugin.level2) {
        result.set(item, { pluginId: plugin.pluginId, source: plugin.source });
      }
    }
    return result;
  }

  getLevel2Capabilities(): ReadonlyMap<TLevel2, ServerToolCapabilitySnapshot> {
    const result = new Map<TLevel2, ServerToolCapabilitySnapshot>();
    for (const plugin of this.state.loaded) {
      for (const [item, capability] of plugin.level2Capabilities) result.set(item, capability);
    }
    return result;
  }

  getLevel1ContributionInfo(): ReadonlyMap<TLevel1, Level1ContributionInfo> {
    const result = new Map<TLevel1, Level1ContributionInfo>();
    for (const plugin of this.state.loaded) {
      for (const item of plugin.level1) {
        result.set(item, { pluginId: plugin.pluginId, source: plugin.source });
      }
    }
    return result;
  }

  getLevel1Capabilities(): ReadonlyMap<TLevel1, Level1ToolSpecCapabilitySnapshot<TRuntimeContext>> {
    const result = new Map<TLevel1, Level1ToolSpecCapabilitySnapshot<TRuntimeContext>>();
    for (const plugin of this.state.loaded) {
      for (const [item, capability] of plugin.level1Capabilities) result.set(item, capability);
    }
    return result;
  }

  getStatuses(): readonly ToolPluginStatus[] {
    return this.state.statuses;
  }

  acquireGeneration() {
    const state = this.state;
    const lifetime = this.generationLifetime(state);
    lifetime.holders++;
    let released = false;
    return {
      level1: state.level1,
      level1ContributionInfo: this.getLevel1ContributionInfo(),
      level1Capabilities: this.getLevel1Capabilities(),
      level2: state.level2,
      level2ContributionInfo: this.getLevel2ContributionInfo(),
      level2Capabilities: this.getLevel2Capabilities(),
      release: async (): Promise<ResultType<void, ToolPluginCleanupError>> => {
        if (released) return Result.ok();
        released = true;
        lifetime.holders--;
        return this.cleanupRetiredGeneration(state, lifetime);
      },
    };
  }

  private generationLifetime(state: LoadedState<TRuntimeContext, TLevel1, TLevel2>) {
    const existing = this.generations.get(state);
    if (existing) return existing;
    const lifetime: GenerationLifetime = { holders: 0, retired: false };
    this.generations.set(state, lifetime);
    return lifetime;
  }

  private retireGeneration(
    state: LoadedState<TRuntimeContext, TLevel1, TLevel2>,
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    const lifetime = this.generationLifetime(state);
    lifetime.retired = true;
    return this.cleanupRetiredGeneration(state, lifetime);
  }

  private async cleanupRetiredGeneration(
    state: LoadedState<TRuntimeContext, TLevel1, TLevel2>,
    lifetime: GenerationLifetime,
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    if (!lifetime.retired || lifetime.holders > 0) return Result.ok();
    lifetime.cleanup ??= this.destroyLoaded(state.loaded);
    return lifetime.cleanup;
  }

  async init(): Promise<ResultType<void, ToolPluginManagerError>> {
    if (this.initialized) return Result.ok();
    const next = await this.loadAll();
    return continueResult(next, {
      ok: (nextState) => {
        this.state = nextState;
        this.initialized = true;
        return Result.ok();
      },
      err: (error) => Result.err(error),
    });
  }

  async destroy(): Promise<ResultType<void, ToolPluginCleanupError>> {
    const previous = this.state;
    this.state = { loaded: [], level1: [], level2: [], statuses: [], freshnessKey: "" };
    this.initialized = false;
    return this.retireGeneration(previous);
  }

  async reload(): Promise<ResultType<void, ToolPluginManagerError>> {
    const next = await this.loadAll({
      cacheBustToken: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    let nextState!: LoadedState<TRuntimeContext, TLevel1, TLevel2>;
    let nextError: ToolPluginManagerError | undefined;
    continueResult(next, {
      ok: (value) => {
        nextState = value;
      },
      err: (error) => {
        nextError = error;
      },
    });
    if (nextError !== undefined) return Result.err(nextError);

    const previous = this.state;
    this.state = nextState;
    this.initialized = true;
    const cleanup = await this.retireGeneration(previous);
    return continueResult(cleanup, {
      ok: () => Result.ok(undefined),
      err: (error) =>
        Result.err(
          new ToolPluginReloadCommittedCleanupError({
            cleanup: error,
            message: `Plugin reload committed, but previous plugin cleanup failed: ${error.message}`,
          }),
        ),
    });
  }

  async ensureFresh(): Promise<ResultType<void, ToolPluginManagerError>> {
    if (!this.initialized) return this.init();
    const nextKey = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    return continueResult(nextKey, {
      ok: (freshnessKey) =>
        freshnessKey === this.state.freshnessKey ? Result.ok() : this.reload(),
      err: (error) => Result.err(error),
    });
  }

  private async loadAll(options?: {
    cacheBustToken?: string;
  }): Promise<ResultType<LoadedState<TRuntimeContext, TLevel1, TLevel2>, ToolPluginManagerError>> {
    const disabled = await this.resolveDisabledPluginIds();
    let disabledIds!: readonly string[];
    let disabledError: ToolPluginManagerError | undefined;
    continueResult(disabled, {
      ok: (value) => {
        disabledIds = value;
      },
      err: (error) => {
        disabledError = error;
      },
    });
    if (disabledError !== undefined) return Result.err(disabledError);
    const disabledPluginIds = new Set(disabledIds);

    const freshness = await buildExternalToolPluginFreshnessKey({
      dataDir: this.options.dataDir,
      configPath: this.options.configPath,
    });
    let freshnessKey!: string;
    let freshnessError: ToolPluginManagerError | undefined;
    continueResult(freshness, {
      ok: (value) => {
        freshnessKey = value;
      },
      err: (error) => {
        freshnessError = error;
      },
    });
    if (freshnessError !== undefined) return Result.err(freshnessError);
    const moduleCacheBustKey = options?.cacheBustToken
      ? `${freshnessKey}-${options.cacheBustToken}`
      : freshnessKey;

    const statuses: ToolPluginStatus[] = [];
    const loaded: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[] = [];
    const level1: TLevel1[] = [];
    const level2: TLevel2[] = [];
    const seenPluginIds = new Set<string>();
    const seenLevel1Names = new Map<string, string>();
    const seenLevel2Ids = new Map<string, string>();

    for (const candidate of this.options.builtinPlugins ?? []) {
      const decoded = decodeToolPlugin<TRuntimeContext>(candidate);
      let plugin!: ToolPluginCapabilitySnapshot<TRuntimeContext>;
      let decodeError: ToolPluginCapabilityError | undefined;
      continueResult(decoded, {
        ok: (value) => {
          plugin = value;
        },
        err: (error) => {
          decodeError = error;
        },
      });
      if (decodeError !== undefined) return this.failLoad(decodeError, loaded);
      const outcome = await this.tryLoadPlugin({
        plugin,
        source: "builtin",
        disabledPluginIds,
      });
      let loadedOutcome!: LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>;
      let loadError: ToolPluginManagerError | undefined;
      continueResult(outcome, {
        ok: (value) => {
          loadedOutcome = value;
        },
        err: (error) => {
          loadError = error;
        },
      });
      if (loadError !== undefined) return this.failLoad(loadError, loaded);
      if (loadedOutcome.kind !== "loaded") {
        statuses.push(this.outcomeStatus(loadedOutcome, "builtin"));
        continue;
      }
      const registered = await this.registerPluginPreservingPanic(
        {
          plugin: loadedOutcome.plugin,
          seenPluginIds,
          seenLevel1Names,
          seenLevel2Ids,
        },
        loaded,
      );
      let callableIds!: readonly string[];
      let registrationError: ToolPluginManagerError | undefined;
      continueResult(registered, {
        ok: (value) => {
          callableIds = value;
        },
        err: (error) => {
          registrationError = error;
        },
      });
      if (registrationError !== undefined) {
        const ownCleanup = await this.destroyLoaded([loadedOutcome.plugin]);
        const primary = appendCleanup(registrationError, ownCleanup);
        return this.failLoad(primary, loaded);
      }
      loaded.push(loadedOutcome.plugin);
      level1.push(...loadedOutcome.plugin.level1);
      level2.push(...loadedOutcome.plugin.level2);
      statuses.push(this.loadedStatus(loadedOutcome.plugin, callableIds));
    }

    const discovered = await discoverExternalToolPlugins({ dataDir: this.options.dataDir });
    let discoveredEntries: readonly ExternalToolPluginDiscovery[] = [];
    let discoveryError: ToolPluginManagerError | undefined;
    continueResult(discovered, {
      ok: (value) => {
        discoveredEntries = value;
      },
      err: (error) => {
        discoveryError = error;
      },
    });
    if (discoveryError !== undefined) return this.failLoad(discoveryError, loaded);
    for (const entry of discoveredEntries) {
      if (entry.type === "invalid") {
        statuses.push({
          pluginId: entry.pluginId,
          source: "external",
          state: disabledPluginIds.has(entry.pluginId) ? "disabled" : "failed",
          reason: disabledPluginIds.has(entry.pluginId) ? undefined : entry.reason,
          pluginDir: entry.pluginDir,
          level1Names: [],
          level2Ids: [],
        });
        continue;
      }
      if (seenPluginIds.has(entry.pluginId)) {
        statuses.push({
          pluginId: entry.pluginId,
          source: "external",
          state: disabledPluginIds.has(entry.pluginId) ? "disabled" : "failed",
          reason: disabledPluginIds.has(entry.pluginId)
            ? undefined
            : `duplicate plugin id '${entry.pluginId}'`,
          pluginDir: entry.pluginDir,
          entrypointPath: entry.entrypointPath,
          level1Names: [],
          level2Ids: [],
        });
        continue;
      }

      const module = await loadToolPluginModuleCapability<TRuntimeContext>({
        entrypointPath: entry.entrypointPath,
        pluginDir: entry.pluginDir,
        cacheBustKey: moduleCacheBustKey,
      });
      let moduleCapability!: ToolPluginCapabilitySnapshot<TRuntimeContext>;
      let moduleError: ToolPluginManagerError | undefined;
      continueResult(module, {
        ok: (value) => {
          moduleCapability = value;
        },
        err: (error) => {
          moduleError = error;
        },
      });
      if (moduleError !== undefined) {
        statuses.push(this.failedExternalStatus(entry, moduleError.message, disabledPluginIds));
        continue;
      }
      if (moduleCapability.meta.id !== entry.pluginId) {
        statuses.push(
          this.failedExternalStatus(
            entry,
            `plugin meta.id '${moduleCapability.meta.id}' must match directory name '${entry.pluginId}'`,
            disabledPluginIds,
          ),
        );
        continue;
      }

      const outcome = await this.tryLoadPlugin({
        plugin: moduleCapability,
        source: "external",
        disabledPluginIds,
        pluginDir: entry.pluginDir,
        entrypointPath: entry.entrypointPath,
      });
      let loadedOutcome!: LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>;
      let loadError: ToolPluginManagerError | undefined;
      continueResult(outcome, {
        ok: (value) => {
          loadedOutcome = value;
        },
        err: (error) => {
          loadError = error;
        },
      });
      if (loadError !== undefined) {
        statuses.push(this.failedExternalStatus(entry, loadError.message, disabledPluginIds));
        continue;
      }
      if (loadedOutcome.kind !== "loaded") {
        statuses.push(
          this.outcomeStatus(loadedOutcome, "external", entry.pluginDir, entry.entrypointPath),
        );
        continue;
      }

      const registered = await this.registerPluginPreservingPanic(
        {
          plugin: loadedOutcome.plugin,
          seenPluginIds,
          seenLevel1Names,
          seenLevel2Ids,
        },
        loaded,
      );
      let callableIds!: readonly string[];
      let registrationError: ToolPluginManagerError | undefined;
      continueResult(registered, {
        ok: (value) => {
          callableIds = value;
        },
        err: (error) => {
          registrationError = error;
        },
      });
      if (registrationError !== undefined) {
        const ownCleanup = await this.destroyLoaded([loadedOutcome.plugin]);
        const failure = appendCleanup(registrationError, ownCleanup);
        statuses.push(this.failedExternalStatus(entry, failure.message, disabledPluginIds));
        continue;
      }
      loaded.push(loadedOutcome.plugin);
      level1.push(...loadedOutcome.plugin.level1);
      level2.push(...loadedOutcome.plugin.level2);
      statuses.push(this.loadedStatus(loadedOutcome.plugin, callableIds));
    }

    return Result.ok({
      loaded,
      level1,
      level2,
      statuses,
      freshnessKey,
    });
  }

  private async failLoad(
    error: ToolPluginManagerError,
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<never, ToolPluginManagerError>> {
    const cleanup = await this.destroyLoaded(loaded);
    return Result.err(appendCleanup(error, cleanup));
  }

  private async tryLoadPlugin(params: {
    plugin: ToolPluginCapabilitySnapshot<TRuntimeContext>;
    source: PluginSource;
    disabledPluginIds: ReadonlySet<string>;
    pluginDir?: string;
    entrypointPath?: string;
  }): Promise<
    ResultType<LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>, ToolPluginManagerError>
  > {
    const pluginId = params.plugin.meta.id;
    if (params.disabledPluginIds.has(pluginId)) {
      return Result.ok({ kind: "disabled", pluginId });
    }

    const createWithConfig = <TPluginConfig>(pluginConfig: TPluginConfig) => {
      const createContext: ToolPluginCreateContext<TRuntimeContext> = {
        runtime: this.options.runtime,
        dataDir: this.options.dataDir,
        pluginConfig,
        source: params.source,
        pluginDir: params.pluginDir,
        entrypointPath: params.entrypointPath,
        logger: this.options.logger,
      };
      return invokeToolPluginCreate({
        capability: params.plugin,
        context: createContext,
        source: params.source,
      });
    };
    const created = this.options.getPluginConfig
      ? await captureManagerHook({
          hook: "getPluginConfig",
          pluginId,
          run: () => this.options.getPluginConfig!(pluginId),
          continueWith: createWithConfig,
        })
      : await createWithConfig(undefined);
    const decodeCreated = Result.match<
      ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>,
      ToolPluginManagerError,
      () => ResultType<
        ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
        ToolPluginManagerError
      >
    >(created, {
      ok: (value) => () => decodeToolPluginInstance<TRuntimeContext>(pluginId, value),
      err: (error) => () => Result.err(error),
    });
    const instanceResult = decodeCreated();
    let instance!: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>;
    let instanceError: ToolPluginManagerError | undefined;
    continueResult(instanceResult, {
      ok: (value) => {
        instance = value;
      },
      err: (error) => {
        instanceError = error;
      },
    });
    if (instanceError !== undefined) {
      if (instanceError._tag === "ToolPluginSkipped") {
        return Result.ok({ kind: "skipped", pluginId, reason: instanceError.reason });
      }
      return Result.err(instanceError);
    }

    const initialized = await invokeToolPluginInstanceInit({
      pluginId,
      source: params.source,
      capability: instance,
    });
    let initializationError: ToolPluginOperationError | undefined;
    continueResult(initialized, {
      ok: () => undefined,
      err: (error) => {
        initializationError = error;
      },
    });
    if (initializationError !== undefined) {
      if (initializationError._tag === "ToolPluginSkipped") {
        const cleanup = await this.destroyInstance(pluginId, params.source, instance);
        let cleanupFailed = false;
        continueResult(cleanup, {
          ok: () => undefined,
          err: () => {
            cleanupFailed = true;
          },
        });
        if (cleanupFailed) {
          return Result.err(combineOperationAndCleanup(initializationError, cleanup));
        }
        return Result.ok({ kind: "skipped", pluginId, reason: initializationError.reason });
      }
      const cleanup = await this.destroyInstance(pluginId, params.source, instance);
      return Result.err(combineOperationAndCleanup(initializationError, cleanup));
    }

    const context = { pluginId, source: params.source } satisfies Level1RegistrationContext;
    const adaptedLevel1: TLevel1[] = [];
    const level1Capabilities = new Map<
      TLevel1,
      Level1ToolSpecCapabilitySnapshot<TRuntimeContext>
    >();
    for (const capability of instance.level1) {
      const item = capability.spec;
      const adapted = await captureManagerHook({
        hook: "adaptLevel1Item",
        pluginId,
        run: () => this.options.adaptLevel1Item(item, context),
      });
      let adaptedItem!: TLevel1;
      let adaptationError: ToolPluginManagerHookError | undefined;
      continueResult(adapted, {
        ok: (value) => {
          adaptedItem = value;
        },
        err: (error) => {
          adaptationError = error;
        },
      });
      if (adaptationError !== undefined) {
        return this.cleanupFailedInstance(adaptationError, pluginId, params.source, instance);
      }
      if (!Object.is(adaptedItem, item)) {
        const error = mapPluginManagerHookException({
          hook: "adaptLevel1Item",
          pluginId,
          cause: new Error("adapter must preserve the original object identity"),
        });
        return this.cleanupFailedInstance(error, pluginId, params.source, instance);
      }
      adaptedLevel1.push(adaptedItem);
      level1Capabilities.set(adaptedItem, capability);
      level1ContributionSnapshots.set(adaptedItem, context);
    }

    const adaptedLevel2: TLevel2[] = [];
    const level2Capabilities = new Map<TLevel2, ServerToolCapabilitySnapshot>();
    for (const capability of instance.level2) {
      const item = capability.tool;
      const adapted = await captureManagerHook({
        hook: "adaptLevel2Item",
        pluginId,
        run: () => this.options.adaptLevel2Item(item, context),
      });
      let adaptedItem!: TLevel2;
      let adaptationError: ToolPluginManagerHookError | undefined;
      continueResult(adapted, {
        ok: (value) => {
          adaptedItem = value;
        },
        err: (error) => {
          adaptationError = error;
        },
      });
      if (adaptationError !== undefined) {
        return this.cleanupFailedInstance(adaptationError, pluginId, params.source, instance);
      }
      if (!Object.is(adaptedItem, item)) {
        const error = mapPluginManagerHookException({
          hook: "adaptLevel2Item",
          pluginId,
          cause: new Error("adapter must preserve the original object identity"),
        });
        return this.cleanupFailedInstance(error, pluginId, params.source, instance);
      }
      adaptedLevel2.push(adaptedItem);
      level2Capabilities.set(adaptedItem, capability);
    }

    return Result.ok({
      kind: "loaded",
      plugin: {
        pluginId,
        instance,
        meta: params.plugin.meta,
        source: params.source,
        pluginDir: params.pluginDir,
        entrypointPath: params.entrypointPath,
        level1: adaptedLevel1,
        level1Names: instance.level1.map((capability) => capability.name),
        level1Capabilities,
        level2: adaptedLevel2,
        level2Capabilities,
        initializedLevel2: [],
      },
    });
  }

  private async cleanupFailedInstance(
    primary: ToolPluginOperationError,
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<ResultType<never, ToolPluginManagerError>> {
    const cleanup = await this.destroyInstance(pluginId, source, instance);
    return Result.err(combineOperationAndCleanup(primary, cleanup));
  }

  private async registerPlugin(params: {
    plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>;
    seenPluginIds: Set<string>;
    seenLevel1Names: Map<string, string>;
    seenLevel2Ids: Map<string, string>;
  }): Promise<ResultType<readonly string[], ToolPluginManagerError>> {
    const pluginId = params.plugin.pluginId;
    if (params.seenPluginIds.has(pluginId)) {
      return Result.err(
        new ToolPluginRegistrationError({
          pluginId,
          source: params.plugin.source,
          contribution: "plugin",
          key: pluginId,
          priorPluginId: pluginId,
          message: `duplicate ${params.plugin.source} plugin id '${pluginId}'`,
        }),
      );
    }

    const context = { pluginId, source: params.plugin.source } satisfies Level1RegistrationContext;
    const level1Keys: string[] = [];
    for (const item of params.plugin.level1) {
      const capability = params.plugin.level1Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level1",
            pluginId,
            issues: ["captured Level 1 capability was unavailable"],
            message: `Captured Level 1 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      if (!this.options.getLevel1RegistrationKey) {
        level1Keys.push(capability.name);
        continue;
      }
      const resolved = await captureManagerHook({
        hook: "getLevel1RegistrationKey",
        pluginId,
        run: () => this.options.getLevel1RegistrationKey!(item, context, capability.name),
      });
      let rawRegistrationKey!: string;
      let registrationError: ToolPluginManagerError | undefined;
      continueResult(resolved, {
        ok: (value) => {
          rawRegistrationKey = value;
        },
        err: (error) => {
          registrationError = error;
        },
      });
      if (registrationError !== undefined) return Result.err(registrationError);
      const decodedKey = decodeLevel1RegistrationKey(pluginId, rawRegistrationKey);
      let registrationKey!: string;
      continueResult(decodedKey, {
        ok: (value) => {
          registrationKey = value;
        },
        err: (error) => {
          registrationError = error;
        },
      });
      if (registrationError !== undefined) return Result.err(registrationError);
      level1Keys.push(registrationKey);
    }

    for (const item of params.plugin.level2) {
      const capability = params.plugin.level2Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level2",
            pluginId,
            issues: ["captured Level 2 capability was unavailable"],
            message: `Captured Level 2 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      const result = await invokeLevel2Init({
        pluginId,
        source: params.plugin.source,
        tool: item,
        capability,
      });
      let initializationError: ToolPluginManagerError | undefined;
      continueResult(result, {
        ok: () => undefined,
        err: (error) => {
          initializationError = error;
        },
      });
      if (initializationError !== undefined) return Result.err(initializationError);
      params.plugin.initializedLevel2.push(capability);
    }

    const callableIds: string[] = [];
    for (const item of params.plugin.level2) {
      const capability = params.plugin.level2Capabilities.get(item);
      if (!capability) {
        return Result.err(
          new ToolPluginCapabilityError({
            capability: "level2",
            pluginId,
            issues: ["captured Level 2 capability was unavailable"],
            message: `Captured Level 2 capability was unavailable for plugin '${pluginId}'`,
          }),
        );
      }
      const listed = await invokeLevel2List({
        pluginId,
        source: params.plugin.source,
        tool: item,
        capability,
      });
      let entries!: ServerToolListResult;
      let listError: ToolPluginManagerError | undefined;
      continueResult(listed, {
        ok: (value) => {
          entries = value;
        },
        err: (error) => {
          listError = error;
        },
      });
      if (listError !== undefined) return Result.err(listError);
      callableIds.push(...entries.map((entry) => entry.callableId));
    }

    const localLevel1 = new Set<string>();
    for (const key of level1Keys) {
      const prior = params.seenLevel1Names.get(key);
      if (prior || localLevel1.has(key)) {
        return Result.err(
          new ToolPluginRegistrationError({
            pluginId,
            source: params.plugin.source,
            contribution: "level1",
            key,
            priorPluginId: prior ?? pluginId,
            message: `duplicate Level 1 registration key '${key}' (already provided by '${prior ?? pluginId}')`,
          }),
        );
      }
      localLevel1.add(key);
    }
    const localLevel2 = new Set<string>();
    for (const callableId of callableIds) {
      const prior = params.seenLevel2Ids.get(callableId);
      if (prior || localLevel2.has(callableId)) {
        return Result.err(
          new ToolPluginRegistrationError({
            pluginId,
            source: params.plugin.source,
            contribution: "level2",
            key: callableId,
            priorPluginId: prior ?? pluginId,
            message: `duplicate Level 2 callable id '${callableId}' (already provided by '${prior ?? pluginId}')`,
          }),
        );
      }
      localLevel2.add(callableId);
    }

    params.seenPluginIds.add(pluginId);
    for (const key of level1Keys) params.seenLevel1Names.set(key, pluginId);
    for (const callableId of callableIds) params.seenLevel2Ids.set(callableId, pluginId);
    return Result.ok(callableIds);
  }

  private async registerPluginPreservingPanic(
    params: Parameters<ToolPluginManager<TRuntimeContext, TLevel1, TLevel2>["registerPlugin"]>[0],
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<readonly string[], ToolPluginManagerError>> {
    const [registered] = await Promise.allSettled([this.registerPlugin(params)]);
    if (registered.status === "fulfilled") return registered.value;
    if (!isPluginPanic(registered.reason)) {
      return Result.err(
        mapPluginManagerHookException({
          hook: "adaptLevel2Item",
          pluginId: params.plugin.pluginId,
          cause: safePluginExceptionCause(registered.reason),
        }),
      );
    }

    const [cleanup] = await Promise.allSettled([this.destroyLoaded([...loaded, params.plugin])]);
    await this.reportCleanupFailureAfterPanic(params.plugin.pluginId, cleanup);
    throw registered.reason;
  }

  private async reportCleanupFailureAfterPanic(
    pluginId: string,
    cleanup: PromiseSettledResult<ResultType<void, ToolPluginCleanupError>>,
  ): Promise<void> {
    const report = this.options.logger?.error;
    if (!report) return;

    let detail = "cleanup rejected with Panic";
    if (cleanup.status === "fulfilled") {
      let cleanupFailure: ToolPluginCleanupError | undefined;
      continueResult(cleanup.value, {
        ok: () => undefined,
        err: (error) => {
          cleanupFailure = error;
        },
      });
      if (cleanupFailure === undefined) return;
      detail = cleanupFailure.message;
    }
    await Promise.allSettled([
      Promise.resolve().then(() =>
        report.call(this.options.logger, "Plugin cleanup failed after operation Panic", {
          pluginId,
          detail,
        }),
      ),
    ]);
  }

  private async resolveDisabledPluginIds(): Promise<
    ResultType<readonly string[], ToolPluginManagerHookError | ToolPluginCapabilityError>
  > {
    if (!this.options.getDisabledPluginIds) return Result.ok([]);
    const resolved = await captureManagerHook({
      hook: "getDisabledPluginIds",
      run: this.options.getDisabledPluginIds,
    });
    return continueResult(resolved, {
      ok: (value) => decodeDisabledPluginIds(value),
      err: (error) => Result.err(error),
    });
  }

  private async destroyInstance(
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    const state: CleanupState = { failures: [] };
    await this.appendInstanceCleanup(state, pluginId, source, instance);
    return this.finishCleanup(state);
  }

  private async appendInstanceCleanup(
    state: CleanupState,
    pluginId: string,
    source: PluginSource,
    instance: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>,
  ): Promise<void> {
    const [settled] = await Promise.allSettled([
      invokeToolPluginInstanceDestroy({
        pluginId,
        source,
        capability: instance,
      }),
    ]);
    if (settled.status === "rejected") {
      if (!isPluginPanic(settled.reason)) {
        state.failures.push(cleanupRejectionError(pluginId, settled.reason));
        return;
      }
      if (state.panic === undefined) state.panic = settled.reason;
    } else {
      continueResult(settled.value, {
        ok: () => undefined,
        err: (error) => state.failures.push(error),
      });
    }
  }

  private async appendLevel2Cleanup(
    state: CleanupState,
    pluginId: string,
    source: PluginSource,
    items: readonly ServerToolCapabilitySnapshot[],
  ): Promise<void> {
    for (const capability of [...items].reverse()) {
      const [settled] = await Promise.allSettled([
        invokeLevel2Destroy({
          pluginId,
          source,
          tool: capability.tool,
          capability,
        }),
      ]);
      if (settled.status === "rejected") {
        if (!isPluginPanic(settled.reason)) {
          state.failures.push(cleanupRejectionError(pluginId, settled.reason));
          continue;
        }
        if (state.panic === undefined) state.panic = settled.reason;
      } else {
        continueResult(settled.value, {
          ok: () => undefined,
          err: (error) => state.failures.push(error),
        });
      }
    }
  }

  private finishCleanup(state: CleanupState): ResultType<void, ToolPluginCleanupError> {
    if (state.panic !== undefined) {
      throw state.panic;
    }
    return state.failures.length === 0 ? Result.ok() : Result.err(cleanupError(state.failures));
  }

  private async destroyLoaded(
    loaded: readonly LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>[],
  ): Promise<ResultType<void, ToolPluginCleanupError>> {
    const state: CleanupState = { failures: [] };
    for (const plugin of [...loaded].reverse()) {
      await this.appendLevel2Cleanup(
        state,
        plugin.pluginId,
        plugin.source,
        plugin.initializedLevel2,
      );
      await this.appendInstanceCleanup(state, plugin.pluginId, plugin.source, plugin.instance);
    }
    return this.finishCleanup(state);
  }

  private loadedStatus(
    plugin: LoadedPlugin<TRuntimeContext, TLevel1, TLevel2>,
    callableIds: readonly string[],
  ): ToolPluginStatus {
    return {
      pluginId: plugin.pluginId,
      source: plugin.source,
      state: "loaded",
      pluginDir: plugin.pluginDir,
      entrypointPath: plugin.entrypointPath,
      level1Names: [...plugin.level1Names],
      level2Ids: [...callableIds],
    };
  }

  private outcomeStatus(
    outcome: Exclude<LoadedOutcome<TRuntimeContext, TLevel1, TLevel2>, { kind: "loaded" }>,
    source: PluginSource,
    pluginDir?: string,
    entrypointPath?: string,
  ): ToolPluginStatus {
    return {
      pluginId: outcome.pluginId,
      source,
      state: outcome.kind,
      reason: outcome.kind === "skipped" ? outcome.reason : undefined,
      pluginDir,
      entrypointPath,
      level1Names: [],
      level2Ids: [],
    };
  }

  private failedExternalStatus(
    entry: { pluginId: string; pluginDir: string; entrypointPath: string },
    reason: string,
    disabledPluginIds: ReadonlySet<string>,
  ): ToolPluginStatus {
    const disabled = disabledPluginIds.has(entry.pluginId);
    return {
      pluginId: entry.pluginId,
      source: "external",
      state: disabled ? "disabled" : "failed",
      reason: disabled ? undefined : reason,
      pluginDir: entry.pluginDir,
      entrypointPath: entry.entrypointPath,
      level1Names: [],
      level2Ids: [],
    };
  }
}
