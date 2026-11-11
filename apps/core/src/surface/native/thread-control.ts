import { randomUUID } from "node:crypto";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import type { DurableResolvedModelRequest, ModelReasoningEffort } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import {
  SurfaceInvalidInput,
  SurfacePermissionDenied,
  SurfaceUnavailable,
  type SurfaceOperation,
  type SurfaceOperationError,
} from "../adapter";
import {
  projectThreadTimeline,
  type SurfaceThreadControlPort,
  type ThreadControlCaller,
  type ThreadSendMode,
  type ThreadSendResult,
} from "../thread-control";
import { nativeSurfaceError } from "./adapter";
import { nativeThreadId } from "./native-protocol";
import { NativeStoreFailure } from "./errors";
import { NATIVE_AUTO_STEER_COMMAND_PREFIX, type NativeStore } from "./store";
import type { NativeSurfaceStore } from "./store-surface";

export type NativeThreadControlDependencies = {
  readonly store: NativeStore;
  readonly surface: NativeSurfaceStore;
  readonly serviceUserId?: string;
  /** The deployment's cross-thread setting: whether an agent's message also runs the thread. */
  readonly shouldTriggerRun: () => boolean;
  readonly resolveModel: (
    modelId?: string,
    reasoning?: ModelReasoningEffort,
  ) => ResultType<DurableResolvedModelRequest, Error>;
  readonly kick: (threadId: string) => void;
  readonly notifyPostedMessage?: (threadId: string) => void;
  readonly cancel: (
    actorId: string,
    threadId: string,
    runId: string,
  ) => Promise<ResultType<void, Error>>;
  readonly now?: () => number;
};

function invalid(operation: SurfaceOperation, field: string, message: string) {
  return new SurfaceInvalidInput({ platform: "native", operation, field, message });
}

function cancellationError(error: Error): SurfaceOperationError {
  if (NativeStoreFailure.is(error)) return nativeSurfaceError("send-message", error);
  return new SurfaceUnavailable({
    platform: "native",
    operation: "send-message",
    message: error.message,
  });
}

const SEND_DISPOSITIONS = {
  prompt: "started",
  followup: "queued",
  steer: "steered",
} as const satisfies Record<string, ThreadSendResult["disposition"]>;

/**
 * Commands are scoped to the user, so a stable key per user makes retries idempotent. An `auto`
 * send carries the prefix that lets the store turn a steer that missed its run into a follow-up.
 */
function commandIdentity(commandId: string | undefined, mode: ThreadSendMode): string {
  const prefix = mode === "auto" ? NATIVE_AUTO_STEER_COMMAND_PREFIX : "agent-send-";
  if (!commandId) return `${prefix}${randomUUID()}`;
  return `${prefix}${digest(commandId)}`;
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 40);
}

