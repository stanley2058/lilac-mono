import { describe, expect, it } from "bun:test";
import {
  parseCoreConfigV3ToUniversal,
  resolveSubagentPermissionProfile,
} from "@stanley2058/lilac-utils";

import {
  buildSystemPromptForProfile,
  selectWorkspaceSystemPrompt,
} from "../../../src/surface/bridge/bus-agent-runner/subagent-prompt";

describe("subagent permission profile prompts", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    agent: {
      subagents: {
        permissions: {
          offline: { network: false, execution: false, promptOverlay: "Work from local files." },
        },
      },
    },
  });

  it("uses the worker prompt for every subagent, including legacy self runs", () => {
    for (const profile of ["full", "restricted", "self", "explore"]) {
      expect(
        selectWorkspaceSystemPrompt({
          profile,
          primarySystemPrompt: "primary",
          workerSystemPrompt: "worker",
        }),
      ).toBe("worker");
    }
    expect(
      selectWorkspaceSystemPrompt({
        profile: "primary",
        primarySystemPrompt: "primary",
        workerSystemPrompt: "worker",
      }),
    ).toBe("primary");
  });

  it("falls back to the primary prompt when a worker prompt has not been loaded", () => {
    expect(
      selectWorkspaceSystemPrompt({
        profile: "full",
        primarySystemPrompt: "primary",
        workerSystemPrompt: "",
      }),
    ).toBe("primary");
  });

  it("renders one overlay with the skills section and the customize-lilac pointer", () => {
    const prompt = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "full",
      profileConfig: resolveSubagentPermissionProfile(config, "full"),
      skillsSection: "skills",
    });

    expect(prompt).toContain("skills");
    expect(prompt).toContain("## Subagent (permissions: full)");
    expect(prompt).toContain("names in the task refer to that user");
    expect(prompt).toContain("load the customize-lilac skill");
    expect(prompt).toContain("TOOLS.md describes capabilities and conventions");
    expect(prompt).not.toContain("Do not delegate");
    expect(prompt).not.toContain("Do not edit");
  });

  it("derives constraint lines and the overlay from the permission profile", () => {
    const restricted = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "restricted",
      profileConfig: resolveSubagentPermissionProfile(config, "restricted"),
    });
    expect(restricted).toContain("Do not edit project files.");
    expect(restricted).toContain("Do not delegate to another subagent.");
    expect(restricted).not.toContain("Do not use bash.");

    const offline = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "offline",
      profileConfig: resolveSubagentPermissionProfile(config, "offline"),
    });
    expect(offline).toContain("Do not use bash.");
    expect(offline).toContain("Do not use network access or network-backed tools.");
    expect(offline).toContain("Work from local files.");
  });

  it("leaves the primary prompt without a subagent overlay", () => {
    expect(
      buildSystemPromptForProfile({
        baseSystemPrompt: "base",
        profile: "primary",
        skillsSection: "skills",
      }),
    ).toBe("base\n\nskills");
  });
});
