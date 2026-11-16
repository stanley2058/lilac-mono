import { createHash } from "node:crypto";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  SurfaceQuestionAnswerHandlingFailed,
  type SurfaceQuestionActivity,
  type SurfaceQuestionAnswer,
  type SurfaceQuestionAnswerDisposition,
  type SurfaceQuestionInteractionUpdater,
  type SurfaceQuestionAnswerSubscription,
  type SurfaceQuestionPort,
  type SurfaceQuestionPrompt,
  type SurfaceQuestionSummary,
} from "../surface/question";
import type { SurfaceQuestionResolver } from "../surface/runtime-descriptor";
import type { SurfaceOperationError } from "../surface/adapter";
import type { MsgRefFor } from "../surface/types";
import { isAdapterPlatform } from "../shared/is-adapter-platform";
import type { QuestionActionToken, QuestionAnswers, QuestionCall } from "./question-domain";
import type { QuestionPlatform, QuestionInput } from "./question-domain";
import {
  QuestionStoreCorrupt,
  QuestionStoreFailed,
  SqliteQuestionStore,
  type QuestionStoreError,
  type ValidateQuestionActivityResult,
} from "./question-store";

export class QuestionUnavailable extends TaggedError("QuestionUnavailable")<{
  readonly message: string;
}> {}

export class QuestionPresentationFailed extends TaggedError("QuestionPresentationFailed")<{
  readonly operation: "present" | "update";
  readonly cause: SurfaceOperationError;
  readonly message: string;
}> {}

export class QuestionCancelled extends TaggedError("QuestionCancelled")<{
  readonly message: string;
}> {}

export class QuestionTimedOut extends TaggedError("QuestionTimedOut")<{
  readonly message: string;
}> {}

export class QuestionInterrupted extends TaggedError("QuestionInterrupted")<{
  readonly message: string;
}> {}

export type QuestionServiceError =
  | QuestionUnavailable
  | QuestionPresentationFailed
  | QuestionCancelled
  | QuestionTimedOut
  | QuestionInterrupted
  | QuestionStoreFailed
  | QuestionStoreCorrupt;

type QuestionServiceLogger = {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
};

export type QuestionRequest = {
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly platform?: QuestionPlatform;
  readonly mode?: "deferred" | "sync";
  readonly replyTo?: MsgRefFor<QuestionPlatform>;
  readonly questions: QuestionInput;
  readonly signal?: AbortSignal;
  readonly onActivity?: () => void;
};

export type QuestionHandle = {
  readonly mode: "sync" | "deferred";
  readonly questionCallId: string;
  readonly completion: Promise<ResultType<QuestionAnswers, QuestionServiceError>>;
};

type PendingQuestion = {
  mode: "sync" | "deferred";
  readonly requestId: string;
  readonly completion: Promise<ResultType<QuestionAnswers, QuestionServiceError>>;
  readonly resolve: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void;
  readonly onActivity?: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  interactionOperation: Promise<void> | null;
  terminalOperation: Promise<void> | null;
};

export const QUESTION_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

