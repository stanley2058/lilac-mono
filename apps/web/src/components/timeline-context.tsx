import { type OptimisticTurn } from "../optimistic-turns";
import { type MessageServices } from "./message-services";
import { createContext, type ReactNode, useMemo } from "react";
import type { NativeClient } from "@stanley2058/lilac-client";
import { type OutlineSource } from "../timeline-outline";

export type TimelineProps = MessageServices & {
  header?: ReactNode;
  footer?: ReactNode;
  /** Messages after the last turn that are not turns yet, such as queued or unsent input. */
  trailing?: ReactNode;
  client: Pick<NativeClient, "thread" | "hydrate" | "loadTurnPage" | "subscribe">;
  threadId: string;
  onRewind: (turnId: string) => void;
  onLatestVisibleChange?: (visible: boolean) => void;
  emptyMessage?: string;
  emptyContent?: ReactNode;
  /** Centers the empty state and composer together, as on a new conversation. */
  centerEmpty?: boolean;
  optimisticTurn?: OptimisticTurn;
  onOptimisticResolved?: () => void;
  timestamps?: boolean;
  /** Turn outline for the jump rail; the rail stays hidden without one. */
  outline?: OutlineSource;
};
export type TimelineServices = Pick<
  TimelineProps,
  "client" | "threadId" | "onRewind" | "timestamps"
> & {
  measureTurn: (content: HTMLElement) => void;
};
export const TimelineContext = createContext<TimelineServices | undefined>(undefined);
export function useMessageServicesValue({
  canEdit,
  rewindDisabled,
  resourceUrl,
  upload,
  onAction,
  onReaction,
  questions,
}: MessageServices) {
  return useMemo(
    () => ({ canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction, questions }),
    [canEdit, rewindDisabled, resourceUrl, upload, onAction, onReaction, questions],
  );
}
