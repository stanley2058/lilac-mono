import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalJsonSha256 } from "../../src/workflow/workflow-definition";
import { resolveWorkflowAgentOperationInput } from "../../src/workflow/workflow-operation-policy";

describe("workflow profile-native operation policy", () => {
  it("persists only profile-native options with a normalized cwd", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-policy-"));
    try {
      const resolved = await resolveWorkflowAgentOperationInput({
        value: {
          prompt: "Implement the API fix",
          options: {
            profile: "general",
            model: "deep",
            reasoning: "high",
            cwd: "packages/../packages/api",
            label: "API editor",
          },
        },
        canonicalWorkspaceRoot: project,
      });
      expect(resolved).toEqual({
        prompt: "Implement the API fix",
        options: {
          profile: "general",
          model: "deep",
          reasoning: "high",
          cwd: path.join(project, "packages/api"),
          label: "API editor",
        },
      });

      await expect(
        resolveWorkflowAgentOperationInput({
          value: { prompt: "Inspect", options: {} },
          canonicalWorkspaceRoot: project,
        }),
      ).rejects.toThrow("profile");
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("keeps canonical operation input stable without filesystem identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-stability-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const value = {
        prompt: "Inspect",
        options: { profile: "explore" as const, cwd: "../missing/./child" },
      };
      const first = await resolveWorkflowAgentOperationInput({
        value,
        canonicalWorkspaceRoot: project,
      });
      await fs.mkdir(path.join(root, "missing/child"), { recursive: true });
      const second = await resolveWorkflowAgentOperationInput({
        value,
        canonicalWorkspaceRoot: project,
      });
      expect(first).toEqual(second);
      expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
      expect(first.options.cwd).toBe(path.join(root, "missing/child"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects removed workflow authority and isolation options", async () => {
    for (const field of [
      "editing",
      "tools",
      "executables",
      "level2Callables",
      "surfaceOriginOperations",
      "delegation",
      "isolation",
    ]) {
      await expect(
        resolveWorkflowAgentOperationInput({
          value: { prompt: "Inspect", options: { profile: "general", [field]: true } },
          canonicalWorkspaceRoot: "/workspace",
        }),
      ).rejects.toThrow("migrate to profile-native agent() options");
    }
  });
});
