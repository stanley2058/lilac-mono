import { expect, test } from "bun:test";
import type { CommandOutcome } from "@stanley2058/lilac-client";
import type { NativeInput } from "@stanley2058/lilac-client-protocol";
import { deliverPendingInput, patchPendingInputs, type PendingInput } from "../src/pending-input";
import { inputDeliveryOptions } from "../src/input-mode";

function fixture() {
  let entry: PendingInput = {
    commandId: "command",
    text: "Original message",
    createdAt: 1,
    submission: {
      text: "Original message",
      mode: "steer",
      modelId: "model",
      skillIds: ["skill"],
      attachments: [],
    },
    state: "preparing",
  };
  let removed = false;
  const state = { historyGeneration: 0, active: false, editable: true };
  const sent: NativeInput[] = [];
  const outcomes: CommandOutcome[] = [];
  let preparations = 0;
  const prepare = async (): Promise<NativeInput> => {
    preparations++;
    return {
      threadId: "thread",
      commandId: entry.commandId,
      historyGeneration: state.historyGeneration,
      text: entry.text,
      ...inputDeliveryOptions(
        state.active,
        entry.submission.mode,
        entry.submission.modelId,
        !!entry.submission.command,
      ),
      attachmentIds: ["attachment"],
      skillIds: entry.submission.skillIds,
      command: entry.submission.command,
    };
  };
  const send = () =>
    deliverPendingInput(
      entry,
      prepare,
      async (input) => {
        sent.push(input);
        return outcomes.shift()!;
      },
      (patch) => {
        if (patch) entry = { ...entry, ...patch };
        else removed = true;
      },
      state.editable,
    );
  return {
    state,
    sent,
    outcomes,
    send,
    entry: () => entry,
    preparations: () => preparations,
    removed: () => removed,
  };
}

const rejected: CommandOutcome = {
  kind: "rejected",
  error: { kind: "conflict", message: "Thread changed" },
};
const accepted: CommandOutcome = {
  kind: "accepted",
  receipt: { inputId: "input", messageId: "message", state: "queued" },
};

test("a definitive rejection rebuilds generation and delivery mode on retry", async () => {
  const f = fixture();
  f.outcomes.push(rejected, accepted);
  await f.send();
  expect(f.entry()).toMatchObject({ state: "rejected", error: "Thread changed", input: undefined });
  f.state.historyGeneration = 4;
  f.state.active = true;
  await f.send();
  expect(f.sent[0]).toMatchObject({ historyGeneration: 0, mode: "prompt", modelId: "model" });
  expect(f.sent[1]).toMatchObject({
    historyGeneration: 4,
    mode: "steer",
    modelId: undefined,
    commandId: "command",
    attachmentIds: ["attachment"],
    skillIds: ["skill"],
    text: "Original message",
  });
  expect(f.preparations()).toBe(2);
  expect(f.removed()).toBe(true);
});

test("uncertain delivery retries the exact payload until a definitive outcome", async () => {
  const f = fixture();
  f.outcomes.push({ kind: "uncertain", commandId: "command" }, rejected, accepted);
  await f.send();
  expect(f.entry().state).toBe("uncertain");
  f.state.historyGeneration = 4;
  f.state.active = true;
  await f.send();
  expect(f.sent[1]).toBe(f.sent[0]);
  expect(f.preparations()).toBe(1);
  expect(f.entry().input).toBeUndefined();
  await f.send();
  expect(f.sent[2]).toMatchObject({ historyGeneration: 4, mode: "steer" });
  expect(f.preparations()).toBe(2);
});

test("a rejected first-send handoff discards its retained stale payload", async () => {
  const f = fixture();
  f.entry().state = "rejected";
  f.entry().input = {
    threadId: "thread",
    commandId: "command",
    historyGeneration: 0,
    text: "Original message",
    mode: "prompt",
    attachmentIds: ["attachment"],
    skillIds: ["skill"],
  };
  f.state.historyGeneration = 4;
  f.state.active = true;
  f.outcomes.push(accepted);
  await f.send();
  expect(f.sent[0]).toMatchObject({ historyGeneration: 4, mode: "steer" });
  expect(f.preparations()).toBe(1);
  expect(f.removed()).toBe(true);
});

test("lost edit access settles a preparing message and allows retry after restoration", async () => {
  const f = fixture();
  f.state.editable = false;
  await f.send();
  expect(f.entry().state).toBe("rejected");
  expect(f.entry().error).toContain("permission");
  expect(f.preparations()).toBe(0);
  expect(f.sent).toEqual([]);
  f.state.editable = true;
  f.outcomes.push(accepted);
  await f.send();
  expect(f.sent).toHaveLength(1);
  expect(f.removed()).toBe(true);
});

test("losing permission does not turn an uncertain send into a new payload", async () => {
  const f = fixture();
  f.outcomes.push({ kind: "uncertain", commandId: "command" }, accepted);
  await f.send();
  f.state.editable = false;
  await f.send();
  expect(f.entry().state).toBe("uncertain");
  expect(f.entry().error).toContain("permission");
  expect(f.sent).toHaveLength(1);
  f.state.historyGeneration = 4;
  f.state.active = true;
  f.state.editable = true;
  await f.send();
  expect(f.sent[1]).toBe(f.sent[0]);
  expect(f.preparations()).toBe(1);
  expect(f.removed()).toBe(true);
});

test("accepted optimistic prompts remain until their server turn is rendered", async () => {
  const f = fixture();
  f.entry().optimisticSlotIds = [];
  f.outcomes.push({ ...accepted, receipt: { ...accepted.receipt, turnId: "turn" } });
  await f.send();
  expect(f.removed()).toBe(false);
  expect(f.entry()).toMatchObject({
    state: "accepted",
    receipt: { messageId: "message", turnId: "turn" },
  });
});

test("a retry delivered as steering does not retain an optimistic turn", async () => {
  const f = fixture();
  f.entry().optimisticSlotIds = [];
  f.state.active = true;
  f.outcomes.push({ ...accepted, receipt: { ...accepted.receipt, turnId: "active-turn" } });
  await f.send();
  expect(f.removed()).toBe(true);
});

test("patching pending inputs returns a new map and leaves the rendered one intact", () => {
  const entry = fixture().entry();
  const rendered = new Map([
    ["thread", [entry]],
    ["other", [entry]],
  ]);
  const removed = patchPendingInputs(rendered, "thread", null);
  expect(removed).not.toBe(rendered);
  expect([...removed.keys()]).toEqual(["other"]);
  expect(rendered.get("thread")).toEqual([entry]);
  const appended = patchPendingInputs(rendered, "new", (entries) => [...entries, entry]);
  expect(appended.get("new")).toEqual([entry]);
  expect(rendered.has("new")).toBe(false);
});
