import { type Result as ResultType } from "better-result";
import { type StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import {
  parseRequestControlFromRaw,
  parseWorkflowRequestHintFromRaw,
  preserveAgentRunnerRaw,
  requestRawReferencesMessage,
  type AgentRunnerRaw,
} from "../surface/bridge/bus-agent-runner/raw";
import {
  createCoreRequestDelivery,
  type CoreAcceptedRequestWork,
} from "../surface/bridge/request-delivery";
import { isHeartbeatSessionId } from "../heartbeat/common";
import {
  type AgentRunJournal,
  type AgentRunJournalSqliteFailure,
  type AgentRunRecoveryHead,
} from "../surface/bridge/agent-run-journal";

type AgentRunRecoveryJoinLogger = {
  warn(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
};

type CoreRequestDeliveryStore = ReturnType<typeof createCoreRequestDelivery>["store"];

function compareAgentRunRecoveryHeads(
  left: AgentRunRecoveryHead,
  right: AgentRunRecoveryHead,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.handle.runId === right.handle.runId) return 0;
  return left.handle.runId < right.handle.runId ? -1 : 1;
}

function settleAgentRunRecoveryHeadCleanup(input: {
  readonly head: AgentRunRecoveryHead;
  readonly operation: "reconcile" | "reset";
  readonly reason:
    | "owner-missing"
    | "owner-terminal"
    | "owner-not-accepted"
    | "owner-load-failed"
    | "incompatible-identity"
    | "invalid-retained-delivery"
    | "duplicate-active-session";
  readonly journal: Pick<AgentRunJournal, "removeReconciled" | "resetRun">;
  readonly logger: AgentRunRecoveryJoinLogger;
}): AgentRunJournalSqliteFailure | null {
  const result =
    input.operation === "reconcile"
      ? input.journal.removeReconciled(input.head.handle.runId)
      : input.journal.resetRun(input.head.handle.runId);
  const notice = result.match<
    | { readonly kind: "completed" }
    | {
        readonly kind: "failed";
        readonly error: AgentRunJournalSqliteFailure;
        readonly errorTag: string;
        readonly errorCode: string;
      }
  >({
    ok: () => ({ kind: "completed" }),
    err: (error) => ({
      kind: "failed",
      error,
      errorTag: error.name,
      errorCode: error.code,
    }),
  });
  if (notice.kind === "failed") {
    input.logger.warn("Agent run journal startup cleanup failed", {
      requestDeliveryId: input.head.handle.runId,
      operation: input.operation,
      reason: input.reason,
      errorTag: notice.errorTag,
      errorCode: notice.errorCode,
    });
    return input.operation === "reset" ? notice.error : null;
  }
  input.logger.warn("Agent run journal startup progress discarded", {
    requestDeliveryId: input.head.handle.runId,
    operation: input.operation,
    reason: input.reason,
  });
  return null;
}

type AgentRunRetainedRecoveryReference = NonNullable<
  AgentRunRecoveryHead["checkpoint"]
>["retainedRequestDeliveries"][number];

type AgentRunRetainedRecoveryOwner = {
  readonly ownerRunId: string;
  readonly ownerState: AgentRunRecoveryHead["state"];
  readonly outcome: AgentRunRetainedRecoveryReference["outcome"];
  readonly finalReplayDeadline?: number;
};

type AgentRunRecoveryJoin = {
  readonly heads: Map<string, AgentRunRecoveryHead>;
  readonly retainedOwners: ReadonlyMap<string, AgentRunRetainedRecoveryOwner>;
  readonly recoverableRootParentRequestIds: readonly string[];
  readonly journalResetFailure?: AgentRunJournalSqliteFailure;
};

export function emptyAgentRunRecoveryJoin(): AgentRunRecoveryJoin {
  return {
    heads: new Map(),
    retainedOwners: new Map(),
    recoverableRootParentRequestIds: [],
  };
}

function failedAgentRunRecoveryJoin(error: AgentRunJournalSqliteFailure): AgentRunRecoveryJoin {
  return {
    ...emptyAgentRunRecoveryJoin(),
    journalResetFailure: error,
  };
}

function terminalOutcomesMatch(
  left: AgentRunRetainedRecoveryReference["outcome"],
  right: AgentRunRetainedRecoveryReference["outcome"],
): boolean {
  return left.kind === right.kind && left.code === right.code;
}

function resolveRetainedDeliveriesForRecovery(input: {
  readonly head: AgentRunRecoveryHead;
  readonly ownerRequestId: string;
  readonly ownerSessionId: string;
  readonly ownerRaw: AgentRunnerRaw | undefined;
  readonly journalHeadRunIds: ReadonlySet<string>;
  readonly requestDeliveryStore: Pick<CoreRequestDeliveryStore, "load">;
}): readonly AgentRunRetainedRecoveryReference[] | null {
  const retained = input.head.checkpoint?.retainedRequestDeliveries ?? [];
  const observedDeliveryIds = new Set<string>();

  for (const reference of retained) {
    if (
      reference.requestDeliveryId === input.head.handle.runId ||
      input.journalHeadRunIds.has(reference.requestDeliveryId) ||
      observedDeliveryIds.has(reference.requestDeliveryId)
    ) {
      return null;
    }
    observedDeliveryIds.add(reference.requestDeliveryId);

    const retainedOwner = input.requestDeliveryStore.load(reference.requestDeliveryId).match<
      | {
          readonly kind: "accepted";
          readonly requestDeliveryId: string;
          readonly requestId: string;
          readonly workRequestDeliveryId: string;
          readonly workRequestId: string;
          readonly sessionId: string;
          readonly queue: CoreAcceptedRequestWork["data"]["queue"];
          readonly raw: AgentRunnerRaw | undefined;
        }
      | {
          readonly kind: "terminal";
          readonly requestDeliveryId: string;
          readonly requestId: string;
          readonly outcome: AgentRunRetainedRecoveryReference["outcome"];
        }
      | { readonly kind: "invalid" }
    >({
      ok: (record) => {
        if (record.state === "terminal") {
          return {
            kind: "terminal",
            requestDeliveryId: record.requestDeliveryId,
            requestId: record.requestId,
            outcome: record.outcome,
          };
        }
        return record.state === "accepted"
          ? ({
              kind: "accepted",
              requestDeliveryId: record.requestDeliveryId,
              requestId: record.requestId,
              workRequestDeliveryId: record.work.requestDeliveryId,
              workRequestId: record.work.requestId,
              sessionId: record.work.sessionId,
              queue: record.work.data.queue,
              raw: preserveAgentRunnerRaw({ data: record.work.data }),
            } as const)
          : { kind: "invalid" };
      },
      err: () => ({ kind: "invalid" }),
    });
    if (retainedOwner.kind === "invalid") return null;

    if (retainedOwner.kind === "terminal") {
      if (input.head.state !== "terminal") return null;
      const terminalIdentityMatches =
        retainedOwner.requestDeliveryId === reference.requestDeliveryId &&
        retainedOwner.requestId === input.ownerRequestId;
      if (
        !terminalIdentityMatches ||
        !terminalOutcomesMatch(retainedOwner.outcome, reference.outcome)
      ) {
        return null;
      }
      continue;
    }

    const identityMatches =
      retainedOwner.requestDeliveryId === reference.requestDeliveryId &&
      retainedOwner.workRequestDeliveryId === retainedOwner.requestDeliveryId &&
      retainedOwner.workRequestId === retainedOwner.requestId &&
      retainedOwner.sessionId === input.ownerSessionId;
    if (!identityMatches || retainedOwner.queue === "prompt") return null;

    const control = parseRequestControlFromRaw(retainedOwner.raw);
    const targetsOwnerRequest = retainedOwner.requestId === input.ownerRequestId;
    const targetsOwnerMessage =
      control.cancel &&
      control.targetMessageId !== null &&
      requestRawReferencesMessage(input.ownerRaw, control.targetMessageId);
    if (!targetsOwnerRequest && !targetsOwnerMessage) return null;
  }

  return retained;
}

export function joinAgentRunRecoveryHeads(input: {
  readonly heads: readonly AgentRunRecoveryHead[];
  readonly requestDeliveryStore: Pick<CoreRequestDeliveryStore, "load">;
  readonly journal: Pick<AgentRunJournal, "removeReconciled" | "resetRun">;
  readonly workflowAuthority?: {
    authorizeWorkflowRequest(input: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly platform: string;
    }): {
      readonly policy: {
        readonly runId: string;
        readonly operationId: string;
        readonly dispatchEpoch: string;
      };
    } | null;
  };
  readonly logger: AgentRunRecoveryJoinLogger;
}): AgentRunRecoveryJoin {
  const validatedHeads = new Map<string, AgentRunRecoveryHead>();
  const retainedOwners = new Map<string, AgentRunRetainedRecoveryOwner>();
  const recoverableRootParentRequestIds: string[] = [];
  const activeSessionOwners = new Set<string>();
  const orderedHeads = [...input.heads].sort(compareAgentRunRecoveryHeads);
  const journalHeadRunIds = new Set(orderedHeads.map((head) => head.handle.runId));

  for (const head of orderedHeads) {
    const ownership = input.requestDeliveryStore.load(head.handle.runId).match<
      | {
          readonly kind: "accepted";
          readonly requestId: string;
          readonly workRequestId: string;
          readonly sessionId: string;
          readonly requestClient: string;
          readonly raw: AgentRunnerRaw | undefined;
          readonly workflowHint: ReturnType<typeof parseWorkflowRequestHintFromRaw>;
        }
      | {
          readonly kind: "discard";
          readonly reason: "owner-terminal" | "owner-not-accepted";
        }
      | {
          readonly kind: "terminal";
          readonly requestId: string;
          readonly outcome: AgentRunRetainedRecoveryReference["outcome"];
          readonly finalReplayDeadline?: number;
        }
      | { readonly kind: "missing" }
      | { readonly kind: "load-failed" }
    >({
      ok: (record) => {
        if (record.state === "terminal") {
          if (head.state !== "terminal") {
            return { kind: "discard", reason: "owner-terminal" };
          }
          return {
            kind: "terminal",
            requestId: record.requestId,
            outcome: record.outcome,
            ...(record.finalReplayDeadline === undefined
              ? {}
              : { finalReplayDeadline: record.finalReplayDeadline }),
          };
        }
        if (record.state !== "accepted") {
          return { kind: "discard", reason: "owner-not-accepted" };
        }
        return {
          kind: "accepted",
          requestId: record.requestId,
          workRequestId: record.work.requestId,
          sessionId: record.work.sessionId,
          requestClient: record.work.requestClient,
          raw: preserveAgentRunnerRaw({ data: record.work.data }),
          workflowHint: parseWorkflowRequestHintFromRaw(
            preserveAgentRunnerRaw({ data: record.work.data }),
          ),
        };
      },
      err: (error) =>
        error.name === "RequestDeliveryNotFound" ? { kind: "missing" } : { kind: "load-failed" },
    });

    if (ownership.kind === "missing") {
      settleAgentRunRecoveryHeadCleanup({
        head,
        operation: "reconcile",
        reason: "owner-missing",
        journal: input.journal,
        logger: input.logger,
      });
      continue;
    }
    if (ownership.kind === "load-failed") {
      const resetFailure = settleAgentRunRecoveryHeadCleanup({
        head,
        operation: "reset",
        reason: "owner-load-failed",
        journal: input.journal,
        logger: input.logger,
      });
      if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
      continue;
    }
    if (ownership.kind === "discard") {
      const resetFailure = settleAgentRunRecoveryHeadCleanup({
        head,
        operation: ownership.reason === "owner-terminal" ? "reconcile" : "reset",
        reason: ownership.reason,
        journal: input.journal,
        logger: input.logger,
      });
      if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
      continue;
    }

    if (ownership.kind === "terminal") {
      const terminalIdentityMatches = head.handle.requestId === ownership.requestId;
      const terminalStateMatches =
        head.terminalOutcome !== undefined &&
        terminalOutcomesMatch(head.terminalOutcome, ownership.outcome) &&
        head.finalReplayDeadline === ownership.finalReplayDeadline;
      if (!terminalIdentityMatches || !terminalStateMatches) {
        const resetFailure = settleAgentRunRecoveryHeadCleanup({
          head,
          operation: "reset",
          reason: "incompatible-identity",
          journal: input.journal,
          logger: input.logger,
        });
        if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
        continue;
      }
    }

    const identityMatches =
      ownership.kind === "terminal" ||
      (head.handle.requestId === ownership.requestId &&
        ownership.workRequestId === ownership.requestId &&
        head.handle.sessionId === ownership.sessionId);
    if (!identityMatches) {
      const resetFailure = settleAgentRunRecoveryHeadCleanup({
        head,
        operation: "reset",
        reason: "incompatible-identity",
        journal: input.journal,
        logger: input.logger,
      });
      if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
      continue;
    }
    const retainedReferences = resolveRetainedDeliveriesForRecovery({
      head,
      ownerRequestId: ownership.requestId,
      ownerSessionId: ownership.kind === "terminal" ? head.handle.sessionId : ownership.sessionId,
      ownerRaw: ownership.kind === "terminal" ? undefined : ownership.raw,
      journalHeadRunIds,
      requestDeliveryStore: input.requestDeliveryStore,
    });
    if (
      retainedReferences === null ||
      retainedReferences.some((reference) => retainedOwners.has(reference.requestDeliveryId))
    ) {
      const resetFailure = settleAgentRunRecoveryHeadCleanup({
        head,
        operation: "reset",
        reason: "invalid-retained-delivery",
        journal: input.journal,
        logger: input.logger,
      });
      if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
      continue;
    }
    if (head.state === "active" && activeSessionOwners.has(head.handle.sessionId)) {
      const resetFailure = settleAgentRunRecoveryHeadCleanup({
        head,
        operation: "reset",
        reason: "duplicate-active-session",
        journal: input.journal,
        logger: input.logger,
      });
      if (resetFailure) return failedAgentRunRecoveryJoin(resetFailure);
      continue;
    }
    if (head.state === "active") {
      activeSessionOwners.add(head.handle.sessionId);
      const authorizedWorkflow =
        ownership.kind === "accepted" && ownership.workflowHint
          ? (input.workflowAuthority?.authorizeWorkflowRequest({
              requestId: ownership.requestId,
              sessionId: ownership.sessionId,
              platform: ownership.requestClient,
            }) ?? null)
          : null;
      const isWorkflowOwned =
        ownership.kind === "accepted" &&
        ownership.workflowHint !== null &&
        authorizedWorkflow !== null &&
        authorizedWorkflow.policy.runId === ownership.workflowHint.runId &&
        authorizedWorkflow.policy.operationId === ownership.workflowHint.operationId &&
        authorizedWorkflow.policy.dispatchEpoch === ownership.workflowHint.dispatchEpoch;
      if (!isHeartbeatSessionId(head.handle.sessionId) && !isWorkflowOwned) {
        recoverableRootParentRequestIds.push(head.handle.requestId);
      }
    }
    validatedHeads.set(head.handle.runId, head);
    for (const reference of retainedReferences) {
      retainedOwners.set(reference.requestDeliveryId, {
        ownerRunId: head.handle.runId,
        ownerState: head.state,
        outcome: reference.outcome,
        ...(head.finalReplayDeadline === undefined
          ? {}
          : { finalReplayDeadline: head.finalReplayDeadline }),
      });
    }
  }

  return {
    heads: validatedHeads,
    retainedOwners,
    recoverableRootParentRequestIds,
  };
}

