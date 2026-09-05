import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  acpCleanupFailuresForPanic,
  captureExternal,
  projectExternalFailure,
} from "../external-adapters.ts";
import {
  commitRunCancellationRequest,
  decodeRunCancellation,
  decodeRunRecord,
  decodeSessionIndex,
  loadRunRecord,
  loadSessionIndex,
  observeRunCancellation,
  requestRunCancellation,
  saveRunRecord,
  upsertSessionIndexEntries,
} from "../run-store.ts";
import { createEmptyPermissionCounters, type PromptRunRecord } from "../types.ts";

let tempRoot = "";
let previousStateHome: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-acp-store-test-"));
  previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tempRoot;
});

afterEach(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function runRecord(): PromptRunRecord {
  return {
    id: "run_11111111-1111-4111-8111-111111111111",
    status: "submitted",
    createdAt: 1,
    updatedAt: 1,
    directory: "/repo",
    harnessId: "opencode",
    targetKind: "new",
    promptText: "test",
    textPreview: "test",
    permissions: createEmptyPermissionCounters(),
  };
}

describe("run persistence codecs", () => {
  it("distinguishes cancellation marker codec failures", () => {
    const runId = runRecord().id;
    const malformed = decodeRunCancellation({ runId, content: "{" });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("RunCancellationMalformedSerialization");
    }

    const unsupported = decodeRunCancellation({
      runId,
      content: JSON.stringify({ version: 2, runCreatedAt: 1, requestedAt: 2 }),
    });
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("RunCancellationUnsupportedVersion");
    }

    const corrupt = decodeRunCancellation({
      runId,
      content: JSON.stringify({ version: 1, runCreatedAt: "invalid", requestedAt: 2 }),
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error._tag).toBe("RunCancellationCorruptFields");
    }
  });

  it("distinguishes current, malformed, and corrupt run records", () => {
    const current = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify(runRecord()),
    });
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const malformed = decodeRunRecord({ runId: runRecord().id, content: "{" });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("RunRecordMalformedSerialization");
    }

    const corrupt = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify({ id: runRecord().id }),
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("RunRecordCorruptFields");
  });

  it("migrates historical run records only when permissions are absent", () => {
    const { permissions: _permissions, ...legacyRecord } = runRecord();
    const legacy = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify(legacyRecord),
    });
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value.permissions).toEqual(createEmptyPermissionCounters());
    }
  });

  it("rejects current-shaped run records with present malformed permissions", () => {
    const malformedPermissions = decodeRunRecord({
      runId: runRecord().id,
      content: JSON.stringify({ ...runRecord(), permissions: {} }),
    });

    expect(malformedPermissions.status).toBe("error");
    if (malformedPermissions.status === "error") {
      expect(malformedPermissions.error._tag).toBe("RunRecordCorruptFields");
    }
  });

  it("distinguishes session index codec outcomes", () => {
    const current = decodeSessionIndex('{"version":1,"sessions":[]}');
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const malformed = decodeSessionIndex("{");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("SessionIndexMalformedSerialization");
    }

    const unsupported = decodeSessionIndex('{"version":2,"sessions":[]}');
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error._tag).toBe("SessionIndexUnsupportedVersion");
    }

    const corrupt = decodeSessionIndex('{"version":1,"sessions":"invalid"}');
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("SessionIndexCorruptFields");

    const legacy = decodeSessionIndex('{"version":0,"sessions":[]}');
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value.version).toBe(1);
    }
  });
});

