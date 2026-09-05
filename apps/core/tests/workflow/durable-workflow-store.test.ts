import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import {
  type WorkflowOperation,
  type WorkflowRevision,
  type WorkflowRun,
} from "../../src/workflow/workflow-domain";
import {
  applyWorkflowBlobStorageSchema26Migration,
  applyWorkflowSchemaMigrations,
  WorkflowBlobStorageMigrationRequired,
  WorkflowMigrationInvalidTimestamp,
  WORKFLOW_BLOB_MIGRATION_COMMAND,
  WORKFLOW_MIGRATION_VERSIONS,
  WORKFLOW_SCHEMA_VERSION,
} from "../../src/workflow/workflow-migrations";
import { workflowResolvedModelRequestSchema } from "../../src/workflow/workflow-request-authority";
import { workflowSourceArtifactReferenceForTest } from "./workflow-test-blob-store";
function dbPath(label: string): string {
  return join(tmpdir(), `lilac-workflow-${label}-${crypto.randomUUID()}.sqlite`);
}

function revision(id = "revision-1"): WorkflowRevision {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 2, maxTotal: 8 },
    maxNestingDepth: 4,
    operationIdleTimeoutMs: 10000,
    waits: ["reply", "sleep"],
  });
  const limits = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  return {
    revisionId: id,
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifact: workflowSourceArtifactReferenceForTest(`artifact-${id}`),
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "audit", description: "Audit the project" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: 10,
  };
}
function run(id = "run-1", revisionId = "revision-1"): WorkflowRun {
  return {
    runId: id,
    revisionId,
    state: "queued",
    inputSchemaSnapshot: { type: "object", additionalProperties: false },
    args: {},
    argsSha256: canonicalJsonSha256({}),
    origin: {
      requestId: "request-1",
      sessionId: "session-1",
      client: "discord",
      userId: "user-1",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "detached" },
    progressTarget: null,
    terminalDetail: null,
    result: null,
    resultArtifact: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 10,
    startedAt: null,
    updatedAt: 10,
    terminalAt: null,
  };
}
function liveParentRun(id: string, parentRequestId: string): WorkflowRun {
  return {
    ...run(id),
    completionTarget: {
      kind: "live_parent",
      parentRequestId,
      parentSessionId: "session-1",
      parentRequestClient: "discord",
      parentToolCallId: `tool-${id}`,
      childRequestId: `child-${id}`,
      childSessionId: `child-session-${id}`,
      profile: "general",
      sessionName: `session-${id}`,
      depth: 1,
      reasoning: null,
      fallbackToSurface: true,
      fallbackProgressTarget: {
        platform: "discord",
        channelId: "session-1",
        replyToMessageId: null,
      },
      deferredDelivery: true,
    },
  };
}
function operation(runId: string, operationId: string): WorkflowOperation {
  const input = { prompt: "inspect", options: { profile: "general", cwd: "/workspace" } };
  return {
    runId,
    operationId,
    callSiteId: `call-${operationId}`,
    parentOperationId: null,
    phase: null,
    label: null,
    kind: "agent",
    input,
    inputSha256: canonicalJsonSha256(input),
    state: "queued",
    attempt: 0,
    requestId: null,
    output: null,
    resultArtifact: null,
    error: null,
    usage: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 11,
    startedAt: null,
    updatedAt: 11,
    terminalAt: null,
  };
}
function downgradeSchemaToV24(db: Database): void {
  db.run("ALTER TABLE workflow_surface_bindings DROP COLUMN permanent_failure_json");
  db.run("DELETE FROM workflow_schema_migrations WHERE version = 25");
}
describe("durable workflow store minimal dispatch schema", () => {
  it("keeps the reported schema version aligned with the latest migration", () => {
    const latestMigrationVersion = Math.max(...WORKFLOW_MIGRATION_VERSIONS);
    expect(WORKFLOW_SCHEMA_VERSION).toBe(latestMigrationVersion);
  });
  it("upgrades populated schema 26 online without rewriting workflow data", () => {
    const file = dbPath("v26-publication-upgrade");
    const original = new DurableWorkflowStore(file);
    const saved = workflowStoreValue(
      original.createInvocation({ revision: revision(), run: run() }),
    );
    expect(saved.status).toBe("accepted");
    const originalRun = workflowStoreValue(original.getRun("run-1"));
    const originalRevision = workflowStoreValue(original.getRevision("revision-1"));
    const originalArtifact = workflowStoreValue(
      original.getWorkflowArtifact(revision().snapshotArtifact.artifactId),
    );
    original.close();
    const previous = new Database(file);
    previous.run("DROP TABLE workflow_artifact_publications");
    previous.run("DELETE FROM workflow_schema_migrations WHERE version = 27");
    previous.close();
    const upgraded = new DurableWorkflowStore(file);
    try {
      expect(workflowStoreValue(upgraded.getRun("run-1"))).toEqual(originalRun);
      expect(workflowStoreValue(upgraded.getRevision("revision-1"))).toEqual(originalRevision);
      expect(
        workflowStoreValue(upgraded.getWorkflowArtifact(revision().snapshotArtifact.artifactId)),
      ).toEqual(originalArtifact);
      expect(workflowStoreValue(upgraded.listWorkflowArtifactPublications())).toEqual([]);
      expect(upgraded.listMigrations().at(-1)?.version).toBe(27);
    } finally {
      upgraded.close();
      rmSync(file, { force: true });
    }
  });

  it("keeps duplicate publication ownership until losing bytes are cleaned", () => {
    const file = dbPath("publication-winner");
    const first = new DurableWorkflowStore(file);
    const firstReference = workflowSourceArtifactReferenceForTest("shared source");
    const secondReference = {
      ...firstReference,
      blobRef: { ...firstReference.blobRef, objectId: `b1_${"b".repeat(32)}` },
    };
    expect(first.beginWorkflowArtifactPublication(firstReference, 10).status).toBe("ok");
    expect(first.beginWorkflowArtifactPublication(firstReference, 30).status).toBe("ok");
    first.close();
    const resumed = new DurableWorkflowStore(file);
    const concurrent = new DurableWorkflowStore(file);
    try {
      expect(concurrent.beginWorkflowArtifactPublication(secondReference, 20).status).toBe("ok");
      expect(workflowStoreValue(resumed.listWorkflowArtifactPublications(1))).toEqual([
        firstReference,
      ]);
      expect(
        workflowStoreValue(concurrent.completeWorkflowArtifactPublication(secondReference, 20)),
      ).toEqual(secondReference);
      expect(
        workflowStoreValue(resumed.completeWorkflowArtifactPublication(firstReference, 10)),
      ).toEqual(secondReference);
      expect(workflowStoreValue(resumed.listWorkflowArtifactPublications())).toEqual([
        firstReference,
      ]);
      expect(workflowStoreValue(resumed.getWorkflowArtifact(firstReference.artifactId))).toEqual(
        secondReference,
      );
      expect(resumed.removeWorkflowArtifactPublication(firstReference).status).toBe("ok");
      expect(resumed.removeWorkflowArtifactPublication(firstReference).status).toBe("ok");
      expect(workflowStoreValue(concurrent.listWorkflowArtifactPublications())).toEqual([]);
      expect(
        workflowStoreValue(concurrent.completeWorkflowArtifactPublication(secondReference, 30)),
      ).toEqual(secondReference);
    } finally {
      concurrent.close();
      resumed.close();
      rmSync(file, { force: true });
    }
  });

  it("rejects absent and mismatched publication identities without discarding ownership", () => {
    const store = new DurableWorkflowStore(":memory:");
    const reference = workflowSourceArtifactReferenceForTest("identity source");
    const mismatch = { ...reference, blobRef: { ...reference.blobRef, sha256: "c".repeat(64) } };
    try {
      expect(store.completeWorkflowArtifactPublication(reference, 10).status).toBe("error");
      expect(workflowStoreValue(store.getWorkflowArtifact(reference.artifactId))).toBeNull();
      expect(store.beginWorkflowArtifactPublication(reference, 10).status).toBe("ok");
      expect(store.beginWorkflowArtifactPublication(mismatch, 20).status).toBe("error");
      expect(store.completeWorkflowArtifactPublication(mismatch, 20).status).toBe("error");
      expect(store.removeWorkflowArtifactPublication(mismatch).status).toBe("error");
      expect(workflowStoreValue(store.listWorkflowArtifactPublications())).toEqual([reference]);
      expect(workflowStoreValue(store.completeWorkflowArtifactPublication(reference, 10))).toEqual(
        reference,
      );
      expect(workflowStoreValue(store.listWorkflowArtifactPublications())).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back canonical registration when intent removal fails", () => {
    const file = dbPath("publication-atomicity");
    const store = new DurableWorkflowStore(file);
    const raw = new Database(file);
    const reference = workflowSourceArtifactReferenceForTest("rollback source");
    try {
      expect(store.beginWorkflowArtifactPublication(reference, 10).status).toBe("ok");
      raw.run(`CREATE TRIGGER reject_publication_removal BEFORE DELETE ON workflow_artifact_publications
               BEGIN SELECT RAISE(ABORT, 'injected intent deletion failure'); END`);
      const failed = store.completeWorkflowArtifactPublication(reference, 10);
      expect(failed.status).toBe("error");
      if (failed.status === "error")
        expect(failed.error._tag).toBe("DurableWorkflowSqliteDriverFailure");
      expect(workflowStoreValue(store.getWorkflowArtifact(reference.artifactId))).toBeNull();
      expect(workflowStoreValue(store.listWorkflowArtifactPublications())).toEqual([reference]);
      raw.run("DROP TRIGGER reject_publication_removal");
      expect(workflowStoreValue(store.completeWorkflowArtifactPublication(reference, 10))).toEqual(
        reference,
      );
      expect(workflowStoreValue(store.listWorkflowArtifactPublications())).toEqual([]);
    } finally {
      raw.close();
      store.close();
      rmSync(file, { force: true });
    }
  });

  it("decodes publication references before recovery or mutation", () => {
    const file = dbPath("publication-corruption");
    const store = new DurableWorkflowStore(file);
    const raw = new Database(file);
    const reference = workflowSourceArtifactReferenceForTest("corrupt source");
    try {
      expect(store.beginWorkflowArtifactPublication(reference, 10).status).toBe("ok");
      raw.run("UPDATE workflow_artifact_publications SET blob_ref_json = ?", [
        JSON.stringify({ ...reference.blobRef, byteLength: -1 }),
      ]);
      const listed = store.listWorkflowArtifactPublications();
      expect(listed.status).toBe("error");
      if (listed.status === "error") expect(listed.error._tag).toBe("CorruptPersistedFields");
      expect(store.completeWorkflowArtifactPublication(reference, 10).status).toBe("error");
      expect(store.removeWorkflowArtifactPublication(reference).status).toBe("error");
      expect(workflowStoreValue(store.getWorkflowArtifact(reference.artifactId))).toBeNull();
      expect(
        raw.query("SELECT COUNT(*) AS count FROM workflow_artifact_publications").get(),
      ).toEqual({ count: 1 });
    } finally {
      raw.close();
      store.close();
      rmSync(file, { force: true });
    }
  });

  it("does not touch SQLite when the migration clock throws", () => {
    const db = new Database(":memory:");
    const defect = new Error("migration clock defect");
    let caught: unknown;
    try {
      applyWorkflowSchemaMigrations(db, () => {
        throw defect;
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(defect);
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  it("preserves migration clock Panic identity without touching SQLite", () => {
    const db = new Database(":memory:");
    const panic = new Panic({ message: "migration clock panic" });
    let caught: unknown;
    try {
      applyWorkflowSchemaMigrations(db, () => {
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBe(panic);
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  it("returns an owned invalid-clock Result before touching SQLite", () => {
    const db = new Database(":memory:");
    const migrated = applyWorkflowSchemaMigrations(db, () => Number.NaN);
    expect(migrated.status).toBe("error");
    if (migrated.status === "error") {
      expect(migrated.error).toBeInstanceOf(WorkflowMigrationInvalidTimestamp);
    }
    expect(
      db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([]);
    db.close();
  });
  it("requires the offline command for schema 25 and atomically installs artifact references", () => {
    const db = new Database(":memory:");
    try {
      const legacy = applyWorkflowSchemaMigrations(db, () => 25, 25);
      expect(legacy.status).toBe("ok");
      const reference = workflowSourceArtifactReferenceForTest("legacy workflow source");
      db.run(
        `INSERT INTO workflow_revisions (
           revision_id, canonical_project_id, canonical_workspace_root, scope,
           normalized_path, name, snapshot_artifact_id, source_sha256,
           input_schema_sha256, capability_sha256, metadata_json, input_schema_json,
           capabilities_json, limits_json, runtime_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-revision",
          "legacy-project",
          "/legacy",
          "project",
          "legacy.ts",
          "legacy",
          reference.artifactId,
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          '{"name":"legacy","description":"Legacy workflow"}',
          "{}",
          '{"agents":{"maxConcurrent":1,"maxTotal":1},"maxNestingDepth":1,"operationIdleTimeoutMs":1000,"waits":[]}',
          '{"maxSourceBytes":100,"maxInputBytes":100,"maxOperationOutputBytes":100,"maxResultBytes":100}',
          WORKFLOW_RUNTIME_VERSION,
          10,
        ],
      );

      const runtimeOpen = applyWorkflowSchemaMigrations(db, () => 26);
      expect(runtimeOpen.status).toBe("error");
      if (runtimeOpen.status === "error") {
        expect(runtimeOpen.error).toBeInstanceOf(WorkflowBlobStorageMigrationRequired);
        expect(runtimeOpen.error.message).toContain(WORKFLOW_BLOB_MIGRATION_COMMAND);
      }
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_artifacts'",
          )
          .get()?.count,
      ).toBe(0);

      const migrated = applyWorkflowBlobStorageSchema26Migration(
        db,
        [{ reference, createdAt: 10 }],
        () => 26,
      );
      expect(migrated.status).toBe("ok");
      expect(
        db
          .query<{ version: number }, []>(
            "SELECT version FROM workflow_schema_migrations ORDER BY version DESC LIMIT 1",
          )
          .get()?.version,
      ).toBe(26);
      const migratedRevision = db
        .query<{ snapshot_artifact_id: string }, []>(
          "SELECT snapshot_artifact_id FROM workflow_revisions WHERE revision_id = 'legacy-revision'",
        )
        .get();
      expect(JSON.parse(migratedRevision?.snapshot_artifact_id ?? "null")).toEqual(reference);
      const artifact = db
        .query<{ blob_ref_json: string }, [string]>(
          "SELECT blob_ref_json FROM workflow_artifacts WHERE artifact_id = ?",
        )
        .get(reference.artifactId);
      expect(JSON.parse(artifact?.blob_ref_json ?? "null")).toEqual(reference.blobRef);
    } finally {
      db.close();
    }
  });
  for (const historicalVersion of WORKFLOW_MIGRATION_VERSIONS) {
    it(`opens v${historicalVersion} online only after the blob migration baseline`, () => {
      const db = new Database(":memory:");
      try {
        const historical = applyWorkflowSchemaMigrations(
          db,
          () => historicalVersion,
          historicalVersion,
        );
        expect(historical.status).toBe("ok");
        const prefix = db
          .query<
            {
              version: number;
            },
            []
          >("SELECT version FROM workflow_schema_migrations ORDER BY version")
          .all();
        expect(prefix.map(({ version }) => version)).toEqual(
          WORKFLOW_MIGRATION_VERSIONS.filter((version) => version <= historicalVersion),
        );
        const upgraded = applyWorkflowSchemaMigrations(db, () => WORKFLOW_SCHEMA_VERSION);
        if (historicalVersion < 26) {
          expect(upgraded.status).toBe("error");
          if (upgraded.status === "error") {
            expect(upgraded.error).toBeInstanceOf(WorkflowBlobStorageMigrationRequired);
            expect(upgraded.error.message).toContain(WORKFLOW_BLOB_MIGRATION_COMMAND);
          }
        } else {
          expect(upgraded.status).toBe("ok");
        }
        const complete = db
          .query<
            {
              version: number;
            },
            []
          >("SELECT version FROM workflow_schema_migrations ORDER BY version")
          .all();
        expect(complete.map(({ version }) => version)).toEqual(
          historicalVersion < 26
            ? WORKFLOW_MIGRATION_VERSIONS.filter((version) => version <= historicalVersion)
            : [...WORKFLOW_MIGRATION_VERSIONS],
        );
      } finally {
        db.close();
      }
    });
  }
  it("upgrades a populated on-disk v24 binding through v25 without changing its data", () => {
    const file = dbPath("populated-v24-binding");
    const target = {
      platform: "discord" as const,
      channelId: "channel-1",
      replyToMessageId: "origin-1",
    };
    const binding = {
      runId: "run-1",
      target,
      messageRef: { platform: "discord" as const, channelId: "channel-1", messageId: "card-1" },
      lastRenderedSha256: "f".repeat(64),
      lastError: "legacy retry",
      retryCount: 2,
      nextAttemptAt: 50,
      permanentFailure: null,
      createdAt: 10,
      updatedAt: 20,
    };
    let store = new DurableWorkflowStore(file);
    store.createInvocation({
      revision: revision(),
      run: { ...run(), progressTarget: target },
    });
    store.upsertSurfaceBinding(binding);
    store.close();

    const v24 = new Database(file);
    try {
      downgradeSchemaToV24(v24);
      const upgraded = applyWorkflowSchemaMigrations(v24, () => 30);
      expect(upgraded.status).toBe("ok");
      expect(
        v24
          .query<{ permanent_failure_json: string | null }, []>(
            "SELECT permanent_failure_json FROM workflow_surface_bindings WHERE run_id = 'run-1'",
          )
          .get(),
      ).toEqual({ permanent_failure_json: null });
    } finally {
      v24.close();
    }

    store = new DurableWorkflowStore(file);
    try {
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toEqual(binding);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("rejects workflow databases migrated by an unknown future runtime", () => {
    const file = dbPath("future-schema");
    const db = new Database(file);
    const futureVersion = WORKFLOW_SCHEMA_VERSION + 1;
    try {
      applyWorkflowSchemaMigrations(db);
      db.run(
        "INSERT INTO workflow_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [futureVersion, "future migration", 1],
      );
      const migrated = applyWorkflowSchemaMigrations(db);
      expect(migrated.status).toBe("error");
      if (migrated.status === "error") {
        expect(migrated.error).toMatchObject({
          _tag: "WorkflowMigrationUnsupportedVersion",
          version: futureVersion,
        });
      }
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("fails a corrupt list row and emits only bounded redacted provenance", async () => {
    const file = dbPath("corrupt-list-row");
    const diagnostics: Array<{
      table: string;
      field: string;
      version: number;
      issueCode: string;
      recordId: string;
    }> = [];
    const store = new DurableWorkflowStore(file, {
      onPersistenceDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const corruptor = new Database(file);
    try {
      store.createInvocation({ revision: revision(), run: run() });
      corruptor.run("UPDATE workflow_runs SET args_json = ? WHERE run_id = ?", [
        '{"secret":"must-not-appear"',
        "run-1",
      ]);
      const listed = store.listRuns();
      expect(listed.status).toBe("error");
      if (listed.status === "error") expect(listed.error._tag).toBe("MalformedSerialization");
      await Promise.resolve();
      expect(diagnostics).toEqual([
        {
          table: "workflow_runs",
          field: "args_json",
          version: WORKFLOW_SCHEMA_VERSION,
          issueCode: "malformed-json",
          recordId: "run-1",
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain("must-not-appear");
    } finally {
      corruptor.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("classifies the original SQLite driver error from invocation persistence", () => {
    const file = dbPath("invocation-driver-error");
    const store = new DurableWorkflowStore(file);
    try {
      const faultDb = new Database(file);
      faultDb.run(`CREATE TRIGGER reject_workflow_revision
        BEFORE INSERT ON workflow_revisions
        BEGIN SELECT RAISE(ABORT, 'injected invocation failure'); END`);
      faultDb.close();

      const created = store.createInvocation({ revision: revision(), run: run() });
      expect(created.status).toBe("error");
      if (created.status === "error") {
        expect(created.error._tag).toBe("DurableWorkflowSqliteDriverFailure");
        if (created.error._tag === "DurableWorkflowSqliteDriverFailure") {
          expect(created.error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
          expect(created.error.operation).toBe("create-invocation");
        }
      }
      expect(workflowStoreValue(store.getRun("run-1"))).toBeNull();
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("bounds reconciliation to active runs and terminal runs missing bindings", () => {
    const file = dbPath("active-progress-targets");
    const store = new DurableWorkflowStore(file);
    const progressTarget = {
      platform: "discord" as const,
      channelId: "channel-1",
      replyToMessageId: null,
    };
    try {
      const rev = revision();
      store.createInvocation({
        revision: rev,
        run: { ...run("active-a"), progressTarget, updatedAt: 11 },
      });
      store.createRun({ ...run("active-b"), progressTarget, updatedAt: 12 });
      store.createRun({ ...run("terminal"), progressTarget, updatedAt: 9 });
      store.createRun({ ...run("without-target"), updatedAt: 8 });
      expect(
        store.transitionRun({
          runId: "terminal",
          from: "queued",
          to: "cancelled",
          now: 13,
        }),
      ).toBe(true);
      expect(
        workflowStoreValue(store.listRunsNeedingProjectionReconciliation({ limit: 1 })).map(
          (item) => item.runId,
        ),
      ).toEqual(["active-a"]);
      expect(
        workflowStoreValue(store.listRunsNeedingProjectionReconciliation()).map(
          (item) => item.runId,
        ),
      ).toEqual(["active-a", "active-b", "terminal"]);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("rolls back a binding upsert when action revocation fails", () => {
    const file = dbPath("binding-action-revocation-rollback");
    const target = {
      platform: "discord" as const,
      channelId: "channel-1",
      replyToMessageId: null,
    };
    const originalBinding = {
      runId: "run-1",
      target,
      messageRef: null,
      lastRenderedSha256: null,
      lastError: null,
      retryCount: 0,
      nextAttemptAt: null,
      permanentFailure: null,
      createdAt: 10,
      updatedAt: 10,
    };
    const store = new DurableWorkflowStore(file);
    try {
      store.createInvocation({
        revision: revision(),
        run: { ...run(), progressTarget: target },
      });
      store.upsertSurfaceBinding(originalBinding);
      store.createSurfaceAction({
        actionId: "action-1",
        tokenSha256: "e".repeat(64),
        runId: "run-1",
        kind: "pause",
        expectedPlatform: "discord",
        expectedUserId: "user-1",
        expectedMessageRef: null,
        expiresAt: 100,
        consumedAt: null,
        consumedByPlatform: null,
        consumedByUserId: null,
        createdAt: 10,
      });
      const faultDb = new Database(file);
      try {
        faultDb.run(`CREATE TRIGGER fail_workflow_surface_action_expiry
          BEFORE UPDATE OF expires_at ON workflow_surface_actions
          BEGIN
            SELECT RAISE(ABORT, 'injected action expiry failure');
          END`);
      } finally {
        faultDb.close();
      }

      expect(() =>
        store.commitSurfaceBindingWithActionRevocation(
          { ...originalBinding, lastError: "must roll back", updatedAt: 20 },
          20,
        ),
      ).toThrow("Durable workflow SQLite operation failed");
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toEqual(originalBinding);
      expect(workflowStoreValue(store.getSurfaceAction("action-1"))?.expiresAt).toBe(100);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("creates and claims queued invocations without approval or safety semantics", () => {
    const file = dbPath("minimal-dispatch");
    const store = new DurableWorkflowStore(file);
    try {
      const created = store.createInvocation({ revision: revision(), run: run() });
      expect(created).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { state: "queued" } },
      });
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 })?.state).toBe(
        "running",
      );
      expect(store.listMigrations().at(-1)).toMatchObject({
        version: WORKFLOW_SCHEMA_VERSION,
        name: "recoverable workflow artifact publications",
      });
    } finally {
      store.close();
    }
    const db = new Database(file);
    try {
      const tables = db
        .query<
          {
            name: string;
          },
          []
        >("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).not.toContain("workflow_approvals");
      expect(tables).not.toContain("workflow_worktree_outputs");
      expect(tables).not.toContain("workflow_surface_projection_claims");
      expect(tables).not.toContain("workflow_surface_projection_orphans");
      expect(tables).not.toContain("workflow_missing_surface_bindings");
      expect(tables).not.toContain("workflow_projection_reconciliation_state");
      const runColumns = db
        .query<
          {
            name: string;
          },
          []
        >("PRAGMA table_info(workflow_runs)")
        .all()
        .map((row) => row.name);
      expect(runColumns).not.toContain("approval_id");
      expect(runColumns).not.toContain("origin_safety_mode");
      const dispatchColumns = db
        .query<
          {
            name: string;
          },
          []
        >("PRAGMA table_info(workflow_request_dispatches)")
        .all()
        .map((row) => row.name);
      expect(dispatchColumns).not.toContain("token_sha256");
      expect(dispatchColumns).not.toContain("canonical_cwd");
      expect(
        db
          .query<
            {
              name: string;
            },
            []
          >("PRAGMA table_info(workflow_surface_bindings)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "run_id",
        "target_json",
        "message_ref_json",
        "last_rendered_sha256",
        "last_error",
        "retry_count",
        "next_attempt_at",
        "created_at",
        "updated_at",
        "permanent_failure_json",
      ]);
      expect(
        db
          .query<
            {
              name: string;
            },
            []
          >("PRAGMA table_info(workflow_action_outbox)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "outbox_id",
        "action_id",
        "run_id",
        "event_type",
        "payload_json",
        "published_at",
        "projected_at",
        "attempt_count",
        "next_attempt_at",
        "last_error",
        "created_at",
        "updated_at",
      ]);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("atomically orphans unreachable live-parent runs while retaining reachable chains", () => {
    const file = dbPath("live-parent-orphans");
    const store = new DurableWorkflowStore(file);
    try {
      store.createRevision(revision());
      expect(store.createRun(liveParentRun("reachable", "root-parent"))).toBe(true);
      expect(store.createRun(liveParentRun("nested", "workflow-request"))).toBe(true);
      expect(store.createRun(liveParentRun("active-orphan", "missing-parent"))).toBe(true);
      expect(store.createRun(liveParentRun("terminal-orphan", "missing-parent"))).toBe(true);
      expect(
        store.tryClaimRun({ runId: "reachable", claimerId: "worker", now: 20 }),
      ).not.toBeNull();
      expect(
        store.createOperation(
          {
            ...operation("reachable", "agent-op"),
            state: "running",
            requestId: "workflow-request",
          },
          "worker",
        ),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "terminal-orphan",
          from: "queued",
          to: "running",
          now: 21,
        }),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "terminal-orphan",
          from: "running",
          to: "succeeded",
          now: 22,
          result: "completed without a parent",
        }),
      ).toBe(true);
      const orphaned = store.reconcileOrphanedLiveParentRuns({
        resolvableParentRequestIds: ["root-parent"],
        now: 30,
        detail: "parent request unavailable",
      });
      expect(orphaned.map((entry) => entry.run.runId)).toEqual([
        "active-orphan",
        "terminal-orphan",
      ]);
      expect(workflowStoreValue(store.getRun("reachable"))?.state).toBe("running");
      expect(workflowStoreValue(store.getRun("nested"))?.state).toBe("queued");
      expect(workflowStoreValue(store.getRun("active-orphan"))).toMatchObject({
        state: "cancelled",
        terminalDetail: "parent request unavailable",
      });
      expect(workflowStoreValue(store.getRun("terminal-orphan"))).toMatchObject({
        state: "succeeded",
        result: "completed without a parent",
      });
      expect(store.getLiveParentDeliveryState("reachable")).toBe("pending");
      expect(store.getLiveParentDeliveryState("nested")).toBe("pending");
      expect(store.getLiveParentDeliveryState("active-orphan")).toBe("orphaned");
      expect(store.getLiveParentDeliveryState("terminal-orphan")).toBe("orphaned");
      expect(
        store.reconcileOrphanedLiveParentRuns({
          resolvableParentRequestIds: ["root-parent"],
          now: 31,
          detail: "parent request unavailable",
        }),
      ).toEqual([]);
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("atomically enforces the global active-run cap and admits after terminalization", () => {
    const file = dbPath("active-run-cap");
    const store = new DurableWorkflowStore(file);
    const rejectedRevision = {
      ...revision("revision-rejected"),
      normalizedPath: "rejected.js",
    };
    try {
      expect(
        store.createInvocation({
          revision: revision("revision-active"),
          run: run("run-active", "revision-active"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({ status: "ok", value: { status: "accepted" } });
      expect(store.countActiveRuns()).toBe(1);
      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "rejected_capacity", activeRuns: 1, limit: 1 },
      });
      expect(workflowStoreValue(store.getRun("run-rejected"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-rejected"))).toBeNull();
      expect(
        store.transitionRun({
          runId: "run-active",
          from: "queued",
          to: "cancelled",
          now: 20,
        }),
      ).toBe(true);
      expect(store.countActiveRuns()).toBe(0);
      expect(
        store.createInvocation({
          revision: rejectedRevision,
          run: run("run-rejected", "revision-rejected"),
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-rejected" } },
      });
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("reuses an idempotent invocation at capacity and rejects a new key without rows", () => {
    const file = dbPath("active-run-cap-idempotency");
    const store = new DurableWorkflowStore(file);
    const fingerprintSha256 = "f".repeat(64);
    try {
      const first = store.createInvocation({
        revision: revision("revision-first"),
        run: run("run-first", "revision-first"),
        idempotency: { key: "existing-key", fingerprintSha256 },
        maxActiveRuns: 1,
      });
      expect(first).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-first" } },
      });
      expect(
        store.createInvocation({
          revision: revision("revision-replay"),
          run: run("run-replay", "revision-replay"),
          idempotency: { key: "existing-key", fingerprintSha256 },
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "accepted", run: { runId: "run-first" } },
      });
      expect(
        store.createInvocation({
          revision: revision("revision-new"),
          run: run("run-new", "revision-new"),
          idempotency: { key: "new-key", fingerprintSha256: "e".repeat(64) },
          maxActiveRuns: 1,
        }),
      ).toMatchObject({
        status: "ok",
        value: { status: "rejected_capacity", activeRuns: 1, limit: 1 },
      });
      expect(workflowStoreValue(store.getRun("run-replay"))).toBeNull();
      expect(workflowStoreValue(store.getRun("run-new"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-replay"))).toBeNull();
      expect(workflowStoreValue(store.getRevision("revision-new"))).toBeNull();
    } finally {
      store.close();
    }
    const db = new Database(file);
    try {
      expect(
        db
          .query<
            {
              count: number;
            },
            []
          >("SELECT COUNT(*) AS count FROM workflow_invocation_receipts")
          .get()?.count,
      ).toBe(1);
    } finally {
      db.close();
      rmSync(file, { force: true });
    }
  });
  it("ignores fallbacks but pins every head field across dispatch epochs", () => {
    const file = dbPath("resolved-model-pinning");
    const store = new DurableWorkflowStore(file);
    try {
      store.createInvocation({ revision: revision(), run: run() });
      store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 });
      store.createOperation(operation("run-1", "operation-1"), "worker-1");
      const policy = {
        runId: "run-1",
        operationId: "operation-1",
        dispatchEpoch: "a".repeat(32),
        profile: "general" as const,
        model: null,
        reasoning: null,
        resolvedModelRequest: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "simple" as const,
          fallbacks: [
            {
              spec: "provider/fallback-a",
              provider: "provider",
              modelId: "fallback-a",
              reasoningDisplay: "simple" as const,
            },
          ],
        },
        cwd: "/workspace",
        originSession: {
          requestId: "request-1",
          sessionId: "session-1",
          client: "discord" as const,
          userId: "user-1",
        },
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy,
          now: 21,
          staleOwnerBefore: 21,
        }),
      ).toMatchObject({ state: "dispatched" });
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(policy));
      const refreshedFallbackPolicy = {
        ...policy,
        dispatchEpoch: "b".repeat(32),
        resolvedModelRequest: {
          ...policy.resolvedModelRequest,
          fallbacks: [
            {
              spec: "provider/fallback-b",
              provider: "provider",
              modelId: "fallback-b",
              reasoning: "high" as const,
              reasoningDisplay: "detailed" as const,
            },
          ],
        },
      };
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: refreshedFallbackPolicy,
          now: 22,
          staleOwnerBefore: 22,
        }),
      ).toMatchObject({ state: "dispatched" });
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(refreshedFallbackPolicy));
      expect(
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: "workflow:run-1:operation-1",
          platform: "unknown",
          policy: {
            ...refreshedFallbackPolicy,
            dispatchEpoch: "c".repeat(32),
            resolvedModelRequest: {
              ...refreshedFallbackPolicy.resolvedModelRequest,
              spec: "provider/model-b",
              modelId: "model-b",
            },
          },
          now: 23,
          staleOwnerBefore: 23,
        }),
      ).toBeNull();
      expect(
        JSON.stringify(workflowStoreValue(store.getWorkflowRequestDispatchPolicy("agent-request"))),
      ).toBe(JSON.stringify(refreshedFallbackPolicy));
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("binds stable named continuation authority to the durable completion target", () => {
    const file = dbPath("stable-named-policy");
    const store = new DurableWorkflowStore(file);
    try {
      const childSessionId = "sub:parent-session:named:generated";
      const namedRun: WorkflowRun = {
        ...run(),
        completionTarget: {
          kind: "live_parent",
          parentRequestId: "parent-request",
          parentSessionId: "parent-session",
          parentRequestClient: "discord",
          parentToolCallId: "parent-tool",
          childRequestId: "child-request",
          childSessionId,
          profile: "general",
          sessionName: "generated",
          stableNamedContinuation: true,
          depth: 1,
          reasoning: null,
          fallbackToSurface: false,
          fallbackProgressTarget: null,
          deferredDelivery: true,
        },
      };
      store.createInvocation({ revision: revision(), run: namedRun });
      store.tryClaimRun({ runId: "run-1", claimerId: "worker-1", now: 20 });
      store.createOperation(operation("run-1", "operation-1"), "worker-1");
      const policy = {
        runId: "run-1",
        operationId: "operation-1",
        dispatchEpoch: "a".repeat(32),
        profile: "general" as const,
        model: null,
        reasoning: null,
        resolvedModelRequest: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "simple" as const,
        },
        cwd: "/workspace",
        originSession: {
          requestId: namedRun.origin.requestId,
          sessionId: namedRun.origin.sessionId,
          client: namedRun.origin.client,
          userId: namedRun.origin.userId,
        },
      };
      const authorize = (stableNamedContinuation?: {
        sessionId: string;
        requestClient: "discord" | "github";
      }) =>
        store.authorizeAgentDispatch({
          requestId: "agent-request",
          runId: "run-1",
          operationId: "operation-1",
          runOwnerId: "worker-1",
          sessionId: childSessionId,
          platform: "unknown",
          policy: { ...policy, stableNamedContinuation },
          now: 21,
          staleOwnerBefore: 21,
        });
      expect(authorize()).toBeNull();
      expect(
        authorize({
          sessionId: childSessionId,
          requestClient: "github",
        }),
      ).toBeNull();
      expect(
        authorize({
          sessionId: childSessionId,
          requestClient: "discord",
        }),
      ).toMatchObject({ state: "dispatched" });
    } finally {
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("decodes legacy and flat fallback model requests but rejects recursive fallbacks", () => {
    const legacy = {
      spec: "provider/model-a",
      provider: "provider",
      modelId: "model-a",
      reasoningDisplay: "simple" as const,
    };
    expect(workflowResolvedModelRequestSchema.parse(legacy)).toEqual(legacy);
    expect(
      workflowResolvedModelRequestSchema.parse({
        ...legacy,
        fallbacks: [
          {
            ...legacy,
            reasoning: "high",
            reasoningDisplay: "detailed",
          },
        ],
      }),
    ).toEqual({
      ...legacy,
      fallbacks: [{ ...legacy, reasoning: "high", reasoningDisplay: "detailed" }],
    });
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        fallbacks: [{ ...legacy, fallbacks: [] }],
      }).success,
    ).toBe(false);
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        openaiServerCompaction: false,
      }).success,
    ).toBe(false);
    expect(
      workflowResolvedModelRequestSchema.safeParse({
        ...legacy,
        provider: "anthropic",
        spec: "anthropic/claude-test",
        modelId: "claude-test",
        openaiServerCompaction: true,
      }).success,
    ).toBe(false);
  });
});
