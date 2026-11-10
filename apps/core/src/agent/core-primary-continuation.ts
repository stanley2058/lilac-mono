import { captureError } from "../shared/error-capture";
import { isDeepStrictEqual } from "node:util";

import type { ModelMessage } from "ai";
import {
  hashCanonicalMessagesV1,
  isGeneratedMessage,
  prepareContextHandoff,
  type HistoryProviderState,
  type PrepareModelCall,
} from "@stanley2058/lilac-agent";
import {
  ClaudeAttemptRuntimeOwner,
  ClaudeNativeSessionPreflightError,
  type ClaudeNativeSessionStart,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import type { CorePrimaryLineageV2, StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result, type AnyTaggedError, type Result as ResultType } from "better-result";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";

import {
  computeCorePrimaryClaudeTerminalHead,
  type CoreClaudeAttemptMutationError,
  type CorePrimaryClaudeSessionAttempt,
  type CorePrimaryClaudeSessionBinding,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../transcript/transcript-store";
import {
  projectStoredMessagesV1,
  type StoredMessageProjectionError,
} from "../transcript/stored-message-materialization";
import type { BridgeLogContext } from "../surface/bridge/bridge-log";

const TEXT_REPLAY_TOOL_INPUT_CHARS = 20_000;
const TEXT_REPLAY_TOOL_RESULT_CHARS = 40_000;

function adaptContinuationResultToHost<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

type CorePrimaryContinuationStore = Required<
  Pick<
    TranscriptStore,
    | "getCorePrimaryClaudeSessionBinding"
    | "getCorePrimaryLineageManifest"
    | "getRequestTranscript"
    | "getCorePrimaryClaudeSessionAttempt"
    | "reserveCorePrimaryClaudeSessionAttempt"
    | "recordCorePrimaryClaudeSessionAttemptOutcome"
    | "publishCorePrimaryClaudeSuccess"
    | "promoteCorePrimaryClaudeSessionBinding"
  >
>;

export type CorePrimaryPrefixSelection =
  | { readonly mode: "fork"; readonly canonicalEnd: number }
  | {
      readonly mode: "fresh";
      readonly reason:
        | "fresh-only"
        | "missing-binding"
        | "lineage-version-mismatch"
        | "atom-count-unreachable"
        | "missing-suffix"
        | "prefix-digest-mismatch"
        | "canonical-count-mismatch"
        | "pre-input-head-mismatch"
        | "scope-mismatch"
        | "native-cwd-mismatch"
        | "canonical-alignment-mismatch";
    };

export type CorePrimaryClaudeRuntime = {
  readonly prepareModelCall: PrepareModelCall;
  prepareFullBudgetView(
    canonicalMessages: readonly ModelMessage[],
    canonicalStartIndex?: number,
  ): ModelMessage[];
  prepareHistoryView(canonicalMessages: readonly ModelMessage[]): ModelMessage[];
  inputEstimateFloor(input: {
    readonly canonicalMessages: readonly ModelMessage[];
    readonly overlay: readonly ModelMessage[];
    readonly estimateMessagesTokens: (messages: readonly ModelMessage[]) => number;
  }): number | null;
  recordSuccessfulModelCall(canonicalMessages: readonly ModelMessage[]): Promise<void>;
  retireForRetry(): Promise<void>;
  retireForCanonicalReplacement(): Promise<void>;
  finalize(input: {
    readonly terminalTranscript: TranscriptSnapshot;
    readonly canonicalMessages: readonly ModelMessage[];
    readonly providerState: HistoryProviderState;
    readonly isCancellationRequested: () => boolean;
  }): Promise<boolean>;
  markTerminalFailure(cancelled: boolean): void;
  markUncertain(): void;
  retireAtRunEnd(): Promise<void>;
  currentRun(): MaterializedClaudeCodeRun | null;
};

export function supportsCorePrimaryContinuationStore(
  store: TranscriptStore,
): store is TranscriptStore & CorePrimaryContinuationStore {
  return (
    typeof store.getCorePrimaryClaudeSessionBinding === "function" &&
    typeof store.getCorePrimaryLineageManifest === "function" &&
    typeof store.getRequestTranscript === "function" &&
    typeof store.getCorePrimaryClaudeSessionAttempt === "function" &&
    typeof store.reserveCorePrimaryClaudeSessionAttempt === "function" &&
    typeof store.recordCorePrimaryClaudeSessionAttemptOutcome === "function" &&
    typeof store.publishCorePrimaryClaudeSuccess === "function" &&
    typeof store.promoteCorePrimaryClaudeSessionBinding === "function"
  );
}

export function selectCorePrimaryClaudePrefix(input: {
  readonly lineage: CorePrimaryLineageV2 | undefined;
  readonly canonicalMessages: readonly ModelMessage[];
  readonly canonicalStoredMessages?: readonly StoredMessageV1[];
  readonly binding: CorePrimaryClaudeSessionBinding | null;
  readonly executionScopeHash: string;
  readonly executionCwd: string;
}): CorePrimaryPrefixSelection {
  if (input.lineage?.state !== "complete") return { mode: "fresh", reason: "fresh-only" };
  const latestRequest = input.lineage.segments
    .flatMap((segment) => segment.atoms)
    .findLast((atom) => atom.kind === "request");
  if (latestRequest?.kind === "request" && latestRequest.providerFamily !== "claude-code")
    return { mode: "fresh", reason: "fresh-only" };
  const binding = input.binding;
  if (!binding) return { mode: "fresh", reason: "missing-binding" };
  if (binding.lineageVersion !== input.lineage.lineageVersion) {
    return { mode: "fresh", reason: "lineage-version-mismatch" };
  }
  const segment = input.lineage.segments.find(
    (candidate) => candidate.cumulativeAtomCount === binding.atomCount,
  );
  if (!segment) return { mode: "fresh", reason: "atom-count-unreachable" };
  if (segment.cumulativePrefixDigest !== binding.prefixDigest) {
    return { mode: "fresh", reason: "prefix-digest-mismatch" };
  }
  if (segment.canonicalEnd !== binding.canonicalMessageCount) {
    return { mode: "fresh", reason: "canonical-count-mismatch" };
  }
  if (segment.canonicalEnd !== input.lineage.currentCanonicalStart) {
    return { mode: "fresh", reason: "pre-input-head-mismatch" };
  }
  if (
    binding.executionScopeHashVersion !== 1 ||
    binding.executionScopeHash !== input.executionScopeHash
  ) {
    return { mode: "fresh", reason: "scope-mismatch" };
  }
  if (binding.nativeCwd !== input.executionCwd) {
    return { mode: "fresh", reason: "native-cwd-mismatch" };
  }
  if (
    !isDeepStrictEqual(
      input.lineage.segments.flatMap((candidate) => candidate.canonicalMessages),
      input.canonicalStoredMessages ?? input.canonicalMessages,
    )
  ) {
    return { mode: "fresh", reason: "canonical-alignment-mismatch" };
  }
  return { mode: "fork", canonicalEnd: segment.canonicalEnd };
}

export function shouldReplayCorePrimaryHistory(input: {
  readonly lineage: CorePrimaryLineageV2 | undefined;
  readonly historicalEnd: number;
  readonly store: Pick<TranscriptStore, "getRequestTranscript">;
  readonly targetFamily: "claude-code" | "ai-sdk";
}): boolean {
  if (input.historicalEnd <= 0) return false;
  if (input.lineage?.state !== "complete") return true;
  for (const segment of input.lineage.segments) {
    if (segment.canonicalStart >= input.historicalEnd) break;
    const atom = segment.atoms[0];
    if (atom?.kind === "request") {
      if (atom.providerFamily !== input.targetFamily || atom.containsCrossFamilyTurns) return true;
      continue;
    }
    if (atom?.kind === "checkpoint") {
      const transcript = input.store.getRequestTranscript?.({
        requestId: atom.requestId,
      });
      const state = transcript?.match({
        ok: (value) => value?.providerState,
        err: () => undefined,
      });
      if (!state || state.lastFamily !== input.targetFamily || state.containsCrossFamilyTurns) {
        return true;
      }
      continue;
    }
    if (
      segment.canonicalMessages.some(
        (message) => message.role === "assistant" || message.role === "tool",
      )
    ) {
      return true;
    }
  }
  return false;
}

export function prepareCorePrimaryHistoryView(input: {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly lineage: CorePrimaryLineageV2 | undefined;
  readonly replayHistoricalPrefix: boolean;
  readonly sourceProviderState?: HistoryProviderState;
  readonly targetFamily: "claude-code" | "ai-sdk";
  readonly modelSpecifier: string;
  readonly canonicalStartIndex?: number;
}): ModelMessage[] {
  if (!input.lineage) {
    const currentStart = Math.max(
      0,
      input.canonicalMessages.findLastIndex(
        (message) => message.role === "user" && !isGeneratedMessage(message),
      ),
    );
    const history = input.canonicalMessages.slice(0, currentStart);
    const foreignTools = history.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "tool-call" &&
            Boolean(part.providerExecuted) !== (input.targetFamily === "claude-code"),
        ),
    );
    const crossed =
      input.sourceProviderState !== undefined &&
      input.sourceProviderState.lastFamily !== input.targetFamily;
    if (!foreignTools && !crossed) return [...input.canonicalMessages];
    return [...prepareContextHandoff(history), ...input.canonicalMessages.slice(currentStart)];
  }
  if (!input.replayHistoricalPrefix) return [...input.canonicalMessages];
  const requestedHistoricalEnd = Math.max(
    0,
    Math.min(
      input.canonicalMessages.length,
      (input.lineage?.currentCanonicalStart ?? 0) - (input.canonicalStartIndex ?? 0),
    ),
  );
  const structuralToolExchangeStart =
    requestedHistoricalEnd === input.canonicalMessages.length ||
    input.canonicalMessages[requestedHistoricalEnd]?.role === "tool"
      ? completedToolExchangeStart(input.canonicalMessages, requestedHistoricalEnd)
      : null;
  // A continuation-triggering tool result must remain structural even if a stale
  // lineage boundary classifies the whole transcript as portable history.
  const historicalEnd = structuralToolExchangeStart ?? requestedHistoricalEnd;
  return [
    ...prepareContextHandoff(input.canonicalMessages.slice(0, historicalEnd), {
      providerFamily: input.targetFamily,
      modelSpecifier: input.modelSpecifier,
      maxToolInputChars: TEXT_REPLAY_TOOL_INPUT_CHARS,
      maxToolResultChars: TEXT_REPLAY_TOOL_RESULT_CHARS,
    }),
    ...input.canonicalMessages.slice(historicalEnd),
  ];
}

