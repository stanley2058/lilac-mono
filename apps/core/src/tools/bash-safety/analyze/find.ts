import { getBasename, stripWrappers } from "../shell";

import { hasRecursiveForceFlags } from "./rm-flags";

const REASON_FIND_DELETE = "find -delete permanently removes files. Use -print first to preview.";

export interface AnalyzeFindOptions {
  analyzeCommand?: (tokens: string[], cwdUnknown: boolean) => string | null;
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

export function analyzeFind(
  tokens: readonly string[],
  options: AnalyzeFindOptions = {},
): string | null {
  if (findHasDelete(tokens.slice(1))) {
    return REASON_FIND_DELETE;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && FIND_EXEC_ACTIONS.has(token)) {
      const terminatorIndex = findActionTerminator(tokens, i + 1);
      let execCommand = tokens.slice(i + 1, terminatorIndex);
      if (options.analyzeCommand) {
        const reason = options.analyzeCommand(
          execCommand,
          token === "-execdir" || token === "-okdir",
        );
        if (reason) return reason;
      } else {
        execCommand = stripWrappers(execCommand);

        if (execCommand.length > 0) {
          let head = getBasename(execCommand[0] ?? "");

          if (head === "busybox" && execCommand.length > 1) {
            execCommand = execCommand.slice(1);
            head = getBasename(execCommand[0] ?? "");
          }

          if (head === "rm" && hasRecursiveForceFlags(execCommand)) {
            return "find -exec rm -rf is dangerous. Use explicit file list instead.";
          }
        }
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
