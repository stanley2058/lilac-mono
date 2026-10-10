import type { CommandArgument } from "@stanley2058/lilac-client-protocol";

// Mirrors the custom command text parser in apps/core/src/custom-commands/manager.ts so the composer
// rejects the same input Core would reject at submit.

export type ArgumentSuggestion = {
  id: string;
  label: string;
  description?: string;
  insertText: string;
  /** Keep the cursor on the token, as for `key=`, instead of adding a space. */
  continues: boolean;
};

export type ArgumentError = { index?: number; message: string };

export type ArgumentStep = {
  /** Argument the token at the cursor fills. Undefined once the cursor is in prompt text. */
  active?: number;
  /** Raw value of each argument parsed before the cursor. */
  values: (string | undefined)[];
  token: string;
  suggestions: ArgumentSuggestion[];
  error?: ArgumentError;
};

type Parsed = {
  values: (string | undefined)[];
  promptStart?: number;
  error?: ArgumentError;
};

const booleanWords = ["true", "1", "yes", "y", "on", "false", "0", "no", "n", "off"];

// Quoted runs may contain whitespace; an unterminated quote runs to the end, as in Core.
const tokenPattern = /(?:"[^"]*"?|'[^']*'?|[^\s"'])+/gu;
const closedToken = /^(?:"[^"]*"|'[^']*'|[^\s"'])+$/u;

function tokenize(text: string): { tokens: string[]; open: boolean; trailing: boolean } {
  const tokens = text.match(tokenPattern) ?? [];
  const last = tokens.at(-1);
  const open = !!last && !closedToken.test(last);
  return { tokens, open, trailing: !open && (!text || /\s$/u.test(text)) };
}

function unquote(token: string): string {
  const first = token[0];
  if (token.length >= 2 && (first === '"' || first === "'") && token.at(-1) === first)
    return token.slice(1, -1);
  return token;
}

function valueError(arg: CommandArgument, raw: string): string | undefined {
  switch (arg.type) {
    case "number":
      return Number.isFinite(Number(raw)) ? undefined : `${arg.key} must be a number.`;
    case "boolean":
      return booleanWords.includes(raw.trim().toLowerCase())
        ? undefined
        : `${arg.key} must be true or false.`;
    case "string":
      if (!arg.choices?.length || arg.choices.includes(unquote(raw))) return undefined;
      return `${arg.key} must be one of: ${arg.choices.join(", ")}.`;
  }
}

type NamedToken = { key: string; index: number; raw: string };

function namedToken(args: readonly CommandArgument[], token: string): NamedToken | undefined {
  const eq = token.indexOf("=");
  if (eq <= 0) return undefined;
  const key = token.slice(0, eq);
  return { key, index: args.findIndex((arg) => arg.key === key), raw: token.slice(eq + 1) };
}

function unknownArgument(key: string): ArgumentError {
  return { message: `Unknown argument '${key}'.` };
}

function namedError(
  args: readonly CommandArgument[],
  named: NamedToken,
): ArgumentError | undefined {
  if (named.index < 0) return unknownArgument(named.key);
  const message = valueError(args[named.index]!, named.raw);
  return message ? { index: named.index, message } : undefined;
}

function parseTokens(args: readonly CommandArgument[], tokens: readonly string[]): Parsed {
  const values: (string | undefined)[] = args.map(() => undefined);
  let position = 0;
  for (const [tokenIndex, token] of tokens.entries()) {
    const named = namedToken(args, token);
    const error = named && namedError(args, named);
    if (error) return { values, error };
    if (named) values[named.index] = named.raw;
    if (named) continue;
    while (position < args.length && values[position] !== undefined) position += 1;
    const arg = args[position];
    if (!arg) return { values, promptStart: tokenIndex };
    const message = valueError(arg, token);
    const parses = arg.type === "string" || !message;
    if (!parses && !arg.required) return { values, promptStart: tokenIndex };
    if (message) return { values, error: { index: position, message } };
    values[position] = token;
    position += 1;
  }
  return { values };
}

export function validateCommandArguments(
  args: readonly CommandArgument[],
  text: string,
): ArgumentError | undefined {
  const { tokens, open } = tokenize(text);
  if (open) return { message: "Close the quote." };
  const parsed = parseTokens(args, tokens);
  if (parsed.error) return parsed.error;
  const missing = args.findIndex(
    (arg, index) => arg.required && parsed.values[index] === undefined,
  );
  if (missing < 0) return undefined;
  return { index: missing, message: `${args[missing]!.key} is required.` };
}

/** Returns text that tokenizes to one token and parses back to `value`, if such text exists. */
function encodeValue(value: string): string | undefined {
  return [value, `"${value}"`, `'${value}'`].find((text) => {
    const { tokens, open } = tokenize(text);
    return !open && tokens.length === 1 && tokens[0] === text && unquote(text) === value;
  });
}

