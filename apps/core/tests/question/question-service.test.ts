import { afterEach, describe, expect, it, jest } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";

import type { QuestionActionToken, QuestionInput } from "../../src/question/question-domain";
import {
  QUESTION_INACTIVITY_TIMEOUT_MS,
  QuestionService,
} from "../../src/question/question-service";
import { QuestionStoreFailed, SqliteQuestionStore } from "../../src/question/question-store";
import { SurfaceUnavailable } from "../../src/surface/adapter";
import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";
import type {
  SurfaceQuestionAnswerHandler,
  SurfaceQuestionActivityHandler,
  SurfaceQuestionFinishInput,
  SurfaceQuestionInteractionUpdate,
  SurfaceQuestionPort,
  SurfaceQuestionPrompt,
} from "../../src/surface/question";
import type { SurfaceQuestionResolver } from "../../src/surface/runtime-descriptor";
import type { MsgRefFor, SessionRefFor } from "../../src/surface/types";

const temporaryDirectories: string[] = [];

async function createStore(
  create: (dbPath: string) => SqliteQuestionStore = (dbPath) => new SqliteQuestionStore({ dbPath }),
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-question-service-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "request-delivery.db");
  const owner = new Database(dbPath, { create: true, strict: true });
  owner.run(`
    CREATE TABLE request_delivery_records (
      request_delivery_id TEXT PRIMARY KEY NOT NULL
    ) STRICT
  `);
  owner.run("INSERT INTO request_delivery_records (request_delivery_id) VALUES (?)", [
    "delivery-1",
  ]);
  owner.close();
  return create(dbPath);
}

class ReplaceFailingQuestionStore extends SqliteQuestionStore {
  override replaceTokens(_questionCallId: string, _tokens: readonly QuestionActionToken[]) {
    return Result.err(
      new QuestionStoreFailed({
        operation: "replace-tokens",
        code: "SQLITE_IOERR",
        message: "Question store SQLite replace-tokens failed",
      }),
    );
  }
}

class TransitionFailingQuestionStore extends SqliteQuestionStore {
  override transitionPending() {
    return Result.err(
      new QuestionStoreFailed({
        operation: "transition-pending",
        code: "SQLITE_IOERR",
        message: "Question store SQLite transition-pending failed",
      }),
    );
  }
}

class TestQuestionPort implements SurfaceQuestionPort<"discord"> {
  prompts: SurfaceQuestionPrompt[] = [];
  presentations: Array<{
    readonly sessionRef: SessionRefFor<"discord">;
    readonly replyTo?: MsgRefFor<"discord">;
  }> = [];
  finishes: SurfaceQuestionFinishInput<"discord">[] = [];
  interactionUpdates: SurfaceQuestionInteractionUpdate[] = [];
  handler: SurfaceQuestionAnswerHandler<"discord"> | null = null;
  activityHandler: SurfaceQuestionActivityHandler<"discord"> | null = null;
  dismissHandler: SurfaceQuestionActivityHandler<"discord"> | undefined;
  interactionUpdateGate: Promise<void> | null = null;
  interactionUpdateStarted: (() => void) | null = null;
  finishGate: Promise<void> | null = null;
  finishStarted: (() => void) | null = null;
  pendingUpdateFailure: SurfaceUnavailable | null = null;

  async present(input: {
    readonly sessionRef: SessionRefFor<"discord">;
    readonly replyTo?: MsgRefFor<"discord">;
    readonly prompt: SurfaceQuestionPrompt;
  }) {
    this.prompts.push(input.prompt);
    this.presentations.push({
      sessionRef: input.sessionRef,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    });
    return Result.ok({
      platform: "discord",
      channelId: "channel-1",
      messageId: "card-1",
    } as const);
  }

  async finish(input: SurfaceQuestionFinishInput<"discord">) {
    this.finishes.push(input);
    this.finishStarted?.();
    if (this.finishGate) await this.finishGate;
    return Result.ok(undefined);
  }

  async subscribeAnswers(
    handler: SurfaceQuestionAnswerHandler<"discord">,
    handleActivity: SurfaceQuestionActivityHandler<"discord">,
    handleDismiss?: SurfaceQuestionActivityHandler<"discord">,
  ) {
    this.handler = handler;
    this.activityHandler = handleActivity;
    this.dismissHandler = handleDismiss;
    return {
      stop: async () => {
        this.handler = null;
        this.activityHandler = null;
      },
    };
  }

