import { extractShortOpts, getBasename, hasDynamicExpansion } from "./shell";
import { bashSafetyViolation, type BashSafetyViolation } from "./types";

const REASON_CHECKOUT_DOUBLE_DASH =
  "git checkout -- discards uncommitted changes permanently. Use 'git stash' first.";
const REASON_CHECKOUT_REF_PATH =
  "git checkout <ref> -- <path> overwrites working tree with ref version. Use 'git stash' first.";
const REASON_CHECKOUT_PATHSPEC_FROM_FILE =
  "git checkout --pathspec-from-file can overwrite multiple files. Use 'git stash' first.";
const REASON_CHECKOUT_AMBIGUOUS =
  "git checkout with multiple positional args may overwrite files. Use 'git switch' for branches or 'git restore' for files.";
const REASON_CHECKOUT_FORCE =
  "git checkout --force discards uncommitted changes. Use 'git stash' first.";
const REASON_SWITCH_FORCE =
  "git switch --force discards uncommitted changes. Use 'git stash' first.";
const REASON_RESTORE =
  "git restore discards uncommitted changes. Use 'git stash' first, or use --staged to only unstage.";
const REASON_RESTORE_WORKTREE =
  "git restore --worktree explicitly discards working tree changes. Use 'git stash' first.";
const REASON_RESET_HARD =
  "git reset --hard destroys all uncommitted changes permanently. Use 'git stash' first.";
const REASON_RESET_MERGE = "git reset --merge can lose uncommitted changes. Use 'git stash' first.";
const REASON_CLEAN =
  "git clean -f removes untracked files permanently. Use 'git clean -n' to preview first.";
const REASON_PUSH_FORCE =
  "git push --force destroys remote history. Use --force-with-lease for safer force push.";
const REASON_PUSH_DELETE = "git push deletion permanently removes remote refs.";
const REASON_PUSH_MIRROR = "git push --mirror can force-update or delete every remote ref.";
const REASON_BRANCH_DELETE =
  "git branch --force can discard branch history or bypass merge checks.";
const REASON_TAG_DELETE = "git tag --delete permanently removes local tags.";
const REASON_REFLOG_DELETE = "git reflog delete permanently removes reflog entries.";
const REASON_STASH_DROP =
  "git stash drop permanently deletes stashed changes. Consider 'git stash list' first.";
const REASON_STASH_CLEAR = "git stash clear deletes ALL stashed changes permanently.";
const REASON_WORKTREE_REMOVE_FORCE =
  "git worktree remove --force can delete uncommitted changes. Remove --force flag.";

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

const CHECKOUT_OPTS_WITH_VALUE = new Set([
  "-b",
  "-B",
  "--orphan",
  "--conflict",
  "--pathspec-from-file",
  "--unified",
]);

const CHECKOUT_OPTS_WITH_OPTIONAL_VALUE = new Set(["--recurse-submodules", "--track", "-t"]);

const CHECKOUT_KNOWN_OPTS_NO_VALUE = new Set([
  "-q",
  "--quiet",
  "-f",
  "--force",
  "-d",
  "--detach",
  "-m",
  "--merge",
  "-p",
  "--patch",
  "--ours",
  "--theirs",
  "--no-track",
  "--overwrite-ignore",
  "--no-overwrite-ignore",
  "--ignore-other-worktrees",
  "--progress",
  "--no-progress",
]);

const CHECKOUT_LONG_OPTIONS = [
  "--force",
  "--patch",
  "--pathspec-file-nul",
  "--pathspec-from-file",
] as const;
const BRANCH_LONG_OPTIONS = ["--force", "--format"] as const;
const SWITCH_LONG_OPTIONS = ["--detach", "--discard-changes", "--force"] as const;
const PUSH_LONG_OPTIONS = [
  "--delete",
  "--dry-run",
  "--force",
  "--force-if-includes",
  "--force-with-lease",
  "--mirror",
] as const;
const PUSH_OPTIONS_WITH_VALUE = new Set([
  "--exec",
  "--push-option",
  "--receive-pack",
  "--repo",
  "--recurse-submodules",
  "--signed",
  "-o",
]);

function splitAtDoubleDash(tokens: readonly string[]): {
  index: number;
  before: readonly string[];
  after: readonly string[];
} {
  const index = tokens.indexOf("--");
  if (index === -1) {
    return { index: -1, before: tokens, after: [] };
  }

  return {
    index,
    before: tokens.slice(0, index),
    after: tokens.slice(index + 1),
  };
}

export function analyzeGit(tokens: readonly string[]): BashSafetyViolation | null {
  const reason = analyzeGitReason(tokens);
  return reason ? bashSafetyViolation("dangerous_git_operation", reason) : null;
}