/** Counts the characters after the cursor that belong to the token under the cursor. */
export function tokenRemainder(before: string, after: string): number {
  const cursor = before.length;
  for (const match of `${before}${after}`.matchAll(tokenPattern)) {
    const end = match.index + match[0].length;
    if (match.index <= cursor && cursor <= end) return end - cursor;
  }
  return 0;
}

function rank(label: string, query: string): number {
  const normalized = label.toLocaleLowerCase();
  if (normalized.startsWith(query)) return 0;
  return normalized.includes(query) ? 1 : -1;
}

function filterRanked<T extends { label: string }>(items: T[], query: string): T[] {
  const normalized = query.toLocaleLowerCase();
  return items
    .map((item) => ({ item, rank: rank(item.label, normalized) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item);
}

function argumentValues(arg: CommandArgument): string[] {
  if (arg.type === "boolean") return ["true", "false"];
  return arg.choices ?? [];
}

function valueSuggestions(
  arg: CommandArgument,
  query: string,
  named: boolean,
): ArgumentSuggestion[] {
  // A positional value containing `=` would parse as a named argument, so name it explicitly.
  const values = argumentValues(arg).flatMap((value) => {
    const encoded = encodeValue(value);
    if (encoded === undefined) return [];
    const prefix = named || value.includes("=") ? `${arg.key}=` : "";
    return [
      {
        id: `value:${arg.key}:${value}`,
        label: value,
        insertText: prefix + encoded,
        continues: false,
      },
    ];
  });
  return filterRanked(values, query.replace(/^["']/u, ""));
}

function keySuggestions(
  args: readonly CommandArgument[],
  values: readonly (string | undefined)[],
  query: string,
  position: number,
): ArgumentSuggestion[] {
  // Before typing, the positional argument's own values already cover its `key=` entry.
  const skip = !query && argumentValues(args[position]!).length ? position : -1;
  const keys = args.flatMap((arg, index) =>
    values[index] === undefined && index !== skip
      ? [
          {
            id: `key:${arg.key}`,
            label: `${arg.key}=`,
            description: arg.description ?? argumentValues(arg).join(", "),
            insertText: `${arg.key}=`,
            continues: true,
          },
        ]
      : [],
  );
  return keys.filter((item) =>
    item.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()),
  );
}

/** Describes the argument at the end of `text`, the argument text before the cursor. */
export function commandArgumentStep(args: readonly CommandArgument[], text: string): ArgumentStep {
  const { tokens, trailing } = tokenize(text);
  const token = trailing ? "" : (tokens.pop() ?? "");
  const parsed = parseTokens(args, tokens);
  const { values } = parsed;
  if (parsed.error)
    return { active: parsed.error.index, values, token, suggestions: [], error: parsed.error };
  if (parsed.promptStart !== undefined) return { values, token, suggestions: [] };

  const named = namedToken(args, token);
  if (named) return namedStep(args, values, token, named);

  const position = values.findIndex((value) => value === undefined);
  if (position < 0) return { values, token, suggestions: [] };
  const arg = args[position]!;
  const suggestions = [
    ...valueSuggestions(arg, token, false),
    ...(token.startsWith('"') || token.startsWith("'")
      ? []
      : keySuggestions(args, values, token, position)),
  ];
  if (!token || suggestions.length) return { active: position, values, token, suggestions };
  if (partialValue(arg, token)) return { active: position, values, token, suggestions };
  const message = valueError(arg, token);
  if (!message) return { active: position, values, token, suggestions };
  if (arg.type !== "string" && !arg.required) return { values, token, suggestions };
  return { active: position, values, token, suggestions, error: { index: position, message } };
}

function namedStep(
  args: readonly CommandArgument[],
  values: (string | undefined)[],
  token: string,
  { key, index, raw }: NamedToken,
): ArgumentStep {
  if (index < 0) return { values, token, suggestions: [], error: unknownArgument(key) };
  const arg = args[index]!;
  const suggestions = valueSuggestions(arg, raw, true);
  const message =
    raw && !suggestions.length && !partialValue(arg, raw) ? valueError(arg, raw) : undefined;
  return {
    active: index,
    values,
    token,
    suggestions,
    ...(message ? { error: { index, message } } : {}),
  };
}

function partialValue(arg: CommandArgument, token: string): boolean {
  if (arg.type === "boolean")
    return booleanWords.some((word) => word.startsWith(token.toLowerCase()));
  return arg.type === "number" && /^[-+]?\.?$|^[-+]?\d*\.?\d*e[-+]?$/iu.test(token);
}
