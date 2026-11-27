function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

export function stripLeadingBotMentionPrefix(
  text: string,
  botNames: readonly string[],
): {
  hadLeadingMention: boolean;
  mentionPrefix: string;
  text: string;
} {
  const sanitizedBotNames = botNames
    .map((name) => sanitizeUserToken(name))
    .filter((name) => name.length > 0);
  const nameAlternation =
    sanitizedBotNames.length > 0
      ? `|@(?:${sanitizedBotNames.map((name) => escapeRegExp(name)).join("|")})`
      : "";
  const mentionRe = new RegExp(`^\\s*(?:<@!?[^>]+>${nameAlternation})(?:[,:]\\s*|\\s+)`, "iu");
  const m = text.match(mentionRe);
  if (!m) return { hadLeadingMention: false, mentionPrefix: "", text };
  return {
    hadLeadingMention: true,
    mentionPrefix: m[0],
    text: text.slice(m[0].length),
  };
}

const DEFAULT_CONTINUE_DIRECTIVE_COUNT = 8;
export const LEADING_CONTINUE_DIRECTIVE_RE =
  /^\s*(?:[:,]\s*)?!(?:continue|cont)(?:=(\d+))?(?:\s+|$)/iu;

export function parseLeadingContinueDirective(input: {
  text: string;
  botNames: readonly string[];
}): number | undefined {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  const target = stripped.hadLeadingMention ? stripped.text : input.text;
  const m = target.match(LEADING_CONTINUE_DIRECTIVE_RE);
  if (!m) return undefined;

  if (m[1] === undefined) return DEFAULT_CONTINUE_DIRECTIVE_COUNT;

  const rawCount = Number.parseInt(String(m[1]).trim(), 10);
  if (!Number.isFinite(rawCount) || rawCount < 1) return undefined;
  return Math.min(200, rawCount);
}
