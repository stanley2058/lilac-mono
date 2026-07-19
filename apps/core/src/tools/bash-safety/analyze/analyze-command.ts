import { parse, type ScriptNode } from "just-bash";

import { type AnalyzeOptions, type AnalyzeResult, MAX_RECURSION_DEPTH } from "../types";

import { analyzeScript } from "./ast-walker";
import { dangerousReasonInText } from "./dangerous-text";

export function analyzeCommandInternal(
  command: string,
  depth: number,
  options: AnalyzeOptions,
): AnalyzeResult | null {
  return analyzeCommandAtCwd(command, depth, options, options.cwd);
}

function analyzeCommandAtCwd(
  command: string,
  depth: number,
  options: AnalyzeOptions,
  effectiveCwd: string | null | undefined,
): AnalyzeResult | null {
  if (depth >= MAX_RECURSION_DEPTH) {
    return null;
  }

  let script: ScriptNode;
  try {
    script = parse(command);
  } catch {
    const reason = dangerousReasonInText(command);
    return reason ? { reason, segment: command } : null;
  }

  return analyzeScript(
    script,
    {
      depth,
      options,
      originalCwd: options.cwd,
      analyzeNestedCommand: (nestedCommand, nestedDepth, nestedCwd) =>
        analyzeCommandAtCwd(nestedCommand, nestedDepth, options, nestedCwd),
    },
    { cwd: effectiveCwd },
  );
}
