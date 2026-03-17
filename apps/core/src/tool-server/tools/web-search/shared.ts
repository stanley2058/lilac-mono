import type { WebSearchTimeRange } from "./types";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (!signal.aborted) return;

  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function toUTCDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function startDateFromTimeRange(range: WebSearchTimeRange | undefined): string | undefined {
  if (!range) return undefined;

  const now = new Date();
  const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  switch (range) {
    case "day":
    case "d":
      utcDayStart.setUTCDate(utcDayStart.getUTCDate() - 1);
      return toUTCDateOnlyString(utcDayStart);
    case "week":
    case "w":
      utcDayStart.setUTCDate(utcDayStart.getUTCDate() - 7);
      return toUTCDateOnlyString(utcDayStart);
    case "month":
    case "m":
      utcDayStart.setUTCMonth(utcDayStart.getUTCMonth() - 1);
      return toUTCDateOnlyString(utcDayStart);
    case "year":
    case "y":
      utcDayStart.setUTCFullYear(utcDayStart.getUTCFullYear() - 1);
      return toUTCDateOnlyString(utcDayStart);
  }
}

export function toSearchContentSnippet(input: {
  highlights?: readonly string[];
  summary?: string;
  text?: string;
}): string {
  if (input.highlights && input.highlights.length > 0) {
    return input.highlights
      .map((highlight) => highlight.trim())
      .filter((highlight) => highlight.length > 0)
      .join(" [...] ");
  }

  if (typeof input.summary === "string" && input.summary.trim().length > 0) {
    return input.summary.trim();
  }

  if (typeof input.text === "string" && input.text.trim().length > 0) {
    return input.text.trim().slice(0, 2000);
  }

  return "";
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);

  const pending = run();
  if (!signal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
