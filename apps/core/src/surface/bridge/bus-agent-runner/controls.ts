import { type ModelMessage, type ToolSet, type UserContent } from "ai";
import { Result } from "better-result";
import { type StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { AiSdkPiAgent, type AgentInputQueueId } from "@stanley2058/lilac-agent";
import { parseRequestControlFromRaw } from "./raw";
import { degradeCorePrimaryLineageForMutation } from "./lineage";
import { type Enqueued, type SessionQueue } from "./session-queue";

/** The run a control was routed to, checked again after each await before the agent is used. */
export type RunningAgentControlTarget = {
  /** True while the captured run still owns its session and agent. */
  readonly isCurrent: () => boolean;
  /** Handles a deferred control whose run ended before it could be applied. */
  readonly dropEnded: () => Promise<void>;
};

/**
 * Applies a control to the running agent. Waits for the agent or its children to settle run
 * through `settle`, which orders them per session, so the caller never blocks on them.
 * Returns `target-ended` without touching the agent when the run ended while the control's
 * messages loaded; the caller then routes it as if it had arrived after the run.
 */
export async function applyToRunningAgent(
  agent: AiSdkPiAgent<ToolSet>,
  entry: Enqueued,
  cancelledByRequestId: Set<string>,
  activeRun: SessionQueue["activeRun"],
  retainAppliedControl: (
    checkpoint:
      | { readonly kind: "canonical" }
      | { readonly kind: "queued"; readonly inputId: AgentInputQueueId }
      | { readonly kind: "pending" },
  ) => void,
  settle: (operation: () => Promise<void>) => void,
  target: RunningAgentControlTarget,
): Promise<"applied" | "target-ended"> {
  activeRun?.flushOutput();
  const liveParent = activeRun?.liveParent;
  const notifyWaiters = activeRun?.notifyWaiters;
  const cancel = parseRequestControlFromRaw(entry.raw).cancel;
  const providerMessages =
    !cancel && activeRun?.materializeStoredMessages
      ? await activeRun.materializeStoredMessages(entry.storedMessages)
      : entry.messages;
  // An idle agent whose run already finalized would start a model run nobody owns.
  if (!target.isCurrent()) return "target-ended";
  const merged = mergeToSingleUserMessage(providerMessages);
  if (!cancel) {
    activeRun?.rememberStoredMessages(
      [merged],
      [mergeToSingleStoredUserMessage(entry.storedMessages)],
    );
  }
  const queueWhileIdle = (mode: "followUp" | "steer") => {
    const inputId = mode === "steer" ? agent.steer(merged) : agent.followUp(merged);
    retainAppliedControl({ kind: "queued", inputId });
    notifyWaiters?.();
  };

  const cancelRun = () => {
    retainAppliedControl({ kind: "pending" });
    cancelledByRequestId.add(entry.requestId);
    settle(async () => {
      await liveParent?.cancelAll("parent request aborted");
      await activeRun?.stopAwaitJobs?.();
      agent.cancel();
      notifyWaiters?.();
    });
  };

  const promptWhileIdle = () => {
    retainAppliedControl({ kind: "canonical" });
    void observePrompt();
    notifyWaiters?.();

    async function observePrompt(): Promise<void> {
      const prompted = await Result.tryPromise({
        try: () => agent.prompt(merged),
        catch: () => undefined,
      });
      if (prompted.match({ ok: () => false, err: () => true })) notifyWaiters?.();
    }
  };

  if (!cancel) {
    activeRun?.setCurrentTurnContext(entry.currentTurnUserId, entry.currentTurnMessageRef);
  }
  if (!cancel && activeRun?.runProfile === "primary" && activeRun.requestClient === "discord") {
    activeRun.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      entry.queue === "steer" || entry.queue === "interrupt"
        ? "steering-transform"
        : "follow-up-transform",
      agent.state.messages.length,
    );
  }

  const hasBufferedCompletions =
    (liveParent?.snapshot().hasPendingCompletions ?? false) ||
    (activeRun?.hasPendingJobEvents?.() ?? false);

  if (!agent.state.isStreaming) {
    switch (entry.queue) {
      case "steer": {
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return "applied";
        }
        promptWhileIdle();
        return "applied";
      }
      case "followUp":
      case "prompt": {
        if (hasBufferedCompletions) {
          queueWhileIdle("followUp");
          return "applied";
        }
        promptWhileIdle();
        return "applied";
      }
      case "interrupt": {
        if (cancel) {
          cancelRun();
          return "applied";
        }
        if (hasBufferedCompletions) {
          queueWhileIdle("steer");
          return "applied";
        }
        settle(async () => {
          // Earlier controls in this session may have held the queue until the run ended.
          if (!target.isCurrent()) return target.dropEnded();
          retainAppliedControl({ kind: "canonical" });
          await agent.interrupt(merged);
          notifyWaiters?.();
        });
        return "applied";
      }
      default: {
        const _exhaustive: never = entry.queue;
        return _exhaustive;
      }
    }
  }

  switch (entry.queue) {
    case "steer": {
      const steeringId = agent.steer(merged);
      retainAppliedControl({ kind: "queued", inputId: steeringId });
      notifyWaiters?.();
      return "applied";
    }
    case "followUp": {
      const followUpId = agent.followUp(merged);
      retainAppliedControl({ kind: "queued", inputId: followUpId });
      notifyWaiters?.();
      return "applied";
    }
    case "interrupt": {
      if (cancel) {
        cancelRun();
        return "applied";
      }
      const steeringId = agent.steer(merged);
      retainAppliedControl({ kind: "queued", inputId: steeringId });
      settle(async () => {
        await agent.interruptQueuedSteeringAsync();
        notifyWaiters?.();
      });
      return "applied";
    }
    case "prompt": {
      // Cannot prompt while streaming; treat as followUp.
      const followUpId = agent.followUp(merged);
      retainAppliedControl({ kind: "queued", inputId: followUpId });
      notifyWaiters?.();
      return "applied";
    }
    default: {
      const _exhaustive: never = entry.queue;
      return _exhaustive;
    }
  }
}

