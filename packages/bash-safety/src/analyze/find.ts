import { homedir } from "node:os";
import { resolve } from "node:path";
import { isTempTarget } from "../rules-rm";
import { getBasename, stripExpansionMarkers, stripWrappers } from "../shell";
import { bashSafetyViolation, type BashSafetyViolation } from "../types";

const REASON_FIND_DELETE = "find -delete permanently removes files. Use -print first to preview.";

export interface AnalyzeFindOptions {
  cwd?: string | null;
  allowTmpdirVar?: boolean;
  analyzeCommand?: (tokens: string[], cwdUnknown: boolean) => BashSafetyViolation | null;
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

export function analyzeFind(
  tokens: readonly string[],
  options: AnalyzeFindOptions = {},
): BashSafetyViolation | null {
  if (findHasDelete(tokens.slice(1)) && hasUnsafeRoot(tokens, options)) {
    return bashSafetyViolation("find_delete", REASON_FIND_DELETE);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && FIND_EXEC_ACTIONS.has(token)) {
      const terminatorIndex = findActionTerminator(tokens, i + 1);
      let execCommand = tokens.slice(i + 1, terminatorIndex);
      const executable = stripWrappers([...execCommand]);
      const head = getBasename(executable[0] ?? "");
      if (head === "rm" || (head === "busybox" && executable[1] === "rm")) {
        if (hasUnsafeRoot(tokens, options))
          return bashSafetyViolation("find_delete", REASON_FIND_DELETE);
        // The root policy covers find matches; analyze any additional literal rm targets separately.
        const explicitTargetReason = options.analyzeCommand?.(
          execCommand.filter((argument) => argument !== "{}"),
          token === "-execdir" || token === "-okdir",
        );
        if (explicitTargetReason) return explicitTargetReason;
        i = terminatorIndex;
        continue;
      }
      if (options.analyzeCommand) {
        const reason = options.analyzeCommand(
          execCommand,
          token === "-execdir" || token === "-okdir",
        );
        if (reason) return reason;
      }
      i = terminatorIndex;
    }
  }

  return null;
}

export function findHasDelete(tokens: readonly string[]): boolean {
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    if (FIND_EXEC_ACTIONS.has(token)) {
      i = findActionTerminator(tokens, i + 1) + 1;
      continue;
    }

    if (
      token === "-name" ||
      token === "-iname" ||
      token === "-path" ||
      token === "-ipath" ||
      token === "-regex" ||
      token === "-iregex" ||
      token === "-type" ||
      token === "-user" ||
      token === "-group" ||
      token === "-perm" ||
      token === "-size" ||
      token === "-mtime" ||
      token === "-ctime" ||
      token === "-atime" ||
      token === "-newer" ||
      token === "-printf" ||
      token === "-fprint" ||
      token === "-fprintf"
    ) {
      i += 2;
      continue;
    }

    if (token === "-delete") {
      return true;
    }

    i++;
  }

  return false;
}

function findActionTerminator(tokens: readonly string[], startIndex: number): number {
  for (let i = startIndex; i < tokens.length; i++) {
    if (tokens[i] === ";" || tokens[i] === "+") return i;
  }
  return tokens.length;
}

function hasUnsafeRoot(tokens: readonly string[], options: AnalyzeFindOptions): boolean {
  const home = process.env.HOME ?? homedir();
  const roots: string[] = [];
  let index = 1;
  while (["-H", "-L", "-P"].includes(tokens[index] ?? "")) index++;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("-") || token === "(" || token === "!") break;
    roots.push(stripExpansionMarkers(token));
  }
  if (roots.length === 0) roots.push(".");
  const filters = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type"]);
  let filtered = false;
  for (let i = index; i < tokens.length; i++) {
    if (FIND_EXEC_ACTIONS.has(tokens[i]!)) {
      i = findActionTerminator(tokens, i + 1);
      continue;
    }
    if (filters.has(tokens[i]!)) {
      filtered = true;
      i++;
    }
  }
  return roots.some((root) => {
    const expanded = root.replace(/^~(?=\/|$)/, home).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
    if (/^\$(?:TMPDIR|\{TMPDIR\})(?=\/|$)/.test(expanded)) return !(options.allowTmpdirVar ?? true);
    if (isTempTarget(expanded, options.allowTmpdirVar ?? true)) return false;
    if (expanded.includes("$") || expanded.includes("__LILAC_DYNAMIC")) return false;
    const path = resolveFindRoot(expanded, options.cwd);
    if (!path) return !filtered && (root === "." || root === "..");
    if (path === "/" || path === resolve(home)) return true;
    if (!options.cwd) return false;
    const cwd = resolve(options.cwd);
    // An unfiltered cwd root can remove the entire selected tree, including the root itself.
    if (path === cwd) return !filtered;
    if (cwd.startsWith(`${path}/`)) return true;
    return !path.startsWith(`${cwd}/`);
  });
}

function resolveFindRoot(root: string, cwd: string | null | undefined): string | null {
  if (root.startsWith("/")) return resolve(root);
  if (!cwd) return null;
  return resolve(cwd, root);
}
