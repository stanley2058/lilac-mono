import { describe, expect, it } from "bun:test";

import {
  hasSteering,
  initialInputState,
  isEditorDirty,
  reduceInput,
  type InputEffect,
  type InputEvent,
  type InputState,
} from "./input-state";

function run(state: InputState, events: readonly InputEvent[]): InputState {
  return events.reduce((current, event) => reduceInput(current, event).state, state);
}

function effectsOf(state: InputState, event: InputEvent): readonly InputEffect[] {
  return reduceInput(state, event).effects;
}

describe("reduceInput editing", () => {
  it("accepts a managed multiline editor value", () => {
    const state = reduceInput(initialInputState(), {
      type: "set-editor",
      text: "first line\nsecond line",
    }).state;
    expect(state.editor).toBe("first line\nsecond line");
  });

  it("appends inserted text to a dirty editor and reports dirtiness", () => {
    const typed = run(initialInputState(), [
      { type: "insert", text: "he" },
      { type: "insert", text: "llo" },
    ]);
    expect(typed.editor).toBe("hello");
    expect(isEditorDirty(typed)).toBe(true);
    expect(effectsOf(typed, { type: "insert", text: "!" })).toEqual([]);
  });

  it("removes the last character (grapheme-aware) on backspace", () => {
    const typed = run(initialInputState(), [{ type: "insert", text: "a😀" }]);
    const after = reduceInput(typed, { type: "backspace" }).state;
    expect(after.editor).toBe("a");
  });

  it("treats a whitespace-only editor as not dirty", () => {
    const spaced = run(initialInputState(), [{ type: "insert", text: "   " }]);
    expect(isEditorDirty(spaced)).toBe(false);
    expect(effectsOf(spaced, { type: "submit" })).toEqual([]);
  });

  it("removes draft metadata when its atomic placeholder is deleted", () => {
    const withParts = run(initialInputState(), [
      {
        type: "add-file",
        file: {
          id: "image-1",
          placeholder: "[Image 1]",
          start: 0,
          end: 9,
          file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
        },
      },
      {
        type: "add-pasted-text",
        pastedText: {
          id: "paste-1",
          placeholder: "[Pasted ~3 lines]",
          start: 10,
          end: 27,
          text: "one\ntwo\nthree",
        },
      },
    ]);
    const pastedText = withParts.pastedTexts[0]!;
    const retained = reduceInput(withParts, {
      type: "sync-draft-parts",
      files: [],
      pastedTexts: [{ ...pastedText, start: 0, end: 17 }],
    }).state;

    expect(retained.files).toEqual([]);
    expect(retained.pastedTexts.map((part) => part.id)).toEqual(["paste-1"]);

    const deleted = reduceInput(retained, {
      type: "sync-draft-parts",
      files: [],
      pastedTexts: [],
    }).state;
    const restored = reduceInput(deleted, {
      type: "sync-draft-parts",
      files: [],
      pastedTexts: [pastedText],
    }).state;
    expect(restored.pastedTexts).toEqual([pastedText]);
  });
});

describe("reduceInput idle submit", () => {
  it("prompts through the transport on idle Enter with a dirty editor", () => {
    const dirty = run(initialInputState(), [{ type: "insert", text: "  build it  " }]);
    const { state, effects } = reduceInput(dirty, { type: "submit" });
    expect(effects).toEqual([{ type: "prompt", text: "  build it  ", files: [], pastedTexts: [] }]);
    expect(state.editor).toBe("");
    expect(state.phase).toBe("submitting");
  });

  it("does nothing on idle Enter with an empty editor", () => {
    const { state, effects } = reduceInput(initialInputState(), { type: "submit" });
    expect(effects).toEqual([]);
    expect(state).toEqual(initialInputState());
  });

  it("cannot submit a second prompt while the first is submitting", () => {
    const submitting = run(initialInputState(), [
      { type: "insert", text: "first" },
      { type: "submit" },
      { type: "insert", text: "second" },
    ]);
    const transition = reduceInput(submitting, { type: "submit" });
    expect(transition.effects).toEqual([]);
    expect(transition.state.phase).toBe("submitting");
    expect(transition.state.editor).toBe("second");
  });

  it("returns to idle when prompt admission fails", () => {
    const state = run(initialInputState(), [
      { type: "insert", text: "first" },
      { type: "submit" },
      { type: "admission-failed" },
    ]);
    expect(state.phase).toBe("idle");
  });
});

