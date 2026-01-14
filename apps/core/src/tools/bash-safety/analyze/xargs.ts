import { SHELL_WRAPPERS } from "../types";

import { analyzeGit } from "../rules-git";
import { analyzeRm } from "../rules-rm";
import { getBasename, stripWrappers } from "../shell";

import { analyzeFind } from "./find";
import { hasRecursiveForceFlags } from "./rm-flags";

const REASON_XARGS_RM =
  "xargs rm -rf with dynamic input is dangerous. Use explicit file list instead.";
const REASON_XARGS_SHELL =
  "xargs with shell -c can execute arbitrary commands from dynamic input.";

export interface XargsAnalyzeContext {
  cwd: string | undefined;
  originalCwd: string | undefined;
  paranoidRm: boolean | undefined;
  allowTmpdirVar: boolean;
}

export function analyzeXargs(
  tokens: readonly string[],
  context: XargsAnalyzeContext,
): string | null {
  const { childTokens: rawChildTokens } =
    extractXargsChildCommandWithInfo(tokens);

  let childTokens = stripWrappers(rawChildTokens);

  if (childTokens.length === 0) {
    return null;
  }

  let head = getBasename(childTokens[0] ?? "").toLowerCase();

  if (head === "busybox" && childTokens.length > 1) {
    childTokens = childTokens.slice(1);
    head = getBasename(childTokens[0] ?? "").toLowerCase();
  }

  if (SHELL_WRAPPERS.has(head)) {
    return REASON_XARGS_SHELL;
  }

  if (head === "rm" && hasRecursiveForceFlags(childTokens)) {
    const rmResult = analyzeRm(childTokens, {
      cwd: context.cwd,
      originalCwd: context.originalCwd,
      paranoid: context.paranoidRm,
      allowTmpdirVar: context.allowTmpdirVar,
    });

    if (rmResult) {
      return rmResult;
    }

    return REASON_XARGS_RM;
  }

  if (head === "find") {
    const findResult = analyzeFind(childTokens);
    if (findResult) {
      return findResult;
    }
  }

  if (head === "git") {
    const gitResult = analyzeGit(childTokens);
    if (gitResult) {
      return gitResult;
    }
  }

  return null;
}

interface XargsParseResult {
  childTokens: string[];
  replacementToken: string | null;
}

export function extractXargsChildCommandWithInfo(
  tokens: readonly string[],
): XargsParseResult {
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
      return { childTokens: [...tokens.slice(i + 1)], replacementToken };
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
      return { childTokens: [...tokens.slice(i)], replacementToken };
    }
  }

  return { childTokens: [], replacementToken };
}
