import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@stanley2058/lilac-utils";
import { z } from "zod";

import { collectApplyPatchTouchedPaths } from "../tools/batch";
import type { WorkflowRequestPolicy } from "./workflow-request-authority";
import { isWorkflowProtectedPath } from "./workflow-protected-path";

const toolInputSchema = z.record(z.string(), z.unknown());
const WORKFLOW_READ_TOOLS = new Set(["read_file", "glob", "grep"]);
const WORKFLOW_WRITE_TOOLS = new Set(["edit_file", "apply_patch"]);

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertUnprotected(root: string, candidate: string): void {
  if (isWorkflowProtectedPath(root, candidate)) {
    throw new Error("Workflow Level-1 tools cannot access protected workspace paths");
  }
}

async function assertCanonicalRoot(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(root)) !== root) {
    throw new Error("Workflow Level-1 root is not a canonical real directory");
  }
}

async function assertContainedPath(input: {
  root: string;
  baseCwd?: string;
  value: string;
  requireFile: boolean;
  rejectHardLinks?: boolean;
}): Promise<string> {
  if (input.value.includes("\0")) throw new Error("Workflow Level-1 path contains NUL");
  const candidate = path.resolve(input.baseCwd ?? input.root, input.value);
  if (!isContained(input.root, candidate)) {
    throw new Error("Workflow Level-1 path escaped the authoritative root");
  }
  assertUnprotected(input.root, candidate);

  const relative = path.relative(input.root, candidate);
  let current = input.root;
  let missing = false;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (missing) continue;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("Workflow Level-1 paths must not traverse symbolic links");
      }
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") {
        missing = true;
        continue;
      }
      throw error;
    }
  }
  if (input.requireFile) {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(candidate)) !== candidate) {
      throw new Error("Workflow Level-1 read/edit target must be a canonical regular file");
    }
  }
  if (input.rejectHardLinks) {
    const stat = await fs.lstat(candidate).catch((error: unknown) => {
      if (isRecord(error) && error["code"] === "ENOENT") return null;
      throw error;
    });
    if (stat?.isFile() && stat.nlink > 1) {
      throw new Error("Workflow Level-1 target must not be a hard-linked file");
    }
  }
  return candidate;
}

function assertNoOverrides(value: Record<string, unknown>): void {
  if (value["cwd"] !== undefined) {
    throw new Error("Workflow Level-1 tools do not accept alternate or SSH cwd values");
  }
  if (value["dangerouslyAllow"] !== undefined) {
    throw new Error("Workflow Level-1 tools do not accept dangerouslyAllow");
  }
}

function assertSafeGlobPatterns(value: Record<string, unknown>): void {
  const patterns = z.array(z.string().min(1)).parse(value["patterns"]);
  for (const original of patterns) {
    const pattern = original.startsWith("!") ? original.slice(1) : original;
    if (
      path.isAbsolute(pattern) ||
      pattern.startsWith("~") ||
      pattern.split(/[\\/]/u).includes("..")
    ) {
      throw new Error("Workflow glob patterns must remain relative to the authoritative root");
    }
  }
}

