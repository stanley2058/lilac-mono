import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";

import {
  MiniLilacTransport,
  type MiniLilacCancelResult,
  type MiniLilacCompactInput,
  type MiniLilacCompactResult,
  type MiniLilacInterruptQueuedSteeringResult,
  type MiniLilacSteerRequest,
  type MiniLilacSteerResult,
  type MiniLilacSessionSnapshot,
  type MiniLilacTodoState,
  type MiniLilacUndoRequest,
  type MiniLilacUndoResult,
  type MiniLilacUpdateSessionBindingsInput,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import { Controller, expandDraftText, type ControllerUISink } from "./controller";
import type { InputState } from "./input-state";
import type { TranscriptEntry } from "./render";

const SESSION_PRESENTATION = {
  title: "Test session",
  inputTokens: null,
  contextWindow: null,
} as const;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function silentUI(): ControllerUISink {
  return { onState: () => {}, onOutput: () => {} };
}

function submitText(controller: Controller, text: string): void {
  controller.setEditor(text);
  controller.submit();
}

function messageText(message: MiniLilacUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** A transport whose network methods are stubbed while keeping full typing. */
class FakeTransport extends MiniLilacTransport {
  readonly calls: string[] = [];
  private streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined;
  reconnectCount = 0;
  getMessagesCount = 0;
  sendMessagesCount = 0;
  streamCancelCount = 0;
  undoRequests: MiniLilacUndoRequest[] = [];
  compactRequests: MiniLilacCompactInput[] = [];
  bindingRequests: MiniLilacUpdateSessionBindingsInput[] = [];
  localBindings: Array<{ model?: string; profile?: string; reasoning?: string }> = [];
  sendAbortSignal: AbortSignal | undefined;
  steerAbortSignals: Array<AbortSignal | undefined> = [];
  interruptAbortSignals: Array<AbortSignal | undefined> = [];
  interruptRequests: Array<Parameters<MiniLilacTransport["interruptQueuedSteering"]>[0]> = [];
  cancelAbortSignals: Array<AbortSignal | undefined> = [];
  sentMessages: MiniLilacUIMessage[] = [];
  canonicalMessages: MiniLilacUIMessage[] = [];

  constructor(
    private readonly behavior: {
      readonly failFirstRead?: boolean;
      readonly admissionError?: Error;
      readonly admissionGate?: Promise<void>;
      readonly steerError?: Error;
      readonly steer?: (request: MiniLilacSteerRequest) => Promise<MiniLilacSteerResult>;
      readonly interrupt?: () => Promise<MiniLilacInterruptQueuedSteeringResult>;
      readonly messagesError?: Error;
      readonly getMessages?: () => Promise<MiniLilacUIMessage[]>;
      readonly cancel?: () => Promise<MiniLilacCancelResult>;
      readonly undo?: (request: MiniLilacUndoRequest) => Promise<MiniLilacUndoResult>;
      readonly compact?: (request: MiniLilacCompactInput) => Promise<MiniLilacCompactResult>;
      readonly updateBindings?: (
        request: MiniLilacUpdateSessionBindingsInput,
      ) => Promise<MiniLilacSessionSnapshot>;
      readonly session?: MiniLilacSessionSnapshot;
      readonly sessionError?: Error;
      readonly getSession?: () => Promise<MiniLilacSessionSnapshot>;
      readonly reconnectPromise?: Promise<ReadableStream<UIMessageChunk> | null>;
      readonly reconnectStream?: () => ReadableStream<UIMessageChunk> | null;
    } = {},
  ) {
    super({});
  }

  override sendMessages(
    options: Parameters<MiniLilacTransport["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.sendMessagesCount += 1;
    this.sentMessages = options.messages;
    this.sendAbortSignal = options.abortSignal;
    const failFirstRead = this.behavior.failFirstRead === true;
    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.streamController = controller;
        if (failFirstRead) {
          controller.error(new Error("socket reset"));
        } else {
          controller.enqueue({
            type: "data-streamCursor",
            data: { runId: "run-1", seq: 1 },
            transient: true,
          });
        }
      },
      cancel: () => {
        this.streamCancelCount += 1;
      },
    });
    return (this.behavior.admissionGate ?? Promise.resolve()).then(() => {
      if (this.behavior.admissionError !== undefined) throw this.behavior.admissionError;
      return stream;
    });
  }

  override reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    this.reconnectCount += 1;
    this.calls.push("reconnect");
    if (this.behavior.reconnectPromise !== undefined) return this.behavior.reconnectPromise;
    return Promise.resolve(this.behavior.reconnectStream?.() ?? null);
  }

  override steer(
    request: MiniLilacSteerRequest,
    options?: Parameters<MiniLilacTransport["steer"]>[1],
  ): Promise<MiniLilacSteerResult> {
    const text = messageText(request.message);
    this.calls.push(`steer:${text}`);
    this.steerAbortSignals.push(options?.signal);
    if (this.behavior.steer !== undefined) return this.behavior.steer(request);
    if (this.behavior.steerError !== undefined) return Promise.reject(this.behavior.steerError);
    return Promise.resolve({ status: "queued", steeringId: `steer-${text}` });
  }

  override interruptQueuedSteering(
    request: Parameters<MiniLilacTransport["interruptQueuedSteering"]>[0],
    options?: Parameters<MiniLilacTransport["interruptQueuedSteering"]>[1],
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    this.calls.push("interrupt");
    this.interruptRequests.push(request);
    this.interruptAbortSignals.push(options?.signal);
    if (this.behavior.interrupt !== undefined) return this.behavior.interrupt();
    return Promise.resolve({ status: "interrupted", steeringIds: [] });
  }

  override cancel(
    _request: Parameters<MiniLilacTransport["cancel"]>[0],
    options?: Parameters<MiniLilacTransport["cancel"]>[1],
  ): Promise<MiniLilacCancelResult> {
    this.calls.push("cancel");
    this.cancelAbortSignals.push(options?.signal);
    if (this.behavior.cancel !== undefined) return this.behavior.cancel();
    try {
      this.streamController?.enqueue({ type: "finish", finishReason: "stop" });
      this.streamController?.close();
    } catch {
      // An errored disconnected stream cannot be closed again.
    }
    return Promise.resolve({ status: "cancelled" });
  }

  override undo(request: MiniLilacUndoRequest): Promise<MiniLilacUndoResult> {
    this.calls.push("undo");
    this.undoRequests.push(request);
    if (this.behavior.undo !== undefined) return this.behavior.undo(request);
    return Promise.reject(new Error("undo not configured"));
  }

  override compact(request: MiniLilacCompactInput): Promise<MiniLilacCompactResult> {
    this.calls.push("compact");
    this.compactRequests.push(request);
    if (this.behavior.compact !== undefined) return this.behavior.compact(request);
    return Promise.reject(new Error("compact not configured"));
  }

  override setSessionBindings(bindings: {
    readonly model?: string;
    readonly profile?: string;
    readonly reasoning?:
      | "provider-default"
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
  }): void {
    this.localBindings.push(bindings);
    super.setSessionBindings(bindings);
  }

  override updateSessionBindings(
    request: MiniLilacUpdateSessionBindingsInput,
  ): Promise<MiniLilacSessionSnapshot> {
    this.bindingRequests.push(request);
    if (this.behavior.updateBindings !== undefined) return this.behavior.updateBindings(request);
    return Promise.reject(new Error("binding update not configured"));
  }

  override getMessages(): Promise<MiniLilacUIMessage[]> {
    this.getMessagesCount += 1;
    if (this.behavior.getMessages !== undefined) return this.behavior.getMessages();
    if (this.behavior.messagesError !== undefined)
      return Promise.reject(this.behavior.messagesError);
    return Promise.resolve(this.canonicalMessages);
  }

  override getSession(): Promise<MiniLilacSessionSnapshot> {
    if (this.behavior.getSession !== undefined) return this.behavior.getSession();
    if (this.behavior.sessionError !== undefined) return Promise.reject(this.behavior.sessionError);
    if (this.behavior.session !== undefined) return Promise.resolve(this.behavior.session);
    return Promise.reject(new Error("MiniLilac request failed (404): session not found"));
  }

  enqueue(chunk: UIMessageChunk): void {
    this.streamController?.enqueue(chunk);
  }

  closeStream(): void {
    this.streamController?.enqueue({ type: "finish", finishReason: "stop" });
    this.streamController?.close();
  }

  closeStreamWithoutFinish(): void {
    this.streamController?.close();
  }
}

