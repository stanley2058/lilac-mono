const BYTE_MULTIPLIERS = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
} as const;

const DURATION_MULTIPLIERS_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  mo: 30 * 24 * 60 * 60 * 1000,
} as const;

function parseFriendlyUnit(
  value: unknown,
  multipliers: Readonly<Record<string, number>>,
  expected: string,
): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`${expected} must be a non-negative safe integer`);
  }

  if (typeof value !== "string") {
    throw new Error(`${expected} must be a number or friendly unit string`);
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d+))?([A-Za-z]+)$/u.exec(value);
  if (!match) throw new Error(`Invalid ${expected}: ${value}`);

  const multiplier = multipliers[match[3] ?? ""];
  if (multiplier === undefined) throw new Error(`Unsupported ${expected} unit: ${match[3]}`);

  const amount = Number(match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`);
  const normalized = amount * multiplier;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${expected} must normalize to a non-negative safe integer`);
  }
  return normalized;
}

export function parseFriendlyByteSize(value: unknown): number {
  return parseFriendlyUnit(value, BYTE_MULTIPLIERS, "byte size");
}

export function parseFriendlyDurationMs(value: unknown): number {
  return parseFriendlyUnit(value, DURATION_MULTIPLIERS_MS, "duration");
}
