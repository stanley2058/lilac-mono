import { resolveSubagentPermissionProfile } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import { isHeartbeatSessionId } from "../../heartbeat/common";
import {
  createOrchestrateTool,
  formatOrchestrateToolArgs,
  OrchestrateTargetUnavailable,
} from "../../tools/orchestrate";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import type { CoreLevel1ToolSpec, CoreToolPlugin } from "../types";
import { markBoundedBuiltinOutput } from "../types";
import { decodeCoreToolRequestMetadata } from "./local-tools";

/** Surfaces whose runs may orchestrate. Thread targets also need the surface's thread-control port. */
const ORCHESTRATE_SURFACES: ReadonlySet<string> = new Set(["native", "discord"]);

type RunContext = Parameters<CoreLevel1ToolSpec["isEnabled"]>[0];

/** A primary run controls its children and threads; a subagent only when it may delegate. */
function canControl({ runtime, runProfile, subagentDepth, subagentConfig }: RunContext): boolean {
  if (runProfile === "primary") return true;
  if (!runtime.config || !subagentConfig.enabled || subagentDepth >= subagentConfig.maxDepth)
    return false;
  return resolveSubagentPermissionProfile(runtime.config, runProfile).delegation;
}

const ORCHESTRATE_TOOL: CoreLevel1ToolSpec = markBoundedBuiltinOutput({
  name: "orchestrate",
  supportsBatch: false,
  isEnabled: ({ runtime, requestContext, runProfile }) => {
    if (!requestContext || !runtime.config) return false;
    if (requestContext.safetyMode === "restricted") return false;
    if (isHeartbeatSessionId(requestContext.sessionId)) return false;
    // A child's request has no surface client of its own; it acts for the surface that started it.
    const surface =
      runProfile === "primary"
        ? requestContext.requestClient
        : requestContext.requestInitiator?.platform;
    return surface !== undefined && ORCHESTRATE_SURFACES.has(surface);
  },
  formatArgs: formatOrchestrateToolArgs,
  createTool: (context) => {
    const { runtime, requestContext, subagentConfig } = context;
    if (!runtime.config || !requestContext) {
      return adaptToolResultToHost(
        Result.err(
          new OrchestrateTargetUnavailable({ message: "orchestrate requires a request context" }),
        ),
      );
    }
    const { onSubagentDelegate } = decodeCoreToolRequestMetadata(requestContext.metadata);
    return createOrchestrateTool({
      config: runtime.config,
      cwd: context.cwd,
      runProfile: context.runProfile,
      canControl: canControl(context),
      idleTimeoutMs: subagentConfig.idleTimeoutMs,
      maxDepth: subagentConfig.maxDepth,
      requestContext,
      ...(runtime.durableWorkflowStore ? { workflows: runtime.durableWorkflowStore } : {}),
      ...(runtime.transcriptStore ? { transcripts: runtime.transcriptStore } : {}),
      ...(runtime.subagentSnapshots ? { liveSubagents: runtime.subagentSnapshots } : {}),
      ...(runtime.threadControl ? { threadControl: runtime.threadControl } : {}),
      ...(runtime.requestDeliveryKnown
        ? { requestDeliveryKnown: runtime.requestDeliveryKnown }
        : {}),
      ...(runtime.bus ? { bus: runtime.bus } : {}),
      ...(runtime.workflowProgressCards ? { progressCards: runtime.workflowProgressCards } : {}),
      ...(subagentConfig.enabled && onSubagentDelegate ? { delegate: onSubagentDelegate } : {}),
    });
  },
});

export function createBuiltinOrchestratePlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-orchestrate",
      name: "Built-in Orchestration",
    },
    create() {
      return {
        level1: [ORCHESTRATE_TOOL],
        level2: [],
      };
    },
  };
}
