import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  blobHandleV1Schema,
  blobRefV1Schema,
  type BlobHandleV1,
  type BlobRefV1,
} from "@stanley2058/lilac-blob-storage";
import { classifyBunSqliteError, runBunSqliteTransaction } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import {
  RequestDeliveryCodecFailure,
  RequestDeliveryConflict,
  RequestDeliveryInvalidTransition,
  RequestDeliveryNotFound,
  RequestDeliverySqliteFailure,
  type AcceptedRequestDelivery,
  type PreparedRequestDelivery,
  type RequestDeliveryAcceptanceResult,
  type RequestDeliveryInputTarget,
  type RequestDeliveryPrepareResult,
  type RequestDeliveryPublication,
  type RequestDeliveryRecord,
  type RequestDeliverySerializedValue,
  type RequestDeliveryStoreError,
  type RequestDeliveryTerminalOutcome,
  type RequestDeliveryTerminalizeResult,
  type RequestDeliveryValueCodec,
  type RequestOutputLifecycle,
  type TerminalRequestDelivery,
} from "./types";

type RequestDeliveryRow = {
  request_delivery_id: string;
  request_id: string;
  state: string;
  envelope_json: string | null;
  input_handles_json: string | null;
  accepted_work_json: string | null;
  input_references_json: string | null;
  publication_stream_id: string | null;
  publication_recorded_at: number | null;
  created_at: number;
  accepted_at: number | null;
  terminal_at: number | null;
  terminal_outcome_json: string | null;
  transport_commit_required: number;
  transport_committed_at: number | null;
  input_cleanup_json: string | null;
  final_replay_deadline: number | null;
};

type RequestOutputRow = {
  request_delivery_id: string;
  request_id: string;
  object_id: string;
  target_json: string;
  metadata_json: string;
  created_at: number;
  delete_after: number | null;
};

export type RequestDeliveryCodecs<TEnvelope, TWork, TOutputMetadata> = {
  readonly envelope: RequestDeliveryValueCodec<TEnvelope>;
  readonly acceptedWork: RequestDeliveryValueCodec<TWork>;
  readonly outputMetadata: RequestDeliveryValueCodec<TOutputMetadata>;
};

export type RequestDeliveryOutputLifecycle<TMetadata> = RequestOutputLifecycle<TMetadata>;

export type AcceptedRecoveryRow<TWork> = {
  readonly requestDeliveryId: string;
  readonly acceptedAt: number;
  readonly record: ResultType<AcceptedRequestDelivery<TWork>, RequestDeliveryCodecFailure>;
};

function sqliteFailure(operation: string, cause: Error): RequestDeliverySqliteFailure | undefined {
  const classified = classifyBunSqliteError(cause);
  if (!classified) return undefined;
  return new RequestDeliverySqliteFailure({
    operation,
    code: classified.code,
    message: `Request delivery SQLite ${operation} failed`,
  });
}

function transaction<T, TError extends Error>(
  database: Database,
  operation: string,
  callback: () => ResultType<T, TError>,
): ResultType<T, TError | RequestDeliverySqliteFailure> {
  return runBunSqliteTransaction(database, callback, (cause) => sqliteFailure(operation, cause));
}

function encodeJson<T>(
  value: T,
  codec: RequestDeliveryValueCodec<T>,
  field: string,
): ResultType<string, RequestDeliveryCodecFailure> {
  if (codec.serialize) {
    return codec.serialize(value).mapError(
      () =>
        new RequestDeliveryCodecFailure({
          field,
          message: `Request delivery ${field} is not serializable`,
        }),
    );
  }
  return codec
    .decode(value)
    .mapError(
      () =>
        new RequestDeliveryCodecFailure({
          field,
          message: `Request delivery ${field} failed codec validation`,
        }),
    )
    .andThen((decoded) =>
      Result.try({
        try: () => JSON.stringify(decoded),
        catch: () =>
          new RequestDeliveryCodecFailure({
            field,
            message: `Request delivery ${field} is not JSON serializable`,
          }),
      }).andThen((json) =>
        json === undefined
          ? Result.err(
              new RequestDeliveryCodecFailure({
                field,
                message: `Request delivery ${field} is not JSON serializable`,
              }),
            )
          : Result.ok(json),
      ),
    );
}

function decodeJson<T>(
  json: string,
  codec: RequestDeliveryValueCodec<T>,
  field: string,
): ResultType<T, RequestDeliveryCodecFailure> {
  if (codec.deserialize) {
    return codec.deserialize(json).mapError(
      () =>
        new RequestDeliveryCodecFailure({
          field,
          message: `Persisted request delivery ${field} failed codec validation`,
        }),
    );
  }
  return Result.try({
    try: () => JSON.parse(json) as RequestDeliverySerializedValue,
    catch: () =>
      new RequestDeliveryCodecFailure({
        field,
        message: `Persisted request delivery ${field} is not valid JSON`,
      }),
  })
    .mapError((error) => error)
    .andThen((value) =>
      codec.decode(value).mapError(
        () =>
          new RequestDeliveryCodecFailure({
            field,
            message: `Persisted request delivery ${field} failed codec validation`,
          }),
      ),
    );
}

function blobHandleCodec(): RequestDeliveryValueCodec<BlobHandleV1> {
  return {
    decode(value) {
      const decoded = blobHandleV1Schema.safeParse(value);
      return decoded.success ? Result.ok(decoded.data) : Result.err(decoded.error);
    },
  };
}

