const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context\s*(length|window).*(exceed|exceeded|overflow|too\s*long)/i,
  /maximum\s+context\s+length/i,
  /prompt\s+is\s+too\s+long/i,
  /input\s+is\s+too\s+long/i,
  /too\s+many\s+tokens/i,
  /token\s+limit\s+(exceed|exceeded|reached)/i,
  /prompt\s+token.*(exceed|exceeded)/i,
  /context[_\s-]*length[_\s-]*exceeded/i,
  /context[_\s-]*overflow/i,
];

function hasOverflowHint(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(s));
}

function visit(value: unknown, seen: Set<unknown>, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || value === undefined) return false;

  if (typeof value === "string") {
    return hasOverflowHint(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return false;
  }

  if (value instanceof Error) {
    if (hasOverflowHint(value.message)) return true;
    const withCause = value as Error & { cause?: unknown };
    if (withCause.cause !== undefined && visit(withCause.cause, seen, depth + 1)) return true;
  }

  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (visit(item, seen, depth + 1)) return true;
    }
    return false;
  }

  if (typeof value !== "object" || value === null) return false;

  const objectValue = value as Record<string, unknown>;

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
  ] as const;

  for (const key of keysToInspect) {
    if (!(key in objectValue)) continue;
    if (visit(objectValue[key], seen, depth + 1)) return true;
  }

  for (const [k, v] of Object.entries(objectValue)) {
    if (keysToInspect.includes(k as (typeof keysToInspect)[number])) continue;
    if (
      typeof v === "string" &&
      (k.toLowerCase().includes("context") || k.toLowerCase().includes("token"))
    ) {
      if (hasOverflowHint(v)) return true;
    }
  }

  return false;
}

export function isLikelyContextOverflowError(error: unknown): boolean {
  return visit(error, new Set<unknown>(), 0);
}
