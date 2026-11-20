import { projectAssistantTextHistory } from "../surface/bridge/request-composition/normalization";
import type { ModelMessage } from "ai";
import type { AiErrorLogDetails } from "@stanley2058/lilac-utils/ai-error";

export function recoverAnthropicThinking(input: {
  provider: string;
  error: AiErrorLogDetails | undefined;
  messages: readonly ModelMessage[];
}): ModelMessage[] | null {
  const { error } = input;
  if (input.provider !== "anthropic" || error?.statusCode !== 400) return null;
  const message = error.providerMessage ?? error.aiErrorMessage;
  if (
    !message.includes("Invalid `signature` in `thinking` block") ||
    !message.includes("The block is bound to a different conversation")
  )
    return null;

  const hasSignedThinking = input.messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "reasoning" && part.providerOptions?.anthropic),
  );
  return hasSignedThinking ? projectAssistantTextHistory(input.messages) : null;
}
