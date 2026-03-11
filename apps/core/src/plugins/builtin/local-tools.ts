import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";

import { applyPatchTool } from "../../tools/apply-patch";
import {
  batchTool,
  collectApplyPatchTouchedPaths,
  collectEditFileTouchedPaths,
} from "../../tools/batch";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import { subagentTools } from "../../tools/subagent";
import { BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS } from "../../surface/bridge/bus-agent-runner/tool-failure-logging";
import { BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS } from "../../tools/tool-args-display";
import type { CoreLevel1ToolSpec, CoreToolPlugin } from "../types";

function getFsReadOnlyTool(name: "read_file" | "glob" | "grep", cwd: string): unknown {
  const tools = fsTool(cwd);
  return tools[name];
}

function getEditFileTool(cwd: string): unknown {
  return (fsTool(cwd, { includeEditFile: true }) as Record<string, unknown>)["edit_file"];
}

function withBuiltinMetadata(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return {
    ...spec,
    formatArgs: spec.formatArgs ?? BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS[spec.name],
    summarizeFailure:
      spec.summarizeFailure ??
      (BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[spec.name]
        ? ({ result }) => BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[spec.name]!(result)
        : undefined),
  };
}

function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  return [
    withBuiltinMetadata({
      name: "bash",
      supportsBatch: true,
      isEnabled: ({ runProfile }) => runProfile !== "explore",
      createTool: ({ cwd }) => bashToolWithCwd(cwd).bash,
    }),
    withBuiltinMetadata({
      name: "read_file",
      supportsBatch: true,
      isEnabled: () => true,
      createTool: ({ cwd }) => getFsReadOnlyTool("read_file", cwd),
    }),
    withBuiltinMetadata({
      name: "glob",
      supportsBatch: true,
      isEnabled: () => true,
      createTool: ({ cwd }) => getFsReadOnlyTool("glob", cwd),
    }),
    withBuiltinMetadata({
      name: "grep",
      supportsBatch: true,
      isEnabled: () => true,
      createTool: ({ cwd }) => getFsReadOnlyTool("grep", cwd),
    }),
    withBuiltinMetadata({
      name: "edit_file",
      supportsBatch: true,
      isEnabled: ({ runProfile, editingToolMode }) =>
        runProfile !== "explore" && editingToolMode === "edit_file",
      createTool: ({ cwd }) => getEditFileTool(cwd),
      editTargets: (args, context) => {
        const record = args as Record<string, unknown>;
        if (typeof record.path !== "string") {
          throw new Error("edit_file batch preflight requires string path");
        }
        return collectEditFileTouchedPaths({ path: record.path, cwd: context.cwd });
      },
    }),
    withBuiltinMetadata({
      name: "apply_patch",
      supportsBatch: true,
      isEnabled: ({ runProfile, editingToolMode }) =>
        runProfile !== "explore" && editingToolMode === "apply_patch",
      createTool: ({ cwd }) => applyPatchTool({ cwd }).apply_patch,
      editTargets: (args, context) => {
        const record = args as Record<string, unknown>;
        if (typeof record.patchText !== "string") {
          throw new Error("apply_patch batch preflight requires string patchText");
        }
        return collectApplyPatchTouchedPaths({ patchText: record.patchText, cwd: context.cwd });
      },
    }),
    withBuiltinMetadata({
      name: "subagent_delegate",
      isEnabled: ({ runProfile, runtime, subagentConfig, subagentDepth }) =>
        runProfile !== "explore" &&
        Boolean(runtime.bus) &&
        subagentConfig.enabled &&
        subagentDepth < subagentConfig.maxDepth,
      createTool: ({ runtime, subagentConfig }) => {
        if (!runtime.bus) {
          throw new Error("subagent_delegate requires bus");
        }
        return subagentTools({
          bus: runtime.bus,
          defaultTimeoutMs: subagentConfig.defaultTimeoutMs,
          maxTimeoutMs: subagentConfig.maxTimeoutMs,
          maxDepth: subagentConfig.maxDepth,
        }).subagent_delegate;
      },
    }),
    withBuiltinMetadata({
      name: "batch",
      isEnabled: () => true,
      createTool: ({ cwd, editingToolMode, getTools, getLevel1ToolSpecs, reportToolStatus }) =>
        batchTool({
          defaultCwd: cwd,
          getTools,
          getToolSpecs: getLevel1ToolSpecs,
          editingMode: editingToolMode,
          reportToolStatus,
        }).batch,
    }),
  ];
}

export function createBuiltinLocalToolsPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-local-tools",
      name: "Built-in Local Tools",
    },
    create() {
      return {
        level1: createLocalToolSpecs(),
        level2: [] satisfies readonly ServerTool[],
      };
    },
  };
}
