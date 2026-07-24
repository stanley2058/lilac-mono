import { setTimeout as sleep } from "node:timers/promises";

import { createLogger, extractAiErrorLogDetails, isRecord } from "@stanley2058/lilac-utils";

import { isLikelyContextOverflowError } from "./context-overflow";
import type { TurnErrorHandler } from "./ai-sdk-pi-agent";

const TRANSIENT_MODEL_ERROR_PATTERN =
  /overloaded|server_is_overloaded|service[_\s-]*unavailable|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|socket connection was closed unexpectedly|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set(["ConnectionClosed", "ECONNRESET"]);

export type TransientModelRetryConfig = {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type TransientModelRetryController = {
  handler: TurnErrorHandler;
  reset: () => void;
};

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return undefined;
}

function hasRetryErrorExhausted(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "AI_RetryError" && error.reason === "maxRetriesExceeded";
}

function hasTransientModelErrorHint(value: unknown, seen: Set<unknown>, depth: number): boolean {
  if (depth > 8 || value === null || value === undefined) return false;

  if (typeof value === "string") {
    return RETRYABLE_NETWORK_ERROR_CODES.has(value) || TRANSIENT_MODEL_ERROR_PATTERN.test(value);
  }

  if (typeof value === "number") {
    return RETRYABLE_STATUS_CODES.has(value);
  }

  if (typeof value === "boolean" || typeof value === "bigint") return false;

  if (Array.isArray(value)) {
    return value.some((item) => hasTransientModelErrorHint(item, seen, depth + 1));
  }

  if (value instanceof Error) {
    if (TRANSIENT_MODEL_ERROR_PATTERN.test(value.message)) return true;
    if (value.cause !== undefined && hasTransientModelErrorHint(value.cause, seen, depth + 1)) {
      return true;
    }
  }

  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (value.isRetryable === true) return true;

  const statusCode = readNumber(value.statusCode ?? value.status);
  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) return true;

  const keysToInspect = [
    "message",
    "error",
    "errorMessage",
    "details",
    "detail",
    "responseBody",
    "body",
    "statusText",
    "name",
    "code",
    "type",
    "cause",
    "lastError",
    "errors",
  ] as const;

  for (const key of keysToInspect) {
    if (!(key in value)) continue;
    if (hasTransientModelErrorHint(value[key], seen, depth + 1)) return true;
  }

  return false;
}

export function isRetryableTransientModelError(error: unknown): boolean {
  if (isLikelyContextOverflowError(error)) return false;
  if (hasRetryErrorExhausted(error)) return false;
  return hasTransientModelErrorHint(error, new Set<unknown>(), 0);
}

export function computeTransientRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): number {
  const baseDelayMs = Math.max(0, params.baseDelayMs);
  const maxDelayMs = Math.max(0, params.maxDelayMs);
  const exponential = baseDelayMs * 2 ** Math.max(0, params.attempt - 1);
  return Math.min(maxDelayMs, exponential);
}

function defaultErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function createTransientModelRetryController(params: {
  retry: TransientModelRetryConfig;
  logger: ReturnType<typeof createLogger>;
  requestId: string;
  sessionId: string;
  modelSpec: string;
  formatError?: (error: unknown) => string;
}): TransientModelRetryController {
  let attempts = 0;
  const summarizeError = params.formatError ?? defaultErrorSummary;

  return {
    reset: () => {
      attempts = 0;
    },
    handler: async (error, context) => {
      const logSkipped = (reason: string) => {
        params.logger.debug("transient model retry skipped", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec: params.modelSpec,
          reason,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
      };

      if (!params.retry.enabled || params.retry.maxRetries <= 0) {
        logSkipped("disabled");
        return "fail";
      }
      if (context.abortSignal?.aborted === true) {
        logSkipped("aborted");
        return "fail";
      }
      if (!isRetryableTransientModelError(error)) {
        logSkipped("not-transient");
        return "fail";
      }
      if (!context.retrySafety.canRetry) {
        params.logger.warn("transient model retry skipped; unsafe transcript boundary", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec: params.modelSpec,
          reason: context.retrySafety.reason,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return "fail";
      }
      if (attempts >= params.retry.maxRetries) {
        params.logger.warn("transient model retry exhausted", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec: params.modelSpec,
          attempts,
          maxRetries: params.retry.maxRetries,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return "fail";
      }

      attempts += 1;
      const delayMs = computeTransientRetryDelayMs({
        attempt: attempts,
        baseDelayMs: params.retry.baseDelayMs,
        maxDelayMs: params.retry.maxDelayMs,
      });

      params.logger.warn("transient model error; retrying", {
        requestId: params.requestId,
        sessionId: params.sessionId,
        modelSpec: params.modelSpec,
        attempt: attempts,
        maxRetries: params.retry.maxRetries,
        delayMs,
        error: summarizeError(error),
        ...extractAiErrorLogDetails(error),
      });

      if (delayMs > 0) {
        try {
          await sleep(delayMs, undefined, { signal: context.abortSignal });
        } catch {
          logSkipped("aborted-during-backoff");
          return "fail";
        }
      }

      return "retry";
    },
  };
}
