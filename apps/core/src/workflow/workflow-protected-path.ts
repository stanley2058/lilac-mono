import path from "node:path";

const PROTECTED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
  ".secrets",
  ".ssh",
  "secrets",
]);

const PROTECTED_FILE_NAMES = new Set([
  ".credentials",
  ".gitconfig",
  ".gitcredentials",
  ".gitmodules",
  ".lfsconfig",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "core-config.yaml",
  "core-config.yml",
]);

const PROTECTED_PATH_PREFIXES = [
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "github-copilot"],
  [".config", "glab-cli"],
  [".config", "op"],
  [".config", "opencode"],
  [".local", "share", "keyrings"],
  [".local", "share", "opencode"],
] as const;

const PROTECTED_EXACT_PATHS = [
  [".claude", ".credentials.json"],
  [".codex", "auth.json"],
] as const;

function includesPathSequence(parts: readonly string[], sequence: readonly string[]): boolean {
  return parts.some(
    (_part, index) =>
      index + sequence.length <= parts.length &&
      sequence.every((segment, offset) => parts[index + offset] === segment),
  );
}

function isProtectedGitMetadata(parts: readonly string[]): boolean {
  const gitIndex = parts.lastIndexOf(".git");
  if (gitIndex < 0) return false;
  const gitParts = parts.slice(gitIndex + 1);
  return (
    gitParts.includes("hooks") ||
    gitParts.some((part) =>
      ["config", "config.worktree", "credentials", "gitweb_config.perl"].includes(part),
    )
  );
}

export function isWorkflowProtectedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  const parts = relative.split(/[\\/]/u).filter(Boolean);
  return (
    parts.some((part) => PROTECTED_DIRECTORY_NAMES.has(part)) ||
    parts.some((part) => PROTECTED_FILE_NAMES.has(part)) ||
    parts.some((part) => part.startsWith(".env")) ||
    PROTECTED_PATH_PREFIXES.some((prefix) => includesPathSequence(parts, prefix)) ||
    PROTECTED_EXACT_PATHS.some((protectedPath) => includesPathSequence(parts, protectedPath)) ||
    isProtectedGitMetadata(parts)
  );
}
