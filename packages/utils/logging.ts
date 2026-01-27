import type { LogLevel } from "@stanley2058/simple-module-logger";

function hasTestGlobals(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;
  return typeof g.describe === "function" && typeof g.it === "function";
}

export function isTestEnv(): boolean {
  const env = process.env;

  // Common conventions across runners (Bun/Jest/Vitest).
  if (env.NODE_ENV === "test") return true;
  if (env.BUN_ENV === "test") return true;
  if (env.BUN_TEST === "1" || env.BUN_TEST === "true") return true;
  if (typeof env.VITEST === "string") return true;
  if (typeof env.JEST_WORKER_ID === "string") return true;

  // Fallback: Bun's test runner installs `describe`/`it` globals.
  return hasTestGlobals();
}

export function resolveLogLevel(override?: LogLevel): LogLevel {
  if (override) return override;
  if (isTestEnv()) return "error";
  const fromEnv = process.env.LOG_LEVEL as LogLevel | undefined;
  return fromEnv ?? "info";
}
