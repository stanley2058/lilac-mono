export function dangerousInText(text: string): string | null {
  const t = text.toLowerCase();
  const stripped = t.trimStart();
  const isEchoOrRg = stripped.startsWith("echo ") || stripped.startsWith("rg ");

  const patterns: Array<{
    regex: RegExp;
    reason: string;
    skipForEchoRg?: boolean;
    caseSensitive?: boolean;
  }> = [
    {
      regex: /\bprivate-keys-v1\.d\b/,
      reason: "access to GPG private keys (private-keys-v1.d)",
    },
    {
      regex: /\/secret\/gnupg(\/|\b)/,
      reason: "access to agent GNUPGHOME (secret/gnupg)",
    },
    {
      regex: /\/\.ssh(\/|\b)/,
      reason: "access to ~/.ssh",
    },
    {
      regex: /\/\.aws(\/|\b)/,
      reason: "access to ~/.aws",
    },
    {
      regex: /\/\.gnupg(\/|\b)/,
      reason: "access to ~/.gnupg",
    },
    {
      regex: /github-app\.private-key\.pem\b/,
      reason: "access to GitHub App private key",
    },
    {
      regex:
        /\brm\s+(-[^\s]*r[^\s]*\s+-[^\s]*f|-\S*f\S*\s+-\S*r|-\S*rf|-\S*fr)\b/,
      reason: "rm -rf",
    },
    {
      regex: /\bgit\s+reset\s+--hard\b/,
      reason: "git reset --hard",
    },
    {
      regex: /\bgit\s+reset\s+--merge\b/,
      reason: "git reset --merge",
    },
    {
      regex: /\bgit\s+clean\s+(-[^\s]*f|-f)\b/,
      reason: "git clean -f",
    },
    {
      regex: /\bgit\s+push\s+[^|;]*(-f\b|--force\b)(?!-with-lease)/,
      reason: "git push --force (use --force-with-lease instead)",
    },
    {
      regex: /\bgit\s+branch\s+-D\b/,
      reason: "git branch -D",
      caseSensitive: true,
    },
    {
      regex: /\bgit\s+stash\s+(drop|clear)\b/,
      reason: "git stash drop/clear",
    },
    {
      regex: /\bgit\s+checkout\s+--\s/,
      reason: "git checkout --",
    },
    {
      regex: /\bgit\s+restore\b(?!.*--(staged|help))/,
      reason: "git restore (without --staged)",
    },
    {
      regex: /\bfind\b[^\n;|&]*\s-delete\b/,
      reason: "find -delete",
      skipForEchoRg: true,
    },
  ];

  for (const { regex, reason, skipForEchoRg, caseSensitive } of patterns) {
    if (skipForEchoRg && isEchoOrRg) continue;
    const target = caseSensitive ? text : t;
    if (regex.test(target)) {
      return reason;
    }
  }

  return null;
}