function analyzeGitReason(tokens: readonly string[]): string | null {
  const { subcommand, rest } = extractGitSubcommandAndRest(tokens);

  if (!subcommand) {
    return null;
  }

  switch (subcommand.toLowerCase()) {
    case "checkout":
      return analyzeGitCheckout(rest);
    case "switch":
      return analyzeGitSwitch(rest);
    case "restore":
      return analyzeGitRestore(rest);
    case "reset":
      return analyzeGitReset(rest);
    case "clean":
      return analyzeGitClean(rest);
    case "push":
      return analyzeGitPush(rest);
    case "branch":
      return analyzeGitBranch(rest);
    case "tag":
      return analyzeGitTag(rest);
    case "reflog":
      return analyzeGitReflog(rest);
    case "stash":
      return analyzeGitStash(rest);
    case "worktree":
      return analyzeGitWorktree(rest);
    default:
      return null;
  }
}

function extractGitSubcommandAndRest(tokens: readonly string[]): {
  subcommand: string | null;
  rest: string[];
} {
  if (tokens.length === 0) {
    return { subcommand: null, rest: [] };
  }

  const firstToken = tokens[0];
  const command = firstToken ? getBasename(firstToken).toLowerCase() : null;
  if (command !== "git") {
    return { subcommand: null, rest: [] };
  }

  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "--") {
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith("-")) {
        return { subcommand: nextToken, rest: tokens.slice(i + 2) };
      }

      return { subcommand: null, rest: tokens.slice(i + 1) };
    }

    if (token.startsWith("-")) {
      if (GIT_GLOBAL_OPTS_WITH_VALUE.has(token)) {
        i += 2;
      } else if (token.startsWith("-c") && token.length > 2) {
        i++;
      } else if (token.startsWith("-C") && token.length > 2) {
        i++;
      } else {
        i++;
      }
    } else {
      return { subcommand: token, rest: tokens.slice(i + 1) };
    }
  }

  return { subcommand: null, rest: [] };
}

function analyzeGitCheckout(tokens: readonly string[]): string | null {
  const { index: doubleDashIdx, before: beforeDash } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(beforeDash);
  if (
    shortOpts.has("-f") ||
    beforeDash.some((token) => isAcceptedLongOption(token, "--force", CHECKOUT_LONG_OPTIONS))
  ) {
    return REASON_CHECKOUT_FORCE;
  }

  for (const token of beforeDash) {
    if (token === "-b" || token === "-B" || token === "--orphan") {
      return null;
    }

    if (isAcceptedLongOption(token, "--pathspec-from-file", CHECKOUT_LONG_OPTIONS)) {
      return REASON_CHECKOUT_PATHSPEC_FROM_FILE;
    }
  }

  if (doubleDashIdx !== -1) {
    const hasRefBeforeDash = beforeDash.some((t) => !t.startsWith("-"));

    if (hasRefBeforeDash) {
      return REASON_CHECKOUT_REF_PATH;
    }

    return REASON_CHECKOUT_DOUBLE_DASH;
  }

  const positionalArgs = getCheckoutPositionalArgs(tokens);
  if (
    positionalArgs.length >= 2 ||
    positionalArgs.some(
      (arg) =>
        arg === "." ||
        arg === ".." ||
        arg.startsWith("./") ||
        arg.startsWith("../") ||
        arg.startsWith("/") ||
        arg.startsWith(":(") ||
        arg.includes("*"),
    )
  ) {
    return REASON_CHECKOUT_AMBIGUOUS;
  }

  return null;
}

function analyzeGitSwitch(tokens: readonly string[]): string | null {
  const { before } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(before);
  if (
    shortOpts.has("-f") ||
    before.some(
      (token) =>
        isAcceptedLongOption(token, "--force", SWITCH_LONG_OPTIONS) ||
        isAcceptedLongOption(token, "--discard-changes", SWITCH_LONG_OPTIONS),
    )
  ) {
    return REASON_SWITCH_FORCE;
  }
  return null;
}

function getCheckoutPositionalArgs(tokens: readonly string[]): string[] {
  const positional: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "--") {
      break;
    }

    if (token.startsWith("-")) {
      if (CHECKOUT_OPTS_WITH_VALUE.has(token)) {
        i += 2;
      } else if (token.startsWith("--") && token.includes("=")) {
        i++;
      } else if (CHECKOUT_OPTS_WITH_OPTIONAL_VALUE.has(token)) {
        const nextToken = tokens[i + 1];
        if (
          nextToken &&
          !nextToken.startsWith("-") &&
          (token === "--recurse-submodules" || token === "--track" || token === "-t")
        ) {
          const validModes =
            token === "--recurse-submodules" ? ["checkout", "on-demand"] : ["direct", "inherit"];

          if (validModes.includes(nextToken)) {
            i += 2;
          } else {
            i++;
          }
        } else {
          i++;
        }
      } else if (
        token.startsWith("--") &&
        !CHECKOUT_KNOWN_OPTS_NO_VALUE.has(token) &&
        !CHECKOUT_OPTS_WITH_VALUE.has(token) &&
        !CHECKOUT_OPTS_WITH_OPTIONAL_VALUE.has(token)
      ) {
        const nextToken = tokens[i + 1];
        if (nextToken && !nextToken.startsWith("-")) {
          i += 2;
        } else {
          i++;
        }
      } else {
        i++;
      }
    } else {
      positional.push(token);
      i++;
    }
  }

  return positional;
}

