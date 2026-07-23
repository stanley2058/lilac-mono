import { z } from "zod";

const MAX_TITLE_LENGTH = 100;

const snapshotPresentationSchema = z.object({
  title: z.string().optional(),
  inputTokens: z.number().nonnegative().nullable().optional(),
  contextWindow: z.number().positive().nullable().optional(),
});

export interface SessionPresentation {
  readonly title: string;
  readonly inputTokens: number | null;
  readonly contextWindow: number | null;
}

export function sessionPresentation(snapshot: unknown): SessionPresentation {
  const parsed = snapshotPresentationSchema.safeParse(snapshot);
  if (!parsed.success) return { title: "Mini Lilac", inputTokens: null, contextWindow: null };
  return {
    title: parsed.data.title ?? "Mini Lilac",
    inputTokens: parsed.data.inputTokens ?? null,
    contextWindow: parsed.data.contextWindow ?? null,
  };
}

export function formatSessionTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= MAX_TITLE_LENGTH) return title;
  return `${characters.slice(0, MAX_TITLE_LENGTH - 3).join("")}...`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "K" : "M";
  const rounded = Math.round((tokens / divisor) * 10) / 10;
  if (suffix === "K" && rounded >= 1_000) return "1M";
  return `${rounded}${suffix}`;
}

export function resolveContextWindow(
  sessionContextWindow: number | null,
  modelContextWindow: number | undefined,
): number | null {
  return sessionContextWindow ?? modelContextWindow ?? null;
}

export function formatTokenUsage(
  inputTokens: number | null,
  contextWindow: number | null,
): string | undefined {
  if (inputTokens === null || contextWindow === null || contextWindow <= 0) return undefined;
  return `${formatTokenCount(inputTokens)} (${Math.round((inputTokens / contextWindow) * 100)}%)`;
}
