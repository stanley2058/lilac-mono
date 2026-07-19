const DANGEROUS_TEXT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\b[^\n;|&)]*\breset\s+--hard\b/iu, reason: "git reset --hard" },
  { pattern: /\bgit\b[^\n;|&)]*\breset\s+--merge\b/iu, reason: "git reset --merge" },
  {
    pattern: /\bgit\b[^\n;|&)]*\bclean\b[^\n;|&)]*(?:-[^\s]*f|--force)\b/iu,
    reason: "git clean -f",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bbranch\b[^\n;|&)]*\s-[A-Za-z]*D[A-Za-z]*\b/u,
    reason: "git branch -D",
  },
  { pattern: /\bgit\b[^\n;|&)]*\bstash\s+(?:drop|clear)\b/iu, reason: "git stash drop/clear" },
  {
    pattern:
      /\bgit\b[^\n;|&)]*\bpush\b[^\n;|&)]*(?:\s-[A-Za-z]*f[A-Za-z]*\b|--force\b)(?!-with-lease)/iu,
    reason: "git push --force",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\brestore\b[^\n;|&)]*(?:--worktree|\s-W\b)/iu,
    reason: "git restore --worktree",
  },
  { pattern: /\bgit\b[^\n;|&)]*\brestore\b(?![^\n;|&)]*--staged)/iu, reason: "git restore" },
  { pattern: /\bgit\b[^\n;|&)]*\bcheckout\b[^\n;|&)]*\s--(?:\s|$)/iu, reason: "git checkout --" },
  {
    pattern: /\bgit\b[^\n;|&)]*\bcheckout\b[^\n;|&)]*--pathspec-from-file(?:=|\b)/iu,
    reason: "git checkout --pathspec-from-file",
  },
  {
    pattern: /\bgit\b[^\n;|&)]*\bworktree\s+remove\b[^\n;|&)]*(?:\s-f\b|--force\b)/iu,
    reason: "git worktree remove --force",
  },
  { pattern: /\bfind\b[^\n;|&]*\s-delete\b/iu, reason: "find -delete" },
];

export function dangerousReasonInText(text: string): string | null {
  for (const match of text.matchAll(/\brm\b([^\n;|&)]*)/giu)) {
    const args = match[1] ?? "";
    const shortOptions = Array.from(
      args.matchAll(/(?:^|\s)-([A-Za-z]+)/gu),
      (option) => option[1] ?? "",
    );
    const recursive =
      /(?:^|\s)--recursive\b/iu.test(args) || shortOptions.some((o) => /[rR]/u.test(o));
    const force = /(?:^|\s)--force\b/iu.test(args) || shortOptions.some((o) => o.includes("f"));
    if (recursive && force) return "rm -rf";
  }

  for (const { pattern, reason } of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}
