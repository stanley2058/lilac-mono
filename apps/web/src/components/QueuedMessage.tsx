import { RotateCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { IconButton } from "./ui";
import { Bubble, BubbleContent } from "./ui/bubble";
import { Button } from "./ui/button";

/** Unconfirmed by the server, waiting in its queue, or rejected. */
export type QueuedMessageState = "sending" | "queued" | "failed";

const bubbleStates: Record<QueuedMessageState, string> = {
  sending:
    "*:data-[slot=bubble-content]:border-dashed *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:text-muted-foreground",
  queued: "*:data-[slot=bubble-content]:bg-transparent",
  failed:
    "*:data-[slot=bubble-content]:border-dashed *:data-[slot=bubble-content]:border-destructive/60 *:data-[slot=bubble-content]:bg-transparent",
};

export function QueuedMessage(props: {
  text: string;
  state: QueuedMessageState;
  /** The delivery mode, such as Steering; a plain message has none. */
  label?: string;
  error?: string;
  retryLabel?: string;
  onRetry?: () => void;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  let status: ReactNode = props.label;
  if (props.state === "sending") status = props.label ? `${props.label} · Sending` : "Sending";
  if (props.state === "failed")
    status = <span className="text-destructive">{props.error ?? "Not sent"}</span>;
  return (
    <div
      data-ui="queued-message"
      data-state={props.state}
      className="flex min-w-0 flex-col items-end gap-1 py-0.5"
    >
      <Bubble align="end" variant="outline" className={bubbleStates[props.state]}>
        <BubbleContent className="max-h-40 overflow-auto whitespace-pre-wrap">
          {props.text}
        </BubbleContent>
      </Bubble>
      <div className="message-controls flex min-h-[var(--ui-control-compact)] items-center justify-end gap-1 text-xs text-muted-foreground">
        {status ? <span className="px-1">{status}</span> : null}
        {props.onRetry ? (
          <Button type="button" variant="ghost" size="xs" onClick={props.onRetry}>
            <RotateCw />
            {props.retryLabel ?? "Retry"}
          </Button>
        ) : null}
        {props.onRemove ? (
          <IconButton label={props.removeLabel ?? "Remove message"} onClick={props.onRemove}>
            <X />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

/** Messages after the last turn, laid out like a turn so they line up with the conversation. */
export function QueuedMessages({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-ui="queued-messages"
      className={cn(
        "flex flex-col gap-3 px-6 pb-6 max-workspace:px-4 max-workspace:pb-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
