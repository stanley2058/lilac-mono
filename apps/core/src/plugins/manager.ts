import type { ToolSet } from "ai";
import type { ClaudeCodeToolCatalogMetadataMap } from "@stanley2058/lilac-claude-code-bridge";
import {
  ToolPluginManager,
  decodeLevel1ExecutableMetadata,
  invokeLevel1CreateTool,
  invokeLevel1EditTargets,
  invokeLevel1IsEnabled,
  isPluginPanic,
  safePluginExceptionCause,
  type Level1ContributionInfo,
  type Level1ExecutionRequestContext,
  type Level1RunProfile,
  type Level1ToolSpecCapabilitySnapshot,
  type ServerTool,
  type ToolPluginCleanupError,
} from "@stanley2058/lilac-plugin-runtime";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createLogger,
  deriveSubagentIdleTimeoutMs,
  formatTaggedErrorForLog,
  getCoreConfig,
  profileIncludes,
  resolveCoreConfigPath,
  resolveNativeSubagentProfile,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

import { createBuiltinCoreToolPlugins } from "./builtin";
import {
  buildUnifiedToolCatalogResult,
  catalogCandidateExecutable,
  createPortableToolSearchResult,
  formatCatalogNamespaceSummary,
  type CatalogNamespaceSummary,
  type CatalogToolCandidate,
  type CatalogToolEntry,
  type PortableToolSearchInvalid,
  type UnifiedToolCatalogInvalid,
} from "../mcp/catalog";
import {
  assignCatalogToolNames,
  baseCatalogToolName,
  catalogToolStableId,
} from "../mcp/catalog-identity";
import {
  createMcpBinaryResultMaterializer,
  wrapMcpToolWithBinaryMaterialization,
} from "../mcp/binary-result-materializer";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  hasBoundedBuiltinOutput,
  isAggregateOutputBudgetExempt,
  type CoreLevel1ToolSpec,
  type CoreToolPluginRuntime,
} from "./types";
import type { RegisteredSurfacePlatform } from "../surface/types";

function isStructurallyAllowed(
  specName: string,
  contribution: import("@stanley2058/lilac-plugin-runtime").Level1ContributionInfo | undefined,
  params: Pick<BuildLevel1ToolsetParams, "runProfile">,
  config: CoreConfig,
): boolean {
  if (params.runProfile === "primary") return true;
  if (!contribution) return false;
  const profile = resolveNativeSubagentProfile(config, params.runProfile);
  if (!profileIncludes(profile.level1.plugins, contribution.pluginId)) return false;
  if (!profileIncludes(profile.level1.tools, specName)) return false;
  if (specName === "bash" && profile.execution === false) return false;
  if (["edit", "patch"].includes(specName) && !profile.workspaceWrites) return false;
  if (specName === "subagent_delegate" && !profile.delegation) return false;
  return true;
}

function isMcpStructurallyAllowed(params: {
  serverId: string;
  rawName: string;
  modelName: string;
  runProfile: Level1RunProfile;
  config: CoreConfig;
}): boolean {
  if (params.runProfile === "primary") return true;
  const profile = resolveNativeSubagentProfile(params.config, params.runProfile);
  const serverAllowed =
    profileIncludes(profile.level1.plugins, "mcp") ||
    profileIncludes(profile.level1.plugins, `mcp:${params.serverId}`);
  if (!serverAllowed) return false;
  return (
    profileIncludes(profile.level1.tools, params.modelName) ||
    profileIncludes(profile.level1.tools, params.rawName)
  );
}

export type BuildLevel1ToolsetParams = {
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: {
    enabled: boolean;
    idleTimeoutMs?: number;
    maxDepth: number;
  };
  requestContext?: Level1ExecutionRequestContext<RegisteredSurfacePlatform>;
  onSelectCatalogIds?: (catalogIds: readonly string[]) => void;
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "update" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
};

