import { parse, type ScriptNode } from "just-bash";

import { type AnalyzeOptions, type AnalyzeResult, MAX_RECURSION_DEPTH } from "../types";

import { analyzeScript } from "./ast-walker";

const REASON_RECURSION_LIMIT =
  "Command could not be safely analyzed because nested shell recursion exceeded the safety limit.";

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
    return { reason: REASON_RECURSION_LIMIT, segment: command };
  }

  let script: ScriptNode;
  try {
    script = parse(command);
  } catch (error) {
    return {
      reason: `Command could not be safely analyzed because shell parsing failed: ${parserErrorDetail(error)}.`,
      segment: command,
    };
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

function parserErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutQuotedContent = raw
    .replace(/`[^`]*`/g, "<token>")
    .replace(/'[^']*'/g, "<token>")
    .replace(/"[^"]*"/g, "<token>");
  return withoutQuotedContent
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^a-zA-Z0-9 _.:()<>/-]/g, "?")
    .slice(0, 200);
}
