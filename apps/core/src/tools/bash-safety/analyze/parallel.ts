import { DYNAMIC_EXPANSION_MARKER } from "../shell";

export interface ParallelAnalyzeContext {
  analyzeNested: (command: string) => string | null;
  analyzeCommand: (tokens: string[]) => string | null;
}

export function analyzeParallel(
  tokens: readonly string[],
  context: ParallelAnalyzeContext,
): string | null {
  const parseResult = parseParallelCommand(tokens);
  if (!parseResult) return null;

  const { template, argSources } = parseResult;
  if (template.length === 0) {
    for (const source of argSources) {
      for (const arg of source) {
        const reason = context.analyzeNested(arg);
        if (reason) return reason;
      }
    }
    return null;
  }

  const combinations = buildParallelCombinations(argSources);
  if (combinations.length === 0) {
    const dynamicTemplate = template.some(hasParallelPlaceholder)
      ? template.map((token) => expandParallelToken(token, [DYNAMIC_EXPANSION_MARKER]))
      : [...template, DYNAMIC_EXPANSION_MARKER];
    return analyzeExpandedParallelCommand(dynamicTemplate, context);
  }

  for (const combination of combinations) {
    const expanded = template.some(hasParallelPlaceholder)
      ? template.map((token) => expandParallelToken(token, combination))
      : [...template, ...combination];
    const reason = analyzeExpandedParallelCommand(expanded, context);
    if (reason) return reason;
  }
  return null;
}

function analyzeExpandedParallelCommand(
  tokens: string[],
  context: ParallelAnalyzeContext,
): string | null {
  return context.analyzeCommand(tokens) ?? context.analyzeNested(tokens.join(" "));
}

function buildParallelCombinations(argSources: readonly (readonly string[])[]): string[][] {
  if (argSources.length === 0 || argSources.some((source) => source.length === 0)) return [];
  let combinations: string[][] = [[]];
  for (const source of argSources) {
    const next: string[][] = [];
    for (const combination of combinations) {
      for (const arg of source) {
        next.push([...combination, arg]);
        if (next.length >= 256) return [[DYNAMIC_EXPANSION_MARKER]];
      }
    }
    combinations = next;
  }
  return combinations;
}

function hasParallelPlaceholder(token: string): boolean {
  return token.includes("{}") || /\{(?:\d+)?(?:\.|\/|\/\.)?\}/u.test(token);
}

function expandParallelToken(token: string, args: readonly string[]): string {
  return token
    .replace(/\{(?:\d+)?(?:\.|\/|\/\.)\}/gu, DYNAMIC_EXPANSION_MARKER)
    .replaceAll("{}", args.join(" "))
    .replace(/\{(\d+)\}/gu, (_match, indexText: string) => {
      const index = Number.parseInt(indexText, 10) - 1;
      return args[index] ?? DYNAMIC_EXPANSION_MARKER;
    });
}

interface ParallelParseResult {
  template: string[];
  argSources: string[][];
}

function parseParallelCommand(tokens: readonly string[]): ParallelParseResult | null {
  const parallelOptsWithValue = new Set([
    "-S",
    "--sshlogin",
    "--slf",
    "--sshloginfile",
    "-a",
    "--arg-file",
    "--colsep",
    "-I",
    "--replace",
    "--results",
    "--result",
    "--res",
  ]);

  let i = 1;
  const templateTokens: string[] = [];
  let markerIndex = -1;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === ":::") {
      markerIndex = i;
      break;
    }

    if (token === "--") {
      i++;
      while (i < tokens.length) {
        const next = tokens[i];
        if (next === undefined || next === ":::") break;
        templateTokens.push(next);
        i++;
      }
      if (tokens[i] === ":::") markerIndex = i;
      break;
    }

    if (token.startsWith("-")) {
      if (token.startsWith("-j") && token.length > 2 && /^\d+$/u.test(token.slice(2))) {
        i++;
      } else if (token.startsWith("--") && token.includes("=")) {
        i++;
      } else if (parallelOptsWithValue.has(token) || token === "-j" || token === "--jobs") {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    while (i < tokens.length) {
      const next = tokens[i];
      if (next === undefined || next === ":::") break;
      templateTokens.push(next);
      i++;
    }
    if (tokens[i] === ":::") markerIndex = i;
    break;
  }

  const argSources: string[][] = [];
  if (markerIndex !== -1) {
    let source: string[] = [];
    for (let j = markerIndex + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (token === ":::") {
        argSources.push(source);
        source = [];
      } else if (token) {
        source.push(token);
      }
    }
    argSources.push(source);
  }

  if (templateTokens.length === 0 && markerIndex === -1) return null;
  return { template: templateTokens, argSources };
}