export function removeFullyReconciledAgentRunTerminalHeads(input: {
  readonly heads: ReadonlyMap<string, AgentRunRecoveryHead>;
  readonly requestDeliveryStore: Pick<CoreRequestDeliveryStore, "load">;
  readonly journal: Pick<AgentRunJournal, "removeReconciled">;
}): readonly string[] {
  const removedRunIds: string[] = [];
  for (const [runId, head] of input.heads) {
    if (head.state !== "terminal" || !head.terminalOutcome) continue;
    const terminalOutcome = head.terminalOutcome;
    const ownerIsTerminal = input.requestDeliveryStore.load(runId).match({
      ok: (record) =>
        record.state === "terminal" &&
        terminalOutcomesMatch(record.outcome, terminalOutcome) &&
        record.finalReplayDeadline === head.finalReplayDeadline,
      err: () => false,
    });
    if (!ownerIsTerminal) continue;

    const retainedAreTerminal = (head.checkpoint?.retainedRequestDeliveries ?? []).every(
      (reference) =>
        input.requestDeliveryStore.load(reference.requestDeliveryId).match({
          ok: (record) =>
            record.state === "terminal" &&
            record.requestId === head.handle.requestId &&
            terminalOutcomesMatch(record.outcome, reference.outcome),
          err: () => false,
        }),
    );
    if (!retainedAreTerminal) continue;
    input.journal.removeReconciled(runId).match({
      ok: () => removedRunIds.push(runId),
      err: () => undefined,
    });
  }
  return removedRunIds;
}

