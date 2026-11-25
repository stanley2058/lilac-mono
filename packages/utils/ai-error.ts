import { APICallError, RetryError } from "ai";
import { Result } from "better-result";

import { isRecord } from "./runtime-utils";

const MAX_ERROR_DEPTH = 8;
const MAX_PROVIDER_MESSAGE_LENGTH = 1_000;
const MAX_URL_LENGTH = 1_000;
const SENSITIVE_ASSIGNMENT_RE =
  /((?:authorization|api[_-]?key|token|secret|password|cookie)\s*[:=]\s*)([^\s,;}]+)/giu;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const CREDENTIAL_TOKEN_RE =
  /\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{8,}\b/gu;

export type AiErrorLogDetails = {
  aiErrorName: string;
  aiErrorMessage: string;
  retryReason?: string;
  retryAttempts?: number;
  statusCode?: number;
  requestUrl?: string;
  isRetryable?: boolean;
  providerMessage?: string;
  providerCode?: string | number;
  providerType?: string;
  providerParam?: string;
};

type NativeProviderErrorDetails = {
  readonly name: string;
  readonly message: string;
  readonly statusCode?: number;
  readonly providerCode?: string | number;
  readonly providerType?: string;
  readonly providerParam?: string;
};

type LocatedAiErrors = {
  apiCallError?: APICallError;
  retryError?: RetryError;
  nativeError?: NativeProviderErrorDetails;
};

type ProviderErrorDetails = Pick<
  AiErrorLogDetails,
  "providerMessage" | "providerCode" | "providerType" | "providerParam"
>;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function sanitizeProviderText(value: string): string {
  return truncate(
    value
      .replace(SENSITIVE_ASSIGNMENT_RE, "$1<redacted>")
      .replace(BEARER_TOKEN_RE, "Bearer <redacted>")
      .replace(CREDENTIAL_TOKEN_RE, "<redacted>"),
    MAX_PROVIDER_MESSAGE_LENGTH,
  );
}

function sanitizeRequestUrl(value: string): string {
  return Result.try({
    try: () => {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return truncate(url.toString(), MAX_URL_LENGTH);
    },
    catch: () => undefined,
  }).match({
    ok: (sanitized) => sanitized,
    err: () => truncate(value.split(/[?#]/u, 1)[0] ?? value, MAX_URL_LENGTH),
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? sanitizeProviderText(value) : undefined;
}

function readStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "string") return sanitizeProviderText(value);
  return typeof value === "number" ? value : undefined;
}

function parseProviderErrorDetails(value: unknown): ProviderErrorDetails {
  if (!isRecord(value)) return {};

  const nested = isRecord(value.error) ? value.error : value;
  const providerType = readString(nested.type) ?? readString(nested.status);
  const providerParam = readString(nested.param);

  return {
    providerMessage: readString(nested.message) ?? readString(nested.detail),
    providerCode: readStringOrNumber(nested.code),
    providerType,
    providerParam,
  };
}

function parseResponseBody(responseBody: string): ProviderErrorDetails {
  return Result.try({
    try: () => parseProviderErrorDetails(JSON.parse(responseBody) as unknown),
    catch: () => undefined,
  }).match({
    ok: (details) => details,
    err: () => {
      const providerMessage = sanitizeProviderText(responseBody.trim());
      return providerMessage.length > 0 ? { providerMessage } : {};
    },
  });
}

function extractNativeProviderError(
  error: Error,
  cause: unknown,
): NativeProviderErrorDetails | undefined {
  if (!isRecord(cause)) return undefined;
  let statusCode: number | undefined;
  if (typeof cause.statusCode === "number") {
    statusCode = cause.statusCode;
  } else if (typeof cause.status === "number") {
    statusCode = cause.status;
  }
  const providerCode = readStringOrNumber(cause.code);
  const providerType = readString(cause.type);
  const providerParam = readString(cause.param);
  if (
    statusCode === undefined &&
    providerCode === undefined &&
    providerType === undefined &&
    providerParam === undefined
  ) {
    return undefined;
  }
  const message =
    readString(cause.message) ??
    (error.message.length > 0 ? sanitizeProviderText(error.message) : "Provider request failed");
  return {
    name: error.name || "ProviderError",
    message,
    statusCode,
    providerCode,
    providerType,
    providerParam,
  };
}

function locateAiErrors(
  value: unknown,
  located: LocatedAiErrors,
  seen: Set<unknown>,
  depth: number,
): void {
  if (depth > MAX_ERROR_DEPTH || value === null || value === undefined) return;
  if ((typeof value === "object" || typeof value === "function") && seen.has(value)) return;
  if (typeof value === "object" || typeof value === "function") seen.add(value);

  if (RetryError.isInstance(value)) {
    located.retryError ??= value;
    locateAiErrors(value.lastError, located, seen, depth + 1);
    for (let index = value.errors.length - 1; index >= 0; index -= 1) {
      locateAiErrors(value.errors[index], located, seen, depth + 1);
    }
    return;
  }

  if (APICallError.isInstance(value)) {
    located.apiCallError ??= value;
    return;
  }

  if (value instanceof Error && value.cause !== undefined) {
    located.nativeError ??= extractNativeProviderError(value, value.cause);
    locateAiErrors(value.cause, located, seen, depth + 1);
  }

  if (!isRecord(value)) return;

  for (const key of ["lastError", "error", "cause", "errors"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        locateAiErrors(nested[index], located, seen, depth + 1);
      }
    } else {
      locateAiErrors(nested, located, seen, depth + 1);
    }
  }
}

export function extractAiErrorLogDetails(error: unknown): AiErrorLogDetails | undefined {
  const located: LocatedAiErrors = {};
  const captured = Result.try({
    try: () => locateAiErrors(error, located, new Set<unknown>(), 0),
    catch: () => undefined,
  });
  const locatedSuccessfully = captured.match({ ok: () => true, err: () => false });
  if (!locatedSuccessfully) return undefined;

  const apiCallError = located.apiCallError;
  const retryError = located.retryError;
  const primaryError = retryError ?? apiCallError;
  if (!primaryError) {
    const nativeError = located.nativeError;
    if (!nativeError) return undefined;
    return {
      aiErrorName: nativeError.name,
      aiErrorMessage: nativeError.message,
      statusCode: nativeError.statusCode,
      providerMessage: nativeError.message,
      providerCode: nativeError.providerCode,
      providerType: nativeError.providerType,
      providerParam: nativeError.providerParam,
    };
  }

  const responseBody = apiCallError?.responseBody;
  const providerDetails = responseBody
    ? parseResponseBody(responseBody)
    : parseProviderErrorDetails(apiCallError?.data);

  return {
    aiErrorName: primaryError.name,
    aiErrorMessage: sanitizeProviderText(primaryError.message),
    retryReason: retryError ? sanitizeProviderText(retryError.reason) : undefined,
    retryAttempts: retryError?.errors.length,
    statusCode: apiCallError?.statusCode,
    requestUrl: apiCallError ? sanitizeRequestUrl(apiCallError.url) : undefined,
    isRetryable: apiCallError?.isRetryable,
    ...providerDetails,
  };
}
