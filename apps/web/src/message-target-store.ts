import { createStore } from "zustand/vanilla";

export type WorkflowCardLocation = { position: number; messageId: string };

/** A one-shot request for a thread's timeline to open at a workflow card instead of its end. */
export const messageTargetStore = createStore<{
  target?: { threadId: string } & WorkflowCardLocation;
}>(() => ({}));

export function openThreadAtWorkflowCard(threadId: string, source: WorkflowCardLocation) {
  messageTargetStore.setState({ target: { threadId, ...source } });
}

export function clearMessageTarget() {
  messageTargetStore.setState({ target: undefined });
}