export type BuiltLevel1Toolset = {
  release(): Promise<ResultType<void, ToolPluginCleanupError>>;
  /** Every executable tool, including deferred plugin and MCP tools. */
  tools: ToolSet;
  specs: ReadonlyMap<string, CoreLevel1ToolSpec>;
  /** Builtins that may be active before any deferred catalog selection. */
  directToolNames: ReadonlySet<string>;
  /** The complete deferred plugin and MCP catalog. */
  catalog: readonly CatalogToolEntry[];
  /** Deferred metadata consumed by the Claude Code MCP bridge. */
  catalogMetadata: ClaudeCodeToolCatalogMetadataMap;
  /** Refresh the run-scoped batch child mapping before freezing step authority. */
  updateActiveBatchTools(activeToolNames: ReadonlySet<string>): void;
  contributionInfo: ReadonlyMap<CoreLevel1ToolSpec, Level1ContributionInfo>;
  genericOutputNormalizerBypassTools: ReadonlySet<string>;
  aggregateOutputBudgetExemptTools: ReadonlySet<string>;
};

export class Level1ToolsetBuildFailed extends TaggedError("Level1ToolsetBuildFailed")<{
  readonly operation: string;
  readonly cause: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError;
  readonly message: string;
}> {}

export class Level1ToolsetInvariantViolation extends TaggedError(
  "Level1ToolsetInvariantViolation",
)<{
  readonly message: string;
}> {}

export class Level1ToolsetAssemblyFailed extends TaggedError("Level1ToolsetAssemblyFailed")<{
  readonly cause: UnifiedToolCatalogInvalid | PortableToolSearchInvalid;
  readonly message: string;
}> {}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

function resultErrorOrNull<T, E>(result: ResultType<T, E>): E | null {
  const select = result.match<() => E | null>({
    ok: () => () => null,
    err: (error) => () => error,
  });
  return select();
}

type CreatedCoreToolPluginManager = ReturnType<typeof createCoreToolPluginManager>;
export type CoreToolPluginManager = Omit<
  CreatedCoreToolPluginManager,
  "getLevel2Capabilities" | "acquireGeneration"
> &
  Partial<Pick<CreatedCoreToolPluginManager, "getLevel2Capabilities" | "acquireGeneration">>;

export function resolveOpaquePluginConfig(config: CoreConfig, pluginId: string): unknown {
  return config.plugins?.config?.[pluginId];
}

export function assignOpaqueTool(target: ToolSet, name: string, executable: unknown): void {
  (target as Record<string, unknown>)[name] = executable;
}

export function readOpaqueTool(target: ToolSet, name: string): unknown {
  return (target as Record<string, unknown>)[name];
}