export function createNativeThreadControl(
  dependencies: NativeThreadControlDependencies,
): SurfaceThreadControlPort {
  const { store, surface } = dependencies;
  const serviceUserId = dependencies.serviceUserId ?? "lilac";

  /** Agent authority comes from the run's own thread, which its user must have started. */
  function authorizeCaller(caller: ThreadControlCaller, operation: SurfaceOperation) {
    return store
      .authorizeThread(caller.userId, nativeThreadId(caller.sourceThreadId))
      .mapError((error) => nativeSurfaceError(operation, error))
      .andThen((thread) =>
        thread.starterId === caller.userId
          ? Result.ok(thread)
          : Result.err(
              new SurfacePermissionDenied({
                platform: "native",
                operation,
                message: "Agent authority must match the source thread starter",
              }),
            ),
      );
  }

  /** Reports a message's input outcome unless it was simply admitted. */
  function inputStateOf(message: DisplayMessage): string | undefined {
    const inputId = message.metadata?.inputId;
    if (!inputId) return undefined;
    return store.getInput(inputId).match({
      ok: (record) => (record.state === "admitted" ? undefined : record.state),
      err: () => undefined,
    });
  }

  function otherThread(caller: ThreadControlCaller, threadId: string, operation: SurfaceOperation) {
    const id = nativeThreadId(threadId);
    if (id === nativeThreadId(caller.sourceThreadId))
      return Result.err(invalid(operation, "id", "This run already belongs to that thread"));
    return Result.ok(id);
  }

  return {
    async read(caller, threadId, input) {
      return Result.gen(function* () {
        yield* authorizeCaller(caller, "list-messages");
        const id = nativeThreadId(threadId);
        const thread = yield* store
          .authorizeThread(caller.userId, id)
          .mapError((error) => nativeSurfaceError("list-messages", error));
        const rows = yield* surface
          .listMessages(caller.userId, id, {
            limit: input.limit,
            ...(input.before ? { beforeMessageId: input.before } : {}),
            ...(input.after ? { afterMessageId: input.after } : {}),
          })
          .mapError((error) => nativeSurfaceError("list-messages", error));
        const first = rows[0]?.message.id;
        const last = rows.at(-1)?.message.id ?? input.after;
        return Result.ok({
          threadId: id,
          title: thread.title,
          activeRunId: thread.activeRunId ?? null,
          items: projectThreadTimeline(
            rows.map((row) => row.message),
            input.view,
            input.maxCharsPerItem,
            inputStateOf,
          ),
          hasMore: Boolean(first && rows.length >= input.limit),
          ...(first && rows.length >= input.limit ? { before: first } : {}),
          ...(last ? { after: last } : {}),
        });
      });
    },

    async send(caller, threadId, input) {
      return Result.gen(function* () {
        yield* authorizeCaller(caller, "send-message");
        const id = yield* otherThread(caller, threadId, "send-message");
        const thread = yield* store
          .authorizeThread(caller.userId, id, true)
          .mapError((error) => nativeSurfaceError("send-message", error));
        const message: DisplayMessage = {
          // A retried post with the same key lands on the same message, which the store keeps once.
          id: input.commandId
            ? `agent-post-${digest(`${caller.userId}:${id}:${input.commandId}`)}`
            : randomUUID(),
          role: "assistant",
          metadata: {
            phase: "final",
            authorId: serviceUserId,
            createdAt: (dependencies.now ?? Date.now)(),
          },
          parts: [{ type: "text", text: input.text }],
        };
        if (!dependencies.shouldTriggerRun()) {
          yield* store
            .postMessage(caller.userId, id, message)
            .mapError((error) => nativeSurfaceError("send-message", error));
          dependencies.notifyPostedMessage?.(id);
          return Result.ok({ disposition: "posted" as const, messageId: message.id });
        }
        const model = yield* dependencies
          .resolveModel(thread.modelId, thread.reasoning)
          .mapError((error) => invalid("send-message", "model", error.message));
        const nativeInput = {
          threadId: id,
          commandId: commandIdentity(input.commandId, input.mode),
          historyGeneration: thread.historyGeneration,
          text: input.text,
          attachmentIds: [],
          skillIds: [],
          // The store admits steer or queue as a new prompt when the thread is idle.
          mode: input.mode === "queue" ? ("followup" as const) : ("steer" as const),
        };
        const replayed = yield* store
          .lookupInputReceipt(caller.userId, nativeInput)
          .mapError((error) => nativeSurfaceError("send-message", error));
        const receipt =
          replayed ??
          (yield* store
            .acceptSurfaceInput(caller.userId, nativeInput, serviceUserId, message, model)
            .mapError((error) => nativeSurfaceError("send-message", error)));
        dependencies.kick(id);
        const accepted = yield* store
          .getInput(receipt.inputId)
          .mapError((error) => nativeSurfaceError("send-message", error));
        const runId = accepted.mode === "steer" ? accepted.runId : accepted.requestId;
        return Result.ok({
          disposition: SEND_DISPOSITIONS[accepted.mode],
          messageId: receipt.messageId,
          ...(runId ? { runId } : {}),
        });
      });
    },

    async interrupt(caller, threadId, input) {
      return Result.gen(async function* () {
        yield* authorizeCaller(caller, "send-message");
        const id = yield* otherThread(caller, threadId, "send-message");
        const thread = yield* store
          .authorizeThread(caller.userId, id, true)
          .mapError((error) => nativeSurfaceError("send-message", error));
        const active = thread.activeRunId;
        if (input.runId && input.runId !== active)
          return Result.ok({ status: "ended" as const, runId: input.runId });
        if (!active) return Result.ok({ status: "idle" as const });
        yield* Result.await(
          dependencies
            .cancel(caller.userId, id, active)
            .then((result) => result.mapError(cancellationError)),
        );
        return Result.ok({ status: "cancelled" as const, runId: active });
      });
    },
  };
}
