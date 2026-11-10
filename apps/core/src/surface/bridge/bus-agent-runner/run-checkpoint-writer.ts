import type { ModelMessage } from "ai";
import { Panic, Result } from "better-result";
import type { AgentInputQueueId } from "@stanley2058/lilac-agent";
import type { NativeOutputFrontier, StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type { createLogger } from "@stanley2058/lilac-utils";

import {
  McpImageCheckpointRegistry,
  materializeMcpImageCheckpoint,
} from "../../../mcp/image-checkpoint";
import { captureError } from "../../../shared/error-capture";
import type { StoredMessageIdentityProjectionV1 } from "../../../transcript/stored-message-materialization";
import {
  AgentRunCheckpointOwnershipRollbackFailed,
  AgentRunCheckpointPreparationFailed,
  persistBlobBackedAgentRunCheckpoint,
} from "../agent-run-checkpoint-persistence";
import {
  AgentRunJournalConflict,
  type AgentRunCheckpointV1,
  type AgentRunJournalHandle,
} from "../agent-run-journal";
import { formatBridgeTaggedErrorForLog } from "../bridge-log";
import type { startBusAgentRunner } from "../bus-agent-runner";
import type { RequestDeliveryTerminalOutcome } from "../request-delivery";
import { projectBusAgentRunnerError } from "./errors";
import { settlesBefore, type Enqueued, type SessionQueue } from "./session-queue";

type RunCheckpointWriterParams = Pick<
  Parameters<typeof startBusAgentRunner>[0],
  "agentRunJournal" | "blobStore" | "transcriptStore"
>;

/**
 * Owns the agent-run journal for one runner: opens and resets runs, writes checkpoints in a
 * serialized latest-pending-wins worker, restores predecessors, and records terminal markers.
 */
export function createRunCheckpointWriter(context: {
  readonly params: RunCheckpointWriterParams;
  readonly logger: ReturnType<typeof createLogger>;
  readonly bySession: ReadonlyMap<string, SessionQueue>;
  readonly reportFatalPanic: (panic: Panic) => void;
}) {
  const { params, logger, bySession, reportFatalPanic } = context;
  let activeAgentRunJournal = params.agentRunJournal ?? null;

  const logJournalReset = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly error: Error;
  }): void => {
    logger.warn("agent run journal reset", {
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      errorTag: input.error.name,
    });
  };

  const releaseRunCheckpointBlobs = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): void => {
    const releaseError = params.transcriptStore
      ?.releaseAgentRunCheckpointBlobs?.({ requestDeliveryId: input.requestDeliveryId })
      .match({ ok: () => null, err: (error) => error });
    if (!releaseError) return;
    logger.warn(
      "agent run checkpoint blob reference cleanup deferred",
      formatBridgeTaggedErrorForLog(releaseError, input),
    );
  };

  const resetRunJournal = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): boolean => {
    const journal = activeAgentRunJournal;
    if (!journal) return false;
    const reset = journal.resetRun(input.requestDeliveryId);
    const resetError = reset.match({ ok: () => null, err: (error) => error });
    if (!resetError) {
      releaseRunCheckpointBlobs(input);
      return true;
    }
    logJournalReset({ ...input, error: resetError });
    activeAgentRunJournal = null;
    return false;
  };

  const openRunJournal = (input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly sessionId: string;
  }): AgentRunJournalHandle | null => {
    const journal = activeAgentRunJournal;
    if (!journal) return null;
    const opened = journal.openRun(input);
    const decision = opened.match<
      | { readonly kind: "opened"; readonly handle: AgentRunJournalHandle }
      | { readonly kind: "reset"; readonly error: Error }
    >({
      ok: (handle) => ({ kind: "opened", handle }),
      err: (error) => ({ kind: "reset", error }),
    });
    if (decision.kind === "opened") return decision.handle;
    logJournalReset({ ...input, error: decision.error });
    if (!resetRunJournal(input)) return null;
    return journal.openRun(input).match({
      ok: (handle) => handle,
      err: (error) => {
        logJournalReset({ ...input, error });
        activeAgentRunJournal = null;
        return null;
      },
    });
  };

  const persistRunCheckpoint = async (
    run: NonNullable<SessionQueue["activeRun"]>,
    messages: readonly ModelMessage[],
    canonicalInputIds: readonly AgentInputQueueId[],
    identityProjection: StoredMessageIdentityProjectionV1,
    nativeOutputFrontier?: NativeOutputFrontier,
  ): Promise<"written" | "kept-previous"> => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = run.requestDeliveryId;
    if (!journal || !requestDeliveryId || run.checkpointWriter.disabled) return "written";
    const nextCheckpointedRetainedRequestDeliveryIds = new Set(
      run.checkpointedRetainedRequestDeliveryIds,
    );
    for (const inputId of canonicalInputIds) {
      const retainedRequestDeliveryId = run.retainedRequestDeliveryByInputId.get(inputId);
      if (!retainedRequestDeliveryId) continue;
      nextCheckpointedRetainedRequestDeliveryIds.add(retainedRequestDeliveryId);
    }
    const owner = {
      requestDeliveryId,
      requestId: run.requestId,
      sessionId: run.sessionId,
    };
    const handle = run.journalHandle ?? openRunJournal(owner);
    if (!handle) return activeAgentRunJournal ? "kept-previous" : "written";
    const persisted = await persistBlobBackedAgentRunCheckpoint({
      mcpImages: run.mcpImages,
      nativeOutput: nativeOutputFrontier,
      handle,
      journal,
      messages,
      previousCheckpoint: {
        providerMessages: run.checkpointWriter.lastCommittedProviderMessages,
        storedMessages: run.checkpointWriter.lastCommittedStoredMessages,
      },
      retainedPredecessorMessages: run.checkpointWriter.retainedPredecessorStoredMessages,
      identityProjection,
      blobStore: params.blobStore,
      transcriptStore: params.transcriptStore,
      shouldAbandon: () => run.checkpointWriter.abandoned,
      ...(run.corePrimaryLineage ? { corePrimaryLineage: run.corePrimaryLineage } : {}),
      loadedCatalogIds: run.toolAuthority.snapshot(),
      questionResultIds: run.questionContinuation.checkpoint(messages),
      ...(run.currentTurnUserId ? { currentTurnUserId: run.currentTurnUserId } : {}),
      retainedRequestDeliveries: [...run.retainedRequestDeliveries]
        .filter(([retainedRequestDeliveryId]) =>
          nextCheckpointedRetainedRequestDeliveryIds.has(retainedRequestDeliveryId),
        )
        .map(([retainedRequestDeliveryId, outcome]) => ({
          requestDeliveryId: retainedRequestDeliveryId,
          outcome,
        })),
    });
    const decision = persisted.match<
      | {
          readonly kind: "written";
          readonly handle: AgentRunJournalHandle;
          readonly messages: readonly StoredMessageV1[];
          readonly advanced: boolean;
          readonly cleanupError?: Error;
        }
      | { readonly kind: "kept-previous"; readonly error: Error }
    >({
      ok: ({ handle: nextHandle, messages: storedMessages, advanced, cleanupError }) => ({
        kind: "written",
        handle: nextHandle,
        messages: storedMessages,
        advanced,
        ...(cleanupError ? { cleanupError } : {}),
      }),
      err: (error) => ({ kind: "kept-previous", error }),
    });
    if (decision.kind === "kept-previous") {
      logger.warn(
        "agent run checkpoint kept previous",
        formatBridgeTaggedErrorForLog(decision.error, {
          requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          ...(AgentRunCheckpointPreparationFailed.is(decision.error)
            ? { stage: decision.error.stage }
            : {}),
        }),
      );
      const journalError = AgentRunCheckpointOwnershipRollbackFailed.is(decision.error)
        ? decision.error.journalError
        : decision.error;
      if (AgentRunCheckpointOwnershipRollbackFailed.is(decision.error)) {
        logger.warn(
          "agent run checkpoint blob reference cleanup deferred",
          formatBridgeTaggedErrorForLog(decision.error.cleanupError, {
            requestDeliveryId,
            requestId: run.requestId,
            sessionId: run.sessionId,
          }),
        );
      }
      if (AgentRunJournalConflict.is(journalError)) {
        run.journalHandle = openRunJournal(owner);
        run.checkpointWriter.disabled = true;
      }
      return "kept-previous";
    }
    const priorCommittedCheckpointMessages = run.checkpointWriter.lastCommittedStoredMessages;
    run.journalHandle = decision.handle;
    if (decision.advanced) {
      run.checkpointWriter.retainedPredecessorStoredMessages = priorCommittedCheckpointMessages;
    }
    run.checkpointWriter.lastCommittedProviderMessages = messages;
    run.checkpointWriter.lastCommittedStoredMessages = decision.messages;
    for (const inputId of canonicalInputIds) {
      run.retainedRequestDeliveryByInputId.delete(inputId);
    }
    run.checkpointedRetainedRequestDeliveryIds = nextCheckpointedRetainedRequestDeliveryIds;
    if (decision.cleanupError) {
      logger.warn(
        "agent run checkpoint blob reference cleanup deferred",
        formatBridgeTaggedErrorForLog(decision.cleanupError, {
          requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
        }),
      );
    }
    return "written";
  };

  const enqueueRunCheckpoint = (
    run: NonNullable<SessionQueue["activeRun"]>,
    messages: readonly ModelMessage[],
    canonicalInputIds: readonly AgentInputQueueId[],
    identityProjection: StoredMessageIdentityProjectionV1,
  ): void => {
    if (
      run.checkpointWriter.closed ||
      run.checkpointWriter.disabled ||
      !activeAgentRunJournal ||
      !run.requestDeliveryId
    ) {
      return;
    }
    if (run.nativeOutput?.hasPendingText()) {
      for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.add(inputId);
      return;
    }
    const nativeCheckpoint = run.nativeOutput?.captureCheckpoint();
    const nativeOutputBarrier = nativeCheckpoint?.barrier;
    const pendingInputIds = new Set(run.checkpointWriter.pending?.canonicalInputIds ?? []);
    for (const inputId of canonicalInputIds) pendingInputIds.add(inputId);
    run.checkpointWriter.pending = {
      messages,
      canonicalInputIds: pendingInputIds,
      identityProjection,
      nativeOutputBarrier,
      nativeOutputFrontier: nativeCheckpoint?.frontier,
    };
    startRunCheckpointWriter(run);
  };

  function startRunCheckpointWriter(run: NonNullable<SessionQueue["activeRun"]>): void {
    if (run.checkpointWriter.operation || !run.checkpointWriter.pending) return;
    const operation = deferRunCheckpointWriter(run);
    run.checkpointWriter.operation = operation;
  }

  async function deferRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await superviseRunCheckpointWriter(run);
  }

  async function superviseRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    const completed = await Result.tryPromise({
      try: () => drainRunCheckpointWriter(run),
      catch: captureError,
    });
    const failure = completed.match({
      ok: () => null,
      err: ({ cause }) => ({ cause }),
    });
    const inFlightInputIds = run.checkpointWriter.inFlightInputIds;
    run.checkpointWriter.inFlightInputIds = null;
    run.checkpointWriter.operation = null;
    if (failure) {
      for (const inputId of inFlightInputIds ?? []) {
        run.checkpointWriter.retryInputIds.add(inputId);
      }
      if (Panic.is(failure.cause)) {
        reportFatalPanic(failure.cause);
      } else {
        const error = projectBusAgentRunnerError(
          failure.cause,
          "Agent run checkpoint background write failed",
        );
        logger.error("agent run checkpoint background write failed", {
          requestDeliveryId: run.requestDeliveryId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          errorMessage: error.message,
        });
      }
    }
    if (run.checkpointWriter.pending) startRunCheckpointWriter(run);
  }

  async function drainRunCheckpointWriter(
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> {
    while (run.checkpointWriter.pending) {
      const pending = run.checkpointWriter.pending;
      run.checkpointWriter.pending = null;
      const canonicalInputIds = new Set(run.checkpointWriter.retryInputIds);
      for (const inputId of pending.canonicalInputIds) canonicalInputIds.add(inputId);
      run.checkpointWriter.inFlightInputIds = canonicalInputIds;
      const outputFailure = pending.nativeOutputBarrier
        ? (await pending.nativeOutputBarrier).match({ ok: () => null, err: (error) => error })
        : null;
      if (outputFailure) {
        for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.add(inputId);
        run.checkpointWriter.inFlightInputIds = null;
        logger.error(
          "native output prevented run checkpoint",
          formatBridgeTaggedErrorForLog(outputFailure, {
            requestId: run.requestId,
            sessionId: run.sessionId,
          }),
        );
        continue;
      }
      const outcome = await persistRunCheckpoint(
        run,
        pending.messages,
        [...canonicalInputIds],
        pending.identityProjection,
        pending.nativeOutputFrontier,
      );
      run.checkpointWriter.inFlightInputIds = null;
      if (outcome === "kept-previous") {
        for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.add(inputId);
        continue;
      }
      for (const inputId of canonicalInputIds) run.checkpointWriter.retryInputIds.delete(inputId);
    }
  }

  const flushRunCheckpointWriter = async (
    run: NonNullable<SessionQueue["activeRun"]>,
  ): Promise<void> => {
    run.checkpointWriter.closed = true;
    while (run.checkpointWriter.operation) {
      await run.checkpointWriter.operation;
    }
  };

  const stopRunCheckpointWriters = async (deadlineAtMs: number): Promise<void> => {
    const operations = [...bySession.values()].flatMap((state) => {
      const run = state.activeRun;
      if (!run) return [];
      run.checkpointWriter.closed = true;
      run.checkpointWriter.abandoned = true;
      run.checkpointWriter.pending = null;
      return run.checkpointWriter.operation ? [run.checkpointWriter.operation] : [];
    });
    if (operations.length === 0) return;
    if (await settlesBefore(operations, deadlineAtMs)) return;
    logger.warn("agent run checkpoint writes exceeded shutdown wait", {
      deadlineAtMs,
      pendingCount: operations.length,
    });
  };

  const restorePreviousRunCheckpoint = async (input: {
    readonly entry: Enqueued;
    readonly checkpoint: AgentRunCheckpointV1;
  }): Promise<AgentRunJournalHandle | null> => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = input.entry.requestDeliveryId;
    if (!journal || !requestDeliveryId || !journal.promotePreviousCheckpoint) return null;
    const owner = {
      requestDeliveryId,
      requestId: input.entry.requestId,
      sessionId: input.entry.sessionId,
    };
    const currentHandle = input.entry.journalHandle;
    if (!currentHandle) return null;
    const promoted = journal.promotePreviousCheckpoint(currentHandle, input.checkpoint);
    const decision = promoted.match<
      | {
          readonly kind: "restored";
          readonly handle: AgentRunJournalHandle;
        }
      | { readonly kind: "failed"; readonly error: Error }
    >({
      ok: (handle) => ({ kind: "restored", handle }),
      err: (error) => ({ kind: "failed", error }),
    });
    if (decision.kind === "failed") {
      logger.warn(
        "agent run previous checkpoint restore failed",
        formatBridgeTaggedErrorForLog(decision.error, owner),
      );
      return null;
    }
    const cleanupError = params.transcriptStore?.replaceAgentRunCheckpointBlobs
      ?.call(params.transcriptStore, {
        requestDeliveryId,
        messages: input.checkpoint.messages,
      })
      .match({ ok: () => undefined, err: (error) => error });
    if (cleanupError) {
      logger.warn(
        "agent run checkpoint blob reference cleanup deferred",
        formatBridgeTaggedErrorForLog(cleanupError, owner),
      );
    }
    return decision.handle;
  };

  const materializePreviousRunCheckpoint = async (input: {
    readonly imageRegistry: McpImageCheckpointRegistry;
    readonly entry: Enqueued;
    readonly identityProjection: StoredMessageIdentityProjectionV1;
  }): Promise<
    | {
        readonly kind: "restored";
        readonly checkpoint: AgentRunCheckpointV1;
        readonly messages: ModelMessage[];
        readonly handle: AgentRunJournalHandle;
      }
    | { readonly kind: "unavailable" }
  > => {
    const checkpoint = input.entry.previousRecoveryCheckpoint;
    if (!checkpoint) return { kind: "unavailable" };
    const materialized = await materializeMcpImageCheckpoint({
      imageRegistry: input.imageRegistry,
      mcpImages: checkpoint.mcpImages,
      messages: checkpoint.messages,
      blobStore: params.blobStore,
      identityProjection: input.identityProjection,
    });
    const decision = materialized.match<
      | { readonly kind: "messages"; readonly messages: ModelMessage[] }
      | { readonly kind: "unavailable"; readonly error: Error }
    >({
      ok: (messages) => ({ kind: "messages", messages }),
      err: (error) => ({ kind: "unavailable", error }),
    });
    if (decision.kind === "unavailable") {
      logger.warn(
        "agent run previous checkpoint blob unavailable",
        formatBridgeTaggedErrorForLog(decision.error, {
          requestDeliveryId: input.entry.requestDeliveryId,
          requestId: input.entry.requestId,
          sessionId: input.entry.sessionId,
        }),
      );
      return { kind: "unavailable" };
    }
    const handle = await restorePreviousRunCheckpoint({
      entry: input.entry,
      checkpoint,
    });
    return handle
      ? { kind: "restored", checkpoint, messages: decision.messages, handle }
      : { kind: "unavailable" };
  };

  const installPreviousRunCheckpoint = (input: {
    readonly entry: Enqueued;
    readonly recovery: NonNullable<Enqueued["recovery"]>;
    readonly checkpoint: AgentRunCheckpointV1;
    readonly messages: ModelMessage[];
    readonly handle: AgentRunJournalHandle;
  }): void => {
    logger.warn("agent run checkpoint restore used previous checkpoint", {
      requestDeliveryId: input.entry.requestDeliveryId,
      requestId: input.entry.requestId,
      sessionId: input.entry.sessionId,
    });
    input.recovery.checkpointMessages = input.messages;
    input.recovery.nativeOutputFrontier = input.checkpoint.nativeOutput;
    input.entry.questionResultIds = input.checkpoint.questionResultIds;
    input.entry.storedRecoveryCheckpoint = [...input.checkpoint.messages];
    input.entry.recoveryMcpImages = input.checkpoint.mcpImages;
    input.entry.retainedRequestDeliveries = input.checkpoint.retainedRequestDeliveries;
    input.entry.journalHandle = input.handle;
    input.entry.corePrimaryLineage =
      input.checkpoint.corePrimaryLineage ?? input.entry.acceptedCorePrimaryLineage;
    if (input.checkpoint.loadedCatalogIds) {
      input.entry.loadedCatalogIds = [...input.checkpoint.loadedCatalogIds];
    } else {
      delete input.entry.loadedCatalogIds;
    }
    input.entry.currentTurnUserId =
      input.checkpoint.currentTurnUserId ?? input.entry.acceptedCurrentTurnUserId;
    input.entry.currentTurnMessageRef = input.checkpoint.currentTurnUserId
      ? undefined
      : input.entry.authenticatedOrigin?.messageRef;
    delete input.entry.previousRecoveryCheckpoint;
  };

  const fallBackRunCheckpointToAcceptedWork = (input: {
    readonly entry: Enqueued;
    readonly error: Error;
  }): void => {
    logger.warn(
      "agent run checkpoint restore fell back to accepted work",
      formatBridgeTaggedErrorForLog(input.error, {
        requestDeliveryId: input.entry.requestDeliveryId,
        requestId: input.entry.requestId,
        sessionId: input.entry.sessionId,
      }),
    );
    if (input.entry.requestDeliveryId) {
      resetRunJournal({
        requestDeliveryId: input.entry.requestDeliveryId,
        requestId: input.entry.requestId,
        sessionId: input.entry.sessionId,
      });
    }
    delete input.entry.recovery;
    delete input.entry.storedRecoveryCheckpoint;
    delete input.entry.recoveryMcpImages;
    delete input.entry.previousRecoveryCheckpoint;
    delete input.entry.retainedRequestDeliveries;
    delete input.entry.journalHandle;
    delete input.entry.loadedCatalogIds;
    input.entry.corePrimaryLineage = input.entry.acceptedCorePrimaryLineage;
    input.entry.currentTurnUserId = input.entry.acceptedCurrentTurnUserId;
    input.entry.currentTurnMessageRef = input.entry.authenticatedOrigin?.messageRef;
  };

  const markRunTerminal = (
    run: NonNullable<SessionQueue["activeRun"]>,
    outcome: RequestDeliveryTerminalOutcome,
    finalReplayDeadline: number | undefined,
  ): void => {
    const journal = activeAgentRunJournal;
    const requestDeliveryId = run.requestDeliveryId;
    if (!journal || !requestDeliveryId) return;
    const owner = {
      requestDeliveryId,
      requestId: run.requestId,
      sessionId: run.sessionId,
    };
    const handle = run.journalHandle ?? openRunJournal(owner);
    if (!handle) return;
    const terminal = journal.markTerminal(handle, {
      outcome,
      ...(finalReplayDeadline === undefined ? {} : { finalReplayDeadline }),
    });
    terminal.match({
      ok: (nextHandle) => {
        run.journalHandle = nextHandle;
      },
      err: (error) => {
        logJournalReset({ ...owner, error });
        resetRunJournal(owner);
        run.journalHandle = null;
      },
    });
  };

  return {
    journal: () => activeAgentRunJournal,
    releaseRunCheckpointBlobs,
    openRunJournal,
    enqueueRunCheckpoint,
    flushRunCheckpointWriter,
    stopRunCheckpointWriters,
    materializePreviousRunCheckpoint,
    installPreviousRunCheckpoint,
    fallBackRunCheckpointToAcceptedWork,
    markRunTerminal,
  };
}
