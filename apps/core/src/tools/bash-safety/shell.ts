import { MAX_STRIP_ITERATIONS } from "./types";

export const DYNAMIC_EXPANSION_MARKER = "__LILAC_DYNAMIC_SHELL_EXPANSION__";
export const NONTRIVIAL_DYNAMIC_EXPANSION_MARKER = `${DYNAMIC_EXPANSION_MARKER}NONTRIVIAL__`;
export const PARAMETER_EXPANSION_MARKER = `${DYNAMIC_EXPANSION_MARKER}PARAMETER__`;
export const COMMAND_SUBSTITUTION_MARKER = `${DYNAMIC_EXPANSION_MARKER}COMMAND_SUBSTITUTION__`;
export const ARITHMETIC_EXPANSION_MARKER = `${DYNAMIC_EXPANSION_MARKER}ARITHMETIC__`;
export const BRACE_EXPANSION_MARKER = `${DYNAMIC_EXPANSION_MARKER}BRACE__`;
export const GLOB_EXPANSION_MARKER = `${DYNAMIC_EXPANSION_MARKER}GLOB__`;

const EXPANSION_MARKERS = [
  NONTRIVIAL_DYNAMIC_EXPANSION_MARKER,
  PARAMETER_EXPANSION_MARKER,
  COMMAND_SUBSTITUTION_MARKER,
  ARITHMETIC_EXPANSION_MARKER,
  BRACE_EXPANSION_MARKER,
  GLOB_EXPANSION_MARKER,
  DYNAMIC_EXPANSION_MARKER,
];

export function hasDynamicExpansion(token: string): boolean {
  return token.includes(DYNAMIC_EXPANSION_MARKER);
}

export function hasNontrivialDynamicExpansion(token: string): boolean {
  return token.includes(NONTRIVIAL_DYNAMIC_EXPANSION_MARKER);
}

export function hasCommandSubstitution(token: string): boolean {
  return token.includes(COMMAND_SUBSTITUTION_MARKER);
}

export function hasGlobExpansion(token: string): boolean {
  return token.includes(GLOB_EXPANSION_MARKER);
}

export function stripExpansionMarkers(token: string): string {
  let result = token;
  for (const marker of EXPANSION_MARKERS) result = result.replaceAll(marker, "");
  return result;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseEnvAssignment(token: string): { name: string; value: string } | null {
  if (!ENV_ASSIGNMENT_RE.test(token)) {
    return null;
  }
  const eqIdx = token.indexOf("=");
  if (eqIdx < 0) {
    return null;
  }
  return { name: token.slice(0, eqIdx), value: token.slice(eqIdx + 1) };
}

export interface EnvStrippingResult {
  tokens: string[];
  envAssignments: Map<string, string>;
}

export function stripEnvAssignmentsWithInfo(tokens: string[]): EnvStrippingResult {
  const envAssignments = new Map<string, string>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      break;
    }

    const assignment = parseEnvAssignment(token);
    if (!assignment) {
      break;
    }

    envAssignments.set(assignment.name, assignment.value);
    i++;
  }

  return { tokens: tokens.slice(i), envAssignments };
}

export interface WrapperStrippingResult {
  tokens: string[];
  envAssignments: Map<string, string>;
  childCwdUnknown: boolean;
}

export function stripWrappers(tokens: string[]): string[] {
  return stripWrappersWithInfo(tokens).tokens;
}

export function stripWrappersWithInfo(tokens: string[]): WrapperStrippingResult {
  let result = [...tokens];
  const allEnvAssignments = new Map<string, string>();
  let childCwdUnknown = false;

  for (let iteration = 0; iteration < MAX_STRIP_ITERATIONS; iteration++) {
    const before = result.join(" ");

    const { tokens: strippedTokens, envAssignments } = stripEnvAssignmentsWithInfo(result);
    for (const [k, v] of envAssignments) {
      allEnvAssignments.set(k, v);
    }
    result = strippedTokens;
    if (result.length === 0) break;

    while (
      result.length > 0 &&
      result[0]?.includes("=") &&
      !ENV_ASSIGNMENT_RE.test(result[0] ?? "")
    ) {
      result = result.slice(1);
    }

    if (result.length === 0) break;

    const head = result[0]?.toLowerCase();
    if (head !== "sudo" && head !== "env" && head !== "command") {
      break;
    }

    if (head === "sudo") {
      const sudoResult = stripSudo(result);
      result = sudoResult.tokens;
      childCwdUnknown ||= sudoResult.childCwdUnknown;
    }

    if (head === "env") {
      const envResult = stripEnvWithInfo(result);
      result = envResult.tokens;
      childCwdUnknown ||= envResult.childCwdUnknown;
      for (const [k, v] of envResult.envAssignments) {
        allEnvAssignments.set(k, v);
      }
    }

    if (head === "command") {
      result = stripCommand(result);
    }

    if (result.join(" ") === before) break;
  }

  const { tokens: finalTokens, envAssignments: finalAssignments } =
    stripEnvAssignmentsWithInfo(result);

  for (const [k, v] of finalAssignments) {
    allEnvAssignments.set(k, v);
  }

  return { tokens: finalTokens, envAssignments: allEnvAssignments, childCwdUnknown };
}

