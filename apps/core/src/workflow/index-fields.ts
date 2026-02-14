import { z } from "zod";

import type { WorkflowTaskRecord } from "./types";
import { computeNextCronAtMs } from "./cron";

const cronExpr5Schema = z
  .string()
  .min(1)
  .refine((s) => s.trim().split(/\s+/g).filter(Boolean).length === 5, "cron expr must be 5 fields");

const discordWaitForReplyInputSchema = z
  .object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    fromUserId: z.string().min(1).optional(),
    timeoutMs: z.number().finite().optional(),
  })
  .passthrough();

const timeWaitUntilInputSchema = z
  .object({
    runAtMs: z.number().finite(),
  })
  .passthrough();

const timeCronInputSchema = z
  .object({
    expr: cronExpr5Schema,
    tz: z.string().min(1).optional(),
    startAtMs: z.number().finite().optional(),
    skipMissed: z.boolean().optional(),
  })
  .passthrough();

export function indexFieldsForTask(params: {
  kind: string;
  input?: unknown;
}): Pick<
  WorkflowTaskRecord,
  "discordChannelId" | "discordMessageId" | "discordFromUserId" | "timeoutAt"
> {
  if (params.kind === "discord.wait_for_reply") {
    const parsed = discordWaitForReplyInputSchema.safeParse(params.input);
    if (!parsed.success) return {};
    const input = parsed.data;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? input.timeoutMs
        : undefined;
    return {
      discordChannelId: input.channelId,
      discordMessageId: input.messageId,
      discordFromUserId: input.fromUserId,
      timeoutAt:
        typeof timeoutMs === "number" && timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
    };
  }

  if (params.kind === "time.wait_until") {
    const parsed = timeWaitUntilInputSchema.safeParse(params.input);
    if (!parsed.success) return {};
    return {
      timeoutAt: Math.trunc(parsed.data.runAtMs),
    };
  }

  if (params.kind === "time.cron") {
    const parsed = timeCronInputSchema.safeParse(params.input);
    if (!parsed.success) return {};
    let nextAt: number;
    try {
      nextAt = computeNextCronAtMs(
        {
          expr: parsed.data.expr,
          tz: parsed.data.tz,
          startAtMs:
            typeof parsed.data.startAtMs === "number" && Number.isFinite(parsed.data.startAtMs)
              ? Math.trunc(parsed.data.startAtMs)
              : undefined,
          skipMissed: parsed.data.skipMissed,
        },
        Date.now(),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid time.cron input: ${msg}`);
    }
    return {
      timeoutAt: nextAt,
    };
  }

  return {};
}
