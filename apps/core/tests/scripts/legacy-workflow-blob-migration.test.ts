import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";

import {
  applyLegacyWorkflowBlobMigration,
  preflightLegacyWorkflowBlobMigration,
} from "../../scripts/legacy-workflow-blob-migration";
import { encodeWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-persistence-codec";
import { sha256 } from "../../src/workflow/workflow-definition";
import { applyWorkflowSchemaMigrations } from "../../src/workflow/workflow-migrations";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function installInertLegacyWorkflowState(db: Database): void {
  db.run(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resume_published_at INTEGER,
      definition_json TEXT NOT NULL,
      resume_seq INTEGER NOT NULL
    );
    CREATE TABLE workflow_tasks (
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL,
      input_json TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      discord_from_user_id TEXT,
      timeout_at INTEGER,

      PRIMARY KEY (workflow_id, task_id)
    );
    CREATE INDEX idx_workflow_tasks_wid_state
      ON workflow_tasks(workflow_id, state);
    CREATE INDEX idx_workflow_tasks_discord_wait
      ON workflow_tasks(kind, discord_channel_id, state);
    CREATE INDEX idx_workflow_tasks_timeout
      ON workflow_tasks(timeout_at, state);
  `);
  db.run("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    "legacy-workflow",
    "resolved",
    1,
    2,
    2,
    null,
    "{}",
    0,
  ]);
  db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    "legacy-workflow",
    "legacy-task",
    "sleep",
    "inert fixture",
    "resolved",
    null,
    null,
    1,
    2,
    2,
    "fixture",
    null,
    null,
    null,
    null,
  ]);
}

async function legacyFixture(
  options: { readonly includeInertLegacyState?: boolean } = {},
): Promise<{
  root: string;
  dbPath: string;
  sourceArtifactId: string;
  valueArtifactId: string;
  durableBytes: number;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "lilac-workflow-blob-migration-"));
  roots.push(root);
  const dbPath = path.join(root, "workflow.sqlite");
  const source = "export default async function workflow() { return 'done'; }\n";
  const sourceHash = sha256(source);
  const sourceArtifactId = `workflow-source:${sourceHash}`;
  const value = { shared: "x".repeat(70_000) };
  const encodedValue = encodeWorkflowValueArtifact(value);
  const valueArtifactId = `workflow-value:${encodedValue.payloadHash}`;
  await fs.mkdir(path.join(root, "workflow-snapshots"));
  await fs.mkdir(path.join(root, "workflow-artifacts"));
  await fs.writeFile(path.join(root, "workflow-snapshots", `${sourceHash}.js`), source);
  await fs.writeFile(
    path.join(root, "workflow-artifacts", `${encodedValue.payloadHash}.json`),
    encodedValue.encoded,
  );
  await fs.writeFile(path.join(root, "workflow-artifacts", ".stale.tmp"), "discard me");

  const db = new Database(dbPath, { create: true, strict: true });
  const migrated = applyWorkflowSchemaMigrations(db, () => 1, 25);
  expect(migrated.status).toBe("ok");
  if (options.includeInertLegacyState === true) installInertLegacyWorkflowState(db);
  const limits = JSON.stringify({
    maxSourceBytes: 256 * 1024,
    maxInputBytes: 256 * 1024,
    maxOperationOutputBytes: 1024 * 1024,
    maxResultBytes: 1024 * 1024,
  });
  db.run(
    `INSERT INTO workflow_revisions (
       revision_id, canonical_project_id, canonical_workspace_root, scope,
       normalized_path, name, snapshot_artifact_id, source_sha256,
       input_schema_sha256, capability_sha256, metadata_json, input_schema_json,
       capabilities_json, limits_json, runtime_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "revision-1",
      "project-1",
      "/workspace",
      "project",
      "shared.js",
      "shared",
      sourceArtifactId,
      sourceHash,
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify({ name: "shared", description: "fixture" }),
      "{}",
      JSON.stringify({ agents: { maxConcurrent: 1, maxTotal: 1 }, waits: [] }),
      limits,
      "lilac-workflow-js-v4",
      10,
    ],
  );
  db.run(
    `INSERT INTO workflow_runs (
       run_id, revision_id, state, input_schema_json, args_json, args_sha256,
       origin_request_id, origin_session_id, origin_client, origin_user_id,
       origin_project_cwd, completion_target_json, progress_target_json,
       terminal_detail, result_json, result_artifact_id, claimed_by, claimed_at,
       created_at, started_at, updated_at, terminal_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "run-1",
      "revision-1",
      "succeeded",
      "{}",
      "{}",
      "c".repeat(64),
      null,
      null,
      null,
      null,
      "/workspace",
      JSON.stringify({ kind: "detached" }),
      null,
      "complete",
      null,
      valueArtifactId,
      null,
      null,
      20,
      21,
      22,
      22,
    ],
  );
  db.run(
    `INSERT INTO workflow_operations (
       run_id, operation_id, call_site_id, parent_operation_id, phase, label,
       kind, input_json, input_sha256, state, attempt, request_id, output_json,
       result_artifact_id, error, usage_json, claimed_by, claimed_at, created_at,
       started_at, updated_at, terminal_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "run-1",
      "operation-1",
      "call-site-1",
      null,
      null,
      null,
      "agent",
      JSON.stringify("input"),
      "d".repeat(64),
      "succeeded",
      0,
      "request-1",
      null,
      valueArtifactId,
      null,
      null,
      null,
      null,
      20,
      21,
      22,
      22,
    ],
  );
  db.run(
    `INSERT INTO workflow_request_terminal_receipts (
       request_id, run_id, operation_id, dispatch_epoch, state, detail,
       created_at, output_json, result_artifact_id, usage_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "request-1",
      "run-1",
      "operation-1",
      "epoch-1",
      "resolved",
      "complete",
      22,
      null,
      valueArtifactId,
      null,
    ],
  );
  db.close();
  return {
    root,
    dbPath,
    sourceArtifactId,
    valueArtifactId,
    durableBytes: Buffer.byteLength(source) + Buffer.byteLength(encodedValue.encoded),
  };
}

function countingStore(store: BlobStore, onUpload: () => void): BlobStore {
  return {
    startUpload: (input) => {
      onUpload();
      return store.startUpload(input);
    },
    startStagedUpload: (input) => store.startStagedUpload(input),
    adopt: (handle) => store.adopt(handle),
    resolve: (handle, options) => store.resolve(handle, options),
    open: (reference) => store.open(reference),
    delete: (target) => store.delete(target),
    maintain: (input) => store.maintain(input),
    close: (input) => store.close(input),
  };
}

async function expectSchemaCatalogMismatchBeforeUpload(input: {
  readonly root: string;
  readonly dbPath: string;
}): Promise<void> {
  const before = await fs.readFile(input.dbPath);
  const created = await createMemoryBlobStore();
  if (created.status === "error") throw created.error;
  let uploadCount = 0;
  const result = await applyLegacyWorkflowBlobMigration({
    dbPath: input.dbPath,
    dataDir: input.root,
    blobStore: countingStore(created.value, () => {
      uploadCount += 1;
    }),
  });
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error).toMatchObject({
      source: "schema",
      code: "schema-25-catalog-mismatch",
    });
  }
  expect(uploadCount).toBe(0);
  expect(await fs.readFile(input.dbPath)).toEqual(before);
  await created.value.close({ deadlineAtMs: Date.now() + 1_000 });
}

describe("legacy workflow blob migration", () => {
  it("preflights schema 25 without mutating the database, files, or blob store", async () => {
    const fixture = await legacyFixture();
    const before = await fs.readFile(fixture.dbPath);
    const result = await preflightLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
    });
    expect(result.status).toBe("ok");
    if (result.status === "error") return;
    expect(result.value).toEqual({
      schemaVersion: 25,
      revisionSnapshotReferences: 1,
      runResultReferences: 1,
      operationResultReferences: 1,
      terminalReceiptResultReferences: 1,
      distinctSourceArtifacts: 1,
      distinctValueArtifacts: 1,
      distinctArtifacts: 2,
      durableBytes: fixture.durableBytes,
      discardedLegacyEntries: 1,
    });
    expect(await fs.readFile(fixture.dbPath)).toEqual(before);
    expect(await fs.readdir(path.join(fixture.root, "workflow-snapshots"))).toHaveLength(1);
    expect(await fs.readdir(path.join(fixture.root, "workflow-artifacts"))).toHaveLength(2);
  });

  it("preflights and migrates the exact inert pre-unified workflow tables", async () => {
    const fixture = await legacyFixture({ includeInertLegacyState: true });
    const before = await fs.readFile(fixture.dbPath);

    const result = await preflightLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
    });

    expect(result.status).toBe("ok");
    expect(await fs.readFile(fixture.dbPath)).toEqual(before);

    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    const migrated = await applyLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
      blobStore: created.value,
      now: () => 100,
    });
    expect(migrated.status).toBe("ok");
    using database = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflows").get(),
    ).toEqual({ count: 1 });
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflow_tasks").get(),
    ).toEqual({ count: 1 });
    database.close();
    await created.value.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  it("uploads a shared value once, rewrites schema 26, and removes legacy state", async () => {
    const fixture = await legacyFixture();
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    let uploadCount = 0;
    const blobStore = countingStore(created.value, () => {
      uploadCount += 1;
    });
    const result = await applyLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
      blobStore,
      now: () => 100,
    });
    expect(result.status).toBe("ok");
    if (result.status === "error") return;
    expect(result.value).toMatchObject({
      migratedSchemaVersion: 26,
      uploadedArtifacts: 2,
      removedLegacyDirectories: 2,
      distinctArtifacts: 2,
      discardedLegacyEntries: 1,
    });
    expect(uploadCount).toBe(2);
    expect(existsSync(path.join(fixture.root, "workflow-snapshots"))).toBe(false);
    expect(existsSync(path.join(fixture.root, "workflow-artifacts"))).toBe(false);

    const db = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(
      db
        .query<{ version: number }, []>(
          "SELECT version FROM workflow_schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ version: 26 });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM workflow_artifacts").get(),
    ).toEqual({ count: 2 });
    const runReference = db
      .query<{ result_artifact_id: string }, []>(
        "SELECT result_artifact_id FROM workflow_runs WHERE run_id = 'run-1'",
      )
      .get();
    const operationReference = db
      .query<{ result_artifact_id: string }, []>(
        "SELECT result_artifact_id FROM workflow_operations WHERE operation_id = 'operation-1'",
      )
      .get();
    const receiptReference = db
      .query<{ result_artifact_id: string }, []>(
        "SELECT result_artifact_id FROM workflow_request_terminal_receipts WHERE request_id = 'request-1'",
      )
      .get();
    expect(runReference).toEqual(operationReference);
    expect(runReference).toEqual(receiptReference);
    expect(JSON.parse(runReference!.result_artifact_id)).toMatchObject({
      artifactId: fixture.valueArtifactId,
      blobRef: {
        version: 1,
        sha256: expect.any(String),
        byteLength: expect.any(Number),
      },
    });
    db.close();
    await created.value.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  it("fails a missing referenced artifact before starting an upload", async () => {
    const fixture = await legacyFixture();
    await fs.rm(
      path.join(
        fixture.root,
        "workflow-artifacts",
        `${fixture.valueArtifactId.slice("workflow-value:".length)}.json`,
      ),
    );
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    let uploadCount = 0;
    const result = await applyLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
      blobStore: countingStore(created.value, () => {
        uploadCount += 1;
      }),
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({ source: "value-artifact" });
    }
    expect(uploadCount).toBe(0);
    const db = new Database(fixture.dbPath, { readonly: true, strict: true });
    expect(
      db
        .query<{ version: number }, []>(
          "SELECT version FROM workflow_schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ version: 25 });
    db.close();
    await created.value.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  it("rejects partial schema-26 objects during read-only preflight", async () => {
    const fixture = await legacyFixture();
    const database = new Database(fixture.dbPath, { strict: true });
    database.run(
      "CREATE TABLE workflow_artifacts (artifact_id TEXT PRIMARY KEY, blob_ref_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    database.close();
    const before = await fs.readFile(fixture.dbPath);

    const result = await preflightLegacyWorkflowBlobMigration({
      dbPath: fixture.dbPath,
      dataDir: fixture.root,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({
        source: "schema",
        code: "partial-schema-26",
      });
    }
    expect(await fs.readFile(fixture.dbPath)).toEqual(before);
  });

  it("rejects a partial schema-25 object catalog before uploading", async () => {
    const fixture = await legacyFixture();
    const database = new Database(fixture.dbPath, { strict: true });
    database.run("DROP INDEX idx_workflow_runs_state_updated");
    database.close();

    await expectSchemaCatalogMismatchBeforeUpload(fixture);
  });

  it("rejects an extra schema-25 object before uploading", async () => {
    const fixture = await legacyFixture();
    const database = new Database(fixture.dbPath, { strict: true });
    database.run("CREATE TABLE workflow_unexpected_object (id TEXT PRIMARY KEY)");
    database.close();

    await expectSchemaCatalogMismatchBeforeUpload(fixture);
  });

  it("rejects a drifted schema-25 object definition before uploading", async () => {
    const fixture = await legacyFixture();
    const database = new Database(fixture.dbPath, { strict: true });
    database.run("DROP INDEX idx_workflow_runs_state_updated");
    database.run(
      `CREATE INDEX idx_workflow_runs_state_updated
       ON workflow_runs(state, updated_at DESC, run_id)`,
    );
    database.close();

    await expectSchemaCatalogMismatchBeforeUpload(fixture);
  });
});
