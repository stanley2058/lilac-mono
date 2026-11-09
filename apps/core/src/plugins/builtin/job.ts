import { resolveSubagentPermissionProfile } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import { isHeartbeatSessionId } from "../../heartbeat/common";
import { createJobTool, formatJobToolArgs, JobToolUnavailable } from "../../tools/job";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import type { CoreLevel1ToolSpec, CoreToolPlugin } from "../types";
import { markBoundedBuiltinOutput } from "../types";
import { decodeCoreToolRequestMetadata } from "./local-tools";

const JOB_TOOL: CoreLevel1ToolSpec = markBoundedBuiltinOutput({
  name: "job",
  supportsBatch: false,
  isEnabled: ({ runtime, requestContext, runProfile }) => {
    if (!runtime.jobs || !requestContext?.requestDeliveryId) return false;
    if (!requestContext.requestClient || !runtime.jobs.supports(requestContext.requestClient))
      return false;
    if (requestContext.safetyMode === "restricted") return false;
    if (requestContext.sessionId && isHeartbeatSessionId(requestContext.sessionId)) return false;
    if (runProfile === "primary" || !runtime.config) return true;
    return resolveSubagentPermissionProfile(runtime.config, runProfile).execution === "native";
  },
  formatArgs: formatJobToolArgs,
  createTool: ({ runtime, cwd, runProfile, requestContext }) => {
    if (!runtime.jobs) {
      return adaptToolResultToHost(
        Result.err(new JobToolUnavailable({ message: "background jobs are unavailable" })),
      );
    }
    const { controlCapability } = decodeCoreToolRequestMetadata(requestContext?.metadata);
    return createJobTool({
      service: runtime.jobs,
      defaultCwd: cwd,
      runProfile,
      ...(typeof controlCapability === "string" ? { controlCapability } : {}),
    });
  },
});

export function createBuiltinJobPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-job",
      name: "Built-in Background Jobs",
    },
    create() {
      return {
        level1: [JOB_TOOL],
        level2: [],
      };
    },
  };
}
