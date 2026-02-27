import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";

import { resolveModelSlot, type CoreConfig } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import type { MsgRef } from "../../types";

export type RouterGateContextMode = "active-batch" | "direct-reply-mention-disambiguation";

export type BufferedMessage = {
  msgRef: MsgRef;
  userId: string;
  text: string;
  ts: number;
  mentionsBot: boolean;
  replyToBot: boolean;
  botUserId?: string;
  sessionModelOverride?: string;
  requestModelOverride?: string;
};

export type RouterGateInput = {
  sessionId: string;
  botName: string;
  messages: BufferedMessage[];
  context?: {
    mode: RouterGateContextMode;
    triggerMessageText?: string;
    previousMessageText?: string;
    repliedToMessageText?: string;
  };
};

export type RouterGateDecision = {
  forward: boolean;
  reason?: string;
};

const gateSchema = z.object({
  forward: z.boolean(),
  reason: z.string().optional(),
});

export async function shouldForwardByGate(params: {
  cfg: CoreConfig;
  input: RouterGateInput;
  logger: Logger;
}): Promise<RouterGateDecision> {
  const gateCfg = params.cfg.surface.router.activeGate;

  const timeoutMs = gateCfg.timeoutMs;
  const abort = new AbortController();

  const timeout = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const resolved = resolveModelSlot(params.cfg, "fast");

    const prompt = (() => {
      if (params.input.context?.mode === "direct-reply-mention-disambiguation") {
        const triggerMessageText = params.input.context.triggerMessageText ?? "";
        const previousMessageText = params.input.context.previousMessageText ?? "";
        const repliedToMessageText = params.input.context.repliedToMessageText ?? "";

        return [
          {
            role: "system",
            content: [
              "You are a router gate for a chat bot.",
              "Decide whether THIS bot should reply to this direct-reply message.",
              "The user replied to this bot, did not mention this bot explicitly, and included another @mention.",
              'Return strict JSON only: {"forward": true|false, "reason"?: string}',
              "Use context to distinguish address vs reference mentions.",
              "If uncertain, return forward=true.",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `sessionId=${params.input.sessionId}`,
              `botName=${params.input.botName}`,
              "",
              `triggerMessage=${triggerMessageText || "(none)"}`,
              `repliedToMessage=${repliedToMessageText || "(none)"}`,
              `previousMessage=${previousMessageText || "(none)"}`,
              "",
              "forward=true when the message still seeks this bot's input (even if another bot is referenced).",
              "forward=false only when it is clearly addressed to someone else.",
            ].join("\n"),
          },
        ] satisfies ModelMessage[];
      }

      const indirectMention = params.input.messages.some((m) =>
        m.text.toLowerCase().includes(params.input.botName.toLowerCase()),
      );

      const transcript = params.input.messages
        .map((m) => `[user_id=${m.userId}] ${m.text}`)
        .join("\n");

      return [
        {
          role: "system",
          content: [
            "You are a router gate for a chat bot.",
            "Decide whether the bot should start a new request and reply.",
            'Return strict JSON only: {"forward": true|false, "reason"?: string}',
            "If uncertain, return forward=false.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `sessionId=${params.input.sessionId}`,
            `botName=${params.input.botName}`,
            `indirectMention=${String(indirectMention)}`,
            `previousMessage=${params.input.context?.previousMessageText ?? "(none)"}`,
            "",
            "Batch:",
            transcript,
            "",
            "Special case: if this looks like a heartbeat poll that expects a reply (e.g. mentions HEARTBEAT.md/HEARTBEAT_OK), forward=true.",
          ].join("\n"),
        },
      ] satisfies ModelMessage[];
    })();

    const res = await generateText({
      model: resolved.model,
      output: Output.object({ schema: gateSchema }),
      prompt,
      abortSignal: abort.signal,
      maxOutputTokens: 1024,
      providerOptions: resolved.providerOptions,
    });

    return res.output;
  } catch (e) {
    const failOpen = params.input.context?.mode === "direct-reply-mention-disambiguation";
    params.logger.error(
      "router gate error",
      {
        sessionId: params.input.sessionId,
        mode: params.input.context?.mode ?? "active-batch",
        failOpen,
      },
      e,
    );
    return {
      forward: failOpen,
      reason: failOpen ? "error-fail-open" : "error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
