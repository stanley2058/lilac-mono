import type { CommandOutcome } from "@stanley2058/lilac-client";
import type { NativeInput, NativeInputReceipt } from "@stanley2058/lilac-client-protocol";
import type { ComposerSubmission } from "./types";

export type PendingInput = {
  commandId: string;
  text: string;
  /** When the person sent it, so the optimistic turn groups and times like the confirmed one. */
  createdAt: number;
  submission: ComposerSubmission;
  input?: NativeInput;
  error?: string;
  optimisticSlotIds?: readonly string[];
  receipt?: NativeInputReceipt;
  /** The question this answered closed first, so a retry sends a regular message. */
  questionClosed?: boolean;
  state: "preparing" | "uncertain" | "rejected" | "accepted";
};

export async function deliverPendingInput(
  entry: PendingInput,
  prepare: () => Promise<NativeInput | undefined>,
  submit: (input: NativeInput) => Promise<CommandOutcome>,
  update: (patch: Partial<PendingInput> | null) => void,
  editable: boolean,
): Promise<CommandOutcome | undefined> {
  if (!editable) {
    update({
      state: entry.state === "uncertain" ? "uncertain" : "rejected",
      error: "You no longer have permission to send to this conversation.",
    });
    return;
  }
  update({ state: "preparing", error: undefined });
  const retained = entry.state === "uncertain" ? entry.input : undefined;
  const input = retained ?? (await prepare());
  if (!input) return;
  update({ input });
  const outcome = await submit(input);
  switch (outcome.kind) {
    case "accepted":
      update(
        entry.optimisticSlotIds && input.mode === "prompt" && outcome.receipt.turnId
          ? { state: "accepted", receipt: outcome.receipt }
          : null,
      );
      return outcome;
    case "uncertain":
      update({ state: "uncertain", error: "Send not confirmed. Retry safely when connected." });
      return outcome;
    case "rejected":
      update({ input: undefined, state: "rejected", error: outcome.error.message });
      return outcome;
  }
}

/** Returns a new map so React sees the change; `null` drops the thread's entries. */
export function patchPendingInputs(
  inputs: ReadonlyMap<string, PendingInput[]>,
  threadId: string,
  update: ((entries: PendingInput[]) => PendingInput[]) | null,
): Map<string, PendingInput[]> {
  const changed = new Map(inputs);
  if (update) changed.set(threadId, update(changed.get(threadId) ?? []));
  else changed.delete(threadId);
  return changed;
}
