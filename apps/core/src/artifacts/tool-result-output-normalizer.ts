import type { NormalizeToolResultOutputFn } from "@stanley2058/lilac-agent";
import {
  createOverflowReferenceNormalizer,
  type ToolResultOutput,
  type ToolResultOutputNormalizerOwner,
} from "@stanley2058/lilac-tool-results/tool-result-output-normalizer";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import type { ToolResultArtifactStore } from "./tool-result-artifact-store";
import { redactSecrets } from "../tools/bash-safety/format";

export { createOverflowReferenceNormalizer } from "@stanley2058/lilac-tool-results/tool-result-output-normalizer";

export function createToolResultOutputNormalizer(params: {
  artifacts?: ToolResultArtifactStore;
  owner: ToolResultOutputNormalizerOwner;
  getOutputConfig: () => CoreConfig["tools"]["output"];
}): NormalizeToolResultOutputFn {
  const normalizeOverflow = createOverflowReferenceNormalizer({
    ...params,
    sanitize: redactSecrets,
  });

  return async (output, context) => {
    if (
      context.bypassGenericOutputNormalizer === true &&
      context.toolName === "subagent_delegate" &&
      (output.type === "json" || output.type === "error-json") &&
      output.value !== null &&
      typeof output.value === "object" &&
      !Array.isArray(output.value) &&
      typeof output.value.finalText === "string"
    ) {
      const normalized = await normalizeOverflow(
        { type: "text", value: output.value.finalText },
        { toolCallId: context.toolCallId, toolName: "subagent_result" },
      );
      return {
        ...output,
        value: {
          ...output.value,
          finalText:
            normalized.type === "text" || normalized.type === "error-text"
              ? normalized.value
              : output.value.finalText,
        },
      };
    }
    if (context.bypassGenericOutputNormalizer === true) return output;
    return normalizeOverflow(output, context);
  };
}

export async function normalizeSubagentFinalText(params: {
  normalize: NormalizeToolResultOutputFn;
  finalText: string;
  toolCallId: string;
}): Promise<string> {
  const normalized = await params.normalize(
    { type: "text", value: params.finalText },
    { toolCallId: params.toolCallId, toolName: "subagent_result" },
  );
  return normalized.type === "text" || normalized.type === "error-text"
    ? normalized.value
    : params.finalText;
}

export type { ToolResultOutput };
