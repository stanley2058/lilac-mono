import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Database } from "bun:sqlite";

import {
  BlobAdapterFailure,
  BlobCloseDeadlineExceeded,
  BlobUploadReservationFailed,
  createMemoryBlobStore,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { afterEach, describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";
import SuperJSON from "superjson";

import {
  BlobStorageMigrationArgumentsInvalid,
  parseBlobStorageMigrationArgs,
  runBlobStorageMigration,
  type BlobStorageMigrationOptions,
} from "../../scripts/migrate-blob-storage";
import { applyWorkflowSchemaMigrations } from "../../src/workflow/workflow-migrations";
import { createTranscriptSchemaMigrationFixture } from "../transcript/fixtures/transcript-schema-migration-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function parse(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
):
  | { readonly kind: "ok"; readonly value: BlobStorageMigrationOptions }
  | { readonly kind: "error"; readonly error: BlobStorageMigrationArgumentsInvalid } {
  return parseBlobStorageMigrationArgs(argv, environment).match<
    | { readonly kind: "ok"; readonly value: BlobStorageMigrationOptions }
    | { readonly kind: "error"; readonly error: BlobStorageMigrationArgumentsInvalid }
  >({
    ok: (value) => ({ kind: "ok" as const, value }),
    err: (error) => ({ kind: "error" as const, error }),
  });
}

async function legacyCliFixture(): Promise<{
  dataDir: string;
  configPath: string;
  transcriptPath: string;
  workflowPath: string;
  gracefulRestartPath: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-blob-migration-cli-"));
  temporaryRoots.push(dataDir);
  const configPath = path.join(dataDir, "core-config.yaml");
  const transcriptPath = path.join(dataDir, "agent-transcripts.db");
  const workflowPath = path.join(dataDir, "data.sqlite3");
  const gracefulRestartPath = path.join(dataDir, "graceful-restart.db");
  await fs.writeFile(configPath, "configVersion: 2\n");
  createTranscriptSchemaMigrationFixture(transcriptPath, 5);
  const workflow = new Database(workflowPath, { create: true, strict: true });
  const workflowSchema = applyWorkflowSchemaMigrations(workflow, () => 1, 25);
  workflowSchema.match({
    ok: () => undefined,
    err: (error) => {
      throw error;
    },
  });
  workflow.close();
  const gracefulRestart = new Database(gracefulRestartPath, { create: true, strict: true });
  gracefulRestart.run(`
    CREATE TABLE graceful_restart_state (
      singleton_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      updated_ts INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
  gracefulRestart.run("INSERT INTO graceful_restart_state VALUES (?, ?, ?, ?)", [
    1,
    "completed",
    1,
    SuperJSON.stringify({ version: 1, createdAt: 1, deadlineMs: 1_000, agent: [], relays: [] }),
  ]);
  gracefulRestart.close();
  return { dataDir, configPath, transcriptPath, workflowPath, gracefulRestartPath };
}

function closeFailingStore(store: BlobStore, onDelete: () => void = () => undefined): BlobStore {
  return {
    startUpload: (input) => store.startUpload(input),
    startStagedUpload: (input) => store.startStagedUpload(input),
    adopt: (handle) => store.adopt(handle),
    resolve: (handle, options) => store.resolve(handle, options),
    open: (reference) => store.open(reference),
    delete: (target) => {
      onDelete();
      return store.delete(target);
    },
    maintain: (input) => store.maintain(input),
    close: () =>
      Promise.resolve(
        Result.err(
          new BlobCloseDeadlineExceeded({
            deadlineAtMs: 1,
            pendingFences: 1,
            message: "controlled close failure",
          }),
        ),
      ),
  };
}

function operationAndCloseFailingStore(store: BlobStore, onClose: () => void): BlobStore {
  return {
    startUpload: () =>
      Promise.resolve(
        Result.err(
          new BlobUploadReservationFailed({
            objectId: "migration-test-object",
            failure: new BlobAdapterFailure({
              adapter: "memory",
              kind: "io",
              operation: "reserve-upload",
              message: "controlled upload failure",
            }),
            message: "controlled upload failure",
          }),
        ),
      ),
    startStagedUpload: (input) => store.startStagedUpload(input),
    adopt: (handle) => store.adopt(handle),
    resolve: (handle, options) => store.resolve(handle, options),
    open: (reference) => store.open(reference),
    delete: (target) => store.delete(target),
    maintain: (input) => store.maintain(input),
    close: () => {
      onClose();
      return Promise.resolve(
        Result.err(
          new BlobCloseDeadlineExceeded({
            deadlineAtMs: 1,
            pendingFences: 1,
            message: "controlled close failure",
          }),
        ),
      );
    },
  };
}

function rejectingOperationStore(store: BlobStore, onClose: () => void): BlobStore {
  return {
    startUpload: () => Promise.reject(new Error("controlled rejected operation")),
    startStagedUpload: (input) => store.startStagedUpload(input),
    adopt: (handle) => store.adopt(handle),
    resolve: (handle, options) => store.resolve(handle, options),
    open: (reference) => store.open(reference),
    delete: (target) => store.delete(target),
    maintain: (input) => store.maintain(input),
    close: (input) => {
      onClose();
      return store.close(input);
    },
  };
}

describe("blob storage migration command", () => {
  it("accepts only the documented normal and dry-run arguments", () => {
    expect(parse(["--config", "core.yaml", "--data-dir", "state"])).toEqual({
      kind: "ok",
      value: {
        configPath: path.resolve("core.yaml"),
        dataDir: path.resolve("state"),
        workflowDbPath: path.resolve("state/data.sqlite3"),
        dryRun: false,
      },
    });
    expect(parse(["--config", "core.yaml", "--data-dir", "state", "--dry-run"])).toEqual({
      kind: "ok",
      value: {
        configPath: path.resolve("core.yaml"),
        dataDir: path.resolve("state"),
        workflowDbPath: path.resolve("state/data.sqlite3"),
        dryRun: true,
      },
    });
    expect(
      parse(["--config", "core.yaml", "--data-dir", "state"], {
        SQLITE_URL: "custom/workflows.sqlite3",
      }),
    ).toEqual({
      kind: "ok",
      value: {
        configPath: path.resolve("core.yaml"),
        dataDir: path.resolve("state"),
        workflowDbPath: path.resolve("custom/workflows.sqlite3"),
        dryRun: false,
      },
    });
  });

  it("rejects missing, positional, and unknown arguments", () => {
    for (const argv of [
      ["--config", "core.yaml"],
      ["--config", "core.yaml", "--data-dir", "state", "apply"],
      ["--config", "core.yaml", "--data-dir", "state", "--apply"],
    ]) {
      expect(parse(argv).kind).toBe("error");
    }
  });

  it("runs the complete preflight without changing legacy databases or creating the target", async () => {
    const { dataDir, configPath, transcriptPath, workflowPath, gracefulRestartPath } =
      await legacyCliFixture();

    const transcriptBefore = await fs.readFile(transcriptPath);
    const workflowBefore = await fs.readFile(workflowPath);
    const gracefulRestartBefore = await fs.readFile(gracefulRestartPath);
    const result = await runBlobStorageMigration({
      configPath,
      dataDir,
      workflowDbPath: workflowPath,
      dryRun: true,
    });
    const report = result.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });

    expect(report.result).toBe("preflight-complete");
    expect(report.targetAdapter).toBe("local");
    expect(report.redisMigration).toBe("not-attempted");
    expect(report.legacyGracefulRestartSnapshotsToDiscard).toBe(1);
    expect(report.discardedLegacyGracefulRestartSnapshots).toBe(0);
    expect(await fs.readFile(transcriptPath)).toEqual(transcriptBefore);
    expect(await fs.readFile(workflowPath)).toEqual(workflowBefore);
    expect(await fs.readFile(gracefulRestartPath)).toEqual(gracefulRestartBefore);
    expect(await fs.exists(path.join(dataDir, "blobs"))).toBe(false);
  });

  it("migrates the workflow database selected by SQLITE_URL", async () => {
    const { dataDir, configPath, workflowPath } = await legacyCliFixture();
    const selectedWorkflowPath = path.join(dataDir, "selected", "workflows.sqlite3");
    await fs.mkdir(path.dirname(selectedWorkflowPath), { recursive: true });
    await fs.rename(workflowPath, selectedWorkflowPath);
    const parsed = parse(["--config", configPath, "--data-dir", dataDir], {
      SQLITE_URL: selectedWorkflowPath,
    });
    if (parsed.kind === "error") throw parsed.error;

    const result = await runBlobStorageMigration(parsed.value);

    expect(result.status).toBe("ok");
    expect(await fs.exists(workflowPath)).toBe(false);
    using workflow = new Database(selectedWorkflowPath, { readonly: true, strict: true });
    expect(
      workflow
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM workflow_schema_migrations",
        )
        .get()?.version,
    ).toBe(26);
  });

  it("closes the target before committing either database schema", async () => {
    const { dataDir, configPath, transcriptPath, workflowPath, gracefulRestartPath } =
      await legacyCliFixture();
    const bytes = new Uint8Array([7, 8, 9]);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    using transcriptWriter = new Database(transcriptPath, { strict: true });
    transcriptWriter.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
      digest,
      "application/octet-stream",
      "close-fixture.bin",
      bytes.byteLength,
      bytes,
      1,
    ]);
    transcriptWriter.close();
    let deleteCalls = 0;
    const result = await runBlobStorageMigration(
      { configPath, dataDir, workflowDbPath: workflowPath, dryRun: false },
      {
        createTargetStore: async () => {
          const created = await createMemoryBlobStore();
          return created.map((store) =>
            closeFailingStore(store, () => {
              deleteCalls += 1;
            }),
          );
        },
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.phase).toBe("close");
    expect(deleteCalls).toBe(1);
    using transcript = new Database(transcriptPath, { readonly: true, strict: true });
    using workflow = new Database(workflowPath, { readonly: true, strict: true });
    expect(
      transcript
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(5);
    expect(
      workflow
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM workflow_schema_migrations",
        )
        .get()?.version,
    ).toBe(25);
    using gracefulRestart = new Database(gracefulRestartPath, { readonly: true, strict: true });
    expect(
      gracefulRestart
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graceful_restart_state")
        .get()?.count,
    ).toBe(1);
  });

  it("reports both a rejected migration operation and store close failure", async () => {
    const { dataDir, configPath, transcriptPath } = await legacyCliFixture();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    using transcript = new Database(transcriptPath, { strict: true });
    transcript.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
      digest,
      "application/octet-stream",
      "fixture.bin",
      bytes.byteLength,
      bytes,
      1,
    ]);
    transcript.close();
    let closeCalls = 0;

    const result = await runBlobStorageMigration(
      { configPath, dataDir, workflowDbPath: path.join(dataDir, "data.sqlite3"), dryRun: false },
      {
        createTargetStore: async () => {
          const created = await createMemoryBlobStore();
          return created.map((store) =>
            operationAndCloseFailingStore(store, () => {
              closeCalls += 1;
            }),
          );
        },
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("operation=");
      expect(result.error.message).toContain("close=");
    }
    expect(closeCalls).toBe(1);
  });

  it("closes the store and preserves Panic identity for a rejected owned operation", async () => {
    const { dataDir, configPath, transcriptPath, workflowPath } = await legacyCliFixture();
    const bytes = new Uint8Array([4, 5, 6]);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    using transcriptWriter = new Database(transcriptPath, { strict: true });
    transcriptWriter.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
      digest,
      "application/octet-stream",
      "panic-fixture.bin",
      bytes.byteLength,
      bytes,
      1,
    ]);
    transcriptWriter.close();
    let closeCalls = 0;

    const captured = await Result.tryPromise({
      try: () =>
        runBlobStorageMigration(
          { configPath, dataDir, workflowDbPath: workflowPath, dryRun: false },
          {
            createTargetStore: async () => {
              const created = await createMemoryBlobStore();
              return created.map((store) =>
                rejectingOperationStore(store, () => {
                  closeCalls += 1;
                }),
              );
            },
          },
        ),
      catch: (cause) => ({ cause }),
    });

    expect(captured.status).toBe("error");
    if (captured.status === "error") expect(Panic.is(captured.error.cause)).toBe(true);
    expect(closeCalls).toBe(1);
    using transcript = new Database(transcriptPath, { readonly: true, strict: true });
    using workflow = new Database(workflowPath, { readonly: true, strict: true });
    expect(
      transcript
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(5);
    expect(
      workflow
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM workflow_schema_migrations",
        )
        .get()?.version,
    ).toBe(25);
  });

  it("applies both current schemas after a successful preflight", async () => {
    const { dataDir, configPath, transcriptPath, workflowPath, gracefulRestartPath } =
      await legacyCliFixture();
    const reports: string[] = [];
    const result = await runBlobStorageMigration(
      { configPath, dataDir, workflowDbPath: workflowPath, dryRun: false },
      { onPreflight: (report) => reports.push(report.result) },
    );

    expect(result.status).toBe("ok");
    expect(reports).toEqual(["preflight-complete"]);
    if (result.status === "ok") {
      expect(result.value.legacyGracefulRestartSnapshotsToDiscard).toBe(1);
      expect(result.value.discardedLegacyGracefulRestartSnapshots).toBe(1);
    }
    using transcript = new Database(transcriptPath, { readonly: true, strict: true });
    using workflow = new Database(workflowPath, { readonly: true, strict: true });
    expect(
      transcript
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM transcript_schema_migrations",
        )
        .get()?.version,
    ).toBe(6);
    expect(
      workflow
        .query<{ version: number }, []>(
          "SELECT MAX(version) AS version FROM workflow_schema_migrations",
        )
        .get()?.version,
    ).toBe(26);
    using gracefulRestart = new Database(gracefulRestartPath, { readonly: true, strict: true });
    expect(
      gracefulRestart
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graceful_restart_state")
        .get()?.count,
    ).toBe(0);
  });

  it("rejects a local target nested below legacy storage that apply removes", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-blob-migration-overlap-"));
    temporaryRoots.push(dataDir);
    const configPath = path.join(dataDir, "core-config.yaml");
    const targetRoot = path.join(dataDir, "tool-results", "blobs");
    await fs.writeFile(
      configPath,
      `configVersion: 2\nblobStorage:\n  kind: local\n  root: ${JSON.stringify(targetRoot)}\n`,
    );

    const result = await runBlobStorageMigration({
      configPath,
      dataDir,
      workflowDbPath: path.join(dataDir, "data.sqlite3"),
      dryRun: true,
    });
    const failure = result.match({ ok: () => null, err: (error) => error });

    expect(failure?.source).toBe("target");
    expect(failure?.message).toContain("overlaps storage");
    expect(await fs.exists(targetRoot)).toBe(false);
  });

  it("rejects a local target that contains legacy storage removed by apply", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-blob-migration-overlap-"));
    temporaryRoots.push(dataDir);
    const configPath = path.join(dataDir, "core-config.yaml");
    await fs.writeFile(
      configPath,
      `configVersion: 2\nblobStorage:\n  kind: local\n  root: ${JSON.stringify(dataDir)}\n`,
    );

    const result = await runBlobStorageMigration({
      configPath,
      dataDir,
      workflowDbPath: path.join(dataDir, "data.sqlite3"),
      dryRun: true,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.source).toBe("target");
  });
});
