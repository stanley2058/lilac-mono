import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { GroqLanguageModelOptions } from "@ai-sdk/groq";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { OpenAICompatibleLanguageModelChatOptions } from "@ai-sdk/openai-compatible";
import type { XaiLanguageModelResponsesOptions } from "@ai-sdk/xai";

/** Provider option namespaces whose unknown keys are stripped by their providers. */
export type ModelProviderOptionTypes = {
  anthropic: AnthropicLanguageModelOptions;
  groq: GroqLanguageModelOptions;
  openai: OpenAILanguageModelResponsesOptions;
  openaiCompatible: OpenAICompatibleLanguageModelChatOptions;
  xai: XaiLanguageModelResponsesOptions;
};
