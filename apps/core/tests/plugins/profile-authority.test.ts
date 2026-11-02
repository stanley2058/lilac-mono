import { describe, expect, it } from "bun:test";
import { parseCoreConfigV3ToUniversal } from "@stanley2058/lilac-utils";

import { isLevel2ContributionAllowedForNativeProfile } from "../../src/plugins/profile-authority";

describe("subagent Level 2 profile authority", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    agent: {
      subagents: {
        permissions: {
          scheduler: {
            level2: { plugins: ["workflow"], callables: ["*"] },
            delegation: true,
          },
        },
      },
    },
  });
  const allowed = (profileName: string, callableId: string) =>
    isLevel2ContributionAllowedForNativeProfile({
      config,
      profileName,
      pluginId: "workflow",
      callableId,
    });

  it("lets only a profile holding every configured authority start or resume workflows", () => {
    for (const callableId of [
      "workflow.run.trigger",
      "workflow.run.resume",
      "workflow.trigger.create",
    ]) {
      expect(allowed("full", callableId)).toBe(true);
      expect(allowed("scheduler", callableId)).toBe(false);
    }
    expect(allowed("scheduler", "workflow.run.list")).toBe(true);
  });
});
