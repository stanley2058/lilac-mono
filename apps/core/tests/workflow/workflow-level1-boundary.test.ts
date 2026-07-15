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
    safetyMode: "restricted",
    editing,
    isolation,
    externalTools: false,
    surfaceSends: false,
    subagents: false,
    canonicalWorkspaceRoot: root,
    canonicalCwd: root,
    canonicalProjectId: "project-1",
    originSessionId: "channel-1",
    originClient: "discord",
    revisionId: "revision-1",
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    capabilitySha256: "c".repeat(64),
    argsSha256: "d".repeat(64),
  };
}

describe("workflow Level-1 filesystem boundary", () => {
  it("rejects host, proc, SSH cwd, dangerous override, symlink, and glob escapes", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level1-read-"));
    const root = path.join(temp, "workspace");
    const outside = path.join(temp, "outside.txt");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf8");
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
      await expect(execute(read, { path: "inside.txt" })).resolves.toMatchObject({ success: true });
      expect(calls).toHaveLength(1);
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

  it("allows shared editing only at the canonical workspace root", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-level1-shared-write-"));
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "inside.txt"), "inside", "utf8");
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

      const escapedAuthority = enforceWorkflowLevel1Boundary({
        tool: original,
        toolName: "edit_file",
        policy: {
          ...policy(workspace, true, "shared"),
          canonicalWorkspaceRoot: temp,
        },
      });
      await expect(
        execute(escapedAuthority, {
          path: "inside.txt",
          oldText: "inside",
          newText: "changed",
        }),
      ).rejects.toThrow("canonical workspace root");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
