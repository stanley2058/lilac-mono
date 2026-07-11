export const REDACTION_PLACEHOLDER = "<redacted>";

export function normalizeLiteralSecrets(literalSecrets: readonly string[]): readonly string[] {
  const utf8Secrets = literalSecrets.map((value) => Buffer.from(value, "utf8").toString("utf8"));
  return [...new Set(utf8Secrets.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
}

export function redactLiteralSecrets(text: string, literalSecrets: readonly string[]): string {
  const secrets = normalizeLiteralSecrets(literalSecrets);
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const secret = secrets.find((value) => text.startsWith(value, cursor));
    if (secret) {
      output += REDACTION_PLACEHOLDER;
      cursor += secret.length;
    } else {
      output += text[cursor];
      cursor += 1;
    }
  }

  return output;
}
