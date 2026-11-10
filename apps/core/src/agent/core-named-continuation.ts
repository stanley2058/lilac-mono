import { captureError } from "../shared/error-capture";
import { createHash } from "node:crypto";

import { modelMessageSchema, type ModelMessage } from "ai";
import {
  canonicalJsonStringify,
  hashCanonicalMessagesV1,
  hashExecutionScopeV1,
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
import { Result, type AnyTaggedError, type Result as ResultType } from "better-result";
import { opaqueErrorMessage, type SubagentExecution } from "@stanley2058/lilac-utils";

import {
  type CoreClaudeAttemptMutationError,
  type CoreNamedClaudeSessionAttempt,
  type CoreNamedClaudeSessionBinding,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../transcript/transcript-store";
import { hashCanonicalStoredMessagesV2 } from "../transcript/transcript-persistence-codec";
import { projectStoredMessagesV1 } from "../transcript/stored-message-materialization";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type { BridgeLogContext } from "../surface/bridge/bridge-log";

const TEXT_REPLAY_TOOL_INPUT_CHARS = 20_000;
const TEXT_REPLAY_TOOL_RESULT_CHARS = 40_000;

function decodeStoredContinuationModelMessages(
  messages: readonly StoredMessageV1[],
): ModelMessage[] | null {
  const decoded = modelMessageSchema.array().safeParse(messages);
  return decoded.success ? decoded.data : null;
}

function adaptContinuationResultToHost<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw error;
    },
  })();
}

type CoreNamedContinuationStore = Required<
  Pick<
    TranscriptStore,
    | "getCoreNamedClaudeSessionBinding"
    | "getLatestCompleteNamedTranscript"
    | "getRequestTranscript"
    | "getCoreNamedClaudeSessionAttempt"
    | "reserveCoreNamedClaudeSessionAttempt"
    | "recordCoreNamedClaudeSessionAttemptOutcome"
    | "publishCoreNamedClaudeSuccess"
    | "promoteCoreNamedClaudeSessionBinding"
  >
>;

export type CoreNamedClaudeRuntime = {
  readonly prepareModelCall: PrepareModelCall;
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
    readonly storedCanonicalMessages?: readonly StoredMessageV1[];
    readonly providerState: HistoryProviderState;
    readonly isCancellationRequested: () => boolean;
  }): Promise<boolean>;
  markTerminalFailure(cancelled: boolean): void;
  markUncertain(): void;
  retireAtRunEnd(): Promise<void>;
  currentRun(): MaterializedClaudeCodeRun | null;
};

export function supportsCoreNamedContinuationStore(
  store: TranscriptStore,
): store is TranscriptStore & CoreNamedContinuationStore {
  return (
    typeof store.getCoreNamedClaudeSessionBinding === "function" &&
    typeof store.getLatestCompleteNamedTranscript === "function" &&
    typeof store.getRequestTranscript === "function" &&
    typeof store.getCoreNamedClaudeSessionAttempt === "function" &&
    typeof store.reserveCoreNamedClaudeSessionAttempt === "function" &&
    typeof store.recordCoreNamedClaudeSessionAttemptOutcome === "function" &&
    typeof store.publishCoreNamedClaudeSuccess === "function" &&
    typeof store.promoteCoreNamedClaudeSessionBinding === "function"
  );
}

export function shouldReplayCoreNamedHistory(input: {
  readonly sourceTranscript: TranscriptSnapshot | null;
  readonly targetFamily: "claude-code" | "ai-sdk";
}): boolean {
  const source = input.sourceTranscript;
  return (
    source !== null &&
    source.messages.length > 0 &&
    (source.providerState == null ||
      source.providerState.containsCrossFamilyTurns ||
      source.providerState.lastFamily !== input.targetFamily)
  );
}

