export type EditingToolMode = "apply_patch" | "edit_file";

function normalizeLower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Returns true when a model should use OpenAI-style apply_patch editing.
 *
 * OpenAI-like model families:
 * - openai/*
 * - codex/*
 * - openrouter/openai/*
 * - vercel/openai/*
 */
export function isOpenAiLikeModel(params: { provider: string; modelId: string }): boolean {
  const provider = normalizeLower(params.provider);
  const modelId = normalizeLower(params.modelId);

  if (provider === "openai" || provider === "codex") return true;

  if ((provider === "openrouter" || provider === "vercel") && modelId.startsWith("openai/")) {
    return true;
  }

  return false;
}

export function resolveEditingToolMode(params: {
  provider: string;
  modelId: string;
}): EditingToolMode {
  return isOpenAiLikeModel(params) ? "apply_patch" : "edit_file";
}
