import { SHELL_WRAPPERS } from "../types";

import { analyzeGit } from "../rules-git";
import { analyzeRm } from "../rules-rm";
import { getBasename, stripWrappers } from "../shell";

import { analyzeFind } from "./find";
import { hasRecursiveForceFlags } from "./rm-flags";
import { extractDashCArg } from "./shell-wrappers";

const REASON_PARALLEL_RM =
  "parallel rm -rf with dynamic input is dangerous. Use explicit file list instead.";
const REASON_PARALLEL_SHELL =
  "parallel with shell -c can execute arbitrary commands from dynamic input.";

export interface ParallelAnalyzeContext {
  cwd: string | undefined;
  originalCwd: string | undefined;
  paranoidRm: boolean | undefined;
  allowTmpdirVar: boolean;
  analyzeNested: (command: string) => string | null;
}

export function analyzeParallel(
  tokens: readonly string[],
  context: ParallelAnalyzeContext,
): string | null {
  const parseResult = parseParallelCommand(tokens);

  if (!parseResult) {
    return null;
  }

  const { template, args, hasPlaceholder } = parseResult;

  if (template.length === 0) {
    for (const arg of args) {
      const reason = context.analyzeNested(arg);
      if (reason) {
        return reason;
      }
    }
    return null;
  }

  let childTokens = stripWrappers([...template]);
  let head = getBasename(childTokens[0] ?? "").toLowerCase();

  if (head === "busybox" && childTokens.length > 1) {
    childTokens = childTokens.slice(1);
    head = getBasename(childTokens[0] ?? "").toLowerCase();
  }

  if (SHELL_WRAPPERS.has(head)) {
    const dashCArg = extractDashCArg(childTokens);
    if (dashCArg) {
      if (dashCArg === "{}" || dashCArg === "{1}") {
        return REASON_PARALLEL_SHELL;
      }

      if (dashCArg.includes("{}")) {
        if (args.length > 0) {
          for (const arg of args) {
            const expandedScript = dashCArg.replace(/{}/g, arg);
            const reason = context.analyzeNested(expandedScript);
            if (reason) {
              return reason;
            }
          }

          return null;
        }

        const reason = context.analyzeNested(dashCArg);
        if (reason) {
          return reason;
        }

        return null;
      }

      const reason = context.analyzeNested(dashCArg);
      if (reason) {
        return reason;
      }

      if (hasPlaceholder) {
        return REASON_PARALLEL_SHELL;
      }

      return null;
    }

    if (args.length > 0) {
      return REASON_PARALLEL_SHELL;
    }

    if (hasPlaceholder) {
      return REASON_PARALLEL_SHELL;
    }

    return null;
  }

  if (head === "rm" && hasRecursiveForceFlags(childTokens)) {
    if (hasPlaceholder && args.length > 0) {
      for (const arg of args) {
        const expandedTokens = childTokens.map((t) => t.replace(/{}/g, arg));
        const rmResult = analyzeRm(expandedTokens, {
          cwd: context.cwd,
          originalCwd: context.originalCwd,
          paranoid: context.paranoidRm,
          allowTmpdirVar: context.allowTmpdirVar,
        });

        if (rmResult) {
          return rmResult;
        }
      }

      return null;
    }

    if (args.length > 0) {
      const expandedTokens = [...childTokens, args[0] ?? ""];
      const rmResult = analyzeRm(expandedTokens, {
        cwd: context.cwd,
        originalCwd: context.originalCwd,
        paranoid: context.paranoidRm,
        allowTmpdirVar: context.allowTmpdirVar,
      });

      if (rmResult) {
        return rmResult;
      }

      return null;
    }

    return REASON_PARALLEL_RM;
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

interface ParallelParseResult {
  template: string[];
  args: string[];
  hasPlaceholder: boolean;
}

function parseParallelCommand(
  tokens: readonly string[],
): ParallelParseResult | null {
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
        const token = tokens[i];
        if (token === undefined || token === ":::") break;
        templateTokens.push(token);
        i++;
      }

      if (i < tokens.length && tokens[i] === ":::") {
        markerIndex = i;
      }
      break;
    }

    if (token.startsWith("-")) {
      if (
        token.startsWith("-j") &&
        token.length > 2 &&
        /^\d+$/.test(token.slice(2))
      ) {
        i++;
        continue;
      }

      if (token.startsWith("--") && token.includes("=")) {
        i++;
        continue;
      }

      if (parallelOptsWithValue.has(token)) {
        i += 2;
        continue;
      }

      if (token === "-j" || token === "--jobs") {
        i += 2;
        continue;
      }

      i++;
    } else {
      while (i < tokens.length) {
        const token = tokens[i];
        if (token === undefined || token === ":::") break;
        templateTokens.push(token);
        i++;
      }

      if (i < tokens.length && tokens[i] === ":::") {
        markerIndex = i;
      }
      break;
    }
  }

  const args: string[] = [];
  if (markerIndex !== -1) {
    for (let j = markerIndex + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (token && token !== ":::") {
        args.push(token);
      }
    }
  }

  const hasPlaceholder = templateTokens.some(
    (t) => t.includes("{}") || t.includes("{1}") || t.includes("{.}"),
  );

  if (templateTokens.length === 0 && markerIndex === -1) {
    return null;
  }

  return { template: templateTokens, args, hasPlaceholder };
}
