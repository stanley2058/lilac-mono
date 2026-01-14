import { getBasename, stripWrappers } from "../shell";

import { hasRecursiveForceFlags } from "./rm-flags";

const REASON_FIND_DELETE =
  "find -delete permanently removes files. Use -print first to preview.";

export function analyzeFind(tokens: readonly string[]): string | null {
  if (findHasDelete(tokens.slice(1))) {
    return REASON_FIND_DELETE;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-exec" || token === "-execdir") {
      const execTokens = tokens.slice(i + 1);
      const semicolonIdx = execTokens.indexOf(";");
      const plusIdx = execTokens.indexOf("+");
      const endIdx =
        semicolonIdx !== -1 && plusIdx !== -1
          ? Math.min(semicolonIdx, plusIdx)
          : semicolonIdx !== -1
            ? semicolonIdx
            : plusIdx !== -1
              ? plusIdx
              : execTokens.length;

      let execCommand = execTokens.slice(0, endIdx);
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
  }

  return null;
}

export function findHasDelete(tokens: readonly string[]): boolean {
  let i = 0;
  let insideExec = false;
  let execDepth = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    if (token === "-exec" || token === "-execdir") {
      insideExec = true;
      execDepth++;
      i++;
      continue;
    }

    if (insideExec && (token === ";" || token === "+")) {
      execDepth--;
      if (execDepth === 0) {
        insideExec = false;
      }
      i++;
      continue;
    }

    if (insideExec) {
      i++;
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
