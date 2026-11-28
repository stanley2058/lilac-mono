import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import type { Result } from "better-result";

import type { SurfaceOperationError } from "./adapter";

/** The authenticated user an agent run acts for, and the thread that run belongs to. */
export type ThreadControlCaller = {
  /** The user on the target surface, which may be an account linked to the run's own user. */
  readonly userId: string;
  readonly sourceThreadId: string;
  /** Set when the run is on another surface: its own user, who owns `sourceThreadId`. */
  readonly source?: { readonly platform: "native"; readonly userId: string };
};

/** A thread on another surface whose run posted into this surface's thread. */
export type ThreadRelaySource = {
  readonly platform: "native";
  readonly threadId: string;
  readonly userId: string;
};

export type ThreadTimelineView = "messages" | "activity";

export type ThreadTimelineItem = {
  readonly id: string;
  readonly role: DisplayMessage["role"];
  readonly kind: "text" | "activity";
  readonly text: string;
  readonly truncated: boolean;
  /** Where `text` starts in the full item, when it is not the start. */
  readonly textOffset?: number;
  /** Pass with this item's id as `textOffset` to read the rest of a truncated item. */
  readonly nextTextOffset?: number;
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
  /** Read only this item, starting at `textOffset`, instead of a page. */
  readonly item?: { readonly id: string; readonly textOffset: number };
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

export const THREAD_SEND_DISPOSITIONS = ["posted", "started", "queued", "steered"] as const;

export type ThreadSendResult = {
  /** `posted` means the message was delivered without running the thread's agent. */
  readonly disposition: (typeof THREAD_SEND_DISPOSITIONS)[number];
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
  /** Threads on other surfaces that relayed into this thread, which its runs may read. */
  relaySources?(threadId: string): readonly ThreadRelaySource[];
};

export function boundTimelineText(
  text: string,
  maxChars: number,
  textOffset = 0,
): { text: string; truncated: boolean; textOffset?: number; nextTextOffset?: number } {
  const end = textOffset + maxChars;
  const offset = textOffset > 0 ? { textOffset } : {};
  if (text.length <= end) return { text: text.slice(textOffset), truncated: false, ...offset };
  return { text: text.slice(textOffset, end), truncated: true, ...offset, nextTextOffset: end };
}

/** The message id of a timeline item; activity items append the part id after a colon. */
export function timelineItemMessageId(itemId: string): string {
  const colon = itemId.indexOf(":");
  return colon < 0 ? itemId : itemId.slice(0, colon);
}

/** Re-bounds one item of a full-text timeline from `textOffset`, for an item read. */
export function sliceTimelineItem(
  items: readonly ThreadTimelineItem[],
  item: NonNullable<ThreadReadInput["item"]>,
  maxChars: number,
): ThreadTimelineItem[] {
  const found = items.find((candidate) => candidate.id === item.id);
  if (!found) return [];
  return [{ ...found, ...boundTimelineText(found.text, maxChars, item.textOffset) }];
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
