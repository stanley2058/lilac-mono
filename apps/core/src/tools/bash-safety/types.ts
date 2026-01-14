export interface AnalyzeResult {
  reason: string;
  segment: string;
}

export interface AnalyzeOptions {
  cwd?: string;
  /** Fail-closed on unparseable commands (unclosed quotes, etc.) */
  strict?: boolean;
  /** Block non-temp rm -rf even within cwd */
  paranoidRm?: boolean;
  /** Block interpreter one-liners (python -c, node -e, etc.) */
  paranoidInterpreters?: boolean;
  /** Allow $TMPDIR paths (false when TMPDIR is overridden to non-temp) */
  allowTmpdirVar?: boolean;
}

export const MAX_RECURSION_DEPTH = 5;
export const MAX_STRIP_ITERATIONS = 20;

export const SHELL_OPERATORS = new Set(["&&", "||", "|&", "|", "&", ";", "\n"]);

export const SHELL_WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "dash",
  "fish",
  "csh",
  "tcsh",
]);

export const INTERPRETERS = new Set([
  "python",
  "python3",
  "python2",
  "node",
  "ruby",
  "perl",
]);

export const DANGEROUS_PATTERNS = [
  /\brm\s+.*-[rR].*-f\b/,
  /\brm\s+.*-f.*-[rR]\b/,
  /\brm\s+-rf\b/,
  /\brm\s+-fr\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bgit\s+clean\s+-f\b/,
  /\bfind\b.*\s-delete\b/,
];

export const PARANOID_INTERPRETERS_SUFFIX =
  "\n\n(Paranoid mode: interpreter one-liners are blocked.)";
