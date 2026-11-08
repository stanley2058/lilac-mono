import { createStore } from "zustand/vanilla";

/** Links the board to its sidebar minimap, which live in separate parts of the app shell. */
export const workflowBoardStore = createStore<{
  /** Runs whose cards are on screen. */
  visible: ReadonlySet<string>;
  /** The latest minimap selection. The key lets the same run be selected twice. */
  focus?: { runId: string; key: number };
}>(() => ({ visible: new Set() }));

let focusKey = 0;

export function focusWorkflowCard(runId: string) {
  focusKey += 1;
  workflowBoardStore.setState({ focus: { runId, key: focusKey } });
}

export function setVisibleWorkflowCards(visible: ReadonlySet<string>) {
  workflowBoardStore.setState({ visible });
}
