import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import {
  blobRefV1Schema,
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { coreLineageManifestV2Schema } from "@stanley2058/lilac-event-bus";
import { afterEach, describe, expect, it } from "bun:test";
import { modelMessageSchema, type ModelMessage } from "ai";
import SuperJSON from "superjson";
import { z } from "zod";

import {
  applyLegacyTranscriptMigration,
  applyTranscriptBlobStorageSchema6Migration,
  commitLegacyTranscriptMigration,
  deleteStagedLegacyTranscriptUploads,
  preflightLegacyTranscriptDb,
  stageLegacyTranscriptMigration,
} from "../../scripts/legacy-transcript-blob-migration";
import {
  hashCanonicalStoredMessagesV2,
  storedMessageV1Schema,
} from "../../src/transcript/transcript-persistence-codec";
import {
  computeCorePrimaryClaudeTerminalHead,
  SqliteTranscriptStore,
} from "../../src/transcript/transcript-store";
import { createTranscriptSchemaMigrationFixture } from "../transcript/fixtures/transcript-schema-migration-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function schema5Fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-blob-migration-"));
  temporaryRoots.push(root);
  const dbPath = path.join(root, "agent-transcripts.db");
  createTranscriptSchemaMigrationFixture(dbPath, 5);
  return dbPath;
}

function legacySurfacePrefixDigest(atom: {
  readonly kind: "surface";
  readonly requestClient: string;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
}): string {
  const domain = "lilac:core-primary-lineage:v1";
  const initial = createHash("sha256").update(domain).digest("hex");
  const index = Buffer.alloc(8);
  index.writeBigUInt64BE(1n);
  return createHash("sha256")
    .update(domain)
    .update(index)
    .update(Buffer.from(initial, "hex"))
    .update(
      JSON.stringify({
        kind: atom.kind,
        messageId: atom.messageId,
        requestClient: atom.requestClient,
        sessionId: atom.sessionId,
        surfaceId: atom.surfaceId,
      }),
    )
    .digest("hex");
}

function legacyTerminalPrefixDigest(input: {
  readonly surfaceAtom: {
    readonly kind: "surface";
    readonly requestClient: string;
    readonly surfaceId: string;
    readonly sessionId: string;
    readonly messageId: string;
  };
  readonly requestId: string;
  readonly transcriptDigest: string;
}): string {
  const domain = "lilac:core-primary-lineage:v1";
  const previous = legacySurfacePrefixDigest(input.surfaceAtom);
  const index = Buffer.alloc(8);
  index.writeBigUInt64BE(2n);
  return createHash("sha256")
    .update(domain)
    .update(index)
    .update(Buffer.from(previous, "hex"))
    .update(
      JSON.stringify({
        containsCrossFamilyTurns: false,
        kind: "request",
        providerFamily: "claude-code",
        requestId: input.requestId,
        transcriptDigest: input.transcriptDigest,
      }),
    )
    .digest("hex");
}

