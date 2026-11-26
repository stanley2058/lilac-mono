import { resolveSubagentPermissionProfile } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import { isHeartbeatSessionId } from "../../heartbeat/common";
import { canWakeJobPlatform } from "../../jobs/job-domain";
import type { BackgroundJobModes } from "../../tools/bash-background";
import { createJobTool, formatJobToolArgs, JobToolUnavailable } from "../../tools/job";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import type { CoreLevel1ToolSpec, CoreToolPlugin } from "../types";
import { markBoundedBuiltinOutput } from "../types";
import { JOB_PLUGIN_ID, LOCAL_TOOLS_PLUGIN_ID } from "./plugin-ids";

type RunContext = Parameters<CoreLevel1ToolSpec["isEnabled"]>[0];

/**
 * The background modes a run's `bash` offers, or none. `service` needs a surface that can start a
 * turn after the request ends. Restricted sessions get `await` only, so they never start turns on
 * their own.
 */
export function resolveBackgroundJobModes({
  runtime,
  requestContext,
  runProfile,
}: Pick<RunContext, "runtime" | "requestContext" | "runProfile">): BackgroundJobModes | null {
  if (!runtime.jobs || !requestContext?.requestDeliveryId) return null;
  // Background starts live in built-in bash and are managed through job, so both must be loaded.
  const disabled = runtime.config?.plugins.disabled ?? [];
  if (disabled.includes(JOB_PLUGIN_ID) || disabled.includes(LOCAL_TOOLS_PLUGIN_ID)) return null;
  const client = requestContext.requestClient;
  if (!client || !runtime.jobs.supports(client)) return null;
  // Heartbeat runs are the only `unknown` client that may start jobs.
  if (client === "unknown" && !isHeartbeatSessionId(requestContext.sessionId)) return null;
  if (
    runProfile !== "primary" &&
    runtime.config &&
    resolveSubagentPermissionProfile(runtime.config, runProfile).execution === false
  ) {
    return null;
  }
  if (requestContext.safetyMode === "restricted" || !canWakeJobPlatform(client)) return ["await"];
  return ["await", "service"];
}

const JOB_TOOL: CoreLevel1ToolSpec = markBoundedBuiltinOutput({
  name: "job",
  isEnabled: (context) => resolveBackgroundJobModes(context) !== null,
  formatArgs: formatJobToolArgs,
  createTool: ({ runtime }) => {
    if (!runtime.jobs) {
      return adaptToolResultToHost(
        Result.err(new JobToolUnavailable({ message: "background jobs are unavailable" })),
      );
    }
    return createJobTool({ service: runtime.jobs });
  },
});

export function createBuiltinJobPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: JOB_PLUGIN_ID,
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
