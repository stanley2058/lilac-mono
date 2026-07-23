import type { MiniLilacUserUIMessage } from "@stanley2058/mini-lilac-client";

type FileUIPart = Extract<MiniLilacUserUIMessage["parts"][number], { type: "file" }>;

export interface DraftFile {
  readonly id: string;
  readonly placeholder: string;
  readonly start: number;
  readonly end: number;
  readonly file: FileUIPart;
}

export interface DraftPastedText {
  readonly id: string;
  readonly placeholder: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Pure input state reducer for the mini-lilac terminal client.
 *
 * The reducer owns exactly the keyboard-driven state machine described by the
 * interactive spec. Side effects (network calls and UI lifecycle) are expressed
 * as declarative {@link InputEffect} values so the orchestrator can execute them
 * while this module stays deterministic and fully unit-testable.
 */

export type EditorPhase = "idle" | "submitting" | "active" | "disconnected";

export interface InputState {
  /** Current multiline editor buffer. */
  readonly editor: string;
  /** Images and other file parts waiting to be submitted with the editor. */
  readonly files: readonly DraftFile[];
  /** Large pasted text represented by atomic placeholders in the editor. */
  readonly pastedTexts: readonly DraftPastedText[];
  /** Current transport/run lifecycle. */
  readonly phase: EditorPhase;
  /** Total locally pending and server-confirmed steering for the active run. */
  readonly queuedSteeringCount: number;
  /** Steering submissions that have not yet been confirmed by the stream. */
  readonly pendingSteeringCount: number;
  /** Queued steering reported by the latest server session snapshot. */
  readonly confirmedSteeringCount: number;
  /** Set once the user requested to leave the program from an idle prompt. */
  readonly exited: boolean;
  /** First Ctrl-C clears the draft and arms the second Ctrl-C to exit. */
  readonly exitArmed: boolean;
}

export type InputEvent =
  | { readonly type: "set-editor"; readonly text: string }
  | { readonly type: "add-file"; readonly file: DraftFile }
  | { readonly type: "add-pasted-text"; readonly pastedText: DraftPastedText }
  | {
      readonly type: "sync-draft-parts";
      readonly files: readonly DraftFile[];
      readonly pastedTexts: readonly DraftPastedText[];
    }
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "submit" }
  | { readonly type: "request-undo" }
  | { readonly type: "request-compact" }
  | { readonly type: "escape" }
  | { readonly type: "ctrl-c" }
  | {
      readonly type: "draft-restored";
      readonly text: string;
      readonly files: readonly DraftFile[];
      readonly pastedTexts?: readonly DraftPastedText[];
      readonly finishOperation?: boolean;
    }
  | { readonly type: "operation-failed" }
  | { readonly type: "operation-started" }
  | { readonly type: "operation-completed" }
  | { readonly type: "agent-started" }
  | { readonly type: "admission-failed" }
  | { readonly type: "agent-stopped" }
  | { readonly type: "disconnected" }
  | { readonly type: "steer-failed" }
  | { readonly type: "steer-confirmed" }
  | { readonly type: "steering-updated"; readonly queuedSteeringCount: number };

export type InputEffect =
  | {
      readonly type: "prompt";
      readonly text: string;
      readonly files: readonly DraftFile[];
      readonly pastedTexts: readonly DraftPastedText[];
    }
  | {
      readonly type: "steer";
      readonly text: string;
      readonly files: readonly DraftFile[];
      readonly pastedTexts: readonly DraftPastedText[];
    }
  | { readonly type: "undo" }
  | { readonly type: "compact" }
  | { readonly type: "interrupt-queued-steering" }
  | { readonly type: "cancel" }
  | { readonly type: "exit" };

export interface InputTransition {
  readonly state: InputState;
  readonly effects: readonly InputEffect[];
}

export function initialInputState(): InputState {
  return {
    editor: "",
    files: [],
    pastedTexts: [],
    phase: "idle",
    queuedSteeringCount: 0,
    pendingSteeringCount: 0,
    confirmedSteeringCount: 0,
    exited: false,
    exitArmed: false,
  };
}

/** An editor is "dirty" when it holds submittable (non-whitespace) content. */
export function isEditorDirty(state: InputState): boolean {
  return state.editor.trim().length > 0 || state.files.length > 0;
}

/** True when there is any queued or in-flight steering that could be interrupted. */
export function hasSteering(state: InputState): boolean {
  return state.queuedSteeringCount > 0;
}

