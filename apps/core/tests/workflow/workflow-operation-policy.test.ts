import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeWorkflowCapabilityProfile } from "../../src/workflow/workflow-domain";
import { resolveWorkflowAgentOperationInput } from "../../src/workflow/workflow-operation-policy";

function capabilities(roots: readonly string[]) {
  return normalizeWorkflowCapabilityProfile({
    agents: {
      profiles: ["explore", "general", "self"],
      models: ["deep", "inherit"],
      reasoning: ["high", "low", "provider-default"],
      allowedRoots: roots,
      tools: ["apply_patch", "bash", "batch", "glob", "grep", "read_file", "subagent_delegate"],
      executables: "trusted-container",
      editing: ["shared", "worktree"],
      delegation: true,
      maxConcurrent: 4,
      maxTotal: 20,
    },
    level2: { callables: ["search", "surface.messages.send"] },
    surfaces: { origin: ["surface.messages.send"] },
    maxNestingDepth: 4,
    maxWallTimeMs: 60_000,
    operationIdleTimeoutMs: 10_000,
    waits: [],
    safety: { originatingMode: "trusted", escalation: "none" },
  });
}

describe("workflow operation maximum envelope", () => {
  it("canonicalizes approved roots and persists a fully narrowed operation policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-policy-"));
    const project = path.join(root, "project");
    const sibling = path.join(root, "sibling");
    const cwd = path.join(sibling, "packages", "api");
    await Promise.all([fs.mkdir(project), fs.mkdir(cwd, { recursive: true })]);
    try {
      const resolved = await resolveWorkflowAgentOperationInput({
        value: {
          prompt: "Implement the API fix",
          options: {
            profile: "general",
            model: "deep",
            reasoning: "high",
            cwd,
            editing: true,
            isolation: "shared",
            tools: ["read_file", "bash", "apply_patch", "read_file"],
            executables: "trusted-container",
            level2Callables: ["surface.messages.send", "search", "search"],
            surfaceOriginOperations: ["surface.messages.send"],
            delegation: false,
            label: "API editor",
          },
        },
        capabilities: capabilities(["project", sibling]),
        canonicalWorkspaceRoot: project,
      });

      expect(resolved).toEqual({
        prompt: "Implement the API fix",
        options: {
          profile: "general",
          model: "deep",
          reasoning: "high",
          cwd,
          authorityRoot: sibling,
          editing: true,
          isolation: "shared",
          tools: ["apply_patch", "bash", "read_file"],
          executables: "trusted-container",
          level2Callables: ["search", "surface.messages.send"],
          surfaceOriginOperations: ["surface.messages.send"],
          delegation: false,
          label: "API editor",
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects widening, nonexistent cwd, outside roots, protected paths, and symlink escapes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-operation-denial-"));
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    const protectedCwd = path.join(project, ".ssh");
    const symlink = path.join(project, "linked-outside");
    await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
    await fs.mkdir(protectedCwd);
    await fs.symlink(outside, symlink);
    const envelope = capabilities(["project"]);
    const resolve = (options: Record<string, unknown>) =>
      resolveWorkflowAgentOperationInput({
        value: { prompt: "Inspect", options },
        capabilities: envelope,
        canonicalWorkspaceRoot: project,
      });
    try {
      await expect(resolve({ reasoning: "xhigh" })).rejects.toThrow("reasoning is not approved");
      await expect(resolve({ model: "unreviewed" })).rejects.toThrow("model is not approved");
      await expect(resolve({ profile: "general", tools: ["apply_patch"] })).rejects.toThrow(
        "Read-only agent operation",
      );
      await expect(resolve({ profile: "explore", editing: true })).rejects.toThrow("read-only");
      await expect(resolve({ profile: "general", editing: true })).rejects.toThrow(
        "isolation must be selected",
      );
      await expect(resolve({ level2Callables: ["unknown"] })).rejects.toThrow("not approved");
      await expect(resolve({ surfaceOriginOperations: ["surface.messages.send"] })).rejects.toThrow(
        "requires selected Level-2 callable",
      );
      await expect(resolve({ executables: "trusted-container" })).rejects.toThrow(
        "requires the bash tool",
      );
      await expect(resolve({ cwd: path.join(project, "missing") })).rejects.toThrow(
        "does not exist",
      );
      await expect(resolve({ cwd: outside })).rejects.toThrow("outside the approved roots");
      await expect(resolve({ cwd: symlink })).rejects.toThrow("real directory");
      await expect(resolve({ cwd: protectedCwd })).rejects.toThrow("protected path");
      await expect(
        resolve({ profile: "self", delegation: true, tools: ["read_file"] }),
      ).rejects.toThrow("must expose subagent_delegate");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
