import { QuestionContinuation } from "../../../question/question-continuation";
import type { NativeOutputFrontier } from "@stanley2058/lilac-event-bus";
import {
  McpImageCheckpointRegistry,
  type McpImageCheckpointReference,
} from "../../../mcp/image-checkpoint";
import { type ModelMessage, type ToolSet } from "ai";
import type { DurableResolvedModelRequest, ModelReasoningEffort } from "@stanley2058/lilac-utils";
import {
  type AdapterPlatform,
  type CorePrimaryLineageV2,
  type RequestOrigin,
  type RequestQueueMode,
  type RequestRunPolicy,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  AiSdkPiAgent,
  type AgentInputQueueId,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import type { WorkflowLiveParentBridge } from "../../../workflow/workflow-live-parent-bridge";
import { type RequestMessageCacheOwner } from "../../../tool-server/request-message-cache";
import { isHeartbeatSessionId } from "../../../heartbeat/common";
import { type StoredMessageIdentityProjectionV1 } from "../../../transcript/stored-message-materialization";
import type { RequestDeliveryTerminalOutcome } from "../request-delivery";
import { type AgentRunCheckpointV1, type AgentRunJournalHandle } from "../agent-run-journal";
import { LineageToolAuthority } from "./lineage-tool-authority";
import {
  parseBufferedForActiveRequestIdFromRaw,
  parseRequestControlFromRaw,
  type AgentRunProfile,
  type AgentRunnerRaw,
} from "./raw";
import { type SessionSafetyMode } from "../../session-policy";
import type { AuthenticatedSurfaceOrigin, MsgRef } from "../../types";
import type { NativeOutputPublisher, NativeOutputPublication } from "../../native/output";
import { degradeCorePrimaryLineageForMutation } from "./lineage";

export type AgentRunnerRetainedRequestDelivery = {
  readonly requestDeliveryId: string;
  readonly outcome: RequestDeliveryTerminalOutcome;
};

export type Enqueued = {
  nativeHistoryProviderState?: HistoryProviderState;
  queueEntryId: string;
  requestDeliveryId?: string;
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
  queue: RequestQueueMode;
  runPolicy: RequestRunPolicy;
  origin?: RequestOrigin;
  messages: ModelMessage[];
  storedMessages: StoredMessageV1[];
  corePrimaryLineage?: CorePrimaryLineageV2;
  modelOverride?: string;
  raw?: AgentRunnerRaw;
  authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  currentTurnUserId?: string;
  currentTurnMessageRef?: MsgRef;
  verifiedIngress?: boolean;
  identityOwner?: RequestMessageCacheOwner;
  restoredSafetyMode?: SessionSafetyMode;
  nativeResolvedModelRequest?: DurableResolvedModelRequest;
  recovery?: {
    checkpointMessages: ModelMessage[];
    partialText: string;
    nativeOutputFrontier?: NativeOutputFrontier;
  };
  storedRecoveryCheckpoint?: StoredMessageV1[];
  recoveryMcpImages?: McpImageCheckpointReference[];
  previousRecoveryCheckpoint?: AgentRunCheckpointV1;
  loadedCatalogIds?: readonly string[];
  questionResultIds?: readonly string[];
  acceptedCorePrimaryLineage?: CorePrimaryLineageV2;
  acceptedCurrentTurnUserId?: string;
  retainedRequestDeliveries?: readonly AgentRunnerRetainedRequestDelivery[];
  journalHandle?: AgentRunJournalHandle;
};

type QueueCancellationGroup = {
  readonly requestId: string;
  readonly requestClient: AdapterPlatform;
  readonly entries: readonly Enqueued[];
};

export type QueueLifecycleAttempt = {
  readonly eventId: string;
  readonly controlRequestId: string;
  readonly controlRequestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly kind: "queued-cancellation" | "buffered-absorption";
  readonly detail: string;
  pendingGroups: QueueCancellationGroup[];
  controlApplied: boolean;
};

/** Waits for every operation to settle, giving up at the deadline; true when all settled. */
export async function settlesBefore(
  operations: readonly Promise<unknown>[],
  deadlineAtMs: number,
): Promise<boolean> {
  if (operations.length === 0) return true;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const settled = await Promise.race([
    Promise.allSettled(operations).then(() => true),
    new Promise<false>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), Math.max(0, deadlineAtMs - Date.now()));
      deadlineTimer.unref?.();
    }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  return settled;
}

export function isCancelControlEntry(entry: Enqueued): boolean {
  return parseRequestControlFromRaw(entry.raw).cancel;
}

export function collectBufferedPromptEntriesForActiveRequest(input: {
  queue: readonly Enqueued[];
  activeRequestId: string;
}): Enqueued[] {
  const out: Enqueued[] = [];

  for (const next of input.queue) {
    if (next.queue !== "prompt") continue;
    if (parseBufferedForActiveRequestIdFromRaw(next.raw) !== input.activeRequestId) continue;
    out.push(next);
  }

  return out;
}

