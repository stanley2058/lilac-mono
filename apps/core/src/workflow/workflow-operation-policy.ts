import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  compareCodeUnits,
  workflowAgentProfileSchema,
  workflowLevel1ToolSchema,
  workflowReasoningSchema,
  type WorkflowCapabilityProfile,
} from "./workflow-domain";
import { isWorkflowProtectedPath } from "./workflow-protected-path";

const requestedAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  editing: z.boolean().optional(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  tools: z.array(workflowLevel1ToolSchema).max(32).optional(),
  executables: z.enum(["none", "trusted-container"]).optional(),
  level2Callables: z.array(z.string().min(1).max(200)).max(512).optional(),
  surfaceOriginOperations: z.array(z.string().min(1).max(200)).max(64).optional(),
  delegation: z.boolean().optional(),
  label: z.string().min(1).max(500).optional(),
});

const requestedAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: requestedAgentOptionsSchema.default({}),
});

export const resolvedWorkflowAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200),
  reasoning: workflowReasoningSchema,
  cwd: z.string().min(1).max(4_096),
  authorityRoot: z.string().min(1).max(4_096),
  editing: z.boolean(),
  isolation: z.enum(["shared", "worktree"]),
  tools: z.array(workflowLevel1ToolSchema),
  executables: z.enum(["none", "trusted-container"]),
  level2Callables: z.array(z.string().min(1).max(200)),
  surfaceOriginOperations: z.array(z.string().min(1).max(200)),
  delegation: z.boolean(),
  label: z.string().min(1).max(500).optional(),
});

export const resolvedWorkflowAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: resolvedWorkflowAgentOptionsSchema,
});

export type ResolvedWorkflowAgentInput = z.infer<typeof resolvedWorkflowAgentInputSchema>;

