import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import { JobService } from "../../src/jobs/job-service";
import { resolveBackgroundJobModes } from "../../src/plugins/builtin/job";

const jobs = Object.create(JobService.prototype) as JobService;

function modes(input: {
  runtime?: { jobs?: JobService; config?: unknown };
  requestClient?: string;
  safetyMode?: "trusted" | "restricted";
  sessionId?: string;
  requestDeliveryId?: string | null;
  runProfile?: string;
}) {
  return resolveBackgroundJobModes({
    runtime: (input.runtime ?? { jobs }) as never,
    runProfile: input.runProfile ?? "primary",
    requestContext: {
      requestId: "request",
      requestDeliveryId:
        input.requestDeliveryId === null ? undefined : (input.requestDeliveryId ?? "delivery"),
      sessionId: input.sessionId ?? "session",
      requestClient: input.requestClient ?? "native",
      subagentDepth: 0,
      subagentProfile: "primary",
      safetyMode: input.safetyMode ?? "trusted",
    } as never,
  });
}

describe("background job modes", () => {
  it("offers await and service where the surface can start a turn", () => {
    expect(modes({ requestClient: "native" })).toEqual(["await", "service"]);
    expect(modes({ requestClient: "discord" })).toEqual(["await", "service"]);
  });

  it("offers only await on GitHub and heartbeat runs", () => {
    expect(modes({ requestClient: "github" })).toEqual(["await"]);
    expect(modes({ requestClient: "unknown", sessionId: "__heartbeat__" })).toEqual(["await"]);
  });

  it("offers only await in restricted sessions", () => {
    expect(modes({ safetyMode: "restricted" })).toEqual(["await"]);
  });

  it("offers nothing to other surfaces", () => {
    expect(modes({ requestClient: "slack" })).toBeNull();
    expect(modes({ requestClient: "unknown", sessionId: "workflow:run-1" })).toBeNull();
  });

  it("needs the service and an accepted request", () => {
    expect(modes({ runtime: {} })).toBeNull();
    expect(modes({ requestDeliveryId: null })).toBeNull();
  });

  it("offers nothing when the job or local-tools plugin is disabled", () => {
    for (const pluginId of ["builtin-job", "builtin-local-tools"]) {
      const config = parseCoreConfigV2ToUniversal({});
      config.plugins.disabled.push(pluginId);
      expect(modes({ runtime: { jobs, config } })).toBeNull();
    }
  });

  it("follows the subagent profile's Bash execution", () => {
    const config = parseCoreConfigV2ToUniversal({});
    const full = config.agent.subagents.permissions["full"]!;
    config.agent.subagents.permissions["sandboxed"] = { ...full, execution: "restricted" };
    config.agent.subagents.permissions["noexec"] = { ...full, execution: false };
    const runtime = { jobs, config };
    expect(modes({ runtime, runProfile: "full" })).toEqual(["await", "service"]);
    expect(modes({ runtime, runProfile: "sandboxed" })).toEqual(["await", "service"]);
    expect(modes({ runtime, runProfile: "noexec" })).toBeNull();
    expect(modes({ runtime, runProfile: "profile-that-no-longer-exists" })).toBeNull();
  });
});