type IssuedPrompt = {
  readonly prompt: SurfaceQuestionPrompt;
  readonly tokens: readonly QuestionActionToken[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issuePrompt(call: QuestionCall): IssuedPrompt {
  const question = call.input.questions[call.currentIndex]!;
  const options = question.options.map((option, index) => {
    const token = crypto.randomUUID();
    return {
      view: {
        index: index + 1,
        label: option.label,
        description: option.description,
        token,
      },
      stored: {
        tokenSha256: sha256(token),
        questionIndex: call.currentIndex,
        kind: "option" as const,
        optionIndex: index + 1,
      },
    };
  });
  const customToken = crypto.randomUUID();
  return {
    prompt: {
      ordinal: call.currentIndex + 1,
      total: call.input.questions.length,
      header: question.header,
      question: question.question,
      options: options.map((option) => option.view),
      customToken,
    },
    tokens: [
      ...options.map((option) => option.stored),
      {
        tokenSha256: sha256(customToken),
        questionIndex: call.currentIndex,
        kind: "custom",
        optionIndex: null,
      },
    ],
  };
}

function presentationFailure(
  operation: QuestionPresentationFailed["operation"],
  cause: SurfaceOperationError,
): QuestionPresentationFailed {
  return new QuestionPresentationFailed({
    operation,
    cause,
    message: `Question ${operation} failed: ${cause.message}`,
  });
}

function answerHandlingFailure(error: {
  readonly message: string;
}): SurfaceQuestionAnswerHandlingFailed {
  return new SurfaceQuestionAnswerHandlingFailed({ message: error.message });
}

function questionSummary(call: QuestionCall): SurfaceQuestionSummary {
  return {
    answers: call.answers.map((answer) => {
      const question = call.input.questions.find((candidate) => candidate.id === answer.questionId);
      const selectedAnswer = answer.answer;
      if (selectedAnswer.kind !== "option") {
        return {
          header: question?.header ?? answer.questionId,
          answer: { kind: "custom" as const },
        };
      }
      const option = question?.options.find(
        (candidate) => candidate.id === selectedAnswer.optionId,
      );
      return {
        header: question?.header ?? answer.questionId,
        answer: {
          kind: "option" as const,
          label: option?.label ?? selectedAnswer.optionId,
        },
      };
    }),
  };
}

export class QuestionService {
  readonly #deferredFailures = new Map<string, QuestionServiceError>();
  readonly #listeners = new Set<(requestId: string) => void>();
  readonly #waiters = new Map<string, PendingQuestion>();
  readonly #subscriptions: SurfaceQuestionAnswerSubscription[] = [];
  readonly #startupInterrupted: QuestionCall[] = [];

  constructor(
    private readonly input: {
      readonly store: SqliteQuestionStore;
      readonly surfaces: SurfaceQuestionResolver;
      readonly logger: QuestionServiceLogger;
    },
  ) {}

  supports(platform: string): boolean {
    return isAdapterPlatform(platform) && this.input.surfaces.resolve(platform) !== null;
  }

  async start(): Promise<ResultType<void, QuestionStoreError>> {
    for (const resolved of this.input.surfaces.entries()) {
      const subscription = await resolved.question.subscribeAnswers(
        async (answer, updateInteraction) =>
          await this.handleAnswer(
            answer as SurfaceQuestionAnswer<QuestionPlatform>,
            updateInteraction,
          ),
        async (activity) =>
          await this.handleActivity(activity as SurfaceQuestionActivity<QuestionPlatform>),
        async (activity) =>
          await this.handleDismiss(activity as SurfaceQuestionActivity<QuestionPlatform>),
      );
      this.#subscriptions.push(subscription);
    }

    const interrupted = this.input.store.interruptPending();
    const interruptedOutcome = interrupted.match<
      | { readonly kind: "calls"; readonly calls: QuestionCall[] }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (calls) => ({ kind: "calls", calls }),
      err: (error) => ({ kind: "error", error }),
    });
    if (interruptedOutcome.kind === "error") return Result.err(interruptedOutcome.error);

    this.#startupInterrupted.push(...interruptedOutcome.calls);
    return Result.ok(undefined);
  }

  async finishStartupRecovery(): Promise<void> {
    for (const call of this.#startupInterrupted.splice(0)) {
      if (!call.messageId) continue;
      const surface = this.input.surfaces.resolve(call.platform);
      if (!surface) continue;
      const finished = await (surface.question as SurfaceQuestionPort<QuestionPlatform>).finish({
        messageRef: {
          platform: call.platform,
          channelId: call.sessionId,
          messageId: call.messageId,
        },
        state: "interrupted",
      });
      finished.match({
        ok: () => undefined,
        err: (error) =>
          this.input.logger.warn("Question startup cleanup failed", {
            questionCallId: call.questionCallId,
            errorTag: error._tag,
            errorMessage: error.message,
          }),
      });
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.#subscriptions.splice(0)) await subscription.stop();
    for (const [questionCallId, waiter] of this.#waiters) {
      this.clearQuestionTimeout(questionCallId);
      if (waiter.terminalOperation) {
        await waiter.terminalOperation;
        continue;
      }
      const operation = this.queueTerminalOperation(questionCallId, waiter, () =>
        this.interruptPendingQuestion(questionCallId, waiter.resolve),
      );
      await operation;
    }
    this.#waiters.clear();
    this.#deferredFailures.clear();
  }

  subscribe(listener: (requestId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  listDeferred(requestId: string) {
    const failure = this.#deferredFailures.get(requestId);
    if (failure) return Result.err(failure);
    return this.input.store.listDeferred(requestId);
  }

  async cancelRequest(requestId: string): Promise<void> {
    for (const [id, pending] of this.#waiters) {
      if (pending.requestId !== requestId) continue;
      await this.queueTerminalOperation(id, pending, () =>
        this.cancelPendingQuestion(id, pending.resolve),
      );
    }
    this.#deferredFailures.delete(requestId);
  }

  async ask(input: QuestionRequest): Promise<ResultType<QuestionAnswers, QuestionServiceError>> {
    const started = await this.begin({ ...input, mode: "sync" });
    const outcome = started.match<
      { handle: QuestionHandle; error: null } | { handle: null; error: QuestionServiceError }
    >({ ok: (handle) => ({ handle, error: null }), err: (error) => ({ handle: null, error }) });
    if (outcome.error) return Result.err(outcome.error);
    return await outcome.handle!.completion;
  }

  async begin(input: QuestionRequest): Promise<ResultType<QuestionHandle, QuestionServiceError>> {
    if (input.signal?.aborted) {
      return Result.err(new QuestionCancelled({ message: "Question cancelled" }));
    }
    const resolved = this.input.surfaces.resolve(input.platform ?? "discord");
    if (!resolved) {
      return Result.err(
        new QuestionUnavailable({
          message: "The active surface does not support questions",
        }),
      );
    }
    if (resolved.question.begin) return resolved.question.begin(input);
    const existing = this.input.store.getByIdentity(input.requestDeliveryId, input.toolCallId);
    const existingOutcome = existing.match<
      | { readonly kind: "call"; readonly call: QuestionCall | null }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (call) => ({ kind: "call", call }),
      err: (error) => ({ kind: "error", error }),
    });
    if (existingOutcome.kind === "error") return Result.err(existingOutcome.error);
    if (existingOutcome.call) {
      const call = existingOutcome.call;
      if (!call.messageId)
        return Result.err(
          new QuestionInterrupted({ message: "The previous question was not presented" }),
        );
      const pending = this.#waiters.get(call.questionCallId);
      const completion =
        pending?.completion ??
        Promise.resolve(
          call.state === "answered"
            ? Result.ok(call.answers)
            : Result.err(
                new QuestionInterrupted({ message: "The previous question call did not complete" }),
              ),
        );
      return Result.ok({ mode: call.mode, questionCallId: call.questionCallId, completion });
    }

    const questionCallId = crypto.randomUUID();
    const initialCall: QuestionCall = {
      questionCallId,
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      platform: input.platform ?? "discord",
      mode: input.mode ?? "deferred",
      sessionId: input.sessionId,
      userId: input.userId,
      input: input.questions,
      currentIndex: 0,
      answers: [],
      messageId: null,
      state: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const issued = issuePrompt(initialCall);
    const created = this.input.store.create({
      questionCallId,
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      userId: input.userId,
      questionInput: input.questions,
      platform: input.platform ?? "discord",
      mode: input.mode ?? "deferred",
      tokens: issued.tokens,
    });
    const createdOutcome = created.match<
      | { readonly kind: "call"; readonly call: QuestionCall }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (call) => ({ kind: "call", call }),
      err: (error) => ({ kind: "error", error }),
    });
    if (createdOutcome.kind === "error") return Result.err(createdOutcome.error);

    const port = resolved.question as SurfaceQuestionPort<QuestionPlatform>;
    const presented = await port.present({
      sessionRef: { platform: input.platform ?? "discord", channelId: input.sessionId },
      requestId: input.requestId,
      questionCallId,
      userId: input.userId,
      mode: input.mode ?? "deferred",
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      prompt: issued.prompt,
    });
    const presentedOutcome = presented.match<
      | { readonly kind: "message"; readonly messageId: string }
      | { readonly kind: "error"; readonly error: SurfaceOperationError }
    >({
      ok: (messageRef) => ({
        kind: "message",
        messageId: messageRef.messageId,
      }),
      err: (error) => ({ kind: "error", error }),
    });
    if (presentedOutcome.kind === "error") {
      this.input.store.transitionPending(questionCallId, "cancelled");
      return Result.err(presentationFailure("present", presentedOutcome.error));
    }
    const bound = this.input.store.bindMessage(questionCallId, presentedOutcome.messageId);
    const boundError = bound.match({ ok: () => null, err: (error) => error });
    if (boundError) {
      this.input.store.transitionPending(questionCallId, "cancelled");
      await port.finish({
        messageRef: {
          platform: input.platform ?? "discord",
          channelId: input.sessionId,
          messageId: presentedOutcome.messageId,
        },
        state: "cancelled",
      });
      return Result.err(boundError);
    }
    const completion = this.waitForAnswer(
      questionCallId,
      input.requestId,
      input.mode ?? "deferred",
      input.signal,
      input.onActivity,
    );
    return Result.ok({ mode: input.mode ?? "deferred", questionCallId, completion });
  }

  private waitForAnswer(
    questionCallId: string,
    requestId: string,
    mode: "sync" | "deferred",
    signal?: AbortSignal,
    onActivity?: () => void,
  ): Promise<ResultType<QuestionAnswers, QuestionServiceError>> {
    const completion = Promise.withResolvers<ResultType<QuestionAnswers, QuestionServiceError>>();
    const settle = (result: ResultType<QuestionAnswers, QuestionServiceError>) => {
      signal?.removeEventListener("abort", abort);
      this.clearQuestionTimeout(questionCallId);
      this.#waiters.delete(questionCallId);
      result.match({
        ok: () => undefined,
        err: (error) => {
          if (
            mode === "sync" ||
            error._tag === "QuestionCancelled" ||
            error._tag === "QuestionTimedOut" ||
            error._tag === "QuestionInterrupted"
          )
            return;
          this.#deferredFailures.set(requestId, error);
        },
      });
      completion.resolve(result);
      for (const listener of this.#listeners) listener(requestId);
    };
    const abort = () => {
      const waiter = this.#waiters.get(questionCallId);
      if (!waiter || waiter.terminalOperation) return;
      this.clearQuestionTimeout(questionCallId);
      const operation = this.queueTerminalOperation(questionCallId, waiter, () =>
        this.cancelPendingQuestion(questionCallId, settle),
      );
      void operation;
    };
    this.#waiters.set(questionCallId, {
      requestId,
      mode,
      completion: completion.promise,
      resolve: settle,
      ...(onActivity ? { onActivity } : {}),
      timeout: null,
      interactionOperation: null,
      terminalOperation: null,
    });
    this.resetQuestionTimeout(questionCallId);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const stored = this.input.store.getById(questionCallId);
    stored.match({
      ok: (call) => {
        if (call?.state === "answered") settle(Result.ok(call.answers));
      },
      err: (error) => settle(Result.err(error)),
    });
    return completion.promise;
  }

  private clearQuestionTimeout(questionCallId: string): void {
    const waiter = this.#waiters.get(questionCallId);
    if (!waiter?.timeout) return;
    clearTimeout(waiter.timeout);
    waiter.timeout = null;
  }

  private resetQuestionTimeout(questionCallId: string): void {
    const waiter = this.#waiters.get(questionCallId);
    if (!waiter || waiter.mode === "deferred") return;
    this.clearQuestionTimeout(questionCallId);
    const timeout = setTimeout(() => {
      const current = this.#waiters.get(questionCallId);
      if (current?.timeout !== timeout) return;
      current.timeout = null;
      const operation = this.queueTerminalOperation(questionCallId, current, () =>
        this.expirePendingQuestion(questionCallId, current.resolve),
      );
      void operation;
    }, QUESTION_INACTIVITY_TIMEOUT_MS);
    waiter.timeout = timeout;
  }

  private queueTerminalOperation(
    questionCallId: string,
    waiter: PendingQuestion,
    terminalize: () => Promise<void>,
  ): Promise<void> {
    if (waiter.terminalOperation) return waiter.terminalOperation;
    const interactionOperation = waiter.interactionOperation;
    const operation = (async () => {
      if (interactionOperation) await interactionOperation;
      if (this.#waiters.get(questionCallId) !== waiter) return;
      await terminalize();
    })();
    waiter.terminalOperation = operation;
    return operation;
  }

  private async runQuestionInteraction<T>(
    questionCallId: string,
    interact: () => Promise<T>,
  ): Promise<T> {
    const waiter = this.#waiters.get(questionCallId);
    if (!waiter) return await interact();
    const completed = Promise.withResolvers<void>();
    waiter.interactionOperation = completed.promise;
    return await interact().finally(() => {
      completed.resolve();
      const current = this.#waiters.get(questionCallId);
      if (current?.interactionOperation === completed.promise) {
        current.interactionOperation = null;
      }
    });
  }

  private async expirePendingQuestion(
    questionCallId: string,
    settle: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void,
  ): Promise<void> {
    const transitionError = await this.transitionAndFinishQuestion(
      questionCallId,
      "expired",
      "expired",
    );
    if (transitionError) {
      settle(Result.err(transitionError));
      return;
    }
    settle(
      Result.err(
        new QuestionTimedOut({
          message: "Question timed out after 10 minutes without an answer",
        }),
      ),
    );
  }

  private async cancelPendingQuestion(
    questionCallId: string,
    settle: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void,
  ): Promise<void> {
    const transitionError = await this.transitionAndFinishQuestion(
      questionCallId,
      "cancelled",
      "cancelled",
    );
    if (transitionError) {
      settle(Result.err(transitionError));
      return;
    }
    settle(Result.err(new QuestionCancelled({ message: "Question cancelled" })));
  }

  private async interruptPendingQuestion(
    questionCallId: string,
    settle: (result: ResultType<QuestionAnswers, QuestionServiceError>) => void,
  ): Promise<void> {
    const transitionError = await this.transitionAndFinishQuestion(
      questionCallId,
      "interrupted",
      "interrupted",
    );
    if (transitionError) {
      settle(Result.err(transitionError));
      return;
    }
    settle(
      Result.err(
        new QuestionInterrupted({
          message: "Question interrupted by shutdown",
        }),
      ),
    );
  }

  private async transitionAndFinishQuestion(
    questionCallId: string,
    storeState: "cancelled" | "interrupted" | "expired",
    surfaceState: "cancelled" | "expired" | "interrupted",
  ): Promise<QuestionStoreFailed | null> {
    const transitioned = this.input.store.transitionPending(questionCallId, storeState);
    const transitionError = transitioned.match({
      ok: () => null,
      err: (error) => error,
    });
    if (transitionError) return transitionError;
    await this.finishCall(questionCallId, surfaceState);
    return null;
  }

  private async handleAnswer(
    answer: SurfaceQuestionAnswer<QuestionPlatform>,
    updateInteraction: SurfaceQuestionInteractionUpdater,
  ): Promise<
    ResultType<
      "accepted" | "not-found" | "stale" | "unauthorized",
      SurfaceQuestionAnswerHandlingFailed
    >
  > {
    const applied = this.input.store.applyAnswer({
      tokenSha256: sha256(answer.token),
      platform: answer.platform,
      channelId: answer.channelId,
      messageId: answer.messageRef.messageId,
      userId: answer.principal.userId,
      answer: answer.answer,
    });
    const outcome = applied.match<
      | {
          readonly kind: "result";
          readonly result:
            | { readonly disposition: "not-found" | "stale" | "unauthorized" }
            | { readonly disposition: "accepted"; readonly call: QuestionCall };
        }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (result) => ({ kind: "result", result }),
      err: (error) => ({ kind: "error", error }),
    });
    if (outcome.kind === "error") return Result.err(answerHandlingFailure(outcome.error));
    if (outcome.result.disposition !== "accepted") return Result.ok(outcome.result.disposition);

    const call = outcome.result.call;
    return await this.runQuestionInteraction(call.questionCallId, () =>
      this.finishAcceptedAnswer(call, updateInteraction),
    );
  }

  private async finishAcceptedAnswer(
    call: QuestionCall,
    updateInteraction: SurfaceQuestionInteractionUpdater,
  ): Promise<ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>> {
    this.#waiters.get(call.questionCallId)?.onActivity?.();
    if (call.state === "answered") {
      this.clearQuestionTimeout(call.questionCallId);
      const finished = await updateInteraction({
        state: "answered",
        summary: questionSummary(call),
      });
      finished.match({
        ok: () => undefined,
        err: (error) =>
          this.input.logger.warn("Question presentation cleanup failed", {
            questionCallId: call.questionCallId,
            errorTag: error._tag,
            errorMessage: error.message,
          }),
      });
      this.#waiters.get(call.questionCallId)?.resolve(Result.ok(call.answers));
      return Result.ok("accepted");
    }
    this.resetQuestionTimeout(call.questionCallId);
    const issued = issuePrompt(call);
    const replaced = this.input.store.replaceTokens(call.questionCallId, issued.tokens);
    const replaceError = replaced.match({
      ok: () => null,
      err: (error) => error,
    });
    if (replaceError) return await this.cancelAcceptedAnswer(call, replaceError, replaceError);
    const updated = await updateInteraction({
      state: "pending",
      prompt: issued.prompt,
    });
    const updateError = updated.match({
      ok: () => null,
      err: (error) => error,
    });
    if (!updateError) return Result.ok("accepted");
    return await this.cancelAcceptedAnswer(
      call,
      presentationFailure("update", updateError),
      updateError,
    );
  }

  private async cancelAcceptedAnswer(
    call: QuestionCall,
    waiterError: QuestionServiceError,
    failure: { readonly message: string },
  ): Promise<ResultType<never, SurfaceQuestionAnswerHandlingFailed>> {
    this.input.store.transitionPending(call.questionCallId, "cancelled");
    await this.finishCall(call.questionCallId, "cancelled");
    this.#waiters.get(call.questionCallId)?.resolve(Result.err(waiterError));
    return Result.err(answerHandlingFailure(failure));
  }

  private async handleDismiss(
    activity: SurfaceQuestionActivity<QuestionPlatform>,
  ): Promise<ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>> {
    const validated = this.input.store.validateActivity({
      tokenSha256: sha256(activity.token),
      platform: activity.platform,
      channelId: activity.channelId,
      messageId: activity.messageRef.messageId,
      userId: activity.principal.userId,
    });
    const result = validated.mapError(answerHandlingFailure);
    const outcome = result.match<
      | { value: ValidateQuestionActivityResult; error: null }
      | { value: null; error: SurfaceQuestionAnswerHandlingFailed }
    >({ ok: (value) => ({ value, error: null }), err: (error) => ({ value: null, error }) });
    if (outcome.error) return Result.err(outcome.error);
    const value = outcome.value!;
    if (value.disposition !== "accepted") return Result.ok(value.disposition);
    const waiter = this.#waiters.get(value.questionCallId);
    if (!waiter) return Result.ok("stale");
    await this.queueTerminalOperation(value.questionCallId, waiter, () =>
      this.cancelPendingQuestion(value.questionCallId, waiter.resolve),
    );
    const settled = await waiter.completion;
    return settled.match<
      ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>
    >({
      ok: () => Result.ok("stale"),
      err: (error) => {
        if (error._tag === "QuestionCancelled") return Result.ok("accepted");
        if (error._tag === "QuestionTimedOut" || error._tag === "QuestionInterrupted")
          return Result.ok("stale");
        return Result.err(answerHandlingFailure(error));
      },
    });
  }

  private async handleActivity(
    activity: SurfaceQuestionActivity<QuestionPlatform>,
  ): Promise<ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>> {
    const validated = this.input.store.validateActivity({
      tokenSha256: sha256(activity.token),
      platform: activity.platform,
      channelId: activity.channelId,
      messageId: activity.messageRef.messageId,
      userId: activity.principal.userId,
    });
    const outcome = validated.match<
      | { readonly kind: "result"; readonly result: ValidateQuestionActivityResult }
      | { readonly kind: "error"; readonly error: QuestionStoreError }
    >({
      ok: (result) => ({ kind: "result", result }),
      err: (error) => ({ kind: "error", error }),
    });
    if (outcome.kind === "error") return Result.err(answerHandlingFailure(outcome.error));
    if (outcome.result.disposition === "accepted") {
      this.#waiters.get(outcome.result.questionCallId)?.onActivity?.();
      this.resetQuestionTimeout(outcome.result.questionCallId);
    }
    return Result.ok(outcome.result.disposition);
  }

  private async finishCall(
    questionCallId: string,
    state: "cancelled" | "expired" | "interrupted",
  ): Promise<void> {
    const call = this.input.store.getById(questionCallId).match({
      ok: (value) => value,
      err: () => null,
    });
    if (!call) return;
    if (!call.messageId) return;
    const resolved = this.input.surfaces.resolve(call.platform);
    if (!resolved) return;
    const messageRef = {
      platform: call.platform,
      channelId: call.sessionId,
      messageId: call.messageId,
    };
    const port = resolved.question as SurfaceQuestionPort<QuestionPlatform>;
    const finished = await port.finish({ messageRef, state });
    finished.match({
      ok: () => undefined,
      err: (error) =>
        this.input.logger.warn("Question presentation cleanup failed", {
          questionCallId,
          errorTag: error._tag,
          errorMessage: error.message,
        }),
    });
  }
}
