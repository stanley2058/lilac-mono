import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@stanley2058/lilac-utils";

import { enforceWorkflowLevel1Boundary } from "../../src/workflow/workflow-level1-boundary";
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";

async function execute(tool: unknown, input: Record<string, unknown>): Promise<unknown> {
  if (!isRecord(tool) || typeof tool["execute"] !== "function") {
    throw new Error("test tool is not executable");
  }
  return await Reflect.apply(tool["execute"], tool, [input, {}]);
}

function policy(
  root: string,
  editing: boolean,
  isolation: "shared" | "worktree" = editing ? "worktree" : "shared",
): WorkflowRequestPolicy {
  return {
    runId: "run-1",
    operationId: "operation-1",
    dispatchEpoch: "dispatch-epoch-0001",
    profile: editing ? "general" : "explore",
    model: "inherit",
    reasoning: "provider-default",
    tools: editing ? ["apply_patch", "read_file"] : ["read_file"],
    executables: "none",
    safetyMode: "restricted",
    editing,
    isolation,
    delegation: false,
    level2Callables: [],
    surfaceOriginOperations: [],
    canonicalWorkspaceRoot: root,
    canonicalAuthorityRoot: root,
    canonicalRequestedCwd: root,
    canonicalCwd: root,
    canonicalProjectId: "project-1",
    originSessionId: "channel-1",
    originClient: "discord",
    originUserId: "user-1",
    revisionId: "revision-1",
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    capabilitySha256: "c".repeat(64),
    argsSha256: "d".repeat(64),
    operationInputSha256: "e".repeat(64),
  };
}

