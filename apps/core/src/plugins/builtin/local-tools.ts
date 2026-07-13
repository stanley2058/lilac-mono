import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";

import { applyPatchTool } from "../../tools/apply-patch";
import {
  batchTool,
  collectApplyPatchTouchedPaths,
  collectEditFileTouchedPaths,
} from "../../tools/batch";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import { subagentTools, type DeferredSubagentRegistration } from "../../tools/subagent";
import { BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS } from "../../surface/bridge/bus-agent-runner/tool-failure-logging";
import { BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS } from "../../tools/tool-args-display";
import { markBoundedBuiltinOutput, type CoreLevel1ToolSpec, type CoreToolPlugin } from "../types";

type CoreToolBuildContext = Parameters<CoreLevel1ToolSpec["createTool"]>[0];

const localFsToolsByBuildContext = new WeakMap<CoreToolBuildContext, ReturnType<typeof fsTool>>();

function getReadFileDirectAttachmentSupported(context: CoreToolBuildContext): boolean {
  return context.requestContext?.metadata?.["readFileDirectAttachmentSupported"] === true;
}

function getFsTools(context: CoreToolBuildContext): ReturnType<typeof fsTool> {
  const cached = localFsToolsByBuildContext.get(context);
  if (cached) return cached;

  const tools = fsTool(context.cwd, {
    includeEditFile: true,
    experimentalHashlineEdit:
      context.editingToolMode === "edit_file" &&
      context.runtime.config?.tools.editFile.hashline === true,
    fsBackend: context.runtime.config?.tools.fsBackend,
    readFileDirectAttachmentSupported: getReadFileDirectAttachmentSupported(context),
    maxOutputBytes: context.runtime.config?.tools.output.maxPreviewBytes,
    maxInlineMediaBytesPerPart: context.runtime.config?.tools.media.maxInlineBytesPerPart,
    artifactOnly: context.requestContext?.safetyMode === "restricted",
    toolResultArtifacts: context.runtime.toolResultArtifacts,
    requestContext: context.requestContext
      ? {
          requestId: context.requestContext.requestId,
          sessionId: context.requestContext.sessionId,
        }
      : undefined,
  });
  localFsToolsByBuildContext.set(context, tools);
  return tools;
}

function getFsReadOnlyTool(
  name: "read_file" | "glob" | "grep" | "fuzzy_search",
  context: CoreToolBuildContext,
): unknown {
  const tools = getFsTools(context);
  return tools[name];
}

function getEditFileTool(context: CoreToolBuildContext): unknown {
  return (getFsTools(context) as Record<string, unknown>)["edit_file"];
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

function withBoundedOutput(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return markBoundedBuiltinOutput(withBuiltinMetadata(spec));
}

function getDeferredDelegateHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): ((registration: DeferredSubagentRegistration) => Promise<void>) | undefined {
  const candidate = requestContext.metadata?.["onDeferredDelegate"];
  return typeof candidate === "function"
    ? (candidate as (registration: DeferredSubagentRegistration) => Promise<void>)
    : undefined;
}

function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  return [
    withBoundedOutput({
      name: "bash",
      supportsBatch: true,
      isEnabled: ({ runProfile }) => runProfile !== "explore",
      createTool: ({ cwd, runtime }) =>
        bashToolWithCwd(cwd, {
          artifacts: runtime.toolResultArtifacts,
          outputConfig: runtime.config?.tools.output,
        }).bash,
    }),
    withBoundedOutput({
      name: "read_file",
      supportsBatch: true,
      isEnabled: () => true,
      createTool: (context) => getFsReadOnlyTool("read_file", context),
    }),
    withBoundedOutput({
      name: "glob",
      supportsBatch: true,
      isEnabled: ({ requestContext }) => requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("glob", context),
    }),
    withBoundedOutput({
      name: "grep",
      supportsBatch: true,
      isEnabled: ({ requestContext }) => requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("grep", context),
    }),
    withBoundedOutput({
      name: "fuzzy_search",
      supportsBatch: true,
      isEnabled: ({ runtime, requestContext }) =>
        runtime.config?.tools.fsBackend === "fff" && requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("fuzzy_search", context),
    }),
    withBoundedOutput({
      name: "edit_file",
      supportsBatch: true,
      isEnabled: ({ runProfile, editingToolMode, requestContext }) =>
        runProfile !== "explore" &&
        editingToolMode === "edit_file" &&
        requestContext?.safetyMode !== "restricted",
      createTool: (context) => getEditFileTool(context),
      editTargets: (args, context) => {
        const record = args as Record<string, unknown>;
        if (typeof record.path !== "string") {
          throw new Error("edit_file batch preflight requires string path");
        }
        return collectEditFileTouchedPaths({ path: record.path, cwd: context.cwd });
      },
    }),
    withBoundedOutput({
      name: "apply_patch",
      supportsBatch: true,
      isEnabled: ({ runProfile, editingToolMode, requestContext }) =>
        runProfile !== "explore" &&
        editingToolMode === "apply_patch" &&
        requestContext?.safetyMode !== "restricted",
      createTool: ({ cwd }) => applyPatchTool({ cwd }).apply_patch,
      editTargets: (args, context) => {
        const record = args as Record<string, unknown>;
        if (typeof record.patchText !== "string") {
          throw new Error("apply_patch batch preflight requires string patchText");
        }
        return collectApplyPatchTouchedPaths({ patchText: record.patchText, cwd: context.cwd });
      },
    }),
    withBoundedOutput({
      name: "subagent_delegate",
      isEnabled: ({ runProfile, runtime, subagentConfig, subagentDepth, requestContext }) =>
        runProfile !== "explore" &&
        runProfile !== "general" &&
        Boolean(runtime.bus) &&
        subagentConfig.enabled &&
        subagentDepth < subagentConfig.maxDepth &&
        requestContext?.safetyMode !== "restricted",
      createTool: ({ runtime, subagentConfig, requestContext }) => {
        if (!runtime.bus) {
          throw new Error("subagent_delegate requires bus");
        }
        return subagentTools({
          bus: runtime.bus,
          idleTimeoutMs: subagentConfig.idleTimeoutMs,
          maxDepth: subagentConfig.maxDepth,
          onDeferredDelegate: requestContext
            ? getDeferredDelegateHandler(requestContext)
            : undefined,
        }).subagent_delegate;
      },
    }),
    withBoundedOutput({
      name: "batch",
      isEnabled: () => true,
      createTool: ({
        cwd,
        editingToolMode,
        getTools,
        getLevel1ToolSpecs,
        reportToolStatus,
        runtime,
      }) =>
        batchTool({
          defaultCwd: cwd,
          getTools,
          getToolSpecs: getLevel1ToolSpecs,
          editingMode: editingToolMode,
          reportToolStatus,
          maxCalls: runtime.config?.tools.batch.maxCalls ?? 8,
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
