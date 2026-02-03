import cronParser from "cron-parser";

export type CronScheduleInput = {
  expr: string;
  tz?: string;
  startAtMs?: number;
  /** If true, compute next run strictly after now/start. Default: true. */
  skipMissed?: boolean;
};

type CronParserLike = {
  parseExpression(
    expr: string,
    opts?: { currentDate?: Date; tz?: string },
  ): {
    next(): unknown;
  };
};

function asCronParser(mod: unknown): CronParserLike {
  if (typeof mod === "function") {
    const m = mod as unknown as { parseExpression?: unknown };
    if (typeof m.parseExpression === "function") {
      return mod as unknown as CronParserLike;
    }
  }
  if (mod && typeof mod === "object") {
    const m = mod as Record<string, unknown>;
    if (typeof m.parseExpression === "function") {
      return mod as CronParserLike;
    }
    if (m.default && typeof (m.default as any).parseExpression === "function") {
      return m.default as CronParserLike;
    }
  }
  throw new Error("cron-parser module shape not recognized");
}

function ensureFiveFieldCron(expr: string): string {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/g).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression '${expr}'. Expected 5 fields (minute precision).`,
    );
  }
  return trimmed;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const v = value as { toDate?: unknown };
    if (typeof v.toDate === "function") {
      const d = (v.toDate as () => unknown)();
      if (d instanceof Date) return d;
    }
  }

  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) {
    throw new Error("Failed to convert cron next() result to Date");
  }
  return d;
}

/** Compute the next cron run timestamp (ms since epoch). */
export function computeNextCronAtMs(input: CronScheduleInput, nowMs: number): number {
  const expr = ensureFiveFieldCron(input.expr);
  const tz = input.tz ?? "UTC";

  const startAtMs =
    typeof input.startAtMs === "number" && Number.isFinite(input.startAtMs)
      ? Math.trunc(input.startAtMs)
      : undefined;

  const baseMs = startAtMs !== undefined ? Math.max(nowMs, startAtMs) : nowMs;

  // cron-parser's next() is strict (> currentDate). Subtract 1ms so boundary-aligned
  // schedules can fire exactly at baseMs.
  const currentDate = new Date(baseMs - 1);

  const parser = asCronParser(cronParser);

  const it = parser.parseExpression(expr, { currentDate, tz });
  const next = toDate(it.next());
  return next.getTime();
}