describe("workflow Level-1 filesystem boundary", () => {
  it("rejects host, proc, SSH cwd, dangerous override, symlink, and glob escapes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level1-read-"));
    const root = path.join(temp, "workspace");
    const outside = path.join(temp, "outside.txt");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf8");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, ".config", "gh"), { recursive: true });
    await fs.mkdir(path.join(root, ".config", "project"), { recursive: true });
    await fs.mkdir(path.join(root, ".local", "project"), { recursive: true });
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.mkdir(path.join(root, ".secrets"));
    await fs.mkdir(path.join(root, ".env.local"));
    await fs.writeFile(path.join(root, ".git", "index"), "index", "utf8");
    await fs.writeFile(path.join(root, ".git", "config"), "credential", "utf8");
    await fs.writeFile(path.join(root, ".config", "gh", "hosts.yml"), "token", "utf8");
    await fs.writeFile(path.join(root, ".config", "project", "settings.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, ".local", "project", "cache"), "safe", "utf8");
    await fs.writeFile(path.join(root, ".claude", "settings.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, ".claude", ".credentials.json"), "token", "utf8");
    await fs.writeFile(path.join(root, ".npmrc"), "token", "utf8");
    await fs.writeFile(path.join(root, ".secrets", "token"), "token", "utf8");
    await fs.writeFile(path.join(root, ".envrc"), "TOKEN=1", "utf8");
    await fs.writeFile(path.join(root, ".env.local", "token"), "DESCENDANT=1", "utf8");
    await fs.writeFile(outside, "outside", "utf8");
    await fs.symlink(outside, path.join(root, "escape-link"));
    const calls: unknown[] = [];
    const original = {
      execute: async (input: unknown) => {
        calls.push(input);
        return { success: true };
      },
    };
    const read = enforceWorkflowLevel1Boundary({
      tool: original,
      toolName: "read_file",
      policy: policy(root, false),
    });
    const glob = enforceWorkflowLevel1Boundary({
      tool: original,
      toolName: "glob",
      policy: policy(root, false),
    });
    try {
      await expect(execute(read, { path: "/etc/passwd" })).rejects.toThrow("escaped");
      await expect(execute(read, { path: "/proc/self/environ" })).rejects.toThrow("escaped");
      await expect(execute(read, { path: "inside.txt", cwd: "host:/tmp" })).rejects.toThrow(
        "alternate or SSH cwd",
      );
      await expect(execute(read, { path: "inside.txt", dangerouslyAllow: true })).rejects.toThrow(
        "dangerouslyAllow",
      );
      await expect(execute(read, { path: "escape-link" })).rejects.toThrow("symbolic links");
      await expect(execute(glob, { patterns: ["/etc/**"] })).rejects.toThrow("remain relative");
      await expect(execute(glob, { patterns: ["../**"] })).rejects.toThrow("remain relative");
      await expect(execute(read, { path: ".env" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".envrc" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".env.local/token" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".git/config" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".config/gh/hosts.yml" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".npmrc" })).rejects.toThrow("protected");
      await expect(execute(read, { path: ".claude/.credentials.json" })).rejects.toThrow(
        "protected",
      );
      await expect(execute(read, { path: ".secrets/token" })).rejects.toThrow("protected");
      await expect(execute(read, { path: "inside.txt" })).resolves.toMatchObject({ success: true });
      await expect(execute(read, { path: ".git/index" })).resolves.toMatchObject({ success: true });
      await expect(execute(read, { path: ".config/project/settings.json" })).resolves.toMatchObject(
        { success: true },
      );
      await expect(execute(read, { path: ".local/project/cache" })).resolves.toMatchObject({
        success: true,
      });
      await expect(execute(read, { path: ".claude/settings.json" })).resolves.toMatchObject({
        success: true,
      });
      expect(calls).toHaveLength(5);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("requires an owned worktree and rejects edit and patch escapes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level1-write-"));
    const ownedRoot = path.join(temp, "workflow-worktrees");
    const worktree = path.join(ownedRoot, "run", "operation");
    const outside = path.join(temp, "outside.txt");
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, "inside.txt"), "inside", "utf8");
    await fs.writeFile(outside, "outside", "utf8");
    await fs.symlink(outside, path.join(worktree, "escape-link"));
    const editPolicy = policy(worktree, true);
    const original = { execute: async () => ({ success: true }) };
    const edit = enforceWorkflowLevel1Boundary({
      tool: original,
      toolName: "edit_file",
      policy: editPolicy,
      ownedWorktreeRoot: ownedRoot,
    });
    const patch = enforceWorkflowLevel1Boundary({
      tool: original,
      toolName: "apply_patch",
      policy: editPolicy,
      ownedWorktreeRoot: ownedRoot,
    });
    try {
      await expect(execute(edit, { path: outside, oldText: "out", newText: "in" })).rejects.toThrow(
        "escaped",
      );
      await expect(
        execute(edit, { path: "escape-link", oldText: "out", newText: "in" }),
      ).rejects.toThrow("symbolic links");
      await expect(
        execute(patch, {
          patchText: "*** Begin Patch\n*** Add File: /etc/lilac-owned\n+x\n*** End Patch",
        }),
      ).rejects.toThrow("escaped");
      await expect(
        execute(patch, {
          patchText:
            "*** Begin Patch\n*** Update File: escape-link\n@@\n-outside\n+changed\n*** End Patch",
        }),
      ).rejects.toThrow("symbolic links");
      await expect(
        execute(edit, { path: "inside.txt", oldText: "inside", newText: "changed" }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        execute(
          enforceWorkflowLevel1Boundary({
            tool: original,
            toolName: "edit_file",
            policy: editPolicy,
          }),
          { path: "inside.txt", oldText: "inside", newText: "changed" },
        ),
      ).rejects.toThrow("owned worktree");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("allows shared editing throughout the canonical authority root", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level1-shared-write-"));
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "inside.txt"), "inside", "utf8");
    await fs.mkdir(path.join(workspace, ".git"));
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=1", "utf8");
    await fs.writeFile(path.join(workspace, ".envrc"), "export SECRET=1", "utf8");
    await fs.writeFile(path.join(workspace, ".git", "config"), "[safe]", "utf8");
    await fs.writeFile(path.join(temp, "outside.txt"), "outside", "utf8");
    await fs.symlink(path.join(temp, "outside.txt"), path.join(workspace, "grep-link"));
    await fs.link(path.join(workspace, ".env"), path.join(workspace, "env-alias.txt"));
    await fs.link(path.join(workspace, ".git", "config"), path.join(workspace, "git-alias.txt"));
    const original = { execute: async () => ({ success: true }) };
    try {
      const shared = enforceWorkflowLevel1Boundary({
        tool: original,
        toolName: "edit_file",
        policy: policy(workspace, true, "shared"),
      });
      await expect(
        execute(shared, { path: "inside.txt", oldText: "inside", newText: "changed" }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        execute(shared, { path: ".envrc", oldText: "SECRET", newText: "TOKEN" }),
      ).rejects.toThrow("protected");
      await expect(
        execute(shared, { path: "env-alias.txt", oldText: "SECRET", newText: "TOKEN" }),
      ).rejects.toThrow("hard-linked");
      await expect(
        execute(shared, { path: "git-alias.txt", oldText: "safe", newText: "unsafe" }),
      ).rejects.toThrow("hard-linked");
      const read = enforceWorkflowLevel1Boundary({
        tool: original,
        toolName: "read_file",
        policy: policy(workspace, false),
      });
      await expect(execute(read, { path: "env-alias.txt" })).rejects.toThrow("hard-linked");
      let grepExecuted = false;
      const grep = enforceWorkflowLevel1Boundary({
        tool: {
          execute: async () => {
            grepExecuted = true;
            return { results: [{ file: "git-alias.txt", line: "safe" }] };
          },
        },
        toolName: "grep",
        policy: policy(workspace, false),
      });
      await expect(execute(grep, { pattern: "safe" })).rejects.toThrow("hard-linked");
      expect(grepExecuted).toBe(true);
      for (const [file, expected] of [
        [".env", "protected"],
        ["grep-link", "symbolic links"],
      ] as const) {
        const unsafeGrep = enforceWorkflowLevel1Boundary({
          tool: { execute: async () => ({ results: [{ file, line: 1, text: "match" }] }) },
          toolName: "grep",
          policy: policy(workspace, false),
        });
        await expect(execute(unsafeGrep, { pattern: "match" })).rejects.toThrow(expected);
      }
      const glob = enforceWorkflowLevel1Boundary({
        tool: { execute: async () => ({ paths: ["env-alias.txt"] }) },
        toolName: "glob",
        policy: policy(workspace, false),
      });
      await expect(execute(glob, { patterns: ["*.txt"] })).rejects.toThrow("hard-linked");
      const sharedPatch = enforceWorkflowLevel1Boundary({
        tool: original,
        toolName: "apply_patch",
        policy: policy(workspace, true, "shared"),
      });
      await expect(
        execute(sharedPatch, {
          patchText:
            "*** Begin Patch\n*** Update File: env-alias.txt\n@@\n-SECRET=1\n+SECRET=2\n*** End Patch",
        }),
      ).rejects.toThrow("hard-linked");

      const sibling = path.join(temp, "sibling.txt");
      await fs.writeFile(sibling, "sibling", "utf8");
      const broaderAuthority = enforceWorkflowLevel1Boundary({
        tool: original,
        toolName: "edit_file",
        policy: {
          ...policy(workspace, true, "shared"),
          canonicalAuthorityRoot: temp,
        },
      });
      await expect(
        execute(broaderAuthority, {
          path: sibling,
          oldText: "sibling",
          newText: "changed",
        }),
      ).resolves.toMatchObject({ success: true });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
