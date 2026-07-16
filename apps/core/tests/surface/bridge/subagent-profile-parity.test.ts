import { describe, expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";

import { buildSystemPromptForProfile } from "../../../src/surface/bridge/bus-agent-runner/subagent-prompt";

describe("native subagent profile prompt parity", () => {
  const config = parseCoreConfigV2ToUniversal({ configVersion: 2 });

  for (const profile of ["explore", "general", "self"] as const) {
    it(`uses one ${profile} prompt for direct and workflow launches`, () => {
      const params = {
        baseSystemPrompt: "base",
        profile,
        profileConfig: config.agent.subagents.profiles[profile],
        exploreOverlay: config.agent.subagents.profiles.explore.promptOverlay,
        generalOverlay: config.agent.subagents.profiles.general.promptOverlay,
        selfOverlay: config.agent.subagents.profiles.self.promptOverlay,
        skillsSection: profile === "explore" ? null : "skills",
      };

      const direct = buildSystemPromptForProfile(params);
      const workflow = buildSystemPromptForProfile(params);
      expect(workflow).toBe(direct);
      expect(workflow).not.toContain("Workflow Tool Surface");
    });
  }
});
