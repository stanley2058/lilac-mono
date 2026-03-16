const MAGIC_TOKEN_QUOTES = ['"', "'", "`"] as const;

export function matchesMagicToken(text: string, token: string): boolean {
  const trimmed = text.trim();
  if (trimmed === token) {
    return true;
  }

  return MAGIC_TOKEN_QUOTES.some((quote) => trimmed === `${quote}${token}${quote}`);
}

export function isPossibleMagicTokenPrefix(text: string, token: string): boolean {
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return true;
  }

  if (isPossibleBareMagicTokenPrefix(trimmedStart, token)) {
    return true;
  }

  return MAGIC_TOKEN_QUOTES.some((quote) =>
    isPossibleQuotedMagicTokenPrefix(trimmedStart, token, quote),
  );
}

function isPossibleBareMagicTokenPrefix(trimmedStart: string, token: string): boolean {
  if (token.startsWith(trimmedStart)) {
    return true;
  }

  if (!trimmedStart.startsWith(token)) {
    return false;
  }

  const suffix = trimmedStart.slice(token.length);
  return /^\s*$/.test(suffix);
}

function isPossibleQuotedMagicTokenPrefix(
  trimmedStart: string,
  token: string,
  quote: (typeof MAGIC_TOKEN_QUOTES)[number],
): boolean {
  if (!trimmedStart.startsWith(quote)) {
    return false;
  }

  const afterOpenQuote = trimmedStart.slice(quote.length);
  if (!afterOpenQuote) {
    return true;
  }

  if (token.startsWith(afterOpenQuote)) {
    return true;
  }

  if (!afterOpenQuote.startsWith(token)) {
    return false;
  }

  const suffix = afterOpenQuote.slice(token.length);
  if (!suffix) {
    return true;
  }

  if (!suffix.startsWith(quote)) {
    return false;
  }

  return /^\s*$/.test(suffix.slice(quote.length));
}