export type AgentRunCheckpointBlobRecoveryDecision =
  | { readonly kind: "retained" }
  | {
      readonly kind: "reset";
      readonly reconciliationError: Error;
      readonly cleanupError?: Error;
    }
  | {
      readonly kind: "disabled";
      readonly reconciliationError: Error;
      readonly resetError: Error;
    };

export function recoverAgentRunCheckpointBlobReferences<
  TReconciliationError extends Error,
  TResetError extends Error,
>(input: {
  readonly heads: ReadonlyMap<string, AgentRunRecoveryHead>;
  readonly reconcile: (checkpoints: {
    readonly checkpoints: readonly {
      readonly requestDeliveryId: string;
      readonly messages: readonly StoredMessageV1[];
    }[];
  }) => ResultType<void, TReconciliationError>;
  readonly resetAll: () => ResultType<void, TResetError>;
}): AgentRunCheckpointBlobRecoveryDecision {
  const checkpoints = [...input.heads.values()].flatMap((head) =>
    head.checkpoint
      ? [
          {
            requestDeliveryId: head.handle.runId,
            messages: [...head.checkpoint.messages, ...(head.previousCheckpoint?.messages ?? [])],
          },
        ]
      : [],
  );
  const reconciliationError = input
    .reconcile({ checkpoints })
    .match({ ok: () => null, err: (error) => error });
  if (!reconciliationError) return { kind: "retained" };

  const resetError = input.resetAll().match({ ok: () => null, err: (error) => error });
  if (resetError) return { kind: "disabled", reconciliationError, resetError };

  const cleanupError = input
    .reconcile({ checkpoints: [] })
    .match({ ok: () => undefined, err: (error) => error });
  return {
    kind: "reset",
    reconciliationError,
    ...(cleanupError ? { cleanupError } : {}),
  };
}

