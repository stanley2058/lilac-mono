import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

let resolvedClaudeExecutable: string | null | undefined;

/**
 * Point the Claude Agent SDK at the operator's own Claude installation.
 *
 * The SDK otherwise looks for a native CLI binary shipped as an optional
 * dependency of `@anthropic-ai/claude-agent-sdk`, which a bundled build has no
 * dependency tree to resolve — so it fails even when Claude is installed and
 * authenticated. Empty when no `claude` is on PATH, leaving the SDK's own
 * resolution and diagnostic intact.
 */
export function claudeCodeExecutableSettings(
  resolveExecutable: () => string | null = memoizedClaudeExecutable,
): Pick<ClaudeCodeSettings, "pathToClaudeCodeExecutable"> {
  const executable = resolveExecutable();
  return executable === null ? {} : { pathToClaudeCodeExecutable: executable };
}

function memoizedClaudeExecutable(): string | null {
  // `??=` would re-scan PATH forever once the answer is `null`.
  if (resolvedClaudeExecutable === undefined) resolvedClaudeExecutable = Bun.which("claude");
  return resolvedClaudeExecutable;
}
