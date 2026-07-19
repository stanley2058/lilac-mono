import { DYNAMIC_EXPANSION_MARKER } from "../shell";

export interface XargsAnalyzeContext {
  analyzeCommand: (tokens: string[]) => string | null;
}

export function analyzeXargs(
  tokens: readonly string[],
  context: XargsAnalyzeContext,
): string | null {
  const { childTokens, replacementToken } = extractXargsChildCommandWithInfo(tokens);
  if (childTokens.length === 0) return null;

  if (replacementToken) {
    const expanded = childTokens.map((token, index) =>
      index === 0 ? token : token.replaceAll(replacementToken, DYNAMIC_EXPANSION_MARKER),
    );
    return context.analyzeCommand(expanded);
  }

  return context.analyzeCommand([...childTokens, DYNAMIC_EXPANSION_MARKER]);
}

interface XargsParseResult {
  childTokens: string[];
  replacementToken: string | null;
}

export function extractXargsChildCommandWithInfo(tokens: readonly string[]): XargsParseResult {
  const xargsOptsWithValue = new Set([
    "-L",
    "-n",
    "-P",
    "-s",
    "-a",
    "-E",
    "-e",
    "-d",
    "-J",
    "--max-args",
    "--max-procs",
    "--max-chars",
    "--arg-file",
    "--eof",
    "--delimiter",
    "--max-lines",
  ]);

  let replacementToken: string | null = null;
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "--") {
      return { childTokens: tokens.slice(i + 1), replacementToken };
    }

    if (token.startsWith("-")) {
      if (token === "-I") {
        replacementToken = (tokens[i + 1] as string | undefined) ?? "{}";
        i += 2;
        continue;
      }

      if (token.startsWith("-I") && token.length > 2) {
        replacementToken = token.slice(2);
        i++;
        continue;
      }

      if (token === "--replace") {
        replacementToken = "{}";
        i++;
        continue;
      }

      if (token.startsWith("--replace=")) {
        const value = token.slice("--replace=".length);
        replacementToken = value === "" ? "{}" : value;
        i++;
        continue;
      }

      if (token === "-J") {
        i += 2;
        continue;
      }

      if (xargsOptsWithValue.has(token)) {
        i += 2;
      } else if (token.startsWith("--") && token.includes("=")) {
        i++;
      } else if (
        token.startsWith("-L") ||
        token.startsWith("-n") ||
        token.startsWith("-P") ||
        token.startsWith("-s")
      ) {
        i++;
      } else {
        i++;
      }
    } else {
      return { childTokens: tokens.slice(i), replacementToken };
    }
  }

  return { childTokens: [], replacementToken };
}
