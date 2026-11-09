import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { NativeStore } from "../../../src/surface/native/store";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { seedNativeBrowserFixture } from "./browser-seed";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const databaseFiles = ["native-surface.db", "transcripts.db"] as const;
type SeedOptions = Pick<
  Parameters<typeof seedNativeBrowserFixture>[1],
  "historyTurns" | "sidebarThreads" | "longTurns" | "dmWindows"
>;
const snapshotSchema = z.strictObject({
  createdAt: z.number().int(),
  threads: z.strictObject({
    dm: z.string(),
    search: z.string(),
    novel: z.string(),
    trip: z.string(),
    media: z.string(),
    questions: z.string(),
    jobWake: z.string(),
    rich: z.string(),
    history: z.string(),
    largeTurn: z.string(),
    empty: z.string(),
    uploads: z.string(),
    historyTurns: z.number().int(),
    sidebarThreads: z.number().int(),
  }),
});

export function browserSnapshotSourceHash(root = repoRoot): string {
  const sources = [
    "bun.lock",
    "package.json",
    "apps/core/tests/surface/native/browser-seed.ts",
    "apps/core/tests/surface/native/browser-seed-long.ts",
    "apps/core/tests/surface/native/browser-snapshot.ts",
    ...new Bun.Glob("apps/core/src/**/*.{ts,tsx,json}").scanSync({ cwd: root }),
    ...new Bun.Glob("packages/**/*.{ts,tsx,json}").scanSync({ cwd: root }),
  ].filter((file) => !file.includes("/node_modules/"));
  const hash = createHash("sha256").update(Bun.version);
  for (const file of sources.sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(root, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

async function seedSnapshot(directory: string, options: SeedOptions) {
  using database = new Database(path.join(directory, databaseFiles[0]));
  const store = new NativeStore(database);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const transcript = new SqliteTranscriptStore(path.join(directory, databaseFiles[1]));
  try {
    const threads = seedNativeBrowserFixture(store, { ...options, database, transcript });
    const createdAt = Date.now();
    await Bun.write(path.join(directory, "snapshot.json"), JSON.stringify({ createdAt, threads }));
  } finally {
    transcript.close();
  }
}

async function generateSnapshot(directory: string, options: SeedOptions) {
  const temporary = await mkdtemp(path.join(tmpdir(), "lilac-browser-seed-"));
  try {
    await seedSnapshot(temporary, options);
    await Promise.all(
      [...databaseFiles, "snapshot.json"].map((file) =>
        copyFile(path.join(temporary, file), path.join(directory, file)),
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function ensureSnapshot(cacheDir: string, key: string, options: SeedOptions) {
  const directory = path.join(cacheDir, key);
  if (await Bun.file(path.join(directory, "snapshot.json")).exists()) return directory;
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(path.join(cacheDir, ".building-"));
  try {
    await generateSnapshot(staging, options);
    try {
      await rename(staging, directory);
    } catch (error) {
      // Another dev process can finish the same immutable snapshot first.
      if (!(await Bun.file(path.join(directory, "snapshot.json")).exists())) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return directory;
}

const timestampFields = new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "settledAt",
  "completedAt",
]);

function refreshSnapshotTimes(dataDir: string, offset: number) {
  using native = new Database(path.join(dataDir, databaseFiles[0]));
  const shiftTime = (serialized: string) =>
    JSON.stringify(
      JSON.parse(serialized, (key, value) =>
        timestampFields.has(key) && typeof value === "number" ? value + offset : value,
      ),
    );
  native.transaction(() => {
    const records = native
      .query<{ rowid: number; data_json: string }, []>("SELECT rowid,data_json FROM native_records")
      .all();
    const updateRecord = native.query(
      "UPDATE native_records SET updated_at=updated_at+?, data_json=? WHERE rowid=?",
    );
    for (const row of records) updateRecord.run(offset, shiftTime(row.data_json), row.rowid);
    native.run("UPDATE native_changes SET created_at=created_at+?", [offset]);
    const changes = native
      .query<{ rowid: number; data_json: string }, []>(
        "SELECT rowid,data_json FROM native_changes WHERE data_json IS NOT NULL",
      )
      .all();
    const updateChange = native.query(
      "UPDATE native_changes SET data_json=?, byte_size=? WHERE rowid=?",
    );
    for (const row of changes) {
      const data = shiftTime(row.data_json);
      updateChange.run(data, Buffer.byteLength(data), row.rowid);
    }
  })();
  using transcript = new Database(path.join(dataDir, databaseFiles[1]));
  // Seeded canonical messages have no timestamps. Keep their bytes and digests intact.
  transcript.run(
    "UPDATE request_transcripts SET created_ts=created_ts+?, updated_ts=updated_ts+?",
    [offset, offset],
  );
}

export async function restoreNativeBrowserSnapshot(
  dataDir: string,
  options: { cacheDir?: string; seedOptions?: SeedOptions; now?: number } = {},
): Promise<ReturnType<typeof seedNativeBrowserFixture>> {
  const seedOptions = options.seedOptions ?? {};
  const key = createHash("sha256")
    .update(browserSnapshotSourceHash())
    .update(JSON.stringify(seedOptions))
    .digest("hex");
  const directory = await ensureSnapshot(
    options.cacheDir ?? path.join(repoRoot, ".cache", "native-browser-fixture"),
    key,
    seedOptions,
  );
  const snapshot = snapshotSchema.parse(
    await Bun.file(path.join(directory, "snapshot.json")).json(),
  );
  await mkdir(dataDir, { recursive: true });
  await Promise.all(
    databaseFiles.map((file) => copyFile(path.join(directory, file), path.join(dataDir, file))),
  );
  refreshSnapshotTimes(dataDir, (options.now ?? Date.now()) - snapshot.createdAt);
  return snapshot.threads;
}