export function reduceInput(state: InputState, event: InputEvent): InputTransition {
  switch (event.type) {
    case "set-editor":
      return commit({
        ...state,
        editor: event.text,
        exitArmed: event.text === state.editor ? state.exitArmed : false,
      });
    case "add-file":
      return commit({ ...state, files: [...state.files, event.file], exitArmed: false });
    case "add-pasted-text":
      return commit({
        ...state,
        pastedTexts: [...state.pastedTexts, event.pastedText],
        exitArmed: false,
      });
    case "sync-draft-parts":
      return commit({
        ...state,
        files: event.files,
        pastedTexts: event.pastedTexts,
      });
    case "insert":
      return commit({ ...state, editor: state.editor + event.text, exitArmed: false });
    case "backspace":
      return commit({ ...state, editor: dropLastCharacter(state.editor), exitArmed: false });
    case "submit":
      return onSubmit(state);
    case "request-undo":
      if (state.phase !== "idle") return commit(state);
      return commit({ ...state, phase: "submitting" }, { type: "undo" });
    case "request-compact":
      if (state.phase !== "idle" || state.files.length > 0 || state.pastedTexts.length > 0) {
        return commit(state);
      }
      return commit({ ...state, phase: "submitting" }, { type: "compact" });
    case "escape":
      return onEscape(state);
    case "ctrl-c":
      return onCtrlC(state);
    case "draft-restored":
      return commit({
        ...state,
        editor: event.text,
        files: event.files,
        pastedTexts: event.pastedTexts ?? [],
        phase: event.finishOperation === true ? "idle" : state.phase,
        exitArmed: false,
      });
    case "operation-failed":
      return commit({ ...state, phase: "idle", exitArmed: false });
    case "operation-started":
      return commit({ ...state, phase: "submitting", exitArmed: false });
    case "operation-completed":
      return commit({ ...state, phase: "idle", exitArmed: false });
    case "agent-started":
      return commit(resetSteering({ ...state, phase: "active" }));
    case "admission-failed":
      return commit(resetSteering({ ...state, phase: "idle" }));
    case "agent-stopped":
      return commit(resetSteering({ ...state, phase: "idle" }));
    case "disconnected":
      return commit({ ...state, phase: "disconnected" });
    case "steer-failed":
      return commit(
        withSteering(state, state.pendingSteeringCount - 1, state.confirmedSteeringCount),
      );
    case "steer-confirmed":
      if (state.pendingSteeringCount === 0) return commit(state);
      return commit(
        withSteering(state, state.pendingSteeringCount - 1, state.confirmedSteeringCount + 1),
      );
    case "steering-updated":
      return commit(withSteering(state, state.pendingSteeringCount, event.queuedSteeringCount));
  }
}

function onSubmit(state: InputState): InputTransition {
  const text = state.editor;
  const trimmedText = text.trim();
  const dirty = trimmedText.length > 0 || state.files.length > 0;
  const slash = trimmedText.toLowerCase();

  if (state.phase === "idle") {
    // Idle Enter with an empty editor is a no-op; a dirty editor starts a prompt.
    if (!dirty) return commit(state);
    if (state.files.length === 0 && (slash === "/undo" || slash === "/rollback")) {
      return commit(
        { ...state, editor: "", phase: "submitting", exitArmed: false },
        { type: "undo" },
      );
    }
    if (slash === "/compact") {
      if (state.files.length > 0 || state.pastedTexts.length > 0) return commit(state);
      return commit(
        { ...state, editor: "", phase: "submitting", exitArmed: false },
        { type: "compact" },
      );
    }
    return commit(
      {
        ...state,
        editor: "",
        files: [],
        pastedTexts: [],
        phase: "submitting",
        exitArmed: false,
      },
      { type: "prompt", text, files: state.files, pastedTexts: state.pastedTexts },
    );
  }

  // A prompt admission is already in flight, or the stream is disconnected.
  // Keep accepting editor input, but never submit another prompt or steer.
  if (state.phase !== "active") return commit(state);

  // Session commands mutate canonical history and are never steering messages.
  if (
    slash === "/compact" ||
    (state.files.length === 0 && (slash === "/undo" || slash === "/rollback"))
  ) {
    return commit(state);
  }

  // Active run: a dirty editor queues a steer (multiple submits append to the queue).
  if (dirty) {
    return commit(
      withSteering(
        { ...state, editor: "", files: [], pastedTexts: [], exitArmed: false },
        state.pendingSteeringCount + 1,
        state.confirmedSteeringCount,
      ),
      { type: "steer", text, files: state.files, pastedTexts: state.pastedTexts },
    );
  }

  // Active run with an empty editor while steering is queued/pending interrupts it.
  if (state.queuedSteeringCount > 0) {
    return commit(state, { type: "interrupt-queued-steering" });
  }

  return commit(state);
}

function onEscape(state: InputState): InputTransition {
  if (state.phase !== "idle") {
    // Esc only interrupts server work. The current draft remains available.
    return commit(resetSteering({ ...state, exitArmed: false }), { type: "cancel" });
  }
  return commit({ ...state, exitArmed: false });
}

function onCtrlC(state: InputState): InputTransition {
  if (state.exitArmed) {
    return commit({ ...state, exited: true }, { type: "exit" });
  }
  return commit({ ...state, editor: "", files: [], pastedTexts: [], exitArmed: true });
}

function withSteering(state: InputState, pending: number, confirmed: number): InputState {
  const pendingSteeringCount = Math.max(0, pending);
  const confirmedSteeringCount = Math.max(0, confirmed);
  return {
    ...state,
    pendingSteeringCount,
    confirmedSteeringCount,
    queuedSteeringCount: pendingSteeringCount + confirmedSteeringCount,
  };
}

function resetSteering(state: InputState): InputState {
  return withSteering(state, 0, 0);
}

function commit(state: InputState, ...effects: readonly InputEffect[]): InputTransition {
  return { state, effects };
}

function dropLastCharacter(value: string): string {
  const characters = Array.from(value);
  characters.pop();
  return characters.join("");
}

export function editorOffsetWidth(value: string): number {
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const part of graphemes.segment(value)) {
    width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment);
  }
  return width;
}

export function editorOffsetIndex(value: string, offset: number): number {
  if (offset <= 0) return 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const part of graphemes.segment(value)) {
    const next = width + editorOffsetWidth(part.segment);
    if (next > offset) return part.index;
    width = next;
  }
  return value.length;
}
