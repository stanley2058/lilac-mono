import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DM_CONTEXT_GAP_MS, replayReplySchema } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "../../../src/surface/native/store";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { browserSnapshotSourceHash, restoreNativeBrowserSnapshot } from "./browser-snapshot";

const seedOptions = { historyTurns: 12, sidebarThreads: 2, longTurns: 4, dmWindows: 6 };

test("browser snapshots restore isolated history, canonical transcripts, and relative times", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-browser-snapshot-test-"));
  try {
    const cacheDir = path.join(root, "cache");
    const firstDir = path.join(root, "first");
    const firstNow = Date.now();
    const threads = await restoreNativeBrowserSnapshot(firstDir, {
      cacheDir,
      seedOptions,
      now: firstNow,
    });
    const entries = await readdir(cacheDir);
    expect(entries).toHaveLength(1);
    const snapshotDir = path.join(cacheDir, entries[0]!);
    const snapshotBefore = await readFile(path.join(snapshotDir, "native-surface.db"));
    using firstDb = new Database(path.join(firstDir, "native-surface.db"));
    const first = new NativeStore(firstDb);
    const originalThread = first.getThreadRecord(threads.rich).unwrap();
    const originalInput = first.listPendingInputs().unwrap()[0]!;
    first
      .createThread("owner", { commandId: "session-only", title: "Not in the snapshot" })
      .unwrap();
    first.settleInput(originalInput.id, "canceled").unwrap();

    const offset = 30 * 24 * 3_600_000;
    const secondNow = firstNow + offset;
    const secondDir = path.join(root, "second");
    const restored = await restoreNativeBrowserSnapshot(secondDir, {
      cacheDir,
      seedOptions,
      now: secondNow,
    });
    expect(restored).toEqual(threads);
    expect(await readdir(cacheDir)).toEqual(entries);
    expect(await readFile(path.join(snapshotDir, "native-surface.db"))).toEqual(snapshotBefore);
    using secondDb = new Database(path.join(secondDir, "native-surface.db"));
    const second = new NativeStore(secondDb, () => secondNow);
    second.initialize().unwrap();
    expect(
      secondDb.query("SELECT 1 FROM native_records WHERE data_json LIKE '%session-only%'").get(),
    ).toBeNull();
    expect(second.getThreadRecord(restored.rich).unwrap().createdAt).toBe(
      originalThread.createdAt + offset,
    );
    const pending = second.listPendingInputs().unwrap();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("uploading");
    expect(pending[0]?.createdAt).toBe(originalInput.createdAt + offset);
    expect(second.getThread("participant", restored.rich).unwrap().capabilities).toEqual({
      read: true,
      edit: false,
      share: false,
    });
    const history = second.sync("owner", restored.history).unwrap();
    expect(replayReplySchema.safeParse(history).success).toBe(true);
    expect(JSON.stringify(history)).toContain("Checkpoint **12**");
    expect(JSON.stringify(second.sync("owner", restored.rich).unwrap())).toContain("mermaid");
    expect(
      secondDb
        .query(
          "SELECT 1 FROM native_changes WHERE byte_size != length(CAST(data_json AS BLOB)) LIMIT 1",
        )
        .get(),
    ).toBeNull();
    const firstReplay = firstDb
      .query<{ created_at: number; data_json: string }, [string]>(
        "SELECT created_at,data_json FROM native_changes WHERE thread_id=? AND data_json LIKE '%settledAt%' ORDER BY revision DESC LIMIT 1",
      )
      .get(restored.rich)!;
    const secondReplay = secondDb
      .query<{ created_at: number; data_json: string }, [string]>(
        "SELECT created_at,data_json FROM native_changes WHERE thread_id=? AND data_json LIKE '%settledAt%' ORDER BY revision DESC LIMIT 1",
      )
      .get(restored.rich)!;
    expect(secondReplay.created_at).toBe(firstReplay.created_at + offset);
    expect(secondReplay.data_json).not.toBe(firstReplay.data_json);
    expect(
      second
        .selectSessionWindow(restored.dm, { gapMs: DEFAULT_DM_CONTEXT_GAP_MS, at: secondNow })
        .unwrap().firstPosition,
    ).toBeNull();
    const outline = second
      .outline("owner", restored.dm, { dmContextGapMs: DEFAULT_DM_CONTEXT_GAP_MS })
      .unwrap();
    expect(outline.windows).toHaveLength(8);
    expect(
      second
        .selectSessionWindow(restored.dm, {
          gapMs: DEFAULT_DM_CONTEXT_GAP_MS,
          at: secondNow - 3 * 3_600_000 + 60_000,
        })
        .unwrap().firstPosition,
    ).toBe(outline.windows!.at(-1)!.firstPosition);

    const transcript = new SqliteTranscriptStore(path.join(secondDir, "transcripts.db"));
    try {
      const requestId = second.getLatestCanonicalRequestId(restored.history).unwrap()!;
      expect(transcript.getRequestTranscript({ requestId }).unwrap()?.messages).toHaveLength(24);
    } finally {
      transcript.close();
    }
    using firstTranscripts = new Database(path.join(firstDir, "transcripts.db"));
    using secondTranscripts = new Database(path.join(secondDir, "transcripts.db"));
    expect(
      secondTranscripts
        .query(
          "SELECT request_id,messages_json,transcript_digest FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual(
      firstTranscripts
        .query(
          "SELECT request_id,messages_json,transcript_digest FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    );
    const firstTime = firstTranscripts
      .query<{ created_ts: number }, []>(
        "SELECT MIN(created_ts) created_ts FROM request_transcripts",
      )
      .get()!;
    const secondTime = secondTranscripts
      .query<{ created_ts: number }, []>(
        "SELECT MIN(created_ts) created_ts FROM request_transcripts",
      )
      .get()!;
    expect(secondTime.created_ts).toBe(firstTime.created_ts + offset);

    await restoreNativeBrowserSnapshot(path.join(root, "different"), {
      cacheDir,
      seedOptions: { ...seedOptions, historyTurns: 1 },
    });
    expect(await readdir(cacheDir)).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("snapshot key changes with seed, schema, dependency, and shared source changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-browser-snapshot-key-"));
  const files = [
    "bun.lock",
    "package.json",
    "apps/core/tests/surface/native/browser-seed.ts",
    "apps/core/tests/surface/native/browser-seed-long.ts",
    "apps/core/tests/surface/native/browser-snapshot.ts",
    "apps/core/src/surface/native/store.ts",
    "packages/client-protocol/native.ts",
  ];
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "before");
    }
    let previous = browserSnapshotSourceHash(root);
    expect(browserSnapshotSourceHash(root)).toBe(previous);
    for (const file of files) {
      await writeFile(path.join(root, file), "after");
      const next = browserSnapshotSourceHash(root);
      expect(next).not.toBe(previous);
      previous = next;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