describe("legacy transcript blob migration", () => {
  it("preflights the production-evolved schema-5 and all durable byte sources read-only", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    const transcriptMessages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: Buffer.from([1, 2, 3]).toString("base64"),
            mediaType: "application/octet-stream",
            filename: "request.bin",
          },
        ],
      },
    ] satisfies ModelMessage[];
    database.run(
      "UPDATE request_transcripts SET messages_json = ?, transcript_digest = ? WHERE request_id = ?",
      [
        SuperJSON.stringify(transcriptMessages),
        hashCanonicalMessagesV1(transcriptMessages).hash,
        "schema-v5",
      ],
    );
    const ownedBytes = new Uint8Array([4, 5, 6, 7]);
    const ownedSha = new Bun.CryptoHasher("sha256").update(ownedBytes).digest("hex");
    database.run(
      `INSERT INTO core_owned_blobs
         (sha256, media_type, filename, byte_length, bytes, created_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ownedSha, "application/octet-stream", "owned.bin", ownedBytes.byteLength, ownedBytes, 3],
    );
    const projectionMessages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: new Uint8Array([8, 9]),
            mediaType: "application/octet-stream",
            filename: "projection.bin",
          },
        ],
      },
    ];
    database.run(
      `INSERT INTO core_surface_projections
         (request_client, surface_id, session_id, message_id, projection_format_version,
          canonical_messages_json, source_facts_json, created_ts)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        "discord",
        "surface",
        "session-v5",
        "message",
        SuperJSON.stringify(projectionMessages),
        SuperJSON.stringify({ segmentDigest: "11".repeat(32) }),
        4,
      ],
    );
    database.run(
      `INSERT INTO core_surface_projection_blobs
         (request_client, surface_id, session_id, message_id, projection_format_version,
          position, blob_sha256)
       VALUES (?, ?, ?, ?, 1, 0, ?)`,
      ["discord", "surface", "session-v5", "message", ownedSha],
    );
    database.close();

    const before = await fs.readFile(dbPath);
    const preflight = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });

    expect(preflight.report).toMatchObject({
      schemaVersion: 5,
      totalBlobCount: 3,
      totalByteLength: 9,
      blockerCount: 0,
    });
    expect(preflight.plan.ownedBlobs).toHaveLength(1);
    expect(preflight.plan.requestTranscripts[0]).toMatchObject({ blobCount: 1, byteLength: 3 });
    expect(preflight.plan.surfaceProjections[0]).toMatchObject({ blobCount: 1, byteLength: 2 });
    expect(preflight.plan).not.toHaveProperty("bytes");
    expect(await fs.readFile(dbPath)).toEqual(before);
  });

  it("rejects a corrupt legacy owned BLOB before upload", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    database.run(
      `INSERT INTO core_owned_blobs
         (sha256, media_type, filename, byte_length, bytes, created_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["00".repeat(32), "application/octet-stream", "corrupt.bin", 3, new Uint8Array([1, 2]), 3],
    );
    database.close();

    preflightLegacyTranscriptDb(dbPath).match({
      ok: () => {
        throw new Error("Expected corrupt schema-5 state to fail preflight");
      },
      err: (error) => {
        expect(error.report.blockerCount).toBe(1);
        expect(error.report.blockers[0]).toMatchObject({
          kind: "owned-blob",
          field: "bytes",
        });
      },
    });
  });

  it("rejects any transcript schema other than exact version 5", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-blob-migration-"));
    temporaryRoots.push(root);
    const dbPath = path.join(root, "agent-transcripts.db");
    createTranscriptSchemaMigrationFixture(dbPath, 4);

    preflightLegacyTranscriptDb(dbPath).match({
      ok: () => {
        throw new Error("Expected schema 4 to fail preflight");
      },
      err: (error) => {
        expect(error.report.blockers[0]).toMatchObject({
          kind: "schema",
          recordId: "transcript_schema_migrations",
        });
      },
    });
  });

  it("keeps runtime startup blocked on schema 5 with the exact offline command", async () => {
    const dbPath = await schema5Fixture();

    expect(() => new SqliteTranscriptStore(dbPath)).toThrow(
      "Core transcript schema 5 requires offline blob migration. Run: bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data",
    );

    using database = new Database(dbPath, { readonly: true, strict: true });
    expect(
      database
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(5);
  });

  it("rejects a schema-5 marker with a missing required migration table", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    database.run("DROP TABLE core_named_claude_attempts");
    database.close();

    preflightLegacyTranscriptDb(dbPath).match({
      ok: () => {
        throw new Error("Expected an incomplete schema-5 layout to fail preflight");
      },
      err: (error) => {
        expect(error.report.blockers[0]).toMatchObject({
          kind: "schema",
          recordId: "core_named_claude_attempts",
          field: "columns",
        });
      },
    });
  });

  it("rejects an unexpected schema-5 database object before staging", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    database.run("CREATE TABLE unexpected_transcript_state (value TEXT)");
    database.close();

    preflightLegacyTranscriptDb(dbPath).match({
      ok: () => {
        throw new Error("Expected an unexpected schema object to fail preflight");
      },
      err: (error) => {
        expect(error.report.blockers[0]).toMatchObject({
          kind: "schema",
          recordId: "unexpected_transcript_state",
          field: "sqlite_schema",
        });
      },
    });
  });

  it("rejects drift in a named schema-5 index definition before staging", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    database.run("DROP INDEX idx_core_named_claude_attempts_owner");
    database.run(
      `CREATE INDEX idx_core_named_claude_attempts_owner
       ON core_named_claude_attempts(request_id, updated_ts)`,
    );
    database.close();

    preflightLegacyTranscriptDb(dbPath).match({
      ok: () => {
        throw new Error("Expected schema SQL drift to fail preflight");
      },
      err: (error) => {
        expect(error.report.blockers[0]).toMatchObject({
          kind: "schema",
          recordId: "idx_core_named_claude_attempts_owner",
          field: "sqlite_schema",
        });
      },
    });
  });

  it("accepts a named continuation published from a different transport client", async () => {
    const dbPath = await schema5Fixture();
    using database = new Database(dbPath, { strict: true });
    const transcript = database
      .query<{ transcript_digest: string }, []>(
        "SELECT transcript_digest FROM request_transcripts WHERE request_id = 'schema-v5'",
      )
      .get()!;
    database.run(
      `UPDATE request_transcripts
       SET request_client = 'github', provider_state_json = ?, stable_named_request_client = 'discord'
       WHERE request_id = 'schema-v5'`,
      [SuperJSON.stringify({ lastFamily: "claude-code", containsCrossFamilyTurns: false })],
    );
    database.run(
      `INSERT INTO core_named_claude_bindings VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "discord",
        "session-v5",
        "named-provider",
        1,
        "claude-code",
        "schema-v5",
        1,
        transcript.transcript_digest,
        2,
        1,
        "named-scope",
        "11111111-1111-4111-8111-111111111111",
        "/named",
        10.5,
        100,
        200,
        "named-model",
        "named-reasoning",
        1,
        50,
      ],
    );
    database.close();

    const preflight = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });

    expect(preflight.plan.namedClaudeBindings).toHaveLength(1);
  });

  it("preserves and rewrites all schema-5 Claude continuation rows as schema 6", async () => {
    const dbPath = await schema5Fixture();
    const database = new Database(dbPath, { strict: true });
    const requestId = "schema-v5";
    const sessionId = "session-v5";
    const providerState = { lastFamily: "claude-code", containsCrossFamilyTurns: false } as const;
    database.run(
      `UPDATE request_transcripts
       SET context_meta_json = NULL, provider_state_json = ?, stable_named_request_client = ?
       WHERE request_id = ?`,
      [SuperJSON.stringify(providerState), "discord", requestId],
    );
    const transcript = database
      .query<{ messages_json: string; transcript_digest: string }, [string]>(
        "SELECT messages_json, transcript_digest FROM request_transcripts WHERE request_id = ?",
      )
      .get(requestId)!;
    const responseMessages = z
      .array(modelMessageSchema)
      .parse(SuperJSON.parse(transcript.messages_json));
    const surfaceAtom = {
      kind: "surface",
      requestClient: "discord",
      surfaceId: "surface-v5",
      sessionId,
      messageId: "message-v5",
    } as const;
    const segmentPrefix = legacySurfacePrefixDigest(surfaceAtom);
    const legacyManifest = {
      state: "complete",
      lineageVersion: 1,
      currentCanonicalStart: 0,
      segments: [
        {
          atoms: [surfaceAtom],
          canonicalMessages: [{ role: "user", content: "prior canonical turn" }],
          canonicalStart: 0,
          canonicalEnd: 1,
          cumulativeAtomCount: 1,
          cumulativePrefixDigest: segmentPrefix,
        },
      ],
    } as const;
    database.run("INSERT INTO core_primary_lineage_manifests VALUES (?, 1, ?, ?)", [
      requestId,
      SuperJSON.stringify(legacyManifest),
      3,
    ]);
    const legacyTerminalHead = {
      lineageVersion: 1,
      atomCount: 2,
      prefixDigest: legacyTerminalPrefixDigest({
        surfaceAtom,
        requestId,
        transcriptDigest: transcript.transcript_digest,
      }),
      canonicalMessageCount: 1 + responseMessages.length,
    } as const;
    const claudeSessionId = "11111111-1111-4111-8111-111111111111";
    database.run(
      "INSERT INTO core_named_claude_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "discord",
        sessionId,
        "named-provider",
        1,
        "claude-code",
        requestId,
        1,
        transcript.transcript_digest,
        responseMessages.length,
        1,
        "named-scope",
        claudeSessionId,
        "/named",
        10.5,
        100,
        200,
        "named-model",
        "named-reasoning",
        7,
        50,
      ],
    );
    database.run(
      `INSERT INTO core_named_claude_attempts VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "core-named",
        "discord",
        sessionId,
        "named-provider",
        requestId,
        transcript.transcript_digest,
        responseMessages.length,
        1,
        "named-scope",
        requestId,
        3,
        claudeSessionId,
        claudeSessionId,
        7,
        "succeeded",
        requestId,
        transcript.transcript_digest,
        responseMessages.length,
        "/named-attempt",
        11.5,
        101,
        201,
        "named-attempt-model",
        "named-attempt-reasoning",
        40,
        60,
      ],
    );
    database.run(
      `INSERT INTO core_primary_claude_bindings VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "discord",
        sessionId,
        "primary-provider",
        1,
        "claude-code",
        legacyTerminalHead.lineageVersion,
        legacyTerminalHead.atomCount,
        legacyTerminalHead.prefixDigest,
        legacyTerminalHead.canonicalMessageCount,
        1,
        "primary-scope",
        claudeSessionId,
        "/primary",
        20.5,
        300,
        400,
        "primary-model",
        "primary-reasoning",
        9,
        70,
        null,
      ],
    );
    database.run(
      `INSERT INTO core_primary_claude_attempts VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "core-primary",
        "discord",
        sessionId,
        "primary-provider",
        legacyTerminalHead.lineageVersion,
        legacyTerminalHead.atomCount,
        legacyTerminalHead.prefixDigest,
        legacyTerminalHead.canonicalMessageCount,
        1,
        "primary-scope",
        requestId,
        4,
        claudeSessionId,
        claudeSessionId,
        9,
        "succeeded",
        requestId,
        legacyTerminalHead.lineageVersion,
        legacyTerminalHead.atomCount,
        legacyTerminalHead.prefixDigest,
        legacyTerminalHead.canonicalMessageCount,
        "/primary-attempt",
        21.5,
        301,
        401,
        "primary-attempt-model",
        "primary-attempt-reasoning",
        41,
        61,
      ],
    );
    database.close();

    const preflight = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(preflight.plan.namedClaudeBindings).toHaveLength(1);
    expect(preflight.plan.namedClaudeAttempts).toHaveLength(1);
    expect(preflight.plan.primaryClaudeBindings).toHaveLength(1);
    expect(preflight.plan.primaryClaudeAttempts).toHaveLength(1);
    const store = (await createMemoryBlobStore()).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    using changed = new Database(dbPath, { strict: true });
    changed.run("UPDATE core_named_claude_bindings SET last_reasoning = ? WHERE provider_id = ?", [
      "changed-after-preflight",
      "named-provider",
    ]);
    changed.close();
    (await stageLegacyTranscriptMigration({ dbPath, store, plan: preflight.plan })).match({
      ok: () => {
        throw new Error("Expected continuation changes after preflight to reject staging");
      },
      err: (error) => expect(error.stage).toBe("plan-validation"),
    });
    using restored = new Database(dbPath, { strict: true });
    restored.run("UPDATE core_named_claude_bindings SET last_reasoning = ? WHERE provider_id = ?", [
      "named-reasoning",
      "named-provider",
    ]);
    restored.close();
    const refreshedPlan = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value.plan,
      err: (error) => {
        throw error;
      },
    });
    const stage = (
      await stageLegacyTranscriptMigration({ dbPath, store, plan: refreshedPlan })
    ).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    commitLegacyTranscriptMigration({ dbPath, stage }).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });

    const migrated = new Database(dbPath, { readonly: true, strict: true });
    const migratedTranscript = migrated
      .query<{ messages_json: string; transcript_digest: string }, [string]>(
        "SELECT messages_json, transcript_digest FROM request_transcripts WHERE request_id = ?",
      )
      .get(requestId)!;
    const storedMessages = z
      .array(storedMessageV1Schema)
      .parse(JSON.parse(migratedTranscript.messages_json));
    const expectedNamedDigest = hashCanonicalStoredMessagesV2(storedMessages).match({
      ok: (value) => value.hash,
      err: (error) => {
        throw error;
      },
    });
    const migratedManifest = coreLineageManifestV2Schema.parse(
      JSON.parse(
        migrated
          .query<{ manifest_json: string }, [string]>(
            "SELECT manifest_json FROM core_primary_lineage_manifests WHERE request_id = ?",
          )
          .get(requestId)!.manifest_json,
      ),
    );
    const expectedPrimaryHead = computeCorePrimaryClaudeTerminalHead({
      manifest: migratedManifest,
      requestId,
      transcriptDigest: migratedTranscript.transcript_digest,
      responseMessageCount: storedMessages.length,
      providerState,
    }).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });

    expect(
      migrated
        .query<Record<string, string | number | null>, []>(
          "SELECT * FROM core_named_claude_bindings",
        )
        .get(),
    ).toEqual({
      request_client: "discord",
      session_id: sessionId,
      provider_id: "named-provider",
      binding_protocol_version: 1,
      provider_family: "claude-code",
      terminal_request_id: requestId,
      canonical_hash_version: 2,
      canonical_head_hash: expectedNamedDigest,
      canonical_message_count: storedMessages.length,
      execution_scope_hash_version: 1,
      execution_scope_hash: "named-scope",
      claude_session_id: claudeSessionId,
      native_cwd: "/named",
      native_last_modified: 10.5,
      native_context_tokens: 100,
      native_context_max_tokens: 200,
      last_model_specifier: "named-model",
      last_reasoning: "named-reasoning",
      revision: 7,
      updated_ts: 50,
    });
    expect(
      migrated
        .query<Record<string, string | number | null>, []>(
          "SELECT * FROM core_named_claude_attempts",
        )
        .get(),
    ).toEqual({
      product: "core-named",
      request_client: "discord",
      session_id: sessionId,
      provider_id: "named-provider",
      source_terminal_request_id: requestId,
      source_canonical_head_hash: expectedNamedDigest,
      source_canonical_message_count: storedMessages.length,
      execution_scope_hash_version: 1,
      execution_scope_hash: "named-scope",
      request_id: requestId,
      attempt_index: 3,
      candidate_session_id: claudeSessionId,
      source_session_id: claudeSessionId,
      expected_binding_revision: 7,
      state: "succeeded",
      terminal_request_id: requestId,
      terminal_canonical_head_hash: expectedNamedDigest,
      terminal_canonical_message_count: storedMessages.length,
      native_cwd: "/named-attempt",
      native_last_modified: 11.5,
      native_context_tokens: 101,
      native_context_max_tokens: 201,
      last_model_specifier: "named-attempt-model",
      last_reasoning: "named-attempt-reasoning",
      created_ts: 40,
      updated_ts: 60,
    });
    expect(
      migrated
        .query<Record<string, string | number | null>, []>(
          "SELECT * FROM core_primary_claude_bindings",
        )
        .get(),
    ).toEqual({
      request_client: "discord",
      session_id: sessionId,
      provider_id: "primary-provider",
      binding_protocol_version: 1,
      provider_family: "claude-code",
      lineage_version: 2,
      atom_count: expectedPrimaryHead.atomCount,
      prefix_digest: expectedPrimaryHead.prefixDigest,
      canonical_message_count: expectedPrimaryHead.canonicalMessageCount,
      execution_scope_hash_version: 1,
      execution_scope_hash: "primary-scope",
      claude_session_id: claudeSessionId,
      native_cwd: "/primary",
      native_last_modified: 20.5,
      native_context_tokens: 300,
      native_context_max_tokens: 400,
      last_model_specifier: "primary-model",
      last_reasoning: "primary-reasoning",
      revision: 9,
      updated_ts: 70,
      terminal_request_id: requestId,
    });
    expect(
      migrated
        .query<Record<string, string | number | null>, []>(
          "SELECT * FROM core_primary_claude_attempts",
        )
        .get(),
    ).toEqual({
      product: "core-primary",
      request_client: "discord",
      session_id: sessionId,
      provider_id: "primary-provider",
      source_lineage_version: 2,
      source_atom_count: expectedPrimaryHead.atomCount,
      source_prefix_digest: expectedPrimaryHead.prefixDigest,
      source_canonical_message_count: expectedPrimaryHead.canonicalMessageCount,
      execution_scope_hash_version: 1,
      execution_scope_hash: "primary-scope",
      request_id: requestId,
      attempt_index: 4,
      candidate_session_id: claudeSessionId,
      source_session_id: claudeSessionId,
      expected_binding_revision: 9,
      state: "succeeded",
      terminal_request_id: requestId,
      terminal_lineage_version: 2,
      terminal_atom_count: expectedPrimaryHead.atomCount,
      terminal_prefix_digest: expectedPrimaryHead.prefixDigest,
      terminal_canonical_message_count: expectedPrimaryHead.canonicalMessageCount,
      native_cwd: "/primary-attempt",
      native_last_modified: 21.5,
      native_context_tokens: 301,
      native_context_max_tokens: 401,
      last_model_specifier: "primary-attempt-model",
      last_reasoning: "primary-attempt-reasoning",
      created_ts: 41,
      updated_ts: 61,
    });
    migrated.close();

    const runtime = new SqliteTranscriptStore(dbPath);
    runtime
      .getCoreNamedClaudeSessionBinding({
        providerId: "named-provider",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })
      .match({
        ok: (binding) => expect(binding?.canonicalHeadHash).toBe(expectedNamedDigest),
        err: (error) => {
          throw error;
        },
      });
    runtime
      .getCorePrimaryClaudeSessionBinding({
        providerId: "primary-provider",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })
      .match({
        ok: (binding) => expect(binding?.prefixDigest).toBe(expectedPrimaryHead.prefixDigest),
        err: (error) => {
          throw error;
        },
      });
    expect(
      runtime.getCoreNamedClaudeSessionAttempt({
        providerId: "named-provider",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 3,
      })?.state,
    ).toBe("succeeded");
    expect(
      runtime.getCorePrimaryClaudeSessionAttempt({
        providerId: "primary-provider",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 4,
      })?.state,
    ).toBe("succeeded");
    runtime.close();
    await store.close({ deadlineAtMs: Date.now() + 5_000 });
  });

  it("uploads durable bytes and transactionally rewrites schema 5 as schema 6", async () => {
    const dbPath = await schema5Fixture();
    const database = new Database(dbPath, { strict: true });
    const transcriptMessages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: Buffer.from([10, 11, 12]).toString("base64"),
            mediaType: "application/octet-stream",
            filename: "request.bin",
          },
        ],
      },
    ] satisfies ModelMessage[];
    database.run(
      "UPDATE request_transcripts SET messages_json = ?, transcript_digest = ? WHERE request_id = ?",
      [
        SuperJSON.stringify(transcriptMessages),
        hashCanonicalMessagesV1(transcriptMessages).hash,
        "schema-v5",
      ],
    );
    const ownedBytes = new Uint8Array([20, 21, 22, 23]);
    const ownedSha = new Bun.CryptoHasher("sha256").update(ownedBytes).digest("hex");
    database.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
      ownedSha,
      "application/octet-stream",
      "owned.bin",
      ownedBytes.byteLength,
      ownedBytes,
      3,
    ]);
    const projectionMessages = [{ role: "user", content: "projection" }] satisfies ModelMessage[];
    database.run(`INSERT INTO core_surface_projections VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, [
      "discord",
      "surface",
      "session-v5",
      "message",
      SuperJSON.stringify(projectionMessages),
      SuperJSON.stringify({
        segmentMessageIds: ["message"],
        segmentDigest: hashCanonicalMessagesV1(projectionMessages).hash,
      }),
      4,
    ]);
    database.run("INSERT INTO core_surface_projection_blobs VALUES (?, ?, ?, ?, 1, 0, ?)", [
      "discord",
      "surface",
      "session-v5",
      "message",
      ownedSha,
    ]);
    const atom = {
      kind: "surface",
      requestClient: "discord",
      surfaceId: "surface",
      sessionId: "session-v5",
      messageId: "message",
    } as const;
    database.run("INSERT INTO core_primary_lineage_manifests VALUES (?, 1, ?, ?)", [
      "schema-v5",
      SuperJSON.stringify({
        state: "complete",
        lineageVersion: 1,
        currentCanonicalStart: 0,
        segments: [
          {
            atoms: [atom],
            canonicalMessages: projectionMessages,
            canonicalStart: 0,
            canonicalEnd: 1,
            cumulativeAtomCount: 1,
            cumulativePrefixDigest: legacySurfacePrefixDigest(atom),
          },
        ],
      }),
      4,
    ]);
    database.run("INSERT INTO core_lineage_projection_refs VALUES (?, 0, 0, ?, ?, ?, ?, 1)", [
      "schema-v5",
      "discord",
      "surface",
      "session-v5",
      "message",
    ]);
    database.close();

    const plan = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value.plan,
      err: (error) => {
        throw error;
      },
    });
    const store = (await createMemoryBlobStore()).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const applied = await applyLegacyTranscriptMigration({ dbPath, store, plan });
    applied.match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });

    using migrated = new Database(dbPath, { readonly: true, strict: true });
    expect(
      migrated
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(6);
    const transcript = migrated
      .query<{ messages_json: string; transcript_digest: string }, []>(
        "SELECT messages_json, transcript_digest FROM request_transcripts",
      )
      .get();
    expect(transcript).not.toBeNull();
    const messages = z.array(storedMessageV1Schema).parse(JSON.parse(transcript!.messages_json));
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "blob", mediaType: "application/octet-stream" }],
    });
    const firstMessage = messages[0];
    const inlinePart =
      firstMessage?.role === "user" && Array.isArray(firstMessage.content)
        ? firstMessage.content[0]
        : undefined;
    expect(inlinePart?.type).toBe("blob");
    if (!inlinePart || inlinePart.type !== "blob") {
      throw new Error("Expected a migrated inline blob part");
    }
    expect(
      migrated
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM core_owned_blobs WHERE owner_id = ?",
        )
        .get(inlinePart.blob.objectId)?.count,
    ).toBe(1);
    const openedInline = await store.open(inlinePart.blob);
    const inlineRead = openedInline.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    (await materializeBlobRead(inlineRead)).match({
      ok: (bytes) => expect(bytes).toEqual(new Uint8Array([10, 11, 12])),
      err: (error) => {
        throw error;
      },
    });
    const lineageJson = migrated
      .query<{ manifest_json: string; lineage_version: number }, []>(
        "SELECT manifest_json, lineage_version FROM core_primary_lineage_manifests",
      )
      .get();
    expect(lineageJson?.lineage_version).toBe(2);
    expect(coreLineageManifestV2Schema.parse(JSON.parse(lineageJson!.manifest_json))).toMatchObject(
      {
        lineageVersion: 2,
        segments: [{ atoms: [atom] }],
      },
    );
    const migratedSourceFacts = migrated
      .query<{ source_facts_json: string }, []>(
        "SELECT source_facts_json FROM core_surface_projections",
      )
      .get();
    expect(JSON.parse(migratedSourceFacts!.source_facts_json).segmentDigest).not.toBe(
      hashCanonicalMessagesV1(projectionMessages).hash,
    );
    const owned = migrated
      .query<{ owner_id: string; blob_ref_json: string }, []>(
        "SELECT owner_id, blob_ref_json FROM core_owned_blobs",
      )
      .get();
    expect(owned).not.toBeNull();
    const ownedRef = blobRefV1Schema.parse(JSON.parse(owned!.blob_ref_json));
    expect(owned!.owner_id).toBe(ownedRef.objectId);
    expect(
      migrated
        .query<{ blob_owner_id: string }, []>(
          "SELECT blob_owner_id FROM core_surface_projection_blobs",
        )
        .get()?.blob_owner_id,
    ).toBe(ownedRef.objectId);
    const opened = await store.open(ownedRef);
    const read = opened.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const materialized = await materializeBlobRead(read);
    materialized.match({
      ok: (bytes) => expect(bytes).toEqual(ownedBytes),
      err: (error) => {
        throw error;
      },
    });
    migrated.close();
    const runtimeStore = new SqliteTranscriptStore(dbPath);
    runtimeStore.getRequestTranscript({ requestId: "schema-v5" }).match({
      ok: (value) => expect(value?.messages[0]).toMatchObject({ role: "user" }),
      err: (error) => {
        throw error;
      },
    });
    runtimeStore.close();
    await store.close({ deadlineAtMs: Date.now() + 5_000 });
  });

  it("keeps schema 5 readable until an explicit staged migration commit", async () => {
    const dbPath = await schema5Fixture();
    const plan = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value.plan,
      err: (error) => {
        throw error;
      },
    });
    const store = (await createMemoryBlobStore()).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const stage = (await stageLegacyTranscriptMigration({ dbPath, store, plan })).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    using beforeCommit = new Database(dbPath, { readonly: true, strict: true });
    expect(
      beforeCommit
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(5);
    beforeCommit.close();

    commitLegacyTranscriptMigration({ dbPath, stage }).match({
      ok: () => undefined,
      err: (error) => {
        throw error;
      },
    });
    using afterCommit = new Database(dbPath, { readonly: true, strict: true });
    expect(
      afterCommit
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(6);
    await store.close({ deadlineAtMs: Date.now() + 5_000 });
  });

  it("rolls back a failed commit, restores PRAGMAs, and deletes staged uploads", async () => {
    const dbPath = await schema5Fixture();
    using source = new Database(dbPath, { strict: true });
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: Buffer.from([31, 32]).toString("base64"),
            mediaType: "application/octet-stream",
          },
        ],
      },
    ] satisfies ModelMessage[];
    source.run(
      "UPDATE request_transcripts SET messages_json = ?, transcript_digest = ? WHERE request_id = ?",
      [SuperJSON.stringify(messages), hashCanonicalMessagesV1(messages).hash, "schema-v5"],
    );
    source.close();
    const plan = preflightLegacyTranscriptDb(dbPath).match({
      ok: (value) => value.plan,
      err: (error) => {
        throw error;
      },
    });
    const backingStore = (await createMemoryBlobStore()).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const uploadedRefs: BlobRefV1[] = [];
    const trackingStore: BlobStore = {
      startUpload: async (uploadInput) =>
        (await backingStore.startUpload(uploadInput)).map((upload) => ({
          ...upload,
          completion: upload.completion.then((completed) =>
            completed.map((ref) => {
              uploadedRefs.push(ref);
              return ref;
            }),
          ),
        })),
      startStagedUpload: (input) => backingStore.startStagedUpload(input),
      adopt: (handle) => backingStore.adopt(handle),
      resolve: (handle, options) => backingStore.resolve(handle, options),
      open: (ref) => backingStore.open(ref),
      delete: (target) => backingStore.delete(target),
      maintain: (input) => backingStore.maintain(input),
      close: (input) => backingStore.close(input),
    };
    const stage = (
      await stageLegacyTranscriptMigration({ dbPath, store: trackingStore, plan })
    ).match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    expect(uploadedRefs).toHaveLength(1);
    using conflict = new Database(dbPath, { strict: true });
    conflict.run("CREATE TABLE legacy_core_owned_blobs (value TEXT)");
    conflict.close();

    commitLegacyTranscriptMigration({ dbPath, stage }).match({
      ok: () => {
        throw new Error("Expected the schema rewrite conflict to fail");
      },
      err: (error) => expect(error.stage).toBe("rewrite"),
    });
    using pragmaDatabase = new Database(dbPath, { strict: true });
    applyTranscriptBlobStorageSchema6Migration(pragmaDatabase, {
      ownedBlobs: [],
      requestTranscripts: [],
      surfaceProjections: [],
      lineageManifests: [],
      namedClaudeBindings: [],
      namedClaudeAttempts: [],
      primaryClaudeBindings: [],
      primaryClaudeAttempts: [],
    }).match({
      ok: () => {
        throw new Error("Expected the schema rewrite conflict to fail");
      },
      err: () => undefined,
    });
    expect(
      pragmaDatabase.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
    ).toBe(1);
    expect(
      pragmaDatabase.query<{ legacy_alter_table: number }, []>("PRAGMA legacy_alter_table").get()
        ?.legacy_alter_table,
    ).toBe(0);
    pragmaDatabase.close();
    using rolledBack = new Database(dbPath, { readonly: true, strict: true });
    expect(
      rolledBack
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(5);
    await deleteStagedLegacyTranscriptUploads({ stage, store: trackingStore }).then((deleted) =>
      deleted.match({
        ok: () => undefined,
        err: (error) => {
          throw error;
        },
      }),
    );
    const opened = await trackingStore.open(uploadedRefs[0]!);
    opened.match({
      ok: () => {
        throw new Error("Expected staged upload cleanup to remove the object");
      },
      err: (error) => expect(error._tag).toBe("BlobObjectAbsent"),
    });
    await trackingStore.close({ deadlineAtMs: Date.now() + 5_000 });
  });
});