function blobRefCodec(): RequestDeliveryValueCodec<BlobRefV1> {
  return {
    decode(value) {
      const decoded = blobRefV1Schema.safeParse(value);
      return decoded.success ? Result.ok(decoded.data) : Result.err(decoded.error);
    },
  };
}

function arrayCodec<T>(
  codec: RequestDeliveryValueCodec<T>,
): RequestDeliveryValueCodec<readonly T[]> {
  return {
    decode(value) {
      if (!Array.isArray(value)) return Result.err(new Error("Expected an array"));
      return Result.all(value.map((entry) => codec.decode(entry)));
    },
  };
}

function decodeRequestDeliveryInputTarget(
  value: unknown,
): ResultType<RequestDeliveryInputTarget, Error> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.err(new Error("Expected an input target"));
  }
  const candidate = value as {
    kind?: RequestDeliverySerializedValue;
    blob?: RequestDeliverySerializedValue;
  };
  if (candidate.kind === "handle") {
    if (candidate.blob === undefined) return Result.err(new Error("Expected a blob handle"));
    return blobHandleCodec()
      .decode(candidate.blob)
      .map((blob) => ({ kind: "handle", blob }));
  }
  if (candidate.kind === "reference") {
    if (candidate.blob === undefined) return Result.err(new Error("Expected a blob reference"));
    return blobRefCodec()
      .decode(candidate.blob)
      .map((blob) => ({ kind: "reference", blob }));
  }
  return Result.err(new Error("Expected a versioned input target"));
}

const inputTargetCodec: RequestDeliveryValueCodec<RequestDeliveryInputTarget> = {
  decode: decodeRequestDeliveryInputTarget,
};

function decodeRequestDeliveryTerminalOutcome(
  value: unknown,
): ResultType<RequestDeliveryTerminalOutcome, Error> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Result.err(new Error("Expected a terminal outcome"));
  }
  const candidate = value as {
    kind?: RequestDeliverySerializedValue;
    code?: RequestDeliverySerializedValue;
  };
  const allowed = new Set([
    "completed",
    "failed",
    "cancelled",
    "abandoned",
    "publication-failed",
    "upload-failed",
    "upload-timeout",
  ]);
  if (typeof candidate.kind !== "string" || !allowed.has(candidate.kind)) {
    return Result.err(new Error("Expected a terminal outcome kind"));
  }
  if (candidate.code !== undefined && typeof candidate.code !== "string") {
    return Result.err(new Error("Expected an optional terminal outcome code"));
  }
  return Result.ok({
    kind: candidate.kind as RequestDeliveryTerminalOutcome["kind"],
    ...(candidate.code === undefined ? {} : { code: candidate.code }),
  });
}

const terminalOutcomeCodec: RequestDeliveryValueCodec<RequestDeliveryTerminalOutcome> = {
  decode: decodeRequestDeliveryTerminalOutcome,
};

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requiredTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function publicationFromRow(
  row: RequestDeliveryRow,
): ResultType<RequestDeliveryPublication | undefined, RequestDeliveryCodecFailure> {
  if (row.publication_stream_id === null && row.publication_recorded_at === null) {
    return Result.ok(undefined);
  }
  if (
    !requiredString(row.publication_stream_id) ||
    !requiredTimestamp(row.publication_recorded_at)
  ) {
    return Result.err(
      new RequestDeliveryCodecFailure({
        field: "publication",
        message: "Persisted request delivery publication is incomplete",
      }),
    );
  }
  return Result.ok({
    streamId: row.publication_stream_id,
    recordedAt: row.publication_recorded_at,
  });
}

export class SqliteRequestDeliveryStore<TEnvelope, TWork, TOutputMetadata> {
  readonly #database: Database;
  readonly #codecs: RequestDeliveryCodecs<TEnvelope, TWork, TOutputMetadata>;