function analyzeGitRestore(tokens: readonly string[]): string | null {
  let hasStaged = false;
  for (const token of tokens) {
    if (token === "--help" || token === "--version") {
      return null;
    }

    // --worktree explicitly discards working tree changes, even with --staged.
    if (token === "--worktree" || token === "-W") {
      return REASON_RESTORE_WORKTREE;
    }

    if (token === "--staged" || token === "-S") {
      hasStaged = true;
    }
  }

  // Only safe if --staged is present (and --worktree is not).
  return hasStaged ? null : REASON_RESTORE;
}

function analyzeGitReset(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (token === "--hard") {
      return REASON_RESET_HARD;
    }

    if (token === "--merge") {
      return REASON_RESET_MERGE;
    }
  }

  return null;
}

function analyzeGitClean(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (token === "-n" || token === "--dry-run") {
      return null;
    }
  }

  const shortOpts = extractShortOpts(tokens.filter((t) => t !== "--"));
  if (tokens.includes("--force") || shortOpts.has("-f")) {
    return REASON_CLEAN;
  }

  return null;
}

function analyzeGitPush(tokens: readonly string[]): string | null {
  const { before } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(before);
  const positionals = extractPushPositionals(tokens);
  if (
    shortOpts.has("-f") ||
    before.some((token) => isAcceptedLongOption(token, "--force", PUSH_LONG_OPTIONS)) ||
    positionals.some(isForcedPushRefspec)
  ) {
    return REASON_PUSH_FORCE;
  }

  if (before.some((token) => isAcceptedLongOption(token, "--mirror", PUSH_LONG_OPTIONS))) {
    return REASON_PUSH_MIRROR;
  }

  if (
    shortOpts.has("-d") ||
    before.some((token) => isAcceptedLongOption(token, "--delete", PUSH_LONG_OPTIONS)) ||
    positionals.some(isDeletionPushRefspec)
  ) {
    return REASON_PUSH_DELETE;
  }

  return null;
}

function isForcedPushRefspec(token: string): boolean {
  return !hasDynamicExpansion(token) && /^\+[^:]/u.test(token);
}

function isDeletionPushRefspec(token: string): boolean {
  return !hasDynamicExpansion(token) && /^\+?:[^:]+/u.test(token);
}

function analyzeGitBranch(tokens: readonly string[]): string | null {
  const { before } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(before);
  if (
    shortOpts.has("-D") ||
    shortOpts.has("-f") ||
    before.some((token) => isAcceptedLongOption(token, "--force", BRANCH_LONG_OPTIONS))
  ) {
    return REASON_BRANCH_DELETE;
  }

  return null;
}

function analyzeGitTag(tokens: readonly string[]): string | null {
  const { before } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(before);
  if (
    shortOpts.has("-d") ||
    before.some((token) => isAcceptedLongOption(token, "--delete", ["--delete"]))
  ) {
    return REASON_TAG_DELETE;
  }
  return null;
}

function analyzeGitReflog(tokens: readonly string[]): string | null {
  let i = 0;
  while (tokens[i]?.startsWith("-")) {
    if (
      [
        "--date",
        "--format",
        "--grep",
        "--max-count",
        "--skip",
        "--since",
        "--until",
        "-n",
      ].includes(tokens[i] ?? "")
    ) {
      i += 2;
    } else {
      i++;
    }
  }
  return tokens[i]?.toLowerCase() === "delete" ? REASON_REFLOG_DELETE : null;
}

function analyzeGitStash(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (token === "drop") {
      return REASON_STASH_DROP;
    }

    if (token === "clear") {
      return REASON_STASH_CLEAR;
    }
  }

  return null;
}

function analyzeGitWorktree(tokens: readonly string[]): string | null {
  const hasRemove = tokens.find((token) => !token.startsWith("-")) === "remove";
  if (!hasRemove) return null;

  const { before } = splitAtDoubleDash(tokens);
  const shortOpts = extractShortOpts(before);
  if (
    shortOpts.has("-f") ||
    before.some((token) => isAcceptedLongOption(token, "--force", ["--force"]))
  ) {
    return REASON_WORKTREE_REMOVE_FORCE;
  }

  return null;
}

function extractPushPositionals(tokens: readonly string[]): string[] {
  const positionals: string[] = [];
  let pastDoubleDash = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }
    if (pastDoubleDash || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (PUSH_OPTIONS_WITH_VALUE.has(token)) i++;
  }
  return positionals;
}

function isAcceptedLongOption(
  token: string,
  canonical: string,
  options: readonly string[],
): boolean {
  const name = token.split("=", 1)[0] ?? token;
  if (name === canonical) return true;
  if (name.length <= 2 || !name.startsWith("--") || !canonical.startsWith(name)) return false;
  return options.every((option) => option === canonical || !option.startsWith(name));
}
