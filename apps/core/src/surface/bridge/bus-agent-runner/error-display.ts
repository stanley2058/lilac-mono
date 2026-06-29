import { isRecord } from "@stanley2058/lilac-utils";

import { safeStringify } from "./formatting";

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatErrorLabel(value: unknown): string | undefined {
  const label = readNonEmptyString(value);
  if (!label || label === "error") return undefined;
  return label;
}

function extractReadableErrorMessage(
  value: unknown,
  seen: Set<unknown>,
  depth: number,
): string | null {
  if (depth > 8 || value === null || value === undefined) return null;

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value instanceof Error) {
    return value.message.trim().length > 0 ? value.message : value.name;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractReadableErrorMessage(item, seen, depth + 1);
      if (message) return message;
    }
    return null;
  }

  if (!isRecord(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  for (const key of ["error", "cause", "lastError"] as const) {
    if (!(key in value)) continue;
    const message = extractReadableErrorMessage(value[key], seen, depth + 1);
    if (message) return message;
  }

  const message = readNonEmptyString(value.message ?? value.errorMessage ?? value.detail);
  if (message) {
    const label =
      formatErrorLabel(value.code) ?? formatErrorLabel(value.type) ?? formatErrorLabel(value.name);
    return label && !message.includes(label) ? `${label}: ${message}` : message;
  }

  const responseBody = readNonEmptyString(value.responseBody ?? value.body);
  if (responseBody) return responseBody;

  return null;
}

export function formatUnknownErrorForDisplay(error: unknown): string {
  const readable = extractReadableErrorMessage(error, new Set<unknown>(), 0);
  if (readable) return readable;

  const formatted = safeStringify(error);
  return formatted.length > 500 ? `${formatted.slice(0, 500)}...` : formatted;
}
