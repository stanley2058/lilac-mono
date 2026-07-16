import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { workflowAgentProfileSchema, workflowReasoningSchema } from "./workflow-domain";
import {
  assertWorkflowPathAllowed,
  assertWorkflowWritableRootAllowed,
  createWorkflowDeniedRootPolicy,
} from "./workflow-denied-root-policy";
import {
  openPinnedWorkflowRoot,
  workflowPathIdentity,
  workflowPathIdentitySchema,
} from "./workflow-descriptor-path";

const requestedAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  label: z.string().min(1).max(500).optional(),
});

const requestedAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: requestedAgentOptionsSchema,
});

export const resolvedWorkflowAgentOptionsSchema = z.strictObject({
  profile: workflowAgentProfileSchema,
  model: z.string().min(1).max(200).optional(),
  reasoning: workflowReasoningSchema.optional(),
  cwd: z.string().min(1).max(4_096),
  cwdIdentity: workflowPathIdentitySchema,
  authorityRoot: z.string().min(1).max(4_096),
  authorityRootIdentity: workflowPathIdentitySchema,
  isolation: z.enum(["shared", "worktree"]),
  label: z.string().min(1).max(500).optional(),
});

export const resolvedWorkflowAgentInputSchema = z.strictObject({
  prompt: z.string().min(1).max(1_000_000),
  options: resolvedWorkflowAgentOptionsSchema,
});

export type ResolvedWorkflowAgentInput = z.infer<typeof resolvedWorkflowAgentInputSchema>;

const REMOVED_AGENT_OPTIONS = [
  "editing",
  "tools",
  "executables",
  "level2Callables",
  "surfaceOriginOperations",
  "delegation",
] as const;

async function resolveCanonicalDirectory(
  directory: string,
  label: string,
): Promise<{ path: string; identity: z.infer<typeof workflowPathIdentitySchema> }> {
  await fs.lstat(directory).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} does not exist or is inaccessible: ${directory} (${message})`);
  });
  const canonical = await fs.realpath(directory);
  const handle = await openPinnedWorkflowRoot(canonical, label);
  const identity = workflowPathIdentity(await handle.stat({ bigint: true }));
  await handle.close();
  await fs.access(canonical, constants.R_OK | constants.X_OK).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not accessible to the service UID: ${directory} (${message})`);
  });
  return { path: canonical, identity };
}

async function resolveCwd(input: {
  requestedCwd: string;
  projectRoot: string;
  dataDir: string;
}): Promise<{
  cwd: string;
  cwdIdentity: z.infer<typeof workflowPathIdentitySchema>;
  authorityRoot: string;
  authorityRootIdentity: z.infer<typeof workflowPathIdentitySchema>;
}> {
  const projectRoot = await resolveCanonicalDirectory(input.projectRoot, "Workflow project root");
  const requested = path.isAbsolute(input.requestedCwd)
    ? path.resolve(input.requestedCwd)
    : path.resolve(projectRoot.path, input.requestedCwd);
  const cwd = await resolveCanonicalDirectory(requested, "Agent cwd");
  assertWorkflowPathAllowed({
    policy: createWorkflowDeniedRootPolicy(input.dataDir),
    candidate: cwd.path,
    label: "Agent cwd",
  });
  return {
    cwd: cwd.path,
    cwdIdentity: cwd.identity,
    authorityRoot: cwd.path,
    authorityRootIdentity: cwd.identity,
  };
}

export async function resolveWorkflowAgentOperationInput(input: {
  value: unknown;
  canonicalWorkspaceRoot: string;
  dataDir?: string;
}): Promise<ResolvedWorkflowAgentInput> {
  const rawInput = z.record(z.string(), z.unknown()).safeParse(input.value);
  const rawOptions = rawInput.success
    ? z.record(z.string(), z.unknown()).safeParse(rawInput.data["options"])
    : null;
  if (rawOptions?.success) {
    const removed = REMOVED_AGENT_OPTIONS.find((field) => field in rawOptions.data);
    if (removed) {
      throw new Error(
        `Workflow agent option '${removed}' was removed; migrate to profile-native agent() options`,
      );
    }
  }
  const parsed = requestedAgentInputSchema.parse(input.value);
  const location = await resolveCwd({
    requestedCwd: parsed.options.cwd ?? input.canonicalWorkspaceRoot,
    projectRoot: input.canonicalWorkspaceRoot,
    dataDir: input.dataDir ?? path.join(input.canonicalWorkspaceRoot, ".lilac-data"),
  });
  if (parsed.options.profile !== "explore") {
    assertWorkflowWritableRootAllowed({
      policy: createWorkflowDeniedRootPolicy(
        input.dataDir ?? path.join(input.canonicalWorkspaceRoot, ".lilac-data"),
      ),
      candidate: location.authorityRoot,
      label: "Agent writable authority root",
    });
  }
  return resolvedWorkflowAgentInputSchema.parse({
    prompt: parsed.prompt,
    options: {
      profile: parsed.options.profile,
      ...(parsed.options.model ? { model: parsed.options.model } : {}),
      ...(parsed.options.reasoning ? { reasoning: parsed.options.reasoning } : {}),
      cwd: location.cwd,
      cwdIdentity: location.cwdIdentity,
      authorityRoot: location.authorityRoot,
      authorityRootIdentity: location.authorityRootIdentity,
      isolation: parsed.options.isolation ?? "shared",
      ...(parsed.options.label ? { label: parsed.options.label } : {}),
    },
  });
}
