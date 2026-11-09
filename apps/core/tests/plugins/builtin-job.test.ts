import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import type { JobService } from "../../src/jobs/job-service";
import { createBuiltinJobPlugin } from "../../src/plugins/builtin/job";
import type { CoreLevel1ToolSpec } from "../../src/plugins/types";

const jobs = {
  supports: (platform: string) => platform === "native" || platform === "discord",
} as unknown as JobService;

async function jobToolSpec(): Promise<CoreLevel1ToolSpec> {
  const created = await createBuiltinJobPlugin().create({} as never);
  const spec = created.level1?.[0];
  if (!spec) throw new Error("job plugin has no Level 1 tool");
  return spec;
}

async function enabled(input: {
  runtime?: { jobs?: JobService };
  requestClient?: string;
  safetyMode?: "trusted" | "restricted";
  sessionId?: string;
  requestDeliveryId?: string | null;
  runProfile?: string;
}): Promise<boolean> {
  const spec = await jobToolSpec();
  return Boolean(
    spec.isEnabled?.({
      runtime: input.runtime ?? { jobs },
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
      },
    } as never),
  );
}

describe("job tool capability", () => {
  it("is available on native and Discord", async () => {
    expect(await enabled({ requestClient: "native" })).toBe(true);
    expect(await enabled({ requestClient: "discord" })).toBe(true);
  });

  it("is absent from the GitHub surface", async () => {
    expect(await enabled({ requestClient: "github" })).toBe(false);
  });

  it("is absent from restricted and heartbeat sessions", async () => {
    expect(await enabled({ safetyMode: "restricted" })).toBe(false);
    expect(await enabled({ sessionId: "__heartbeat__" })).toBe(false);
  });

  it("needs the service and an accepted request", async () => {
    expect(await enabled({ runtime: {} })).toBe(false);
    expect(await enabled({ requestDeliveryId: null })).toBe(false);
  });

  it("needs native execution in the subagent's permission profile", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    const sandboxed = { ...config.agent.subagents.permissions["full"]!, execution: "restricted" };
    config.agent.subagents.permissions["sandboxed"] = sandboxed as never;
    const runtime = { jobs, config } as never;
    expect(await enabled({ runtime, runProfile: "full" })).toBe(true);
    expect(await enabled({ runtime, runProfile: "sandboxed" })).toBe(false);
    expect(await enabled({ runtime, runProfile: "profile-that-no-longer-exists" })).toBe(false);
  });

  it("stays out of the built-in restricted profile, which lists its plugins", () => {
    const { level1 } = parseCoreConfigV2ToUniversal({}).agent.subagents.permissions["restricted"]!;
    expect(level1.plugins).not.toContain("builtin-job");
    expect(level1.tools).not.toContain("job");
  });
});
