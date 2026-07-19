export function extractInterpreterCodeArg(tokens: readonly string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if ((token === "-c" || token === "-e") && tokens[i + 1]) {
      return tokens[i + 1] ?? null;
    }
  }
  return null;
}
