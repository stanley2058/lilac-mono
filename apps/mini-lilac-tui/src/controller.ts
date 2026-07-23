import type { UIMessageChunk } from "ai";

import {
  miniLilacStreamCursorChunkSchema,
  type MiniLilacControlResult,
  type MiniLilacReasoning,
  type MiniLilacSessionSnapshot,
  type MiniLilacTodoState,
  type MiniLilacTranscriptReset,
  type MiniLilacTransport,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import {
  editorOffsetIndex,
  editorOffsetWidth,
  initialInputState,
  reduceInput,
  type DraftFile,
  type DraftPastedText,
  type InputEffect,
  type InputEvent,
  type InputState,
} from "./input-state";
import { ChunkRenderer, renderInitialMessages, type TranscriptEntry } from "./render";
import { sessionPresentation, type SessionPresentation } from "./presentation";

export interface ControllerUISink {
  onState(state: InputState): void;
  onOutput(entries: readonly TranscriptEntry[]): void;
  onTodos?(todos: MiniLilacTodoState): void;
  onBindings?(bindings: SessionBindings): void;
  onSession?(session: SessionPresentation): void;
}

export interface SessionBindings {
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly reasoning: MiniLilacReasoning | undefined;
}

export type SessionBindingUpdate =
  | { readonly model: string; readonly profile?: string; readonly reasoning?: MiniLilacReasoning }
  | { readonly model?: string; readonly profile: string; readonly reasoning?: MiniLilacReasoning }
  | { readonly model?: string; readonly profile?: string; readonly reasoning: MiniLilacReasoning };

export interface ControllerOptions {
  readonly transport: MiniLilacTransport;
  readonly ui: ControllerUISink;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly initialSnapshot?: MiniLilacSessionSnapshot;
  readonly initialMessages?: readonly MiniLilacUIMessage[];
  readonly initialTodos?: MiniLilacTodoState;
  readonly initialBindings?: SessionBindings;
  readonly reconnectDelay?: (attempt: number) => Promise<void>;
  readonly onExit: () => void;
}

type StreamOutcome = "completed" | "disconnected" | "disposed" | "superseded";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wires semantic UI events, the input-state reducer, and the mini-lilac
 * transport into an interactive session. It has no terminal dependencies.
 */
export class Controller {
  private state: InputState = initialInputState();
  private readonly renderer: ChunkRenderer;
  private messages: MiniLilacUIMessage[];
  private output: TranscriptEntry[];
  private outputSequence = 0;
  private steerChain: Promise<void> = Promise.resolve();
  private promptAdmission: Promise<string | undefined>;
  private resolvePromptAdmission: ((runId: string | undefined) => void) | undefined;
  private activeRunId: string | undefined;
  private activeReader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
  private pendingUndoCommandId: string | undefined;
  private bindings: SessionBindings;
  private presentation: SessionPresentation;
  private todos: MiniLilacTodoState;
  private sessionExists: boolean;
  private readonly abortController = new AbortController();
  private runOutputBaseline: number;
  private runMessageBaseline: number;
  private runGeneration = 0;
  private disposed = false;

  constructor(private readonly options: ControllerOptions) {
    this.activeRunId = options.initialSnapshot?.activeRunId ?? undefined;
    this.sessionExists =
      options.initialSnapshot !== undefined || (options.initialMessages?.length ?? 0) > 0;
    this.bindings =
      options.initialSnapshot === undefined
        ? (options.initialBindings ?? {
            model: undefined,
            profile: undefined,
            reasoning: undefined,
          })
        : {
            model: options.initialSnapshot.model ?? undefined,
            profile: options.initialSnapshot.profile ?? undefined,
            reasoning: options.initialSnapshot.reasoning ?? undefined,
          };
    this.presentation = sessionPresentation(options.initialSnapshot);
    this.todos = options.initialTodos ?? { revision: 0, todos: [] };
    this.promptAdmission = Promise.resolve(this.activeRunId);
    this.messages = [...(options.initialMessages ?? [])];
    this.output = this.renderMessages();
    this.runOutputBaseline = this.output.length;
    this.runMessageBaseline = this.messages.length;
    if (
      options.initialSnapshot?.status === "streaming" ||
      options.initialSnapshot?.status === "cancelling"
    ) {
      this.state = reduceInput(this.state, { type: "agent-started" }).state;
      this.state = reduceInput(this.state, {
        type: "steering-updated",
        queuedSteeringCount: options.initialSnapshot.queuedSteeringCount,
      }).state;
    }
    this.renderer = new ChunkRenderer(
      {
        append: (entry) => this.appendOutput(entry),
        update: (id, entry) => this.updateOutput(id, entry),
        appendText: (id, delta) => this.appendOutputText(id, delta),
        finish: (id) => this.finishOutput(id),
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onControl: (result) => this.onControl(result),
        onTodos: (todos) => this.onTodos(todos),
        onTranscriptReset: (reset) => this.onTranscriptReset(reset),
      },
      { cwd: options.cwd ?? options.initialSnapshot?.cwd },
    );
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** Publish initial state/output and reconnect a resumed active session. */
  start(): void {
    this.notifyState();
    this.notifyOutput();
    this.options.ui.onTodos?.(this.todos);
    this.options.ui.onBindings?.(this.bindings);
    this.options.ui.onSession?.(this.presentation);
    if (this.state.phase === "active") void this.resumeActiveSession();
  }

  /** Replace the editor value from a managed textarea. */
  setEditor(text: string): void {
    this.dispatch({ type: "set-editor", text });
  }

  /** Apply Enter semantics to the current editor and lifecycle state. */
  submit(): void {
    this.dispatch({ type: "submit" });
  }

  undo(): void {
    this.dispatch({ type: "request-undo" });
  }

  compact(): void {
    this.dispatch({ type: "request-compact" });
  }

  async updateSessionBindings(update: SessionBindingUpdate): Promise<boolean> {
    if (this.state.phase !== "idle") return false;
    this.dispatch({ type: "operation-started" });
    try {
      if (!this.sessionExists) {
        this.options.transport.setSessionBindings(update);
        this.bindings = { ...this.bindings, ...update };
        this.options.ui.onBindings?.(this.bindings);
      } else {
        const clientCommandId = crypto.randomUUID();
        let snapshot: MiniLilacSessionSnapshot;
        try {
          snapshot = await this.options.transport.updateSessionBindings(
            { sessionId: this.sessionId, clientCommandId, ...update },
            { signal: this.abortController.signal },
          );
        } catch {
          snapshot = await this.options.transport.updateSessionBindings(
            { sessionId: this.sessionId, clientCommandId, ...update },
            { signal: this.abortController.signal },
          );
        }
        if (this.disposed) return false;
        this.acceptSnapshot(snapshot);
      }
      this.dispatch({ type: "operation-completed" });
      return true;
    } catch (error) {
      if (this.disposed) return false;
      const recovered = await this.reconcileSessionBindings();
      if (recovered !== undefined && sessionBindingUpdateMatches(recovered, update)) {
        this.dispatch({ type: "operation-completed" });
        return true;
      }
      this.dispatch({ type: "operation-failed" });
      this.commitError(error);
      return false;
    }
  }

  private async reconcileSessionBindings(): Promise<MiniLilacSessionSnapshot | undefined> {
    try {
      const snapshot = await this.options.transport.getSession(this.sessionId, {
        signal: this.abortController.signal,
      });
      if (this.disposed) return undefined;
      this.options.transport.setSessionBindings({
        model: snapshot.model ?? undefined,
        profile: snapshot.profile ?? undefined,
        reasoning: snapshot.reasoning ?? undefined,
      });
      this.acceptSnapshot(snapshot);
      return snapshot;
    } catch {
      return undefined;
    }
  }

  /** Esc interrupts server work and never exits the program. */
  escape(): void {
    this.dispatch({ type: "escape" });
  }

  /** First Ctrl-C clears the draft; a second consecutive Ctrl-C exits. */
  ctrlC(): void {
    this.dispatch({ type: "ctrl-c" });
  }

  addFile(file: DraftFile): void {
    this.dispatch({ type: "add-file", file });
  }

  addPastedText(pastedText: DraftPastedText): void {
    this.dispatch({ type: "add-pasted-text", pastedText });
  }

  syncDraftParts(files: readonly DraftFile[], pastedTexts: readonly DraftPastedText[]): void {
    this.dispatch({ type: "sync-draft-parts", files, pastedTexts });
  }

  /** Stop local stream consumption when the UI renderer is destroyed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    const reader = this.activeReader;
    this.activeReader = undefined;
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
  }

  /** Current state exposed for focused integration tests and status adapters. */
  get inputState(): InputState {
    return this.state;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.output;
  }

  private dispatch(event: InputEvent): void {
    const { state, effects } = reduceInput(this.state, event);
    this.state = state;
    this.notifyState();
    for (const effect of effects) this.execute(effect);
  }

  private execute(effect: InputEffect): void {
    switch (effect.type) {
      case "prompt":
        void this.runPrompt(effect.text, effect.files, effect.pastedTexts);
        return;
      case "steer":
        this.enqueueSteer(effect.text, effect.files, effect.pastedTexts);
        return;
      case "undo":
        void this.runUndo();
        return;
      case "compact":
        void this.runCompact();
        return;
      case "interrupt-queued-steering":
        this.enqueueInterrupt();
        return;
      case "cancel":
        this.enqueueCancel();
        return;
      case "exit":
        this.options.onExit();
        return;
    }
  }

  private async runPrompt(
    draftText: string,
    files: readonly DraftFile[],
    pastedTexts: readonly DraftPastedText[],
  ): Promise<void> {
    // A newly admitted turn supersedes any undo whose response remained uncertain.
    this.pendingUndoCommandId = undefined;
    const generation = this.nextRunGeneration();
    let resolveAdmission: (runId: string | undefined) => void = () => {};
    const text = expandDraftText(draftText, files, pastedTexts);
    const message: MiniLilacUserUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: userParts(text, files),
    };
    this.messages.push(message);
    const outputIds = this.appendUserOutput(text, files);
    this.runMessageBaseline = this.messages.length;
    this.runOutputBaseline = this.output.length;

    this.activeRunId = undefined;
    this.promptAdmission = new Promise<string | undefined>((resolve) => {
      resolveAdmission = resolve;
      this.resolvePromptAdmission = resolveAdmission;
    });
    // Become active synchronously before awaiting HTTP admission. This closes
    // the rapid-submit race; steering still waits on promptAdmission below.
    this.dispatch({ type: "agent-started" });

    let stream: ReadableStream<UIMessageChunk>;
    try {
      stream = await this.options.transport.sendMessages({
        trigger: "submit-message",
        chatId: this.sessionId,
        messageId: undefined,
        messages: [...this.messages],
        abortSignal: this.abortController.signal,
      });
    } catch (error) {
      const recovery = await this.recoverSessionAfterAmbiguousAdmission();
      if (!this.isCurrentRun(generation)) return;

      if (
        recovery.kind === "session" &&
        recovery.snapshot.activeRunId !== null &&
        recovery.snapshot.activeRunId !== undefined
      ) {
        const runId = recovery.snapshot.activeRunId;
        resolveAdmission(runId);
        this.resolvePromptAdmission = undefined;
        this.promptAdmission = Promise.resolve(runId);
        this.activeRunId = runId;
        if (recovery.messages !== undefined) this.replaceMessages(recovery.messages);
        this.runMessageBaseline = this.messages.length;
        this.runOutputBaseline = this.output.length;
        this.beginRun();
        await this.reconnectRun(generation);
        return;
      }

      if (
        recovery.kind === "session" &&
        recovery.messages?.some((candidate) => candidate.id === message.id)
      ) {
        resolveAdmission(undefined);
        this.resolvePromptAdmission = undefined;
        this.replaceMessages(recovery.messages);
        this.activeRunId = undefined;
        this.dispatch({ type: "agent-stopped" });
        return;
      }

      if (
        recovery.kind === "unknown" ||
        (recovery.kind === "session" && recovery.messages === undefined)
      ) {
        resolveAdmission(undefined);
        if (this.resolvePromptAdmission === resolveAdmission) {
          this.resolvePromptAdmission = undefined;
        }
        this.dispatch({ type: "disconnected" });
        this.commitError("prompt admission outcome is unknown; resume this session to reconcile");
        return;
      }

      resolveAdmission(undefined);
      if (this.resolvePromptAdmission === resolveAdmission) this.resolvePromptAdmission = undefined;
      this.messages = this.messages.filter((candidate) => candidate.id !== message.id);
      outputIds.forEach((id) => this.removeOutput(id));
      this.runMessageBaseline = this.messages.length;
      this.runOutputBaseline = this.output.length;
      this.dispatch({ type: "admission-failed" });
      this.restoreSubmittedDraft(draftText, files, pastedTexts, false, true);
      this.commitError(error);
      return;
    }

    if (!this.isCurrentRun(generation)) {
      resolveAdmission(undefined);
      await stream.cancel().catch(() => undefined);
      return;
    }
    this.beginRun();

    const outcome = await this.driveStream(stream, generation);
    if (!this.isCurrentRun(generation)) return;
    if (outcome === "completed") {
      await this.completeRun(generation);
    } else if (outcome === "disconnected") {
      this.dispatch({ type: "disconnected" });
    }
  }

  private async recoverSessionAfterAmbiguousAdmission(): Promise<
    | { kind: "session"; snapshot: MiniLilacSessionSnapshot; messages?: MiniLilacUIMessage[] }
    | { kind: "not-created" }
    | { kind: "unknown" }
  > {
    if (this.disposed) return { kind: "unknown" };
    let snapshot: MiniLilacSessionSnapshot;
    try {
      snapshot = await this.options.transport.getSession(this.sessionId, {
        signal: this.abortController.signal,
      });
    } catch (error) {
      const message = errorMessage(error);
      return message.includes("(404)") || message.includes("not_found")
        ? { kind: "not-created" }
        : { kind: "unknown" };
    }
    if (this.disposed) return { kind: "unknown" };
    this.sessionExists = true;
    this.options.transport.setSessionBindings({
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    });
    this.acceptSnapshot(snapshot);
    const messages = await this.options.transport
      .getMessages(this.sessionId, { signal: this.abortController.signal })
      .catch(() => undefined);
    return { kind: "session", snapshot, ...(messages === undefined ? {} : { messages }) };
  }

  private async resumeActiveSession(): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextRunGeneration();
    this.beginRun();
    await this.reconnectRun(generation);
  }

  private async reconnectRun(generation: number): Promise<void> {
    const outcome = await this.driveStream(undefined, generation);
    if (!this.isCurrentRun(generation)) return;
    if (outcome === "completed") {
      await this.completeRun(generation);
    } else if (outcome === "disconnected") {
      this.dispatch({ type: "disconnected" });
    }
  }

  private async driveStream(
    initial: ReadableStream<UIMessageChunk> | undefined,
    generation: number,
  ): Promise<StreamOutcome> {
    if (!this.isCurrentRun(generation) && initial !== undefined) {
      await initial.cancel().catch(() => undefined);
      return this.disposed ? "disposed" : "superseded";
    }
    let stream = initial;
    const hadInitialStream = initial !== undefined;
    let reconnectAttempt = 0;
    let reconnectEntryId: string | undefined;

    for (;;) {
      if (stream !== undefined) {
        const outcome = await this.consume(stream, generation);
        if (outcome === "completed") return "completed";
        if (outcome === "disposed") return "disposed";
        if (outcome === "superseded") return "superseded";
        stream = undefined;
      }

      reconnectAttempt += 1;
      const reconnecting = {
        kind: "status",
        tone: "warning",
        text:
          reconnectAttempt === 1
            ? "connection lost; reconnecting"
            : `connection unavailable; retrying (${reconnectAttempt})`,
      } as const;
      if (hadInitialStream || reconnectAttempt > 1) {
        if (reconnectEntryId === undefined) reconnectEntryId = this.appendOutput(reconnecting);
        else this.updateOutput(reconnectEntryId, reconnecting);
      }
      if (reconnectAttempt > 1 || this.options.reconnectDelay !== undefined) {
        await this.waitForReconnect(reconnectAttempt);
      }
      if (!this.isCurrentRun(generation)) {
        return this.disposed ? "disposed" : "superseded";
      }

      let reconnected: ReadableStream<UIMessageChunk> | null;
      try {
        reconnected = await this.options.transport.reconnectToStream({ chatId: this.sessionId });
      } catch (error) {
        if (!this.isCurrentRun(generation)) {
          return this.disposed ? "disposed" : "superseded";
        }
        const unavailable = {
          kind: "status",
          tone: "warning",
          text: `connection unavailable; retrying (${reconnectAttempt}): ${errorMessage(error)}`,
        } as const;
        if (reconnectEntryId === undefined) reconnectEntryId = this.appendOutput(unavailable);
        else this.updateOutput(reconnectEntryId, unavailable);
        continue;
      }
      if (!this.isCurrentRun(generation)) {
        if (reconnected !== null) await reconnected.cancel().catch(() => undefined);
        return this.disposed ? "disposed" : "superseded";
      }
      // `null` means the run already finished server-side; treat as completion.
      if (reconnected === null) return "completed";
      stream = reconnected;
    }
  }

  private async waitForReconnect(attempt: number): Promise<void> {
    if (this.options.reconnectDelay !== undefined) {
      await this.options.reconnectDelay(attempt);
      return;
    }
    if (attempt <= 1) return;
    await Bun.sleep(Math.min(5_000, 250 * 2 ** Math.min(attempt - 2, 5)));
  }

  private async consume(
    stream: ReadableStream<UIMessageChunk>,
    generation: number,
  ): Promise<StreamOutcome> {
    if (!this.isCurrentRun(generation)) {
      await stream.cancel().catch(() => undefined);
      return this.disposed ? "disposed" : "superseded";
    }
    const reader = stream.getReader();
    this.activeReader = reader;
    let terminalFinish = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.disposed) return "disposed";
        if (generation !== this.runGeneration) {
          await reader.cancel().catch(() => undefined);
          return "superseded";
        }
        if (done) return terminalFinish ? "completed" : "disconnected";
        if (value.type === "finish") terminalFinish = true;
        const cursor = miniLilacStreamCursorChunkSchema.safeParse(value);
        if (cursor.success) this.admitRun(cursor.data.data.runId);
        this.renderer.handle(value);
      }
    } catch {
      // A read failure is a transport disconnect, not a cancellation.
      if (this.disposed) return "disposed";
      if (generation !== this.runGeneration) return "superseded";
      return terminalFinish ? "completed" : "disconnected";
    } finally {
      if (this.activeReader === reader) this.activeReader = undefined;
      reader.releaseLock();
    }
  }

  private enqueueSteer(
    draftText: string,
    files: readonly DraftFile[],
    pastedTexts: readonly DraftPastedText[],
  ): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const text = expandDraftText(draftText, files, pastedTexts);
    const message: MiniLilacUserUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: userParts(text, files),
    };
    const clientCommandId = crypto.randomUUID();
    this.messages.push(message);
    const outputIds = this.appendUserOutput(text, files);
    const rollback = () => {
      this.messages = this.messages.filter((candidate) => candidate.id !== message.id);
      outputIds.forEach((id) => this.removeOutput(id));
      this.restoreSubmittedDraft(draftText, files, pastedTexts, false, true);
    };
    this.steerChain = this.steerChain.then(async () => {
      const runId = await admission;
      if (runId === undefined || !this.isCurrentRun(generation)) {
        rollback();
        return;
      }
      try {
        const request = { sessionId: this.sessionId, runId, message, clientCommandId };
        try {
          await this.options.transport.steer(request, { signal: this.abortController.signal });
        } catch {
          if (this.abortController.signal.aborted) throw new Error("Steering was aborted");
          await this.options.transport.steer(request, { signal: this.abortController.signal });
        }
      } catch (error) {
        rollback();
        if (!this.isCurrentRun(generation)) return;
        this.dispatch({ type: "steer-failed" });
        this.commitError(error);
      }
    });
  }

  private enqueueInterrupt(): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const clientCommandId = crypto.randomUUID();
    // Chained after pending steers so admissions complete before interrupting.
    this.steerChain = this.steerChain.then(async () => {
      const runId = await admission;
      if (runId === undefined || !this.isCurrentRun(generation)) return;
      try {
        await this.options.transport.interruptQueuedSteering(
          { sessionId: this.sessionId, runId, clientCommandId },
          { signal: this.abortController.signal },
        );
      } catch (error) {
        if (!this.isCurrentRun(generation)) return;
        this.commitError(error);
      }
    });
  }

  private enqueueCancel(): void {
    const admission = this.promptAdmission;
    const generation = this.runGeneration;
    const clientCommandId = crypto.randomUUID();
    // Cancellation follows prompt and steering admission so it cannot overtake them.
    this.steerChain = this.steerChain.then(async () => {
      let runId = await admission;
      if (!this.isCurrentRun(generation)) return;
      if (runId === undefined && this.state.phase === "disconnected") {
        try {
          const snapshot = await this.options.transport.getSession(this.sessionId, {
            signal: this.abortController.signal,
          });
          this.onSnapshot(snapshot);
          runId = snapshot.activeRunId ?? undefined;
        } catch (error) {
          if (this.isCurrentRun(generation)) this.commitError(error);
          return;
        }
      }
      if (runId === undefined) return;
      try {
        await this.options.transport.cancel(
          { sessionId: this.sessionId, runId, clientCommandId },
          { signal: this.abortController.signal },
        );
        if (!this.isCurrentRun(generation)) return;
        if (this.state.phase === "disconnected") {
          await this.reconnectRun(generation);
        }
      } catch (error) {
        if (!this.isCurrentRun(generation)) return;
        this.commitError(error);
      }
    });
  }

  private onSnapshot(snapshot: MiniLilacSessionSnapshot): void {
    this.sessionExists = true;
    this.acceptSnapshot(snapshot);
    if (snapshot.activeRunId !== null) this.admitRun(snapshot.activeRunId);
    this.dispatch({ type: "steering-updated", queuedSteeringCount: snapshot.queuedSteeringCount });
  }

  private acceptSnapshot(snapshot: MiniLilacSessionSnapshot): void {
    this.bindings = {
      model: snapshot.model ?? undefined,
      profile: snapshot.profile ?? undefined,
      reasoning: snapshot.reasoning ?? undefined,
    };
    this.presentation = sessionPresentation(snapshot);
    this.options.ui.onBindings?.(this.bindings);
    this.options.ui.onSession?.(this.presentation);
  }

  private onControl(result: MiniLilacControlResult): void {
    if (result.status === "queued") this.dispatch({ type: "steer-confirmed" });
  }

  private onTodos(todos: MiniLilacTodoState): void {
    if (todos.revision <= this.todos.revision) return;
    this.todos = todos;
    this.options.ui.onTodos?.(this.todos);
  }

  private admitRun(runId: string): void {
    this.activeRunId = runId;
    this.resolvePromptAdmission?.(runId);
    this.resolvePromptAdmission = undefined;
  }

  private onTranscriptReset(_reset: MiniLilacTranscriptReset): void {
    this.messages = this.messages.slice(0, this.runMessageBaseline);
    this.output = this.output.slice(0, this.runOutputBaseline);
    this.notifyOutput();
  }

  private async runUndo(): Promise<void> {
    if (!this.sessionExists) {
      this.dispatch({ type: "operation-completed" });
      return;
    }
    const clientCommandId = (this.pendingUndoCommandId ??= crypto.randomUUID());
    let result: Awaited<ReturnType<MiniLilacTransport["undo"]>>;
    try {
      try {
        result = await this.options.transport.undo(
          { sessionId: this.sessionId, clientCommandId },
          { signal: this.abortController.signal },
        );
      } catch {
        result = await this.options.transport.undo(
          { sessionId: this.sessionId, clientCommandId },
          { signal: this.abortController.signal },
        );
      }
    } catch (error) {
      if (this.disposed) return;
      this.dispatch({ type: "operation-failed" });
      this.commitError(error);
      return;
    }

    if (this.disposed) return;
    if (result.status === "empty") {
      this.pendingUndoCommandId = undefined;
      this.dispatch({ type: "operation-completed" });
      return;
    }
    try {
      this.messages = await this.options.transport.getMessages(this.sessionId, {
        signal: this.abortController.signal,
      });
      if (this.disposed) return;
      this.output = this.renderMessages();
      this.runOutputBaseline = this.output.length;
      this.runMessageBaseline = this.messages.length;
      this.notifyOutput();
    } catch (error) {
      if (this.disposed) return;
      const removedIndex = this.messages.findIndex((message) => message.id === result.message.id);
      if (removedIndex >= 0) {
        this.messages = this.messages.slice(0, removedIndex);
        this.output = this.renderMessages();
        this.runOutputBaseline = this.output.length;
        this.runMessageBaseline = this.messages.length;
        this.notifyOutput();
      }
      this.commitError(`undo saved; transcript refresh failed: ${errorMessage(error)}`);
    }
    this.restoreDraft(result.message, true, true);
    this.pendingUndoCommandId = undefined;
  }

  private async runCompact(): Promise<void> {
    if (!this.sessionExists) {
      this.dispatch({ type: "operation-completed" });
      return;
    }
    try {
      const result = await this.options.transport.compact(
        { sessionId: this.sessionId, clientCommandId: crypto.randomUUID() },
        { signal: this.abortController.signal },
      );
      if (this.disposed) return;
      if (result.status === "compacted") {
        const messages = await this.options.transport.getMessages(this.sessionId, {
          signal: this.abortController.signal,
        });
        if (this.disposed) return;
        this.replaceMessages(messages);
        const snapshot = await this.options.transport.getSession(this.sessionId, {
          signal: this.abortController.signal,
        });
        if (this.disposed) return;
        this.acceptSnapshot(snapshot);
      }
      this.dispatch({ type: "operation-completed" });
    } catch (error) {
      if (this.disposed) return;
      this.dispatch({ type: "operation-failed" });
      this.commitError(error);
    }
  }

  private async completeRun(generation: number): Promise<void> {
    await this.reconcile(generation);
    if (!this.isCurrentRun(generation)) return;
    this.activeRunId = undefined;
    this.dispatch({ type: "agent-stopped" });
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.isCurrentRun(generation)) return;
    try {
      const messages = await this.options.transport.getMessages(this.sessionId, {
        signal: this.abortController.signal,
      });
      if (!this.isCurrentRun(generation)) return;
      this.replaceMessages(messages);
    } catch {
      // Keep the local transcript; the server copy is temporarily unavailable.
    }
  }

  private replaceMessages(messages: readonly MiniLilacUIMessage[]): void {
    this.messages = [...messages];
    this.output = this.renderMessages();
    this.runOutputBaseline = this.output.length;
    this.runMessageBaseline = this.messages.length;
    this.notifyOutput();
  }

  private renderMessages(): TranscriptEntry[] {
    return renderInitialMessages(this.messages, {
      cwd: this.options.cwd ?? this.options.initialSnapshot?.cwd,
    });
  }

  private appendOutput(entry: Omit<TranscriptEntry, "id">): string {
    const id = `output:${this.outputSequence}`;
    this.outputSequence += 1;
    this.output = [...this.output, { id, ...entry }];
    this.notifyOutput();
    return id;
  }

  private appendOutputText(id: string, delta: string): void {
    this.output = this.output.map((entry) =>
      entry.id === id ? { ...entry, text: entry.text + delta } : entry,
    );
    this.notifyOutput();
  }

  private finishOutput(id: string): void {
    this.output = this.output.map((entry) =>
      entry.id === id ? { ...entry, streaming: false } : entry,
    );
    this.notifyOutput();
  }

  private updateOutput(id: string, entry: Omit<TranscriptEntry, "id">): void {
    this.output = this.output.map((candidate) =>
      candidate.id === id ? { id: candidate.id, ...entry } : candidate,
    );
    this.notifyOutput();
  }

  private removeOutput(id: string): void {
    this.output = this.output.filter((entry) => entry.id !== id);
    this.notifyOutput();
  }

  private appendUserOutput(text: string, files: readonly DraftFile[]): string[] {
    const ids: string[] = [];
    if (text.length > 0) ids.push(this.appendOutput({ kind: "user", tone: "accent", text }));
    files.forEach((file) => {
      ids.push(
        this.appendOutput({
          kind: "file",
          tone: "muted",
          text: file.file.filename ? `Image: ${file.file.filename}` : "Image attached",
        }),
      );
    });
    return ids;
  }

  private restoreDraft(
    message: MiniLilacUserUIMessage,
    finishOperation = false,
    preserveCurrent = false,
  ): void {
    const restoredText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    let restoredEditor = restoredText;
    const restoredFiles = message.parts
      .filter((part) => part.type === "file")
      .map(
        (file, index): DraftFile => ({
          id: crypto.randomUUID(),
          placeholder: `[Image ${index + 1}]`,
          start: 0,
          end: 0,
          file,
        }),
      )
      .map((file) => {
        const separator = restoredEditor.length > 0 ? (restoredText.length > 0 ? "\n" : " ") : "";
        restoredEditor += separator;
        const start = editorOffsetWidth(restoredEditor);
        restoredEditor += file.placeholder;
        return { ...file, start, end: start + editorOffsetWidth(file.placeholder) };
      });
    const current = this.state;
    const text =
      preserveCurrent && current.editor.length > 0
        ? [restoredEditor, current.editor].filter(Boolean).join("\n")
        : restoredEditor;
    const currentOffset = restoredEditor.length > 0 ? editorOffsetWidth(`${restoredEditor}\n`) : 0;
    const files = preserveCurrent
      ? [
          ...restoredFiles,
          ...current.files.map(
            (file): DraftFile => ({
              ...file,
              start: file.start + currentOffset,
              end: file.end + currentOffset,
            }),
          ),
        ]
      : restoredFiles;
    const pastedTexts = preserveCurrent
      ? current.pastedTexts.map(
          (part): DraftPastedText => ({
            ...part,
            start: part.start + currentOffset,
            end: part.end + currentOffset,
          }),
        )
      : [];
    this.dispatch({ type: "draft-restored", text, files, pastedTexts, finishOperation });
  }

  private restoreSubmittedDraft(
    submittedText: string,
    submittedFiles: readonly DraftFile[],
    submittedPastedTexts: readonly DraftPastedText[],
    finishOperation: boolean,
    preserveCurrent: boolean,
  ): void {
    const current = this.state;
    const text =
      preserveCurrent && current.editor.length > 0
        ? [submittedText, current.editor].filter(Boolean).join("\n")
        : submittedText;
    const currentOffset = submittedText.length > 0 ? editorOffsetWidth(`${submittedText}\n`) : 0;
    this.dispatch({
      type: "draft-restored",
      text,
      files: preserveCurrent
        ? [
            ...submittedFiles,
            ...current.files.map(
              (file): DraftFile => ({
                ...file,
                start: file.start + currentOffset,
                end: file.end + currentOffset,
              }),
            ),
          ]
        : submittedFiles,
      pastedTexts: preserveCurrent
        ? [
            ...submittedPastedTexts,
            ...current.pastedTexts.map(
              (part): DraftPastedText => ({
                ...part,
                start: part.start + currentOffset,
                end: part.end + currentOffset,
              }),
            ),
          ]
        : submittedPastedTexts,
      finishOperation,
    });
  }

  private commitError(error: unknown): void {
    this.appendOutput({ kind: "error", tone: "danger", text: errorMessage(error) });
  }

  private beginRun(): void {
    this.renderer.startRun();
  }

  private nextRunGeneration(): number {
    this.runGeneration += 1;
    return this.runGeneration;
  }

  private isCurrentRun(generation: number): boolean {
    return !this.disposed && generation === this.runGeneration;
  }

  private notifyState(): void {
    if (!this.disposed) this.options.ui.onState(this.state);
  }

  private notifyOutput(): void {
    if (!this.disposed) this.options.ui.onOutput(this.output);
  }
}

