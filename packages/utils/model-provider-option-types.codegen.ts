import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { GroqLanguageModelOptions } from "@ai-sdk/groq";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { OpenAICompatibleLanguageModelChatOptions } from "@ai-sdk/openai-compatible";
import type { XaiLanguageModelResponsesOptions } from "@ai-sdk/xai";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";

/** Agent SDK query options that the Claude Code bridge forwards from `providerOptions["claude-code"]`. */
type ClaudeCodeModelOptions = Pick<Options, "taskBudget"> & {
  settings?: Pick<Settings, "fastMode">;
};

/** Provider option namespaces and the option types their adapters accept. */
export type ModelProviderOptionTypes = {
  anthropic: AnthropicLanguageModelOptions;
  "claude-code": ClaudeCodeModelOptions;
  groq: GroqLanguageModelOptions;
  openai: OpenAILanguageModelResponsesOptions;
  openaiCompatible: OpenAICompatibleLanguageModelChatOptions;
  xai: XaiLanguageModelResponsesOptions;
};
