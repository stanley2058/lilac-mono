import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Result } from "better-result";
import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";

function value<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(options?: ConstructorParameters<typeof SqliteTranscriptStore>[3]) {
  const directory = await mkdtemp(join(tmpdir(), "native-transcript-retention-"));
  directories.push(directory);
  const path = join(directory, "transcripts.db");
  const store = new SqliteTranscriptStore(path, undefined, undefined, options);
  const save = (requestId: string, requestClient: "native" | "discord" = "native") =>
    value(
      store.saveRequestTranscript({
        requestId,
        requestClient,
        sessionId: requestClient === "native" ? "native:thread" : "discord:channel",
        messages: [{ role: "user", content: requestId }],
      }),
    );
  const age = () => {
    const db = new Database(path);
    db.run("UPDATE request_transcripts SET created_ts=0,updated_ts=0");
    db.close();
  };
  const present = (requestId: string) => value(store.getRequestTranscript({ requestId })) !== null;
  return { store, path, save, age, present };
}

test("default global transcript pruning preserves idle native canonical history and releases removed turns", async () => {
  const f = await fixture();
  f.save("first");
  f.save("second");
  f.save("unowned", "discord");
  f.age();
  f.save("trigger-1", "discord");
  expect(f.present("first")).toBe(true);
  expect(f.present("second")).toBe(true);
  expect(f.present("unowned")).toBe(false);
  value(
    f.store.reconcileNativeTranscriptReferences({
      sessionId: "native:thread",
      requestIds: ["first"],
    }),
  );
  f.save("trigger-2", "discord");
  expect(f.present("first")).toBe(true);
  expect(f.present("second")).toBe(false);
  value(
    f.store.reconcileNativeTranscriptReferences({ sessionId: "native:thread", requestIds: [] }),
  );
  f.save("trigger-3", "discord");
  expect(f.present("first")).toBe(false);
  f.store.close();
});

test("native pins are saved before count pruning and persist across restart", async () => {
  const f = await fixture({
    retention: { maxAgeMs: { kind: "unlimited" }, maxRequests: { kind: "bounded", value: 1 } },
  });
  f.save("first");
  f.save("second");
  expect(f.present("first")).toBe(true);
  expect(f.present("second")).toBe(true);
  f.store.close();
  const restarted = new SqliteTranscriptStore(f.path, undefined, undefined, {
    retention: { maxAgeMs: { kind: "unlimited" }, maxRequests: { kind: "bounded", value: 1 } },
  });
  value(
    restarted.reconcileNativeTranscriptReferences({
      sessionId: "native:thread",
      requestIds: ["second"],
    }),
  );
  value(
    restarted.saveRequestTranscript({
      requestId: "third",
      requestClient: "native",
      sessionId: "native:thread",
      messages: [{ role: "user", content: "third" }],
    }),
  );
  expect(value(restarted.getRequestTranscript({ requestId: "first" }))).toBeNull();
  expect(value(restarted.getRequestTranscript({ requestId: "second" }))).not.toBeNull();
  expect(value(restarted.getRequestTranscript({ requestId: "third" }))).not.toBeNull();
  restarted.close();
});

test("schema 12 migration pins existing native transcripts before the next global prune", async () => {
  const f = await fixture();
  f.save("existing");
  f.age();
  f.store.close();
  const db = new Database(f.path);
  db.run("DROP TABLE discord_skipped_replies");
  db.run("DROP TABLE core_native_transcript_refs");
  db.run("ALTER TABLE core_resources DROP COLUMN image_preview_json");
  db.run("DELETE FROM transcript_schema_migrations WHERE version>=13");
  db.close();
  const upgraded = new SqliteTranscriptStore(f.path);
  value(
    upgraded.saveRequestTranscript({
      requestId: "trigger",
      requestClient: "discord",
      sessionId: "discord:channel",
      messages: [{ role: "user", content: "trigger" }],
    }),
  );
  expect(value(upgraded.getRequestTranscript({ requestId: "existing" }))).not.toBeNull();
  upgraded.close();
});