export function removeQueuedEntriesByReference(
  queue: Enqueued[],
  removed: readonly Enqueued[],
): number {
  if (removed.length === 0) return 0;
  const targets = new Set(removed);
  const before = queue.length;

  for (let i = 0; i < queue.length; ) {
    if (!targets.has(queue[i]!)) {
      i += 1;
      continue;
    }

    queue.splice(i, 1);
  }

  return before - queue.length;
}

export function groupQueueCancellationEntries(
  entries: readonly Enqueued[],
): QueueCancellationGroup[] {
  const groups = new Map<string, QueueCancellationGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.requestId);
    if (existing) {
      groups.set(entry.requestId, {
        ...existing,
        entries: [...existing.entries, entry],
      });
      continue;
    }
    groups.set(entry.requestId, {
      requestId: entry.requestId,
      requestClient: entry.requestClient,
      entries: [entry],
    });
  }
  return [...groups.values()];
}

export type UnconsumedControlDisposition = "requeue" | "abandon" | "release";

/**
 * Decides what happens to steers and follow-ups an ended run never consumed. They normally run as
 * the session's next prompts. A run left for recovery keeps them, and a cancel that landed during
 * cleanup has cleared them. A workflow request runs only under its dispatch authority, so its
 * controls cannot start another run and end with it instead.
 */
export function unconsumedControlDisposition(input: {
  readonly terminalPanic: boolean;
  readonly terminalized: boolean;
  readonly cancelled: boolean;
  readonly workflowRequest: boolean;
}): UnconsumedControlDisposition {
  switch (true) {
    case input.terminalPanic || !input.terminalized || input.cancelled:
      return "release";
    case input.workflowRequest:
      return "abandon";
    default:
      return "requeue";
  }
}

export function shouldCancelIdleOnlyGlobalRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy !== "idle_only_global") return false;

  for (const [queuedSessionId, state] of params.states) {
    if (!state.running) continue;
    if (queuedSessionId === params.sessionId) return true;
    if (!isHeartbeatSessionId(queuedSessionId)) return true;
  }

  return false;
}

export function shouldCancelRunPolicyRequest(params: {
  runPolicy: RequestRunPolicy;
  sessionId: string;
  states: ReadonlyMap<string, SessionQueue>;
}): boolean {
  if (params.runPolicy === "idle_only_global") {
    return shouldCancelIdleOnlyGlobalRequest(params);
  }

  if (params.runPolicy !== "idle_only_session") return false;

  const state = params.states.get(params.sessionId);
  return Boolean(state?.running);
}

export type SessionQueue = {
  running: boolean;
  agent: AiSdkPiAgent<ToolSet> | null;
  queue: Enqueued[];
  activeRequestId: string | null;
  activeRun: {
    mcpImages: McpImageCheckpointRegistry;
    requestDeliveryId?: string;
    requestId: string;
    sessionId: string;
    requestClient: AdapterPlatform;
    runProfile: AgentRunProfile;
    queue: RequestQueueMode;
    runPolicy: RequestRunPolicy;
    origin?: RequestOrigin;
    messages: ModelMessage[];
    storedMessages: StoredMessageV1[];
    corePrimaryLineage?: CorePrimaryLineageV2;
    toolAuthority: LineageToolAuthority;
    questionContinuation: QuestionContinuation;
    modelOverride?: string;
    currentTurnUserId?: string;
    currentTurnMessageRef?: MsgRef;
    raw?: AgentRunnerRaw;
    resolvedModelSpec: string | null;
    resolvedReasoning: ModelReasoningEffort | undefined;
    resolvedProviderFamily: HistoryProviderState["lastFamily"] | null;
    partialText: string;
    liveParent: ReturnType<WorkflowLiveParentBridge["registerParent"]> | undefined;
    hasPendingJobEvents?: () => boolean;
    stopAwaitJobs?: () => Promise<void>;
    materializeStoredMessages:
      | ((messages: readonly StoredMessageV1[]) => Promise<ModelMessage[]>)
      | null;
    rememberStoredMessages: (
      providerMessages: readonly ModelMessage[],
      storedMessages: readonly StoredMessageV1[],
    ) => void;
    notifyWaiters: () => void;
    flushOutput: () => void;
    setCurrentTurnContext: (userId: string | undefined, messageRef: MsgRef | undefined) => void;
    cancel: () => void;
    started: boolean;
    /** False once the run has stopped reading new input and is finalizing its output. */
    acceptsInput: boolean;
    startedAt: number;
    activeTools: Map<string, { toolName: string; startedAt: number }>;
    retainedRequestDeliveries: Map<string, RequestDeliveryTerminalOutcome>;
    checkpointedRetainedRequestDeliveryIds: Set<string>;
    retainedRequestDeliveryByInputId: Map<AgentInputQueueId, string>;
    /** Controls applied as queued agent input, rerun as the next prompt if the run never takes them. */
    queuedControlEntries: Map<AgentInputQueueId, Enqueued>;
    /** Unconsumed controls this run moved to the session queue while it finalized. */
    transferredControls: readonly Enqueued[];
    journalHandle: AgentRunJournalHandle | null;
    nativeOutput: NativeOutputPublisher | undefined;
    checkpointWriter: {
      disabled: boolean;
      pending: {
        readonly messages: readonly ModelMessage[];
        readonly canonicalInputIds: ReadonlySet<AgentInputQueueId>;
        readonly identityProjection: StoredMessageIdentityProjectionV1;
        readonly nativeOutputBarrier?: Promise<NativeOutputPublication>;
        readonly nativeOutputFrontier?: NativeOutputFrontier;
      } | null;
      operation: Promise<void> | null;
      closed: boolean;
      abandoned: boolean;
      retryInputIds: Set<AgentInputQueueId>;
      inFlightInputIds: ReadonlySet<AgentInputQueueId> | null;
      lastCommittedProviderMessages: readonly ModelMessage[];
      lastCommittedStoredMessages: readonly StoredMessageV1[];
      retainedPredecessorStoredMessages: readonly StoredMessageV1[];
    };
  } | null;
  /** Track toolCallIds whose outputs are compacted in the model-facing view. */
  compactedToolCallIds: Set<string>;
};