async function authorizeInput(input: {
  toolName: string;
  value: Record<string, unknown>;
  policy: WorkflowRequestPolicy;
  ownedWorktreeRoot?: string;
}): Promise<Record<string, unknown>> {
  assertNoOverrides(input.value);
  const cwd = input.policy.canonicalCwd;
  const root = input.policy.isolation === "shared" ? input.policy.canonicalAuthorityRoot : cwd;
  await assertCanonicalRoot(cwd);
  if (root !== cwd) await assertCanonicalRoot(root);
  if (input.policy.isolation === "shared" && !isContained(root, cwd)) {
    throw new Error("Shared workflow cwd is outside its canonical authority root");
  }

  if (WORKFLOW_WRITE_TOOLS.has(input.toolName)) {
    if (!input.policy.editing) throw new Error("Workflow write tools require editing authority");
    if (input.policy.isolation === "shared") {
      await assertCanonicalRoot(input.policy.canonicalAuthorityRoot);
    } else {
      if (!input.ownedWorktreeRoot) {
        throw new Error("Worktree workflow writes require an approved owned worktree");
      }
      await assertCanonicalRoot(input.ownedWorktreeRoot);
      if (!isContained(input.ownedWorktreeRoot, root) || root === input.ownedWorktreeRoot) {
        throw new Error("Workflow write root is outside the owned worktree directory");
      }
    }
  } else if (!WORKFLOW_READ_TOOLS.has(input.toolName)) {
    throw new Error(`Unsupported workflow Level-1 filesystem tool: ${input.toolName}`);
  }

  if (input.toolName === "read_file" || input.toolName === "edit_file") {
    const target = z.string().min(1).parse(input.value["path"]);
    await assertContainedPath({
      root,
      baseCwd: cwd,
      value: target,
      requireFile: true,
      rejectHardLinks: true,
    });
  } else if (input.toolName === "glob") {
    assertSafeGlobPatterns(input.value);
  } else if (input.toolName === "apply_patch") {
    const patchText = z.string().min(1).parse(input.value["patchText"]);
    const targets = await collectApplyPatchTouchedPaths({ patchText, cwd });
    for (const target of targets) {
      if (!target.startsWith("file://")) {
        throw new Error("Workflow patch target escaped the local authoritative root");
      }
      await assertContainedPath({
        root,
        baseCwd: cwd,
        value: fileURLToPath(target),
        requireFile: false,
        rejectHardLinks: true,
      });
    }
  }

  return { ...input.value, cwd: undefined, dangerouslyAllow: undefined };
}

async function assertOutputContained(
  toolName: string,
  output: unknown,
  root: string,
  baseCwd: string,
): Promise<void> {
  if (!isRecord(output)) return;
  const paths: string[] = [];
  const rawPaths = output["paths"];
  if (Array.isArray(rawPaths)) {
    for (const value of rawPaths) if (typeof value === "string") paths.push(value);
  }
  const results = output["results"];
  if (Array.isArray(results)) {
    for (const result of results) {
      if (!isRecord(result)) continue;
      const resultPath = result["path"];
      if (typeof resultPath === "string") paths.push(resultPath);
      const resultFile = result["file"];
      if (typeof resultFile === "string") paths.push(resultFile);
    }
  }
  const entries = output["entries"];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry["path"] === "string") paths.push(entry["path"]);
    }
  }
  for (const resultPath of paths) {
    await assertContainedPath({
      root,
      baseCwd,
      value: resultPath,
      requireFile: false,
      rejectHardLinks: true,
    });
  }
}

export function enforceWorkflowLevel1Boundary(input: {
  tool: unknown;
  toolName: string;
  policy: WorkflowRequestPolicy | undefined;
  ownedWorktreeRoot?: string;
}): unknown {
  if (!input.policy) return input.tool;
  if (!isRecord(input.tool)) throw new Error(`Workflow tool ${input.toolName} is malformed`);
  const execute = input.tool["execute"];
  if (typeof execute !== "function") {
    throw new Error(`Workflow tool ${input.toolName} has no executable boundary`);
  }
  return {
    ...input.tool,
    execute: async (rawInput: unknown, options: unknown) => {
      const authorized = await authorizeInput({
        toolName: input.toolName,
        value: toolInputSchema.parse(rawInput),
        policy: input.policy!,
        ownedWorktreeRoot: input.ownedWorktreeRoot,
      });
      const output = await Reflect.apply(execute, input.tool, [authorized, options]);
      const outputRoot =
        input.policy!.isolation === "shared"
          ? input.policy!.canonicalAuthorityRoot
          : input.policy!.canonicalCwd;
      await assertOutputContained(input.toolName, output, outputRoot, input.policy!.canonicalCwd);
      return output;
    },
  };
}
