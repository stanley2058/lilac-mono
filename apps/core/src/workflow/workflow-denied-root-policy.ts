import path from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export type WorkflowDeniedRootPolicy = {
  dataDir: string;
  scratchContainerRoot: string;
  absoluteDeniedRoots: readonly string[];
};

const SYSTEM_DENIED_ROOTS = ["/run/lilac", "/root", "/etc/lilac"] as const;

const DATA_DIR_DENIED_ENTRIES = [
  "cmds",
  "plugins",
  "prompts",
  "secret",
  "skills",
  "tool-results",
  "workflow-artifacts",
  "workflow-runtime",
  "workflow-worktree-artifacts",
  "workflow-worktrees",
  "workflows",
] as const;

const HOME_DENIED_ENTRIES = [
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".gitconfig",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".config/gh",
  ".config/gcloud",
  ".config/glab-cli",
  ".config/op",
  ".config/opencode",
  ".local/share/keyrings",
  ".local/share/opencode",
  ".claude/.credentials.json",
  ".codex/auth.json",
] as const;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function createWorkflowDeniedRootPolicy(dataDir: string): WorkflowDeniedRootPolicy {
  const resolvedDataDir = path.resolve(dataDir);
  const canonicalDataDir = (() => {
    try {
      return realpathSync.native(resolvedDataDir);
    } catch {
      return resolvedDataDir;
    }
  })();
  const scratchContainerRoot = path.join(canonicalDataDir, "workflow-runtime", "scratch");
  return {
    dataDir: canonicalDataDir,
    scratchContainerRoot,
    absoluteDeniedRoots: [
      path.parse(canonicalDataDir).root,
      ...SYSTEM_DENIED_ROOTS,
      ...HOME_DENIED_ENTRIES.map((entry) => path.join(homedir(), entry)),
      path.join(canonicalDataDir, "core-config.yaml"),
      path.join(canonicalDataDir, "core-config.yml"),
      path.join(canonicalDataDir, "data.sqlite3"),
      path.join(canonicalDataDir, "discord-search.db"),
      path.join(canonicalDataDir, "discord-surface.db"),
      path.join(canonicalDataDir, "agent-transcripts.db"),
      path.join(canonicalDataDir, "graceful-restart.db"),
      ...DATA_DIR_DENIED_ENTRIES.map((entry) => path.join(canonicalDataDir, entry)),
    ].map((entry) => path.resolve(entry)),
  };
}

export function workflowWritableRootDenialReason(input: {
  policy: WorkflowDeniedRootPolicy;
  candidate: string;
  scratchRoot?: string;
}): string | null {
  return workflowPathDenialReason(input);
}

export function assertWorkflowWritableRootAllowed(input: {
  policy: WorkflowDeniedRootPolicy;
  candidate: string;
  scratchRoot?: string;
  label?: string;
}): void {
  const reason = workflowWritableRootDenialReason(input);
  if (reason) {
    throw new Error(
      `${input.label ?? "Workflow writable root"} is globally denied (${reason}): ${input.candidate}`,
    );
  }
}

export function workflowDeniedRootPolicyForScratch(scratchRoot: string): WorkflowDeniedRootPolicy {
  return createWorkflowDeniedRootPolicy(path.resolve(scratchRoot, "../../.."));
}

function isAuthorizedScratchException(input: {
  policy: WorkflowDeniedRootPolicy;
  candidate: string;
  scratchRoot?: string;
}): boolean {
  if (!input.scratchRoot) return false;
  const scratchRoot = path.resolve(input.scratchRoot);
  return (
    scratchRoot !== input.policy.scratchContainerRoot &&
    path.dirname(scratchRoot) === input.policy.scratchContainerRoot &&
    isContained(scratchRoot, input.candidate)
  );
}

export function workflowPathDenialReason(input: {
  policy: WorkflowDeniedRootPolicy;
  candidate: string;
  scratchRoot?: string;
}): string | null {
  const candidate = path.resolve(input.candidate);
  for (const deniedRoot of input.policy.absoluteDeniedRoots) {
    const filesystemRoot = path.parse(deniedRoot).root;
    if (
      deniedRoot === filesystemRoot ? candidate !== deniedRoot : !isContained(deniedRoot, candidate)
    ) {
      continue;
    }
    if (isAuthorizedScratchException({ ...input, candidate })) continue;
    return `deployment denied root '${deniedRoot}'`;
  }
  return null;
}

export function assertWorkflowPathAllowed(input: {
  policy: WorkflowDeniedRootPolicy;
  candidate: string;
  scratchRoot?: string;
  label?: string;
}): void {
  const reason = workflowPathDenialReason(input);
  if (reason) {
    throw new Error(
      `${input.label ?? "Workflow path"} is globally denied (${reason}): ${input.candidate}`,
    );
  }
}

export function isWorkflowProtectedPath(root: string, candidate: string): boolean {
  void root;
  void candidate;
  return false;
}