export function mergeQueuedControlsForRecovery(
  first: Enqueued,
  queue: Enqueued[],
  reservedQueueEntries: ReadonlySet<Enqueued>,
): {
  readonly storedMessages: readonly StoredMessageV1[];
  readonly reapplied: readonly Enqueued[];
  readonly discarded: readonly Enqueued[];
} {
  const retainedRequestDeliveryIds = new Set(
    first.retainedRequestDeliveries?.map(({ requestDeliveryId }) => requestDeliveryId),
  );
  const storedMessages: StoredMessageV1[] = [];
  const reapplied: Enqueued[] = [];
  const discarded: Enqueued[] = [];

  for (let index = 0; index < queue.length; ) {
    const entry = queue[index]!;
    const control = parseRequestControlFromRaw(entry.raw);
    const targetsRecoveredRun = entry.requestId === first.requestId || control.requiresActive;
    const isActiveControl = entry.queue !== "prompt" && !control.cancel && targetsRecoveredRun;
    if (!isActiveControl || reservedQueueEntries.has(entry)) {
      index += 1;
      continue;
    }

    const alreadyRetained =
      entry.requestDeliveryId !== undefined &&
      retainedRequestDeliveryIds.has(entry.requestDeliveryId);
    if (!alreadyRetained) {
      storedMessages.push(...entry.storedMessages);
      reapplied.push(entry);
      first.currentTurnUserId = entry.currentTurnUserId;
      first.currentTurnMessageRef = entry.currentTurnMessageRef;
    }
    discarded.push(entry);
    queue.splice(index, 1);
  }

  if (reapplied.length > 0) {
    first.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      "queued-request-coalesced",
      first.corePrimaryLineage?.currentCanonicalStart,
    );
  }

  return { storedMessages, reapplied, discarded };
}

export function mergeQueuedForSameRequest(
  first: Enqueued,
  queue: Enqueued[],
  reservedQueueEntries: ReadonlySet<Enqueued>,
): {
  readonly messages: ModelMessage[];
  readonly storedMessages: StoredMessageV1[];
  readonly discarded: readonly Enqueued[];
} {
  const merged: ModelMessage[] = [...first.messages];
  const storedMessages: StoredMessageV1[] = [...first.storedMessages];
  const discarded: Enqueued[] = [];

  // Pull in any already-queued items for the same request id so they become
  // additional user messages in the same initial run.
  for (let i = 0; i < queue.length; ) {
    const next = queue[i]!;
    if (next.requestId !== first.requestId || reservedQueueEntries.has(next)) {
      i += 1;
      continue;
    }

    merged.push(...next.messages);
    storedMessages.push(...next.storedMessages);
    first.currentTurnUserId = next.currentTurnUserId;
    first.currentTurnMessageRef = next.currentTurnMessageRef;
    discarded.push(next);
    queue.splice(i, 1);
  }

  if (discarded.length > 0) {
    first.corePrimaryLineage = degradeCorePrimaryLineageForMutation(
      "queued-request-coalesced",
      first.corePrimaryLineage?.currentCanonicalStart,
    );
  }

  return { messages: merged, storedMessages, discarded };
}
