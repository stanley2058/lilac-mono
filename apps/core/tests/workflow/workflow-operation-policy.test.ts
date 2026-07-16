import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveWorkflowAgentOperationInput } from "../../src/workflow/workflow-operation-policy";

describe("workflow profile-native operation policy", () => {
  it("requires a profile and preserves omitted native model and reasoning defaults", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-policy-"));
    const cwd = path.join(project, "packages", "api");
    await fs.mkdir(cwd, { recursive: true });
    try {
      const resolved = await resolveWorkflowAgentOperationInput({
        value: {
          prompt: "Implement the API fix",
          options: { profile: "general", cwd, label: "API editor" },
        },
        canonicalWorkspaceRoot: project,
      });
      expect(resolved).toMatchObject({
        prompt: "Implement the API fix",
        options: {
          profile: "general",
          cwd,
          authorityRoot: cwd,
          isolation: "shared",
          label: "API editor",
        },
      });
      expect(resolved.options.cwdIdentity.dev).toMatch(/^\d+$/u);
      expect(resolved.options.cwdIdentity.ino).toMatch(/^\d+$/u);
      expect(resolved.options.authorityRootIdentity).toEqual(resolved.options.cwdIdentity);

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

  it("accepts only profile-native options and validates cwd boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-denial-"));
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    const dataDir = path.join(root, "data");
    const dataSecret = path.join(dataDir, "secret");
    const protectedCwd = path.join(project, ".ssh");
    const symlink = path.join(project, "linked-outside");
    await Promise.all([
      fs.mkdir(project),
      fs.mkdir(outside),
      fs.mkdir(dataSecret, { recursive: true }),
    ]);
    await fs.mkdir(protectedCwd);
    await fs.symlink(outside, symlink);
    const resolve = (options: Record<string, unknown>) =>
      resolveWorkflowAgentOperationInput({
        value: { prompt: "Inspect", options: { profile: "general", ...options } },
        canonicalWorkspaceRoot: project,
        dataDir,
      });
    try {
      expect(
        await resolve({ model: "deep", reasoning: "high", isolation: "worktree" }),
      ).toMatchObject({
        options: {
          profile: "general",
          model: "deep",
          reasoning: "high",
          isolation: "worktree",
        },
      });
      for (const field of [
        "editing",
        "tools",
        "executables",
        "level2Callables",
        "surfaceOriginOperations",
        "delegation",
      ]) {
        await expect(resolve({ [field]: field === "editing" })).rejects.toThrow(
          "migrate to profile-native agent() options",
        );
      }
      await expect(resolve({ cwd: path.join(project, "missing") })).rejects.toThrow(
        "does not exist",
      );
      expect(await resolve({ cwd: outside })).toMatchObject({
        options: { cwd: outside, authorityRoot: outside },
      });
      expect(await resolve({ cwd: "../outside" })).toMatchObject({
        options: { cwd: outside, authorityRoot: outside },
      });
      expect(await resolve({ cwd: symlink })).toMatchObject({
        options: { cwd: outside, authorityRoot: outside },
      });
      expect(await resolve({ cwd: protectedCwd })).toMatchObject({
        options: { cwd: protectedCwd, authorityRoot: protectedCwd },
      });
      await expect(resolve({ cwd: dataSecret })).rejects.toThrow("deployment denied root");
      await expect(resolve({ cwd: path.parse(project).root })).rejects.toThrow(
        "deployment denied root",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
