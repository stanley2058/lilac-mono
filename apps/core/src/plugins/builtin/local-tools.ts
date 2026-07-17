import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";
import { resolveNativeSubagentProfile } from "@stanley2058/lilac-utils";

import { applyPatchTool } from "../../tools/apply-patch";
import {
  batchTool,
  collectApplyPatchTouchedPaths,
  collectEditFileTouchedPaths,
} from "../../tools/batch";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import {
  subagentTools,
  type SubagentDelegationHandle,
  type SubagentDelegationRegistration,
} from "../../tools/subagent";
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
    loadInstructions: true,
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

function getDelegateHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}):
  | ((registration: SubagentDelegationRegistration) => Promise<SubagentDelegationHandle>)
  | undefined {
  const candidate = requestContext.metadata?.["onSubagentDelegate"];
  return typeof candidate === "function"
    ? (candidate as (
        registration: SubagentDelegationRegistration,
      ) => Promise<SubagentDelegationHandle>)
    : undefined;
}

function getAgentActivityHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): ((source: "tool" | "subagent") => void) | undefined {
  const candidate = requestContext.metadata?.["onActivity"];
  return typeof candidate === "function"
    ? (candidate as (source: "tool" | "subagent") => void)
    : undefined;
}

function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  return [
    withBoundedOutput({
      name: "bash",
      supportsBatch: true,
      isEnabled: () => true,
      createTool: (context) => {
        const { cwd, runtime, requestContext, runProfile } = context;
        const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
        const controlCapability = requestContext?.metadata?.["controlCapability"];
        return bashToolWithCwd(cwd, {
          artifacts: runtime.toolResultArtifacts,
          outputConfig: runtime.config?.tools.output,
          onActivity: onActivity ? () => onActivity("tool") : undefined,
          controlCapability: typeof controlCapability === "string" ? controlCapability : undefined,
          nativeProfile:
            runProfile === "primary" || !runtime.config
              ? undefined
              : resolveNativeSubagentProfile(runtime.config, runProfile),
        }).bash;
      },
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
      isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("glob", context),
    }),
    withBoundedOutput({
      name: "grep",
      supportsBatch: true,
      isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("grep", context),
    }),
    withBoundedOutput({
      name: "fuzzy_search",
      supportsBatch: true,
      isEnabled: (context) =>
        context.runtime.config?.tools.fsBackend === "fff" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("fuzzy_search", context),
    }),
    withBoundedOutput({
      name: "edit_file",
      supportsBatch: true,
      isEnabled: (context) =>
        context.editingToolMode === "edit_file" &&
        context.requestContext?.safetyMode !== "restricted",
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
      isEnabled: (context) =>
        context.editingToolMode === "apply_patch" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) =>
        applyPatchTool({
          cwd: context.cwd,
        }).apply_patch,
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
      isEnabled: ({ runtime, subagentConfig, subagentDepth, requestContext }) =>
        Boolean(runtime.bus) &&
        subagentConfig.enabled &&
        subagentDepth < subagentConfig.maxDepth &&
        requestContext?.safetyMode !== "restricted",
      createTool: ({ runtime, subagentConfig, requestContext }) => {
        if (!runtime.bus) {
          throw new Error("subagent_delegate requires bus");
        }
        const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
        return subagentTools({
          bus: runtime.bus,
          idleTimeoutMs: subagentConfig.idleTimeoutMs,
          maxDepth: subagentConfig.maxDepth,
          modelPresets: runtime.config?.models.def,
          delegatePromptOverlay: runtime.config?.agent.subagents.delegatePromptOverlay,
          onDelegate: requestContext ? getDelegateHandler(requestContext) : undefined,
          onActivity: onActivity ? () => onActivity("subagent") : undefined,
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