export function prepareCoreNamedHistoryView(input: {
  readonly canonicalMessages: readonly ModelMessage[];
  readonly sourceMessages: readonly ModelMessage[];
  readonly currentTurnMessages: readonly ModelMessage[];
  readonly replayHistoricalPrefix: boolean;
  readonly targetFamily: "claude-code" | "ai-sdk";
  readonly modelSpecifier: string;
}): ModelMessage[] {
  if (!input.replayHistoricalPrefix || input.sourceMessages.length === 0) {
    return [...input.canonicalMessages];
  }
  const sourceHash = hashCanonicalMessagesV1(input.sourceMessages).hash;
  const exactSourcePrefix =
    input.sourceMessages.length <= input.canonicalMessages.length &&
    hashCanonicalMessagesV1(input.canonicalMessages.slice(0, input.sourceMessages.length)).hash ===
      sourceHash;
  let historicalMessageCount: number;
  if (exactSourcePrefix) {
    historicalMessageCount = input.sourceMessages.length;
  } else if (input.currentTurnMessages.length > 0) {
    const currentTurnHash = hashCanonicalMessagesV1(input.currentTurnMessages).hash;
    historicalMessageCount = input.canonicalMessages.length;
    for (
      let index = input.canonicalMessages.length - input.currentTurnMessages.length;
      index >= 0;
      index -= 1
    ) {
      if (
        hashCanonicalMessagesV1(
          input.canonicalMessages.slice(index, index + input.currentTurnMessages.length),
        ).hash === currentTurnHash
      ) {
        historicalMessageCount = index;
        break;
      }
    }
  } else {
    historicalMessageCount = input.canonicalMessages.length;
  }
  return [
    ...prepareContextHandoff(input.canonicalMessages.slice(0, historicalMessageCount), {
      providerFamily: input.targetFamily,
      modelSpecifier: input.modelSpecifier,
      maxToolInputChars: TEXT_REPLAY_TOOL_INPUT_CHARS,
      maxToolResultChars: TEXT_REPLAY_TOOL_RESULT_CHARS,
    }),
    ...input.canonicalMessages.slice(historicalMessageCount),
  ];
}

function semanticFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function normalizeDirectToolAuthorityName(name: string): string {
  return name === "patch" || name === "edit" ? "workspace_edit" : name;
}

export function coreProfileExecutionScopeAuthority(
  execution: SubagentExecution,
): boolean | SubagentExecution {
  return execution === "native" ? true : execution;
}

export function hashCoreNamedExecutionScope(input: {
  readonly canonicalCwd: string;
  readonly providerIdentity: string;
  readonly nativeStorageNamespaceIdentity: string;
  readonly nativeExecutableConfig: unknown;
  readonly profile: string;
  readonly safetyMode: string;
  readonly profileAuthority: unknown;
  readonly pluginAuthority: unknown;
  readonly workflowAuthority: unknown;
  readonly systemPolicy: unknown;
  readonly directToolNames: readonly string[];
  readonly externalToolAuthority: readonly unknown[];
  readonly subagentAuthority: {
    readonly enabled: boolean;
    readonly maxDepth: number;
    readonly currentDepth: number;
  };
}) {
  const directTools = [
    ...new Set(input.directToolNames.map(normalizeDirectToolAuthorityName)),
  ].sort();
  const effectiveSubagentAuthority = {
    ...input.subagentAuthority,
    available:
      input.subagentAuthority.enabled &&
      input.subagentAuthority.currentDepth < input.subagentAuthority.maxDepth &&
      input.safetyMode !== "restricted" &&
      directTools.includes("subagent_delegate"),
  };
  return hashExecutionScopeV1({
    canonicalCwd: input.canonicalCwd,
    providerIdentity: input.providerIdentity,
    nativeStorageNamespaceIdentity: input.nativeStorageNamespaceIdentity,
    nativeExecutableConfigIdentity: semanticFingerprint(input.nativeExecutableConfig),
    profile: input.profile,
    safetyMode: input.safetyMode,
    effectiveAuthorityFingerprint: semanticFingerprint({
      profile: input.profileAuthority,
      plugins: input.pluginAuthority,
      workflow: input.workflowAuthority,
      subagents: effectiveSubagentAuthority,
    }),
    systemPolicyFingerprint: semanticFingerprint(input.systemPolicy),
    effectiveToolMcpAuthorityFingerprint: semanticFingerprint({
      directTools,
      externalTools: input.externalToolAuthority,
      subagents: effectiveSubagentAuthority,
    }),
  });
}

