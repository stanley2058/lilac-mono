import { setTimeout as sleep } from "node:timers/promises";

import { createLogger } from "@stanley2058/lilac-utils/logging";
import { extractAiErrorLogDetails } from "@stanley2058/lilac-utils/ai-error";
import { isRecord } from "@stanley2058/lilac-utils/runtime-utils";

import { captureAgentOperation, captureAgentPromise, rethrowAgentPanic } from "./failure-adapters";
import { isLikelyContextOverflowError } from "./context-overflow";
import type { TurnErrorHandler, TurnErrorHandlerDecision } from "./ai-sdk-pi-agent";
import { computeRetryBackoffDelayMs, type RetryBackoffConfig } from "./retry-backoff";

const TRANSIENT_MODEL_ERROR_PATTERN =
  /overloaded|server_is_overloaded|service[_\s-]*unavailable|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|524|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|socket connection was closed unexpectedly|websocket.?closed|websocket.?error|other side closed|fetch failed|failed to fetch|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before|http2 request did not get a response|timed? out|timeout|terminated|retry delay|resource[_\s-]*exhausted|try your request again|retry your request|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 524]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ConnectionClosed",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

export type TransientModelRetryConfig = RetryBackoffConfig;

export type TransientModelRetryController = {
  handler: TurnErrorHandler;
  reset: () => void;
};

export type AdvanceModelResult = { ok: true; modelSpec: string } | { ok: false; reason: string };

export type AdvanceModel = () => Promise<AdvanceModelResult>;

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return undefined;
}

function hasRetryErrorExhausted(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "AI_RetryError" && error.reason === "maxRetriesExceeded";
}

function hasTransientRetryErrorExhausted(error: unknown): boolean {
  if (!hasRetryErrorExhausted(error) || !isRecord(error)) return false;
  return isRetryableTransientModelError(error.lastError);
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
  return computeRetryBackoffDelayMs(params);
}

function defaultErrorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const serialized = captureAgentOperation(() => JSON.stringify(error));
  const outcome = serialized.match<
    { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: unknown }
  >({
    ok: (value) => ({ ok: true, value }),
    err: (cause) => ({ ok: false, error: cause }),
  });
  if (outcome.ok) return outcome.value;
  rethrowAgentPanic(outcome.error);
  return String(error);
}

export function createTransientModelRetryController(params: {
  retry: TransientModelRetryConfig;
  logger: ReturnType<typeof createLogger>;
  requestId: string;
  sessionId: string;
  modelSpec: string;
  formatError?: (error: unknown) => string;
  advanceModel?: AdvanceModel;
}): TransientModelRetryController {
  let attempts = 0;
  let modelSpec = params.modelSpec;
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
          modelSpec,
          reason,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
      };

      const advanceModel = params.advanceModel;
      if (!advanceModel && (!params.retry.enabled || params.retry.maxRetries <= 0)) {
        logSkipped("disabled");
        return "fail";
      }

      if (context.abortSignal?.aborted === true) {
        logSkipped("aborted");
        return "fail";
      }

      const aiSdkRetriesExhausted =
        advanceModel !== undefined && hasTransientRetryErrorExhausted(error);
      if (!aiSdkRetriesExhausted && !isRetryableTransientModelError(error)) {
        logSkipped("not-transient");
        return "fail";
      }
      if (!context.retrySafety.canRetry) {
        params.logger.warn("transient model retry skipped; unsafe transcript boundary", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec,
          reason: context.retrySafety.reason,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return "fail";
      }
      if (advanceModel && context.phase !== "model-call") {
        logSkipped("not-model-call");
        return "fail";
      }

      const advance = async (callback: AdvanceModel): Promise<TurnErrorHandlerDecision> => {
        const previousModelSpec = modelSpec;
        const result = await callback();
        if (!result.ok) {
          params.logger.warn("model fallback skipped", {
            requestId: params.requestId,
            sessionId: params.sessionId,
            modelSpec: previousModelSpec,
            reason: result.reason,
            attempts,
            error: summarizeError(error),
            ...extractAiErrorLogDetails(error),
          });
          return "fail";
        }

        attempts = 0;
        modelSpec = result.modelSpec;
        params.logger.warn("transient model error; advanced model", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          fromModelSpec: previousModelSpec,
          modelSpec,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return "retry";
      };

      if (aiSdkRetriesExhausted && advanceModel) {
        params.logger.warn("AI SDK transient model retries exhausted", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return await advance(advanceModel);
      }

      if (!params.retry.enabled || params.retry.maxRetries <= 0) {
        logSkipped("disabled");
        return advanceModel ? await advance(advanceModel) : "fail";
      }
      if (attempts >= params.retry.maxRetries) {
        params.logger.warn("transient model retry exhausted", {
          requestId: params.requestId,
          sessionId: params.sessionId,
          modelSpec,
          attempts,
          maxRetries: params.retry.maxRetries,
          error: summarizeError(error),
          ...extractAiErrorLogDetails(error),
        });
        return advanceModel ? await advance(advanceModel) : "fail";
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
        modelSpec,
        attempt: attempts,
        maxRetries: params.retry.maxRetries,
        delayMs,
        error: summarizeError(error),
        ...extractAiErrorLogDetails(error),
      });

      if (delayMs > 0) {
        const delayed = await captureAgentPromise(() =>
          sleep(delayMs, undefined, { signal: context.abortSignal }),
        );
        const delayError = delayed.match({ ok: () => undefined, err: (cause) => cause });
        if (delayError !== undefined) {
          rethrowAgentPanic(delayError);
          if (!context.abortSignal?.aborted) throw delayError;
          logSkipped("aborted-during-backoff");
          return "fail";
        }
      }

      return "retry";
    },
  };
}
