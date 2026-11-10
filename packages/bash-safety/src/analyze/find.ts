import { getBasename, stripWrappers } from "../shell";
import { bashSafetyViolation, type BashSafetyViolation } from "../types";

const REASON_FIND_DELETE = "find -delete permanently removes files. Use -print first to preview.";

export interface AnalyzeFindOptions {
  analyzeCommand?: (tokens: string[], cwdUnknown: boolean) => BashSafetyViolation | null;
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

export function analyzeFind(
  tokens: readonly string[],
  options: AnalyzeFindOptions = {},
): BashSafetyViolation | null {
  if (findHasDelete(tokens.slice(1))) {
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
        return bashSafetyViolation("find_delete", REASON_FIND_DELETE);
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