describe("run store adapters", () => {
  it("rejects invalid cancellation marker objects and corrupt marker files", async () => {
    const run = runRecord();
    expect((await saveRunRecord(run)).status).toBe("ok");
    const runsDir = path.join(tempRoot, "lilac-acp-controller", "runs");
    const markerPath = path.join(runsDir, `${run.id}.cancel.json`);

    const invalidMarkerSetups = [
      () => fs.mkdir(markerPath),
      () => fs.symlink(path.join(runsDir, `${run.id}.json`), markerPath),
    ];
    for (const setup of invalidMarkerSetups) {
      await setup();
      const invalidMarker = await loadRunRecord(run.id);
      expect(invalidMarker.status).toBe("error");
      if (invalidMarker.status === "error") {
        expect(invalidMarker.error._tag).toBe("RunCancellationMarkerInvalidType");
      }
      await fs.rm(markerPath, { recursive: true, force: true });
    }

    await fs.writeFile(markerPath, "{", "utf8");
    const corruptMarker = await loadRunRecord(run.id);
    expect(corruptMarker.status).toBe("error");
    if (corruptMarker.status === "error") {
      expect(corruptMarker.error._tag).toBe("RunCancellationMalformedSerialization");
    }
  });

  it("ignores and supersedes stale cancellation markers", async () => {
    const run = { ...runRecord(), createdAt: 100, updatedAt: 100 };
    expect((await saveRunRecord(run)).status).toBe("ok");
    const markerPath = path.join(tempRoot, "lilac-acp-controller", "runs", `${run.id}.cancel.json`);
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({ version: 1, runCreatedAt: 1, requestedAt: 2 })}\n`,
      "utf8",
    );

    const stale = await loadRunRecord(run.id);
    expect(stale.status).toBe("ok");
    if (stale.status === "ok") expect(stale.value.cancelRequestedAt).toBeUndefined();

    const requested = await requestRunCancellation(run.id);
    expect(requested.status).toBe("ok");
    if (requested.status === "ok") {
      expect(requested.value.kind).toBe("requested");
      expect(requested.value.run.cancelRequestedAt).toBeNumber();
    }
    const marker = decodeRunCancellation({
      runId: run.id,
      content: await fs.readFile(markerPath, "utf8"),
    });
    expect(marker.status).toBe("ok");
    if (marker.status === "ok") expect(marker.value.value.runCreatedAt).toBe(run.createdAt);
  });

  it("reports a committed cancellation request as successful across terminal persistence", async () => {
    const running = { ...runRecord(), status: "running" as const, updatedAt: Date.now() - 10 };
    expect((await saveRunRecord(running)).status).toBe("ok");
    const completed: PromptRunRecord = {
      ...running,
      status: "completed",
      updatedAt: Date.now() - 5,
    };
    expect((await saveRunRecord(completed)).status).toBe("ok");

    const requested = await commitRunCancellationRequest(running);
    expect(requested.status).toBe("ok");
    if (requested.status === "ok") {
      expect(requested.value.kind).toBe("requested");
      expect(requested.value.run.status).toBe("completed");
      expect(requested.value.run.cancelRequestedAt).toBeNumber();
    }
  });

  it("preserves the earliest timestamp across repeated cancellation requests", async () => {
    const running = { ...runRecord(), status: "running" as const, createdAt: 1, updatedAt: 10 };
    expect((await saveRunRecord(running)).status).toBe("ok");
    const markerPath = path.join(
      tempRoot,
      "lilac-acp-controller",
      "runs",
      `${running.id}.cancel.json`,
    );
    await fs.writeFile(
      markerPath,
      `${JSON.stringify({ version: 1, runCreatedAt: running.createdAt, requestedAt: 20 })}\n`,
      "utf8",
    );

    const repeated = await requestRunCancellation(running.id);
    expect(repeated.status).toBe("ok");
    const marker = decodeRunCancellation({
      runId: running.id,
      content: await fs.readFile(markerPath, "utf8"),
    });
    expect(marker.status).toBe("ok");
    if (marker.status === "ok") expect(marker.value.value.requestedAt).toBe(20);
  });

  it("uses terminal-wins ties while preserving strict cancellation ordering", async () => {
    const completed: PromptRunRecord = {
      ...runRecord(),
      status: "completed",
      createdAt: 1,
      updatedAt: 100,
    };
    expect((await saveRunRecord(completed)).status).toBe("ok");
    const markerPath = path.join(
      tempRoot,
      "lilac-acp-controller",
      "runs",
      `${completed.id}.cancel.json`,
    );
    const writeMarker = (requestedAt: number) =>
      fs.writeFile(
        markerPath,
        `${JSON.stringify({ version: 1, runCreatedAt: completed.createdAt, requestedAt })}\n`,
        "utf8",
      );

    await writeMarker(100);
    const tied = await loadRunRecord(completed.id);
    expect(tied.status).toBe("ok");
    if (tied.status === "ok") expect(tied.value.status).toBe("completed");

    await writeMarker(99);
    const cancellationFirst = await loadRunRecord(completed.id);
    expect(cancellationFirst.status).toBe("ok");
    if (cancellationFirst.status === "ok") expect(cancellationFirst.value.status).toBe("cancelled");

    await writeMarker(101);
    const terminalFirst = await loadRunRecord(completed.id);
    expect(terminalFirst.status).toBe("ok");
    if (terminalFirst.status === "ok") expect(terminalFirst.value.status).toBe("completed");

    expect(
      (
        await saveRunRecord({
          ...completed,
          updatedAt: 100,
          cancelRequestedAt: 99,
        })
      ).status,
    ).toBe("ok");
    await writeMarker(101);
    const repeatedAfterTerminal = await loadRunRecord(completed.id);
    expect(repeatedAfterTerminal.status).toBe("ok");
    if (repeatedAfterTerminal.status === "ok") {
      expect(repeatedAfterTerminal.value.status).toBe("cancelled");
      expect(repeatedAfterTerminal.value.cancelRequestedAt).toBe(99);
    }
  });

  it("observes a cancellation marker through the watcher or fallback check", async () => {
    const run = runRecord();
    expect((await saveRunRecord(run)).status).toBe("ok");
    const observation = await observeRunCancellation(run);
    expect(observation.status).toBe("ok");
    if (observation.status === "error") return;

    const requested = await requestRunCancellation(run.id);
    expect(requested.status).toBe("ok");
    const observed = await observation.value.result;
    expect(observed.status).toBe("ok");
    if (observed.status === "ok") expect(observed.value).toBe("requested");
    expect((await observation.value.close()).status).toBe("ok");
  });

  it("rejects cancellation observation with the exact inspection Panic and settles close", async () => {
    const run = runRecord();
    expect((await saveRunRecord(run)).status).toBe("ok");
    const panic = new Panic({ message: "cancellation marker invariant" });
    const observation = await observeRunCancellation(run, () => Promise.reject(panic));
    expect(observation.status).toBe("ok");
    if (observation.status === "error") return;

    await expect(observation.value.result).rejects.toBe(panic);
    expect((await observation.value.close()).status).toBe("ok");
    expect((await observation.value.close()).status).toBe("ok");
  });

  it("maps ordinary cancellation inspection rejection to an owned observation error", async () => {
    const run = runRecord();
    expect((await saveRunRecord(run)).status).toBe("ok");
    const observation = await observeRunCancellation(run, () =>
      Promise.reject(new Error("inspection failed")),
    );
    expect(observation.status).toBe("ok");
    if (observation.status === "error") return;

    const result = await observation.value.result;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ExternalOperationFailed");
      if (result.error._tag === "ExternalOperationFailed") {
        expect(result.error.operation).toBe("watch-run-cancellation");
      }
    }
    expect((await observation.value.close()).status).toBe("ok");
  });

  it("round trips records and reports missing session index provenance", async () => {
    const missing = await loadSessionIndex();
    expect(missing.status).toBe("ok");
    if (missing.status === "ok") expect(missing.value.provenance).toBe("missing-defaulted");

    const saved = await saveRunRecord(runRecord());
    expect(saved.status).toBe("ok");
    const loaded = await loadRunRecord(runRecord().id);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.value).toEqual(runRecord());
  });

  it("blocks upserts without rewriting corrupt or unsupported session indexes", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    const invalidIndexes = [
      {
        content: '{"version":1,"sessions":"invalid"}',
        tag: "SessionIndexCorruptFields",
      },
      {
        content: '{"version":2,"sessions":[]}',
        tag: "SessionIndexUnsupportedVersion",
      },
    ] as const;

    for (const invalid of invalidIndexes) {
      await fs.writeFile(indexPath, invalid.content, "utf8");
      const upserted = await upsertSessionIndexEntries([
        {
          sessionRef: "opencode::session-1",
          harnessId: "opencode",
          remoteSessionId: "session-1",
          cwd: "/repo",
          capabilities: [],
          lastSeenAt: 1,
        },
      ]);

      expect(upserted.status).toBe("error");
      if (upserted.status === "error") expect(upserted.error._tag).toBe(invalid.tag);
      expect(await fs.readFile(indexPath, "utf8")).toBe(invalid.content);
    }
  });

  it("ignores orphaned legacy lock directories", async () => {
    const lockPath = path.join(tempRoot, "lilac-acp-controller", "sessions", "index.lock");
    await fs.mkdir(lockPath, { recursive: true });
    expect((await upsertSessionIndexEntries([])).status).toBe("ok");
  });

  it("releases a killed process's lock without deleting its directory", async () => {
    const directory = path.join(tempRoot, "lilac-acp-controller", "sessions");
    await fs.mkdir(directory, { recursive: true });
    const lockModule = new URL("../session-index-lock.ts", import.meta.url).href;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
        import { acquireSessionIndexLock } from ${JSON.stringify(lockModule)};
        const acquired = await acquireSessionIndexLock(${JSON.stringify(directory)});
        if (acquired.status === "error") process.exit(1);
        process.stdout.write("locked\\n");
        await Bun.stdin.text();
        await acquired.value.close();
      `,
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toBe("locked\n");
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
      expect((await upsertSessionIndexEntries([])).status).toBe("ok");
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("serializes cross-process index updates without losing sessions", async () => {
    const storeModule = new URL("../run-store.ts", import.meta.url).href;
    const children = Array.from({ length: 8 }, (_, owner) =>
      Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `
        import { upsertSessionIndexEntries } from ${JSON.stringify(storeModule)};
        for (let index = 0; index < 12; index += 1) {
          const sessionId = ${JSON.stringify(String(owner))} + ":" + index;
          const saved = await upsertSessionIndexEntries([{
            sessionRef: "opencode::" + sessionId,
            harnessId: "opencode",
            remoteSessionId: sessionId,
            cwd: "/repo",
            capabilities: [],
            lastSeenAt: index,
          }]);
          if (saved.status === "error") process.exit(1);
        }
      `,
        ],
        env: { ...process.env, XDG_STATE_HOME: tempRoot },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    try {
      expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(8).fill(0));
      const loaded = await loadSessionIndex();
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") expect(loaded.value.value.sessions).toHaveLength(96);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  });

  it("releases the session-index lock before rethrowing the exact work Panic", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(indexPath, '{"version":1,"sessions":[]}', "utf8");
    const panic = new Panic({ message: "session index work invariant" });
    const entry = new Proxy(
      {
        sessionRef: "opencode::session-1",
        harnessId: "opencode",
        remoteSessionId: "session-1",
        cwd: "/repo",
        capabilities: [],
        lastSeenAt: 1,
      },
      {
        get(target, property, receiver) {
          if (property === "sessionRef") throw panic;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    let observed: unknown;
    try {
      await upsertSessionIndexEntries([entry]);
    } catch (cause) {
      observed = cause;
    }

    expect(observed).toBe(panic);
    expect((await upsertSessionIndexEntries([])).status).toBe("ok");
  });

  it("releases the lock despite directory permission changes while preserving the work Panic", async () => {
    const sessionsDir = path.join(tempRoot, "lilac-acp-controller", "sessions");
    const indexPath = path.join(sessionsDir, "index.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(indexPath, '{"version":1,"sessions":[]}', "utf8");
    const panic = new Panic({ message: "session index work invariant" });
    const entry = new Proxy(
      {
        sessionRef: "opencode::session-1",
        harnessId: "opencode",
        remoteSessionId: "session-1",
        cwd: "/repo",
        capabilities: [],
        lastSeenAt: 1,
      },
      {
        get(target, property, receiver) {
          if (property === "sessionRef") {
            fsSync.chmodSync(sessionsDir, 0o500);
            throw panic;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    let observed: unknown;
    try {
      await upsertSessionIndexEntries([entry]);
    } catch (cause) {
      observed = cause;
    } finally {
      fsSync.chmodSync(sessionsDir, 0o700);
    }

    expect(observed).toBe(panic);
    const cleanupFailures = acpCleanupFailuresForPanic(panic);
    expect(cleanupFailures).toHaveLength(0);
    expect((await upsertSessionIndexEntries([])).status).toBe("ok");
  });

  it("preserves exact Panic identity at external rejection boundaries", async () => {
    const panic = new Panic({ message: "adapter invariant" });
    let observed: unknown;
    try {
      await captureExternal("read-run", () => Promise.reject(panic));
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBe(panic);
  });

  it("totally projects null-prototype and hostile proxy rejection values", async () => {
    const nullPrototype = Object.create(null);
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap");
      },
      get() {
        throw new Error("get trap");
      },
      has() {
        throw new Error("has trap");
      },
    });

    for (const cause of [nullPrototype, hostile]) {
      expect(projectExternalFailure(cause)).toEqual({ message: "Opaque ACP external failure" });
      const captured = await captureExternal("read-run", () => Promise.reject(cause));
      expect(captured.status).toBe("error");
      if (captured.status === "error") {
        expect(captured.error.message).toBe("Opaque ACP external failure");
      }
    }
  });
});
