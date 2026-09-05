import type { Database } from "bun:sqlite";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import {
  decodeTranscriptRow,
  TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION,
} from "./transcript-persistence-codec";
import type {
  CoreClaudeAttemptMutationError,
  CoreClaudeBindingReadError,
  CoreNamedClaudeSessionBinding,
  RecordCoreNamedClaudeSessionAttemptOutcome,
  ReserveCoreNamedClaudeSessionAttempt,
  TranscriptTransactionConflict,
} from "./transcript-store";

type AttemptOwner = {
  readonly requestClient: AdapterPlatform;
  readonly lilacSessionId: string;
  readonly providerId: string;
};
type BindingFence = Pick<
  CoreNamedClaudeSessionBinding,
  "revision" | "claudeSessionId" | "executionScopeHashVersion" | "executionScopeHash"
>;
type AttemptState = {
  readonly state: "active" | "succeeded" | "failed" | "cancelled" | "uncertain";
};

const ACTIVE_ATTEMPT_LIMIT = 8;
const TERMINAL_ATTEMPT_RETENTION_LIMIT = 32;

export class CoreClaudeAttemptLifecycle {
  private readonly table: "core_named_claude_attempts" | "core_primary_claude_attempts";
  private readonly label: string;

  constructor(
    private readonly db: Database,
    private readonly kind: "named" | "primary",
    private readonly conflict: (
      reason: TranscriptTransactionConflict["reason"],
      message: string,
    ) => TranscriptTransactionConflict,
  ) {
    this.table = `core_${kind}_claude_attempts`;
    this.label = `Core ${kind} Claude`;
  }

  reserve<TBinding extends BindingFence, TAttempt>(
    input: ReserveCoreNamedClaudeSessionAttempt,
    proof: {
      readonly readBinding: () => ResultType<TBinding | null, CoreClaudeBindingReadError>;
      readonly readAttempt: (attemptIndex: number) => TAttempt | null;
      readonly insert: (binding: TBinding | null, attemptIndex: number, now: number) => void;
      readonly prune: () => void;
    },
  ): ResultType<TAttempt, CoreClaudeAttemptMutationError> {
    const decision = proof
      .readBinding()
      .match<
        | { readonly kind: "binding"; readonly binding: TBinding | null }
        | { readonly kind: "error"; readonly error: CoreClaudeBindingReadError }
      >({
        ok: (binding) => ({ kind: "binding", binding }),
        err: (error) => ({ kind: "error", error }),
      });
    if (decision.kind === "error") return Result.err(decision.error);
    const binding = decision.binding;
    const bindingChanged =
      input.expectedBindingRevision === null
        ? binding !== null
        : binding === null ||
          binding.revision !== input.expectedBindingRevision ||
          (input.sourceSessionId !== null &&
            (binding.claudeSessionId !== input.sourceSessionId ||
              binding.executionScopeHashVersion !== input.executionScopeHashVersion ||
              binding.executionScopeHash !== input.executionScopeHash));
    if (bindingChanged) {
      return Result.err(
        this.conflict("publication-fence-lost", `${this.label} binding changed before reservation`),
      );
    }
    const count = decodeTranscriptRow({
      storeKind: "count",
      row: this.db
        .query<{ count: number }, [AdapterPlatform, string, string]>(
          `SELECT COUNT(*) AS count FROM ${this.table}
         WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state = 'active'`,
        )
        .get(input.requestClient, input.lilacSessionId, input.providerId),
      schemaVersion: TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION,
      recordId:
        this.kind === "named"
          ? `named-active:${input.requestClient}:${input.lilacSessionId}:${input.providerId}`
          : `primary-active:${input.lilacSessionId}:${input.providerId}`,
    }).match<
      | { readonly kind: "count"; readonly count: number }
      | { readonly kind: "error"; readonly error: TranscriptTransactionConflict }
    >({
      ok: (value) => ({ kind: "count", count: value.value.count }),
      err: (error) => ({
        kind: "error",
        error: this.conflict("publication-verification-failed", error.message),
      }),
    });
    if (count.kind === "error") return Result.err(count.error);
    if (count.count >= ACTIVE_ATTEMPT_LIMIT) {
      return Result.err(
        this.conflict(
          "attempt-not-retained",
          `Too many active ${this.label} attempts are retained`,
        ),
      );
    }
    let attemptIndex = input.attemptIndex;
    if (proof.readAttempt(attemptIndex) !== null) {
      const latest = this.db
        .query<{ attempt_index: number }, [AdapterPlatform, string, string, string, number]>(
          `SELECT attempt_index FROM ${this.table}
         WHERE request_client = ? AND session_id = ? AND provider_id = ?
           AND request_id = ? AND attempt_index % 2 = ?
         ORDER BY attempt_index DESC LIMIT 1`,
        )
        .get(
          input.requestClient,
          input.lilacSessionId,
          input.providerId,
          input.requestId,
          input.attemptIndex % 2,
        );
      attemptIndex = (latest?.attempt_index ?? input.attemptIndex) + 2;
    }
    proof.insert(binding, attemptIndex, Date.now());
    proof.prune();
    const attempt = proof.readAttempt(attemptIndex);
    if (!attempt) {
      return Result.err(
        this.conflict("attempt-not-retained", `Reserved ${this.label} attempt was not retained`),
      );
    }
    return Result.ok(attempt);
  }

  recordOutcome<TAttempt extends AttemptState>(
    input: RecordCoreNamedClaudeSessionAttemptOutcome,
    readAttempt: () => TAttempt | null,
    prune: () => void,
  ): ResultType<TAttempt, TranscriptTransactionConflict> {
    const current = readAttempt();
    if (!current) {
      return Result.err(
        this.conflict(
          "attempt-not-found",
          `${this.label} attempt '${input.requestId}' was not found`,
        ),
      );
    }
    if (current.state !== "active") {
      if (current.state === input.state) return Result.ok(current);
      return Result.err(
        this.conflict(
          "attempt-terminal",
          `${this.label} attempt is already terminal as '${current.state}'`,
        ),
      );
    }
    const updated = this.db.run(
      `UPDATE ${this.table} SET state = ?, updated_ts = ?
       WHERE request_client = ? AND session_id = ? AND provider_id = ?
         AND request_id = ? AND attempt_index = ? AND state = 'active'`,
      [
        input.state,
        Date.now(),
        input.requestClient,
        input.lilacSessionId,
        input.providerId,
        input.requestId,
        input.attemptIndex,
      ],
    );
    if (updated.changes !== 1) {
      return Result.err(
        this.conflict("publication-fence-lost", `${this.label} attempt lost its active fence`),
      );
    }
    prune();
    const attempt = readAttempt();
    if (!attempt) {
      return Result.err(
        this.conflict("attempt-not-retained", `Updated ${this.label} attempt was not retained`),
      );
    }
    return Result.ok(attempt);
  }

  markInterrupted(now: number): void {
    this.db.run(
      `UPDATE ${this.table} SET state = 'uncertain', updated_ts = ? WHERE state = 'active'`,
      [now],
    );
  }

  prune(owner: AttemptOwner): number {
    return this.db.run(
      `DELETE FROM ${this.table}
       WHERE rowid IN (
         SELECT rowid FROM ${this.table}
         WHERE request_client = ? AND session_id = ? AND provider_id = ? AND state <> 'active'
         ORDER BY updated_ts DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
      [
        owner.requestClient,
        owner.lilacSessionId,
        owner.providerId,
        TERMINAL_ATTEMPT_RETENTION_LIMIT,
      ],
    ).changes;
  }
}
