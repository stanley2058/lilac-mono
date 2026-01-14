import type { AnalyzeOptions, AnalyzeResult } from "./types";

import { analyzeCommandInternal } from "./analyze/analyze-command";

export type { AnalyzeOptions, AnalyzeResult };

export function analyzeBashCommand(
  command: string,
  options: AnalyzeOptions = {},
): AnalyzeResult | null {
  return analyzeCommandInternal(command, 0, options);
}
