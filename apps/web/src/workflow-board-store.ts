import { createStore } from "zustand/vanilla";

/** Links the board to its sidebar list, which live in separate parts of the app shell. */
export const workflowBoardStore = createStore<{
  /** The selected run. The key lets the same run be selected twice. */
  focus?: { runId: string; key: number; pending: boolean };
  /** The run shown in the dialog. Kept here so the dialog outlives its virtualized card. */
  openRunId?: string;
}>(() => ({}));

let focusKey = 0;

export function focusWorkflowCard(runId: string) {
  focusKey += 1;
  workflowBoardStore.setState({ focus: { runId, key: focusKey, pending: true } });
}

/** Scrolling back to a card remounts it, which must not take keyboard focus a second time. */
export function workflowCardFocused() {
  const { focus } = workflowBoardStore.getState();
  if (focus) workflowBoardStore.setState({ focus: { ...focus, pending: false } });
}

export function openWorkflowCard(runId: string) {
  workflowBoardStore.setState({ openRunId: runId });
}

export function closeWorkflowCard() {
  workflowBoardStore.setState({ openRunId: undefined });
}

export function resetWorkflowBoard() {
  workflowBoardStore.setState({ focus: undefined, openRunId: undefined });
}
