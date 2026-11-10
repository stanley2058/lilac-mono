import type { Database } from "bun:sqlite";
import type { DecodedPersistedValue, PersistedDataError } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  decodeTranscriptMessages as decodePersistedTranscriptMessages,
  type DecodedTranscriptForeignKeyFailureRow,
  type DecodedTranscriptMigrationVersionRow,
} from "./transcript-persistence-codec";
import {
  collectStoredBlobReferences,
  CoreOwnedBlobIntegrityError,
  decodeTranscriptRow,
  TRANSCRIPT_SCHEMA_VERSION,
  type CoreOwnedBlob,
  type CoreOwnedBlobReference,
  type CorePrimaryClaudeBindingRow,
} from "./transcript-store";

export type TranscriptMigrationHost = {
  readonly reportPersistenceError: (error: PersistedDataError) => void;
  readonly findCorePrimaryTerminalRequestId: (
    binding: CorePrimaryClaudeBindingRow,
  ) => string | null;
  readonly ensureTranscriptOwnedBlob: (
    reference: CoreOwnedBlobReference,
  ) => ResultType<CoreOwnedBlob, CoreOwnedBlobIntegrityError>;
  readonly replaceTranscriptBlobReferences: (
    requestId: string,
    references: readonly CoreOwnedBlobReference[],
  ) => void;
};