const EXPLORE_TOOLS = new Set(["batch", "glob", "grep", "read_file"]);
const EDITING_TOOLS = new Set(["apply_patch", "edit_file"]);

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertCanonicalDirectory(directory: string, label: string): Promise<string> {
  const stats = await fs.lstat(directory).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} does not exist or is inaccessible: ${directory} (${message})`);
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  const canonical = await fs.realpath(directory);
  if (canonical !== directory) {
    throw new Error(`${label} must be canonical and symlink-free: ${directory}`);
  }
  return canonical;
}

async function resolveCwd(input: {
  requestedCwd: string;
  projectRoot: string;
  allowedRoots: readonly string[];
}): Promise<{ cwd: string; authorityRoot: string }> {
  if (
    !path.isAbsolute(input.requestedCwd) ||
    path.normalize(input.requestedCwd) !== input.requestedCwd
  ) {
    throw new Error(`Agent cwd must be a canonical absolute path: ${input.requestedCwd}`);
  }
  const roots = await Promise.all(
    input.allowedRoots.map(async (root) => {
      const resolved = root === "project" ? input.projectRoot : root;
      if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) {
        throw new Error(`Approved workflow root is not a canonical absolute path: ${root}`);
      }
      const canonical = await assertCanonicalDirectory(resolved, "Approved workflow root");
      if (isWorkflowProtectedPath(path.parse(canonical).root, canonical)) {
        throw new Error(`Approved workflow root is protected: ${canonical}`);
      }
      return canonical;
    }),
  );
  const cwd = await assertCanonicalDirectory(input.requestedCwd, "Agent cwd");
  const authorityRoot = roots
    .filter((root) => isContained(root, cwd))
    .sort((left, right) => right.length - left.length || compareCodeUnits(left, right))[0];
  if (!authorityRoot) throw new Error(`Agent cwd is outside the approved roots: ${cwd}`);
  if (isWorkflowProtectedPath(authorityRoot, cwd)) {
    throw new Error(`Agent cwd is inside a protected path: ${cwd}`);
  }
  return { cwd, authorityRoot };
}

function assertApproved(value: string, approved: readonly string[], field: string): void {
  if (!approved.includes(value)) throw new Error(`Agent ${field} is not approved: ${value}`);
}

export async function resolveWorkflowAgentOperationInput(input: {
  value: unknown;
  capabilities: WorkflowCapabilityProfile;
  canonicalWorkspaceRoot: string;
}): Promise<ResolvedWorkflowAgentInput> {
  const parsed = requestedAgentInputSchema.parse(input.value);
  const envelope = input.capabilities.agents;
  const profile = parsed.options.profile ?? envelope.profiles[0];
  const model =
    parsed.options.model ?? (envelope.models.includes("inherit") ? "inherit" : envelope.models[0]);
  const reasoning =
    parsed.options.reasoning ??
    (envelope.reasoning.includes("provider-default") ? "provider-default" : envelope.reasoning[0]);
  if (!profile) throw new Error("Agent profile envelope is empty");
  if (!model) throw new Error("Agent model envelope is empty");
  if (!reasoning) throw new Error("Agent reasoning envelope is empty");
  assertApproved(profile, envelope.profiles, "profile");
  assertApproved(model, envelope.models, "model");
  assertApproved(reasoning, envelope.reasoning, "reasoning");

  const editing = parsed.options.editing ?? false;
  if (editing && profile === "explore")
    throw new Error("Explore agent operations must be read-only");
  if (!editing && parsed.options.isolation !== undefined) {
    throw new Error("Agent isolation can be selected only for an editing operation");
  }
  if (editing && parsed.options.isolation === undefined && envelope.editing.length > 1) {
    throw new Error("Agent isolation must be selected when multiple editing modes are approved");
  }
  const isolation = editing ? (parsed.options.isolation ?? envelope.editing[0]) : "shared";
  if (!isolation) throw new Error("Agent editing is not approved");
  if (editing) assertApproved(isolation, envelope.editing, "editing isolation");

  const delegation = parsed.options.delegation ?? false;
  if (delegation && !envelope.delegation) throw new Error("Agent delegation is not approved");
  if (delegation && profile !== "self") {
    throw new Error("Only self-profile agent operations may enable delegation");
  }

  const compatibleTools = envelope.tools.filter(
    (tool) =>
      (profile !== "explore" || EXPLORE_TOOLS.has(tool)) &&
      (editing || !EDITING_TOOLS.has(tool)) &&
      (delegation || tool !== "subagent_delegate"),
  );
  const requestedTools = parsed.options.tools ?? compatibleTools;
  const tools = [...new Set(requestedTools)].sort(compareCodeUnits);
  for (const tool of tools) {
    assertApproved(tool, envelope.tools, "tool");
    if (profile === "explore" && !EXPLORE_TOOLS.has(tool)) {
      throw new Error(`Explore profile cannot expose Level-1 tool: ${tool}`);
    }
    if (!editing && EDITING_TOOLS.has(tool)) {
      throw new Error(`Read-only agent operation cannot expose editing tool: ${tool}`);
    }
    if (tool === "subagent_delegate" && !delegation) {
      throw new Error("subagent_delegate requires operation delegation authority");
    }
  }
  if (delegation && !tools.includes("subagent_delegate")) {
    throw new Error("Delegation-enabled operations must expose subagent_delegate");
  }

  const executables = parsed.options.executables ?? "none";
  if (executables === "trusted-container" && envelope.executables !== "trusted-container") {
    throw new Error("Agent executable authority is not approved: trusted-container");
  }
  if (executables !== "none" && !tools.includes("bash")) {
    throw new Error("Agent executable authority requires the bash tool");
  }
  const level2Callables = [...new Set(parsed.options.level2Callables ?? [])].sort(compareCodeUnits);
  for (const callableId of level2Callables) {
    assertApproved(callableId, input.capabilities.level2.callables, "Level-2 callable");
  }
  const surfaceOriginOperations = [...new Set(parsed.options.surfaceOriginOperations ?? [])].sort(
    compareCodeUnits,
  );
  for (const callableId of surfaceOriginOperations) {
    assertApproved(callableId, input.capabilities.surfaces.origin, "origin surface operation");
    if (!level2Callables.includes(callableId)) {
      throw new Error(`Origin surface operation requires selected Level-2 callable: ${callableId}`);
    }
  }

  const location = await resolveCwd({
    requestedCwd: parsed.options.cwd ?? input.canonicalWorkspaceRoot,
    projectRoot: input.canonicalWorkspaceRoot,
    allowedRoots: envelope.allowedRoots,
  });
  return resolvedWorkflowAgentInputSchema.parse({
    prompt: parsed.prompt,
    options: {
      profile,
      model,
      reasoning,
      cwd: location.cwd,
      authorityRoot: location.authorityRoot,
      editing,
      isolation,
      tools,
      executables,
      level2Callables,
      surfaceOriginOperations,
      delegation,
      ...(parsed.options.label ? { label: parsed.options.label } : {}),
    },
  });
}