export type AgentRunAcceptedRecoveryDecision =
  | { readonly kind: "resume"; readonly head?: AgentRunRecoveryHead }
  | { readonly kind: "retained-active"; readonly ownerRunId: string }
  | {
      readonly kind: "terminal";
      readonly outcome: AgentRunRetainedRecoveryReference["outcome"];
      readonly finalReplayDeadline?: number;
    };

export function selectAgentRunAcceptedRecovery(
  join: AgentRunRecoveryJoin,
  requestDeliveryId: string,
): AgentRunAcceptedRecoveryDecision {
  const head = join.heads.get(requestDeliveryId);
  if (head?.state === "terminal" && head.terminalOutcome) {
    return {
      kind: "terminal",
      outcome: head.terminalOutcome,
      ...(head.finalReplayDeadline === undefined
        ? {}
        : { finalReplayDeadline: head.finalReplayDeadline }),
    };
  }
  const retainedOwner = join.retainedOwners.get(requestDeliveryId);
  if (retainedOwner?.ownerState === "terminal") {
    return {
      kind: "terminal",
      outcome: retainedOwner.outcome,
      ...(retainedOwner.finalReplayDeadline === undefined
        ? {}
        : { finalReplayDeadline: retainedOwner.finalReplayDeadline }),
    };
  }
  if (retainedOwner) {
    return { kind: "retained-active", ownerRunId: retainedOwner.ownerRunId };
  }
  return { kind: "resume", ...(head ? { head } : {}) };
}