/** Creates or upgrades the transcript schema to the current version in one transaction. */
export function migrateTranscriptSchema(db: Database, host: TranscriptMigrationHost): void {
  db.run("PRAGMA foreign_keys = ON");
  const migrate = db.transaction(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS request_transcripts (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_client TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      model_label TEXT,
      final_text TEXT,
      messages_json TEXT NOT NULL,
      context_meta_json TEXT,
      provider_state_json TEXT,
      stable_named_request_client TEXT,
      transcript_digest TEXT,
      loaded_catalog_ids_json TEXT
    );
  `);

    db.run(`
      CREATE TABLE IF NOT EXISTS transcript_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_ts INTEGER NOT NULL
      )
    `);
    const versionRow = decodeTranscriptRow({
      storeKind: "migration-version",
      row: db
        .query<DecodedTranscriptMigrationVersionRow, []>(
          "SELECT COALESCE(MAX(version), 0) AS version FROM transcript_schema_migrations",
        )
        .get(),
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      recordId: "schema-version",
    });
    const finishVersion = versionRow.match<
      () => ResultType<DecodedPersistedValue<DecodedTranscriptMigrationVersionRow>, Panic>
    >({
      ok: (value) => () => Result.ok(value),
      err: (error) => () => {
        host.reportPersistenceError(error);
        return Result.err(
          new Panic({
            message: "Invalid transcript schema migration row",
            cause: error,
          }),
        );
      },
    });
    const version = adaptToolResultToHost(finishVersion()).value.version;
    if (version > TRANSCRIPT_SCHEMA_VERSION) {
      throw new Error(`Unsupported transcript schema version ${version}`);
    }
    if (version !== 0 && version < 6) {
      throw new Error(
        `Core transcript schema ${version} requires offline blob migration. Run: check out commit f2c90667 (see MIGRATIONS.md), then bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data`,
      );
    }

    const transcriptColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(request_transcripts)")
      .all();
    for (const column of [
      ["context_meta_json", "TEXT"],
      ["provider_state_json", "TEXT"],
      ["stable_named_request_client", "TEXT"],
      ["transcript_digest", "TEXT"],
      ["loaded_catalog_ids_json", "TEXT"],
    ] as const) {
      if (!transcriptColumns.some((entry) => entry.name === column[0])) {
        db.run(`ALTER TABLE request_transcripts ADD COLUMN ${column[0]} ${column[1]}`);
      }
    }

    db.run(`
    CREATE INDEX IF NOT EXISTS idx_request_transcripts_session
    ON request_transcripts(session_id, updated_ts);
  `);

    db.run(`
    CREATE INDEX IF NOT EXISTS idx_request_transcripts_client_session
    ON request_transcripts(request_client, session_id);
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS surface_message_to_request (
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      PRIMARY KEY (platform, channel_id, message_id)
    );
  `);

    db.run(`
    CREATE INDEX IF NOT EXISTS idx_surface_message_to_request_request
    ON surface_message_to_request(request_id);
  `);

    db.run(`
      CREATE TABLE IF NOT EXISTS core_named_claude_bindings (
        request_client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
        provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
        terminal_request_id TEXT NOT NULL REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
        canonical_hash_version INTEGER NOT NULL CHECK (canonical_hash_version = 2),
        canonical_head_hash TEXT NOT NULL,
        canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count >= 0),
        execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        native_cwd TEXT NOT NULL,
        native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
        native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
        native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
        last_model_specifier TEXT NOT NULL,
        last_reasoning TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (request_client, session_id, provider_id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS core_named_claude_attempts (
        product TEXT NOT NULL CHECK (product = 'core-named'),
        request_client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        source_terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE SET NULL,
        source_canonical_head_hash TEXT,
        source_canonical_message_count INTEGER CHECK (source_canonical_message_count >= 0),
        execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
        execution_scope_hash TEXT NOT NULL,
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
        candidate_session_id TEXT NOT NULL,
        source_session_id TEXT,
        expected_binding_revision INTEGER CHECK (expected_binding_revision > 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
        terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
        terminal_canonical_head_hash TEXT,
        terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count >= 0),
        native_cwd TEXT,
        native_last_modified REAL CHECK (native_last_modified >= 0),
        native_context_tokens INTEGER CHECK (native_context_tokens >= 0),
        native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0),
        last_model_specifier TEXT,
        last_reasoning TEXT,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index)
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_core_named_claude_attempts_owner
      ON core_named_claude_attempts(request_client, session_id, provider_id, updated_ts)
    `);

    if (version < 1) {
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        1,
        Date.now(),
      ]);
    }

    if (version < 2) {
      db.run(`
        CREATE TABLE core_owned_blobs (
          owner_id TEXT PRIMARY KEY CHECK (length(owner_id) > 0),
          blob_ref_json TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (length(media_type) > 0),
          filename TEXT NOT NULL CHECK (length(filename) > 0),
          byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
          created_ts INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE core_surface_projections (
          request_client TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          projection_format_version INTEGER NOT NULL
            CHECK (projection_format_version = 1),
          canonical_messages_json TEXT NOT NULL,
          source_facts_json TEXT NOT NULL,
          created_ts INTEGER NOT NULL,
          PRIMARY KEY (
            request_client, surface_id, session_id, message_id, projection_format_version
          )
        )
      `);
      db.run(`
        CREATE TABLE core_surface_projection_blobs (
          request_client TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          projection_format_version INTEGER NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          blob_owner_id TEXT NOT NULL REFERENCES core_owned_blobs(owner_id) ON DELETE RESTRICT,
          PRIMARY KEY (
            request_client, surface_id, session_id, message_id,
            projection_format_version, position
          ),
          FOREIGN KEY (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) REFERENCES core_surface_projections (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE core_primary_lineage_manifests (
          request_id TEXT PRIMARY KEY
            REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          lineage_version INTEGER NOT NULL CHECK (lineage_version = 2),
          manifest_json TEXT NOT NULL,
          created_ts INTEGER NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE core_lineage_projection_refs (
          request_id TEXT NOT NULL
            REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
          atom_index INTEGER NOT NULL CHECK (atom_index >= 0),
          request_client TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          projection_format_version INTEGER NOT NULL,
          PRIMARY KEY (request_id, segment_index, atom_index),
          FOREIGN KEY (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) REFERENCES core_surface_projections (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) ON DELETE RESTRICT
        )
      `);
      db.run(`
        CREATE TABLE core_lineage_request_refs (
          request_id TEXT NOT NULL
            REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
          atom_index INTEGER NOT NULL CHECK (atom_index >= 0),
          reference_kind TEXT NOT NULL CHECK (reference_kind IN ('request', 'checkpoint')),
          referenced_request_id TEXT NOT NULL
            REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
          transcript_digest TEXT NOT NULL,
          PRIMARY KEY (request_id, segment_index, atom_index)
        )
      `);
      db.run(`
        CREATE INDEX idx_core_lineage_request_refs_referenced
        ON core_lineage_request_refs(referenced_request_id)
      `);

      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        2,
        Date.now(),
      ]);
    }
    if (version < 3) {
      db.run(`
        CREATE TABLE core_lineage_request_alias_refs (
          request_id TEXT NOT NULL
            REFERENCES core_primary_lineage_manifests(request_id) ON DELETE CASCADE,
          segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
          alias_index INTEGER NOT NULL CHECK (alias_index >= 0),
          referenced_request_id TEXT NOT NULL
            REFERENCES request_transcripts(request_id) ON DELETE RESTRICT,
          request_client TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          projection_format_version INTEGER NOT NULL,
          PRIMARY KEY (request_id, segment_index, alias_index),
          FOREIGN KEY (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) REFERENCES core_surface_projections (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) ON DELETE RESTRICT
        )
      `);
      db.run(`
        CREATE INDEX idx_core_lineage_request_alias_refs_projection
        ON core_lineage_request_alias_refs(
          request_client, surface_id, session_id, message_id, projection_format_version
        )
      `);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        3,
        Date.now(),
      ]);
    }
    if (version < 4) {
      db.run(`
        CREATE TABLE core_primary_claude_bindings (
          request_client TEXT NOT NULL CHECK (request_client = 'discord'),
          session_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          binding_protocol_version INTEGER NOT NULL CHECK (binding_protocol_version = 1),
          provider_family TEXT NOT NULL CHECK (provider_family = 'claude-code'),
          lineage_version INTEGER NOT NULL CHECK (lineage_version = 2),
          atom_count INTEGER NOT NULL CHECK (atom_count > 0),
          prefix_digest TEXT NOT NULL,
          canonical_message_count INTEGER NOT NULL CHECK (canonical_message_count > 0),
          execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
          execution_scope_hash TEXT NOT NULL,
          claude_session_id TEXT NOT NULL,
          native_cwd TEXT NOT NULL,
          native_last_modified REAL NOT NULL CHECK (native_last_modified >= 0),
          native_context_tokens INTEGER NOT NULL CHECK (native_context_tokens >= 0),
          native_context_max_tokens INTEGER NOT NULL CHECK (native_context_max_tokens > 0),
          last_model_specifier TEXT NOT NULL,
          last_reasoning TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          updated_ts INTEGER NOT NULL,
          PRIMARY KEY (request_client, session_id, provider_id)
        )
      `);
      db.run(`
        CREATE TABLE core_primary_claude_attempts (
          product TEXT NOT NULL CHECK (product = 'core-primary'),
          request_client TEXT NOT NULL CHECK (request_client = 'discord'),
          session_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          source_lineage_version INTEGER CHECK (source_lineage_version = 2),
          source_atom_count INTEGER CHECK (source_atom_count > 0),
          source_prefix_digest TEXT,
          source_canonical_message_count INTEGER CHECK (source_canonical_message_count > 0),
          execution_scope_hash_version INTEGER NOT NULL CHECK (execution_scope_hash_version = 1),
          execution_scope_hash TEXT NOT NULL,
          request_id TEXT NOT NULL,
          attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
          candidate_session_id TEXT NOT NULL,
          source_session_id TEXT,
          expected_binding_revision INTEGER CHECK (expected_binding_revision > 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'uncertain')),
          terminal_request_id TEXT REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          terminal_lineage_version INTEGER CHECK (terminal_lineage_version = 2),
          terminal_atom_count INTEGER CHECK (terminal_atom_count > 0),
          terminal_prefix_digest TEXT,
          terminal_canonical_message_count INTEGER CHECK (terminal_canonical_message_count > 0),
          native_cwd TEXT,
          native_last_modified REAL CHECK (native_last_modified >= 0),
          native_context_tokens INTEGER CHECK (native_context_tokens >= 0),
          native_context_max_tokens INTEGER CHECK (native_context_max_tokens > 0),
          last_model_specifier TEXT,
          last_reasoning TEXT,
          created_ts INTEGER NOT NULL,
          updated_ts INTEGER NOT NULL,
          PRIMARY KEY (request_client, session_id, provider_id, request_id, attempt_index)
        )
      `);
      db.run(`
        CREATE INDEX idx_core_primary_claude_attempts_owner
        ON core_primary_claude_attempts(request_client, session_id, provider_id, updated_ts)
      `);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        4,
        Date.now(),
      ]);
    }
    if (version < 5) {
      db.run(
        `ALTER TABLE core_primary_claude_bindings
         ADD COLUMN terminal_request_id TEXT
           REFERENCES request_transcripts(request_id) ON DELETE CASCADE`,
      );
      const bindings = db
        .query<CorePrimaryClaudeBindingRow, []>(
          "SELECT * FROM core_primary_claude_bindings ORDER BY rowid",
        )
        .all();
      for (const binding of bindings) {
        const terminalRequestId = host.findCorePrimaryTerminalRequestId(binding);
        if (terminalRequestId === null) continue;
        db.run(
          `UPDATE core_primary_claude_bindings SET terminal_request_id = ?
           WHERE request_client = ? AND session_id = ? AND provider_id = ?
             AND revision = ? AND terminal_request_id IS NULL`,
          [
            terminalRequestId,
            binding.request_client,
            binding.session_id,
            binding.provider_id,
            binding.revision,
          ],
        );
      }
      db.run("DELETE FROM core_primary_claude_bindings WHERE terminal_request_id IS NULL");
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        5,
        Date.now(),
      ]);
    }
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_core_lineage_projection_refs_projection
      ON core_lineage_projection_refs(
        request_client, surface_id, session_id, message_id, projection_format_version
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_core_surface_projection_blobs_blob
      ON core_surface_projection_blobs(blob_owner_id)
    `);
    if (version < 6) {
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        6,
        Date.now(),
      ]);
    }
    if (version < 7) {
      db.run(`
        CREATE TABLE core_resources (
          resource_id TEXT PRIMARY KEY
            CHECK (
              length(resource_id) = 35
              AND substr(resource_id, 1, 3) = 'r1_'
              AND substr(resource_id, 4) NOT GLOB '*[^0-9a-f]*'
            ),
          record_version INTEGER NOT NULL CHECK (record_version = 1),
          origin_key TEXT NOT NULL UNIQUE CHECK (length(origin_key) > 0),
          origin_json TEXT NOT NULL,
          filename TEXT,
          declared_media_type TEXT,
          detected_media_type TEXT,
          reported_byte_length INTEGER CHECK (reported_byte_length >= 0),
          created_ts INTEGER NOT NULL,
          cache_blob_ref_json TEXT,
          cache_cached_ts INTEGER,
          CHECK (
            (cache_blob_ref_json IS NULL AND cache_cached_ts IS NULL)
            OR (cache_blob_ref_json IS NOT NULL AND cache_cached_ts IS NOT NULL)
          )
        )
      `);
      db.run(`
        CREATE TABLE core_transcript_resource_refs (
          request_id TEXT NOT NULL
            REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL
            REFERENCES core_resources(resource_id) ON DELETE RESTRICT,
          PRIMARY KEY (request_id, resource_id)
        )
      `);
      db.run(`
        CREATE INDEX idx_core_transcript_resource_refs_resource
        ON core_transcript_resource_refs(resource_id)
      `);
      db.run(`
        CREATE TABLE core_surface_projection_resource_refs (
          request_client TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          projection_format_version INTEGER NOT NULL,
          resource_id TEXT NOT NULL
            REFERENCES core_resources(resource_id) ON DELETE RESTRICT,
          PRIMARY KEY (
            request_client, surface_id, session_id, message_id,
            projection_format_version, resource_id
          ),
          FOREIGN KEY (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) REFERENCES core_surface_projections (
            request_client, surface_id, session_id, message_id, projection_format_version
          ) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX idx_core_surface_projection_resource_refs_resource
        ON core_surface_projection_resource_refs(resource_id)
      `);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        7,
        Date.now(),
      ]);
    }
    if (version < 8) {
      db.run(`
        ALTER TABLE core_owned_blobs
        ADD COLUMN deletion_claim_ts INTEGER CHECK (deletion_claim_ts >= 0)
      `);
      db.run(`
        CREATE TABLE core_transcript_blob_refs (
          request_id TEXT NOT NULL
            REFERENCES request_transcripts(request_id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          blob_owner_id TEXT NOT NULL
            REFERENCES core_owned_blobs(owner_id) ON DELETE RESTRICT,
          PRIMARY KEY (request_id, position),
          UNIQUE (request_id, blob_owner_id)
        )
      `);
      db.run(`
        CREATE INDEX idx_core_transcript_blob_refs_blob
        ON core_transcript_blob_refs(blob_owner_id)
      `);
      const transcripts = db
        .query<{ request_id: string; messages_json: string }, []>(
          "SELECT request_id, messages_json FROM request_transcripts ORDER BY rowid",
        )
        .all();
      for (const transcript of transcripts) {
        const messages = adaptToolResultToHost(
          decodePersistedTranscriptMessages({
            raw: transcript.messages_json,
            schemaVersion: 7,
            recordId: transcript.request_id,
          }),
        ).value;
        const references = adaptToolResultToHost(collectStoredBlobReferences(messages));
        for (const reference of references) {
          adaptToolResultToHost(host.ensureTranscriptOwnedBlob(reference));
        }
        host.replaceTranscriptBlobReferences(transcript.request_id, references);
      }
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        8,
        Date.now(),
      ]);
    }
    if (version < 9) {
      db.run(`
        CREATE TABLE core_agent_run_checkpoint_blobs (
          request_delivery_id TEXT NOT NULL CHECK (length(request_delivery_id) > 0),
          blob_owner_id TEXT NOT NULL
            REFERENCES core_owned_blobs(owner_id) ON DELETE RESTRICT,
          PRIMARY KEY (request_delivery_id, blob_owner_id)
        )
      `);
      db.run(`
        CREATE INDEX idx_core_agent_run_checkpoint_blobs_blob
        ON core_agent_run_checkpoint_blobs(blob_owner_id)
      `);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        9,
        Date.now(),
      ]);
    }
    if (version < 10) {
      db.run("DROP TABLE IF EXISTS session_loaded_tools");
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        10,
        Date.now(),
      ]);
    }
    if (version < 11) {
      db.run("ALTER TABLE surface_message_to_request ADD COLUMN deleted_ts INTEGER");
      db.run(`
        CREATE TRIGGER delete_transcript_surface_aliases
        AFTER DELETE ON request_transcripts
        BEGIN
          DELETE FROM surface_message_to_request WHERE request_id = OLD.request_id;
        END
      `);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        11,
        Date.now(),
      ]);
    }
    if (version < 12) {
      db.run(`CREATE TABLE core_native_resource_refs (
        upload_id TEXT PRIMARY KEY CHECK (length(upload_id) > 0),
        thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
        resource_id TEXT NOT NULL REFERENCES core_resources(resource_id) ON DELETE RESTRICT
      )`);
      db.run(
        "CREATE INDEX idx_core_native_resource_refs_resource ON core_native_resource_refs(resource_id)",
      );
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        12,
        Date.now(),
      ]);
    }
    if (version < 13) {
      db.run(`CREATE TABLE core_native_transcript_refs (
        session_id TEXT NOT NULL CHECK (length(session_id) > 0),
        request_id TEXT PRIMARY KEY REFERENCES request_transcripts(request_id) ON DELETE CASCADE
      )`);
      db.run(
        "CREATE INDEX idx_core_native_transcript_refs_session ON core_native_transcript_refs(session_id)",
      );
      db.run(`INSERT INTO core_native_transcript_refs (session_id, request_id)
        SELECT session_id, request_id FROM request_transcripts WHERE request_client = 'native'`);
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        13,
        Date.now(),
      ]);
    }
    if (version < 14) {
      db.run("ALTER TABLE core_resources ADD COLUMN image_preview_json TEXT");
      db.run("INSERT INTO transcript_schema_migrations (version, applied_ts) VALUES (?, ?)", [
        14,
        Date.now(),
      ]);
    }
    // Retention pruning filters by age; without these indexes it scans every transcript row.
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_transcripts_updated
      ON request_transcripts(updated_ts)
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_transcripts_checkpoint_candidates
      ON request_transcripts(updated_ts) WHERE context_meta_json IS NOT NULL
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_surface_message_to_request_deleted
      ON surface_message_to_request(deleted_ts) WHERE deleted_ts IS NOT NULL
    `);
    const foreignKeyFailures = db
      .query<DecodedTranscriptForeignKeyFailureRow, []>("PRAGMA foreign_key_check")
      .all()
      .map((row, index) => {
        const decoded = decodeTranscriptRow({
          storeKind: "foreign-key-failure",
          row,
          schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
          recordId: `foreign-key:${index}`,
        });
        const finishForeignKeyFailure = decoded.match<
          () => ResultType<DecodedTranscriptForeignKeyFailureRow, Panic>
        >({
          ok: (value) => () => Result.ok(value.value),
          err: (error) => () => {
            host.reportPersistenceError(error);
            return Result.err(
              new Panic({
                message: "Invalid transcript foreign-key check row",
                cause: error,
              }),
            );
          },
        });
        return adaptToolResultToHost(finishForeignKeyFailure());
      });
    if (foreignKeyFailures.length > 0) {
      if (foreignKeyFailures.some((failure) => failure.parent === "core_owned_blobs")) {
        throw new CoreOwnedBlobIntegrityError(
          "Transcript schema validation found a missing Core-owned blob",
        );
      }
      throw new Error("Transcript schema migration failed foreign-key validation");
    }
  });
  migrate.immediate();
}