const SUDO_OPTS_WITH_VALUE = new Set([
  "-u",
  "-g",
  "-C",
  "-D",
  "-h",
  "-p",
  "-r",
  "-t",
  "-T",
  "-U",
  "--chdir",
]);

interface ChildCwdStrippingResult {
  tokens: string[];
  childCwdUnknown: boolean;
}

function stripSudo(tokens: string[]): ChildCwdStrippingResult {
  let i = 1;
  let childCwdUnknown = false;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "--") {
      return { tokens: tokens.slice(i + 1), childCwdUnknown };
    }

    if (!token.startsWith("-")) {
      break;
    }

    if (SUDO_OPTS_WITH_VALUE.has(token)) {
      if (token === "-D" || token === "--chdir") childCwdUnknown = true;
      i += 2;
      continue;
    }

    if (token.startsWith("--chdir=")) {
      childCwdUnknown = true;
      i++;
      continue;
    }

    if (token.startsWith("-D") && token.length > 2) {
      childCwdUnknown = true;
      i++;
      continue;
    }

    i++;
  }

  return { tokens: tokens.slice(i), childCwdUnknown };
}

const ENV_OPTS_NO_VALUE = new Set(["-i", "-0", "--null"]);
const ENV_OPTS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "-P",
]);

function stripEnvWithInfo(tokens: string[]): EnvStrippingResult & { childCwdUnknown: boolean } {
  const envAssignments = new Map<string, string>();
  let childCwdUnknown = false;
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "--") {
      return { tokens: tokens.slice(i + 1), envAssignments, childCwdUnknown };
    }

    if (ENV_OPTS_NO_VALUE.has(token)) {
      i++;
      continue;
    }

    if (ENV_OPTS_WITH_VALUE.has(token)) {
      if (token === "-C" || token === "--chdir") childCwdUnknown = true;
      i += 2;
      continue;
    }

    if (token.startsWith("-u=") || token.startsWith("--unset=")) {
      i++;
      continue;
    }

    if (token.startsWith("-C=") || token.startsWith("--chdir=")) {
      childCwdUnknown = true;
      i++;
      continue;
    }

    if (token.startsWith("-P")) {
      i++;
      continue;
    }

    if (token.startsWith("-")) {
      i++;
      continue;
    }

    const assignment = parseEnvAssignment(token);
    if (!assignment) {
      break;
    }

    envAssignments.set(assignment.name, assignment.value);
    i++;
  }

  return { tokens: tokens.slice(i), envAssignments, childCwdUnknown };
}

function stripCommand(tokens: string[]): string[] {
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;

    if (token === "-p" || token === "-v" || token === "-V") {
      i++;
      continue;
    }

    if (token === "--") {
      return tokens.slice(i + 1);
    }

    if (token.startsWith("-") && !token.startsWith("--") && token.length > 1) {
      const chars = token.slice(1);
      if (!/^[pvV]+$/.test(chars)) {
        break;
      }
      i++;
      continue;
    }

    break;
  }

  return tokens.slice(i);
}

export function extractShortOpts(tokens: readonly string[]): Set<string> {
  const opts = new Set<string>();
  let pastDoubleDash = false;

  for (const token of tokens) {
    if (token === "--") {
      pastDoubleDash = true;
      continue;
    }

    if (pastDoubleDash) continue;

    if (token.startsWith("-") && !token.startsWith("--") && token.length > 1) {
      for (let i = 1; i < token.length; i++) {
        const char = token[i];
        if (!char || !/[a-zA-Z]/.test(char)) {
          break;
        }

        opts.add(`-${char}`);
      }
    }
  }

  return opts;
}

export function normalizeCommandToken(token: string): string {
  return getBasename(token).toLowerCase();
}

export function getBasename(token: string): string {
  return token.includes("/") ? (token.split("/").pop() ?? token) : token;
}
