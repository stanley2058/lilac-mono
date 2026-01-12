import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createGateway } from "ai";
import { env } from "./env";

export type Providers =
  | "openai"
  | "xai"
  | "openrouter"
  | "anthropic"
  | "groq"
  | "vercel"
  | (string & {});

export function getModelProviders() {
  const providers = {
    openai: env.providers.openai
      ? createOpenAI({
          baseURL: env.providers.openai.baseUrl,
          apiKey: env.providers.openai.apiKey,
        })
      : null,
    xai: env.providers.xai
      ? createXai({
          baseURL: env.providers.xai.baseUrl,
          apiKey: env.providers.xai.apiKey,
        })
      : null,
    anthropic: env.providers.anthropic
      ? createAnthropic({
          baseURL: env.providers.anthropic.baseUrl,
          apiKey: env.providers.anthropic.apiKey,
        })
      : null,
    openrouter: env.providers.openrouter
      ? createOpenRouter({
          baseURL: env.providers.openrouter.baseUrl,
          apiKey: env.providers.openrouter.apiKey,
        })
      : null,
    groq: env.providers.groq
      ? createGroq({
          baseURL: env.providers.groq.baseUrl,
          apiKey: env.providers.groq.apiKey,
        })
      : null,
    vercel: env.providers.vercel
      ? createGateway({
          baseURL: env.providers.vercel.baseUrl,
          apiKey: env.providers.vercel.apiKey,
        })
      : null,
  } satisfies Record<Providers, unknown>;
  return providers as typeof providers &
    Record<string, OpenAICompatibleProvider>;
}

export const providers = getModelProviders();
