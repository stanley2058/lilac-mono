import { isGeneratedMessage } from "@stanley2058/lilac-agent";
import { createFreshOnlyLineage } from "../../../shared/core-primary-lineage";
import { type ModelMessage } from "ai";
import {
  corePrimaryLineageV2Schema,
  decodeCorePrimaryLineageV2,
  extendCoreLineagePrefixDigestV2,
  type AdapterPlatform,
  type CoreLineageManifestV2,
  type CorePrimaryLineageV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { type HistoryProviderState } from "@stanley2058/lilac-agent";
import { type TranscriptStore } from "../../../transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../../transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../../transcript/transcript-persistence-codec";
import { type AgentRunProfile } from "./raw";
import { signalBusAgentRunnerHostFailure } from "./errors";

export function validateCorePrimaryLineageAtRunnerIntake(input: {
  requestClient: AdapterPlatform;
  sessionId?: string;
  runProfile: AgentRunProfile;
  messages: readonly ModelMessage[];
  corePrimaryLineage: unknown;
  transcriptStore?: TranscriptStore;
}): CorePrimaryLineageV2 | undefined {
  if (input.requestClient !== "discord" || input.runProfile !== "primary") return undefined;
  const fallbackCurrentCanonicalStart = Math.max(
    0,
    input.messages.findLastIndex(
      (message) => message.role === "user" && !isGeneratedMessage(message),
    ),
  );
  if (input.corePrimaryLineage === undefined) {
    return createFreshOnlyLineage("missing-manifest", fallbackCurrentCanonicalStart);
  }
  const decoded = decodeCorePrimaryLineageV2(input.corePrimaryLineage, input.messages);
  const continueDecoded = decoded.match<() => CorePrimaryLineageV2>({
    err: () => () =>
      createFreshOnlyLineage("malformed-or-unaligned-manifest", fallbackCurrentCanonicalStart),
    ok: (lineage) => () => {
      if (lineage.state !== "complete") return lineage;
      if (!input.sessionId) {
        return createFreshOnlyLineage("missing-lineage-scope", lineage.currentCanonicalStart);
      }
      if (!input.transcriptStore?.validateCorePrimaryLineageReferences) {
        return createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart);
      }
      const invalidReason = input.transcriptStore.validateCorePrimaryLineageReferences({
        manifest: lineage,
        requestClient: input.requestClient,
        sessionId: input.sessionId,
        surfaceId: `discord:${input.sessionId}`,
      });
      const continueValidation = invalidReason.match<() => CorePrimaryLineageV2>({
        err: () => () =>
          createFreshOnlyLineage("lineage-store-unavailable", lineage.currentCanonicalStart),
        ok: (storedInvalidReason) => () =>
          storedInvalidReason
            ? createFreshOnlyLineage(storedInvalidReason, lineage.currentCanonicalStart)
            : lineage,
      });
      return continueValidation();
    },
  });
  return continueDecoded();
}

export function degradeCorePrimaryLineageForMutation(
  reason: string,
  currentCanonicalStart = 0,
): CorePrimaryLineageV2 {
  return createFreshOnlyLineage(reason, currentCanonicalStart);
}

export function corePrimaryLineageHasCompactionCheckpoint(
  lineage: CorePrimaryLineageV2 | undefined,
): boolean {
  return (
    lineage?.state === "complete" &&
    lineage.segments.some((segment) => segment.atoms.some((atom) => atom.kind === "checkpoint"))
  );
}

const AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE = "conversation-thread-auto-inject";

