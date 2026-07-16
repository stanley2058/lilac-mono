import path from "node:path";

const PROTECTED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".git",
  ".gnupg",
  ".secrets",
  ".ssh",
  "secrets",
]);

export function isWorkflowProtectedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  const parts = relative.split(/[\\/]/u).filter(Boolean);
  return (
    parts.some((part) => PROTECTED_DIRECTORY_NAMES.has(part)) ||
    parts.some((part) => part === "core-config.yaml" || part === "core-config.yml") ||
    parts.some((part) => part.startsWith(".env"))
  );
}
