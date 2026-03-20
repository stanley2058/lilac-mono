import type { ToolSet } from "ai";
import {
  ToolPluginManager,
  type Level1ExecutionRequestContext,
  type Level1RunProfile,
  type ServerTool,
} from "@stanley2058/lilac-plugin-runtime";
import { createLogger, getCoreConfig, resolveCoreConfigPath } from "@stanley2058/lilac-utils";

import { createBuiltinCoreToolPlugins } from "./builtin";
import type { CoreLevel1ToolSpec, CoreToolPluginRuntime } from "./types";

async function listServerToolCallableIds(tool: ServerTool): Promise<readonly string[]> {
  const entries = await tool.list();
  return entries.map((entry: Awaited<ReturnType<ServerTool["list"]>>[number]) => entry.callableId);
}

export type BuildLevel1ToolsetParams = {
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: {
    enabled: boolean;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    maxDepth: number;
  };
  requestContext?: Level1ExecutionRequestContext;
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "update" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
};

export type BuiltLevel1Toolset = {
  tools: ToolSet;
  specs: ReadonlyMap<string, CoreLevel1ToolSpec>;
};

export type CoreToolPluginManager = ReturnType<typeof createCoreToolPluginManager>;

export function createCoreToolPluginManager(params: {
  runtime: CoreToolPluginRuntime;
  dataDir: string;
}) {
  const logger = createLogger({
    module: "tool-plugin-manager",
  });

  const resolveConfig = async () =>
    params.runtime.config ?? params.runtime.getConfig?.() ?? (await getCoreConfig());

  const manager = new ToolPluginManager<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>({
    runtime: params.runtime,
    dataDir: params.dataDir,
    configPath: resolveCoreConfigPath({ dataDir: params.dataDir }),
    logger,
    builtinPlugins: createBuiltinCoreToolPlugins(),
    getDisabledPluginIds: async () => (await resolveConfig()).plugins?.disabled ?? [],
    getPluginConfig: async (pluginId: string) =>
      (await resolveConfig()).plugins?.config?.[pluginId],
    getLevel1Name: (spec) => spec.name,
    getLevel2CallableIds: listServerToolCallableIds,
    initLevel2Item: async (tool) => {
      await tool.init();
    },
    destroyLevel2Item: async (tool) => {
      await tool.destroy();
    },
  });

  return {
    init: () => manager.init(),
    destroy: () => manager.destroy(),
    reload: () => manager.reload(),
    ensureFresh: () => manager.ensureFresh(),
    getStatuses: () => manager.getStatuses(),
    getLevel2Tools: () => manager.getLevel2Items(),
    async buildLevel1Toolset(buildParams: BuildLevel1ToolsetParams): Promise<BuiltLevel1Toolset> {
      await manager.ensureFresh();
      const resolvedConfig = await resolveConfig();

      const tools: ToolSet = {} as ToolSet;
      const specs = new Map<string, CoreLevel1ToolSpec>();
      const runContext = {
        runtime: {
          ...params.runtime,
          config: resolvedConfig,
        },
        cwd: buildParams.cwd,
        runProfile: buildParams.runProfile,
        editingToolMode: buildParams.editingToolMode,
        subagentDepth: buildParams.subagentDepth,
        subagentConfig: buildParams.subagentConfig,
        requestContext: buildParams.requestContext,
      };

      const enabledSpecs = manager.getLevel1Items().filter((spec) => spec.isEnabled(runContext));

      for (const spec of enabledSpecs) {
        specs.set(spec.name, spec);
      }

      const buildContext = {
        ...runContext,
        getTools: () => tools,
        getLevel1ToolSpecs: () => specs,
        reportToolStatus: buildParams.reportToolStatus,
      };

      for (const spec of enabledSpecs) {
        (tools as Record<string, unknown>)[spec.name] = spec.createTool(buildContext);
      }

      return {
        tools,
        specs,
      };
    },
  };
}