export function appendAutoInjectedThreadSearchLineage(input: {
  lineage: unknown;
  canonicalMessages: readonly ModelMessage[];
  injectedMessages: readonly ModelMessage[];
}): CorePrimaryLineageV2 {
  const parsedShape = corePrimaryLineageV2Schema.safeParse(input.lineage);
  const fallbackCurrentCanonicalStart = parsedShape.success
    ? parsedShape.data.currentCanonicalStart
    : Math.max(
        0,
        input.canonicalMessages.findLastIndex(
          (message) => message.role === "user" && !isGeneratedMessage(message),
        ),
      );
  const failClosed = () =>
    degradeCorePrimaryLineageForMutation(
      "synthetic-thread-search-insertion",
      fallbackCurrentCanonicalStart,
    );

  const decoded = decodeCorePrimaryLineageV2(input.lineage, input.canonicalMessages);
  const continueDecoded = decoded.match<() => CorePrimaryLineageV2>({
    err: () => failClosed,
    ok: (lineage) => () => {
      if (lineage.state !== "complete" || input.injectedMessages.length === 0) {
        return failClosed();
      }
      const previous = lineage.segments.at(-1);
      if (!previous || previous.canonicalEnd !== input.canonicalMessages.length) {
        return failClosed();
      }

      const preparedInjected = projectStoredMessagesV1(input.injectedMessages).andThen((messages) =>
        hashCanonicalStoredMessagesV2(messages).map((digest) => ({
          messages,
          messageDigest: digest.hash,
        })),
      );
      const prepared = preparedInjected.match({
        ok: (value) => value,
        err: () => null,
      });
      if (!prepared) return failClosed();
      const atom = {
        kind: "synthetic" as const,
        source: AUTO_INJECTED_THREAD_SEARCH_LINEAGE_SOURCE,
        messageDigest: prepared.messageDigest,
      };
      const cumulativeAtomCount = previous.cumulativeAtomCount + 1;
      const extended = extendCoreLineagePrefixDigestV2(
        previous.cumulativePrefixDigest,
        cumulativeAtomCount,
        atom,
      );
      const continueExtended = extended.match<() => CorePrimaryLineageV2>({
        err: () => failClosed,
        ok: (cumulativePrefixDigest) => () => {
          const candidate = {
            ...lineage,
            segments: [
              ...lineage.segments,
              {
                atoms: [atom],
                canonicalMessages: prepared.messages,
                canonicalStart: previous.canonicalEnd,
                canonicalEnd: previous.canonicalEnd + input.injectedMessages.length,
                cumulativeAtomCount,
                cumulativePrefixDigest,
              },
            ],
          };
          const parsed = decodeCorePrimaryLineageV2(candidate, [
            ...input.canonicalMessages,
            ...prepared.messages,
          ]);
          const continueParsed = parsed.match<() => CorePrimaryLineageV2>({
            ok: (value) => () => (value.state === "complete" ? value : failClosed()),
            err: () => failClosed,
          });
          return continueParsed();
        },
      });
      return continueExtended();
    },
  });
  return continueDecoded();
}

export function mapCorePrimaryCompactionCurrentCanonicalStart(input: {
  previousCurrentCanonicalStart: number;
  replacement: {
    originalSuffixStart: number;
    replacementSuffixStart: number;
    replacementMessageCount: number;
  };
}): number {
  const retainedOffset =
    input.previousCurrentCanonicalStart - input.replacement.originalSuffixStart;
  if (retainedOffset < 0) return 0;
  return Math.min(
    input.replacement.replacementMessageCount,
    input.replacement.replacementSuffixStart + retainedOffset,
  );
}

export function persistedCompleteLineage(lineage: CorePrimaryLineageV2 | undefined): {
  corePrimaryLineage?: CoreLineageManifestV2;
} {
  return lineage?.state === "complete" ? { corePrimaryLineage: lineage } : {};
}

export function requireStoredMessageHash(messages: readonly StoredMessageV1[]): string {
  return hashCanonicalStoredMessagesV2(messages).match({
    ok: (digest) => () => digest.hash,
    err: (error) => () => signalBusAgentRunnerHostFailure(error),
  })();
}

export function resolveCorePrimaryTranscriptProviderState(input: {
  targetFamily: HistoryProviderState["lastFamily"];
  lineage?: CorePrimaryLineageV2;
  transcriptStore?: TranscriptStore;
}): HistoryProviderState {
  const lineage = input.lineage;
  let containsCrossFamilyTurns = lineage?.state !== "complete";
  if (lineage?.state === "complete") {
    for (const segment of lineage.segments) {
      const atom = segment.atoms[0];
      if (!atom) {
        containsCrossFamilyTurns = true;
        continue;
      }
      if (atom.kind === "request") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.match({
          ok: (value) => value?.providerState,
          err: () => undefined,
        });
        if (
          !state ||
          state.lastFamily !== atom.providerFamily ||
          state.containsCrossFamilyTurns !== atom.containsCrossFamilyTurns ||
          state.lastFamily !== input.targetFamily ||
          state.containsCrossFamilyTurns
        ) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (atom.kind === "checkpoint") {
        const transcript = input.transcriptStore?.getRequestTranscript?.({
          requestId: atom.requestId,
        });
        const state = transcript?.match({
          ok: (value) => value?.providerState,
          err: () => undefined,
        });
        if (!state || state.lastFamily !== input.targetFamily || state.containsCrossFamilyTurns) {
          containsCrossFamilyTurns = true;
        }
        continue;
      }
      if (
        segment.canonicalMessages.some(
          (message) => message.role === "assistant" || message.role === "tool",
        )
      ) {
        containsCrossFamilyTurns = true;
      }
    }
  }
  return {
    lastFamily: input.targetFamily,
    containsCrossFamilyTurns,
  };
}
