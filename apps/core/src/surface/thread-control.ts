import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import type { Result } from "better-result";

import type { SurfaceOperationError } from "./adapter";

/** The authenticated user an agent run acts for, and the thread that run belongs to. */
export type ThreadControlCaller = {
  readonly userId: string;
  readonly sourceThreadId: string;
};

export type ThreadTimelineView = "messages" | "activity";

export type ThreadTimelineItem = {
  readonly id: string;
  readonly role: DisplayMessage["role"];
  readonly kind: "text" | "activity";
  readonly text: string;
  readonly truncated: boolean;
  /** Who wrote a user message, on surfaces where several people share a thread. */
  readonly author?: string;
  /**
   * The state of the input this message carries, when it is not simply admitted: queued, still
   * uploading, `target-ended` for a steer whose run ended first, canceled, or failed.
   */
  readonly inputState?: string;
  readonly activity?: {
    readonly kind: "tool" | "thinking" | "workflow";
    readonly state: "running" | "complete" | "failed";
    readonly exitCode?: number;
  };
};

export type ThreadReadInput = {
  readonly view: ThreadTimelineView;
  readonly before?: string;
  readonly after?: string;
  readonly limit: number;
  readonly maxCharsPerItem: number;
};

export type ThreadReadResult = {
  readonly threadId: string;
  readonly title: string;
  readonly activeRunId: string | null;
  readonly items: readonly ThreadTimelineItem[];
  /** Older messages exist before this page. */
  readonly hasMore: boolean;
  /** Pass as `before` to read older messages. */
  readonly before?: string;
  /** Pass as `after` to read messages newer than this page. */
  readonly after?: string;
};

export type ThreadSendMode = "auto" | "queue" | "steer";

export type ThreadSendResult = {
  /** `posted` means the message was delivered without running the thread's agent. */
  readonly disposition: "posted" | "started" | "queued" | "steered";
  readonly messageId: string;
  readonly runId?: string;
};

export type ThreadInterruptResult = {
  /** `ended` means the requested run had already finished; nothing was cancelled. */
  readonly status: "cancelled" | "idle" | "ended";
  readonly runId?: string;
};

/**
 * Lets an agent read, message, and stop another thread on the surface that started its run.
 * A surface without this port does not support cross-thread control. A surface may support
 * reads only and reject `send` and `interrupt`.
 */
export type SurfaceThreadControlPort = {
  read(
    caller: ThreadControlCaller,
    threadId: string,
    input: ThreadReadInput,
  ): Promise<Result<ThreadReadResult, SurfaceOperationError>>;
  send(
    caller: ThreadControlCaller,
    threadId: string,
    input: { readonly text: string; readonly mode: ThreadSendMode; readonly commandId?: string },
  ): Promise<Result<ThreadSendResult, SurfaceOperationError>>;
  interrupt(
    caller: ThreadControlCaller,
    threadId: string,
    input: { readonly runId?: string },
  ): Promise<Result<ThreadInterruptResult, SurfaceOperationError>>;
};

export function boundTimelineText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Projects display messages into agent-readable items. `messages` keeps only text, and `activity`
 * also keeps tool calls, thinking, and workflow cards with their output.
 */
export function projectThreadTimeline(
  messages: readonly DisplayMessage[],
  view: ThreadTimelineView,
  maxCharsPerItem: number,
  inputState: (message: DisplayMessage) => string | undefined = () => undefined,
): ThreadTimelineItem[] {
  const items: ThreadTimelineItem[] = [];
  for (const message of messages) {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    const state = inputState(message);
    if (text.trim())
      items.push({
        id: message.id,
        role: message.role,
        kind: "text",
        ...boundTimelineText(text, maxCharsPerItem),
        ...(state ? { inputState: state } : {}),
      });
    if (view !== "activity") continue;
    for (const part of message.parts) {
      if (part.type !== "data-activity") continue;
      const body = [part.data.label, part.data.detail, part.data.output]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n");
      items.push({
        id: `${message.id}:${part.id}`,
        role: message.role,
        kind: "activity",
        ...boundTimelineText(body, maxCharsPerItem),
        activity: {
          kind: part.data.kind,
          state: part.data.state,
          ...(part.data.exitCode === undefined ? {} : { exitCode: part.data.exitCode }),
        },
      });
    }
  }
  return items;
}
