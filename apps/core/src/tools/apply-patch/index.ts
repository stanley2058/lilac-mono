import { providers } from "@stanley2058/lilac-utils";

import { createOpenAIApplyPatchExecutor } from "./openai-apply-patch-executor";
import { localApplyPatchTool } from "./local-apply-patch-tool";

export function applyPatchToolForModel(params: {
  cwd: string;
  provider: string;
  modelId: string;
}) {
  const { cwd, provider, modelId } = params;

  // Use OpenAI-native apply_patch tool for GPT-5.* on OpenAI/Codex providers.
  if ((provider === "openai" || provider === "codex") && modelId.startsWith("gpt-5")) {
    const p = providers[provider];
    if (!p) {
      throw new Error(`Provider '${provider}' is not configured`);
    }

    return {
      apply_patch: p.tools.applyPatch({
        execute: createOpenAIApplyPatchExecutor(cwd),
      }),
    };
  }

  return localApplyPatchTool(cwd);
}