  async openCustomInput() {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    if (!prompt || !this.activityHandler) throw new Error("Question prompt is not ready");
    return await this.activityHandler({
      platform: "discord",
      channelId: "channel-1",
      messageRef: {
        platform: "discord",
        channelId: "channel-1",
        messageId: "card-1",
      },
      principal: { platform: "discord", userId: "user-1" },
      token: prompt.customToken,
    });
  }

  async answerOption(optionIndex: number) {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    const option = prompt?.options[optionIndex - 1];
    if (!option || !this.handler) throw new Error("Question option is not ready");
    return await this.handler(
      {
        platform: "discord",
        channelId: "channel-1",
        messageRef: {
          platform: "discord",
          channelId: "channel-1",
          messageId: "card-1",
        },
        principal: { platform: "discord", userId: "user-1" },
        token: option.token,
        answer: { kind: "option", optionIndex },
      },
      async (update) => await this.updateInteraction(update),
    );
  }

  async answerCustom(text: string) {
    const latestUpdate = this.interactionUpdates.at(-1);
    const prompt = latestUpdate?.state === "pending" ? latestUpdate.prompt : this.prompts.at(-1);
    if (!prompt || !this.handler) throw new Error("Question prompt is not ready");
    return await this.handler(
      {
        platform: "discord",
        channelId: "channel-1",
        messageRef: {
          platform: "discord",
          channelId: "channel-1",
          messageId: "card-1",
        },
        principal: { platform: "discord", userId: "user-1" },
        token: prompt.customToken,
        answer: { kind: "custom", text },
      },
      async (update) => await this.updateInteraction(update),
    );
  }

  private async updateInteraction(update: SurfaceQuestionInteractionUpdate) {
    this.interactionUpdateStarted?.();
    if (this.interactionUpdateGate) await this.interactionUpdateGate;
    if (update.state === "pending" && this.pendingUpdateFailure) {
      return Result.err(this.pendingUpdateFailure);
    }
    this.interactionUpdates.push(update);
    return Result.ok(undefined);
  }
}

function createService(store: SqliteQuestionStore, port: TestQuestionPort): QuestionService {
  const resolved = {
    platform: "discord" as const,
    protocol: BUILTIN_SURFACE_PROTOCOLS.discord,
    question: port,
  };
  const surfaces: SurfaceQuestionResolver = {
    entries: () => [resolved],
    resolve: (platform) => (platform === "discord" ? resolved : null),
  };
  return new QuestionService({
    store,
    surfaces,
    logger: { warn: () => undefined },
  });
}

const input: QuestionInput = {
  questions: [
    {
      id: "environment",
      header: "Environment",
      question: "Where should this run?",
      options: [
        { id: "staging", label: "Staging", description: "Use staging." },
        {
          id: "production",
          label: "Production",
          description: "Use production.",
        },
      ],
    },
    {
      id: "timing",
      header: "Timing",
      question: "When should this run?",
      options: [
        { id: "now", label: "Now", description: "Run now." },
        { id: "later", label: "Later", description: "Run later." },
      ],
    },
  ],
};