describe("reduceInput active submit", () => {
  it("queues a steer on active Enter with a dirty editor", () => {
    const active = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "focus on tests" },
    ]);
    const { state, effects } = reduceInput(active, { type: "submit" });
    expect(effects).toEqual([
      { type: "steer", text: "focus on tests", files: [], pastedTexts: [] },
    ]);
    expect(state.editor).toBe("");
    expect(state.queuedSteeringCount).toBe(1);
    expect(state.pendingSteeringCount).toBe(1);
    expect(state.confirmedSteeringCount).toBe(0);
  });

  it("serializes multiple steer submissions by appending to the queue", () => {
    let state = run(initialInputState(), [{ type: "agent-started" }]);
    const effects: InputEffect[] = [];
    for (const message of ["first", "second", "third"]) {
      state = run(state, [{ type: "insert", text: message }]);
      const transition = reduceInput(state, { type: "submit" });
      effects.push(...transition.effects);
      state = transition.state;
    }
    expect(effects).toEqual([
      { type: "steer", text: "first", files: [], pastedTexts: [] },
      { type: "steer", text: "second", files: [], pastedTexts: [] },
      { type: "steer", text: "third", files: [], pastedTexts: [] },
    ]);
    expect(state.queuedSteeringCount).toBe(3);
    expect(state.pendingSteeringCount).toBe(3);
  });

  it("interrupts queued steering on active Enter with an empty editor (double submit)", () => {
    // First submit queues a steer, second (empty) submit interrupts it.
    const queued = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "steer once" },
      { type: "submit" },
    ]);
    expect(hasSteering(queued)).toBe(true);

    const { state, effects } = reduceInput(queued, { type: "submit" });
    expect(effects).toEqual([{ type: "interrupt-queued-steering" }]);
    // Queue display is preserved until the server reconciles admissions.
    expect(state.queuedSteeringCount).toBe(1);
  });

  it("does nothing on active Enter with an empty editor when nothing is queued", () => {
    const active = run(initialInputState(), [{ type: "agent-started" }]);
    expect(effectsOf(active, { type: "submit" })).toEqual([]);
  });

  it("reconciles queued steering count from session snapshots", () => {
    const active = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "steer" },
      { type: "submit" },
      { type: "steer-confirmed" },
      { type: "steering-updated", queuedSteeringCount: 0 },
    ]);
    expect(active.queuedSteeringCount).toBe(0);
    expect(active.pendingSteeringCount).toBe(0);
    expect(active.confirmedSteeringCount).toBe(0);
    expect(effectsOf(active, { type: "submit" })).toEqual([]);
  });

  it("preserves confirmed steering when a later optimistic steer fails", () => {
    const queued = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "first" },
      { type: "submit" },
      { type: "insert", text: "second" },
      { type: "submit" },
      { type: "steer-confirmed" },
      { type: "steering-updated", queuedSteeringCount: 1 },
      { type: "steer-failed" },
    ]);
    expect(queued.queuedSteeringCount).toBe(1);
    expect(queued.pendingSteeringCount).toBe(0);
    expect(queued.confirmedSteeringCount).toBe(1);
    expect(effectsOf(queued, { type: "submit" })).toEqual([{ type: "interrupt-queued-steering" }]);

    const consumed = reduceInput(queued, {
      type: "steering-updated",
      queuedSteeringCount: 0,
    }).state;
    expect(consumed.queuedSteeringCount).toBe(0);
  });

  it("does not underflow pending steering on replayed confirmations", () => {
    const active = run(initialInputState(), [
      { type: "agent-started" },
      { type: "steer-confirmed" },
      { type: "steer-confirmed" },
    ]);
    expect(active.pendingSteeringCount).toBe(0);
    expect(active.confirmedSteeringCount).toBe(0);
    expect(active.queuedSteeringCount).toBe(0);
  });
});

