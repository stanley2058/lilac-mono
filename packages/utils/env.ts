import type { LogLevel } from "@stanley2058/simple-module-logger";
import path from "node:path";
import { findWorkspaceRoot } from "./find-root";

export type Env = ReturnType<typeof parseEnv>;

export type ResponsesTransportMode = "sse" | "auto" | "websocket";

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

function parseResponsesTransportMode(value: string | undefined): ResponsesTransportMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "websocket") return normalized;
  return "sse";
}

export function parseEnv() {
  const env = process.env;

  const perfLog = parseBoolean(env.LILAC_PERF_LOG);
  const perfLagWarnMsRaw = env.LILAC_PERF_LAG_WARN_MS;
  const perfLagWarnMs = perfLagWarnMsRaw ? Number(perfLagWarnMsRaw) : 200;
  const perfSampleRateRaw = env.LILAC_PERF_SAMPLE_RATE;
  const perfSampleRate = perfSampleRateRaw ? Number(perfSampleRateRaw) : 0;

  const contextDumpEnabled = parseBoolean(env.LILAC_CONTEXT_DUMP);
  const contextDumpDir = env.LILAC_CONTEXT_DUMP_DIR || "/data/debug";
  const llmWireDebugEnabled = parseBoolean(env.LILAC_LLM_WIRE_DEBUG);
  const llmWireDebugDir = env.LILAC_LLM_WIRE_DEBUG_DIR || path.resolve(contextDumpDir, "llm-wire");
  const llmWireDebugMaxBodyBytes = parsePositiveInt(
    env.LILAC_LLM_WIRE_DEBUG_MAX_BODY_BYTES,
    64 * 1024,
  );
  const llmWireDebugMaxEvents = parsePositiveInt(env.LILAC_LLM_WIRE_DEBUG_MAX_EVENTS, 400);

  return {
    logLevel: env.LOG_LEVEL as LogLevel,
    redisUrl: env.REDIS_URL,
    sqliteUrl: env.SQLITE_URL || path.resolve(findWorkspaceRoot(), "data", "data.sqlite3"),
    dataDir: env.DATA_DIR || path.resolve(findWorkspaceRoot(), "data"),
    toolServer: {
      port: env.LL_TOOL_SERVER_PORT,
    },
    providers: {
      openai: {
        baseUrl: env.OPENAI_BASE_URL,
        apiKey: env.OPENAI_API_KEY,
        responsesTransport: parseResponsesTransportMode(env.OPENAI_RESPONSES_TRANSPORT),
      },
      codex: {
        responsesTransport: parseResponsesTransportMode(env.CODEX_RESPONSES_TRANSPORT),
      },
      openaiCompatible: {
        baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
        apiKey: env.OPENAI_COMPATIBLE_API_KEY,
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
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY,
      },
      vercel: {
        baseUrl: env.AI_GATEWAY_BASE_URL,
        apiKey: env.AI_GATEWAY_API_KEY,
      },
    },
    tools: {
      web: {
        tavilyApiKey: env.TAVILY_API_KEY,
        tavilyApiBaseUrl: env.TAVILY_API_BASE_URL,
        exa: {
          baseUrl: env.EXA_API_BASE_URL,
          apiKey: env.EXA_API_KEY,
        },
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
      sampleRate: Number.isFinite(perfSampleRate) && perfSampleRate >= 0 ? perfSampleRate : 0,
    },
    debug: {
      contextDump: {
        enabled: contextDumpEnabled,
        dir: contextDumpDir,
      },
      llmWire: {
        enabled: llmWireDebugEnabled,
        dir: llmWireDebugDir,
        maxBodyBytes: llmWireDebugMaxBodyBytes,
        maxEvents: llmWireDebugMaxEvents,
      },
    },
  } as const;
}

export const env = parseEnv();