const singleQuestionInput: QuestionInput = {
  questions: [input.questions[0]!],
};

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("question service", () => {
  it("does not acknowledge dismissal when its durable transition fails", async () => {
    const store = await createStore((dbPath) => new TransitionFailingQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    const service = createService(store, port);
    (await service.start()).unwrap();
    const handle = (
      await service.begin({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "tool-call-1",
        sessionId: "channel-1",
        userId: "user-1",
        questions: singleQuestionInput,
      })
    ).unwrap();
    const dismissed = await port.dismissHandler!({
      platform: "discord",
      channelId: "channel-1",
      messageRef: { platform: "discord", channelId: "channel-1", messageId: "card-1" },
      principal: { platform: "discord", userId: "user-1" },
      token: port.prompts[0]!.customToken,
    });
    expect(dismissed.isErr()).toBe(true);
    expect((await handle.completion).isErr()).toBe(true);
    expect(service.listDeferred("request-1").isErr()).toBe(true);
    await service.stop();
    store.close();
  });

  it("replays an existing synchronous call with its original delivery mode", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    (await service.start()).unwrap();
    const args = {
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      questions: singleQuestionInput,
    };
    const original = (await service.begin({ ...args, mode: "sync" })).unwrap();
    (await port.answerOption(1)).unwrap();
    const replayed = (await service.begin(args)).unwrap();
    expect(replayed.mode).toBe("sync");
    expect(replayed.questionCallId).toBe(original.questionCallId);
    expect((await replayed.completion).unwrap()).toEqual((await original.completion).unwrap());
    expect(service.listDeferred("request-1").unwrap()).toEqual([]);
    await service.stop();
    store.close();
  });

  it("returns a deferred handle before the answer and reuses it on replay", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    (await service.start()).unwrap();
    const args = {
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      questions: singleQuestionInput,
      mode: "deferred" as const,
    };
    const handle = (await service.begin(args)).unwrap();
    expect(service.listDeferred("request-1").unwrap()[0]?.state).toBe("pending");
    expect((await service.begin(args)).unwrap().questionCallId).toBe(handle.questionCallId);
    expect(port.prompts).toHaveLength(1);
    (await port.answerOption(1)).unwrap();
    expect((await handle.completion).unwrap()[0]?.answer).toEqual({
      kind: "option",
      optionId: "staging",
    });
    await service.stop();
    store.close();
  });

  it("runs sequential prompts on one card and returns stable IDs to the model", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    expect(service.supports("discord")).toBe(true);
    expect(service.supports("github")).toBe(false);

    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-1",
      sessionId: "channel-1",
      userId: "user-1",
      replyTo: { platform: "discord", channelId: "channel-1", messageId: "turn-1" },
      questions: input,
    });
    await Promise.resolve();
    expect(port.prompts).toHaveLength(1);
    expect(port.presentations).toEqual([
      {
        sessionRef: { platform: "discord", channelId: "channel-1" },
        replyTo: { platform: "discord", channelId: "channel-1", messageId: "turn-1" },
      },
    ]);

    expect((await port.answerOption(2)).status).toBe("ok");
    expect(port.prompts).toHaveLength(1);
    expect(port.interactionUpdates[0]).toMatchObject({
      state: "pending",
      prompt: { ordinal: 2, total: 2, header: "Timing" },
    });
    expect((await port.answerCustom("After the release window")).status).toBe("ok");

    const result = await pending;
    expect(result).toEqual(
      expect.objectContaining({
        status: "ok",
        value: [
          {
            questionId: "environment",
            answer: { kind: "option", optionId: "production" },
          },
          {
            questionId: "timing",
            answer: { kind: "custom", text: "After the release window" },
          },
        ],
      }),
    );
    expect(port.interactionUpdates[1]).toEqual({
      state: "answered",
      summary: {
        answers: [
          {
            header: "Environment",
            answer: { kind: "option", label: "Production" },
          },
          { header: "Timing", answer: { kind: "custom" } },
        ],
      },
    });
    expect(port.finishes).toEqual([]);

    await service.stop();
    store.close();
  });

  it("waits for cancellation cleanup before settling the tool call", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");

    const finishStarted = Promise.withResolvers<void>();
    const finishGate = Promise.withResolvers<void>();
    port.finishStarted = finishStarted.resolve;
    port.finishGate = finishGate.promise;
    const controller = new AbortController();
    let settled = false;
    const pending = service
      .ask({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "tool-call-cancel",
        sessionId: "channel-1",
        userId: "user-1",
        questions: input,
        signal: controller.signal,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();

    controller.abort();
    await finishStarted.promise;
    expect(settled).toBe(false);
    finishGate.resolve();

    const result = await pending;
    expect(result).toMatchObject({ status: "error", error: { _tag: "QuestionCancelled" } });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "cancelled" })]);

    await service.stop();
    store.close();
  });

  it("lets an accepted final answer finish before a concurrent abort", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const interactionUpdateStarted = Promise.withResolvers<void>();
    const interactionUpdateGate = Promise.withResolvers<void>();
    port.interactionUpdateStarted = interactionUpdateStarted.resolve;
    port.interactionUpdateGate = interactionUpdateGate.promise;
    const controller = new AbortController();
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-final-answer-abort",
      sessionId: "channel-1",
      userId: "user-1",
      questions: singleQuestionInput,
      signal: controller.signal,
    });
    await Promise.resolve();

    const answering = port.answerOption(1);
    await interactionUpdateStarted.promise;
    controller.abort();
    expect(port.finishes).toEqual([]);
    interactionUpdateGate.resolve();

    expect(await answering).toMatchObject({ status: "ok", value: "accepted" });
    expect(await pending).toMatchObject({
      status: "ok",
      value: [{ questionId: "environment" }],
    });
    expect(port.finishes).toEqual([]);

    await service.stop();
    store.close();
  });

  it("finishes an intermediate card update before concurrent shutdown interrupts it", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const interactionUpdateStarted = Promise.withResolvers<void>();
    const interactionUpdateGate = Promise.withResolvers<void>();
    port.interactionUpdateStarted = interactionUpdateStarted.resolve;
    port.interactionUpdateGate = interactionUpdateGate.promise;
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-intermediate-answer-stop",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    const answering = port.answerOption(1);
    await interactionUpdateStarted.promise;
    const stopping = service.stop();
    await Promise.resolve();
    expect(port.interactionUpdates).toEqual([]);
    expect(port.finishes).toEqual([]);
    interactionUpdateGate.resolve();

    expect(await answering).toMatchObject({ status: "ok", value: "accepted" });
    await stopping;
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionInterrupted" },
    });
    expect(port.interactionUpdates).toHaveLength(1);
    expect(port.interactionUpdates[0]).toMatchObject({
      state: "pending",
      prompt: { ordinal: 2 },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "interrupted" })]);

    store.close();
  });

  it("does not expire deferred questions after the old sync timeout", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    (await service.start()).unwrap();
    const handle = (
      await service.begin({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "deferred-timeout",
        sessionId: "channel-1",
        userId: "user-1",
        questions: input,
      })
    ).unwrap();
    jest.advanceTimersByTime(QUESTION_INACTIVITY_TIMEOUT_MS * 100);
    expect(store.getById(handle.questionCallId).unwrap()?.state).toBe("pending");
    expect(port.finishes).toEqual([]);
    await service.stop();
    store.close();
  });

  it("expires an unanswered question after ten minutes", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-timeout",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    jest.advanceTimersByTime(QUESTION_INACTIVITY_TIMEOUT_MS);

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionTimedOut" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "expired" })]);

    await service.stop();
    store.close();
  });

  it("resets the timeout after each accepted answer", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    let settled = false;
    let activityCount = 0;
    const pending = service
      .ask({
        requestDeliveryId: "delivery-1",
        requestId: "request-1",
        toolCallId: "tool-call-reset-timeout",
        sessionId: "channel-1",
        userId: "user-1",
        questions: input,
        onActivity: () => {
          activityCount += 1;
        },
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();

    jest.advanceTimersByTime(9 * 60 * 1_000);
    expect((await port.answerOption(1)).status).toBe("ok");
    expect(activityCount).toBe(1);
    jest.advanceTimersByTime(9 * 60 * 1_000);
    expect((await port.openCustomInput()).status).toBe("ok");
    expect(activityCount).toBe(2);
    jest.advanceTimersByTime(2 * 60 * 1_000);
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(8 * 60 * 1_000);
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionTimedOut" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "expired" })]);

    await service.stop();
    store.close();
  });

  it("returns a timeout transition failure without changing the card", async () => {
    jest.useFakeTimers({ now: 0 });
    const store = await createStore((dbPath) => new TransitionFailingQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-timeout-transition-failure",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    jest.advanceTimersByTime(QUESTION_INACTIVITY_TIMEOUT_MS);

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionStoreFailed", operation: "transition-pending" },
    });
    expect(port.finishes).toEqual([]);

    await service.stop();
    store.close();
  });

  it("interrupts active cards before shutdown settles their tool calls", async () => {
    const store = await createStore();
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-stop",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    await service.stop();

    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionInterrupted" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "interrupted" })]);
    store.close();
  });

  it("cancels the card and settles the tool call when next-question token rotation fails", async () => {
    const store = await createStore((dbPath) => new ReplaceFailingQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-rotation",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    const handled = await port.answerOption(1);

    expect(handled).toMatchObject({
      status: "error",
      error: { _tag: "SurfaceQuestionAnswerHandlingFailed" },
    });
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionStoreFailed" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "cancelled" })]);

    await service.stop();
    store.close();
  });

  it("cancels the card and settles the tool call when the next-question card update fails", async () => {
    const store = await createStore((dbPath) => new SqliteQuestionStore({ dbPath }));
    const port = new TestQuestionPort();
    port.pendingUpdateFailure = new SurfaceUnavailable({
      platform: "discord",
      operation: "edit-message",
      message: "Discord is unavailable",
    });
    const service = createService(store, port);
    expect((await service.start()).status).toBe("ok");
    const pending = service.ask({
      requestDeliveryId: "delivery-1",
      requestId: "request-1",
      toolCallId: "tool-call-update",
      sessionId: "channel-1",
      userId: "user-1",
      questions: input,
    });
    await Promise.resolve();

    const handled = await port.answerOption(1);

    expect(handled).toMatchObject({
      status: "error",
      error: { _tag: "SurfaceQuestionAnswerHandlingFailed" },
    });
    expect(await pending).toMatchObject({
      status: "error",
      error: { _tag: "QuestionPresentationFailed", operation: "update" },
    });
    expect(port.finishes).toEqual([expect.objectContaining({ state: "cancelled" })]);

    await service.stop();
    store.close();
  });
});