function userParts(text: string, files: readonly DraftFile[]): MiniLilacUserUIMessage["parts"] {
  const fileParts = files.map((file) => file.file);
  if (text.length > 0) return [{ type: "text", text }, ...fileParts];
  const [first, ...rest] = fileParts;
  if (first === undefined) throw new Error("A user prompt requires text or an attachment");
  return [first, ...rest];
}

export function expandDraftText(
  text: string,
  files: readonly DraftFile[],
  pastedTexts: readonly DraftPastedText[],
): string {
  const replacements = [
    ...pastedTexts.map((part) => ({ ...part, replacement: part.text })),
    ...files.map((part) => ({ ...part, replacement: "" })),
  ].sort((left, right) => right.start - left.start);
  return replacements
    .reduce((expanded, part) => {
      const start = editorOffsetIndex(expanded, part.start);
      const end = editorOffsetIndex(expanded, part.end);
      return `${expanded.slice(0, start)}${part.replacement}${expanded.slice(end)}`;
    }, text)
    .trim();
}

function sessionBindingUpdateMatches(
  snapshot: MiniLilacSessionSnapshot,
  update: SessionBindingUpdate,
): boolean {
  if (update.model !== undefined && snapshot.model !== update.model) return false;
  if (update.profile !== undefined && snapshot.profile !== update.profile) return false;
  if (update.reasoning !== undefined && snapshot.reasoning !== update.reasoning) return false;
  return true;
}