export function createCoreNamedClaudeRuntime(input: {
  readonly store: CoreNamedContinuationStore;
  readonly requestClient: TranscriptSnapshot["requestClient"];
  readonly sessionId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly modelSpecifier: string;
  readonly reasoning: string;
  readonly executionScopeHash: string;
  readonly executionCwd: string;
  readonly sourceTranscript: TranscriptSnapshot | null;
  readonly sourceMessages?: readonly ModelMessage[];
  readonly getCurrentTurnMessages?: () => readonly ModelMessage[];
  readonly materialize: (start: ClaudeNativeSessionStart) => Promise<MaterializedClaudeCodeRun>;
  readonly onDiagnostic?: (event: string, detail: BridgeLogContext, error?: AnyTaggedError) => void;
}): ResultType<CoreNamedClaudeRuntime, CoreClaudeAttemptMutationError> {
  const sourceMessages =
    input.sourceMessages ??
    decodeStoredContinuationModelMessages(input.sourceTranscript?.messages ?? []) ??
    [];
  const sourceModelHash = hashCanonicalMessagesV1(sourceMessages).hash;
  const sourceStoredHash = hashCanonicalStoredMessagesV2(
    input.sourceTranscript?.messages ?? [],
  ).match({
    ok: (digest) => digest.hash,
    err: () => "invalid-stored-source-transcript",
  });
  const sourceBindingResult = input.store.getCoreNamedClaudeSessionBinding({
    providerId: input.providerId,
    requestClient: input.requestClient,
    lilacSessionId: input.sessionId,
  });
  return sourceBindingResult.match<
    () => ResultType<CoreNamedClaudeRuntime, CoreClaudeAttemptMutationError>
  >({
    err: (error) => () => Result.err(error),
    ok: (sourceBinding) => () => {
      const shouldReplayHistoricalPrefix = shouldReplayCoreNamedHistory({
        sourceTranscript: input.sourceTranscript,
        targetFamily: "claude-code",
      });
      let selectedPayload: { readonly mode: "full" | "suffix"; readonly fresh: boolean } | null =
        null;
      let currentAttempt: CoreNamedClaudeSessionAttempt | null = null;
      const diagnostic = (event: string, detail: BridgeLogContext = {}, error?: AnyTaggedError) =>
        input.onDiagnostic?.(
          event,
          {
            requestId: input.requestId,
            sessionId: input.sessionId,
            requestClient: input.requestClient,
            providerId: input.providerId,
            model: input.modelSpecifier,
            reasoning: input.reasoning,
            bindingHead: sourceBinding?.canonicalHeadHash ?? null,
            bindingRevision: sourceBinding?.revision ?? null,
            ...detail,
          },
          error,
        );

      const bindingIsCompatible = (
        binding: CoreNamedClaudeSessionBinding | null,
        canonicalMessages: readonly ModelMessage[],
      ): binding is CoreNamedClaudeSessionBinding =>
        binding !== null &&
        input.sourceTranscript?.providerState?.lastFamily === "claude-code" &&
        binding.terminalRequestId === input.sourceTranscript.requestId &&
        binding.canonicalHeadHash === sourceStoredHash &&
        binding.canonicalMessageCount === sourceMessages.length &&
        binding.executionScopeHashVersion === 1 &&
        binding.executionScopeHash === input.executionScopeHash &&
        binding.nativeCwd === input.executionCwd &&
        binding.canonicalMessageCount <= canonicalMessages.length &&
        hashCanonicalMessagesV1(canonicalMessages.slice(0, binding.canonicalMessageCount)).hash ===
          sourceModelHash;

      const recordAttemptOutcome = (state: "failed" | "cancelled" | "uncertain"): void => {
        const attempt = currentAttempt;
        if (!attempt) return;
        const recorded = input.store.recordCoreNamedClaudeSessionAttemptOutcome({
          providerId: input.providerId,
          requestClient: input.requestClient,
          lilacSessionId: input.sessionId,
          requestId: input.requestId,
          attemptIndex: attempt.attemptIndex,
          state,
        });
        const recordError = recorded.match({ ok: () => null, err: (error) => error });
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
      };

      const materializeAttempt = async (
        attemptIndex: number,
        binding: CoreNamedClaudeSessionBinding | null,
      ) => {
        const candidateSessionId = crypto.randomUUID();
        const reserved = input.store.reserveCoreNamedClaudeSessionAttempt({
          providerId: input.providerId,
          requestClient: input.requestClient,
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
                  ? ({ mode: "suffix", startIndex: binding.canonicalMessageCount } as const)
                  : ({ mode: "full" } as const),
              });
            },
            catch: captureError,
          });

          if (attempt.isErr()) {
            const error = attempt.error.cause;
            recordAttemptOutcome("failed");
            return adaptContinuationResultToHost(
              Result.err(
                error instanceof Error
                  ? error
                  : new Error("Claude continuation materialization failed"),
              ),
            );
          }
          return attempt.value;
        }
      };

      const owner = new ClaudeAttemptRuntimeOwner<null>({
        factoryInputs: null,
        createCandidate: async ({ attemptIndex, prepareContext }) => {
          const persistedAttemptIndex = attemptIndex * 2;
          const binding = bindingIsCompatible(sourceBinding, prepareContext.canonicalMessages)
            ? sourceBinding
            : null;
          let selectionMode: "fork" | "text-replay" | "fresh";
          if (binding !== null) {
            selectionMode = "fork";
          } else if (shouldReplayHistoricalPrefix) {
            selectionMode = "text-replay";
          } else {
            selectionMode = "fresh";
          }
          let selectionReason: string;
          if (binding !== null) {
            selectionReason = "exact-binding";
          } else if (sourceBinding !== null) {
            selectionReason = "binding-mismatch";
          } else if (shouldReplayHistoricalPrefix) {
            selectionReason = "provider-history-replay";
          } else {
            selectionReason = "missing-binding";
          }
          diagnostic("selection", {
            mode: selectionMode,
            reason: selectionReason,
          });
          if (binding) {
            {
              const attempt = await Result.tryPromise({
                try: async () => {
                  const materialized = await materializeAttempt(persistedAttemptIndex, binding);
                  return {
                    status: "return",
                    value: adaptContinuationResultToHost(materialized),
                  } as const;
                },
                catch: captureError,
              });
              if (attempt.isErr()) {
                const error = attempt.error.cause;
                if (!(error instanceof ClaudeNativeSessionPreflightError)) {
                  return adaptContinuationResultToHost(
                    Result.err(
                      error instanceof Error
                        ? error
                        : new Error("Claude continuation candidate creation failed"),
                    ),
                  );
                }
                diagnostic("native-source-invalid", {
                  issues: error.issues.map((issue) => issue.code).join(","),
                  mode: "fresh",
                  reason: "native-source-invalid",
                });
              } else if (attempt.value.status === "return") return attempt.value.value;
            }
          }
          const materialized = await materializeAttempt(
            persistedAttemptIndex + (binding ? 1 : 0),
            null,
          );
          return adaptContinuationResultToHost(materialized);
        },
      });

      const prepareModelCall: PrepareModelCall = async (context) => {
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
        prepareHistoryView: (canonicalMessages) => {
          const selected = selectedPayload;
          selectedPayload = null;
          return prepareCoreNamedHistoryView({
            canonicalMessages,
            sourceMessages,
            currentTurnMessages: input.getCurrentTurnMessages?.() ?? [],
            replayHistoricalPrefix: selected
              ? selected.mode === "full" && selected.fresh && shouldReplayHistoricalPrefix
              : shouldReplayHistoricalPrefix,
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
          const binding = bindingIsCompatible(sourceBinding, canonicalMessages)
            ? sourceBinding
            : null;
          const synchronizedMessageCount = cursorMatches
            ? cursor.canonicalMessageCount
            : binding?.canonicalMessageCount;
          if (synchronizedMessageCount === undefined) return null;
          const cursorIsBindingHead =
            cursorMatches &&
            binding !== null &&
            cursor.canonicalMessageCount === binding.canonicalMessageCount &&
            cursor.canonicalPrefixHash === sourceModelHash;
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
          storedCanonicalMessages,
          providerState,
          isCancellationRequested,
        }) => {
          const attempt = currentAttempt;
          const candidate = owner.currentCandidate;
          const cursor = owner.state.cursor;
          const canonicalHash = hashCanonicalMessagesV1(canonicalMessages).hash;
          const terminalStoredHash = (
            storedCanonicalMessages
              ? Result.ok(storedCanonicalMessages)
              : projectStoredMessagesV1(canonicalMessages)
          )
            .andThen((messages) => hashCanonicalStoredMessagesV2(messages))
            .match({
              ok: (digest) => digest.hash,
              err: () => "invalid-stored-terminal-transcript",
            });
          const terminalTranscriptMatches = storedCanonicalMessages
            ? hashCanonicalStoredMessagesV2(terminalTranscript.messages).match({
                ok: (terminalDigest) =>
                  hashCanonicalStoredMessagesV2(storedCanonicalMessages).match({
                    ok: (canonicalDigest) => canonicalDigest.hash === terminalDigest.hash,
                    err: () => false,
                  }),
                err: () => false,
              })
            : true;
          if (
            !attempt ||
            !candidate?.run.nativeSession ||
            cursor === null ||
            cursor.canonicalMessageCount !== canonicalMessages.length ||
            cursor.canonicalPrefixHash !== canonicalHash ||
            terminalTranscript.messages.length !== canonicalMessages.length ||
            !terminalTranscriptMatches
          ) {
            recordAttemptOutcome("failed");
            return false;
          }
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
          const finalized = finalizedResult.match({ ok: (value) => value, err: () => null });
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
              input.store.publishCoreNamedClaudeSuccess({
                providerId: input.providerId,
                requestClient: input.requestClient,
                lilacSessionId: input.sessionId,
                requestId: input.requestId,
                attemptIndex: attempt.attemptIndex,
                terminalRequestId: terminalTranscript.requestId,
                terminalCanonicalHeadHash: terminalStoredHash,
                terminalCanonicalMessageCount: canonicalMessages.length,
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
              return { message, captured: error instanceof Error ? undefined : error };
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
                input.store.getCoreNamedClaudeSessionAttempt({
                  providerId: input.providerId,
                  requestClient: input.requestClient,
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
            terminalCanonicalMessageCount: canonicalMessages.length,
          });
          diagnostic("attempt-outcome", {
            outcome: "succeeded",
            attemptIndex: attempt.attemptIndex,
            candidateSessionId: attempt.candidateSessionId,
            sourceSessionId: attempt.sourceSessionId,
          });
          currentAttempt = null;
          const promotion = input.store.promoteCoreNamedClaudeSessionBinding({
            providerId: input.providerId,
            requestClient: input.requestClient,
            lilacSessionId: input.sessionId,
            requestId: input.requestId,
            attemptIndex: attempt.attemptIndex,
          });
          const promotionError = promotion.match({ ok: () => null, err: (error) => error });
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
          const promoted = promotion.match({ ok: (value) => value, err: () => false });
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