describe("Controller effect wiring", () => {
  it("expands repeated placeholders by display range", () => {
    const placeholder = "[Pasted ~3 lines]";
    const text = `${placeholder}\n${placeholder}`;

    expect(
      expandDraftText(
        text,
        [],
        [
          {
            id: "paste-2",
            placeholder,
            start: 18,
            end: 35,
            text: "second",
          },
          {
            id: "paste-1",
            placeholder,
            start: 0,
            end: 17,
            text: `first contains ${placeholder}`,
          },
        ],
      ),
    ).toBe(`first contains ${placeholder}\nsecond`);
  });

  it("uses terminal display offsets when removing file placeholders", () => {
    expect(
      expandDraftText(
        "😀界 [Image 1]",
        [
          {
            id: "image-1",
            placeholder: "[Image 1]",
            start: 5,
            end: 14,
            file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
          },
        ],
        [],
      ),
    ).toBe("😀界");
  });

  it("updates local bindings before a fresh session is admitted", async () => {
    const transport = new FakeTransport();
    const seen: Array<{ model?: string; profile?: string; reasoning?: string }> = [];
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onBindings: (bindings) => seen.push(bindings),
      },
      sessionId: "new-session",
      initialBindings: {
        model: "provider/old",
        profile: "coding",
        reasoning: "low",
      },
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toEqual([]);
    expect(transport.localBindings).toEqual([{ model: "provider/new" }]);
    expect(seen.at(-1)).toEqual({
      model: "provider/new",
      profile: "coding",
      reasoning: "low",
    });
    expect(controller.inputState.phase).toBe("idle");
  });

  it("updates durable bindings for an existing quiescent session", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/old",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      updateBindings: (request) =>
        Promise.resolve({
          ...initial,
          model: request.model ?? initial.model,
          profile: request.profile ?? initial.profile,
          reasoning: request.reasoning ?? initial.reasoning,
        }),
    });
    let latest: { model?: string; profile?: string; reasoning?: string } | undefined;
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onBindings: (bindings) => {
          latest = bindings;
        },
      },
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ profile: "review" })).toBe(true);
    expect(transport.bindingRequests).toEqual([
      expect.objectContaining({ sessionId: "session-1", profile: "review" }),
    ]);
    expect(latest).toEqual({ model: "provider/old", profile: "review", reasoning: "low" });
  });

  it("rejects binding changes while a run is active", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start");
    await flush();

    expect(await controller.updateSessionBindings({ reasoning: "high" })).toBe(false);
    expect(transport.bindingRequests).toEqual([]);
    controller.dispose();
  });

  it("reconciles a binding update whose responses were lost", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/old",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const updated = { ...initial, model: "provider/new" };
    const transport = new FakeTransport({
      updateBindings: () => Promise.reject(new Error("response lost")),
      session: updated,
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toHaveLength(2);
    expect(transport.bindingRequests[0]?.clientCommandId).toBe(
      transport.bindingRequests[1]?.clientCommandId,
    );
    expect(transport.localBindings.at(-1)).toEqual({
      model: "provider/new",
      profile: "coding",
      reasoning: "low",
    });
    expect(controller.inputState.phase).toBe("idle");
  });

  it("recovers a server-created session after an ambiguous first admission failure", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/original",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      updateBindings: (request) =>
        Promise.resolve({
          ...snapshot,
          model: request.model ?? snapshot.model,
          profile: request.profile ?? snapshot.profile,
          reasoning: request.reasoning ?? snapshot.reasoning,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: {
        model: "provider/original",
        profile: "coding",
        reasoning: "low",
      },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();
    await flush();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toEqual([
      expect.objectContaining({ sessionId: "session-1", model: "provider/new" }),
    ]);
    expect(transport.localBindings).toEqual([
      { model: "provider/original", profile: "coding", reasoning: "low" },
    ]);
  });

  it("reconnects an active prompt after its admission response is lost", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    let transport: FakeTransport;
    transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      getMessages: () => Promise.resolve(transport.sentMessages),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: { ...snapshot, activeRunId: null, status: "idle" },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "admitted once");
    await flush();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["admitted once"]);
  });

  it("reconciles a completed prompt after its admission response is lost", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    let transport: FakeTransport;
    transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      getMessages: () =>
        Promise.resolve([
          ...transport.sentMessages,
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "completed once" }],
          },
        ]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: {
        model: "provider/model",
        profile: "coding",
        reasoning: "high",
      },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "admitted once");
    await flush();
    await flush();

    expect(transport.sendMessagesCount).toBe(1);
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "admitted once",
      "completed once",
    ]);
  });

  it("blocks resubmission when admission and reconciliation are both unreachable", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      sessionError: new Error("network unreachable"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "possibly admitted");
    await flush();
    await flush();

    expect(controller.inputState.phase).toBe("disconnected");
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toContain("possibly admitted");
    submitText(controller, "must not resubmit");
    expect(transport.sendMessagesCount).toBe(1);
  });

  it("resolves the active run before cancelling a disconnected admission", async () => {
    let snapshotCalls = 0;
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      getSession: () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return Promise.reject(new Error("network unreachable"));
        return Promise.resolve({
          ...SESSION_PRESENTATION,
          id: "session-1",
          activeRunId: "run-1",
          status: "streaming",
          cwd: process.cwd(),
          model: "provider/model",
          profile: "coding",
          reasoning: "high",
          queuedSteeringCount: 0,
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: { model: "provider/model", profile: "coding", reasoning: "high" },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "possibly admitted");
    await flush();
    await flush();
    expect(controller.inputState.phase).toBe("disconnected");

    controller.escape();
    await flush();
    await flush();
    expect(snapshotCalls).toBe(2);
    expect(transport.calls).toContain("cancel");
  });

  it("submits image-only drafts as file UI parts", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.addFile({
      id: "image-1",
      placeholder: "[Image 1]",
      start: 0,
      end: 9,
      file: {
        type: "file",
        mediaType: "image/png",
        filename: "clipboard.png",
        url: "data:image/png;base64,AA==",
      },
    });
    controller.setEditor("[Image 1]");
    controller.submit();
    await flush();

    expect(transport.sentMessages.at(-1)?.parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "clipboard.png",
        url: "data:image/png;base64,AA==",
      },
    ]);
    controller.dispose();
  });

  it("expands pasted-text placeholders only in the submitted message", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("Review this:\n[Pasted ~3 lines]");
    controller.addPastedText({
      id: "paste-1",
      placeholder: "[Pasted ~3 lines]",
      start: 13,
      end: 30,
      text: "one\ntwo\nthree",
    });
    controller.submit();
    await flush();

    expect(messageText(transport.sentMessages.at(-1)!)).toBe("Review this:\none\ntwo\nthree");
    controller.dispose();
  });

  it("executes /undo locally, reconciles history, and restores multipart input", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-2",
      role: "user",
      parts: [
        { type: "text", text: "second prompt" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "diagram.png",
          url: "data:image/png;base64,AA==",
        },
      ],
    };
    const remaining: MiniLilacUIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "first prompt" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
    ];
    const transport = new FakeTransport({
      undo: () =>
        Promise.resolve({ status: "undone", clientCommandId: "undo-1", message: removed }),
      getMessages: () => Promise.resolve(remaining),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [...remaining, removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(transport.calls).toEqual(["undo"]);
    expect(transport.sendMessagesCount).toBe(0);
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "first prompt",
      "first answer",
    ]);
    expect(controller.inputState.editor).toBe("second prompt\n[Image 1]");
    expect(controller.inputState.files.map((file) => file.file.filename)).toEqual(["diagram.png"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("treats undo with no user turn as a successful no-op", async () => {
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "empty",
          clientCommandId: request.clientCommandId ?? "missing",
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages,
      onExit: () => {},
    });
    controller.start();
    controller.undo();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("runs typed /compact as a quiet submitting operation", async () => {
    const completion = deferred<MiniLilacCompactResult>();
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    const transport = new FakeTransport({
      compact: () => completion.promise,
      session: {
        ...SESSION_PRESENTATION,
        id: "session-1",
        activeRunId: null,
        status: "idle",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "coding",
        reasoning: "low",
        queuedSteeringCount: 0,
      },
    });
    transport.canonicalMessages = [
      ...initialMessages,
      {
        id: "compaction:compact-1",
        role: "assistant",
        parts: [
          {
            type: "data-compaction",
            id: "compact-1",
            data: {
              source: "manual",
              reason: "manual",
              status: "completed",
              messageCountBefore: 4,
              messageCountAfter: 2,
            },
          },
        ],
      },
    ];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages,
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "/compact");
    expect(controller.inputState.phase).toBe("submitting");
    expect(transport.calls).toEqual(["compact"]);
    expect(transport.compactRequests[0]).toEqual({
      sessionId: "session-1",
      clientCommandId: expect.any(String),
    });

    completion.resolve({
      status: "compacted",
      clientCommandId: transport.compactRequests[0]?.clientCommandId ?? "compact-1",
      messageCountBefore: 4,
      messageCountAfter: 2,
    });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "Context compacted",
    ]);
  });

  it("keeps compact noop and empty results quiet", async () => {
    const statuses: Array<"noop" | "empty"> = ["noop", "empty"];
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: statuses.shift() ?? "empty",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 0,
          messageCountAfter: 0,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    controller.compact();
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
  });

  it("keeps compact failures visible", async () => {
    const transport = new FakeTransport({
      compact: () => Promise.reject(new Error("compaction failed")),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.text).toBe("compaction failed");
  });

  it("never compacts or steers while active", async () => {
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: "compacted",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 4,
          messageCountAfter: 2,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start");
    await flush();

    controller.compact();
    submitText(controller, "/compact");
    await flush();
    expect(transport.compactRequests).toEqual([]);
    expect(transport.calls).not.toContain("steer:/compact");
    expect(controller.inputState.editor).toBe("/compact");
    controller.dispose();
  });

  it("publishes initial and updated session presentation", async () => {
    const initial = {
      id: "session-1",
      activeRunId: null,
      status: "idle" as const,
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low" as const,
      queuedSteeringCount: 0,
      title: "Initial title",
      inputTokens: 1_000,
      contextWindow: 10_000,
    };
    const updated = {
      ...initial,
      profile: "review",
      title: "Updated title",
      inputTokens: 2_500,
    };
    const seen: Array<{ title: string; inputTokens: number | null; contextWindow: number | null }> =
      [];
    const transport = new FakeTransport({ updateBindings: () => Promise.resolve(updated) });
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onSession: (session) => seen.push(session),
      },
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();
    expect(seen.at(-1)).toEqual({
      title: "Initial title",
      inputTokens: 1_000,
      contextWindow: 10_000,
    });

    expect(await controller.updateSessionBindings({ profile: "review" })).toBe(true);
    expect(seen.at(-1)).toEqual({
      title: "Updated title",
      inputTokens: 2_500,
      contextWindow: 10_000,
    });
  });

  it("does not call the server when undoing before session creation", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.undo();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(transport.undoRequests).toEqual([]);
    expect(controller.transcript).toEqual([]);
  });

  it("retries an uncertain undo with the same idempotency key", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(transport.undoRequests).toHaveLength(2);
    expect(transport.undoRequests[0]?.clientCommandId).toBe(
      transport.undoRequests[1]?.clientCommandId,
    );
    expect(controller.inputState.editor).toBe("restore me");
  });

  it("keeps the undo idempotency key after both responses are uncertain", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();
    expect(transport.undoRequests).toHaveLength(2);

    submitText(controller, "/undo");
    await flush();
    expect(transport.undoRequests).toHaveLength(3);
    expect(new Set(transport.undoRequests.map((request) => request.clientCommandId)).size).toBe(1);
    expect(controller.inputState.editor).toBe("restore me");
  });

  it("supersedes an uncertain undo key when a new prompt is admitted", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();
    const uncertainId = transport.undoRequests[0]?.clientCommandId;

    submitText(controller, "new prompt");
    await flush();
    transport.closeStream();
    await flush();
    submitText(controller, "/undo");
    await flush();

    expect(transport.undoRequests).toHaveLength(3);
    expect(transport.undoRequests[2]?.clientCommandId).not.toBe(uncertainId);
  });

  it("restores the draft when canonical refresh fails after undo commits", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
        }),
      messagesError: new Error("offline"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(controller.inputState.editor).toBe("restore me");
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.text).toContain("undo saved; transcript refresh failed");
  });

  it("preserves text entered while undo is in flight", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restored prompt" }],
    };
    const undo = deferred<MiniLilacUndoResult>();
    const transport = new FakeTransport({
      undo: () => undo.promise,
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    controller.setEditor("new draft text");
    undo.resolve({ status: "undone", clientCommandId: "undo-1", message: removed });
    await flush();

    expect(controller.inputState.editor).toBe("restored prompt\nnew draft text");
  });

  it("preserves pasted-text metadata entered while undo is in flight", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restored prompt" }],
    };
    const undo = deferred<MiniLilacUndoResult>();
    const transport = new FakeTransport({
      undo: () => undo.promise,
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    controller.setEditor("[Pasted ~3 lines]");
    controller.addPastedText({
      id: "paste-1",
      placeholder: "[Pasted ~3 lines]",
      start: 0,
      end: 17,
      text: "one\ntwo\nthree",
    });
    undo.resolve({ status: "undone", clientCommandId: "undo-1", message: removed });
    await flush();

    expect(controller.inputState.editor).toBe("restored prompt\n[Pasted ~3 lines]");
    expect(controller.inputState.pastedTexts).toMatchObject([
      { id: "paste-1", start: 16, end: 33 },
    ]);
    expect(
      expandDraftText(
        controller.inputState.editor,
        controller.inputState.files,
        controller.inputState.pastedTexts,
      ),
    ).toBe("restored prompt\none\ntwo\nthree");
  });

  it("interrupts pending steer admissions atomically, then cancels on Esc", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello"); // idle + dirty -> prompt, run becomes active
    await flush();

    submitText(controller, "one"); // active + dirty -> steer "one"
    submitText(controller, "two"); // active + dirty -> steer "two"
    controller.submit(); // active + empty + queued -> interrupt
    await flush();

    expect(transport.calls).toEqual(["interrupt"]);
    expect(transport.interruptRequests[0]?.pendingSteerCommandIds).toHaveLength(2);

    controller.escape(); // active Esc/Ctrl-C semantic event -> explicit cancel
    expect(controller.inputState.pendingSteeringCount).toBe(0);
    expect(controller.inputState.confirmedSteeringCount).toBe(0);
    await flush();

    expect(transport.calls).toEqual(["interrupt", "cancel"]);
  });

  it("orders cancel after deferred prompt and steer admission", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({ admissionGate: admission.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello");
    submitText(controller, "steer after admission");
    controller.escape();
    await flush();
    expect(transport.calls).toEqual([]);
    expect(transport.sentMessages.map(messageText)).toEqual(["hello"]);

    admission.resolve(undefined);
    await flush();
    expect(transport.calls).toEqual(["steer:steer after admission", "cancel"]);
  });

  it("cancels without waiting for a stalled steer response", async () => {
    const cancelReached = deferred<void>();
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      cancel: async () => {
        cancelReached.resolve(undefined);
        return { status: "cancelled" };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "stalled steer");
    await flush();
    controller.escape();
    await Promise.race([
      cancelReached.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("cancel did not reach the transport");
      }),
    ]);

    expect(transport.calls).toEqual(["steer:stalled steer", "cancel"]);
    expect(transport.steerAbortSignals[0]?.aborted).toBe(true);
    expect(transport.cancelAbortSignals[0]?.aborted).toBe(false);
    expect(transport.sendAbortSignal?.aborted).toBe(false);
    expect(transport.streamCancelCount).toBe(0);
    controller.dispose();
  });

  it("interrupts without waiting for a stalled steer response", async () => {
    const interruptReached = deferred<void>();
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      interrupt: async () => {
        interruptReached.resolve(undefined);
        return { status: "interrupted", steeringIds: [] };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "stalled steer");
    await flush();
    controller.submit();
    await Promise.race([
      interruptReached.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("interrupt did not reach the transport");
      }),
    ]);

    expect(transport.calls).toEqual(["steer:stalled steer", "interrupt"]);
    expect(transport.interruptAbortSignals[0]?.aborted).toBe(false);
    expect(transport.sendAbortSignal?.aborted).toBe(false);
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    controller.dispose();
  });

  it("keeps newer steer barriers when an older interrupt reset arrives", async () => {
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      interrupt: async () => ({ status: "empty" }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "older steer");
    await flush();
    controller.submit();
    await flush();
    expect(transport.interruptRequests[0]?.pendingSteerCommandIds).toHaveLength(1);

    submitText(controller, "newer steer");
    await flush();
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "interrupt" } });
    await flush();
    controller.submit();
    await flush();

    expect(transport.interruptRequests[1]?.pendingSteerCommandIds).toHaveLength(1);
    controller.dispose();
  });

  it("does not cancel and removes local user output when prompt admission fails", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({
      admissionGate: admission.promise,
      admissionError: new Error("rejected"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "not admitted");
    controller.escape();

    admission.resolve(undefined);
    await flush();
    expect(transport.calls).not.toContain("cancel");
    expect(controller.transcript.map((entry) => entry.kind)).toEqual(["error"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("preserves a newer draft when prompt admission fails", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({
      admissionGate: admission.promise,
      admissionError: new Error("rejected"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "original prompt");
    controller.setEditor("new draft");
    admission.resolve(undefined);
    await flush();

    expect(controller.inputState.editor).toBe("original prompt\nnew draft");
    expect(controller.inputState.phase).toBe("idle");
  });

  it("rolls back one optimistic queue entry when steering fails", async () => {
    const transport = new FakeTransport({ steerError: new Error("steer rejected") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "failed steer");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "failed steer"]);
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "steer rejected"]);
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    expect(controller.inputState.editor).toBe("failed steer");
    controller.dispose();
  });

  it("retries an ambiguous steer with the same command id", async () => {
    const attempts: MiniLilacSteerRequest[] = [];
    const transport = new FakeTransport({
      steer: async (request) => {
        attempts.push(request);
        if (attempts.length === 1) throw new Error("response lost");
        return { status: "queued", steeringId: "steer-recovered" };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "recover steer");
    await flush();

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.clientCommandId).toBeTruthy();
    expect(attempts[1]?.clientCommandId).toBe(attempts[0]?.clientCommandId);
    expect(controller.inputState.editor).toBe("");
  });

  it("keeps confirmed steering when a later submission fails, then clears it on consumption", async () => {
    const secondSteer = deferred<MiniLilacSteerResult>();
    const transport = new FakeTransport({
      steer: (request) =>
        messageText(request.message) === "second"
          ? secondSteer.promise
          : Promise.resolve({ status: "queued", steeringId: "steer-first" }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "first");
    submitText(controller, "second");
    await flush();
    transport.enqueue({
      type: "data-control",
      data: { status: "queued", steeringId: "steer-first" },
    });
    transport.enqueue({
      type: "data-session",
      data: {
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        queuedSteeringCount: 1,
      },
    });
    await flush();
    expect(controller.inputState.pendingSteeringCount).toBe(1);
    expect(controller.inputState.confirmedSteeringCount).toBe(1);
    expect(controller.inputState.queuedSteeringCount).toBe(2);

    secondSteer.reject(new Error("second rejected"));
    await flush();
    expect(controller.inputState.pendingSteeringCount).toBe(0);
    expect(controller.inputState.confirmedSteeringCount).toBe(1);
    expect(controller.inputState.queuedSteeringCount).toBe(1);
    expect(controller.inputState.editor).toBe("second");

    controller.ctrlC();
    controller.submit();
    await flush();
    expect(transport.calls).toContain("interrupt");

    transport.enqueue({
      type: "data-session",
      data: {
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        queuedSteeringCount: 0,
      },
    });
    await flush();
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    controller.dispose();
  });

  it("aborts and discards a stream that arrives after disposal during admission", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({ admissionGate: admission.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    controller.dispose();
    expect(transport.sendAbortSignal?.aborted).toBe(true);

    admission.resolve(undefined);
    await flush();
    expect(transport.streamCancelCount).toBe(1);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("classifies reader cancellation during disposal as disposed", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    controller.dispose();
    await flush();
    expect(transport.streamCancelCount).toBe(1);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("discards a resumed stream that arrives after disposal", async () => {
    const reconnect = deferred<ReadableStream<UIMessageChunk> | null>();
    let cancelled = false;
    const transport = new FakeTransport({ reconnectPromise: reconnect.promise });
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: snapshot,
      onExit: () => {},
    });
    controller.start();
    controller.dispose();
    reconnect.resolve(
      new ReadableStream<UIMessageChunk>({
        cancel: () => {
          cancelled = true;
        },
      }),
    );
    await flush();
    expect(cancelled).toBe(true);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("truncates the current-run tail immediately on transcript reset", async () => {
    const transport = new FakeTransport({ messagesError: new Error("offline") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "discard queued steer");
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "discard queued steer",
    ]);

    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "discard me" });
    transport.enqueue({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "bash",
      dynamic: true,
    });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "cancel" } });
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (cancel); canonical transcript will be reconciled",
    ]);
    transport.closeStream();
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (cancel); canonical transcript will be reconciled",
    ]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("preserves admitted steering across an interrupt transcript reset", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "replacement direction");
    await flush();
    transport.enqueue({ type: "text-start", id: "discarded" });
    transport.enqueue({ type: "text-delta", id: "discarded", delta: "discard me" });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "interrupt" } });
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "replacement direction",
      "transcript rewound (interrupt); canonical transcript will be reconciled",
    ]);
  });

  it("shows canonical steering user messages after normal completion", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "change direction");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "change direction"]);
    const optimisticSteerId = controller.transcript[1]?.id;
    await flush();

    transport.canonicalMessages = [
      { id: "user-prompt", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant-before-steer",
        role: "assistant",
        parts: [{ type: "text", text: "working", state: "done" }],
      },
      {
        id: "user-steer",
        role: "user",
        parts: [{ type: "text", text: "change direction" }],
      },
    ];
    transport.closeStream();
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "working",
      "change direction",
    ]);
    expect(controller.transcript[2]?.id).toBe("message:user-steer:0");
    expect(controller.transcript[2]?.id).not.toBe(optimisticSteerId);
    expect(transport.getMessagesCount).toBe(1);
  });

  it("replaces a divergent streamed transcript with canonical messages on completion", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "streamed draft" });
    transport.enqueue({ type: "text-end", id: "text-1" });
    transport.canonicalMessages = [
      { id: "user-canonical", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant-canonical",
        role: "assistant",
        parts: [{ type: "text", text: "canonical answer", state: "done" }],
      },
    ];
    transport.closeStream();
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "canonical answer"]);
    expect(controller.transcript.map((entry) => entry.text)).not.toContain("streamed draft");
    expect(transport.reconnectCount).toBe(0);
  });

  it("keeps the run active until its deferred canonical reconciliation settles", async () => {
    const canonical = deferred<MiniLilacUIMessage[]>();
    const transport = new FakeTransport({ getMessages: () => canonical.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();

    transport.closeStream();
    await flush();
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("active");

    submitText(controller, "must not become a second prompt");
    await flush();
    expect(transport.sendMessagesCount).toBe(1);

    canonical.resolve([
      { id: "canonical", role: "user", parts: [{ type: "text", text: "first prompt" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["first prompt"]);
  });

  it("never lets an older deferred reconciliation overwrite a newer generation", async () => {
    const older = deferred<MiniLilacUIMessage[]>();
    const newer = deferred<MiniLilacUIMessage[]>();
    let reconciliation = 0;
    const transport = new FakeTransport({
      getMessages: () => {
        reconciliation += 1;
        return reconciliation === 1 ? older.promise : newer.promise;
      },
    });
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: snapshot,
      onExit: () => {},
    });

    controller.start();
    await flush();
    expect(transport.getMessagesCount).toBe(1);

    // A second lifecycle generation supersedes the still-pending first one.
    controller.start();
    await flush();
    expect(transport.getMessagesCount).toBe(2);

    newer.resolve([
      { id: "newer", role: "assistant", parts: [{ type: "text", text: "newer output" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["newer output"]);

    older.resolve([
      { id: "older", role: "assistant", parts: [{ type: "text", text: "stale output" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["newer output"]);
  });

  it("does not cancel on a transport disconnect and reconnects exactly once", async () => {
    let reconnectStreamCreated = false;
    const transport = new FakeTransport({
      failFirstRead: true,
      reconnectStream: () => {
        reconnectStreamCreated = true;
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            controller.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 1 },
              transient: true,
            });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello");
    await flush();

    expect(reconnectStreamCreated).toBe(true);
    expect(transport.reconnectCount).toBe(1);
    expect(transport.calls).not.toContain("cancel");
    expect(controller.inputState.phase).toBe("idle");
  });

  it("reconnects exactly once after clean partial EOF and completes only on terminal finish", async () => {
    const transport = new FakeTransport({
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            streamController.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 2 },
              transient: true,
            });
            streamController.enqueue({ type: "text-delta", id: "text-1", delta: " world" });
            streamController.enqueue({ type: "finish", finishReason: "stop" });
            streamController.close();
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "partial" });
    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("keeps reconnecting when a replacement stream also ends before terminal finish", async () => {
    let reconnectAttempt = 0;
    const transport = new FakeTransport({
      reconnectStream: () => {
        reconnectAttempt += 1;
        return new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            streamController.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: reconnectAttempt + 1 },
              transient: true,
            });
            if (reconnectAttempt === 2) {
              streamController.enqueue({ type: "finish", finishReason: "stop" });
            }
            streamController.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      reconnectDelay: async () => {},
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(2);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("accepts reconnect null as server-confirmed terminal after clean EOF", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("retries a transient reconnect request failure instead of exhausting", async () => {
    let reconnectAttempt = 0;
    const transport = new FakeTransport({
      failFirstRead: true,
      reconnectStream: () => {
        reconnectAttempt += 1;
        if (reconnectAttempt === 1) {
          throw new Error("The socket connection was closed unexpectedly");
        }
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            controller.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 1 },
              transient: true,
            });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      reconnectDelay: async () => {},
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    expect(transport.reconnectCount).toBe(2);
    expect(controller.inputState.phase).toBe("idle");
    expect(transport.calls).not.toContain("cancel");
  });

  it("waits for terminal stream after cancelling while reconnecting", async () => {
    const cancelResponse = deferred<MiniLilacCancelResult>();
    let terminalReconnect: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const transport = new FakeTransport({
      cancel: () => cancelResponse.promise,
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            terminalReconnect = streamController;
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();
    expect(controller.inputState.phase).toBe("active");
    expect(transport.reconnectCount).toBe(1);

    controller.escape();
    await flush();
    expect(transport.calls.at(-1)).toBe("cancel");

    cancelResponse.resolve({ status: "cancelled" });
    await flush();
    expect(transport.getMessagesCount).toBe(0);
    expect(controller.inputState.phase).toBe("active");

    submitText(controller, "must not become a second prompt");
    await flush();
    expect(transport.sendMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("active");

    terminalReconnect?.enqueue({ type: "finish", finishReason: "stop" });
    terminalReconnect?.close();
    await flush();
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("returns idle when prompt admission fails", async () => {
    const transport = new FakeTransport({ admissionError: new Error("rejected") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    expect(controller.inputState.phase).toBe("idle");
  });

  it("hydrates resumed messages and reconnects an active snapshot immediately", async () => {
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "existing", role: "user", parts: [{ type: "text", text: "before resume" }] },
    ];
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport();
    transport.canonicalMessages = initialMessages;
    const states: InputState[] = [];
    const outputs: (readonly TranscriptEntry[])[] = [];
    const controller = new Controller({
      transport,
      ui: {
        onState: (state) => states.push(state),
        onOutput: (entries) => outputs.push(entries),
      },
      sessionId: "session-1",
      initialSnapshot: snapshot,
      initialMessages,
      onExit: () => {},
    });

    controller.start();
    expect(outputs[0]).toEqual([
      {
        id: "message:existing:0",
        kind: "user",
        tone: "accent",
        text: "before resume",
      },
    ]);
    expect(states[0]?.phase).toBe("active");
    await flush();
    expect(transport.calls[0]).toBe("reconnect");
    expect(controller.inputState.phase).toBe("idle");

    submitText(controller, "continued");
    await flush();
    expect(transport.sentMessages.map((message) => message.id)).toEqual([
      "existing",
      expect.any(String),
    ]);
  });

  it("replays an admitted steering message at its original stream position", async () => {
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "root", role: "user", parts: [{ type: "text", text: "root prompt" }] },
    ];
    const steering: MiniLilacUserUIMessage = {
      id: "steer-replayed",
      role: "user",
      parts: [{ type: "text", text: "replayed steering" }],
    };
    const transport = new FakeTransport({
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start(stream) {
            stream.enqueue({ type: "data-steering", id: steering.id, data: steering });
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: {
        ...SESSION_PRESENTATION,
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        queuedSteeringCount: 1,
      },
      initialMessages,
      onExit: () => {},
    });

    controller.start();
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "root prompt",
      "replayed steering",
    ]);
    controller.dispose();
  });

  it("publishes hydrated todos initially and admits only newer live revisions", async () => {
    const initialTodos: MiniLilacTodoState = {
      revision: 2,
      todos: [{ content: "Existing", status: "pending", priority: "medium" }],
    };
    const newerTodos: MiniLilacTodoState = {
      revision: 3,
      todos: [{ content: "Live", status: "in_progress", priority: "high" }],
    };
    const seen: MiniLilacTodoState[] = [];
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onTodos: (todos) => seen.push(todos),
      },
      sessionId: "session-1",
      initialTodos,
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start stream");
    await flush();

    transport.enqueue({
      type: "data-todos",
      data: { revision: 1, todos: [] },
      transient: true,
    });
    transport.enqueue({ type: "data-todos", data: initialTodos, transient: true });
    transport.enqueue({ type: "data-todos", data: newerTodos, transient: true });
    transport.enqueue({
      type: "data-todos",
      data: { revision: 2, todos: [] },
      transient: true,
    });
    await flush();

    expect(seen).toEqual([initialTodos, newerTodos]);
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["start stream"]);
    controller.dispose();
  });

  it("retains the latest todos across transcript reset replay overlap", async () => {
    const seen: MiniLilacTodoState[] = [];
    const transport = new FakeTransport({ messagesError: new Error("offline") });
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onTodos: (todos) => seen.push(todos),
      },
      sessionId: "session-1",
      initialTodos: { revision: 0, todos: [] },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start stream");
    await flush();

    const latest: MiniLilacTodoState = {
      revision: 4,
      todos: [{ content: "Keep me", status: "in_progress", priority: "high" }],
    };
    transport.enqueue({ type: "data-todos", data: latest, transient: true });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "cancel" } });
    transport.enqueue({
      type: "data-todos",
      data: { revision: 3, todos: [] },
      transient: true,
    });
    transport.enqueue({ type: "data-todos", data: latest, transient: true });
    await flush();

    expect(seen).toEqual([{ revision: 0, todos: [] }, latest]);
    controller.dispose();
  });
});
