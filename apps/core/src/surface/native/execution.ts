import { isDeepStrictEqual } from "node:util";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import {
  EventPublishContractInvalid,
  lilacEventTypes,
  type LilacBus,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";
import { CUSTOM_COMMAND_TEXT_PREFIX } from "@stanley2058/lilac-utils/custom-commands";
import type { CustomCommandManager } from "../../custom-commands/manager";
import type { TranscriptStore } from "../../transcript/transcript-store";
import { parseNativeRequestEnvelope } from "../authenticated-request";
import { deleteDiscordRequestBlobHandles } from "../bridge/request-composition/attachments";
import { prepareStoredMessagesForBus } from "../bridge/request-composition/prepare-bus-messages";
import { escapeSurfaceMetadataTags, formatSurfaceMetadataLine } from "../bridge/surface-metadata";
import type { NativeRunnerLifecycle, NativeRunnerRequest } from "../bridge/bus-agent-runner";
import type { NativeInputRecord } from "./codec";
import { nativeFailure, NativeStoreFailure } from "./errors";
import { nativeSessionId } from "./native-protocol";
import type { NativeStore } from "./store";
import type { NativeMetrics } from "./metrics";

export type NativeRunnerControl = {
  cancelNativeSession(sessionId: string): Promise<ResultType<void, Error>>;
};

export function createNativeExecution(options: {
  metrics?: NativeMetrics;
  store: NativeStore;
  bus: Pick<LilacBus, "publish">;
  transcriptStore: TranscriptStore;
  blobStore?: BlobStore;
  runner: () => NativeRunnerControl | undefined;
  customCommands?: CustomCommandManager;
  expandReferences?: (
    userId: string,
    text: string,
  ) => Promise<ResultType<string, Error>> | ResultType<string, Error>;
  validateSkill?: (skillId: string, starterId: string) => boolean;
  getOldMessageSelectionMaxAgeMs?: () => number | undefined;
  now?: () => number;
  deliveryState?: (
    deliveryId: string,
  ) => ResultType<"missing" | "owned" | "completed" | "failed" | "cancelled", Error>;
}) {
  const { store } = options;
  const publications = new Map<string, Promise<ResultType<void, Error>>>();
  const cancelingThreads = new Set<string>();
  let accepting = true;

  function validate(request: NativeRunnerRequest): ReturnType<NativeRunnerLifecycle["validate"]> {
    return Result.gen(function* () {
      const native = parseNativeRequestEnvelope(request);
      if (!native)
        return Result.err(nativeFailure("invalid", "Native request metadata is invalid"));
      const input = yield* store.getInput(native.inputId);
      const thread = yield* store.authorizeThread(input.initiatingUserId, input.threadId, true);
      const starter = yield* store.getUser(thread.starterId);
      if (!input.resolvedModelRequest)
        return Result.err(nativeFailure("invalid", "Native input has no pinned model selection"));
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      if (
        input.state !== "admitted" ||
        thread.deleted ||
        thread.mutationPending ||
        input.historyGeneration !== thread.historyGeneration ||
        native.historyGeneration !== input.historyGeneration ||
        native.threadId !== input.threadId ||
        native.turnId !== input.turnId ||
        native.authorUserId !== input.authorId ||
        native.starterUserId !== starter.id ||
        native.requestDeliveryId !== input.deliveryId ||
        request.requestDeliveryId !== input.deliveryId ||
        request.requestId !== requestId ||
        native.requestId !== requestId ||
        request.sessionId !== nativeSessionId(input.threadId)
      )
        return Result.err(
          nativeFailure("stale", "Native request no longer matches its accepted intent"),
        );
      if (input.mode === "steer" && thread.activeRunId !== input.runId) {
        yield* store.settleInput(input.id, "target-ended");
        return Result.err(nativeFailure("stale", "The steering target has ended"));
      }
      return Result.ok({
        safetyMode:
          input.pinnedToolMode === "full" ? ("trusted" as const) : ("restricted" as const),
        resolvedModelRequest: input.resolvedModelRequest,
      });
    });
  }

  function selectedHistory(
    input: NativeInputRecord,
    latestRequestId: string,
    canonical: readonly StoredMessageV1[],
  ): ResultType<{ messages: readonly StoredMessageV1[]; firstRequestId?: string }, Error> {
    return Result.gen(function* () {
      const empty = { messages: [] as readonly StoredMessageV1[] };
      if (input.canonicalHistoryStartRequestId === input.requestId) return Result.ok(empty);
      const requestIds = yield* store.listCanonicalRequestIds(input.threadId);
      const retained = yield* Result.all(
        requestIds.map((requestId) => store.getInputByRequestId(requestId)),
      );
      const fullTurns = retained.filter(
        (turn): turn is NativeInputRecord =>
          turn !== null && turn.mode !== "steer" && turn.completedAt !== undefined,
      );
      const indices = new Map(fullTurns.map((turn, index) => [turn.requestId, index]));
      const latestIndex = indices.get(latestRequestId);
      if (latestIndex === undefined)
        return Result.err(nativeFailure("invalid", "Canonical history has no retained turn"));
      const maxAgeMs = options.getOldMessageSelectionMaxAgeMs?.();
      const cutoff =
        maxAgeMs === undefined ? -Infinity : (options.now?.() ?? Date.now()) - maxAgeMs;
      const firstEligible = input.canonicalHistoryStartRequestId
        ? (indices.get(input.canonicalHistoryStartRequestId) ?? -1)
        : fullTurns.findIndex((turn) => turn.createdAt >= cutoff);
      if (firstEligible < 0) return Result.ok(empty);
      const snapshots = new Map<string, readonly StoredMessageV1[]>([[latestRequestId, canonical]]);
      const pending: { messages: readonly StoredMessageV1[]; startIndex: number }[] = [];
      let snapshotIndex = latestIndex;
      let selectedIndex = firstEligible;
      let selected: { messages: readonly StoredMessageV1[]; firstRequestId?: string } = empty;
      while (true) {
        const turn = fullTurns[snapshotIndex];
        if (!turn) return Result.ok(empty);
        let messages = snapshots.get(turn.requestId);
        if (!messages) {
          const snapshot = yield* (
            options.transcriptStore.getRequestTranscript?.({ requestId: turn.requestId }) ??
              Result.ok(null)
          );
          if (!snapshot) return Result.ok(empty);
          messages = snapshot.messages;
          snapshots.set(turn.requestId, messages);
        }
        const sourceIndex = turn.canonicalHistoryStartRequestId
          ? indices.get(turn.canonicalHistoryStartRequestId)
          : 0;
        if (sourceIndex === undefined || sourceIndex > snapshotIndex) return Result.ok(empty);
        if (selectedIndex <= sourceIndex) {
          selected = { messages, firstRequestId: fullTurns[sourceIndex]!.requestId };
          break;
        }
        pending.push({ messages, startIndex: selectedIndex });
        snapshotIndex = selectedIndex - 1;
        selectedIndex = sourceIndex;
      }
      for (const boundary of pending.toReversed()) {
        if (
          !isDeepStrictEqual(
            boundary.messages.slice(0, selected.messages.length),
            selected.messages,
          )
        )
          return Result.ok(empty);
        selected = {
          messages: boundary.messages.slice(selected.messages.length),
          firstRequestId: fullTurns[boundary.startIndex]!.requestId,
        };
      }
      return Result.ok(selected);
    });
  }

  async function inputMessages(
    input: NativeInputRecord,
  ): Promise<ResultType<StoredMessageV1[], Error>> {
    return Result.gen(async function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      for (const skillId of input.skillIds) {
        if (!options.validateSkill?.(skillId, thread.starterId))
          return Result.err(nativeFailure("invalid", `Skill '${skillId}' is unavailable`));
      }
      const skillText = input.skillIds.map((skillId) => `Use the skill $${skillId}.`).join("\n");
      const author = yield* store.getUser(input.authorId);
      const header = formatSurfaceMetadataLine({
        platform: "native",
        thread_id: input.threadId,
        user_id: author.id,
        user_name: author.displayName || `user_${author.id}`,
        message_id: input.messageId,
        message_time: new Date(input.createdAt).toISOString(),
      });
      const expanded = options.expandReferences
        ? yield* Result.await(
            Promise.resolve(options.expandReferences(thread.starterId, input.text)),
          )
        : input.text;
      const body = skillText ? `${skillText}\n\n${expanded}` : expanded;
      const text = `${header}\n${escapeSurfaceMetadataTags(body)}`;
      const parts: Extract<StoredMessageV1, { role: "user" }>["content"] = [{ type: "text", text }];
      for (const attachmentId of input.attachmentIds) {
        const attachment = yield* store.getUpload(attachmentId);
        if (attachment.state !== "ready" || !attachment.resourceUri)
          return Result.err(nativeFailure("conflict", "Attachment is not ready for model input"));
        yield* store.authorizeThread(thread.starterId, attachment.threadId);
        parts.push({
          type: "resource",
          uri: attachment.resourceUri,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          size: attachment.size,
        });
      }
      const message: StoredMessageV1 = { role: "user", content: parts };
      if (input.mode === "steer") return Result.ok([message]);
      const previousRequestId = yield* store.getLatestCanonicalRequestId(input.threadId);
      if (!previousRequestId) {
        yield* store.setInputCanonicalHistoryStart(input.id, input.requestId);
        return Result.ok([message]);
      }
      const previous = yield* (
        options.transcriptStore.getRequestTranscript?.({ requestId: previousRequestId }) ??
          Result.ok(null)
      );
      if (!previous)
        return Result.err(
          nativeFailure("conflict", "The retained canonical transcript is unavailable"),
        );
      const history = yield* selectedHistory(input, previousRequestId, previous.messages);
      yield* store.setInputCanonicalHistoryStart(
        input.id,
        history.messages.length > 0 ? (history.firstRequestId ?? input.requestId) : input.requestId,
      );
      return Result.ok([...history.messages, message]);
    });
  }

  function commandMetadata(input: NativeInputRecord): ResultType<object, Error> {
    if (!input.command) return Result.ok({});
    const name = input.command.id.replace(/^custom:/u, "");
    const manager = options.customCommands;
    if (!manager?.get(name))
      return Result.err(nativeFailure("invalid", "Custom command is unavailable"));
    return manager
      .parseText(`/${CUSTOM_COMMAND_TEXT_PREFIX}${name} ${input.command.arguments}`)
      .andThen((invocation) => {
        if (!invocation)
          return Result.err(nativeFailure("invalid", "Custom command could not be parsed"));
        return Result.ok({
          customCommand: {
            name,
            args: invocation.args,
            prompt: invocation.prompt ?? undefined,
            text: invocation.text,
            source: "text",
          },
        });
      });
  }

  async function publishInput(input: NativeInputRecord): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      const messages = yield* Result.await(inputMessages(input));
      const custom = yield* commandMetadata(input);
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      if (!input.turnId || !requestId)
        return Result.err(nativeFailure("invalid", "Native input has no admitted turn"));
      if (input.mode !== "steer" && thread.activeRunId !== requestId)
        yield* store.setActiveRun(input.threadId, input.historyGeneration, requestId);
      const prepared = yield* Result.await(
        prepareStoredMessagesForBus({ blobStore: options.blobStore, messages }),
      );
      const published = await options.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: input.deliveryId,
          queue: input.mode === "steer" ? "steer" : "prompt",
          messages: prepared.messages,
          ...(input.mode !== "steer" && input.modelId ? { modelOverride: input.modelId } : {}),
          raw: {
            native: {
              threadId: input.threadId,
              authorUserId: input.authorId,
              starterUserId: thread.starterId,
              turnId: input.turnId,
              historyGeneration: input.historyGeneration,
              inputId: input.id,
              requestId,
              requestDeliveryId: input.deliveryId,
            },
            authenticatedActor: { platform: "native", userId: thread.starterId },
            authenticatedOrigin: {
              platform: "native",
              userId: thread.starterId,
              messageRef: {
                platform: "native",
                channelId: input.threadId,
                messageId: input.messageId,
              },
            },
            ...(input.mode === "steer" ? { requiresActive: true } : {}),
            ...custom,
          },
        },
        {
          headers: {
            request_id: requestId,
            session_id: nativeSessionId(input.threadId),
            request_client: "native",
          },
        },
      );
      const contractError = published.match({
        ok: () => undefined,
        err: (error) => (EventPublishContractInvalid.is(error) ? error : undefined),
      });
      if (contractError && options.blobStore)
        yield* Result.await(
          deleteDiscordRequestBlobHandles(options.blobStore, prepared.inputHandles).then(
            (cleanup) =>
              cleanup.mapError(
                (error) =>
                  new AggregateError(
                    [contractError, error],
                    "Native request validation and input handle cleanup failed",
                  ),
              ),
          ),
        );
      return published.map(() => undefined);
    });
  }

  async function publishPending(threadId: string): Promise<ResultType<void, Error>> {
    if (cancelingThreads.has(threadId)) return Result.ok(undefined);
    return Result.gen(async function* () {
      const pending = yield* store.listPendingInputs(threadId);
      options.metrics?.queue(
        threadId,
        pending.filter((input) => input.state === "uploading").length,
        pending.filter((input) => input.state === "queued").length,
        pending.filter((input) => input.state === "admitted").length,
      );
      for (const candidate of pending) {
        const thread = yield* store.getThreadRecord(threadId);
        if (thread.mutationPending || thread.deleted) return Result.ok(undefined);
        if (candidate.state === "admitted" && options.deliveryState) {
          const state = yield* options.deliveryState(candidate.deliveryId);
          if (state === "owned") continue;
          if (state !== "missing") {
            yield* completeInput(candidate, state);
            continue;
          }
        }
        if (
          candidate.mode !== "steer" &&
          thread.activeRunId &&
          thread.activeRunId !== candidate.requestId
        )
          continue;
        const prepared = yield* store.prepareInput(candidate.id);
        if (!prepared) continue;
        const admitted = yield* store.settleInput(prepared.id, "admitted");
        const published = await publishInput(admitted);
        const failure = published.match({ ok: () => null, err: (error) => error });
        if (!failure) continue;
        options.metrics?.handoffFailure("admission", admitted.threadId, admitted.requestId);
        if (
          failure instanceof NativeStoreFailure &&
          (failure.code === "invalid" || failure.code === "forbidden")
        )
          yield* store.settleInput(admitted.id, "failed");
        return Result.err(failure);
      }
      return Result.ok(undefined);
    });
  }

  async function kick(threadId?: string): Promise<ResultType<void, Error>> {
    if (!accepting) return Result.ok(undefined);
    if (!threadId) {
      return Result.gen(async function* () {
        const pending = yield* store.listPendingInputs();
        for (const id of new Set(pending.map((input) => input.threadId)))
          yield* Result.await(kick(id));
        return Result.ok(undefined);
      });
    }
    const existing = publications.get(threadId);
    if (existing) {
      return Result.gen(async function* () {
        yield* Result.await(existing);
        yield* Result.await(kick(threadId));
        return Result.ok(undefined);
      });
    }
    const operation = publishPending(threadId);
    publications.set(threadId, operation);
    const result = await operation;
    publications.delete(threadId);
    return result;
  }

  function completeInput(
    input: NativeInputRecord,
    outcome: "completed" | "failed" | "cancelled",
  ): ResultType<void, Error> {
    return Result.gen(function* () {
      const thread = yield* store.getThreadRecord(input.threadId);
      if (thread.historyGeneration !== input.historyGeneration || thread.mutationPending)
        return Result.ok(undefined);
      if (outcome === "cancelled") yield* store.settleInput(input.id, "canceled");
      const requestId = input.mode === "steer" ? input.runId : input.requestId;
      const transcript = requestId
        ? yield* options.transcriptStore.getRequestTranscript?.({ requestId }) ?? Result.ok(null)
        : null;
      if (transcript) yield* store.markInputCompleted(input.id);
      if (!transcript && outcome === "failed") yield* store.settleInput(input.id, "failed");
      if (input.mode !== "steer" && thread.activeRunId === input.requestId)
        yield* store.setActiveRun(input.threadId, input.historyGeneration, undefined);
      return Result.ok(undefined);
    });
  }

  async function settled(
    request: NativeRunnerRequest,
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const native = parseNativeRequestEnvelope(request);
      if (!native)
        return Result.err(nativeFailure("invalid", "Settled native request metadata is invalid"));
      const input = yield* store.getInput(native.inputId);
      yield* completeInput(input, outcome);
      yield* Result.await(kick(native.threadId));
      return Result.ok(undefined);
    });
  }

  async function rejected(deliveryId: string): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const input = yield* store.getInputByDeliveryId(deliveryId);
      if (!input || input.state === "target-ended") return Result.ok(undefined);
      yield* completeInput(input, "cancelled");
      yield* Result.await(kick(input.threadId));
      return Result.ok(undefined);
    });
  }

  async function cancel(
    actorId: string,
    threadId: string,
    runId?: string,
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* store.cancelRun(actorId, threadId, runId);
      cancelingThreads.add(threadId);
      const canceled = await runner.cancelNativeSession(nativeSessionId(threadId));
      cancelingThreads.delete(threadId);
      yield* canceled;
      yield* Result.await(kick(threadId));
      return Result.ok(undefined);
    });
  }

  function reconcileCanonical(threadId: string): ResultType<void, Error> {
    return Result.gen(function* () {
      const requestIds = yield* store.listCanonicalRequestIds(threadId);
      yield* (
        options.transcriptStore.reconcileNativeTranscriptReferences?.({
          sessionId: nativeSessionId(threadId),
          requestIds,
        }) ?? Result.ok(undefined)
      );
      return Result.ok(undefined);
    });
  }

  async function rewind(
    actorId: string,
    request: {
      threadId: string;
      commandId: string;
      turnId: string;
      historyGeneration: number;
      revision: number;
    },
  ): Promise<ResultType<{ text: string; historyGeneration: number }, Error>> {
    return Result.gen(async function* () {
      const rewound = yield* store.beginRewind(actorId, request);
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* Result.await(runner.cancelNativeSession(nativeSessionId(request.threadId)));
      if (rewound.historyGeneration === undefined || rewound.text === undefined)
        return Result.err(nativeFailure("invalid", "Rewind receipt is incomplete"));
      yield* reconcileCanonical(request.threadId);
      yield* store.finishMutation(request.threadId, rewound.historyGeneration);
      return Result.ok({ text: rewound.text, historyGeneration: rewound.historyGeneration });
    });
  }

  async function deleteThread(
    actorId: string,
    request: { threadId: string; commandId: string; historyGeneration?: number },
  ): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const deleted = yield* store.deleteThread(actorId, request);
      const runner = options.runner();
      if (!runner) return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      yield* Result.await(runner.cancelNativeSession(nativeSessionId(request.threadId)));
      if (deleted.historyGeneration === undefined)
        return Result.err(nativeFailure("invalid", "Deletion receipt is incomplete"));
      yield* reconcileCanonical(request.threadId);
      yield* store.finishMutation(request.threadId, deleted.historyGeneration);
      return Result.ok(undefined);
    });
  }

  async function recoverMutations(): Promise<ResultType<void, Error>> {
    return Result.gen(async function* () {
      const pending = yield* store.listPendingMutations();
      const runner = options.runner();
      if (!runner && pending.length)
        return Result.err(nativeFailure("conflict", "Native runner is unavailable"));
      for (const thread of pending) {
        if (runner) yield* Result.await(runner.cancelNativeSession(nativeSessionId(thread.id)));
        yield* reconcileCanonical(thread.id);
        yield* store.finishMutation(thread.id, thread.historyGeneration);
      }
      return Result.ok(undefined);
    });
  }

  async function drainPublications(): Promise<ResultType<void, Error>> {
    accepting = false;
    return Result.all(await Promise.all(publications.values())).map(() => undefined);
  }

  return {
    drainPublications,
    kick,
    cancel,
    rewind,
    deleteThread,
    recoverMutations,
    runnerLifecycle: { validate, settled, rejected } satisfies NativeRunnerLifecycle,
  };
}

export type NativeExecution = ReturnType<typeof createNativeExecution>;