export function createCoreToolPluginManager(params: {
  runtime: CoreToolPluginRuntime;
  dataDir: string;
}) {
  const logger = createLogger({
    module: "tool-plugin-manager",
  });

  const resolveConfig = async () =>
    params.runtime.config ?? params.runtime.getConfig?.() ?? (await getCoreConfig());

  const logPluginOperation = (
    operation: string,
    error: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError,
  ): string => {
    const formatted = formatTaggedErrorForLog(error);
    logger.error("tool plugin operation failed", { operation, ...formatted });
    return `Tool plugin ${operation} failed: ${formatted.errorMessage}`;
  };

  const adaptPluginResultToHost = <T>(
    operation: string,
    result: ResultType<T, import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError>,
  ): T => {
    return result.match({
      ok: (value) => () => value,
      err: (error) => () => {
        throw new Error(logPluginOperation(operation, error));
      },
    })();
  };

  const pluginOperationFailure = (
    operation: string,
    error: import("@stanley2058/lilac-plugin-runtime").ToolPluginManagerError,
  ): Level1ToolsetBuildFailed =>
    new Level1ToolsetBuildFailed({
      operation,
      cause: error,
      message: logPluginOperation(operation, error),
    });

  async function buildLevel1ToolsetResult(
    buildParams: BuildLevel1ToolsetParams,
  ): Promise<
    ResultType<
      BuiltLevel1Toolset,
      Level1ToolsetBuildFailed | Level1ToolsetInvariantViolation | Level1ToolsetAssemblyFailed
    >
  > {
    const initialized = await manager.init();
    const initializationError = resultErrorOrNull(initialized);
    if (initializationError) {
      return Result.err(pluginOperationFailure("init", initializationError));
    }
    const generation = manager.acquireGeneration();
    const [built] = await Promise.allSettled([
      assembleLevel1ToolsetResult(buildParams, generation),
    ]);
    if (built.status === "fulfilled") {
      const toolset = built.value.match({ ok: (value) => value, err: () => null });
      if (toolset) return Result.ok({ ...toolset, release: generation.release });
    }
    const [cleanup] = await Promise.allSettled([generation.release()]);
    if (built.status === "rejected" && isPluginPanic(built.reason)) {
      return adaptToolResultToHost(Result.err(built.reason));
    }
    if (cleanup.status === "rejected" && isPluginPanic(cleanup.reason)) {
      return adaptToolResultToHost(Result.err(cleanup.reason));
    }
    if (built.status === "rejected") {
      return adaptToolResultToHost(Result.err(safePluginExceptionCause(built.reason)));
    }
    if (cleanup.status === "rejected") {
      return adaptToolResultToHost(Result.err(safePluginExceptionCause(cleanup.reason)));
    }
    cleanup.value.match({
      ok: () => undefined,
      err: (error) =>
        logger.error("failed toolset generation cleanup", formatTaggedErrorForLog(error)),
    });
    return built.value.map((toolset) => ({ ...toolset, release: generation.release }));
  }

  async function assembleLevel1ToolsetResult(
    buildParams: BuildLevel1ToolsetParams,
    generation: ReturnType<typeof manager.acquireGeneration>,
  ): Promise<
    ResultType<
      Omit<BuiltLevel1Toolset, "release">,
      Level1ToolsetBuildFailed | Level1ToolsetInvariantViolation | Level1ToolsetAssemblyFailed
    >
  > {
    const resolvedConfig = await resolveConfig();

    const tools: ToolSet = {} as ToolSet;
    const batchTools: ToolSet = {} as ToolSet;
    const specs = new Map<string, CoreLevel1ToolSpec>();
    const directSpecs = new Map<string, CoreLevel1ToolSpec>();
    const contributionInfo = generation.level1ContributionInfo;
    const level1Capabilities = generation.level1Capabilities;
    const level1Specs = generation.level1;
    for (const spec of level1Specs) {
      if (!level1Capabilities.has(spec)) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: "Missing captured Level 1 plugin capability",
          }),
        );
      }
      if (!contributionInfo.has(spec)) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: "Missing captured Level 1 contribution identity",
          }),
        );
      }
    }
    const capabilityForSpec = (
      spec: CoreLevel1ToolSpec,
    ): Level1ToolSpecCapabilitySnapshot<CoreToolPluginRuntime> => level1Capabilities.get(spec)!;
    const contributionForSpec = (spec: CoreLevel1ToolSpec): Level1ContributionInfo =>
      contributionInfo.get(spec)!;
    const nameForSpec = (spec: CoreLevel1ToolSpec): string => capabilityForSpec(spec).name;
    const runContext = {
      runtime: {
        ...params.runtime,
        dataDir: params.dataDir,
        config: resolvedConfig,
      },
      cwd: buildParams.cwd,
      runProfile: buildParams.runProfile,
      editingToolMode: buildParams.editingToolMode,
      subagentDepth: buildParams.subagentDepth,
      subagentConfig: {
        ...buildParams.subagentConfig,
        idleTimeoutMs:
          buildParams.subagentConfig.idleTimeoutMs ??
          deriveSubagentIdleTimeoutMs(resolvedConfig.agent.idleTimeoutMs),
      },
      requestContext: buildParams.requestContext,
    };

    const enabledSpecs: CoreLevel1ToolSpec[] = [];
    for (const spec of level1Specs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const enabled = invokeLevel1IsEnabled({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: runContext,
      });
      const enabledError = resultErrorOrNull(enabled);
      if (enabledError) {
        return Result.err(pluginOperationFailure("level1.isEnabled", enabledError));
      }
      const enabledValue = selectResultValue(enabled);
      if (
        enabledValue &&
        isStructurallyAllowed(specName, contribution, buildParams, resolvedConfig)
      ) {
        enabledSpecs.push(spec);
      }
    }

    const builtinSpecs = enabledSpecs.filter(
      (spec) => contributionInfo.get(spec)?.source === "builtin",
    );
    const externalSpecs = enabledSpecs.filter(
      (spec) => contributionInfo.get(spec)?.source === "external",
    );
    const allMcpTools = params.runtime.mcpRegistry?.getTools() ?? [];
    const mcpBinaryMaterializer = buildParams.requestContext
      ? createMcpBinaryResultMaterializer({ requestId: buildParams.requestContext.requestId })
      : undefined;
    const identities = [
      ...externalSpecs.map((spec) => {
        const contribution = contributionForSpec(spec);
        const specName = nameForSpec(spec);
        return {
          source: "plugin",
          sourceId: contribution.pluginId,
          rawToolName: specName,
        } as const;
      }),
      ...allMcpTools.map((entry) => entry.identity),
    ];
    const directToolNames = new Set(builtinSpecs.map(nameForSpec));
    const reservedNames = new Set(
      level1Specs.filter((spec) => contributionForSpec(spec).source === "builtin").map(nameForSpec),
    );
    reservedNames.add("find_tools");
    const nameAssignment = assignCatalogToolNames(identities, reservedNames);
    if (nameAssignment.collisions.length > 0) {
      return Result.err(
        new Level1ToolsetInvariantViolation({
          message: `Unable to assign unique deferred catalog tool names: ${nameAssignment.collisions
            .map(
              (collision) =>
                `${collision.modelName}: ${collision.identities
                  .map((identity) => catalogToolStableId(identity))
                  .join(", ")}`,
            )
            .join("; ")}`,
        }),
      );
    }
    const mcpTools: Array<(typeof allMcpTools)[number]> = [];
    for (const entry of allMcpTools) {
      const modelName = nameAssignment.byStableId.get(entry.stableId);
      if (!modelName) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: `MCP tool did not receive a model name: ${entry.stableId}`,
          }),
        );
      }
      if (
        isMcpStructurallyAllowed({
          serverId: entry.serverId,
          rawName: entry.rawName,
          modelName,
          runProfile: buildParams.runProfile,
          config: resolvedConfig,
        })
      ) {
        mcpTools.push(entry);
      }
    }
    const mcpCatalogServerById = new Map(
      (params.runtime.mcpRegistry?.getCatalogServers() ?? []).map((server) => [
        server.serverId,
        server,
      ]),
    );
    const mcpToolCountsByServerId = new Map<string, number>();
    for (const entry of mcpTools) {
      mcpToolCountsByServerId.set(
        entry.serverId,
        (mcpToolCountsByServerId.get(entry.serverId) ?? 0) + 1,
      );
    }
    const mcpNamespaceSummaries: CatalogNamespaceSummary[] = [
      ...mcpToolCountsByServerId.entries(),
    ].map(([serverId, toolCount]) => {
      const description = mcpCatalogServerById.get(serverId)?.description;
      return {
        source: "mcp",
        sourceId: serverId,
        toolCount,
        ...(description === undefined ? {} : { description }),
      };
    });
    const mcpNamespaceSummaryByServerId = new Map(
      mcpNamespaceSummaries.map((summary) => [
        summary.sourceId,
        formatCatalogNamespaceSummary(summary),
      ]),
    );

    for (const spec of builtinSpecs) {
      const specName = nameForSpec(spec);
      specs.set(specName, spec);
      directSpecs.set(specName, spec);
    }
    for (const spec of externalSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const stableId = catalogToolStableId({
        source: "plugin",
        sourceId: contribution.pluginId,
        rawToolName: specName,
      });
      const modelName = nameAssignment.byStableId.get(stableId);
      if (!modelName) {
        return Result.err(
          new Level1ToolsetInvariantViolation({
            message: `External plugin tool did not receive a model name: ${stableId}`,
          }),
        );
      }
      specs.set(modelName, spec);
    }

    const buildContext = {
      ...runContext,
      getTools: () => batchTools,
      getLevel1ToolSpecs: () => directSpecs,
      resolveEditTargets: async <TArgs>(
        spec: CoreLevel1ToolSpec,
        args: TArgs,
        context: { cwd: string },
      ) => {
        const contribution = contributionForSpec(spec);
        const resolved = await invokeLevel1EditTargets({
          pluginId: contribution.pluginId,
          source: contribution.source,
          spec,
          capability: capabilityForSpec(spec),
          args,
          cwd: context.cwd,
        });
        return adaptPluginResultToHost("level1.editTargets", resolved) ?? [];
      },
      reportToolStatus: buildParams.reportToolStatus,
    };

    for (const spec of builtinSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const executable = invokeLevel1CreateTool({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: buildContext,
      });
      const executableError = resultErrorOrNull(executable);
      if (executableError) {
        return Result.err(pluginOperationFailure("level1.createTool", executableError));
      }
      const executableValue = selectResultValue(executable);
      assignOpaqueTool(tools, specName, executableValue);
      assignOpaqueTool(batchTools, specName, executableValue);
    }

    const candidates: CatalogToolCandidate[] = [];
    for (const spec of externalSpecs) {
      const contribution = contributionForSpec(spec);
      const specName = nameForSpec(spec);
      const identity = {
        source: "plugin",
        sourceId: contribution.pluginId,
        rawToolName: specName,
      } as const;
      const executable = invokeLevel1CreateTool({
        pluginId: contribution.pluginId,
        source: contribution.source,
        spec,
        capability: capabilityForSpec(spec),
        context: buildContext,
      });
      const executableError = resultErrorOrNull(executable);
      if (executableError) {
        return Result.err(pluginOperationFailure("level1.createTool", executableError));
      }
      const executableValue = selectResultValue(executable);
      const metadata = decodeLevel1ExecutableMetadata(contribution.pluginId, executableValue);
      const metadataError = resultErrorOrNull(metadata);
      if (metadataError) {
        return Result.err(pluginOperationFailure("level1.executableMetadata", metadataError));
      }
      const metadataValue = selectResultValue(metadata);
      candidates.push({
        identity,
        ...(metadataValue.title === undefined ? {} : { title: metadataValue.title }),
        ...(metadataValue.description === undefined
          ? {}
          : { description: metadataValue.description }),
        tool: executableValue,
      });
    }
    for (const entry of mcpTools) {
      const namespaceSummary = mcpNamespaceSummaryByServerId.get(entry.serverId);
      candidates.push({
        identity: entry.identity,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(namespaceSummary === undefined ? {} : { namespaceSummary }),
        tool: mcpBinaryMaterializer
          ? wrapMcpToolWithBinaryMaterialization(entry.tool, mcpBinaryMaterializer)
          : entry.tool,
      });
    }

    const catalogReservedNames = new Set(reservedNames);
    for (const candidate of candidates) {
      const assignedName = nameAssignment.byStableId.get(catalogToolStableId(candidate.identity));
      const baseName = baseCatalogToolName(candidate.identity);
      if (assignedName !== baseName) catalogReservedNames.add(baseName);
    }
    const catalogResult = buildUnifiedToolCatalogResult({
      candidates,
      reservedNames: catalogReservedNames,
    });
    const catalogError = resultErrorOrNull(catalogResult);
    if (catalogError) {
      return Result.err(
        new Level1ToolsetAssemblyFailed({
          cause: catalogError,
          message: catalogError.message,
        }),
      );
    }
    const catalog = selectResultValue(catalogResult);
    for (const entry of catalog.entries) {
      assignOpaqueTool(tools, entry.modelName, catalogCandidateExecutable(entry));
    }
    if (catalog.entries.length > 0) {
      directToolNames.add("find_tools");
      const search: ResultType<unknown, PortableToolSearchInvalid> = createPortableToolSearchResult(
        {
          catalog: catalog.entries,
          namespaceSummaries: mcpNamespaceSummaries,
          onSelectCatalogIds: buildParams.onSelectCatalogIds,
          requestContext: buildParams.requestContext,
        },
      );
      const searchError = resultErrorOrNull(search);
      if (searchError) {
        return Result.err(
          new Level1ToolsetAssemblyFailed({
            cause: searchError,
            message: searchError.message,
          }),
        );
      }
      const searchTool = selectResultValue(search);
      assignOpaqueTool(tools, "find_tools", searchTool);
    }

    let batchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
    const updateActiveBatchTools = (activeToolNames: ReadonlySet<string>) => {
      for (const name of Object.keys(batchTools)) delete batchTools[name];
      directSpecs.clear();
      for (const name of activeToolNames) {
        const executable = readOpaqueTool(tools, name);
        const spec = specs.get(name);
        if (executable && spec) {
          assignOpaqueTool(batchTools, name, executable);
          directSpecs.set(name, spec);
        }
      }

      const batchSpec = specs.get("batch");
      if (!activeToolNames.has("batch") || !batchSpec) return;
      const nextBatchAuthorityKey = [...directSpecs.keys()].sort().join("\0");
      if (nextBatchAuthorityKey === batchAuthorityKey) return;
      batchAuthorityKey = nextBatchAuthorityKey;
      const contribution = contributionForSpec(batchSpec);
      const executable = adaptPluginResultToHost(
        "level1.createTool",
        invokeLevel1CreateTool({
          pluginId: contribution.pluginId,
          source: contribution.source,
          spec: batchSpec,
          capability: capabilityForSpec(batchSpec),
          context: buildContext,
        }),
      );
      assignOpaqueTool(tools, "batch", executable);
      assignOpaqueTool(batchTools, "batch", executable);
    };

    return Result.ok({
      tools,
      specs,
      directToolNames,
      catalog: catalog.entries,
      catalogMetadata: catalog.catalogMetadata,
      updateActiveBatchTools,
      contributionInfo,
      genericOutputNormalizerBypassTools: new Set(
        [...specs.entries()]
          .filter(
            ([, spec]) =>
              contributionForSpec(spec).source === "builtin" && hasBoundedBuiltinOutput(spec),
          )
          .map(([modelName]) => modelName),
      ),
      aggregateOutputBudgetExemptTools: new Set(
        [...specs.entries()]
          .filter(
            ([, spec]) =>
              contributionForSpec(spec).source === "builtin" && isAggregateOutputBudgetExempt(spec),
          )
          .map(([modelName]) => modelName),
      ),
    });
  }

  const manager = new ToolPluginManager<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>({
    runtime: params.runtime,
    dataDir: params.dataDir,
    configPath: resolveCoreConfigPath({ dataDir: params.dataDir }),
    logger,
    builtinPlugins: createBuiltinCoreToolPlugins(),
    getDisabledPluginIds: async () => (await resolveConfig()).plugins?.disabled ?? [],
    getPluginConfig: async (pluginId: string) =>
      resolveOpaquePluginConfig(await resolveConfig(), pluginId),
    getLevel1RegistrationKey: (_spec, contribution, capturedName) =>
      contribution.source === "builtin"
        ? capturedName
        : JSON.stringify([contribution.pluginId, capturedName]),
    adaptLevel1Item: (spec) => spec,
    adaptLevel2Item: (tool) => tool,
  });

  return {
    init: () => manager.init(),
    destroy: () => manager.destroy(),
    reload: () => manager.reload(),
    ensureFresh: () => manager.ensureFresh(),
    getStatuses: () => manager.getStatuses(),
    getLevel2Tools: () => manager.getLevel2Items(),
    getLevel2ContributionInfo: () => manager.getLevel2ContributionInfo(),
    getLevel2Capabilities: () => manager.getLevel2Capabilities(),
    acquireGeneration: () => manager.acquireGeneration(),
    buildLevel1ToolsetResult,
  };
}
