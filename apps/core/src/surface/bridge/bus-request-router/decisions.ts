import { parseSteerDirectiveMode } from "./common";

export type ActiveRequestRouteDecision =
  | {
      kind: "active_output_steer";
      queue: "steer" | "interrupt";
      inheritReplyTo: false;
    }
  | {
      kind: "active_output_follow_up";
    }
  | {
      kind: "active_mention_steer";
      queue: "steer" | "interrupt";
      inheritReplyTo: true;
    }
  | {
      kind: "fork_reply_prompt";
    }
  | {
      kind: "plain_follow_up";
    }
  | {
      kind: "buffered_prompt";
    };

export function decideActiveRequestRoute(input: {
  activeOutputMessageIds: ReadonlySet<string>;
  replyToBot: boolean;
  mentionsBot: boolean;
  replyToMessageId?: string;
  userText: string;
  botMentionNames: readonly string[];
  allowMentionSteer: boolean;
  plainMessageBehavior: "follow_up" | "buffered_prompt";
}): ActiveRequestRouteDecision {
  const isReplyToActiveOutput =
    input.replyToBot &&
    typeof input.replyToMessageId === "string" &&
    input.activeOutputMessageIds.has(input.replyToMessageId);

  if (isReplyToActiveOutput) {
    if (input.mentionsBot) {
      return {
        kind: "active_output_steer",
        queue: parseSteerDirectiveMode({
          text: input.userText,
          botNames: input.botMentionNames,
        }),
        inheritReplyTo: false,
      };
    }

    return { kind: "active_output_follow_up" };
  }

  if (!input.replyToBot && input.mentionsBot && input.allowMentionSteer) {
    return {
      kind: "active_mention_steer",
      queue: parseSteerDirectiveMode({
        text: input.userText,
        botNames: input.botMentionNames,
      }),
      inheritReplyTo: true,
    };
  }

  if (input.replyToBot) return { kind: "fork_reply_prompt" };

  return input.plainMessageBehavior === "follow_up"
    ? { kind: "plain_follow_up" }
    : { kind: "buffered_prompt" };
}