export function mergeToSingleUserMessage(messages: ModelMessage[]): ModelMessage {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    return { role: "user", content: "" };
  }

  const hasMultipart = userMessages.some((m) => typeof m.content !== "string");

  if (hasMultipart) {
    const parts: UserContent = [];
    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i]!;
      if (i > 0) {
        parts.push({ type: "text", text: "\n\n" });
      }

      if (typeof msg.content === "string") {
        if (msg.content.length > 0) {
          parts.push({ type: "text", text: msg.content });
        }
      } else {
        parts.push(...msg.content);
      }
    }

    return {
      role: "user",
      content: parts,
    };
  }

  // Preserve existing behavior: merge batches into one user message separated by blank lines.
  const parts: string[] = [];
  for (const m of userMessages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    }
  }

  return {
    role: "user",
    content: parts.join("\n\n").trim(),
  };
}

function mergeToSingleStoredUserMessage(messages: readonly StoredMessageV1[]): StoredMessageV1 {
  const userMessages = messages.filter(
    (message): message is Extract<StoredMessageV1, { readonly role: "user" }> =>
      message.role === "user",
  );
  if (userMessages.length === 0) return { role: "user", content: "" };
  const hasMultipart = userMessages.some((message) => typeof message.content !== "string");
  if (!hasMultipart) {
    return {
      role: "user",
      content: userMessages
        .flatMap((message) => (typeof message.content === "string" ? [message.content] : []))
        .join("\n\n")
        .trim(),
    };
  }

  const content: Exclude<Extract<StoredMessageV1, { readonly role: "user" }>["content"], string> =
    [];
  for (let index = 0; index < userMessages.length; index += 1) {
    const message = userMessages[index];
    if (!message) continue;
    if (index > 0) content.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") {
      if (message.content.length > 0) content.push({ type: "text", text: message.content });
      continue;
    }
    content.push(...message.content);
  }
  return { role: "user", content };
}