  constructor(input: {
    readonly dbPath: string;
    readonly codecs: RequestDeliveryCodecs<TEnvelope, TWork, TOutputMetadata>;
  }) {
    this.#database = new Database(input.dbPath, { create: true, strict: true });
    this.#codecs = input.codecs;
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS request_delivery_records (
        request_delivery_id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted', 'terminal')),
        envelope_json TEXT,
        input_handles_json TEXT,
        accepted_work_json TEXT,
        input_references_json TEXT,
        publication_stream_id TEXT,
        publication_recorded_at INTEGER,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        terminal_at INTEGER,
        terminal_outcome_json TEXT,
        transport_commit_required INTEGER NOT NULL DEFAULT 0,
        transport_committed_at INTEGER,
        input_cleanup_json TEXT,
        final_replay_deadline INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request_delivery_outputs (
        request_delivery_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        object_id TEXT PRIMARY KEY NOT NULL,
        target_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delete_after INTEGER,
        FOREIGN KEY (request_delivery_id) REFERENCES request_delivery_records(request_delivery_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS request_delivery_records_recovery_idx
        ON request_delivery_records(state, created_at, request_delivery_id);
      CREATE INDEX IF NOT EXISTS request_delivery_records_request_idx
        ON request_delivery_records(request_id, state, created_at, request_delivery_id);
      CREATE INDEX IF NOT EXISTS request_delivery_outputs_cleanup_idx
        ON request_delivery_outputs(delete_after, object_id);
    `);
  }

  close(): void {
    this.#database.close();
  }

  prepare(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly envelope: TEnvelope;
    readonly inputHandles: readonly BlobHandleV1[];
    readonly createdAt: number;
  }): ResultType<RequestDeliveryPrepareResult<TEnvelope>, RequestDeliveryStoreError> {
    if (!requiredString(input.requestDeliveryId) || !requiredString(input.requestId)) {
      return Result.err(
        new RequestDeliveryConflict({
          requestDeliveryId: input.requestDeliveryId,
          message: "Request delivery IDs must be non-empty",
        }),
      );
    }
    if (!requiredTimestamp(input.createdAt)) {
      return Result.err(
        new RequestDeliveryConflict({
          requestDeliveryId: input.requestDeliveryId,
          message: "Request delivery createdAt must be a non-negative safe integer",
        }),
      );
    }

    return encodeJson(input.envelope, this.#codecs.envelope, "envelope").andThen((envelopeJson) =>
      encodeJson(input.inputHandles, arrayCodec(blobHandleCodec()), "inputHandles").andThen(
        (handlesJson) =>
          transaction(
            this.#database,
            "prepare",
            (): ResultType<RequestDeliveryPrepareResult<TEnvelope>, RequestDeliveryStoreError> => {
              const existing = this.#selectRow(input.requestDeliveryId);
              if (existing) {
                return this.#decodeRow(existing).andThen((record) => {
                  if (
                    record.state !== "prepared" ||
                    record.requestId !== input.requestId ||
                    !isDeepStrictEqual(record.envelope, input.envelope) ||
                    !isDeepStrictEqual(record.inputHandles, input.inputHandles)
                  ) {
                    return Result.err(
                      new RequestDeliveryConflict({
                        requestDeliveryId: input.requestDeliveryId,
                        message: "Request delivery ID is already bound to different durable work",
                      }),
                    );
                  }
                  return Result.ok({ status: "existing", record } as const);
                });
              }
              this.#database.run(
                `INSERT INTO request_delivery_records (
            request_delivery_id, request_id, state, envelope_json, input_handles_json, created_at
          ) VALUES (?, ?, 'prepared', ?, ?, ?)`,
                [
                  input.requestDeliveryId,
                  input.requestId,
                  envelopeJson,
                  handlesJson,
                  input.createdAt,
                ],
              );
              return Result.ok({
                status: "created",
                record: {
                  state: "prepared",
                  requestDeliveryId: input.requestDeliveryId,
                  requestId: input.requestId,
                  envelope: input.envelope,
                  inputHandles: input.inputHandles,
                  createdAt: input.createdAt,
                },
              } as const);
            },
          ),
      ),
    );
  }

  load(
    requestDeliveryId: string,
  ): ResultType<RequestDeliveryRecord<TEnvelope, TWork>, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "load",
      (): ResultType<RequestDeliveryRecord<TEnvelope, TWork>, RequestDeliveryStoreError> => {
        const row = this.#selectRow(requestDeliveryId);
        return row
          ? this.#decodeRow(row)
          : Result.err(
              new RequestDeliveryNotFound({
                requestDeliveryId,
                message: "Request delivery record was not found",
              }),
            );
      },
    );
  }

  recordPublication(input: {
    readonly requestDeliveryId: string;
    readonly streamId: string;
    readonly recordedAt: number;
  }): ResultType<RequestDeliveryRecord<TEnvelope, TWork>, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "record-publication",
      (): ResultType<RequestDeliveryRecord<TEnvelope, TWork>, RequestDeliveryStoreError> => {
        const row = this.#selectRow(input.requestDeliveryId);
        if (!row) {
          return Result.err(
            new RequestDeliveryNotFound({
              requestDeliveryId: input.requestDeliveryId,
              message: "Cannot record publication for a missing request delivery",
            }),
          );
        }
        if (row.publication_stream_id !== null && row.publication_stream_id !== input.streamId) {
          return Result.err(
            new RequestDeliveryConflict({
              requestDeliveryId: input.requestDeliveryId,
              message: "Request delivery publication resolved to a different Redis stream entry",
            }),
          );
        }
        this.#database.run(
          `UPDATE request_delivery_records
         SET publication_stream_id = ?,
             publication_recorded_at = COALESCE(publication_recorded_at, ?)
         WHERE request_delivery_id = ?`,
          [input.streamId, input.recordedAt, input.requestDeliveryId],
        );
        const updated = this.#selectRow(input.requestDeliveryId);
        return updated
          ? this.#decodeRow(updated)
          : Result.err(this.#missing(input.requestDeliveryId));
      },
    );
  }

  accept(input: {
    readonly requestDeliveryId: string;
    readonly work: TWork;
    readonly inputReferences: readonly BlobRefV1[];
    readonly acceptedAt: number;
  }): ResultType<RequestDeliveryAcceptanceResult<TWork>, RequestDeliveryStoreError> {
    return encodeJson(input.work, this.#codecs.acceptedWork, "acceptedWork").andThen((workJson) =>
      encodeJson(input.inputReferences, arrayCodec(blobRefCodec()), "inputReferences").andThen(
        (referencesJson) =>
          transaction(
            this.#database,
            "accept",
            (): ResultType<RequestDeliveryAcceptanceResult<TWork>, RequestDeliveryStoreError> => {
              const row = this.#selectRow(input.requestDeliveryId);
              if (!row) return Result.err(this.#missing(input.requestDeliveryId));
              if (row.state === "accepted") {
                return this.#decodeAccepted(row).andThen((record) =>
                  isDeepStrictEqual(record.work, input.work) &&
                  isDeepStrictEqual(record.inputReferences, input.inputReferences)
                    ? Result.ok({ status: "already-accepted", record } as const)
                    : Result.err(
                        new RequestDeliveryConflict({
                          requestDeliveryId: input.requestDeliveryId,
                          message: "Accepted request delivery is bound to different durable work",
                        }),
                      ),
                );
              }
              if (row.state !== "prepared") {
                return Result.err(
                  new RequestDeliveryInvalidTransition({
                    requestDeliveryId: input.requestDeliveryId,
                    from: row.state,
                    to: "accepted",
                    message: "Only a prepared request delivery can be accepted",
                  }),
                );
              }
              this.#database.run(
                `UPDATE request_delivery_records SET
             state = 'accepted', envelope_json = NULL, input_handles_json = NULL,
             accepted_work_json = ?, input_references_json = ?, accepted_at = ?
           WHERE request_delivery_id = ?`,
                [workJson, referencesJson, input.acceptedAt, input.requestDeliveryId],
              );
              const updated = this.#selectRow(input.requestDeliveryId);
              if (!updated) return Result.err(this.#missing(input.requestDeliveryId));
              return this.#decodeAccepted(updated).map((record) => ({
                status: "accepted",
                record,
              }));
            },
          ),
      ),
    );
  }

  replaceAcceptedWork(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly work: TWork;
  }): ResultType<AcceptedRequestDelivery<TWork>, RequestDeliveryStoreError> {
    if (input.requestId.length === 0) {
      return Result.err(
        new RequestDeliveryConflict({
          requestDeliveryId: input.requestDeliveryId,
          message: "Projected durable work must retain a non-empty request identity",
        }),
      );
    }
    return encodeJson(input.work, this.#codecs.acceptedWork, "acceptedWork").andThen((workJson) =>
      transaction(
        this.#database,
        "replace-accepted-work",
        (): ResultType<AcceptedRequestDelivery<TWork>, RequestDeliveryStoreError> => {
          const row = this.#selectRow(input.requestDeliveryId);
          if (!row) return Result.err(this.#missing(input.requestDeliveryId));
          if (row.state !== "accepted") {
            return Result.err(
              new RequestDeliveryInvalidTransition({
                requestDeliveryId: input.requestDeliveryId,
                from: row.state,
                to: "accepted-work-replaced",
                message: "Only accepted durable work can record projected queue facts",
              }),
            );
          }
          this.#database.run(
            `UPDATE request_delivery_records
               SET request_id = ?, accepted_work_json = ?
             WHERE request_delivery_id = ?`,
            [input.requestId, workJson, input.requestDeliveryId],
          );
          this.#database.run(
            `UPDATE request_delivery_outputs
               SET request_id = ?
             WHERE request_delivery_id = ?`,
            [input.requestId, input.requestDeliveryId],
          );
          const updated = this.#selectRow(input.requestDeliveryId);
          return updated
            ? this.#decodeAccepted(updated)
            : Result.err(this.#missing(input.requestDeliveryId));
        },
      ),
    );
  }

  terminalize(input: {
    readonly requestDeliveryId: string;
    readonly outcome: RequestDeliveryTerminalOutcome;
    readonly terminalAt: number;
    readonly transportCommitRequired: boolean;
    readonly finalReplayDeadline?: number;
  }): ResultType<RequestDeliveryTerminalizeResult, RequestDeliveryStoreError> {
    if (
      !requiredTimestamp(input.terminalAt) ||
      (input.finalReplayDeadline !== undefined && !requiredTimestamp(input.finalReplayDeadline))
    ) {
      return Result.err(
        new RequestDeliveryConflict({
          requestDeliveryId: input.requestDeliveryId,
          message: "Request terminal and replay timestamps must be non-negative safe integers",
        }),
      );
    }
    return encodeJson(input.outcome, terminalOutcomeCodec, "terminalOutcome").andThen(
      (outcomeJson) =>
        transaction(
          this.#database,
          "terminalize",
          (): ResultType<RequestDeliveryTerminalizeResult, RequestDeliveryStoreError> => {
            const row = this.#selectRow(input.requestDeliveryId);
            if (!row) return Result.err(this.#missing(input.requestDeliveryId));
            if (row.state === "terminal") {
              return this.#decodeTerminal(row).andThen((record) =>
                isDeepStrictEqual(record.outcome, input.outcome) &&
                record.finalReplayDeadline === input.finalReplayDeadline
                  ? Result.ok({ status: "already-terminal", record } as const)
                  : Result.err(
                      new RequestDeliveryConflict({
                        requestDeliveryId: input.requestDeliveryId,
                        message:
                          "Terminal request delivery has a different outcome or replay deadline",
                      }),
                    ),
              );
            }

            const pendingTargets =
              row.state === "prepared"
                ? decodeJson(
                    row.input_handles_json ?? "null",
                    arrayCodec(blobHandleCodec()),
                    "inputHandles",
                  ).map((handles) => handles.map((blob) => ({ kind: "handle", blob }) as const))
                : decodeJson(
                    row.input_references_json ?? "null",
                    arrayCodec(blobRefCodec()),
                    "inputReferences",
                  ).map((references) =>
                    references.map((blob) => ({ kind: "reference", blob }) as const),
                  );

            return pendingTargets.andThen((targets) => {
              const outputCount =
                this.#database
                  .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) AS count FROM request_delivery_outputs WHERE request_delivery_id = ?",
                  )
                  .get(input.requestDeliveryId)?.count ?? 0;
              if (outputCount > 0 && input.finalReplayDeadline === undefined) {
                return Result.err(
                  new RequestDeliveryConflict({
                    requestDeliveryId: input.requestDeliveryId,
                    message:
                      "A request with output blobs needs a Redis replay deadline before terminalization",
                  }),
                );
              }
              return encodeJson(targets, arrayCodec(inputTargetCodec), "inputCleanup").andThen(
                (cleanupJson) => {
                  this.#database.run(
                    `UPDATE request_delivery_records SET
                   state = 'terminal', envelope_json = NULL, input_handles_json = NULL,
                   accepted_work_json = NULL, input_references_json = NULL,
                   terminal_at = ?, terminal_outcome_json = ?, transport_commit_required = ?,
                   input_cleanup_json = ?, final_replay_deadline = ?
                 WHERE request_delivery_id = ?`,
                    [
                      input.terminalAt,
                      outcomeJson,
                      input.transportCommitRequired ? 1 : 0,
                      cleanupJson,
                      input.finalReplayDeadline ?? null,
                      input.requestDeliveryId,
                    ],
                  );
                  if (input.finalReplayDeadline !== undefined) {
                    this.#database.run(
                      `UPDATE request_delivery_outputs SET delete_after = ?
                   WHERE request_delivery_id = ?`,
                      [input.finalReplayDeadline, input.requestDeliveryId],
                    );
                  }
                  const updated = this.#selectRow(input.requestDeliveryId);
                  if (!updated) return Result.err(this.#missing(input.requestDeliveryId));
                  return this.#decodeTerminal(updated).map((record) => ({
                    status: "terminalized" as const,
                    record,
                  }));
                },
              );
            });
          },
        ),
    );
  }

  observeTransportCommit(input: {
    readonly requestDeliveryId: string;
    readonly streamId?: string;
    readonly committedAt: number;
  }): ResultType<void, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "observe-transport-commit",
      (): ResultType<void, RequestDeliveryStoreError> => {
        const row = this.#selectRow(input.requestDeliveryId);
        if (!row) return Result.err(this.#missing(input.requestDeliveryId));
        if (
          input.streamId !== undefined &&
          row.publication_stream_id !== null &&
          row.publication_stream_id !== input.streamId
        ) {
          return Result.err(
            new RequestDeliveryConflict({
              requestDeliveryId: input.requestDeliveryId,
              message: "Transport commit references a different Redis stream entry",
            }),
          );
        }
        this.#database.run(
          `UPDATE request_delivery_records
         SET transport_committed_at = COALESCE(transport_committed_at, ?),
             publication_stream_id = COALESCE(publication_stream_id, ?),
             publication_recorded_at = COALESCE(publication_recorded_at, ?)
         WHERE request_delivery_id = ?`,
          [
            input.committedAt,
            input.streamId ?? null,
            input.streamId === undefined ? null : input.committedAt,
            input.requestDeliveryId,
          ],
        );
        return Result.ok(undefined);
      },
    );
  }

  registerOutputHandle(input: {
    readonly requestDeliveryId: string;
    readonly handle: BlobHandleV1;
    readonly metadata: TOutputMetadata;
    readonly createdAt: number;
  }): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> {
    const target: RequestDeliveryInputTarget = {
      kind: "handle",
      blob: input.handle,
    };
    return encodeJson(target, inputTargetCodec, "outputTarget").andThen((targetJson) =>
      encodeJson(input.metadata, this.#codecs.outputMetadata, "outputMetadata").andThen(
        (metadataJson) =>
          transaction(
            this.#database,
            "register-output",
            (): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> => {
              const owner = this.#selectRow(input.requestDeliveryId);
              if (!owner) {
                return Result.err(
                  new RequestDeliveryNotFound({
                    requestDeliveryId: input.requestDeliveryId,
                    message: "No request delivery owns the output lifecycle registration",
                  }),
                );
              }
              if (owner.state !== "accepted") {
                return Result.err(
                  new RequestDeliveryInvalidTransition({
                    requestDeliveryId: owner.request_delivery_id,
                    from: owner.state,
                    to: "output-registered",
                    message: "Only an accepted request can register output",
                  }),
                );
              }
              const existing = this.#selectOutput(input.handle.objectId);
              if (existing) {
                return this.#decodeOutput(existing).andThen((record) =>
                  record.requestDeliveryId === input.requestDeliveryId &&
                  isDeepStrictEqual(record.target, target) &&
                  isDeepStrictEqual(record.metadata, input.metadata)
                    ? Result.ok(record)
                    : Result.err(
                        new RequestDeliveryConflict({
                          requestDeliveryId: owner.request_delivery_id,
                          message: "Output object is already owned by another lifecycle record",
                        }),
                      ),
                );
              }
              this.#database.run(
                `INSERT INTO request_delivery_outputs (
             request_delivery_id, request_id, object_id, target_json, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  owner.request_delivery_id,
                  owner.request_id,
                  input.handle.objectId,
                  targetJson,
                  metadataJson,
                  input.createdAt,
                ],
              );
              return Result.ok({
                requestDeliveryId: owner.request_delivery_id,
                requestId: owner.request_id,
                target,
                metadata: input.metadata,
                createdAt: input.createdAt,
              });
            },
          ),
      ),
    );
  }

  recordOutputReference(input: {
    readonly requestDeliveryId: string;
    readonly reference: BlobRefV1;
  }): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> {
    const target: RequestDeliveryInputTarget = {
      kind: "reference",
      blob: input.reference,
    };
    return encodeJson(target, inputTargetCodec, "outputTarget").andThen((targetJson) =>
      transaction(
        this.#database,
        "record-output-reference",
        (): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryStoreError> => {
          const row = this.#selectOutput(input.reference.objectId);
          if (!row) {
            return Result.err(
              new RequestDeliveryNotFound({
                requestDeliveryId: input.requestDeliveryId,
                message: "Output lifecycle handle was not registered before publication",
              }),
            );
          }
          if (row.request_delivery_id !== input.requestDeliveryId) {
            return Result.err(
              new RequestDeliveryConflict({
                requestDeliveryId: row.request_delivery_id,
                message: "Output reference belongs to a different request",
              }),
            );
          }
          this.#database.run(
            "UPDATE request_delivery_outputs SET target_json = ? WHERE object_id = ?",
            [targetJson, input.reference.objectId],
          );
          const updated = this.#selectOutput(input.reference.objectId);
          return updated
            ? this.#decodeOutput(updated)
            : Result.err(this.#missing(row.request_delivery_id));
        },
      ),
    );
  }

  listPreparedForPublication(input?: {
    readonly limit?: number;
    readonly after?: { readonly createdAt: number; readonly requestDeliveryId: string };
  }): ResultType<readonly PreparedRequestDelivery<TEnvelope>[], RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "list-prepared",
      (): ResultType<readonly PreparedRequestDelivery<TEnvelope>[], RequestDeliveryStoreError> => {
        const limit = Math.max(1, Math.min(1_000, input?.limit ?? 100));
        const rows = input?.after
          ? this.#database
              .query<RequestDeliveryRow, [number, number, string, number]>(
                `SELECT * FROM request_delivery_records
                 WHERE state = 'prepared'
                   AND (created_at > ? OR (created_at = ? AND request_delivery_id > ?))
                 ORDER BY created_at, request_delivery_id LIMIT ?`,
              )
              .all(
                input.after.createdAt,
                input.after.createdAt,
                input.after.requestDeliveryId,
                limit,
              )
          : this.#database
              .query<RequestDeliveryRow, [number]>(
                `SELECT * FROM request_delivery_records
                 WHERE state = 'prepared'
                 ORDER BY created_at, request_delivery_id LIMIT ?`,
              )
              .all(limit);
        return Result.all(rows.map((row) => this.#decodePrepared(row)));
      },
    );
  }

  /** Lists one page of accepted rows; each row decodes on its own so one bad row stays isolated. */
  listAcceptedForRecovery(input?: {
    readonly limit?: number;
    readonly after?: { readonly acceptedAt: number; readonly requestDeliveryId: string };
  }): ResultType<readonly AcceptedRecoveryRow<TWork>[], RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "list-accepted",
      (): ResultType<readonly AcceptedRecoveryRow<TWork>[], RequestDeliveryStoreError> => {
        const limit = Math.max(1, Math.min(1_000, input?.limit ?? 100));
        const rows = input?.after
          ? this.#database
              .query<RequestDeliveryRow, [number, number, string, number]>(
                `SELECT * FROM request_delivery_records
                 WHERE state = 'accepted'
                   AND (accepted_at > ? OR (accepted_at = ? AND request_delivery_id > ?))
                 ORDER BY accepted_at, request_delivery_id LIMIT ?`,
              )
              .all(
                input.after.acceptedAt,
                input.after.acceptedAt,
                input.after.requestDeliveryId,
                limit,
              )
          : this.#database
              .query<RequestDeliveryRow, [number]>(
                `SELECT * FROM request_delivery_records
                 WHERE state = 'accepted'
                 ORDER BY accepted_at, request_delivery_id LIMIT ?`,
              )
              .all(limit);
        return Result.ok(
          rows.map((row) => ({
            requestDeliveryId: row.request_delivery_id,
            acceptedAt: row.accepted_at ?? 0,
            record: this.#decodeAccepted(row),
          })),
        );
      },
    );
  }

  listPendingInputCleanup(input?: {
    readonly limit?: number;
  }): ResultType<readonly TerminalRequestDelivery[], RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "list-input-cleanup",
      (): ResultType<readonly TerminalRequestDelivery[], RequestDeliveryStoreError> => {
        const rows = this.#database
          .query<RequestDeliveryRow, [number]>(
            `SELECT * FROM request_delivery_records
           WHERE state = 'terminal' AND input_cleanup_json <> '[]'
           ORDER BY terminal_at, request_delivery_id LIMIT ?`,
          )
          .all(Math.max(1, Math.min(1_000, input?.limit ?? 100)));
        return Result.all(rows.map((row) => this.#decodeTerminal(row)));
      },
    );
  }

  markInputObjectDeleted(input: {
    readonly requestDeliveryId: string;
    readonly objectId: string;
  }): ResultType<void, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "mark-input-deleted",
      (): ResultType<void, RequestDeliveryStoreError> => {
        const row = this.#selectRow(input.requestDeliveryId);
        if (!row) return Result.err(this.#missing(input.requestDeliveryId));
        if (row.state !== "terminal") {
          return Result.err(
            new RequestDeliveryInvalidTransition({
              requestDeliveryId: input.requestDeliveryId,
              from: row.state,
              to: "input-cleaned",
              message: "Input ownership can be detached only from a terminal request",
            }),
          );
        }
        return decodeJson(
          row.input_cleanup_json ?? "null",
          arrayCodec(inputTargetCodec),
          "inputCleanup",
        ).andThen((targets) =>
          encodeJson(
            targets.filter((target) => target.blob.objectId !== input.objectId),
            arrayCodec(inputTargetCodec),
            "inputCleanup",
          ).map((json) => {
            this.#database.run(
              "UPDATE request_delivery_records SET input_cleanup_json = ? WHERE request_delivery_id = ?",
              [json, input.requestDeliveryId],
            );
          }),
        );
      },
    );
  }

  listOutputsForRequest(
    requestId: string,
  ): ResultType<readonly RequestOutputLifecycle<TOutputMetadata>[], RequestDeliveryStoreError> {
    return transaction(this.#database, "list-request-outputs", () => {
      const rows = this.#database
        .query<RequestOutputRow, [string]>(
          "SELECT * FROM request_delivery_outputs WHERE request_id = ? ORDER BY created_at, object_id",
        )
        .all(requestId);
      return Result.all(rows.map((row) => this.#decodeOutput(row)));
    });
  }

  listDueOutputs(input: {
    readonly now: number;
    readonly limit?: number;
  }): ResultType<readonly RequestOutputLifecycle<TOutputMetadata>[], RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "list-due-outputs",
      (): ResultType<
        readonly RequestOutputLifecycle<TOutputMetadata>[],
        RequestDeliveryStoreError
      > => {
        const rows = this.#database
          .query<RequestOutputRow, [number, number]>(
            `SELECT * FROM request_delivery_outputs
           WHERE delete_after IS NOT NULL AND delete_after <= ?
           ORDER BY delete_after, object_id LIMIT ?`,
          )
          .all(input.now, Math.max(1, Math.min(1_000, input.limit ?? 100)));
        return Result.all(rows.map((row) => this.#decodeOutput(row)));
      },
    );
  }

  markOutputDeleted(input: {
    readonly requestDeliveryId: string;
    readonly objectId: string;
  }): ResultType<void, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "mark-output-deleted",
      (): ResultType<void, RequestDeliveryStoreError> => {
        this.#database.run(
          "DELETE FROM request_delivery_outputs WHERE request_delivery_id = ? AND object_id = ?",
          [input.requestDeliveryId, input.objectId],
        );
        return Result.ok(undefined);
      },
    );
  }

  deleteEligibleTombstones(input?: {
    readonly limit?: number;
  }): ResultType<number, RequestDeliveryStoreError> {
    return transaction(
      this.#database,
      "delete-tombstones",
      (): ResultType<number, RequestDeliveryStoreError> => {
        const ids = this.#database
          .query<{ request_delivery_id: string }, [number]>(
            `SELECT request_delivery_id FROM request_delivery_records AS record
           WHERE state = 'terminal'
             AND input_cleanup_json = '[]'
             AND (
               transport_commit_required = 0 OR (
                 transport_committed_at IS NOT NULL AND publication_stream_id IS NOT NULL
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM request_delivery_outputs AS output
               WHERE output.request_delivery_id = record.request_delivery_id
             )
           ORDER BY terminal_at, request_delivery_id LIMIT ?`,
          )
          .all(Math.max(1, Math.min(1_000, input?.limit ?? 100)));
        for (const row of ids) {
          this.#database.run("DELETE FROM request_delivery_records WHERE request_delivery_id = ?", [
            row.request_delivery_id,
          ]);
        }
        return Result.ok(ids.length);
      },
    );
  }

  #selectRow(requestDeliveryId: string): RequestDeliveryRow | null {
    return this.#database
      .query<RequestDeliveryRow, [string]>(
        "SELECT * FROM request_delivery_records WHERE request_delivery_id = ?",
      )
      .get(requestDeliveryId);
  }

  #selectOutput(objectId: string): RequestOutputRow | null {
    return this.#database
      .query<RequestOutputRow, [string]>(
        "SELECT * FROM request_delivery_outputs WHERE object_id = ?",
      )
      .get(objectId);
  }

  #missing(requestDeliveryId: string): RequestDeliveryNotFound {
    return new RequestDeliveryNotFound({
      requestDeliveryId,
      message: "Request delivery record disappeared during its transaction",
    });
  }

  #decodeRow(
    row: RequestDeliveryRow,
  ): ResultType<RequestDeliveryRecord<TEnvelope, TWork>, RequestDeliveryCodecFailure> {
    switch (row.state) {
      case "prepared":
        return this.#decodePrepared(row);
      case "accepted":
        return this.#decodeAccepted(row);
      case "terminal":
        return this.#decodeTerminal(row);
      default:
        return Result.err(
          new RequestDeliveryCodecFailure({
            field: "state",
            message: "Persisted request delivery state is invalid",
          }),
        );
    }
  }

  #decodePrepared(
    row: RequestDeliveryRow,
  ): ResultType<PreparedRequestDelivery<TEnvelope>, RequestDeliveryCodecFailure> {
    const envelopeCodec = this.#codecs.envelope;
    return Result.gen(function* () {
      if (!requiredTimestamp(row.created_at)) {
        return yield* Result.err(
          new RequestDeliveryCodecFailure({
            field: "createdAt",
            message: "Persisted prepared request delivery has an invalid creation timestamp",
          }),
        );
      }
      const envelope = yield* decodeJson(row.envelope_json ?? "null", envelopeCodec, "envelope");
      const inputHandles = yield* decodeJson(
        row.input_handles_json ?? "null",
        arrayCodec(blobHandleCodec()),
        "inputHandles",
      );
      const publication = yield* publicationFromRow(row);
      return Result.ok<PreparedRequestDelivery<TEnvelope>>({
        state: "prepared",
        requestDeliveryId: row.request_delivery_id,
        requestId: row.request_id,
        envelope,
        inputHandles,
        ...(publication ? { publication } : {}),
        createdAt: row.created_at,
        ...(row.transport_committed_at === null
          ? {}
          : { transportCommittedAt: row.transport_committed_at }),
      });
    });
  }

  #decodeAccepted(
    row: RequestDeliveryRow,
  ): ResultType<AcceptedRequestDelivery<TWork>, RequestDeliveryCodecFailure> {
    const acceptedWorkCodec = this.#codecs.acceptedWork;
    return Result.gen(function* () {
      if (!requiredTimestamp(row.created_at) || !requiredTimestamp(row.accepted_at)) {
        return yield* Result.err(
          new RequestDeliveryCodecFailure({
            field: "acceptedAt",
            message: "Persisted accepted request delivery has invalid timestamps",
          }),
        );
      }
      const work = yield* decodeJson(
        row.accepted_work_json ?? "null",
        acceptedWorkCodec,
        "acceptedWork",
      );
      const inputReferences = yield* decodeJson(
        row.input_references_json ?? "null",
        arrayCodec(blobRefCodec()),
        "inputReferences",
      );
      const publication = yield* publicationFromRow(row);
      return Result.ok<AcceptedRequestDelivery<TWork>>({
        state: "accepted",
        requestDeliveryId: row.request_delivery_id,
        requestId: row.request_id,
        work,
        inputReferences,
        ...(publication ? { publication } : {}),
        createdAt: row.created_at,
        acceptedAt: row.accepted_at,
        ...(row.transport_committed_at === null
          ? {}
          : { transportCommittedAt: row.transport_committed_at }),
      });
    });
  }

  #decodeTerminal(
    row: RequestDeliveryRow,
  ): ResultType<TerminalRequestDelivery, RequestDeliveryCodecFailure> {
    return Result.gen(function* () {
      if (!requiredTimestamp(row.created_at) || !requiredTimestamp(row.terminal_at)) {
        return yield* Result.err(
          new RequestDeliveryCodecFailure({
            field: "terminalAt",
            message: "Persisted terminal request delivery has invalid timestamps",
          }),
        );
      }
      const outcome = yield* decodeJson(
        row.terminal_outcome_json ?? "null",
        terminalOutcomeCodec,
        "terminalOutcome",
      );
      const inputCleanupPending = yield* decodeJson(
        row.input_cleanup_json ?? "null",
        arrayCodec(inputTargetCodec),
        "inputCleanup",
      );
      const publication = yield* publicationFromRow(row);
      return Result.ok<TerminalRequestDelivery>({
        state: "terminal",
        requestDeliveryId: row.request_delivery_id,
        requestId: row.request_id,
        outcome,
        ...(publication ? { publication } : {}),
        createdAt: row.created_at,
        ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
        terminalAt: row.terminal_at,
        transportCommitRequired: row.transport_commit_required === 1,
        ...(row.transport_committed_at === null
          ? {}
          : { transportCommittedAt: row.transport_committed_at }),
        inputCleanupPending,
        ...(row.final_replay_deadline === null
          ? {}
          : { finalReplayDeadline: row.final_replay_deadline }),
      });
    });
  }

  #decodeOutput(
    row: RequestOutputRow,
  ): ResultType<RequestOutputLifecycle<TOutputMetadata>, RequestDeliveryCodecFailure> {
    const outputMetadataCodec = this.#codecs.outputMetadata;
    return Result.gen(function* () {
      const target = yield* decodeJson(row.target_json, inputTargetCodec, "outputTarget");
      if (target.blob.objectId !== row.object_id) {
        return yield* Result.err(
          new RequestDeliveryCodecFailure({
            field: "outputTarget",
            message: "Persisted output lifecycle object ID does not match its target",
          }),
        );
      }
      const metadata = yield* decodeJson(row.metadata_json, outputMetadataCodec, "outputMetadata");
      return Result.ok<RequestOutputLifecycle<TOutputMetadata>>({
        requestDeliveryId: row.request_delivery_id,
        requestId: row.request_id,
        target,
        metadata,
        createdAt: row.created_at,
        ...(row.delete_after === null ? {} : { deleteAfter: row.delete_after }),
      });
    });
  }
}