describe("reduceInput escape and Ctrl-C", () => {
  it("cancels immediately on active Esc, preserving the draft and staying alive", () => {
    const active = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "steer" },
      { type: "submit" },
      { type: "insert", text: "leftover" },
    ]);
    const { state, effects } = reduceInput(active, { type: "escape" });
    expect(effects).toEqual([{ type: "cancel" }]);
    expect(state.editor).toBe("leftover");
    expect(state.queuedSteeringCount).toBe(0);
    expect(state.pendingSteeringCount).toBe(0);
    expect(state.confirmedSteeringCount).toBe(0);
    expect(state.exited).toBe(false);
    // Phase stays active until the run reports it stopped.
    expect(state.phase).toBe("active");
  });

  it("does nothing on idle Esc", () => {
    const { state, effects } = reduceInput(initialInputState(), { type: "escape" });
    expect(effects).toEqual([]);
    expect(state.exited).toBe(false);
  });

  it("cancels rather than exits on disconnected Esc", () => {
    const disconnected = run(initialInputState(), [
      { type: "agent-started" },
      { type: "disconnected" },
      { type: "insert", text: "not sent" },
    ]);
    expect(effectsOf(disconnected, { type: "submit" })).toEqual([]);
    const { state, effects } = reduceInput(disconnected, { type: "escape" });
    expect(effects).toEqual([{ type: "cancel" }]);
    expect(state.exited).toBe(false);
    expect(state.editor).toBe("not sent");
  });

  it("never exits from Esc after the agent stops", () => {
    const cancelled = run(initialInputState(), [
      { type: "agent-started" },
      { type: "escape" },
      { type: "agent-stopped" },
    ]);
    expect(cancelled.phase).toBe("idle");
    expect(effectsOf(cancelled, { type: "escape" })).toEqual([]);
  });

  it("clears text and attachments on first Ctrl-C, then exits on the second", () => {
    const file = {
      id: "image-1",
      placeholder: "[Image 1]",
      start: 0,
      end: 9,
      file: {
        type: "file" as const,
        mediaType: "image/png",
        filename: "clipboard.png",
        url: "data:image/png;base64,AA==",
      },
    };
    const dirty = run(initialInputState(), [
      { type: "insert", text: "draft" },
      { type: "add-file", file },
    ]);
    const first = reduceInput(dirty, { type: "ctrl-c" });
    expect(first.effects).toEqual([]);
    expect(first.state.editor).toBe("");
    expect(first.state.files).toEqual([]);
    expect(first.state.exitArmed).toBe(true);

    const second = reduceInput(first.state, { type: "ctrl-c" });
    expect(second.effects).toEqual([{ type: "exit" }]);
    expect(second.state.exited).toBe(true);
  });

  it("disarms exit when the user edits after Ctrl-C", () => {
    const armed = reduceInput(initialInputState(), { type: "ctrl-c" }).state;
    const edited = reduceInput(armed, { type: "insert", text: "new draft" }).state;
    expect(edited.exitArmed).toBe(false);
    expect(effectsOf(edited, { type: "ctrl-c" })).toEqual([]);
  });

  it("detaches rather than server-cancelling when Ctrl-C exits an active run", () => {
    const active = run(initialInputState(), [{ type: "agent-started" }]);
    const first = reduceInput(active, { type: "ctrl-c" });
    expect(first.effects).toEqual([]);
    expect(first.state.phase).toBe("active");

    const second = reduceInput(first.state, { type: "ctrl-c" });
    expect(second.effects).toEqual([{ type: "exit" }]);
    expect(second.effects).not.toContainEqual({ type: "cancel" });
  });
});

describe("reduceInput slash commands and files", () => {
  it("dispatches idle /undo without sending it to the model", () => {
    const state = run(initialInputState(), [{ type: "insert", text: "/undo" }]);
    const transition = reduceInput(state, { type: "submit" });
    expect(transition.effects).toEqual([{ type: "undo" }]);
    expect(transition.state.phase).toBe("submitting");
  });

  it("dispatches attachment-free idle /compact without sending it to the model", () => {
    const state = run(initialInputState(), [{ type: "insert", text: "/compact" }]);
    const transition = reduceInput(state, { type: "submit" });
    expect(transition.effects).toEqual([{ type: "compact" }]);
    expect(transition.state.editor).toBe("");
    expect(transition.state.phase).toBe("submitting");
  });

  it("never steers typed /compact during active work", () => {
    const active = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "/compact" },
    ]);
    const transition = reduceInput(active, { type: "submit" });
    expect(transition.effects).toEqual([]);
    expect(transition.state.editor).toBe("/compact");
    expect(transition.state.phase).toBe("active");
  });

  it("does not admit or prompt typed compaction with an attachment", () => {
    const state = run(initialInputState(), [
      { type: "insert", text: "/compact" },
      {
        type: "add-file",
        file: {
          id: "image-1",
          placeholder: "[Image 1]",
          start: 0,
          end: 9,
          file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
        },
      },
    ]);
    expect(effectsOf(state, { type: "request-compact" })).toEqual([]);
    const transition = reduceInput(state, { type: "submit" });
    expect(transition.effects).toEqual([]);
    expect(transition.state.editor).toBe("/compact");
    expect(transition.state.files).toHaveLength(1);
  });

  it("accepts an image-only prompt", () => {
    const file = {
      id: "image-1",
      placeholder: "[Image 1]",
      start: 0,
      end: 9,
      file: {
        type: "file" as const,
        mediaType: "image/png",
        url: "data:image/png;base64,AA==",
      },
    };
    const state = run(initialInputState(), [{ type: "add-file", file }]);
    const transition = reduceInput(state, { type: "submit" });
    expect(transition.effects).toEqual([
      { type: "prompt", text: "", files: [file], pastedTexts: [] },
    ]);
    expect(transition.state.files).toEqual([]);
  });
});

describe("reduceInput lifecycle", () => {
  it("resets queued steering when a fresh run starts", () => {
    const restarted = run(initialInputState(), [
      { type: "agent-started" },
      { type: "insert", text: "pending" },
      { type: "submit" },
      { type: "steering-updated", queuedSteeringCount: 4 },
      { type: "agent-stopped" },
      { type: "agent-started" },
    ]);
    expect(restarted.phase).toBe("active");
    expect(restarted.queuedSteeringCount).toBe(0);
    expect(restarted.pendingSteeringCount).toBe(0);
    expect(restarted.confirmedSteeringCount).toBe(0);
  });
});