function completedToolExchangeStart(messages: readonly ModelMessage[], end: number): number | null {
  if (end <= 0) return null;

  let firstToolIndex = messages[end]?.role === "tool" ? end : end - 1;
  if (messages[firstToolIndex]?.role !== "tool") return null;
  while (firstToolIndex > 0 && messages[firstToolIndex - 1]?.role === "tool") {
    firstToolIndex -= 1;
  }

  let toolEnd = firstToolIndex;
  while (toolEnd < messages.length && messages[toolEnd]?.role === "tool") {
    toolEnd += 1;
  }

  const assistantIndex = firstToolIndex - 1;
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return null;

  const unresolved = new Set<string>();
  for (const part of assistant.content) {
    if (part.type === "tool-call") {
      if (unresolved.has(part.toolCallId)) return null;
      unresolved.add(part.toolCallId);
    } else if (part.type === "tool-result" && !unresolved.delete(part.toolCallId)) {
      return null;
    }
  }
  if (unresolved.size === 0) return null;

  for (let index = firstToolIndex; index < toolEnd; index += 1) {
    const message = messages[index];
    if (message?.role !== "tool") return null;
    for (const part of message.content) {
      if (part.type !== "tool-result" || !unresolved.delete(part.toolCallId)) return null;
    }
  }

  return unresolved.size === 0 ? assistantIndex : null;
}

