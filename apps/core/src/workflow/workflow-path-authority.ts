import fs from "node:fs/promises";
import path from "node:path";

import type { ServerToolWorkflowPathAuthority } from "@stanley2058/lilac-plugin-runtime";
import { z } from "zod";

import {
  assertWorkflowPathAllowed,
  type WorkflowDeniedRootPolicy,
  workflowDeniedRootPolicyForScratch,
} from "./workflow-denied-root-policy";
import { assertWorkflowPathIdentity } from "./workflow-descriptor-path";
import { WORKFLOW_SCRATCH_MOUNT } from "./workflow-scratch";

type WorkflowPathPolicy = {
  canonicalCwd: string;
  canonicalCwdIdentity: { dev: string; ino: string };
  canonicalScratchRoot: string;
};

const workflowPathInputSchema = z.strictObject({
  field: z.string().min(1).max(200),
  aliases: z.array(z.string().min(1).max(200)).max(16).optional(),
  cardinality: z.enum(["one", "many"]),
  target: z.enum(["read-file", "write-directory", "write-file"]),
  default: z.literal("cwd").optional(),
});

const workflowPathAuthoritySchema = z.strictObject({
  inputs: z.array(workflowPathInputSchema).max(64),
});

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function translateScratchPath(policy: WorkflowPathPolicy, requestedPath: string): string {
  if (requestedPath === WORKFLOW_SCRATCH_MOUNT) return policy.canonicalScratchRoot;
  if (!requestedPath.startsWith(`${WORKFLOW_SCRATCH_MOUNT}/`)) return requestedPath;
  const normalized = path.normalize(requestedPath);
  if (!isContained(WORKFLOW_SCRATCH_MOUNT, normalized)) {
    throw new Error("Workflow tool path escaped the stable run scratch mount");
  }
  return path.join(policy.canonicalScratchRoot, path.relative(WORKFLOW_SCRATCH_MOUNT, normalized));
}

function authorityRoot(policy: WorkflowPathPolicy, requestedPath: string): string {
  if (!path.isAbsolute(requestedPath)) return policy.canonicalCwd;
  const candidate = path.resolve(requestedPath);
  if (isContained(policy.canonicalCwd, candidate)) return policy.canonicalCwd;
  if (isContained(policy.canonicalScratchRoot, candidate)) return policy.canonicalScratchRoot;
  throw new Error("Workflow tool path escaped the operation cwd and run scratch roots");
}

async function canonicalizePath(input: {
  requestedPath: string;
  target: "read-file" | "write-directory" | "write-file";
  policy: WorkflowPathPolicy;
  deniedRootPolicy?: WorkflowDeniedRootPolicy;
}): Promise<{ path: string; requestedPath: string }> {
  const requestedPath = translateScratchPath(input.policy, input.requestedPath);
  const root = authorityRoot(input.policy, requestedPath);
  await assertWorkflowPathIdentity({
    candidate: input.policy.canonicalCwd,
    expected: input.policy.canonicalCwdIdentity,
    label: "Workflow Level-2 cwd",
  });

  let canonical: string;
  if (input.target === "write-file") {
    const lexical = path.resolve(root, requestedPath);
    if (lexical === root) throw new Error("Workflow output file must not replace its root");
    const parent = await fs.realpath(path.dirname(lexical));
    canonical = path.join(parent, path.basename(lexical));
  } else {
    canonical = await fs.realpath(path.resolve(root, requestedPath));
  }
  if (!isContained(root, canonical)) {
    throw new Error("Workflow tool path escaped the approved cwd or scratch root");
  }
  assertWorkflowPathAllowed({
    policy:
      input.deniedRootPolicy ??
      workflowDeniedRootPolicyForScratch(input.policy.canonicalScratchRoot),
    candidate: canonical,
    scratchRoot: input.policy.canonicalScratchRoot,
    label: "Workflow Level-2 path",
  });

  if (input.target !== "write-file") {
    const stats = await fs.stat(canonical);
    if (input.target === "read-file" && (!stats.isFile() || stats.nlink > 1)) {
      throw new Error("Workflow read path must be a regular non-linked file");
    }
    if (input.target === "write-directory" && !stats.isDirectory()) {
      throw new Error("Workflow output directory must be a directory");
    }
  }
  return { path: canonical, requestedPath: input.requestedPath };
}

function pathValues(value: unknown, cardinality: "one" | "many"): string[] {
  if (cardinality === "one") return [z.string().min(1).parse(value)];
  return z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(64)])
    .transform((paths) => (Array.isArray(paths) ? paths : [paths]))
    .parse(value);
}

export async function authorizeWorkflowPathInput(input: {
  callableId: string;
  value: Record<string, unknown>;
  policy: WorkflowPathPolicy;
  authority: ServerToolWorkflowPathAuthority | undefined;
  deniedRootPolicy?: WorkflowDeniedRootPolicy;
}): Promise<{
  value: Record<string, unknown>;
  restoreOutput(value: unknown): unknown;
  close(): Promise<void>;
}> {
  const authority = input.authority
    ? workflowPathAuthoritySchema.parse(input.authority)
    : { inputs: [] };
  const declaredFields = new Set<string>();
  const replacements: Array<{ canonical: string; requested: string }> = [];
  const value = { ...input.value };

  for (const descriptor of authority.inputs) {
    const fields = [descriptor.field, ...(descriptor.aliases ?? [])];
    for (const field of fields) {
      if (declaredFields.has(field)) {
        throw new Error(`Workflow path authority declares duplicate field: ${field}`);
      }
      declaredFields.add(field);
    }
    const supplied = fields.filter((field) => input.value[field] !== undefined);
    if (supplied.length > 1) {
      throw new Error(`Workflow path input has conflicting aliases: ${supplied.join(", ")}`);
    }
    const field = supplied[0] ?? descriptor.field;
    const raw = supplied[0]
      ? input.value[supplied[0]]
      : descriptor.default === "cwd"
        ? input.policy.canonicalCwd
        : undefined;
    if (raw === undefined) continue;
    const authorized = await Promise.all(
      pathValues(raw, descriptor.cardinality).map(async (requestedPath) =>
        await canonicalizePath({
          requestedPath,
          target: descriptor.target,
          policy: input.policy,
          deniedRootPolicy: input.deniedRootPolicy,
        }),
      ),
    );
    replacements.push(
      ...authorized.map((entry) => ({ canonical: entry.path, requested: entry.requestedPath })),
    );
    value[field] =
      descriptor.cardinality === "one"
        ? authorized[0]!.path
        : authorized.map((entry) => entry.path);
  }

  const restore = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      const replacement = replacements.find(
        (entry) =>
          candidate === entry.canonical || candidate.startsWith(`${entry.canonical}${path.sep}`),
      );
      return replacement
        ? `${replacement.requested}${candidate.slice(replacement.canonical.length)}`
        : candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(restore);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate).map(([key, child]) => [key, restore(child)]));
  };

  return { value, restoreOutput: restore, close: async () => {} };
}
