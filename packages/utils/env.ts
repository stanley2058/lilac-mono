import type { LogLevel } from "@stanley2058/simple-module-logger";
import path from "node:path";
import { findWorkspaceRoot } from "./find-root";

export type Env = ReturnType<typeof parseEnv>;

export function parseEnv() {
  const env = process.env;

  const perfLog = env.LILAC_PERF_LOG === "1" || env.LILAC_PERF_LOG === "true";
  const perfLagWarnMsRaw = env.LILAC_PERF_LAG_WARN_MS;
  const perfLagWarnMs = perfLagWarnMsRaw ? Number(perfLagWarnMsRaw) : 200;
  const perfSampleRateRaw = env.LILAC_PERF_SAMPLE_RATE;
  const perfSampleRate = perfSampleRateRaw ? Number(perfSampleRateRaw) : 0;

  return {
    logLevel: env.LOG_LEVEL as LogLevel,
    redisUrl: env.REDIS_URL,
    sqliteUrl:
      env.SQLITE_URL ||
      path.resolve(findWorkspaceRoot(), "data", "data.sqlite3"),
    dataDir: env.DATA_DIR || path.resolve(findWorkspaceRoot(), "data"),
    toolServer: {
      port: env.LL_TOOL_SERVER_PORT,
    },
    providers: {
      openai: {
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
      },
      xai: {
        baseUrl: env.XAI_BASE_URL,
        apiKey: env.XAI_API_KEY,
      },
      anthropic: {
        baseUrl: env.ANTHROPIC_BASE_URL,
        apiKey: env.ANTHROPIC_API_KEY,
      },
      openrouter: {
        baseUrl: env.OPENROUTER_BASE_URL,
        apiKey: env.OPENROUTER_API_KEY,
      },
      groq: {
        baseUrl: env.GROQ_BASE_URL,
        apiKey: env.GROQ_API_KEY,
      },
      google: {
        baseUrl: env.GEMINI_BASE_URL || env.GOOGLE_BASE_URL,
        apiKey:
          env.GEMINI_API_KEY ||
          env.GOOGLE_API_KEY ||
          env.GOOGLE_GENERATIVE_AI_API_KEY,
      },
      vercel: {
        baseUrl: env.AI_GATEWAY_BASE_URL,
        apiKey: env.AI_GATEWAY_API_KEY,
      },
    },
    tools: {
      web: {
        tavilyApiKey: env.TAVILY_API_KEY,
      },
    },
    github: {
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      webhookPort: env.GITHUB_WEBHOOK_PORT,
      webhookPath: env.GITHUB_WEBHOOK_PATH || "/github/webhook",
    },
    perf: {
      log: perfLog,
      lagWarnMs: Number.isFinite(perfLagWarnMs) ? perfLagWarnMs : 200,
      sampleRate:
        Number.isFinite(perfSampleRate) && perfSampleRate >= 0
          ? perfSampleRate
          : 0,
    },
  } as const;
}

export const env = parseEnv();