function lineageFingerprint(lineage: CorePrimaryLineageV2 | undefined): string {
  if (!lineage) return "missing";
  if (lineage.state === "fresh-only") {
    return `fresh-only:${lineage.reason}:${lineage.currentCanonicalStart}`;
  }
  const last = lineage.segments[lineage.segments.length - 1];
  return last
    ? `complete:${lineage.currentCanonicalStart}:${last.cumulativeAtomCount}:${last.cumulativePrefixDigest}:${last.canonicalEnd}`
    : "complete:empty";
}

export function createCorePrimaryClaudeRuntime(input: {
  readonly store: CorePrimaryContinuationStore;
  readonly sessionId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly modelSpecifier: string;
  readonly reasoning: string;
  readonly executionScopeHash: string;
  readonly executionCwd: string;
  readonly getLineage: () => CorePrimaryLineageV2 | undefined;
  readonly projectCanonicalStoredMessages?: (
    messages: readonly ModelMessage[],
  ) => ResultType<StoredMessageV1[], StoredMessageProjectionError>;
  readonly materialize: (start: ClaudeNativeSessionStart) => Promise<MaterializedClaudeCodeRun>;
  readonly onDiagnostic?: (event: string, detail: BridgeLogContext, error?: AnyTaggedError) => void;
}): ResultType<CorePrimaryClaudeRuntime, CoreClaudeAttemptMutationError> {
  const sourceBindingResult = input.store.getCorePrimaryClaudeSessionBinding({
    providerId: input.providerId,
    requestClient: "discord",
    lilacSessionId: input.sessionId,
  });
  return sourceBindingResult.match<
    () => ResultType<CorePrimaryClaudeRuntime, CoreClaudeAttemptMutationError>
  >({
    err: (error) => () => Result.err(error),
    ok: (sourceBinding) => () => {
      let selectedPayload: {
        readonly mode: "full" | "suffix";
        readonly fresh: boolean;
      } | null = null;
      let currentAttempt: CorePrimaryClaudeSessionAttempt | null = null;
      let currentAttemptLineageFingerprint: string | null = null;
      const diagnostic = (event: string, detail: BridgeLogContext = {}, error?: AnyTaggedError) =>
        input.onDiagnostic?.(
          event,
          {
            requestId: input.requestId,
            sessionId: input.sessionId,
            requestClient: "discord",
            providerId: input.providerId,
            model: input.modelSpecifier,
            reasoning: input.reasoning,
            bindingHead: sourceBinding?.prefixDigest ?? null,
            bindingRevision: sourceBinding?.revision ?? null,
            ...detail,
          },
          error,
        );

      const projectCanonicalStoredMessages =
        input.projectCanonicalStoredMessages ?? projectStoredMessagesV1;
      const selectionFor = (
        canonicalMessages: readonly ModelMessage[],
      ): CorePrimaryPrefixSelection => {
        const canonicalStoredMessages = projectCanonicalStoredMessages(canonicalMessages).match({
          ok: (messages) => messages,
          err: () => undefined,
        });
        return selectCorePrimaryClaudePrefix({
          lineage: input.getLineage(),
          canonicalMessages,
          canonicalStoredMessages,
          binding: sourceBinding,
          executionScopeHash: input.executionScopeHash,
          executionCwd: input.executionCwd,
        });
      };

      const recordAttemptOutcome = (state: "failed" | "cancelled" | "uncertain"): void => {
        const attempt = currentAttempt;
        if (!attempt) return;
        const recorded = input.store.recordCorePrimaryClaudeSessionAttemptOutcome({
          providerId: input.providerId,
          requestClient: "discord",
          lilacSessionId: input.sessionId,
          requestId: input.requestId,
          attemptIndex: attempt.attemptIndex,
          state,
        });
        const recordError = recorded.match({
          ok: () => null,
          err: (error) => error,
        });
        if (recordError) {
          diagnostic("attempt-outcome-failed", { outcome: state }, recordError);
          return;
        }
        diagnostic("attempt-outcome", {
          outcome: state,
          attemptIndex: attempt.attemptIndex,
          candidateSessionId: attempt.candidateSessionId,
          sourceSessionId: attempt.sourceSessionId,
        });
        currentAttempt = null;
        currentAttemptLineageFingerprint = null;
      };

      const materializeAttempt = async (
        attemptIndex: number,
        binding: CorePrimaryClaudeSessionBinding | null,
        canonicalEnd: number,
      ) => {
        const candidateSessionId = crypto.randomUUID();
        const reserved = input.store.reserveCorePrimaryClaudeSessionAttempt({
          providerId: input.providerId,
          requestClient: "discord",
          lilacSessionId: input.sessionId,
          executionScopeHashVersion: 1,
          executionScopeHash: input.executionScopeHash,
          requestId: input.requestId,
          attemptIndex,
          candidateSessionId,
          sourceSessionId: binding?.claudeSessionId ?? null,
          expectedBindingRevision: sourceBinding?.revision ?? null,
        });
        const attempt = adaptContinuationResultToHost(reserved);
        currentAttempt = attempt;
        currentAttemptLineageFingerprint = lineageFingerprint(input.getLineage());
        diagnostic("attempt-materialized", {
          mode: binding ? "fork" : "fresh",
          reason: binding ? "exact-binding" : "fresh-selection",
          attemptIndex: attempt.attemptIndex,
          candidateSessionId,
          sourceSessionId: binding?.claudeSessionId ?? null,
        });
        {
          const attempt = await Result.tryPromise({
            try: async () => {
              const run = await input.materialize(
                binding
                  ? {
                      mode: "fork",
                      baseSessionId: binding.claudeSessionId,
                      sessionId: candidateSessionId,
                      expectedSourceLastModified: binding.nativeLastModified,
                    }
                  : { mode: "fresh", sessionId: candidateSessionId },
              );
              return Result.ok({
                run,
                modelSpecifier: input.modelSpecifier,
                initialPayload: binding
                  ? ({ mode: "suffix", startIndex: canonicalEnd } as const)
                  : ({ mode: "full" } as const),
              });
            },
            catch: captureError,
          });

          if (attempt.isErr()) {
            const error = attempt.error.cause;
            recordAttemptOutcome("failed");
            throw error;
          }
          return attempt.value;
        }
      };

      const owner = new ClaudeAttemptRuntimeOwner<null>({
        factoryInputs: null,
        createCandidate: async ({ attemptIndex, prepareContext }) => {
          const persistedAttemptIndex = attemptIndex * 2;
          const selection = selectionFor(prepareContext.canonicalMessages);
          const lineage = input.getLineage();
          let mode: "fork" | "text-replay" | "fresh";
          switch (selection.mode) {
            case "fork":
              mode = "fork";
              break;
            case "fresh":
              mode = shouldReplayCorePrimaryHistory({
                lineage,
                historicalEnd: lineage?.currentCanonicalStart ?? 0,
                store: input.store,
                targetFamily: "claude-code",
              })
                ? "text-replay"
                : "fresh";
              break;
            default: {
              const _exhaustive: never = selection;
              mode = _exhaustive;
              break;
            }
          }
          diagnostic("selection", {
            mode,
            ...(selection.mode === "fresh" ? { reason: selection.reason } : {}),
            ...(selection.mode === "fork" ? { reason: "exact-binding" } : {}),
          });
          if (selection.mode === "fork" && sourceBinding) {
            {
              const attempt = await Result.tryPromise({
                try: async () => {
                  const materialized = await materializeAttempt(
                    persistedAttemptIndex,
                    sourceBinding,
                    selection.canonicalEnd,
                  );
                  return {
                    status: "return",
                    value: adaptContinuationResultToHost(materialized),
                  } as const;
                },
                catch: captureError,
              });
              if (attempt.isErr()) {
                const error = attempt.error.cause;
                if (!(error instanceof ClaudeNativeSessionPreflightError)) throw error;
                diagnostic("native-source-invalid", {
                  issues: error.issues.map((issue) => issue.code).join(","),
                  mode: "fresh",
                  reason: "native-source-invalid",
                });
              } else if (attempt.value.status === "return") return attempt.value.value;
            }
          }
          const materialized = await materializeAttempt(
            persistedAttemptIndex + (selection.mode === "fork" ? 1 : 0),
            null,
            0,
          );
          return adaptContinuationResultToHost(materialized);
        },
      });

      const prepareModelCall: PrepareModelCall = async (context) => {
        if (
          currentAttempt &&
          currentAttemptLineageFingerprint !== lineageFingerprint(input.getLineage())
        ) {
          recordAttemptOutcome("failed");
          await owner.retireForCanonicalReplacement();
        }
        const cursor = owner.state.cursor;
        if (
          currentAttempt &&
          cursor &&
          hashCanonicalMessagesV1(context.canonicalMessages.slice(0, cursor.canonicalMessageCount))
            .hash !== cursor.canonicalPrefixHash
        ) {
          recordAttemptOutcome("failed");
        }
        const prepared = await owner.prepare(context);
        selectedPayload = {
          mode: prepared.payload.mode,
          fresh:
            owner.currentCandidate?.run.nativeSession?.getObservation().sourceSessionId === null,
        };
        return prepared;
      };

      return Result.ok({
        prepareModelCall,
        prepareFullBudgetView: (canonicalMessages, canonicalStartIndex = 0) => {
          const lineage = input.getLineage();
          return prepareCorePrimaryHistoryView({
            canonicalMessages,
            lineage,
            replayHistoricalPrefix: shouldReplayCorePrimaryHistory({
              lineage,
              historicalEnd: lineage?.currentCanonicalStart ?? 0,
              store: input.store,
              targetFamily: "claude-code",
            }),
            targetFamily: "claude-code",
            modelSpecifier: input.modelSpecifier,
            canonicalStartIndex,
          });
        },
        prepareHistoryView: (canonicalMessages) => {
          const selected = selectedPayload;
          selectedPayload = null;
          const lineage = input.getLineage();
          const historicalEnd = lineage?.currentCanonicalStart ?? 0;
          const replayHistoricalPrefix =
            selected?.mode === "full" &&
            selected.fresh &&
            shouldReplayCorePrimaryHistory({
              lineage,
              historicalEnd,
              store: input.store,
              targetFamily: "claude-code",
            });
          return prepareCorePrimaryHistoryView({
            canonicalMessages,
            lineage,
            replayHistoricalPrefix,
            targetFamily: "claude-code",
            modelSpecifier: input.modelSpecifier,
          });
        },
        inputEstimateFloor: ({ canonicalMessages, overlay, estimateMessagesTokens }) => {
          const cursor = owner.state.cursor;
          const cursorMatches =
            cursor !== null &&
            cursor.canonicalMessageCount <= canonicalMessages.length &&
            hashCanonicalMessagesV1(canonicalMessages.slice(0, cursor.canonicalMessageCount))
              .hash === cursor.canonicalPrefixHash;
          const selection = selectionFor(canonicalMessages);
          const binding = selection.mode === "fork" ? sourceBinding : null;
          const synchronizedMessageCount = cursorMatches
            ? cursor.canonicalMessageCount
            : binding?.canonicalMessageCount;
          if (synchronizedMessageCount === undefined) return null;
          const cursorIsBindingHead =
            cursorMatches &&
            binding !== null &&
            cursor.canonicalMessageCount === binding.canonicalMessageCount;
          let storedNativeContextTokens = binding?.nativeContextTokens;
          if (cursorMatches && !cursorIsBindingHead) {
            storedNativeContextTokens = undefined;
          }
          return owner.getNativeInputEstimateFloor({
            storedNativeContextTokens,
            unsynchronizedSuffixAndOverlayEstimate: estimateMessagesTokens([
              ...canonicalMessages.slice(synchronizedMessageCount),
              ...overlay,
            ]),
          });
        },
        recordSuccessfulModelCall: async (canonicalMessages) => {
          {
            const attempt = await Result.tryPromise({
              try: async () => {
                await owner.recordSuccessfulModelCall(canonicalMessages);
                if (owner.state.phase !== "unusable")
                  return { status: "return", value: undefined } as const;
                throw new Error(owner.state.unusableReason ?? "Claude native observability failed");
              },
              catch: captureError,
            });
            if (attempt.isErr()) {
              const error = attempt.error.cause;
              recordAttemptOutcome("failed");
              await owner.retireForCanonicalReplacement();
              diagnostic("candidate-observability-lost", {
                mode: "fresh",
                reason: "native-observability-lost",
                error: opaqueErrorMessage(error, "Unknown continuation failure"),
              });
            } else if (attempt.value.status === "return") return attempt.value.value;
          }
          return undefined as never;
        },
        retireForRetry: async () => {
          recordAttemptOutcome("failed");
          await owner.retireForRetry();
        },
        retireForCanonicalReplacement: async () => {
          recordAttemptOutcome("failed");
          await owner.retireForCanonicalReplacement();
        },
        finalize: async ({
          terminalTranscript,
          canonicalMessages,
          providerState,
          isCancellationRequested,
        }) => {
          const attempt = currentAttempt;
          const candidate = owner.currentCandidate;
          const cursor = owner.state.cursor;
          const canonicalHash = hashCanonicalMessagesV1(canonicalMessages).hash;
          const manifest = input.store.getCorePrimaryLineageManifest({
            requestId: terminalTranscript.requestId,
          });
          const manifestValue = manifest.match({
            ok: (value) => value,
            err: () => null,
          });
          if (
            !attempt ||
            !candidate?.run.nativeSession ||
            !manifestValue ||
            cursor === null ||
            cursor.canonicalMessageCount !== canonicalMessages.length ||
            cursor.canonicalPrefixHash !== canonicalHash ||
            terminalTranscript.messages.length === 0 ||
            terminalTranscript.transcriptDigest === undefined
          ) {
            recordAttemptOutcome("failed");
            return false;
          }
          const expectedCanonicalMessages = [
            ...manifestValue.segments.flatMap((segment) => segment.canonicalMessages),
            ...terminalTranscript.messages,
          ];
          const storedCanonicalMessages = projectCanonicalStoredMessages(canonicalMessages).match({
            ok: (messages) => messages,
            err: () => null,
          });
          if (
            storedCanonicalMessages === null ||
            !isDeepStrictEqual(expectedCanonicalMessages, storedCanonicalMessages)
          ) {
            recordAttemptOutcome("failed");
            return false;
          }
          const terminalHead = computeCorePrimaryClaudeTerminalHead({
            manifest: manifestValue,
            requestId: terminalTranscript.requestId,
            transcriptDigest: terminalTranscript.transcriptDigest,
            responseMessageCount: terminalTranscript.messages.length,
            providerState,
          });
          const terminalHeadValue = terminalHead.match({
            ok: (value) => value,
            err: () => null,
          });
          if (
            !terminalHeadValue ||
            terminalHeadValue.canonicalMessageCount !== canonicalMessages.length
          ) {
            recordAttemptOutcome("failed");
            return false;
          }
          const verifiedTerminalHead = terminalHeadValue;
          if (isCancellationRequested()) {
            recordAttemptOutcome("cancelled");
            return false;
          }
          const finalizedResult = await candidate.run.nativeSession.finalizeResult();
          const finalizationError = finalizedResult.match({
            ok: () => null,
            err: (error) => error,
          });
          if (finalizationError) {
            recordAttemptOutcome(isCancellationRequested() ? "cancelled" : "failed");
            diagnostic(
              "candidate-finalization-failed",
              { reason: "native-finalization-failed" },
              finalizationError,
            );
            return false;
          }
          const finalized = finalizedResult.match({
            ok: (value) => value,
            err: () => null,
          });
          if (!finalized) return false;
          if (isCancellationRequested()) {
            recordAttemptOutcome("cancelled");
            return false;
          }
          if (
            finalized.status !== "promotable" ||
            finalized.candidate === null ||
            finalized.observations.contextTokens === null ||
            finalized.observations.contextMaxTokens === null
          ) {
            recordAttemptOutcome("failed");
            diagnostic("candidate-unpromotable", {
              reason: "native-finalization-unpromotable",
              issues: finalized.issues.map((issue) => issue.code).join(","),
            });
            return false;
          }
          if (isCancellationRequested()) {
            recordAttemptOutcome("cancelled");
            return false;
          }
          let publicationRecovered = false;
          const attemptedPublication = Result.try({
            try: () =>
              input.store.publishCorePrimaryClaudeSuccess({
                providerId: input.providerId,
                requestClient: "discord",
                lilacSessionId: input.sessionId,
                requestId: input.requestId,
                attemptIndex: attempt.attemptIndex,
                terminalRequestId: terminalTranscript.requestId,
                terminalLineageVersion: verifiedTerminalHead.lineageVersion,
                terminalAtomCount: verifiedTerminalHead.atomCount,
                terminalPrefixDigest: verifiedTerminalHead.prefixDigest,
                terminalCanonicalMessageCount: verifiedTerminalHead.canonicalMessageCount,
                providerState,
                nativeCwd: finalized.candidate!.cwd,
                nativeLastModified: finalized.candidate!.lastModified,
                nativeContextTokens: finalized.observations.contextTokens!,
                nativeContextMaxTokens: finalized.observations.contextMaxTokens!,
                lastModelSpecifier: input.modelSpecifier,
                lastReasoning: input.reasoning,
              }),
            catch: (error) => {
              let message = "Unknown continuation failure";
              if (typeof error === "string") message = error;
              else if (error instanceof Error) message = error.message;
              return {
                message,
                captured: error instanceof Error ? undefined : error,
              };
            },
          });
          const publicationOutcome = attemptedPublication.match<
            | {
                readonly kind: "success";
                readonly publication: import("better-result").InferOk<typeof attemptedPublication>;
              }
            | {
                readonly kind: "failure";
                readonly failure: import("better-result").InferErr<typeof attemptedPublication>;
              }
          >({
            ok: (publication) => ({ kind: "success" as const, publication }),
            err: (failure) => ({ kind: "failure" as const, failure }),
          });
          if (publicationOutcome.kind === "success") {
            const publicationError = publicationOutcome.publication.match({
              ok: () => null,
              err: (error) => error,
            });
            if (publicationError) {
              recordAttemptOutcome("failed");
              diagnostic(
                "canonical-publication-failed",
                { reason: "transcript-publication-error" },
                publicationError,
              );
              return false;
            }
          } else {
            const persistedState = Result.try({
              try: () =>
                input.store.getCorePrimaryClaudeSessionAttempt({
                  providerId: input.providerId,
                  requestClient: "discord",
                  lilacSessionId: input.sessionId,
                  requestId: input.requestId,
                  attemptIndex: attempt.attemptIndex,
                })?.state ?? null,
              catch: () => null,
            }).match({ ok: (state) => state, err: () => null });
            if (persistedState === "succeeded") {
              publicationRecovered = true;
            } else {
              if (persistedState === "active") {
                recordAttemptOutcome(isCancellationRequested() ? "cancelled" : "failed");
              } else {
                currentAttempt = null;
                currentAttemptLineageFingerprint = null;
              }
              diagnostic("canonical-publication-failed", {
                mode: "canonical-publication",
                reason: "publication-failed",
                persistedState,
                error: publicationOutcome.failure.message,
              });
              return false;
            }
          }
          diagnostic("canonical-published", {
            mode: "canonical-publication",
            reason: publicationRecovered
              ? "verified-after-publication-error"
              : "verified-terminal-head",
            terminalCanonicalMessageCount: verifiedTerminalHead.canonicalMessageCount,
          });
          diagnostic("attempt-outcome", {
            outcome: "succeeded",
            attemptIndex: attempt.attemptIndex,
            candidateSessionId: attempt.candidateSessionId,
            sourceSessionId: attempt.sourceSessionId,
          });
          currentAttempt = null;
          currentAttemptLineageFingerprint = null;
          const promotion = input.store.promoteCorePrimaryClaudeSessionBinding({
            providerId: input.providerId,
            requestClient: "discord",
            lilacSessionId: input.sessionId,
            requestId: input.requestId,
            attemptIndex: attempt.attemptIndex,
          });
          const promotionError = promotion.match({
            ok: () => null,
            err: (error) => error,
          });
          if (promotionError) {
            diagnostic(
              "promotion-failed",
              {
                mode: "cas",
                reason: "promotion-failed",
              },
              promotionError,
            );
            return false;
          }
          const promoted = promotion.match({
            ok: (value) => value,
            err: () => false,
          });
          if (!promoted) {
            diagnostic("promotion-rejected", {
              mode: "cas",
              reason: "promotion-rejected",
              promoted: false,
            });
            return false;
          }
          diagnostic("promotion", {
            mode: "cas",
            reason: "binding-promoted",
            promoted: true,
          });
          return true;
        },
        markTerminalFailure: (cancelled) =>
          recordAttemptOutcome(cancelled ? "cancelled" : "failed"),
        markUncertain: () => recordAttemptOutcome("uncertain"),
        retireAtRunEnd: () => owner.retireAtRunEnd(),
        currentRun: () => owner.currentCandidate?.run ?? null,
      });
    },
  })();
}
